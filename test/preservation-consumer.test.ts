import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  classifyBridgeFailure,
  createRpcClient,
  parseOptions,
  probeConsumer,
  recallSummary,
} from "../scripts/preservation/consumer-probe.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bridge = join(repository, "plugin/scripts/plugin-bridge.mjs");
const probe = join(repository, "scripts/preservation/consumer-probe.mjs");
const publicNames = ["memory_recall", "memory_sessions", "memory_save"];
const tools = { tools: publicNames.map((name) => ({ name, inputSchema: { type: "object" } })) };
const query = "private-query-fixture";
const known = "private-observation-fixture";
const secret = "synthetic-secret-fixture";

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function backend(handle: (path: string, response: ServerResponse, body: unknown) => void) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    handle(request.url!, response, text ? JSON.parse(text) : undefined);
  });
  await new Promise<void>((resolveResult) => server.listen(0, "127.0.0.1", resolveResult));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveResult) => server.close(() => resolveResult()));
    },
  };
}

async function options(url: string, extra: Record<string, unknown> = {}) {
  const home = await mkdtemp(join(tmpdir(), "agentmemory-consumer-home-"));
  return {
    args: { bridge, url, query, knownIds: [known], expectedTools: 3, limit: 10,
      timeoutMs: 1000, maxResponseBytes: 1024 * 1024, ...extra },
    env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH,
      AGENTMEMORY_SECRET: secret, AGENTMEMORY_TOOLS: "all" },
  };
}

function childFixture(reply: (message: Record<string, unknown>, stdout: PassThrough) => void) {
  const child = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    queueMicrotask(() => reply(JSON.parse(chunk.toString()), child.stdout));
    done();
  } });
  return child;
}

describe("MCP preservation consumer probe", () => {
  it("requires an explicit loopback URL, known ID, private output and bounded deadline", () => {
    const valid = ["--bridge", bridge, "--url", "http://127.0.0.1:4411", "--query", query,
      "--known-id", known, "--out", "/tmp/new-private-evidence.json"];
    expect(parseOptions(valid)).toMatchObject({ expectedTools: 54, timeoutMs: 10000, knownIds: [known] });
    expect(parseOptions(["--help"])).toEqual({ help: true });
    expect(() => parseOptions([...valid, "--timeout-ms", "15000"])).toThrow("permitted range");
    expect(() => parseOptions([...valid, "--bridge", bridge])).toThrow("Duplicate");
    expect(() => parseOptions([...valid, "--known-id", known])).toThrow("invalid");
    for (const url of ["https://outside.example", "http://secret@localhost:4411", "http://localhost:4411/?token=secret", "http://localhost:4411/agentmemory"]) {
      expect(() => parseOptions(valid.map((value) => value === "http://127.0.0.1:4411" ? url : value))).toThrow("loopback");
    }
    expect(() => parseOptions(valid.filter((value) => value !== "--known-id" && value !== known))).toThrow("required");
  });

  it("proves actual bridge recall after initialize and the exact approved tool-name inventory", async () => {
    const calls: string[] = [];
    const fixture = await backend((path, response, body: any) => {
      calls.push(path);
      if (path.endsWith("/tools")) json(response, tools);
      else {
        expect(body).toEqual({ name: "memory_recall", arguments: { query, format: "compact", limit: 10 } });
        json(response, { content: [{ type: "text", text: JSON.stringify({ results: [{ obsId: known, title: "private-memory-text" }] }) }] });
      }
    });
    try {
      const runtime = await options(fixture.url);
      const expectedFile = join(runtime.env.HOME, "public-tools.json");
      await writeFile(expectedFile, JSON.stringify(publicNames));
      const result = await probeConsumer({ ...runtime.args, expectedToolsFile: expectedFile }, { env: runtime.env });
      expect(result).toMatchObject({ usable: true, tools: { count: 3, names: [...publicNames].sort() }, recall: { count: 1, matchedKnownIdCount: 1 }, termination: { exited: true } });
      expect(result.stages.map((stage: any) => stage.name)).toEqual(["initialize", "tools/list", "memory_recall"]);
      expect(calls).toEqual(["/agentmemory/mcp/tools", "/agentmemory/mcp/call"]);
      const evidence = JSON.stringify(result);
      for (const privateText of [query, known, secret, "private-memory-text"]) expect(evidence).not.toContain(privateText);
      expect(result.recall.payloadSha256).toHaveLength(64);
      const expectedRecallIdsSha256 = createHash("sha256").update(JSON.stringify([known])).digest("hex");
      const hashed = await probeConsumer({ ...runtime.args, knownIds: [], expectedRecallIdsSha256 }, { env: runtime.env });
      expect(hashed).toMatchObject({ usable: true, recall: { idsSha256: expectedRecallIdsSha256, knownIdCount: 0 } });
      const mismatched = await probeConsumer({ ...runtime.args, knownIds: [], expectedRecallIdsSha256: "0".repeat(64) }, { env: runtime.env });
      expect(mismatched).toMatchObject({ usable: false, failure: { category: "known_recall_missing" } });
    } finally { await fixture.close(); }
  });

  it.each([401, 403])("reports HTTP %i as authentication failure after successful initialize", async (status) => {
    const fixture = await backend((_path, response) => json(response, { error: secret }, status));
    try {
      const runtime = await options(fixture.url);
      const result = await probeConsumer(runtime.args, { env: runtime.env });
      expect(result).toMatchObject({ usable: false, failure: { category: "authentication", stage: "tools/list" } });
      expect(result.stages[0].status).toBe("passed");
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally { await fixture.close(); }
  });

  it("reports a refused backend as unreachable without converting it to empty recall", async () => {
    const fixture = await backend((_path, response) => json(response, tools));
    await fixture.close();
    const runtime = await options(fixture.url);
    const result = await probeConsumer(runtime.args, { env: runtime.env });
    expect(result).toMatchObject({ usable: false, failure: { category: "unreachable", endpointCheck: "unreachable" } });
    expect(result.recall).toBeUndefined();
  });

  it("uses its own deadline to distinguish a stalled response from connection refusal", async () => {
    const fixture = await backend(() => {});
    try {
      const runtime = await options(fixture.url, { timeoutMs: 300 });
      const result = await probeConsumer(runtime.args, { env: runtime.env });
      expect(result).toMatchObject({ usable: false, failure: { category: "timeout", stage: "tools/list" }, termination: { exited: true, sigtermSent: true } });
    } finally { await fixture.close(); }
  });

  it.each(["invalid-json", "invalid-tools", "backend-error", "fallback-tools", "different-names", "empty-known", "invalid-recall", "recall-error"])(
    "rejects %s through the real stdio bridge", async (mode) => {
      const fixture = await backend((path, response) => {
        if (path.endsWith("/tools")) {
          if (mode === "invalid-json") { response.end("raw-private-invalid-json"); return; }
          if (mode === "invalid-tools") { json(response, { tools: [{}] }); return; }
          if (mode === "backend-error") { json(response, { error: secret }, 503); return; }
          if (mode === "fallback-tools") { json(response, { tools: tools.tools.slice(0, 1) }); return; }
          if (mode === "different-names") { json(response, { tools: [tools.tools[0], tools.tools[1], { name: "other_public_tool", inputSchema: {} }] }); return; }
          json(response, tools);
        } else if (mode === "recall-error") json(response, { error: secret }, 401);
        else json(response, { content: [{ type: "text", text: mode === "invalid-recall" ? "not-json-private-text" : JSON.stringify({ results: [] }) }] });
      });
      try {
        const runtime = await options(fixture.url);
        const expectedFile = join(runtime.env.HOME, "public-tools.json");
        await writeFile(expectedFile, JSON.stringify(publicNames));
        const result = await probeConsumer({ ...runtime.args, expectedToolsFile: expectedFile }, { env: runtime.env });
        const categories: Record<string, string> = { "invalid-json": "malformed_response", "invalid-tools": "malformed_response", "backend-error": "backend_failure", "fallback-tools": "tool_inventory", "different-names": "tool_inventory", "empty-known": "known_recall_missing", "invalid-recall": "malformed_response", "recall-error": "authentication" };
        expect(result).toMatchObject({ usable: false, failure: { category: categories[mode] }, termination: { exited: true } });
        expect(JSON.stringify(result)).not.toMatch(/raw-private-invalid-json|not-json-private-text|synthetic-secret-fixture/);
      } finally { await fixture.close(); }
    },
  );

  it("does not guess the cause of an ambiguous network error", () => {
    expect(classifyBridgeFailure("Agent Memory daemon is unreachable or timed out.")).toBe("network_failure");
  });

  it("rejects malformed stdout, JSON-RPC IDs, duplicate result/error and early child exit", async () => {
    const messages = ["raw-private-stdout\n", '{"jsonrpc":"2.0","id":99,"result":{}}\n', '{"jsonrpc":"2.0","id":1,"result":{},"error":{}}\n'];
    for (const message of messages) {
      const child = childFixture((_request, output) => output.write(message));
      const client = createRpcClient(child, { timeoutMs: 100, maxResponseBytes: 1024 });
      await expect(client.request("initialize", {})).rejects.toMatchObject({ category: "malformed_response" });
      expect(JSON.stringify(client.evidence())).not.toContain("raw-private-stdout");
    }
    const child = childFixture(() => child.emit("close", 0, null));
    await expect(createRpcClient(child, { timeoutMs: 100, maxResponseBytes: 1024 }).request("initialize", {})).rejects.toMatchObject({ category: "child_failure" });
    const partial = childFixture((_request, output) => { output.write('{"jsonrpc":'); partial.emit("close", 0, null); });
    await expect(createRpcClient(partial, { timeoutMs: 100, maxResponseBytes: 1024 }).request("initialize", {})).rejects.toMatchObject({ category: "malformed_response" });
  });

  it("bounds output and captures fallback diagnostics without retaining raw stderr", async () => {
    const oversized = childFixture((_request, output) => output.write("x".repeat(2048)));
    await expect(createRpcClient(oversized, { timeoutMs: 100, maxResponseBytes: 1024 }).request("initialize", {})).rejects.toMatchObject({ category: "response_limit" });
    const child = childFixture((request, output) => {
      child.stderr.write(`falling back to local store: ${secret}`);
      output.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\n");
    });
    const client = createRpcClient(child, { timeoutMs: 100, maxResponseBytes: 1024 });
    await client.request("initialize", {});
    expect(client.evidence().fallbackDetected).toBe(true);
    expect(JSON.stringify(client.evidence())).not.toContain(secret);
  });

  it("never maps malformed content or missing IDs to an empty list", () => {
    for (const result of [{}, { content: [{ type: "text", text: "{}" }] }, { content: [{ type: "text", text: '{"results":[{}]}' }] }]) {
      expect(() => recallSummary(result, [known])).toThrow();
    }
    expect(recallSummary({ content: [{ type: "text", text: '{"results":[]}' }] }, [known])).toMatchObject({ count: 0, matchedKnownIdCount: 0 });
  });

  it("writes owner-only CLI evidence and refuses to replace an earlier result", async () => {
    const fixture = await backend((path, response) => json(response, path.endsWith("/tools") ? tools : { content: [{ type: "text", text: JSON.stringify({ results: [{ obsId: known }] }) }] }));
    try {
      const runtime = await options(fixture.url);
      const out = join(runtime.env.HOME, "evidence", "result.json");
      const args = [probe, "--bridge", bridge, "--url", fixture.url, "--query", query, "--known-id", known, "--expected-tools", "3", "--out", out];
      const run = async () => {
        const child = spawn(process.execPath, args, { env: runtime.env });
        let stdout = "", stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        const code = await new Promise((resolveResult) => child.once("close", resolveResult));
        return { code, stdout, stderr };
      };
      expect((await run()).code).toBe(0);
      const original = await readFile(out, "utf8");
      expect(JSON.parse(original).usable).toBe(true);
      expect((await stat(out)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(out))).mode & 0o777).toBe(0o700);
      expect((await run()).code).toBe(2);
      expect(await readFile(out, "utf8")).toBe(original);
    } finally { await fixture.close(); }
  });
});
