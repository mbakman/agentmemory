import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const installed = process.env.AGENTMEMORY_TEST_INSTALLED === "1";
// Resolved from this file, not the working directory, so the suite always runs this checkout's build.
const repoFile = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const distEntries = { agentmemory: "cli", "agentmemory-insights": "insights-cli" } as const;
type Binary = keyof typeof distEntries;
type SpawnIo = { closeStdoutAfterFirstChunk?: boolean; closeStderr?: boolean };
let baseUrl: string;
let requests: Array<{ path: string; body: unknown; auth: string | undefined }>;
let respond: (response: ServerResponse) => void;
const insights = Array.from({ length: 12 }, (_, index) => ({
  id: `ins_${index}`, title: `Insight ${index}`, content: "A durable conclusion.",
  confidence: 0.9, score: 1 - index / 100, tags: ["example"],
  sourceMemoryIds: ["source-that-must-not-be-printed"],
}));
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  requests.push({ path: request.url!, body: JSON.parse(raw), auth: request.headers.authorization });
  respond(response);
});

// Built mode spawns dist/, so a missing or stale build would quietly test old code. Fail fast instead.
beforeAll(() => {
  if (installed) return;
  const [newest] = ["src/cli/insights.ts", "src/insights-cli.ts", "src/cli.ts"]
    .map((source) => ({ path: repoFile(source), mtimeMs: statSync(repoFile(source)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of Object.values(distEntries)) {
    const file = repoFile(`dist/${entry}.mjs`);
    if (!existsSync(file)) throw new Error(`${file} is missing; run npm run build`);
    if (statSync(file).mtimeMs < newest.mtimeMs) throw new Error(`${file} is older than ${newest.path}; run npm run build`);
  }
});

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  requests = [];
  respond = (response) => response.end(JSON.stringify({ success: true, insights }));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

function spawnCli(binary: Binary, args: string[], env: NodeJS.ProcessEnv = {}, io: SpawnIo = {}) {
  // The timeout sends the default SIGTERM and never escalates: a child that survives it fails its test.
  const options = { env: { ...process.env, AGENTMEMORY_URL: baseUrl, AGENTMEMORY_SECRET: "", ...env }, timeout: 30_000 };
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((done, reject) => {
    const child = installed
      ? spawn("/bin/zsh", ["-f", "-c", 'exec "$@"', "insights-test", binary, ...args], options)
      : spawn(process.execPath, [repoFile(`dist/${distEntries[binary]}.mjs`), ...args], options);
    if (io.closeStderr) child.stderr.destroy();
    let stdout = "";
    let stderr = "";
    // Decode as a stream so a multi-byte character split across pipe reads stays intact.
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (io.closeStdoutAfterFirstChunk) child.stdout.destroy();
    });
    if (!io.closeStderr) child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr += chunk);
    child.on("error", reject);
    child.on("close", (code, signal) => done({ code, signal, stdout, stderr }));
  });
}

function run(compatibility: boolean, args: string[], env: NodeJS.ProcessEnv = {}, io: SpawnIo = {}) {
  return compatibility
    ? spawnCli("agentmemory-insights", args, env, io)
    : spawnCli("agentmemory", ["insights", ...args], env, io);
}

// The native binary without the insights prefix, for top-level help and command dispatch.
function runCli(args: string[]) {
  return spawnCli("agentmemory", args);
}

describe.each([false, true])(`${installed ? "installed" : "built"} insight entrypoint compatibility=%s`, (compatibility) => {
  it("runs without shell initialization, defaults to ten, and uses native search", async () => {
    const result = await run(compatibility, ["example", "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).insights).toHaveLength(10);
    expect(result.stdout).not.toContain("sourceMemoryIds");
    expect(requests).toEqual([{ path: "/agentmemory/insights/search", body: { query: "example", limit: 10 }, auth: undefined }]);
  });

  it("limits output and passes bearer authentication", async () => {
    const args = compatibility ? ["example", "2", "--json"] : ["example", "--limit", "2", "--json"];
    const result = await run(compatibility, args, { AGENTMEMORY_SECRET: "fixture-secret" });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).insights).toHaveLength(2);
    expect(requests[0].auth).toBe("Bearer fixture-secret");
  });

  it("flushes a large result to a pipe before exiting", async () => {
    const content = "durable conclusion ".repeat(10000);
    respond = (response) => response.end(JSON.stringify({
      success: true, insights: [{ ...insights[0], content }],
    }));
    const result = await run(compatibility, ["example", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).insights[0].content).toBe(content);
  });

  it("prints compact text and explicit successful empty searches", async () => {
    const result = await run(compatibility, ["example", "--limit=1"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Showing 1 insight(s)");
    expect(result.stdout).toContain("Insight 0");
    expect(result.stdout).not.toContain("source-that-must-not-be-printed");
    respond = (response) => response.end(JSON.stringify({ success: true, insights: [] }));
    const empty = await run(compatibility, ["none"]);
    expect(empty).toMatchObject({ code: 0, stdout: 'No insights match "none".\n', stderr: "" });
    expect(JSON.parse((await run(compatibility, ["none", "--json"])).stdout).insights).toEqual([]);
  });

  it.each([401, 403, 503])("reports HTTP %i failures on stderr with nonzero status", async (status) => {
    respond = (response) => { response.writeHead(status); response.end("failure"); };
    const result = await run(compatibility, ["example", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(status === 503 ? "backend failure" : "authentication failed");
  });

  it.each(["not-json", '{}', '{"success":false}', '{"success":true,"insights":[{}]}'])
    ("does not relabel bad backend payload %s as empty", async (payload) => {
      respond = (response) => response.end(payload);
      const result = await run(compatibility, ["example"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/malformed response|backend failure/);
    });

  it("reports a closed connection", async () => {
    respond = (response) => response.destroy();
    const result = await run(compatibility, ["example"]);
    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toContain("connection failed");
  });

  it.each([false, true])("bounds the request including delayed body=%s", async (body) => {
    respond = (response) => {
      if (body) { response.writeHead(200, { "Content-Type": "application/json" }); response.write('{"success":'); }
      setTimeout(() => response.end("true}"), 200).unref();
    };
    const result = await run(compatibility, ["example"], { AGENTMEMORY_INSIGHTS_TIMEOUT_MS: "50" });
    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toContain("timeout:");
  });

  it("shows help and rejects bad arguments without contacting the backend", async () => {
    expect((await run(compatibility, ["--help"])).code).toBe(0);
    const invalid = await run(compatibility, ["example", "--limit=0"]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("positive integer");
    expect(requests).toEqual([]);
  });

  it.each([false, true])("exits 0 quietly when the reader closes stdout early json=%s", async (json) => {
    // About 5 MiB of output, far more than a pipe buffers, so the writer is still writing when the reader leaves.
    const content = "x".repeat(512 * 1024);
    respond = (response) => response.end(JSON.stringify({
      success: true, insights: insights.map((item) => ({ ...item, content })),
    }));
    const result = await run(compatibility, json ? ["example", "--json"] : ["example"], {}, { closeStdoutAfterFirstChunk: true });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout.length).toBeGreaterThan(0);
  }, 20_000);

  it("keeps the usage exit status when stderr is closed", async () => {
    const result = await run(compatibility, ["example", "--limit=0"], {}, { closeStderr: true });
    expect(result.code).toBe(2);
    expect(requests).toEqual([]);
  });

  it.each([
    { "Content-Length": "100000" },
    { "Content-Length": "100000", Connection: "close" },
    {},
  ])("reports a body cut mid-stream with headers %j as a connection failure", async (headers) => {
    respond = (response) => {
      response.writeHead(200, { "Content-Type": "application/json", ...headers });
      response.write('{"success":true,"insights":[', () => response.destroy());
    };
    const result = await run(compatibility, ["example"]);
    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toContain("connection failed");
    expect(result.stderr).not.toContain("malformed response");
  });

  it("exits promptly after an error status with an unfinished body", async () => {
    respond = (response) => { response.writeHead(503); response.write("partial"); };
    const started = Date.now();
    const result = await run(compatibility, ["example"], { AGENTMEMORY_INSIGHTS_TIMEOUT_MS: "10000" });
    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toContain("backend failure: HTTP 503");
    expect(Date.now() - started).toBeLessThan(4000);
  }, 20_000);

  it.each(["http://", "http:///"])("rejects hostless AGENTMEMORY_URL %j without a request", async (url) => {
    const result = await run(compatibility, ["example"], { AGENTMEMORY_URL: url });
    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toContain("configuration error: AGENTMEMORY_URL");
    expect(requests).toEqual([]);
  });

  it("names III_REST_PORT when the fallback port is unusable", async () => {
    // Never use a port value that maps to the daemon's default: this run must not reach any server.
    const result = await run(compatibility, ["example"], { AGENTMEMORY_URL: "", III_REST_PORT: "70000" });
    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toContain("configuration error: III_REST_PORT");
    expect(result.stderr).not.toContain("AGENTMEMORY_URL must");
    expect(requests).toEqual([]);
  });

  it("caps the limit at 100", async () => {
    const over = await run(compatibility, compatibility ? ["example", "101"] : ["example", "--limit", "101"]);
    expect(over.code).toBe(2);
    expect(over.stderr).toContain("no greater than 100");
    expect(requests).toEqual([]);
    const cap = await run(compatibility, compatibility ? ["example", "100", "--json"] : ["example", "--limit", "100", "--json"]);
    expect(cap.code).toBe(0);
    expect(JSON.parse(cap.stdout)).toMatchObject({ limit: 100 });
    expect(JSON.parse(cap.stdout).insights).toHaveLength(insights.length);
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toMatchObject({ query: "example" });
  });

  it("rejects a query of only one-character terms", async () => {
    const result = await run(compatibility, ["a b"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("no searchable terms");
    expect(requests).toEqual([]);
  });

  it("notes ignored one-character terms and still sends the query unchanged", async () => {
    const result = await run(compatibility, ["x example", "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('ignoring one-character term(s) "x"');
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toMatchObject({ query: "x example" });
  });

  const prefix = compatibility ? "agentmemory-insights: " : "agentmemory insights: ";

  it("shows help for --help or -h anywhere before --", async () => {
    for (const args of [["example", "--limit", "5", "--help"], ["--unknown", "-h"], ["example", "--json", "-h"]]) {
      const result = await run(compatibility, args);
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(result.stdout).toMatch(/^Usage: agentmemory insights <query>/);
    }
    expect(requests).toEqual([]);
  });

  it("searches for --help when it follows --", async () => {
    const result = await run(compatibility, ["--", "--help"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).not.toContain("Usage:");
    expect(result.stdout).toContain('for "--help"');
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toMatchObject({ query: "--help" });
  });

  it("prefixes usage errors, notices and failures with the invoked name", async () => {
    const usage = await run(compatibility, ["example", "--limit=0"]);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toMatch(new RegExp(`^${prefix}limit must be a positive integer`));
    const note = await run(compatibility, ["x example", "--json"]);
    expect(note).toMatchObject({
      code: 0,
      stderr: `${prefix}note: ignoring one-character term(s) "x"; the server searches only terms of 2 or more characters\n`,
    });
    respond = (response) => { response.writeHead(503); response.end("failure"); };
    const failed = await run(compatibility, ["example"]);
    expect(failed).toMatchObject({ code: 1, stdout: "", stderr: `${prefix}backend failure: HTTP 503\n` });
  });

  it("names the endpoint origin and error code on connection failures and timeouts", async () => {
    // A port that was just released refuses connections.
    const released = createServer();
    await new Promise<void>((done) => released.listen(0, "127.0.0.1", done));
    const address = released.address();
    if (!address || typeof address === "string") throw new Error("missing released port");
    await new Promise<void>((done) => released.close(() => done()));
    const refused = await run(compatibility, ["example"], { AGENTMEMORY_URL: `http://127.0.0.1:${address.port}/prefix` });
    expect(refused).toMatchObject({
      code: 1, stdout: "",
      stderr: `${prefix}connection failed: could not reach http://127.0.0.1:${address.port} (ECONNREFUSED); check AGENTMEMORY_URL and that the agentmemory daemon is running\n`,
    });
    respond = (response) => { setTimeout(() => response.end("{}"), 500).unref(); };
    const slow = await run(compatibility, ["example"], { AGENTMEMORY_INSIGHTS_TIMEOUT_MS: "50" });
    expect(slow).toMatchObject({
      code: 1, stdout: "",
      stderr: `${prefix}timeout: no complete response from ${baseUrl} within 50 ms; check the daemon or raise AGENTMEMORY_INSIGHTS_TIMEOUT_MS\n`,
    });
  });

  it.each(["a\nb", "😀"])("rejects the unsendable AGENTMEMORY_SECRET %j without echoing it", async (secret) => {
    const result = await run(compatibility, ["example"], { AGENTMEMORY_SECRET: secret });
    expect(result).toMatchObject({
      code: 1, stdout: "",
      stderr: `${prefix}configuration error: AGENTMEMORY_SECRET cannot be sent in an HTTP Authorization header; remove line breaks, NUL characters, and characters above U+00FF\n`,
    });
    expect(result.stderr).not.toContain(secret);
    expect(requests).toEqual([]);
  });

  it("strips control characters from text output and keeps JSON raw", async () => {
    const title = "Bad\x1b[31m\x07\ntitle\u{2029}end\x9b";
    const content = "line1\r\nline2\x07\x1b\x85\rline3";
    respond = (response) => response.end(JSON.stringify({ success: true, insights: [{ ...insights[0], title, content }] }));
    const text = await run(compatibility, ["example\x7f"]);
    expect(text).toMatchObject({ code: 0, stderr: "" });
    expect(text.stdout).toContain('Showing 1 insight(s) for "example\\u007f"');
    expect(text.stdout).toContain("] Bad[31m title end\nline1\nline2\nline3\n");
    expect(text.stdout).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{2028}\u{2029}]/u);
    const json = await run(compatibility, ["example\x7f", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ query: "example\x7f", insights: [{ title, content }] });
    respond = (response) => response.end(JSON.stringify({ success: true, insights: [] }));
    expect((await run(compatibility, ["example\x7f"])).stdout).toBe('No insights match "example\\u007f".\n');
  });
});

it("accepts and deprecates the obsolete pool argument without changing the request", async () => {
  const result = await run(true, ["example", "2", "3000", "--json"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("pool argument is deprecated and ignored");
  expect(JSON.parse(result.stdout).insights).toHaveLength(2);
  expect(requests[0].body).toEqual({ query: "example", limit: 2 });
});

it("names the compatibility command in the deprecation notice", async () => {
  const result = await run(true, ["example", "2", "3000", "--json"]);
  expect(result.stderr).toMatch(/^agentmemory-insights: the pool argument is deprecated and ignored/);
});

it("hints at quoting an unquoted multi-word query in compatibility mode", async () => {
  const result = await run(true, ["database", "performance"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toMatch(/^agentmemory-insights: max must be a positive integer no greater than 100 \(quote multi-word queries\)\n/);
  expect(requests).toEqual([]);
});
