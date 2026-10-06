import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  backfillVectors,
  getPendingVectorBackfillCount,
  getSearchIndex,
  isBm25RebuildIncomplete,
  isMemoryIndexReady,
  isKeywordRebuildInProgress,
  markKeywordRebuildPending,
  rebuildKeywordIndex,
  registerSearchFunction,
  setEmbeddingProvider,
  setIndexPersistence,
  setVectorIndex,
} from "../src/functions/search.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, EmbeddingProvider, Memory, Session } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    list: async <T>(scope: string): Promise<T[]> => Array.from(store.get(scope)?.values() ?? []) as T[],
    get: async <T>(scope: string, key: string): Promise<T | null> => (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
  };
}

const WORDS = ["auth", "cache", "index", "vector", "session", "memory", "graph", "retry", "queue", "schema", "deploy", "worker"];

function makeObs(id: string, sessionId: string, i: number, timestamp: string): CompressedObservation {
  const a = WORDS[i % WORDS.length];
  const b = WORDS[(i * 7) % WORDS.length];
  return {
    id,
    sessionId,
    timestamp,
    type: "file_edit",
    title: `${a} change ${i}`,
    facts: [`touched ${b} path`],
    narrative: `Updated the ${a} module so ${b} handling works for case ${i}`,
    concepts: [a, b],
    files: [`src/${a}/${b}.ts`],
    importance: 5,
  };
}

function seed(kv: ReturnType<typeof mockKV>, sessions: number, perSession: number, timestamp: (i: number) => string) {
  let n = 0;
  for (let s = 0; s < sessions; s++) {
    const sessionId = `ses_${s}`;
    kv.store.set("mem:sessions", kv.store.get("mem:sessions") ?? new Map());
    kv.store.get("mem:sessions")!.set(sessionId, {
      id: sessionId,
      project: "p",
      cwd: "/tmp",
      startedAt: timestamp(0),
      status: "completed",
      observationCount: perSession,
    } satisfies Session);
    const scope = `mem:obs:${sessionId}`;
    kv.store.set(scope, new Map());
    for (let o = 0; o < perSession; o++) {
      const id = `obs_${n}`;
      kv.store.get(scope)!.set(id, makeObs(id, sessionId, n, timestamp(n)));
      n++;
    }
  }
  const memories = new Map<string, Memory>();
  memories.set("mem_1", {
    id: "mem_1",
    createdAt: timestamp(0),
    updatedAt: timestamp(0),
    type: "fact",
    title: "Deploy uses blue green",
    content: "Deploys switch traffic after health checks pass",
    concepts: ["deploy"],
    files: [],
    sessionIds: ["ses_0"],
    strength: 7,
    version: 1,
    isLatest: true,
  } as Memory);
  memories.set("mem_old", {
    id: "mem_old",
    createdAt: timestamp(0),
    updatedAt: timestamp(0),
    type: "fact",
    title: "Superseded",
    content: "Old version",
    concepts: [],
    files: [],
    sessionIds: [],
    strength: 1,
    version: 1,
    isLatest: false,
  } as Memory);
  kv.store.set("mem:memories", memories);
  kv.store.get("mem:obs:ses_0")!.set("raw_1", { id: "raw_1", sessionId: "ses_0", timestamp: timestamp(0) });
  return n;
}

function stubProvider(): EmbeddingProvider {
  return {
    name: "stub",
    dimensions: 3,
    embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
  } as EmbeddingProvider;
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

function holdSessionListing(kv: ReturnType<typeof mockKV>) {
  const entered = barrier();
  const release = barrier();
  const list = vi.fn(async <T>(scope: string): Promise<T[]> => {
    if (scope === KV.sessions) {
      entered.resolve();
      await release.promise;
    }
    return kv.list<T>(scope);
  });
  return { ...kv, list, entered, release };
}

function registerRecall(kv: ReturnType<typeof mockKV>) {
  type Handler = (data: { query: string; format: string }) => Promise<{ results: Array<{ obsId: string }> }>;
  let handler!: Handler;
  registerSearchFunction({
    registerFunction: (_id: string, fn: Handler) => { handler = fn; },
  } as never, kv as never);
  return () => handler({ query: "auth", format: "compact" });
}

describe("rebuildKeywordIndex", () => {
  afterEach(() => {
    getSearchIndex().clear();
    setVectorIndex(null);
    setEmbeddingProvider(null);
    setIndexPersistence(null);
  });

  it("holds early recall requests for the reserved boot rebuild without starting another scan", async () => {
    const kv = mockKV();
    seed(kv, 1, 3, () => "2026-09-01T00:00:00.000Z");
    const held = holdSessionListing(kv);
    const recall = registerRecall(held);
    getSearchIndex().clear();
    markKeywordRebuildPending();
    let settled = 0;
    const requests = Array.from({ length: 3 }, () => recall().then((result) => { settled++; return result; }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsBeforeBoot = held.list.mock.calls.length;
    const boot = rebuildKeywordIndex(held as never);
    await held.entered.promise;

    try {
      expect(callsBeforeBoot).toBe(0);
      expect(settled).toBe(0);
      expect(isKeywordRebuildInProgress()).toBe(true);
      expect(getSearchIndex().size).toBe(1);
    } finally {
      held.release.resolve();
      await boot;
      await Promise.all(requests);
    }

    for (const result of await Promise.all(requests)) {
      expect(result.results.map((entry) => entry.obsId)).toContain("obs_0");
    }
    expect(held.list.mock.calls.map(([scope]) => scope)).toEqual([
      KV.memories, KV.sessions, KV.observations("ses_0"),
    ]);
    expect(isKeywordRebuildInProgress()).toBe(false);
  });

  it("holds recall while a boot rebuild has a partly populated index", async () => {
    const kv = mockKV();
    seed(kv, 1, 3, () => "2026-09-01T00:00:00.000Z");
    const held = holdSessionListing(kv);
    const recall = registerRecall(held);
    const boot = rebuildKeywordIndex(held as never);
    await held.entered.promise;
    let settled = 0;
    const requests = Array.from({ length: 3 }, () => recall().then((result) => { settled++; return result; }));
    await new Promise<void>((resolve) => setImmediate(resolve));

    try {
      expect(getSearchIndex().size).toBe(1);
      expect(settled).toBe(0);
      expect(held.list.mock.calls.map(([scope]) => scope)).toEqual([KV.memories, KV.sessions]);
    } finally {
      held.release.resolve();
      await boot;
      await Promise.all(requests);
    }

    for (const result of await Promise.all(requests)) {
      expect(result.results.map((entry) => entry.obsId)).toContain("obs_0");
    }
    expect(getSearchIndex().size).toBe(4);
    expect(held.list.mock.calls.map(([scope]) => scope)).toEqual([
      KV.memories, KV.sessions, KV.observations("ses_0"),
    ]);
  });

  it("shares overlapping rebuilds while retaining the boot vector cutoff", async () => {
    const kv = mockKV();
    seed(kv, 2, 5, (i) => (i < 5 ? "2026-09-01T00:00:00.000Z" : "2026-09-20T00:00:00.000Z"));
    const held = holdSessionListing(kv);
    setVectorIndex(new VectorIndex());
    setEmbeddingProvider(stubProvider());
    const boot = rebuildKeywordIndex(held as never, "2026-09-10T00:00:00.000Z");
    await held.entered.promise;
    const overlapping = rebuildKeywordIndex(held as never);

    try {
      expect(overlapping).toBe(boot);
    } finally {
      held.release.resolve();
    }
    const result = await boot;
    expect(result.vectorJobs.map((job) => job.id).sort()).toEqual(["obs_5", "obs_6", "obs_7", "obs_8", "obs_9"]);
    expect(held.list.mock.calls.map(([scope]) => scope)).toEqual([
      KV.memories, KV.sessions, KV.observations("ses_0"), KV.observations("ses_1"),
    ]);
  });

  it("rebuilds BM25 from stored observations and latest memories, quickly", async () => {
    const kv = mockKV();
    const total = seed(kv, 100, 30, () => "2026-09-01T00:00:00.000Z");
    getSearchIndex().add(makeObs("ghost", "ses_gone", 0, "2026-09-01T00:00:00.000Z"));

    const started = performance.now();
    const result = await rebuildKeywordIndex(kv as never);
    const elapsed = performance.now() - started;

    expect(total).toBe(3000);
    expect(result.documents).toBe(3001);
    expect(result.vectorJobs).toEqual([]);
    const idx = getSearchIndex();
    expect(idx.size).toBe(3001);
    expect(idx.has("ghost")).toBe(false);
    expect(idx.has("mem_1")).toBe(true);
    expect(idx.has("mem_old")).toBe(false);
    expect(idx.has("raw_1")).toBe(false);
    expect(idx.search("blue green").map((r) => r.obsId)).toContain("mem_1");
    expect(isMemoryIndexReady()).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
  });

  it("keeps the vector index untouched and reports an incomplete rebuild when the sessions listing fails", async () => {
    const kv = mockKV();
    seed(kv, 1, 3, () => "2026-09-01T00:00:00.000Z");
    const vector = new VectorIndex();
    vector.add("obs_0", "ses_0", new Float32Array([0.1, 0.2, 0.3]));
    setVectorIndex(vector);
    setEmbeddingProvider(stubProvider());
    const failingKv = {
      ...kv,
      list: async <T>(scope: string): Promise<T[]> => {
        if (scope === "mem:sessions") throw new Error("engine unreachable");
        return kv.list<T>(scope);
      },
    };

    const result = await rebuildKeywordIndex(failingKv as never, null);

    expect(result.vectorJobs).toEqual([]);
    expect(vector.size).toBe(1);
    expect(vector.has("obs_0")).toBe(true);
    expect(isBm25RebuildIncomplete()).toBe(true);
  }, 10_000);

  it("queues embeddings only for documents newer than the last vector save", async () => {
    const kv = mockKV();
    seed(kv, 2, 5, (i) => (i < 5 ? "2026-09-01T00:00:00.000Z" : "2026-09-20T00:00:00.000Z"));
    const vector = new VectorIndex();
    vector.add("obs_6", "ses_1", new Float32Array([0.1, 0.2, 0.3]));
    setVectorIndex(vector);
    setEmbeddingProvider(stubProvider());

    const result = await rebuildKeywordIndex(kv as never, "2026-09-10T00:00:00.000Z");

    expect(result.vectorJobs.map((j) => j.id).sort()).toEqual(["obs_5", "obs_7", "obs_8", "obs_9"]);
  });

  it("withholds a whole-store backfill by default and reports it as pending, and queues none when storage was unavailable", async () => {
    const kv = mockKV();
    seed(kv, 1, 3, () => "2026-09-01T00:00:00.000Z");
    setVectorIndex(new VectorIndex());
    setEmbeddingProvider(stubProvider());

    const fresh = await rebuildKeywordIndex(kv as never, null);
    expect(fresh.vectorJobs).toEqual([]);
    expect(fresh.fullBackfillPending).toBe(4);

    const unavailable = await rebuildKeywordIndex(kv as never, undefined);
    expect(unavailable.vectorJobs).toEqual([]);
    expect(unavailable.fullBackfillPending).toBe(0);
  });

  it("runs the whole-store backfill, capped, once AGENTMEMORY_VECTOR_BACKFILL=all is set", async () => {
    const kv = mockKV();
    seed(kv, 1, 3, () => "2026-09-01T00:00:00.000Z");
    setVectorIndex(new VectorIndex());
    setEmbeddingProvider(stubProvider());
    process.env.AGENTMEMORY_VECTOR_BACKFILL = "all";
    try {
      const opted = await rebuildKeywordIndex(kv as never, null);
      expect(opted.vectorJobs.map((j) => j.id).sort()).toEqual(["mem_1", "obs_0", "obs_1", "obs_2"]);
      expect(opted.fullBackfillPending).toBe(0);

      process.env.AGENTMEMORY_VECTOR_BACKFILL_MAX = "2";
      const capped = await rebuildKeywordIndex(kv as never, null);
      expect(capped.vectorJobs.length).toBe(2);
    } finally {
      delete process.env.AGENTMEMORY_VECTOR_BACKFILL;
      delete process.env.AGENTMEMORY_VECTOR_BACKFILL_MAX;
    }
  });

  it("backfills queued vectors in batches and saves progress", async () => {
    const kv = mockKV();
    seed(kv, 1, 3, () => "2026-09-01T00:00:00.000Z");
    const vector = new VectorIndex();
    setVectorIndex(vector);
    setEmbeddingProvider(stubProvider());
    let saved = 0;
    setIndexPersistence({ scheduleSave: () => {}, save: async () => void saved++ });
    process.env.AGENTMEMORY_VECTOR_BACKFILL = "all";

    try {
      const { vectorJobs } = await rebuildKeywordIndex(kv as never, null);
      const added = await backfillVectors(vectorJobs);

      expect(added).toBe(4);
      expect(vector.size).toBe(4);
      expect(saved).toBe(1);
      expect(getPendingVectorBackfillCount()).toBe(0);
    } finally {
      delete process.env.AGENTMEMORY_VECTOR_BACKFILL;
    }
  });
});
