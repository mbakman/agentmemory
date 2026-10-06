import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isMain, writePrivateJson } from "./manifest.mjs";
import { valueMultiset } from "./values.mjs";

const nativeSource = "https://github.com/iii-hq/iii/tree/2b445957701f94dc5f56f900af314e9d59f3b0f7/engine/src/workers";

export function parseStateGroups(value) {
  if (!value || !Array.isArray(value.groups) || !value.groups.every((scope) => typeof scope === "string")) {
    throw new Error("state::list_groups did not return {groups: string[]}");
  }
  if (new Set(value.groups).size !== value.groups.length) throw new Error("Duplicate state scopes in inventory");
  return [...value.groups].sort();
}

export function parseStreams(value) {
  if (!value || !Array.isArray(value.stream) || value.count !== value.stream.length) {
    throw new Error("stream::list_all did not return {stream: metadata[], count}");
  }
  if (!value.stream.every((stream) => typeof stream?.id === "string" && Array.isArray(stream.groups)
    && stream.groups.every((group) => typeof group === "string"))) throw new Error("Malformed stream metadata");
  if (new Set(value.stream.map((stream) => stream.id)).size !== value.stream.length) throw new Error("Duplicate stream names");
  return [...value.stream].sort((left, right) => left.id.localeCompare(right.id));
}

export async function boundedRead(sdk, functionId, payload, timeoutMs, maxBytes) {
  let timer;
  try {
    const value = await Promise.race([
      sdk.trigger({ function_id: functionId, payload, timeoutMs }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Read timeout after ${timeoutMs} ms`)), timeoutMs); }),
    ]);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Native read returned undefined");
    const bytes = Buffer.byteLength(serialized);
    if (bytes > maxBytes) throw new Error(`Read exceeds ${maxBytes} byte coverage limit (${bytes} bytes received)`);
    return { value, bytes };
  } finally {
    clearTimeout(timer);
  }
}

export async function collectInventory(sdk, out, {
  timeoutMs = 20_000, maxBytes = 20 * 1024 * 1024, concurrency = 6,
  scopes = [], skipScopes = [], targets = [{ scope: "mem:config", key: "reflect:recentClusters" }],
  metadataOnly = false, onProgress = () => {},
} = {}) {
  const destination = resolve(out);
  await mkdir(destination, { mode: 0o700 });
  const summary = {
    schema: 1, capturedAt: new Date().toISOString(), source: nativeSource,
    timeoutMs, maxBytes, concurrency, requestedScopes: scopes, skippedScopes: skipScopes, metadataOnly,
    limitations: [
      "State and stream lists return values without arbitrary keys or pagination.",
      "Value multisets preserve duplicates; they do not prove arbitrary key mapping.",
      "A successful metadata read or zero active invocations does not prove all background work is drained.",
      "Response size limits apply after the SDK receives a response; oversized frames can still impair a probe.",
      "stream::list_all truncates colon-bearing group identifiers; stream::list_groups is authoritative for each stream.",
      "Queue metadata includes the first 100 dead-letter messages per topic; it does not enumerate pending queue payloads.",
    ],
    stateScopes: [], streams: [], entries: [], metadata: [], coverageGaps: [],
  };
  const saveSummary = () => writePrivateJson(resolve(destination, "summary.json"), summary);
  const fileName = (kind, identity) => `${kind}-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}.json`;
  const gap = (kind, identity, error) => {
    const item = { kind, ...identity, status: "gap", error: error instanceof Error ? error.message : String(error) };
    summary.coverageGaps.push(item);
    return item;
  };
  async function metadata(name, functionId, payload = {}, validate = (value) => value) {
    try {
      const { value, bytes } = await boundedRead(sdk, functionId, payload, timeoutMs, maxBytes);
      validate(value);
      const valuesFile = fileName("metadata", { name, payload });
      await writePrivateJson(resolve(destination, valuesFile), value);
      summary.metadata.push({ name, payload, status: "ok", bytes, valuesFile });
      return value;
    } catch (error) {
      summary.metadata.push(gap("metadata", { name, payload }, error));
      return null;
    }
  }
  const requireArray = (value) => {
    if (!Array.isArray(value)) throw new Error("Expected native metadata array");
    return value;
  };
  await metadata("workers-before", "engine::workers::list");
  const topics = await metadata("queue-topics", "engine::queue::list_topics", {}, requireArray);
  await metadata("queue-dlq-topics", "engine::queue::dlq_topics", {}, requireArray);
  for (const topic of topics ?? []) {
    if (typeof topic?.name !== "string") {
      gap("metadata", { name: "queue-topic" }, new Error("Queue topic has no name"));
      continue;
    }
    await metadata("queue-topic-stats", "engine::queue::topic_stats", { topic: topic.name });
    await metadata("queue-dlq-first-page", "engine::queue::dlq_messages", { topic: topic.name, offset: 0, limit: 100 }, requireArray);
  }
  const groupsValue = await metadata("state-scopes", "state::list_groups", {}, parseStateGroups);
  if (groupsValue) summary.stateScopes = parseStateGroups(groupsValue);
  const streamsValue = await metadata("stream-list-all", "stream::list_all", {}, parseStreams);
  for (const stream of streamsValue ? parseStreams(streamsValue) : []) {
    const groups = await metadata("stream-groups", "stream::list_groups", { stream_name: stream.id }, (value) => {
      if (!Array.isArray(value) || !value.every((group) => typeof group === "string") || new Set(value).size !== value.length) {
        throw new Error("stream::list_groups did not return unique string group names");
      }
    });
    summary.streams.push({ id: stream.id, groups: groups ? [...groups].sort() : [], groupsComplete: groups !== null });
  }
  const tasks = [];
  if (!metadataOnly) {
    for (const scope of summary.stateScopes) {
      if (scopes.length && !scopes.includes(scope)) continue;
      if (skipScopes.includes(scope)) {
        summary.entries.push(gap("state", { scope }, new Error("Scope was explicitly skipped")));
      } else tasks.push({ kind: "state", identity: { scope }, functionId: "state::list", payload: { scope } });
    }
    for (const stream of summary.streams) {
      for (const group of stream.groups) {
        tasks.push({ kind: "stream", identity: { stream: stream.id, group }, functionId: "stream::list", payload: { stream_name: stream.id, group_id: group } });
      }
    }
    for (const target of targets) {
      if (typeof target?.scope !== "string" || typeof target?.key !== "string") throw new Error("Targets must contain scope and key strings");
      tasks.push({ kind: "target", identity: target, functionId: "state::get", payload: { scope: target.scope, key: target.key } });
    }
  }
  let next = 0;
  let completed = 0;
  let lastProgress = 0;
  async function runTasks() {
    for (;;) {
      const task = tasks[next++];
      if (!task) return;
      const started = Date.now();
      try {
        const { value, bytes } = await boundedRead(sdk, task.functionId, task.payload, timeoutMs, maxBytes);
        const values = task.kind === "target" ? [value] : value;
        if (!Array.isArray(values)) throw new Error("Native list did not return a value array");
        const valuesFile = fileName(task.kind, task.identity);
        await writePrivateJson(resolve(destination, valuesFile), value);
        summary.entries.push({ kind: task.kind, ...task.identity, status: "ok", bytes, durationMs: Date.now() - started, valuesFile, multiset: valueMultiset(values) });
      } catch (error) {
        summary.entries.push(gap(task.kind, task.identity, error));
      }
      completed++;
      if (completed === tasks.length || completed - lastProgress >= 100) {
        onProgress({ completed, total: tasks.length, gaps: summary.coverageGaps.length });
        lastProgress = completed;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, runTasks));
  summary.entries.sort((left, right) => JSON.stringify([left.kind, left.scope, left.key, left.stream, left.group]).localeCompare(JSON.stringify([right.kind, right.scope, right.key, right.stream, right.group])));
  await metadata("workers-after", "engine::workers::list");
  summary.finishedAt = new Date().toISOString();
  summary.complete = !metadataOnly && scopes.length === 0 && summary.coverageGaps.length === 0;
  summary.valueCount = summary.entries.reduce((count, entry) => count + (entry.multiset?.count ?? 0), 0);
  await saveSummary();
  return summary;
}

async function main(args) {
  const options = { scopes: [], skipScopes: [] };
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === "--metadata-only") options.metadataOnly = true;
    else if (["--sdk", "--url", "--out", "--targets", "--timeout-ms", "--max-bytes", "--concurrency", "--scope", "--skip-scope"].includes(option) && args[i + 1]) {
      const value = args[++i];
      if (option === "--scope") options.scopes.push(value);
      else if (option === "--skip-scope") options.skipScopes.push(value);
      else values.set(option, value);
    } else throw new Error(`Unknown or incomplete option: ${option}`);
  }
  for (const key of ["--sdk", "--url", "--out"]) if (!values.has(key)) throw new Error(`Missing ${key}`);
  const address = new URL(values.get("--url"));
  if (!["ws:", "wss:"].includes(address.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname) || address.username || address.password) {
    throw new Error("Inventory requires a local WebSocket address without credentials");
  }
  for (const [option, key, maximum] of [["--timeout-ms", "timeoutMs", 120_000], ["--max-bytes", "maxBytes", 512 * 1024 * 1024], ["--concurrency", "concurrency", 6]]) {
    if (values.has(option)) {
      const value = Number(values.get(option));
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${option}`);
      options[key] = value;
    }
  }
  if (values.has("--targets")) options.targets = JSON.parse(await readFile(values.get("--targets"), "utf8"));
  options.onProgress = (progress) => console.log(JSON.stringify(progress));
  const out = resolve(values.get("--out"));
  try { await stat(out); throw new Error("Inventory output directory already exists; use a fresh path"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  process.env.OTEL_ENABLED = "false";
  process.env.III_TELEMETRY_ENABLED = "false";
  const { registerWorker } = await import(pathToFileURL(resolve(values.get("--sdk"))).href);
  if (typeof registerWorker !== "function") throw new Error("SDK does not export registerWorker");
  const sdk = registerWorker(address.href, {
    workerName: `preservation-inventory-${process.pid}`, enableMetricsReporting: false,
    invocationTimeoutMs: options.timeoutMs ?? 20_000, otel: { enabled: false },
    reconnectionConfig: { maxRetries: 0 },
  });
  try {
    const summary = await collectInventory(sdk, out, options);
    console.log(JSON.stringify({ complete: summary.complete, scopes: summary.stateScopes.length, streams: summary.streams.length, entries: summary.entries.length, valueCount: summary.valueCount, gaps: summary.coverageGaps.length }));
    if (summary.coverageGaps.length) process.exitCode = 1;
  } finally {
    await sdk.shutdown();
  }
}

if (await isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 2; });
}
