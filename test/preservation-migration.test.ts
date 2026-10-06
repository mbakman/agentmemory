import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { valueMultiset } from "../scripts/preservation/values.mjs";
import {
  compareMigrationInventories, compareViewerRows, createInventoryReader, migrationMarkdown, reconstructVectors, reviewStartupMetadata,
} from "../scripts/preservation/migration-report.mjs";

type Entry = { kind: string; scope?: string; stream?: string; group?: string; status: string; valuesFile: string; multiset: ReturnType<typeof valueMultiset> };
function fixture(scopes: Record<string, unknown[]>, streams: Record<string, unknown[]> = {}) {
  const rows = new Map<string, unknown[]>();
  const entries: Entry[] = Object.entries(scopes).map(([scope, values], index) => {
    const valuesFile = `state-${index}.json`;
    rows.set(valuesFile, values);
    return { kind: "state", scope, status: "ok", valuesFile, multiset: valueMultiset(values) };
  });
  for (const [group, values] of Object.entries(streams)) {
    const valuesFile = `stream-${group}.json`;
    rows.set(valuesFile, values);
    entries.push({ kind: "stream", stream: "mem-live", group, status: "ok", valuesFile, multiset: valueMultiset(values) });
  }
  return {
    summary: { complete: true, stateScopes: Object.keys(scopes), streams: Object.keys(streams).length ? [{ id: "mem-live", groups: Object.keys(streams), groupsComplete: true }] : [], coverageGaps: [], entries },
    read: async (entry: Entry) => rows.get(entry.valuesFile)!,
  };
}
async function compare(before: ReturnType<typeof fixture>, after: ReturnType<typeof fixture>) {
  return compareMigrationInventories(before.summary, after.summary, { readBefore: before.read, readAfter: after.read });
}
function audit(id: string, operation: string) {
  return { id, operation, timestamp: "2026-10-06T00:00:00Z", functionId: "mem::save", targetIds: ["mem_saved"], details: {} };
}
function vectorBytes(value = 1) {
  const floats = new Float32Array([value, 2]);
  return Buffer.from(floats.buffer).toString("base64");
}

describe("migration report preservation policy", () => {
  it("accepts exact duplicate-preserving records and detects raw observation payload truncation", async () => {
    const original = { id: "obs_one", source: { toolOutput: "complete private payload" }, title: "record" };
    const before = fixture({ "mem:obs:session": [original, original], "mem:slots": [{ content: "slot" }], "mem:config": [{ cooldown: "kept" }] });
    expect((await compare(before, before)).acceptance).toBe("READY");
    const after = fixture({ "mem:obs:session": [{ ...original, source: { toolOutput: "complete" } }, original], "mem:slots": [{ content: "slot" }], "mem:config": [{ cooldown: "kept" }] });
    const report = await compare(before, after);
    expect(report.acceptance).toBe("BLOCKED");
    expect(report.changes.find((entry: { scope: string }) => entry.scope === "mem:obs:session")).toMatchObject({ beforeCount: 2, afterCount: 2, removedValues: 1, addedValues: 1 });
    expect(report.rawSourceChanges).toEqual([expect.objectContaining({ scope: "mem:obs:session", equal: false, removedValues: 1, addedValues: 1 })]);
    expect(migrationMarkdown(report)).not.toContain("complete private payload");
  });

  it("never waives session sweeps, capture writes, slots, cooldown changes or non-viewer stream removals", async () => {
    const before = fixture({ "mem:sessions": [{ id: "sess", status: "active" }], "mem:slots": [{ content: "kept" }], "mem:config": [{ reflect: "old" }] }, { session: [{ source: "kept" }] });
    const after = fixture({ "mem:sessions": [{ id: "sess", status: "abandoned" }], "mem:slots": [], "mem:config": [{ reflect: "new" }], "mem:capture:inbox": [{ seen: true }] });
    const report = await compare(before, after);
    expect(report.acceptance).toBe("BLOCKED");
    expect(report.blockers.filter((item: { kind: string }) => item.kind === "protected-record-change")).toHaveLength(5);
  });

  it("accepts only named runtime metadata changes without exposing raw values", async () => {
    const before = fixture({ "mem:health": [{ status: "old" }], "mem:metrics": [{ count: 1 }], "mem:access": [{ accessedAt: "old" }] });
    const after = fixture({ "mem:health": [{ status: "new" }], "mem:metrics": [{ count: 2 }], "mem:access": [{ accessedAt: "new" }] });
    const report = await compare(before, after);
    expect(report.acceptance).toBe("READY");
    expect(report.changes.every((entry: { classification: string }) => entry.classification === "explained-runtime-metadata")).toBe(true);
    expect(JSON.stringify(report)).not.toContain('"accessedAt"');
  });

  it("blocks disappearance of runtime records even when remaining records change", async () => {
    const report = await compare(fixture({ "mem:access": [{ accessedAt: "old1" }, { accessedAt: "old2" }] }), fixture({ "mem:access": [{ accessedAt: "new" }] }));
    expect(report.acceptance).toBe("BLOCKED");
    expect(report.blockers).toContainEqual(expect.objectContaining({ kind: "runtime-record-count-loss", beforeCount: 2, afterCount: 1 }));
  });

  it("requires an explicit review for missing empty scopes and never waives inbox records", async () => {
    const before = fixture({ "mem:capture:inbox": [] });
    const after = fixture({});
    expect((await compare(before, after)).acceptance).toBe("BLOCKED");
    const reviewed = await compareMigrationInventories(before.summary, after.summary, { readBefore: before.read, readAfter: after.read, allowAbsentEmptyScopes: true });
    expect(reviewed.acceptance).toBe("READY");
    expect(reviewed.rawBlockers).toHaveLength(1);
    expect(reviewed.reviewedExceptions).toContainEqual(expect.objectContaining({ scope: "mem:capture:inbox", removedValues: 0 }));
    const pending = fixture({ "mem:capture:inbox": [{ eventId: "pending", state: "waiting" }] });
    const blocked = await compareMigrationInventories(pending.summary, after.summary, { readBefore: pending.read, readAfter: after.read, allowAbsentEmptyScopes: true });
    expect(blocked.acceptance).toBe("BLOCKED");
    expect(blocked.reviewedExceptions).toHaveLength(0);
  });

  it("reviews only one proved generation addition and retains its raw blocker", async () => {
    const cooldown = { cluster: "retained" };
    const before = fixture({ "mem:config": [cooldown] });
    const after = fixture({ "mem:config": [cooldown, 1] });
    const reflectDigest = valueMultiset([cooldown]).sha256;
    for (const item of [before, after]) item.summary.entries.push({ kind: "target", scope: "mem:config", key: "reflect:recentClusters", status: "ok", valuesFile: "target.json", multiset: valueMultiset([cooldown]) } as Entry);
    const proof = {
      schema: 1, scope: "mem:config", key: "session-index-generation",
      before: { "session-index-generation": null, "graph-compact-on-boot:v1": null, "reflect:recentClusters": reflectDigest },
      after: { "session-index-generation": 1, "graph-compact-on-boot:v1": null, "reflect:recentClusters": reflectDigest },
    };
    const report = await compareMigrationInventories(before.summary, after.summary, { readBefore: before.read, readAfter: after.read, startupMetadataProof: proof });
    expect(report.acceptance).toBe("READY");
    expect(report.rawBlockers).toContainEqual(expect.objectContaining({ kind: "protected-record-change" }));
    expect(report.reviewedExceptions).toHaveLength(1);
    expect(reviewStartupMetadata(before.summary, after.summary, { ...proof, after: { ...proof.after, "graph-compact-on-boot:v1": 1 } })).toBeNull();
    after.summary.entries[0].multiset = valueMultiset([cooldown, 1, "unrelated"]);
    expect(reviewStartupMetadata(before.summary, after.summary, proof)).toBeNull();
    after.summary.entries[0].multiset = valueMultiset([{ cluster: "changed" }, 1]);
    expect(reviewStartupMetadata(before.summary, after.summary, proof)).toBeNull();
  });

  it("compares audit records across month scopes and permits only index_persist removal plus its verified summary", async () => {
    const kept = audit("audit_kept", "save");
    const indexRows = [audit("audit_index1", "index_persist"), audit("audit_index2", "index_persist")];
    const migration = { id: "audit_new", operation: "audit_migrate", functionId: "mem::audit-migrate", targetIds: [], details: { reason: "index_persist rows predate opt-in auditing", purged: 2, migrated: 1 } };
    const before = fixture({ "mem:audit": [...indexRows, kept] });
    const after = fixture({ "mem:audit:2026-10": [kept, migration], "mem:audit:months": [{ months: ["2026-10"] }] });
    const report = await compare(before, after);
    expect(report.acceptance).toBe("READY");
    expect(report.audit).toMatchObject({ explained: true, indexPersist: { removedValues: 2, addedValues: 0 }, nonIndex: { removedValues: 0, addedValues: 0 }, migrationSummaryAdditions: 1 });
    expect(report.changes.every((change: { classification: string }) => change.classification === "explained-audit-migration")).toBe(true);
    const lost = await compare(before, fixture({ "mem:audit:2026-10": [migration] }));
    expect(lost.acceptance).toBe("BLOCKED");
    expect(lost.audit.nonIndex.removedValues).toBe(1);
  });

  it("flags non-index audit duplicate loss and unexpected index audit additions", async () => {
    const kept = audit("same", "save");
    const duplicateLoss = await compare(fixture({ "mem:audit": [kept, kept] }), fixture({ "mem:audit:2026-10": [kept] }));
    expect(duplicateLoss.audit.nonIndex.removedValues).toBe(1);
    expect(duplicateLoss.acceptance).toBe("BLOCKED");
    const addition = await compare(fixture({ "mem:audit": [] }), fixture({ "mem:audit": [audit("new", "index_persist")] }));
    expect(addition.audit.indexPersist.addedValues).toBe(1);
    expect(addition.acceptance).toBe("BLOCKED");
  });

  it("proves legacy vector shard to bucket migration using IDs, sessions and decoded Float32-byte digests", async () => {
    const vectorRows = [["obs_one", { sessionId: "sess", embedding: vectorBytes() }], ["mem_two", { sessionId: "memories", embedding: vectorBytes(3) }]];
    const serialized = JSON.stringify(vectorRows);
    const split = Math.floor(serialized.length / 2);
    const shards = [{ scope: "mem:index:bm25:vectors:g:00000", key: "data", chars: split }, { scope: "mem:index:bm25:vectors:g:00001", key: "data", chars: serialized.length - split }];
    const before = fixture({ "mem:index:bm25": [{ v: 1, shards, chars: serialized.length }], [shards[0].scope]: [serialized.slice(0, split)], [shards[1].scope]: [serialized.slice(split)] });
    const after = fixture({ "mem:index:bm25": [{ v: 3, bucketCount: 1, count: 2, savedAt: "new" }], "mem:index:bm25:vec:0000": [{ id: "mem_two", s: "memories", e: vectorBytes(3) }, { id: "obs_one", s: "sess", e: vectorBytes() }] });
    const report = await compare(before, after);
    expect(report.acceptance).toBe("READY");
    expect(report.vectors).toMatchObject({ complete: true, equal: true, beforeCount: 2, afterCount: 2, beforeRepresentation: "legacy-shards", afterRepresentation: "v3-buckets", beforeDimensions: [2], afterDimensions: [2] });
    expect(report.changes.every((change: { classification: string }) => change.classification === "explained-index-representation")).toBe(true);
  });

  it("flags vector byte changes, missing vectors and invalid bucket metadata counts", async () => {
    const before = fixture({ "mem:index:bm25": [JSON.stringify([["obs_one", { sessionId: "sess", embedding: vectorBytes() }]])] });
    const changed = fixture({ "mem:index:bm25": [{ v: 3, bucketCount: 1, count: 1 }], "mem:index:bm25:vec:0000": [{ id: "obs_one", s: "sess", e: vectorBytes(7) }] });
    expect((await compare(before, changed)).vectors).toMatchObject({ equal: false, removedValues: 1, addedValues: 1 });
    expect((await compare(before, fixture({}))).acceptance).toBe("BLOCKED");
    const invalid = fixture({ "mem:index:bm25": [{ v: 3, bucketCount: 1, count: 0 }], "mem:index:bm25:vec:0000": [{ id: "obs_one", s: "sess", e: vectorBytes() }] });
    await expect(reconstructVectors(invalid.summary, invalid.read)).rejects.toThrow("metadata count");
  });

  it("reports the exact viewer removals explained by cap500 and flags excess or ambiguous pruning", async () => {
    const rows = Array.from({ length: 503 }, (_, index) => ({ observation: { id: `plain-${index}`, timestamp: 1_000_000 + index, source: "private" } }));
    const report = await compare(fixture({}, { viewer: rows }), fixture({}, { viewer: rows.slice(3) }));
    expect(report.acceptance).toBe("READY");
    expect(report.viewer).toEqual([expect.objectContaining({ explained: true, pruned: 3, beforeCount: 503, afterCount: 500 })]);
    expect(compareViewerRows(rows, rows.slice(4)).explained).toBe(false);
    const tied = rows.map((row) => ({ observation: { ...row.observation, timestamp: 1 } }));
    expect(compareViewerRows(tied, tied.slice(3))).toMatchObject({ explained: false, ambiguousBoundary: true });
  });

  it("keeps failed native reads and incomplete inventories as blockers", async () => {
    const before = fixture({ "mem:memories": [{ id: "kept" }] });
    const after = fixture({ "mem:memories": [{ id: "kept" }] });
    after.summary.complete = false;
    after.summary.entries[0].status = "gap";
    const report = await compare(before, after);
    expect(report.acceptance).toBe("BLOCKED");
    expect(report.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "incomplete-native-coverage" }), expect.objectContaining({ kind: "failed-entry-read" })]));
  });

  it("does not accept a declared complete inventory that omits a listed scope", async () => {
    const before = fixture({ "mem:memories": [] });
    const after = fixture({ "mem:memories": [] });
    after.summary.entries = [];
    const report = await compare(before, after);
    expect(report.acceptance).toBe("BLOCKED");
    expect(report.coverageGaps).toContainEqual({ side: "after", kind: "state", scope: "mem:memories", status: "missing-inventory-entry" });
  });

  it("finds composed private values and rejects a values file whose digest changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-migration-test-"));
    const base = join(root, "base");
    const supplement = join(root, "supplement");
    await mkdir(base);
    await mkdir(supplement);
    const values = [{ id: "known", content: "full payload" }];
    const entry = { kind: "state", scope: "mem:insights", status: "ok", valuesFile: "scope.json", multiset: valueMultiset(values) };
    await writeFile(join(supplement, "scope.json"), JSON.stringify(values));
    const reader = createInventoryReader({ composition: { base, supplement, replacedScopes: ["mem:insights"] } }, join(root, "summary.json"));
    expect(await reader(entry)).toEqual(values);
    await writeFile(join(supplement, "scope.json"), JSON.stringify([{ id: "known", content: "full" }]));
    await expect(reader(entry)).rejects.toThrow("do not match");
  });
});
