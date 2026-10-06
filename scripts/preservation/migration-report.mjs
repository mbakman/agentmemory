import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { isMain, writePrivateJson } from "./manifest.mjs";
import { canonicalJson, compareValueMultisets, valueMultiset } from "./values.mjs";

const emptyMultiset = valueMultiset([]);
const indexRoot = "mem:index:bm25";
const vectorShardPrefix = `${indexRoot}:vectors:`;
const vectorBucketPrefix = `${indexRoot}:vec:`;
const auditDataScope = (scope) => scope === "mem:audit" || /^mem:audit:\d{4}-\d{2}$/.test(scope);
const digest = (value) => createHash("sha256").update(value).digest("hex");

function entryIdentity(entry) {
  return JSON.stringify([entry.kind, entry.scope ?? null, entry.key ?? null, entry.stream ?? null, entry.group ?? null]);
}

export function scopeRole(entry) {
  if (entry.kind === "stream") return entry.stream === "mem-live" && entry.group === "viewer" ? "viewer-stream" : "protected-stream";
  if (entry.kind === "target") return "protected-target";
  if (auditDataScope(entry.scope)) return "audit-records";
  if (entry.scope === "mem:audit:months" || entry.scope === "mem:audit:migration-lock") return "audit-metadata";
  if (entry.scope === indexRoot || entry.scope?.startsWith(`${indexRoot}:`) || entry.scope === "mem:index:vec-pending"
    || entry.scope === "mem:idx:project-sessions" || /^mem:idx:obs:\d+$/.test(entry.scope ?? "")) return "index-representation";
  if (["mem:health", "mem:metrics", "mem:access"].includes(entry.scope)) return "runtime-metadata";
  if (entry.scope?.startsWith("mem:obs:")) return "observations";
  return "protected-state";
}

export function multisetDelta(before, after) {
  const comparison = compareValueMultisets(before, after);
  return {
    equal: comparison.equal, beforeCount: before.count, afterCount: after.count,
    removedValues: comparison.differences.reduce((count, item) => count + Math.max(0, item.before - item.after), 0),
    addedValues: comparison.differences.reduce((count, item) => count + Math.max(0, item.after - item.before), 0),
    beforeSha256: before.sha256, afterSha256: after.sha256,
  };
}

async function readJson(path) {
  let raw;
  try { raw = await readFile(path, "utf8"); }
  catch { throw new Error(`Cannot read evidence file: ${basename(path)}`); }
  try { return JSON.parse(raw); }
  catch { throw new Error(`Cannot parse evidence file: ${basename(path)}`); }
}

export function createInventoryReader(summary, summaryPath, extraRoots = []) {
  return async (entry) => {
    if (entry?.status !== "ok" || typeof entry.valuesFile !== "string") throw new Error("Native values are unavailable");
    const composition = summary.composition;
    const preferred = composition && (composition.replacedScopes ?? []).includes(entry.scope) ? composition.supplement : composition?.base;
    const roots = [...new Set([preferred, ...extraRoots, dirname(resolve(summaryPath))].filter((root) => typeof root === "string"))];
    const candidates = isAbsolute(entry.valuesFile) ? [entry.valuesFile] : roots.map((root) => resolve(root, entry.valuesFile));
    let found = false;
    for (const path of candidates) {
      let value;
      try { value = await readJson(path); } catch { continue; }
      found = true;
      const values = entry.kind === "target" ? [value] : value;
      if (!Array.isArray(values)) continue;
      if (valueMultiset(values).sha256 === entry.multiset?.sha256) return values;
    }
    throw new Error(found ? "Evidence values do not match their native inventory digest" : "Evidence values file is missing");
  };
}

function stateEntries(summary) {
  return summary.entries.filter((entry) => entry.kind === "state");
}

function structuralCoverageGaps(summary, side) {
  const gaps = [];
  const stateScopes = new Set(stateEntries(summary).map((entry) => entry.scope));
  for (const scope of summary.stateScopes) {
    if (!stateScopes.has(scope)) gaps.push({ side, kind: "state", scope, status: "missing-inventory-entry" });
  }
  for (const stream of summary.streams) {
    if (stream.groupsComplete !== true) gaps.push({ side, kind: "stream", stream: stream.id, status: "incomplete-group-inventory" });
    for (const group of stream.groups) {
      if (!summary.entries.some((entry) => entry.kind === "stream" && entry.stream === stream.id && entry.group === group)) {
        gaps.push({ side, kind: "stream", stream: stream.id, group, status: "missing-inventory-entry" });
      }
    }
  }
  if (new Set(summary.entries.map(entryIdentity)).size !== summary.entries.length) gaps.push({ side, kind: "inventory", status: "duplicate-entry-identity" });
  return gaps;
}

async function collectRows(summary, reader, predicate) {
  const rows = [];
  for (const entry of stateEntries(summary).filter((item) => predicate(item.scope))) rows.push(...await reader(entry));
  return rows;
}

export async function compareAuditRows(before, after, readBefore, readAfter) {
  const source = await collectRows(before, readBefore, auditDataScope);
  const restored = await collectRows(after, readAfter, auditDataScope);
  for (const row of [...source, ...restored]) {
    if (!row || typeof row !== "object" || typeof row.operation !== "string") throw new Error("Malformed audit record");
  }
  const indexBefore = source.filter((row) => row.operation === "index_persist");
  const indexAfter = restored.filter((row) => row.operation === "index_persist");
  const indexDelta = multisetDelta(valueMultiset(indexBefore), valueMultiset(indexAfter));
  const nonIndexBefore = source.filter((row) => row.operation !== "index_persist");
  const nonIndexAfter = restored.filter((row) => row.operation !== "index_persist");
  const beforeCounts = new Map(valueMultiset(nonIndexBefore).members.map((item) => [item.sha256, item.count]));
  const acceptedSummaries = [];
  const retainedAfter = [];
  for (const row of nonIndexAfter) {
    const hash = digest(canonicalJson(row));
    const previous = beforeCounts.get(hash) ?? 0;
    if (previous > 0) {
      beforeCounts.set(hash, previous - 1);
      retainedAfter.push(row);
      continue;
    }
    if (acceptedSummaries.length === 0 && indexDelta.removedValues > 0 && row.operation === "audit_migrate"
      && row.functionId === "mem::audit-migrate" && Array.isArray(row.targetIds) && row.targetIds.length === 0
      && row.details?.reason === "index_persist rows predate opt-in auditing"
      && row.details.purged === indexDelta.removedValues && row.details.migrated === nonIndexBefore.length) {
      acceptedSummaries.push(row);
    } else retainedAfter.push(row);
  }
  const protectedDelta = multisetDelta(valueMultiset(nonIndexBefore), valueMultiset(retainedAfter));
  return {
    complete: true, beforeCount: source.length, afterCount: restored.length,
    indexPersist: indexDelta, nonIndex: protectedDelta, migrationSummaryAdditions: acceptedSummaries.length,
    explained: protectedDelta.equal && indexDelta.addedValues === 0,
    source: "src/functions/audit.ts:392-405,446-465 at upstream d03e88f",
    limitation: "Duplicate non-index audit values remain protected even when upstream deduplicates by ID.",
  };
}

function normalizedVector(id, sessionId, base64) {
  if (typeof id !== "string" || typeof sessionId !== "string" || typeof base64 !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error("Malformed persisted vector");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length % 4 !== 0) throw new Error("Persisted vector is not a Float32 byte sequence");
  return { id, sessionId, dimension: bytes.length / 4, embeddingSha256: digest(bytes) };
}

export async function reconstructVectors(summary, reader) {
  const states = new Map(stateEntries(summary).map((entry) => [entry.scope, entry]));
  const rootValues = states.has(indexRoot) ? await reader(states.get(indexRoot)) : [];
  const metas = rootValues.filter((row) => row?.v === 3 && Number.isInteger(row.bucketCount) && row.bucketCount >= 0 && Number.isInteger(row.count));
  const manifests = rootValues.filter((row) => row?.v === 1 && Array.isArray(row.shards)
    && row.shards.length > 0 && row.shards.every((shard) => typeof shard.scope === "string" && shard.scope.startsWith(vectorShardPrefix)));
  const rows = [];
  let representation = "none";
  let expectedCount = null;
  if (metas.length > 1 || manifests.length > 1) throw new Error("Ambiguous vector metadata in values-only inventory");
  if (metas.length) {
    representation = "v3-buckets";
    expectedCount = metas[0].count;
    for (let bucket = 0; bucket < metas[0].bucketCount; bucket++) {
      const scope = `${vectorBucketPrefix}${String(bucket).padStart(4, "0")}`;
      const entry = states.get(scope);
      if (!entry) continue;
      for (const row of await reader(entry)) rows.push(normalizedVector(row?.id, row?.s, row?.e));
    }
    const extraBuckets = [...states.keys()].filter((scope) => scope.startsWith(vectorBucketPrefix)
      && !Array.from({ length: metas[0].bucketCount }, (_, bucket) => `${vectorBucketPrefix}${String(bucket).padStart(4, "0")}`).includes(scope));
    for (const scope of extraBuckets) {
      if ((await reader(states.get(scope))).length) throw new Error("Nonempty vector bucket is outside the metadata bucket count");
    }
  } else {
    let serialized = null;
    if (manifests.length) {
      representation = "legacy-shards";
      const chunks = [];
      for (const shard of manifests[0].shards) {
        if (shard.key !== "data" || !Number.isInteger(shard.chars)) throw new Error("Unknown legacy vector shard schema");
        const entry = states.get(shard.scope);
        if (!entry) throw new Error("Legacy vector shard is missing");
        const values = await reader(entry);
        if (values.length !== 1 || typeof values[0] !== "string" || values[0].length !== shard.chars) throw new Error("Legacy vector shard content or length is invalid");
        chunks.push(values[0]);
      }
      serialized = chunks.join("");
      if (serialized.length !== manifests[0].chars) throw new Error("Legacy vector manifest length is invalid");
    } else {
      const candidates = rootValues.filter((value) => {
        if (typeof value !== "string") return false;
        try { return Array.isArray(JSON.parse(value)); } catch { return false; }
      });
      if (candidates.length > 1) throw new Error("Ambiguous legacy vector snapshot");
      if (candidates.length) { representation = "legacy-single"; serialized = candidates[0]; }
      else if ([...states.keys()].some((scope) => scope.startsWith(vectorBucketPrefix) || scope.startsWith(vectorShardPrefix))) {
        throw new Error("Vector scopes exist without usable metadata");
      }
    }
    if (serialized !== null) {
      let parsed;
      try { parsed = JSON.parse(serialized); } catch { throw new Error("Legacy vector snapshot JSON is malformed"); }
      if (!Array.isArray(parsed)) throw new Error("Legacy vector snapshot is not an array");
      for (const row of parsed) {
        if (!Array.isArray(row) || row.length !== 2) throw new Error("Unknown legacy vector row schema");
        rows.push(normalizedVector(row[0], row[1]?.sessionId, row[1]?.embedding));
      }
    }
  }
  if (expectedCount !== null && expectedCount !== rows.length) throw new Error("Vector metadata count does not match readable bucket values");
  const uniqueIds = new Set(rows.map((row) => row.id));
  return {
    representation, rows, multiset: valueMultiset(rows), count: rows.length, expectedCount,
    uniqueIds: uniqueIds.size, duplicateIds: rows.length - uniqueIds.size,
    dimensions: [...new Set(rows.map((row) => row.dimension))].sort((left, right) => left - right),
  };
}

function viewerItemTime(item) {
  const id = item?.observation?.id;
  const segment = typeof id === "string" ? id.split("_").at(-2) : null;
  const generated = typeof segment === "string" && /^[0-9a-z]{6,10}$/.test(segment) ? parseInt(segment, 36) : NaN;
  if (generated >= Date.UTC(2020, 0, 1) && generated < Date.UTC(2100, 0, 1)) return generated;
  const raw = item?.observation?.timestamp;
  const parsed = typeof raw === "string" ? Date.parse(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function compareViewerRows(before, after, cap = 500) {
  const delta = multisetDelta(valueMultiset(before), valueMultiset(after));
  if (delta.equal) return { ...delta, cap, explained: true, pruned: 0 };
  const ids = before.map((row) => row?.observation?.id);
  if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length || before.length <= cap) {
    return { ...delta, cap, explained: false, pruned: delta.removedValues, reason: "Viewer records do not meet the stock pruning preconditions" };
  }
  const ordered = before.map((item, index) => ({ item, index, at: viewerItemTime(item) }))
    .sort((left, right) => left.at === right.at ? left.index - right.index : left.at < right.at ? -1 : 1);
  const cutoff = ordered.length - cap;
  const ambiguousBoundary = cutoff > 0 && ordered[cutoff - 1].at === ordered[cutoff].at;
  const retained = ordered.slice(cutoff).map((row) => row.item);
  const retainedDelta = multisetDelta(valueMultiset(retained), valueMultiset(after));
  return {
    ...delta, cap, explained: !ambiguousBoundary && retainedDelta.equal, pruned: delta.removedValues, ambiguousBoundary,
    source: "src/state/viewer-stream.ts:113-153 at upstream d03e88f",
    reason: ambiguousBoundary ? "Equal timestamps cross the pruning boundary; values-only order is insufficient" : "Compared the newest retained records against the stock cap",
  };
}

export function reviewStartupMetadata(before, after, proof) {
  const key = "session-index-generation";
  const graphKey = "graph-compact-on-boot:v1";
  const reflectKey = "reflect:recentClusters";
  if (proof?.schema !== 1 || proof.scope !== "mem:config" || proof.key !== key
    || proof.before?.[key] !== null || proof.after?.[key] !== 1
    || proof.before?.[graphKey] !== null || proof.after?.[graphKey] !== null) return null;
  const target = (summary) => summary.entries.find((entry) => entry.kind === "target"
    && entry.scope === "mem:config" && entry.key === reflectKey && entry.status === "ok");
  const leftTarget = target(before);
  const rightTarget = target(after);
  if (!leftTarget || !rightTarget || leftTarget.multiset.sha256 !== rightTarget.multiset.sha256
    || proof.before[reflectKey] !== leftTarget.multiset.sha256
    || proof.after[reflectKey] !== rightTarget.multiset.sha256) return null;
  const config = (summary) => summary.entries.find((entry) => entry.kind === "state"
    && entry.scope === "mem:config" && entry.status === "ok");
  const left = config(before);
  const right = config(after);
  if (!left || !right) return null;
  const delta = multisetDelta(left.multiset, right.multiset);
  const one = digest(canonicalJson(1));
  const multiplicity = (entry) => entry.multiset.members.find((member) => member.sha256 === one)?.count ?? 0;
  if (delta.removedValues !== 0 || delta.addedValues !== 1 || multiplicity(right) !== multiplicity(left) + 1) return null;
  return {
    scope: "mem:config", key, addedValues: 1, removedValues: 0,
    source: "src/state/session-index.ts:194-203 at upstream d03e88f",
    explanation: "The boot session-index generation marker is the sole added value. Targeted reads preserve reflect cooldowns and exclude graph compaction.",
    limitation: "The engine returns values without arbitrary keys. This review does not prove every key mapping.",
  };
}

export async function compareMigrationInventories(before, after, { readBefore, readAfter, viewerCap = 500, startupMetadataProof, allowAbsentEmptyScopes = false } = {}) {
  const beforeMap = new Map(before.entries.map((entry) => [entryIdentity(entry), entry]));
  const afterMap = new Map(after.entries.map((entry) => [entryIdentity(entry), entry]));
  const blockers = [];
  const coverageGaps = [...(before.coverageGaps ?? []).map((gap) => ({ side: "before", kind: gap.kind, scope: gap.scope, status: "gap" })),
    ...(after.coverageGaps ?? []).map((gap) => ({ side: "after", kind: gap.kind, scope: gap.scope, status: "gap" })),
    ...structuralCoverageGaps(before, "before"), ...structuralCoverageGaps(after, "after")];
  if (before.complete !== true || after.complete !== true || coverageGaps.length) blockers.push({ kind: "incomplete-native-coverage" });
  const changes = [];
  const rawSourceChanges = [];
  const totals = { before: 0, after: 0, unchangedEntries: 0 };
  const valuesByKind = {
    before: { state: 0, stream: 0, target: 0 },
    after: { state: 0, stream: 0, target: 0 },
  };
  for (const identity of [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort()) {
    const left = beforeMap.get(identity);
    const right = afterMap.get(identity);
    const entry = left ?? right;
    const role = scopeRole(entry);
    totals.before += left?.multiset?.count ?? 0;
    totals.after += right?.multiset?.count ?? 0;
    if (left && Object.hasOwn(valuesByKind.before, left.kind)) valuesByKind.before[left.kind] += left.multiset?.count ?? 0;
    if (right && Object.hasOwn(valuesByKind.after, right.kind)) valuesByKind.after[right.kind] += right.multiset?.count ?? 0;
    if ((left && left.status !== "ok") || (right && right.status !== "ok")) {
      changes.push({ kind: entry.kind, scope: entry.scope, key: entry.key, stream: entry.stream, group: entry.group, role, presence: left && right ? "modified" : left ? "missing" : "unexpected", status: "coverage-gap" });
      blockers.push({ kind: "failed-entry-read", identity });
      continue;
    }
    const delta = multisetDelta(left?.multiset ?? emptyMultiset, right?.multiset ?? emptyMultiset);
    if (left && right && delta.equal) { totals.unchangedEntries++; continue; }
    const change = {
      kind: entry.kind, scope: entry.scope, key: entry.key, stream: entry.stream, group: entry.group, role,
      presence: left && right ? "modified" : left ? "missing" : "unexpected", ...delta,
      classification: role === "runtime-metadata" ? "explained-runtime-metadata" : "requires-review",
    };
    changes.push(change);
    if (role === "observations" && readBefore && readAfter) {
      try {
        const projection = (rows) => rows.map((row) => ({ id: row?.id ?? null, hasSource: Object.hasOwn(row ?? {}, "source"), source: row?.source ?? null }));
        rawSourceChanges.push({ scope: entry.scope, ...multisetDelta(valueMultiset(projection(left ? await readBefore(left) : [])), valueMultiset(projection(right ? await readAfter(right) : []))) });
      } catch { rawSourceChanges.push({ scope: entry.scope, complete: false }); }
    }
    if (role === "runtime-metadata" && delta.afterCount < delta.beforeCount) {
      change.classification = "runtime-record-count-loss";
      blockers.push({ kind: "runtime-record-count-loss", identity, beforeCount: delta.beforeCount, afterCount: delta.afterCount });
    }
    if (["observations", "protected-state", "protected-stream", "protected-target"].includes(role)) blockers.push({ kind: "protected-record-change", identity, removedValues: delta.removedValues, addedValues: delta.addedValues });
  }
  const scopeCoverage = {
    beforeScopes: before.stateScopes.length, afterScopes: after.stateScopes.length,
    missing: before.stateScopes.filter((scope) => !after.stateScopes.includes(scope)).sort(),
    unexpected: after.stateScopes.filter((scope) => !before.stateScopes.includes(scope)).sort(),
    beforeStreams: before.streams.length, afterStreams: after.streams.length,
  };
  let audit = { complete: false, explained: false };
  let vectors = { complete: false, equal: false };
  const viewer = [];
  if (readBefore && readAfter) {
    try { audit = await compareAuditRows(before, after, readBefore, readAfter); }
    catch (error) { audit = { complete: false, explained: false, reason: error.message }; }
    try {
      const [oldVectors, newVectors] = await Promise.all([reconstructVectors(before, readBefore), reconstructVectors(after, readAfter)]);
      const delta = multisetDelta(oldVectors.multiset, newVectors.multiset);
      vectors = {
        complete: true, ...delta, beforeRepresentation: oldVectors.representation, afterRepresentation: newVectors.representation,
        beforeUniqueIds: oldVectors.uniqueIds, afterUniqueIds: newVectors.uniqueIds,
        beforeDuplicateIds: oldVectors.duplicateIds, afterDuplicateIds: newVectors.duplicateIds,
        beforeDimensions: oldVectors.dimensions, afterDimensions: newVectors.dimensions,
        source: "src/state/index-persistence.ts:609-695 and src/state/vector-index.ts:174-190 at upstream d03e88f",
        limitation: "Logical ID, session, dimension and Float32-byte digests are compared; arbitrary engine key mapping remains unproven.",
      };
    } catch (error) { vectors = { complete: false, equal: false, reason: error.message }; }
    for (const change of changes.filter((item) => item.role === "viewer-stream")) {
      const identity = entryIdentity(change);
      try {
        const left = beforeMap.get(identity);
        const right = afterMap.get(identity);
        const result = compareViewerRows(left ? await readBefore(left) : [], right ? await readAfter(right) : [], viewerCap);
        viewer.push({ stream: change.stream, group: change.group, ...result });
        change.classification = result.explained ? "explained-viewer-pruning" : "unexplained-viewer-change";
        if (!result.explained) blockers.push({ kind: "unexplained-viewer-change", identity });
      } catch { viewer.push({ stream: change.stream, group: change.group, complete: false, explained: false }); blockers.push({ kind: "viewer-coverage-gap", identity }); }
    }
  }
  if (!audit.complete || !audit.explained) blockers.push({ kind: "audit-preservation-failed" });
  if (!vectors.complete || !vectors.equal) blockers.push({ kind: "vector-preservation-failed" });
  for (const change of changes) {
    if (change.role === "audit-records" || change.role === "audit-metadata") change.classification = audit.complete && audit.explained ? "explained-audit-migration" : "unexplained-audit-change";
    if (change.role === "index-representation") change.classification = vectors.complete && vectors.equal ? "explained-index-representation" : "index-change-requires-proof";
  }
  const rawBlockers = [...blockers];
  const reviewedExceptions = [];
  if (allowAbsentEmptyScopes) {
    for (const change of changes) {
      if (change.kind !== "state" || change.presence !== "missing" || change.beforeCount !== 0 || change.afterCount !== 0
        || change.removedValues !== 0 || change.addedValues !== 0) continue;
      const identity = entryIdentity(change);
      const entry = beforeMap.get(identity);
      if (entry?.status !== "ok" || entry.multiset.count !== 0) continue;
      const index = blockers.findIndex((blocker) => blocker.kind === "protected-record-change" && blocker.identity === identity);
      if (index < 0) continue;
      blockers.splice(index, 1);
      change.classification = "reviewed-absent-empty-scope";
      reviewedExceptions.push({ scope: change.scope, addedValues: 0, removedValues: 0,
        explanation: "The complete source read returned an empty list. The engine does not persist an empty scope file.",
        source: "The final cold-file comparison and native empty-scope persistence evidence",
        limitation: "The RAM scope name disappeared; no record was removed." });
    }
  }
  const startupReview = reviewStartupMetadata(before, after, startupMetadataProof);
  if (startupReview) {
    const identity = JSON.stringify(["state", "mem:config", null, null, null]);
    const index = blockers.findIndex((blocker) => blocker.kind === "protected-record-change" && blocker.identity === identity);
    if (index >= 0) {
      blockers.splice(index, 1);
      reviewedExceptions.push(startupReview);
      changes.find((change) => change.kind === "state" && change.scope === "mem:config").classification = "reviewed-session-index-generation";
    }
  }
  return {
    schema: 1, comparedAt: new Date().toISOString(), acceptance: blockers.length ? "BLOCKED" : "READY", totals, valuesByKind, scopeCoverage,
    beforeComplete: before.complete === true, afterComplete: after.complete === true, coverageGaps,
    changedEntries: changes.length, changes, rawSourceChanges, audit, vectors, viewer, effectiveViewerCap: viewerCap,
    rawBlockers, reviewedExceptions, blockers, allowAbsentEmptyScopes,
    limits: [
      "Whole-value multisets protect duplicate multiplicity and raw payload text.",
      "Counts sum inventory values, including stream copies and targeted reads; they do not count distinct memories.",
      "Values-only APIs cannot prove arbitrary key mapping.",
      "Index representation changes require logical vector preservation and functional rebuild evidence supplied separately.",
      "All session, capture, slot, cooldown and unclassified state changes remain blockers. An explicit native proof can review only the sole session-index generation addition.",
      "Viewer pruning is reported as removal even when the stock cap explains it.",
      "A READY comparison does not authorize production cutover or prove preservation of unfinished requests.",
    ],
  };
}

export function migrationMarkdown(report) {
  const lines = [
    `# Migration comparison: ${report.acceptance}`, "",
    `Compared ${report.totals.before} source values with ${report.totals.after} destination values.`,
    `${report.totals.unchangedEntries} entries are unchanged. ${report.changedEntries} entries changed.`,
    `${report.coverageGaps.length} native coverage gaps and ${report.blockers.length} blockers remain.`, "",
    "| Kind | Scope or stream group | Change | Policy | Before | After | Removed | Added |", "| --- | --- | --- | --- | ---: | ---: | ---: | ---: |",
  ];
  const escape = (value) => String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
  for (const change of report.changes) lines.push(`| ${escape(change.kind)} | ${escape(change.scope ?? `${change.stream}/${change.group}`)}${change.key ? `/${escape(change.key)}` : ""} | ${change.presence} | ${change.classification ?? change.status} | ${change.beforeCount ?? "?"} | ${change.afterCount ?? "?"} | ${change.removedValues ?? "?"} | ${change.addedValues ?? "?"} |`);
  lines.push("", `Audit: complete=${report.audit.complete}; explained=${report.audit.explained}; non-index removals=${report.audit.nonIndex?.removedValues ?? "unknown"}.`,
    `Vectors: complete=${report.vectors.complete}; equal=${report.vectors.equal}; before=${report.vectors.beforeCount ?? "unknown"}; after=${report.vectors.afterCount ?? "unknown"}.`, "", "## Proof limits", "");
  for (const limit of report.limits) lines.push(`- ${limit}`);
  if (report.blockers.length) {
    lines.push("", "## Blockers", "");
    for (const blocker of report.blockers) lines.push(`- ${escape(blocker.kind)}${blocker.identity ? `: ${escape(blocker.identity)}` : ""}`);
  }
  if (report.reviewedExceptions.length) {
    lines.push("", "## Reviewed additions", "");
    for (const review of report.reviewedExceptions) lines.push(`- ${escape(review.scope)}${review.key === undefined ? "" : `/${escape(review.key)}`}: ${escape(review.explanation)} Source: ${escape(review.source)}. The original blocker remains in rawBlockers.`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(args) {
  const options = new Map();
  const beforeRoots = [];
  const afterRoots = [];
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--allow-absent-empty-scopes") { options.set(option, true); continue; }
    if (!["--before", "--after", "--out", "--markdown", "--before-values", "--after-values", "--viewer-cap", "--startup-metadata-proof"].includes(option) || !args[index + 1]) {
      throw new Error("Usage: migration-report.mjs --before SUMMARY --after SUMMARY --out JSON [--markdown MD] [--before-values DIR] [--after-values DIR] [--viewer-cap 500] [--startup-metadata-proof JSON] [--allow-absent-empty-scopes]");
    }
    const value = args[++index];
    if (option === "--before-values") beforeRoots.push(value);
    else if (option === "--after-values") afterRoots.push(value);
    else options.set(option, value);
  }
  for (const key of ["--before", "--after", "--out"]) if (!options.has(key)) throw new Error(`Missing ${key}`);
  const viewerCap = Number(options.get("--viewer-cap") ?? 500);
  if (!Number.isSafeInteger(viewerCap) || viewerCap < 1) throw new Error("Invalid viewer cap");
  const [before, after] = await Promise.all([readJson(options.get("--before")), readJson(options.get("--after"))]);
  const report = await compareMigrationInventories(before, after, {
    readBefore: createInventoryReader(before, options.get("--before"), beforeRoots),
    readAfter: createInventoryReader(after, options.get("--after"), afterRoots), viewerCap,
    startupMetadataProof: options.has("--startup-metadata-proof") ? await readJson(options.get("--startup-metadata-proof")) : undefined,
    allowAbsentEmptyScopes: options.has("--allow-absent-empty-scopes"),
  });
  await writePrivateJson(options.get("--out"), report);
  if (options.has("--markdown")) {
    await mkdir(dirname(resolve(options.get("--markdown"))), { recursive: true, mode: 0o700 });
    await writeFile(options.get("--markdown"), migrationMarkdown(report), { mode: 0o600, flag: "wx" });
  }
  console.log(JSON.stringify({ acceptance: report.acceptance, beforeValues: report.totals.before, afterValues: report.totals.after, changedEntries: report.changedEntries, blockers: report.blockers.length, coverageGaps: report.coverageGaps.length, auditExplained: report.audit.explained, vectorsEqual: report.vectors.equal }));
  if (report.acceptance !== "READY") process.exitCode = 1;
}

if (await isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 2; });
}
