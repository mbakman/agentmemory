import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { isMain, sha256File } from "./manifest.mjs";

const HELP = `Usage: consumer-probe.mjs --bridge ABSOLUTE_FILE --url LOOPBACK_URL
  --query TOKEN --out NEW_PRIVATE_FILE
  (--known-id ID [--known-id ID ...] | --expected-recall-ids-sha256 HASH)
  [--expected-tools 54] [--expected-tools-file NAMES_JSON]
  [--limit 10] [--timeout-ms 10000] [--max-response-bytes 1048576]

Speak MCP over stdio to the specified bridge with the current Node executable.
Use an isolated HOME and the normal bridge credential resolver. Secrets have no
CLI option. Only initialize, tools/list and memory_recall are called.
Evidence contains counts, hashes and public tool names, not memory text or IDs.
Exit 0: usable expected recall; 1: failed gate; 2: usage/evidence failure.
The RPC deadline must be at most 10000 ms, below the bridge's 15000 ms deadline.
Transport errors that cannot be distinguished remain network_failure.
Only the owned bridge child can receive SIGTERM. No forced termination is used.`;

const digest = (value) => createHash("sha256").update(value).digest("hex");
const idDigest = (ids) => digest(JSON.stringify([...ids].sort()));
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export class ProbeFailure extends Error {
  constructor(category, reason) {
    super(reason);
    this.category = category;
  }
}

export function classifyBridgeFailure(message) {
  if (/HTTP (401|403)\b/.test(message)) return "authentication";
  if (/invalid JSON|invalid resources/i.test(message)) return "malformed_response";
  if (/unreachable or timed out/i.test(message)) return "network_failure";
  if (/\bHTTP \d{3}\b/.test(message)) return "backend_failure";
  return "protocol_failure";
}

function integer(value, name, min, max) {
  const number = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new ProbeFailure("usage", `${name} is outside the permitted range`);
  }
  return number;
}

export function parseOptions(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const values = new Map();
  const knownIds = [];
  const options = new Set(["--bridge", "--url", "--query", "--known-id", "--expected-recall-ids-sha256", "--out", "--expected-tools", "--expected-tools-file", "--limit", "--timeout-ms", "--max-response-bytes"]);
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    const value = args[++i];
    if (!options.has(name) || !value || value.startsWith("--")) throw new ProbeFailure("usage", "Unknown or incomplete option");
    if (name === "--known-id") knownIds.push(value);
    else {
      if (values.has(name)) throw new ProbeFailure("usage", "Duplicate option");
      values.set(name, value);
    }
  }
  if (!["--bridge", "--url", "--query", "--out"].every((name) => values.has(name)) || (!knownIds.length && !values.has("--expected-recall-ids-sha256"))) {
    throw new ProbeFailure("usage", "Bridge, URL, query, known ID or result hash, and output are required");
  }
  if (!["--bridge", "--out"].every((name) => isAbsolute(values.get(name)))) {
    throw new ProbeFailure("usage", "Bridge and output paths must be absolute");
  }
  let url;
  try { url = new URL(values.get("--url")); }
  catch { throw new ProbeFailure("usage", "Invalid backend URL"); }
  const loopback = ["localhost", "localhost.", "[::1]"].includes(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (!loopback || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new ProbeFailure("usage", "Backend URL must be loopback HTTP(S) without credentials, path, query or fragment");
  }
  const query = values.get("--query");
  if (!query.trim() || query.length > 1024 || knownIds.length > 100 || new Set(knownIds).size !== knownIds.length || knownIds.some((id) => !id.trim() || id.length > 512)) {
    throw new ProbeFailure("usage", "Query or known ID is invalid");
  }
  const expectedRecallIdsSha256 = values.get("--expected-recall-ids-sha256");
  if (expectedRecallIdsSha256 && !/^[a-f0-9]{64}$/.test(expectedRecallIdsSha256)) {
    throw new ProbeFailure("usage", "Expected recall ID hash must be lowercase SHA-256");
  }
  return {
    bridge: resolve(values.get("--bridge")), url: url.origin, query, knownIds,
    expectedRecallIdsSha256,
    out: resolve(values.get("--out")), expectedToolsFile: values.get("--expected-tools-file"),
    expectedTools: integer(values.get("--expected-tools") ?? "54", "Tool count", 1, 1024),
    limit: integer(values.get("--limit") ?? "10", "Recall limit", 1, 100),
    timeoutMs: integer(values.get("--timeout-ms") ?? "10000", "RPC deadline", 1, 10000),
    maxResponseBytes: integer(values.get("--max-response-bytes") ?? "1048576", "Response limit", 1024, 16 * 1024 * 1024),
  };
}

function toolNames(result) {
  if (!object(result) || !Array.isArray(result.tools) || result.tools.length > 1024) {
    throw new ProbeFailure("malformed_response", "Invalid tool inventory");
  }
  const names = result.tools.map((tool) => {
    if (!object(tool) || typeof tool.name !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(tool.name) || !object(tool.inputSchema)) {
      throw new ProbeFailure("malformed_response", "Invalid tool definition");
    }
    return tool.name;
  });
  if (new Set(names).size !== names.length) throw new ProbeFailure("malformed_response", "Duplicate tool name");
  return names.sort();
}

export function recallSummary(result, knownIds) {
  if (!object(result) || !Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== "text" || typeof result.content[0]?.text !== "string") {
    throw new ProbeFailure("malformed_response", "Invalid recall content");
  }
  if (result.isError === true) {
    throw new ProbeFailure(classifyBridgeFailure(result.content[0].text), "Bridge reported a recall error");
  }
  let body;
  try { body = JSON.parse(result.content[0].text); }
  catch { throw new ProbeFailure("malformed_response", "Recall content is not JSON"); }
  if (!object(body) || !Array.isArray(body.results) || body.results.length > 100) {
    throw new ProbeFailure("malformed_response", "Invalid recall results");
  }
  const ids = body.results.map((row) => {
    if (!object(row)) throw new ProbeFailure("malformed_response", "Invalid recall row");
    const id = row.obsId ?? row.id ?? row.observationId;
    if (typeof id !== "string" || !id.trim()) throw new ProbeFailure("malformed_response", "Recall row has no ID");
    return id;
  });
  const matched = knownIds.filter((id) => ids.includes(id));
  return { count: ids.length, idsSha256: idDigest(ids), knownIdCount: knownIds.length,
    matchedKnownIdCount: matched.length, matchedKnownIdsSha256: idDigest(matched),
    payloadSha256: digest(result.content[0].text) };
}

export function createRpcClient(child, { timeoutMs, maxResponseBytes }) {
  let nextId = 0;
  let buffer = Buffer.alloc(0);
  let closed = false;
  let terminalFailure;
  const pending = new Map();
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  const metrics = { stdoutBytes: 0, stderrBytes: 0, notifications: 0, fallbackDetected: false };
  let stderrTail = "";
  const fail = (error) => {
    terminalFailure ??= error;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  child.stdout.on("data", (chunk) => {
    const bytes = Buffer.from(chunk);
    stdoutHash.update(bytes);
    metrics.stdoutBytes += bytes.length;
    if (terminalFailure) return;
    if (metrics.stdoutBytes > maxResponseBytes) { fail(new ProbeFailure("response_limit", "MCP stdout exceeds the evidence limit")); return; }
    buffer = Buffer.concat([buffer, bytes]);
    for (let newline; (newline = buffer.indexOf(10)) !== -1;) {
      const line = buffer.subarray(0, newline).toString("utf8").trim();
      buffer = buffer.subarray(newline + 1);
      if (!line) continue;
      let response;
      try { response = JSON.parse(line); }
      catch { fail(new ProbeFailure("malformed_response", "MCP stdout is not JSON")); return; }
      if (!object(response) || response.jsonrpc !== "2.0") { fail(new ProbeFailure("malformed_response", "Invalid JSON-RPC envelope")); return; }
      if (response.id === undefined && typeof response.method === "string") { metrics.notifications++; continue; }
      const item = pending.get(response.id);
      if (!item || (Object.hasOwn(response, "result") === Object.hasOwn(response, "error"))) {
        fail(new ProbeFailure("malformed_response", "Invalid JSON-RPC response ID or result")); return;
      }
      pending.delete(response.id);
      clearTimeout(item.timer);
      if (Object.hasOwn(response, "error")) {
        if (!object(response.error) || !Number.isInteger(response.error.code) || typeof response.error.message !== "string") {
          item.reject(new ProbeFailure("malformed_response", "Invalid JSON-RPC error"));
        } else item.reject(new ProbeFailure(classifyBridgeFailure(response.error.message), "Bridge returned a JSON-RPC error"));
      } else item.resolve(response.result);
    }
  });
  child.stderr.on("data", (chunk) => {
    const bytes = Buffer.from(chunk);
    stderrHash.update(bytes);
    metrics.stderrBytes += bytes.length;
    const scan = stderrTail + bytes.toString("utf8");
    metrics.fallbackDetected ||= /falling back|local fallback|fallback store/i.test(scan.replace(/no fallback store was used/ig, ""));
    stderrTail = scan.slice(-256);
    if (metrics.stderrBytes > 65536) fail(new ProbeFailure("response_limit", "MCP stderr exceeds the evidence limit"));
  });
  child.stdin.on("error", () => fail(new ProbeFailure("child_failure", "Bridge stdin failed")));
  child.on("error", () => fail(new ProbeFailure("child_failure", "Bridge process could not start")));
  child.on("close", () => {
    closed = true;
    if (buffer.length) fail(new ProbeFailure("malformed_response", "Bridge ended with incomplete JSON-RPC output"));
    else if (pending.size) fail(new ProbeFailure("child_failure", "Bridge exited before a response"));
  });
  return {
    request(method, params) {
      if (terminalFailure) return Promise.reject(terminalFailure);
      if (closed) return Promise.reject(new ProbeFailure("child_failure", "Bridge is closed"));
      const id = ++nextId;
      return new Promise((resolveResult, reject) => {
        const timer = setTimeout(() => fail(new ProbeFailure("timeout", "MCP request exceeded its deadline")), timeoutMs);
        pending.set(id, { resolve: resolveResult, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    initialized() { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); },
    evidence() { return { ...metrics, failureCategory: terminalFailure?.category, stdoutSha256: stdoutHash.copy().digest("hex"), stderrSha256: stderrHash.copy().digest("hex") }; },
  };
}

export async function diagnoseConnection(url, timeoutMs = 1000) {
  const endpoint = new URL(url);
  return new Promise((resolveResult) => {
    const socket = connect({ host: endpoint.hostname.replace(/^\[|\]$/g, ""), port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)) });
    let settled = false;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolveResult(result); };
    const timer = setTimeout(() => finish("inconclusive"), timeoutMs);
    socket.once("connect", () => finish("connected"));
    socket.once("error", (error) => finish(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"].includes(error.code) ? "unreachable" : "inconclusive"));
  });
}

async function stopOwnedChild(child, closed) {
  child.stdin.end();
  const wait = (milliseconds) => new Promise((resolveResult) => {
    const timer = setTimeout(() => resolveResult(null), milliseconds);
    closed.then((result) => { clearTimeout(timer); resolveResult(result); });
  });
  const normal = await wait(1000);
  if (normal) return { ...normal, sigtermSent: false };
  const sent = child.kill("SIGTERM");
  const terminated = await wait(5000);
  return terminated ? { ...terminated, sigtermSent: sent } : { exited: false, sigtermSent: sent, pid: child.pid };
}

export async function probeConsumer(options, { env = process.env, spawnProcess = spawn, diagnose = diagnoseConnection } = {}) {
  const start = Date.now();
  const stages = [];
  const evidence = { schema: 1, capturedAt: new Date().toISOString(), backendUrl: options.url,
    bridge: options.bridge, bridgeSha256: await sha256File(options.bridge), node: process.execPath,
    querySha256: digest(options.query), knownIdsSha256: idDigest(options.knownIds),
    expectedRecallIdsSha256: options.expectedRecallIdsSha256,
    expectedToolCount: options.expectedTools, timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes, stages, usable: false };
  let expectedNames;
  if (options.expectedToolsFile) {
    const bytes = await readFile(options.expectedToolsFile);
    if (bytes.length > 128 * 1024) throw new ProbeFailure("usage", "Expected inventory is too large");
    try { expectedNames = JSON.parse(bytes.toString("utf8")); }
    catch { throw new ProbeFailure("usage", "Expected inventory is not JSON"); }
    if (!Array.isArray(expectedNames) || expectedNames.length !== options.expectedTools || expectedNames.some((name) => typeof name !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(name)) || new Set(expectedNames).size !== expectedNames.length) {
      throw new ProbeFailure("usage", "Expected inventory must be a unique public tool-name array with the expected count");
    }
    expectedNames.sort();
    evidence.expectedToolNamesSha256 = idDigest(expectedNames);
  }
  const child = spawnProcess(process.execPath, [options.bridge], {
    env: { ...env, AGENTMEMORY_URL: options.url }, stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise((resolveResult) => child.once("close", (code, signal) => resolveResult({ exited: true, code, signal })));
  const client = createRpcClient(child, options);
  let activeStage;
  async function stage(name, callback) {
    activeStage = name;
    const started = Date.now();
    try {
      const result = await callback();
      stages.push({ name, status: "passed", durationMs: Date.now() - started, ...result });
    } catch (error) {
      stages.push({ name, status: "failed", durationMs: Date.now() - started });
      throw error;
    }
  }
  try {
    await stage("initialize", async () => {
      const initialized = await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "agentmemory-preservation-probe", version: "1" } });
      if (!object(initialized) || initialized.protocolVersion !== "2024-11-05" || !object(initialized.capabilities) || !object(initialized.serverInfo) || initialized.serverInfo.name !== "agentmemory" || typeof initialized.serverInfo.version !== "string" || initialized.serverInfo.version.length > 128 || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(initialized.serverInfo.version)) {
        throw new ProbeFailure("malformed_response", "Invalid initialize response");
      }
      client.initialized();
      return { protocolVersion: initialized.protocolVersion, serverVersion: initialized.serverInfo.version };
    });
    await stage("tools/list", async () => {
      const names = toolNames(await client.request("tools/list", {}));
      evidence.tools = { count: names.length, names, namesSha256: idDigest(names) };
      if (names.length !== options.expectedTools || !names.includes("memory_recall") || (expectedNames && JSON.stringify(names) !== JSON.stringify(expectedNames))) {
        throw new ProbeFailure("tool_inventory", "Tool inventory differs from the approved inventory");
      }
      return { count: names.length, namesSha256: idDigest(names) };
    });
    await stage("memory_recall", async () => {
      const result = await client.request("tools/call", { name: "memory_recall", arguments: { query: options.query, format: "compact", limit: options.limit } });
      const summary = recallSummary(result, options.knownIds);
      evidence.recall = summary;
      if (summary.count > options.limit) throw new ProbeFailure("malformed_response", "Recall exceeds the requested limit");
      if (!summary.count || summary.matchedKnownIdCount !== options.knownIds.length || (options.expectedRecallIdsSha256 && summary.idsSha256 !== options.expectedRecallIdsSha256)) {
        throw new ProbeFailure("known_recall_missing", "Known recall IDs are absent or their hash differs");
      }
      return summary;
    });
    evidence.usable = true;
  } catch (error) {
    const category = error instanceof ProbeFailure ? error.category : "probe_failure";
    evidence.failure = { category, stage: activeStage, reason: error instanceof ProbeFailure ? error.message : "Probe failed without a safe diagnostic" };
    if (category === "network_failure") {
      evidence.failure.endpointCheck = await diagnose(options.url);
      if (evidence.failure.endpointCheck === "unreachable") evidence.failure.category = "unreachable";
    }
  } finally {
    evidence.termination = await stopOwnedChild(child, closed);
    evidence.transport = client.evidence();
    if (evidence.transport.fallbackDetected || evidence.transport.failureCategory || !evidence.termination.exited) {
      evidence.usable = false;
      evidence.failure ??= { category: evidence.transport.fallbackDetected ? "fallback_detected" : evidence.transport.failureCategory ?? "shutdown_timeout", stage: "termination", reason: "Bridge fallback, transport failure or incomplete child shutdown blocks acceptance" };
    }
    evidence.durationMs = Date.now() - start;
  }
  return evidence;
}

async function main(args) {
  const options = parseOptions(args);
  if (options.help) { console.log(HELP); return; }
  await mkdir(dirname(options.out), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(options.out));
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) {
    throw new ProbeFailure("evidence", "Evidence parent must be an owner-only directory owned by this user");
  }
  const output = await open(options.out, "wx", 0o600);
  try {
    const evidence = await probeConsumer(options);
    await output.writeFile(JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify({ usable: evidence.usable, category: evidence.failure?.category ?? "passed", tools: evidence.tools?.count, recall: evidence.recall?.count }));
    process.exitCode = evidence.usable ? 0 : 1;
  } finally { await output.close(); }
}

if (await isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => { console.error("Consumer probe failed before evidence completion. Check usage, input paths and private output permissions."); process.exitCode = 2; });
}
