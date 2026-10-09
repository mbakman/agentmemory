import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain, sha256File, writePrivateJson } from "./manifest.mjs";
import { createInventoryReader, reconstructVectors } from "./migration-report.mjs";
import { canonicalJson } from "./values.mjs";

const indexRoot = "mem:index:bm25";
const bm25Prefix = `${indexRoot}:bm25:`;
const vectorPrefix = `${indexRoot}:vectors:`;
const bucketPrefix = `${indexRoot}:vec:`;
const sourceCommit = "d03e88f6a08c8eb602fd1dc4174a2f5124862274";
const sources = {
  legacyCleanup: { commit: sourceCommit, path: "src/state/index-persistence.ts", lines: "643-722" },
  vectorBuckets: { commit: sourceCommit, path: "src/state/index-persistence.ts", lines: "14-49,609-640" },
  auditMigration: { commit: sourceCommit, path: "src/functions/audit.ts", lines: "392-469" },
  observationIndex: { commit: sourceCommit, path: "src/state/obs-index.ts", lines: "4-19" },
  projectSessionIndex: { commit: sourceCommit, path: "src/state/session-index.ts", lines: "181-203" },
  scopeNames: { commit: sourceCommit, path: "src/state/schema.ts", lines: "4-64" },
  keywordEligibility: { commit: "0e472a03f055424043cf9cb8688b1e085a5ed1ca", path: "src/functions/search.ts", lines: "600-649" },
  keywordInsertion: { commit: "0e472a03f055424043cf9cb8688b1e085a5ed1ca", path: "src/state/search-index.ts", lines: "22-37" },
  keywordList: { commit: "0e472a03f055424043cf9cb8688b1e085a5ed1ca", path: "src/state/kv.ts", lines: "151-157" },
  fileNames: { commit: "2b445957701f94dc5f56f900af314e9d59f3b0f7", path: "engine/src/builtins/kv.rs", lines: "49-86,163-169,340-366" },
};
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function describeSet(ids) {
  return { count: ids.size, sha256: hash(JSON.stringify([...ids].sort())) };
}

export function compareIdSets(before, after) {
  const intersection = new Set([...before].filter((id) => after.has(id)));
  const removed = new Set([...before].filter((id) => !after.has(id)));
  const added = new Set([...after].filter((id) => !before.has(id)));
  return { before: describeSet(before), after: describeSet(after), intersection: describeSet(intersection), removed: describeSet(removed), added: describeSet(added) };
}

function union(...sets) { return new Set(sets.flatMap((set) => [...set])); }
function difference(before, after) { return new Set([...before].filter((id) => !after.has(id))); }
function intersection(before, after) { return new Set([...before].filter((id) => after.has(id))); }

function collectId(ids, row, label) {
  if (!row || typeof row.id !== "string" || !row.id) throw new Error(`Invalid ${label} ID in native evidence`);
  ids.add(row.id);
}

async function inputJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error(`Cannot read JSON evidence: ${basename(path)}`); }
}

async function inputProof(path) {
  const filename = path instanceof URL ? fileURLToPath(path) : path;
  return { path: resolve(filename), sha256: await sha256File(filename) };
}

export async function inventoryCoverage(summary, reader) {
  if (summary.complete !== true || (summary.coverageGaps ?? []).length) throw new Error("Native inventory is incomplete");
  const observations = new Set();
  const memories = new Set();
  const eligibleObservations = new Set();
  const eligibleMemories = new Set();
  const textEligibleObservations = new Set();
  const observationsOutsideSessionWalk = new Set();
  const outsideSessionScopes = new Set();
  const sessions = new Set();
  const sessionScopeSuffixes = new Set();
  let sessionRows = 0;
  let sessionRowsMissingId = 0;
  let observationRows = 0;
  let memoryRows = 0;
  const stateEntries = summary.entries.filter((entry) => entry.kind === "state");
  const sessionsEntry = stateEntries.find((entry) => entry.scope === "mem:sessions");
  if (!sessionsEntry) throw new Error("Native inventory lacks session values required for keyword rebuild");
  for (const row of await reader(sessionsEntry)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid session value in native evidence");
    sessionRows++;
    if (typeof row.id === "string") sessions.add(row.id);
    else if (row.id === undefined) sessionRowsMissingId++;
    else throw new Error("Unsupported session ID type in native evidence");
    sessionScopeSuffixes.add(String(row.id));
  }
  for (const entry of stateEntries) {
    if (entry.scope !== "mem:memories" && !entry.scope.startsWith("mem:obs:")) continue;
    const values = await reader(entry);
    const memory = entry.scope === "mem:memories";
    for (const row of values) {
      collectId(memory ? memories : observations, row, memory ? "memory" : "observation");
      if (memory) {
        memoryRows++;
        if (row.isLatest !== false && row.title && row.content) eligibleMemories.add(row.id);
      } else {
        observationRows++;
        const walked = sessionScopeSuffixes.has(entry.scope.slice("mem:obs:".length));
        if (!walked) { observationsOutsideSessionWalk.add(row.id); outsideSessionScopes.add(entry.scope); }
        if (row.title && row.narrative) {
          textEligibleObservations.add(row.id);
          if (walked) eligibleObservations.add(row.id);
        }
      }
    }
  }
  const reconstructed = await reconstructVectors(summary, reader);
  const vectors = new Set(reconstructed.rows.map((row) => row.id));
  const vectorMembers = new Map();
  for (const row of reconstructed.rows) {
    const members = vectorMembers.get(row.id) ?? [];
    members.push(hash(canonicalJson(row)));
    vectorMembers.set(row.id, members);
  }
  const vectorDigests = new Map([...vectorMembers].map(([id, members]) => [id, hash(JSON.stringify(members.sort()))]));
  const allRecords = union(observations, memories);
  const eligibleRecords = union(eligibleObservations, eligibleMemories);
  const rootEntry = stateEntries.find((entry) => entry.scope === indexRoot);
  const rootValues = rootEntry ? await reader(rootEntry) : [];
  const legacy = { bm25: new Set(), vectors: new Set() };
  for (const value of rootValues) {
    if (value?.v !== 1 || !Array.isArray(value.shards)) continue;
    for (const shard of value.shards) {
      if (typeof shard.scope !== "string") throw new Error("Invalid legacy index manifest scope");
      if (shard.scope.startsWith(bm25Prefix)) legacy.bm25.add(shard.scope);
      else if (shard.scope.startsWith(vectorPrefix)) legacy.vectors.add(shard.scope);
    }
  }
  const nativeScopes = new Map(stateEntries.map((entry) => [entry.scope, entry.multiset?.count]));
  const nativeValuesByKind = {};
  for (const entry of summary.entries) nativeValuesByKind[entry.kind] = (nativeValuesByKind[entry.kind] ?? 0) + (entry.multiset?.count ?? 0);
  return {
    sets: { observations, memories, vectors, allRecords, eligibleRecords, eligibleObservations, eligibleMemories }, vectorDigests, legacy, nativeScopes,
    report: {
      complete: true, nativeInventoryValues: summary.valueCount, nativeValuesByKind,
      observations: { rows: observationRows, ids: describeSet(observations), duplicateIdRows: observationRows - observations.size, textEligibleIds: describeSet(textEligibleObservations), keywordEligibleIds: describeSet(eligibleObservations), excludedMissingTitleOrNarrative: compareIdSets(observations, textEligibleObservations).removed, excludedTextEligibleOutsideSessionWalk: compareIdSets(textEligibleObservations, eligibleObservations).removed, outsideSessionWalk: describeSet(observationsOutsideSessionWalk), outsideSessionWalkScopes: describeSet(outsideSessionScopes) },
      memories: { rows: memoryRows, ids: describeSet(memories), duplicateIdRows: memoryRows - memories.size, keywordEligibleIds: describeSet(eligibleMemories) },
      observationMemoryOverlap: compareIdSets(observations, memories).intersection,
      recordUnion: describeSet(allRecords), keywordEligibleUnion: describeSet(eligibleRecords),
      keywordSessionWalk: { rows: sessionRows, rowsMissingId: sessionRowsMissingId, sessions: describeSet(sessions), scopeSuffixes: describeSet(sessionScopeSuffixes), eligibility: "Memory isLatest !== false with truthy title/content; observations with truthy title/narrative only in mem:obs:<session.id> scopes from mem:sessions. Missing session.id is stringified as undefined by the source template. File-backed StateKV.list returns native values directly; no deletedAt or _meta.deleted predicate occurs in the rebuild.", sources: { rebuild: sources.keywordEligibility, insertion: sources.keywordInsertion, nativeList: sources.keywordList, scopes: sources.scopeNames } },
      vectors: { rows: reconstructed.count, ids: describeSet(vectors), duplicateIdRows: reconstructed.duplicateIds, representation: reconstructed.representation, dimensions: reconstructed.dimensions, logicalMultisetSha256: reconstructed.multiset.sha256 },
      observationCoverage: compareIdSets(observations, vectors), memoryCoverage: compareIdSets(memories, vectors),
      recordCoverage: compareIdSets(allRecords, vectors), keywordEligibleVectorCoverage: compareIdSets(eligibleRecords, vectors),
      keywordObservationVectorCoverage: compareIdSets(eligibleObservations, vectors), keywordMemoryVectorCoverage: compareIdSets(eligibleMemories, vectors),
      vectorIdsExcludedFromKeywordRebuild: { observationMissingTitleOrNarrative: describeSet(intersection(vectors, difference(observations, textEligibleObservations))), textEligibleObservationOutsideSessionWalk: describeSet(intersection(vectors, difference(textEligibleObservations, eligibleObservations))), memorySupersededOrMissingTitleContent: describeSet(intersection(vectors, difference(memories, eligibleMemories))), absentFromStoredRecords: describeSet(difference(vectors, allRecords)) },
      activeLegacyManifestScopes: { bm25: describeSet(legacy.bm25), vectors: describeSet(legacy.vectors) },
      limitation: "ID sets use native value.id and reconstructed logical vector IDs; arbitrary engine key associations remain unproven. Missing means a record ID has no persisted vector; orphan means a vector ID is absent from both record sets.",
    },
  };
}

function compareCoverage(before, after) {
  const ids = compareIdSets(before.sets.vectors, after.sets.vectors);
  let unchanged = 0;
  let changed = 0;
  for (const id of before.sets.vectors) {
    if (!after.sets.vectors.has(id)) continue;
    if (before.vectorDigests.get(id) === after.vectorDigests.get(id)) unchanged++;
    else changed++;
  }
  return {
    observations: compareIdSets(before.sets.observations, after.sets.observations),
    memories: compareIdSets(before.sets.memories, after.sets.memories), vectors: ids,
    keywordEligibleRecords: compareIdSets(before.sets.eligibleRecords, after.sets.eligibleRecords),
    commonVectorIdsWithUnchangedSessionDimensionAndBytes: unchanged,
    commonVectorIdsWithChangedSessionDimensionOrBytes: changed,
  };
}

function fileIndex(entry) {
  const parts = entry.path.split("/");
  if (parts.length !== 2 || !["state_store.db", "stream_store"].includes(parts[0]) || !parts[1].endsWith(".bin")) return null;
  try { return { store: parts[0], scope: decodeURIComponent(parts[1].slice(0, -4)) }; }
  catch { return { store: parts[0], invalid: true }; }
}

function fileCategory(entry) {
  const index = fileIndex(entry);
  if (!index) return entry.path === "iii-config.yaml" ? "configuration" : "unclassified-file";
  if (index.invalid) return "invalid-scope-filename";
  if (index.store === "stream_store") return "stream-group";
  const scope = index.scope;
  if (scope.startsWith(bm25Prefix)) return "legacy-bm25-shard";
  if (scope.startsWith(vectorPrefix)) return "legacy-vector-shard";
  if (scope.startsWith(bucketPrefix)) return "vector-bucket";
  if (scope === "mem:audit") return "legacy-audit";
  if (/^mem:audit:\d{4}-\d{2}$/.test(scope)) return "monthly-audit";
  if (scope === "mem:audit:months") return "audit-metadata";
  if (scope === indexRoot) return "index-root-metadata";
  if (/^mem:idx:obs:\d+$/.test(scope)) return "observation-session-index";
  if (scope === "mem:idx:project-sessions") return "project-session-index";
  if (scope.startsWith("mem:capture:events:")) return "capture-event";
  if (scope.startsWith("mem:obs:")) return "observation-scope";
  if (["mem:health", "mem:metrics", "mem:access"].includes(scope)) return "runtime-metadata";
  return "other-state";
}

export function reconcileFiles(before, after, oldCoverage, finalCoverage) {
  const left = new Map(before.entries.filter((entry) => entry.type === "file").map((entry) => [entry.path, entry]));
  const right = new Map(after.entries.filter((entry) => entry.type === "file").map((entry) => [entry.path, entry]));
  const categories = new Map();
  const unexplained = [];
  const activeCleanup = { bm25: { manifestScopes: oldCoverage.legacy.bm25.size, removed: 0, retained: 0 }, vectors: { manifestScopes: oldCoverage.legacy.vectors.size, removed: 0, retained: 0 } };
  const staleLegacy = { bm25: { files: 0, emptyNativeScopes: 0, nativeValues: 0 }, vectors: { files: 0, emptyNativeScopes: 0, nativeValues: 0 } };
  const generations = new Map();
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const beforeEntry = left.get(path);
    const afterEntry = right.get(path);
    const category = fileCategory(beforeEntry ?? afterEntry);
    const row = categories.get(category) ?? { category, before: 0, after: 0, removed: 0, added: 0, retained: 0, modifiedRetained: 0 };
    if (beforeEntry) row.before++;
    if (afterEntry) row.after++;
    if (beforeEntry && afterEntry) { row.retained++; if (beforeEntry.sha256 !== afterEntry.sha256) row.modifiedRetained++; }
    else if (beforeEntry) row.removed++;
    else row.added++;
    categories.set(category, row);
    const scope = fileIndex(beforeEntry ?? afterEntry)?.scope;
    const leg = category === "legacy-bm25-shard" ? "bm25" : category === "legacy-vector-shard" ? "vectors" : null;
    if (leg) {
      const prefix = leg === "bm25" ? bm25Prefix : vectorPrefix;
      const suffix = scope.slice(prefix.length);
      const split = suffix.lastIndexOf(":");
      if (split < 1 || !/^\d+$/.test(suffix.slice(split + 1))) throw new Error("Unknown legacy generation scope schema");
      const generationSha256 = hash(suffix.slice(0, split));
      const key = `${leg}:${generationSha256}`;
      const generation = generations.get(key) ?? { leg, generationSha256, beforeFiles: 0, afterFiles: 0, referencedOriginalManifestScopes: 0, afterNativeValues: 0, afterEmptyNativeScopes: 0 };
      if (beforeEntry) { generation.beforeFiles++; if (oldCoverage.legacy[leg].has(scope)) generation.referencedOriginalManifestScopes++; }
      if (afterEntry) { generation.afterFiles++; const count = finalCoverage.nativeScopes.get(scope); if (count === 0) generation.afterEmptyNativeScopes++; if (typeof count === "number") generation.afterNativeValues += count; }
      generations.set(key, generation);
    }
    if (leg && beforeEntry && oldCoverage.legacy[leg].has(scope)) {
      activeCleanup[leg][afterEntry ? "retained" : "removed"]++;
    } else if (leg && afterEntry) {
      staleLegacy[leg].files++;
      const count = finalCoverage.nativeScopes.get(scope);
      if (count === 0) staleLegacy[leg].emptyNativeScopes++;
      if (typeof count === "number") staleLegacy[leg].nativeValues += count;
      else unexplained.push({ reason: "retained-legacy-scope-not-in-native-inventory", scopeSha256: hash(scope) });
    }
    if (!beforeEntry && !["vector-bucket", "monthly-audit", "audit-metadata", "observation-session-index", "project-session-index", "capture-event", "observation-scope"].includes(category)) {
      unexplained.push({ reason: "unclassified-file-addition", category, pathSha256: hash(path) });
    }
    if (!afterEntry && !(leg && oldCoverage.legacy[leg].has(scope)) && category !== "legacy-audit") {
      unexplained.push({ reason: "unclassified-file-removal", category, pathSha256: hash(path) });
    }
    if (["unclassified-file", "invalid-scope-filename"].includes(category)) unexplained.push({ reason: "unclassified-file", category, pathSha256: hash(path) });
  }
  const rows = [...categories.values()].sort((a, b) => a.category.localeCompare(b.category));
  const removed = rows.reduce((sum, row) => sum + row.removed, 0);
  const added = rows.reduce((sum, row) => sum + row.added, 0);
  return {
    beforeFiles: left.size, afterFiles: right.size, removed, added, netChange: right.size - left.size,
    reconciles: left.size - removed + added === right.size, categories: rows, activeManifestCleanup: activeCleanup,
    retainedLegacyOutsideOriginalActiveManifests: staleLegacy, legacyGenerations: [...generations.values()].sort((a, b) => a.leg.localeCompare(b.leg) || a.generationSha256.localeCompare(b.generationSha256)), unexplained,
    sources: { cleanup: sources.legacyCleanup, vectorBuckets: sources.vectorBuckets, audit: sources.auditMigration, observationIndex: sources.observationIndex, projectIndex: sources.projectSessionIndex, names: sources.scopeNames, physical: sources.fileNames },
    limitation: "File categories explain inventory presence changes; they do not establish full semantic preservation or justify deleting retained stale shards. Ready native values may predate the final cold file manifest.",
  };
}

function functionalDelta(report) {
  const changes = report.changes ?? [];
  const protectedRoles = new Set(["observations", "protected-state", "protected-stream", "protected-target"]);
  const aggregate = (items) => ({ entries: items.length, removedValues: items.reduce((sum, row) => sum + (row.removedValues ?? 0), 0), addedValues: items.reduce((sum, row) => sum + (row.addedValues ?? 0), 0) });
  return { acceptance: report.acceptance, totals: report.totals, allChanges: aggregate(changes), protectedChanges: aggregate(changes.filter((row) => protectedRoles.has(row.role))), byRole: [...new Set(changes.map((row) => row.role))].sort().map((role) => ({ role, ...aggregate(changes.filter((row) => row.role === role)) })), rawBlockerCount: report.rawBlockers?.length ?? null, vectors: { removed: report.vectors?.removedValues, added: report.vectors?.addedValues }, limitation: "This summarizes the existing functional comparison; expected probe additions retain its raw BLOCKED verdict." };
}

export function coverageMarkdown(report) {
  const lines = ["# Captured index coverage and physical-file reconciliation", "", "| Phase | Observation rows / unique IDs | Memory IDs | Vector IDs | Vectors covering observations | Vectors covering memories | Missing record IDs | Orphan vector IDs |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"];
  for (const phase of report.phases) { const c = phase.coverage; lines.push(`| ${phase.label} | ${c.observations.rows} / ${c.observations.ids.count} | ${c.memories.ids.count} | ${c.vectors.ids.count} | ${c.observationCoverage.intersection.count} | ${c.memoryCoverage.intersection.count} | ${c.recordCoverage.removed.count} | ${c.recordCoverage.added.count} |`); }
  lines.push("", "| Phase | Rebuild-eligible observations | Rebuild-eligible memories | Eligible/vector intersection | Eligible IDs lacking vectors | Vectors outside rebuild-eligible IDs |", "| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const phase of report.phases) { const c = phase.coverage; lines.push(`| ${phase.label} | ${c.observations.keywordEligibleIds.count} | ${c.memories.keywordEligibleIds.count} | ${c.keywordEligibleVectorCoverage.intersection.count} | ${c.keywordEligibleVectorCoverage.removed.count} | ${c.keywordEligibleVectorCoverage.added.count} |`); }
  for (const phase of report.phases) { const c = phase.coverage; lines.push("", `${phase.label}: excluded observation IDs missing title/narrative ${c.observations.excludedMissingTitleOrNarrative.count}; text-eligible IDs outside scopes of stored sessions ${c.observations.excludedTextEligibleOutsideSessionWalk.count} (${c.observations.outsideSessionWalkScopes.count} scopes).`); }
  for (const phase of report.phases) { const c = phase.coverage.vectorIdsExcludedFromKeywordRebuild; lines.push("", `${phase.label}: stored vectors outside rebuild eligibility: observation missing title/narrative ${c.observationMissingTitleOrNarrative.count}, text-eligible observation outside session walk ${c.textEligibleObservationOutsideSessionWalk.count}, ineligible memory ${c.memorySupersededOrMissingTitleContent.count}; vector IDs absent from all stored records ${c.absentFromStoredRecords.count}.`); }
  for (const comparison of report.comparisons) lines.push("", `${comparison.before} → ${comparison.after}: observation IDs removed/added ${comparison.observations.removed.count}/${comparison.observations.added.count}; memory IDs ${comparison.memories.removed.count}/${comparison.memories.added.count}; vector IDs ${comparison.vectors.removed.count}/${comparison.vectors.added.count}; changed common vector byte/session/dimension groups ${comparison.commonVectorIdsWithChangedSessionDimensionOrBytes}.`);
  if (report.files) {
    const f = report.files;
    lines.push("", `${f.beforeFiles} − ${f.removed} + ${f.added} = ${f.afterFiles} files; net ${f.netChange}. Unexplained categories: ${f.unexplained.length}.`, "", "| File category | Before | After | Removed | Added | Retained with changed bytes |", "| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const row of f.categories) lines.push(`| ${row.category} | ${row.before} | ${row.after} | ${row.removed} | ${row.added} | ${row.modifiedRetained} |`);
    lines.push("", `Retained legacy scopes outside original active manifests: BM25 ${f.retainedLegacyOutsideOriginalActiveManifests.bm25.files} (${f.retainedLegacyOutsideOriginalActiveManifests.bm25.emptyNativeScopes} empty); vectors ${f.retainedLegacyOutsideOriginalActiveManifests.vectors.files}. These are reported, not removed.`);
  }
  if (report.functional) lines.push("", `Existing functional comparison: ${report.functional.acceptance}; protected removed values ${report.functional.protectedChanges.removedValues}, protected additions ${report.functional.protectedChanges.addedValues}.`);
  if (report.status) lines.push("", `Captured ready status: BM25 ${report.status.bm25Documents}, vectors ${report.status.vectorDocuments}; incomplete=${report.status.bm25Incomplete}; derived eligible count agrees=${report.status.matchesDerivedRebuildEligibleCount}.`);
  lines.push("", "All set digests and input SHA256 values are in the accompanying JSON. No raw IDs, narratives, source payloads, or embeddings are emitted.", "", "The comparison concerns captured native evidence. Rebuild-eligible IDs follow the verified source walk and match the captured ready BM25 count; the in-memory BM25 ID list was not captured separately. Values-only APIs do not prove arbitrary stored keys; missing vectors are coverage gaps, not proof of migration loss. Final cold-file hashes can include later audit writes absent from the ready inventory.");
  return `${lines.join("\n")}\n`;
}

async function main(args) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: coverage-report.mjs --inventory LABEL=SUMMARY [--inventory LABEL=SUMMARY] --out JSON [--before-files JSON --after-files JSON] [--functional-delta JSON] [--status JSON] [--markdown MD]");
    return;
  }
  const options = new Map();
  const inventories = [];
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!["--inventory", "--before-files", "--after-files", "--functional-delta", "--status", "--out", "--markdown"].includes(name) || !args[i + 1]) throw new Error("Usage: coverage-report.mjs --inventory LABEL=SUMMARY [--inventory LABEL=SUMMARY] --out JSON [--before-files JSON --after-files JSON] [--functional-delta JSON] [--status JSON] [--markdown MD]");
    const value = args[++i];
    if (name === "--inventory") {
      const separator = value.indexOf("=");
      if (separator < 1 || separator === value.length - 1) throw new Error("Inventory must be LABEL=SUMMARY");
      inventories.push({ label: value.slice(0, separator), path: value.slice(separator + 1) });
    } else options.set(name, value);
  }
  if (!inventories.length || !options.has("--out") || new Set(inventories.map((item) => item.label)).size !== inventories.length) throw new Error("Unique inventories and output path are required");
  if (options.has("--before-files") !== options.has("--after-files")) throw new Error("Both file manifests are required");
  const phases = [];
  const results = [];
  for (const inventory of inventories) {
    const summary = await inputJson(inventory.path);
    const coverage = await inventoryCoverage(summary, createInventoryReader(summary, inventory.path));
    results.push(coverage);
    phases.push({ label: inventory.label, input: await inputProof(inventory.path), coverage: coverage.report });
    console.log(JSON.stringify({ phase: inventory.label, observations: coverage.report.observations.ids.count, memories: coverage.report.memories.ids.count, vectors: coverage.report.vectors.ids.count, missingRecords: coverage.report.recordCoverage.removed.count, orphanVectors: coverage.report.recordCoverage.added.count }));
  }
  const report = { schema: 1, measuredAt: new Date().toISOString(), phases, sources, comparisons: results.slice(1).map((result, index) => ({ before: phases[0].label, after: phases[index + 1].label, ...compareCoverage(results[0], result) })), tooling: { migrationReader: await inputProof(new URL("./migration-report.mjs", import.meta.url)), values: await inputProof(new URL("./values.mjs", import.meta.url)) } };
  if (options.has("--before-files")) {
    const beforePath = options.get("--before-files");
    const afterPath = options.get("--after-files");
    report.fileInputs = { before: await inputProof(beforePath), after: await inputProof(afterPath) };
    report.files = reconcileFiles(await inputJson(beforePath), await inputJson(afterPath), results[0], results.at(-1));
  }
  if (options.has("--functional-delta")) { report.functionalInput = await inputProof(options.get("--functional-delta")); report.functional = functionalDelta(await inputJson(options.get("--functional-delta"))); }
  if (options.has("--status")) {
    report.statusInput = await inputProof(options.get("--status"));
    const status = await inputJson(options.get("--status"));
    const index = status.body?.index ?? status.index;
    if (!index || !Number.isInteger(index.bm25Documents) || !Number.isInteger(index.vectorDocuments)) throw new Error("Captured status lacks index counts");
    const finalCoverage = phases.at(-1).coverage;
    report.status = { bm25Documents: index.bm25Documents, vectorDocuments: index.vectorDocuments, bm25Incomplete: index.bm25Incomplete, breakdown: index.breakdown, derivedRebuildEligibleIds: finalCoverage.keywordEligibleUnion, matchesDerivedRebuildEligibleCount: finalCoverage.keywordEligibleUnion.count === index.bm25Documents, matchesDerivedBreakdown: index.breakdown?.observations === finalCoverage.observations.keywordEligibleIds.count && index.breakdown?.memories === finalCoverage.memories.keywordEligibleIds.count, limitation: "The derived deterministic rebuild set matches captured counts; the actual in-memory BM25 ID set was not independently enumerated." };
  }
  await writePrivateJson(options.get("--out"), report);
  if (options.has("--markdown")) {
    const path = resolve(options.get("--markdown"));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, coverageMarkdown(report), { flag: "wx", mode: 0o600 });
  }
  console.log(JSON.stringify({ phases: phases.length, filesBefore: report.files?.beforeFiles, filesAfter: report.files?.afterFiles, fileCategoriesUnexplained: report.files?.unexplained.length, protectedFunctionalRemovals: report.functional?.protectedChanges.removedValues }));
}

if (await isMain(import.meta.url)) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 2; });
