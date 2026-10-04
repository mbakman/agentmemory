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
});

it("accepts and deprecates the obsolete pool argument without changing the request", async () => {
  const result = await run(true, ["example", "2", "3000", "--json"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("pool argument is deprecated and ignored");
  expect(JSON.parse(result.stdout).insights).toHaveLength(2);
  expect(requests[0].body).toEqual({ query: "example", limit: 2 });
});
