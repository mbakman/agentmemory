import { describe, expect, it } from "vitest";
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManifest, compareManifests, writePrivateJson } from "../scripts/preservation/manifest.mjs";
import { canonicalJson, compareValueMultisets, valueMultiset } from "../scripts/preservation/values.mjs";
import { boundedRead, collectInventory, parseStateGroups, parseStreams } from "../scripts/preservation/inventory.mjs";
import { compareInventories } from "../scripts/preservation/compare-inventory.mjs";

async function scratch() {
  return mkdtemp(join(tmpdir(), "agentmemory-preservation-test-"));
}

describe("physical preservation manifest", () => {
  it("includes hidden files, stale temporary files, symlinks and hardlink identity without following symlinks", async () => {
    const root = await scratch();
    await mkdir(join(root, "store"));
    await writeFile(join(root, ".env"), "private-placeholder", { mode: 0o600 });
    await writeFile(join(root, "store", "scope.bin.tmp"), "forensic");
    await link(join(root, ".env"), join(root, "second-name"));
    await symlink("/does-not-exist", join(root, "external"));
    const manifest = await createManifest(root);
    expect(manifest.entries.map((entry: { path: string }) => entry.path)).toEqual([".", ".env", "external", "second-name", "store", "store/scope.bin.tmp"]);
    const secret = manifest.entries.find((entry: { path: string }) => entry.path === ".env");
    const alias = manifest.entries.find((entry: { path: string }) => entry.path === "second-name");
    expect(secret.mode).toBe(0o600);
    expect(secret.sha256).toHaveLength(64);
    expect(secret.ino).toBe(alias.ino);
    expect(manifest.entries.find((entry: { path: string }) => entry.path === "external").target).toBe("/does-not-exist");
  });

  it("detects changed bytes of identical size and missing or extra file coverage", async () => {
    const before = await scratch();
    const after = await scratch();
    await writeFile(join(before, "record"), "abc", { mode: 0o600 });
    await copyFile(join(before, "record"), join(after, "record"));
    const baseline = await createManifest(before);
    expect(compareManifests(baseline, await createManifest(after)).equal).toBe(true);
    await writeFile(join(after, "record"), "xyz");
    await writeFile(join(after, "extra"), "new");
    const changed = compareManifests(baseline, await createManifest(after));
    expect(changed.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "record", reason: "sha256" }),
      expect.objectContaining({ path: "extra", reason: "unexpected" }),
    ]));
    const missing = compareManifests(baseline, { ...baseline, entries: baseline.entries.filter((entry: { path: string }) => entry.path !== "record") });
    expect(missing.errors).toContainEqual({ path: "record", reason: "missing" });
  });

  it("checks permissions and copied hardlink relationships separately from inode identities", async () => {
    const before = await scratch();
    const after = await scratch();
    await writeFile(join(before, "record"), "abc", { mode: 0o600 });
    await link(join(before, "record"), join(before, "alias"));
    await copyFile(join(before, "record"), join(after, "record"));
    await copyFile(join(before, "alias"), join(after, "alias"));
    const baseline = await createManifest(before);
    const copied = await createManifest(after);
    expect(compareManifests(baseline, copied).errors).toContainEqual({ path: ".", reason: "hardlink-relationships" });
    expect(compareManifests(baseline, copied, { hardlinks: false }).equal).toBe(true);
    await chmod(join(after, "record"), 0o644);
    expect(compareManifests(baseline, await createManifest(after), { hardlinks: false }).errors).toContainEqual(expect.objectContaining({ path: "record", reason: "mode" }));
  });

  it("excludes only explicit descendants and rejects traversal exclusions", async () => {
    const root = await scratch();
    await mkdir(join(root, "cache"));
    await writeFile(join(root, "cache", "entry"), "cache");
    await writeFile(join(root, "cache-other"), "keep");
    const manifest = await createManifest(root, { exclude: ["cache"] });
    expect(manifest.entries.map((entry: { path: string }) => entry.path)).toEqual([".", "cache-other"]);
    await expect(createManifest(root, { exclude: ["../escape"] })).rejects.toThrow("below");
  });

  it("records an owner-only restore-root exception without relaxing descendant or content checks", async () => {
    const root = await scratch();
    await writeFile(join(root, "record"), "abc", { mode: 0o600 });
    const baseline = await createManifest(root);
    const changed = {
      ...baseline,
      entries: baseline.entries.map((entry: { path: string; mode: number; uid: number; gid: number; mtimeNs: string }) => entry.path === "."
        ? { ...entry, mode: 0o755, uid: entry.uid + 1, gid: entry.gid + 1, mtimeNs: "0" }
        : { ...entry }),
    };
    expect(compareManifests(baseline, changed, { metadata: true }).equal).toBe(false);
    const excepted = compareManifests(baseline, changed, { metadata: true, ignoreRootMetadata: true });
    expect(excepted.equal).toBe(true);
    expect(excepted.metadataExceptions).toEqual([{ path: ".", type: "directory", fields: ["mode", "uid", "gid", "mtimeNs"], reason: "Independent restore uses an owner-only root directory" }]);
    changed.entries.find((entry: { path: string }) => entry.path === "record").mode = 0o644;
    changed.entries.find((entry: { path: string }) => entry.path === "record").sha256 = "different";
    changed.entries.find((entry: { path: string }) => entry.path === ".").type = "file";
    const invalid = compareManifests(baseline, changed, { metadata: true, ignoreRootMetadata: true });
    expect(invalid.metadataExceptions).toEqual([]);
    expect(invalid.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "record", reason: "mode" }),
      expect.objectContaining({ path: "record", reason: "sha256" }),
      expect.objectContaining({ path: ".", reason: "type" }),
    ]));
  });

  it("creates owner-only output and refuses to replace existing evidence", async () => {
    const root = await scratch();
    const out = join(root, "private", "evidence.json");
    await writePrivateJson(out, { preserved: true });
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "private"))).mode & 0o777).toBe(0o700);
    await expect(writePrivateJson(out, { preserved: false })).rejects.toThrow("EEXIST");
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual({ preserved: true });
  });
});

describe("native value preservation", () => {
  it("normalizes object order but retains duplicate values and array order", () => {
    expect(canonicalJson({ b: 2, a: [1, 2] })).toBe(canonicalJson({ a: [1, 2], b: 2 }));
    const first = valueMultiset([{ b: 2, a: 1 }, { a: 1, b: 2 }, { other: true }]);
    const reordered = valueMultiset([{ other: true }, { a: 1, b: 2 }, { b: 2, a: 1 }]);
    expect(compareValueMultisets(first, reordered).equal).toBe(true);
    expect(first.count).toBe(3);
    expect(first.uniqueValues).toBe(2);
    expect(compareValueMultisets(first, valueMultiset([{ a: 1, b: 2 }, { other: true }])).equal).toBe(false);
    expect(valueMultiset([[1, 2]]).sha256).not.toBe(valueMultiset([[2, 1]]).sha256);
  });

  it("detects payload truncation even when IDs remain unchanged", () => {
    const original = valueMultiset([{ id: "obs_known", source: { toolOutput: "complete payload" } }]);
    const truncated = valueMultiset([{ id: "obs_known", source: { toolOutput: "complete" } }]);
    expect(compareValueMultisets(original, truncated)).toMatchObject({ equal: false, beforeCount: 1, afterCount: 1 });
  });

  it("rejects malformed native inventories rather than converting them to empty lists", () => {
    expect(() => parseStateGroups({ groups: [] })).not.toThrow();
    expect(() => parseStateGroups({ results: [] })).toThrow();
    expect(() => parseStateGroups({ groups: ["mem:sessions", "mem:sessions"] })).toThrow("Duplicate");
    expect(() => parseStreams({ stream: [], count: 0 })).not.toThrow();
    expect(() => parseStreams({ stream: [], count: 1 })).toThrow();
  });

  it("reports failed, oversized and timed-out reads as failures", async () => {
    await expect(boundedRead({ trigger: async () => { throw new Error("Invocation stopped"); } }, "state::list", {}, 20, 100)).rejects.toThrow("Invocation stopped");
    await expect(boundedRead({ trigger: async () => ["large"] }, "state::list", {}, 20, 2)).rejects.toThrow("coverage limit");
    await expect(boundedRead({ trigger: async () => new Promise(() => {}) }, "state::list", {}, 5, 100)).rejects.toThrow("timeout");
  });

  it("collects complete native values, true colon-bearing stream groups and cooldown targets without mutations", async () => {
    const root = await scratch();
    const calls: string[] = [];
    const sdk = {
      trigger: async ({ function_id: functionId, payload }: { function_id: string; payload: Record<string, string> }) => {
        calls.push(functionId);
        if (functionId === "engine::workers::list") return [{ active_invocations: 0 }];
        if (functionId === "engine::queue::list_topics" || functionId === "engine::queue::dlq_topics") return [];
        if (functionId === "state::list_groups") return { groups: ["mem:config", "mem:memories"] };
        if (functionId === "state::list") return payload.scope === "mem:memories" ? [{ id: "one" }, { id: "one" }] : [{ reflect: true }];
        if (functionId === "stream::list_all") return { stream: [{ id: "mem-live", groups: ["colon"] }], count: 1 };
        if (functionId === "stream::list_groups") return ["colon:full-group"];
        if (functionId === "stream::list") {
          expect(payload).toEqual({ stream_name: "mem-live", group_id: "colon:full-group" });
          return [{ source: "complete" }];
        }
        if (functionId === "state::get") return { cluster: "2026-10-06T00:00:00Z" };
        throw new Error(`Unexpected call ${functionId}`);
      },
    };
    const summary = await collectInventory(sdk, join(root, "inventory"));
    expect(summary.complete).toBe(true);
    expect(summary.valueCount).toBe(5);
    expect(summary.entries.find((entry: { kind: string }) => entry.kind === "target")).toMatchObject({ scope: "mem:config", key: "reflect:recentClusters", status: "ok" });
    expect(calls.every((call) => !/set|delete|update|enqueue|send/.test(call))).toBe(true);
    expect(compareInventories(summary, summary)).toMatchObject({ readableEqual: true, complete: true, comparedValues: 5 });
  });

  it("distinguishes readable equality with coverage gaps from complete proof", async () => {
    const root = await scratch();
    const sdk = {
      trigger: async ({ function_id: functionId }: { function_id: string }) => {
        if (functionId === "state::list_groups") return { groups: ["mem:too-large"] };
        if (functionId === "state::list") throw new Error("Invocation stopped");
        if (functionId === "stream::list_all") return { stream: [], count: 0 };
        if (functionId === "state::get") return null;
        return [];
      },
    };
    const summary = await collectInventory(sdk, join(root, "inventory"));
    expect(summary.complete).toBe(false);
    expect(summary.entries.find((entry: { kind: string }) => entry.kind === "state")).toMatchObject({ status: "gap", error: "Invocation stopped" });
    expect(compareInventories(summary, summary)).toMatchObject({ readableEqual: true, complete: false, comparedEntries: 1 });
  });

  it("allows only verified empty state scopes to be absent after restart when explicitly selected", () => {
    const empty = { kind: "state", scope: "mem:empty", status: "ok", multiset: valueMultiset([]) };
    const full = { kind: "state", scope: "mem:records", status: "ok", multiset: valueMultiset([{ id: "keep" }]) };
    const failed = { kind: "state", scope: "mem:failed", status: "gap", error: "Invocation stopped" };
    const target = { kind: "target", scope: "mem:empty", key: "known", status: "ok", multiset: valueMultiset([null]) };
    const stream = { kind: "stream", stream: "mem-live", group: "empty", status: "ok", multiset: valueMultiset([]) };
    const before = { complete: false, stateScopes: ["mem:empty", "mem:records", "mem:failed"], streams: [], entries: [empty, full, failed, target, stream], coverageGaps: [] };
    const after = { ...before, stateScopes: ["mem:records", "mem:failed"], entries: [full, failed, target, stream] };
    expect(compareInventories(before, after).readableEqual).toBe(false);
    const accepted = compareInventories(before, after, { allowAbsentEmptyScopes: true });
    expect(accepted).toMatchObject({ readableEqual: true, complete: false, physicalScopeCoverage: false, scopeCoverage: true, expectedEmptyScopeAbsences: ["mem:empty"] });
    expect(accepted.gaps).toHaveLength(1);
    const missingProtected = compareInventories(before, { ...after, stateScopes: [], entries: [] }, { allowAbsentEmptyScopes: true });
    expect(missingProtected.readableEqual).toBe(false);
    expect(missingProtected.expectedEmptyScopeAbsences).toEqual(["mem:empty"]);
    expect(missingProtected.differences.filter((item: { reason?: string }) => item.reason === "missing-entry")).toHaveLength(4);
    const unexpected = compareInventories(before, { ...after, stateScopes: [...after.stateScopes, "mem:new"] }, { allowAbsentEmptyScopes: true });
    expect(unexpected.readableEqual).toBe(false);
  });
});
