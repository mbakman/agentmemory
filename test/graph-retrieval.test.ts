import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import type { GraphNode, GraphEdge } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { logger } from "../src/logger.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockKV(
  nodes: GraphNode[] = [],
  edges: GraphEdge[] = [],
) {
  const store = new Map<string, Map<string, unknown>>();
  const nodesMap = new Map<string, unknown>();
  for (const n of nodes) nodesMap.set(n.id, n);
  store.set("mem:graph:nodes", nodesMap);

  const edgesMap = new Map<string, unknown>();
  for (const e of edges) edgesMap.set(e.id, e);
  store.set("mem:graph:edges", edgesMap);

  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function makeNode(
  id: string,
  name: string,
  type: GraphNode["type"] = "concept",
  obsIds: string[] = ["obs_1"],
): GraphNode {
  return {
    id,
    type,
    name,
    properties: {},
    sourceObservationIds: obsIds,
    createdAt: new Date().toISOString(),
  };
}

function makeEdge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  type: GraphEdge["type"] = "related_to",
  weight = 0.8,
): GraphEdge {
  return {
    id,
    type,
    sourceNodeId,
    targetNodeId,
    weight,
    sourceObservationIds: ["obs_1"],
    createdAt: new Date().toISOString(),
    tcommit: new Date().toISOString(),
    isLatest: true,
  };
}

describe("GraphRetrieval", () => {
  it("finds entities by name", async () => {
    const nodes = [
      makeNode("n1", "React", "library", ["obs_1"]),
      makeNode("n2", "Vue", "library", ["obs_2"]),
    ];
    const kv = mockKV(nodes, []);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["React"]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].obsId).toBe("obs_1");
  });

  it("finds entities by partial name match", async () => {
    const nodes = [makeNode("n1", "auth-middleware", "function", ["obs_1"])];
    const kv = mockKV(nodes, []);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["auth"]);
    expect(results.length).toBeGreaterThan(0);
  });

  it("traverses graph edges to find related observations", async () => {
    const nodes = [
      makeNode("n1", "React", "library", ["obs_1"]),
      makeNode("n2", "Component", "concept", ["obs_2"]),
    ];
    const edges = [makeEdge("e1", "n1", "n2", "uses")];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["React"], 2);
    const obsIds = results.map((r) => r.obsId);
    expect(obsIds).toContain("obs_1");
    expect(obsIds).toContain("obs_2");
  });

  it("returns empty for no matches", async () => {
    const kv = mockKV([], []);
    const retrieval = new GraphRetrieval(kv as never);
    const results = await retrieval.searchByEntities(["nonexistent"]);
    expect(results).toEqual([]);
  });

  it("expands from existing chunks", async () => {
    const nodes = [
      makeNode("n1", "auth.ts", "file", ["obs_1"]),
      makeNode("n2", "jwt", "concept", ["obs_2"]),
    ];
    const edges = [makeEdge("e1", "n1", "n2", "uses")];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.expandFromChunks(["obs_1"]);
    const obsIds = results.map((r) => r.obsId);
    expect(obsIds).toContain("obs_2");
  });

  it("does not duplicate already-seen observations in expansion", async () => {
    const nodes = [makeNode("n1", "file.ts", "file", ["obs_1", "obs_2"])];
    const kv = mockKV(nodes, []);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.expandFromChunks(["obs_1"]);
    const obsIds = results.map((r) => r.obsId);
    expect(obsIds).not.toContain("obs_1");
  });

  it("performs temporal query - current state", async () => {
    const nodes = [makeNode("n1", "Alice", "person", ["obs_1"])];
    const edges = [
      makeEdge("e1", "n1", "n1", "located_in" as any, 0.9),
      {
        ...makeEdge("e2", "n1", "n1", "located_in" as any, 0.9),
        tvalid: "2024-06-01",
        isLatest: true,
      },
    ];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const result = await retrieval.temporalQuery("Alice");
    expect(result.entity).toBeDefined();
    expect(result.entity!.name).toBe("Alice");
    expect(result.currentState.length).toBeGreaterThan(0);
  });

  it("returns null entity for unknown name", async () => {
    const kv = mockKV([], []);
    const retrieval = new GraphRetrieval(kv as never);
    const result = await retrieval.temporalQuery("Unknown");
    expect(result.entity).toBeNull();
  });

  it("scores closer paths higher", async () => {
    const nodes = [
      makeNode("n1", "React", "library", ["obs_1"]),
      makeNode("n2", "Hook", "concept", ["obs_2"]),
      makeNode("n3", "State", "concept", ["obs_3"]),
    ];
    const edges = [
      makeEdge("e1", "n1", "n2", "uses", 0.9),
      makeEdge("e2", "n2", "n3", "related_to", 0.8),
    ];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["React"], 3);
    const directScore = results.find((r) => r.obsId === "obs_1")?.score ?? 0;
    const indirectScore = results.find((r) => r.obsId === "obs_3")?.score ?? 0;
    expect(directScore).toBeGreaterThan(indirectScore);
  });

  // Dijkstra path selection (#328). The BFS implementation this
  // replaced visited a node via its first-discovered path regardless
  // of edge weight. Dijkstra picks the highest-weight (lowest
  // 1/weight cost) path, so a one-hop weak edge no longer beats a
  // two-hop chain of strong edges to the same node.
  it("picks the weight-optimal path under Dijkstra, not the edge-count-shortest one (#328)", async () => {
    const nodes = [
      makeNode("n1", "Start", "concept", ["obs_start"]),
      makeNode("n2", "Mid", "concept", ["obs_mid"]),
      makeNode("n3", "End", "concept", ["obs_end"]),
    ];
    const edges = [
      // Direct n1 → n3 path with a weak edge. BFS would prefer this.
      makeEdge("e_direct", "n1", "n3", "related_to", 0.15),
      // Two-hop chain n1 → n2 → n3 with strong edges. Total cost
      // (1/0.9) + (1/0.9) ≈ 2.22, vs direct 1/0.15 ≈ 6.67.
      // Dijkstra picks the chain.
      makeEdge("e_strong_a", "n1", "n2", "related_to", 0.9),
      makeEdge("e_strong_b", "n2", "n3", "related_to", 0.9),
    ];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["Start"], 3);
    const endResult = results.find((r) => r.obsId === "obs_end");
    expect(endResult).toBeDefined();
    // Path is [Start → Mid → End] (length 3) — Dijkstra picked the
    // chain of two strong edges over the direct weak one.
    expect(endResult!.pathLength).toBe(3);
    expect(endResult!.graphContext).toContain("Mid");
  });

  it("handles disconnected nodes without crashing", async () => {
    const nodes = [
      makeNode("n1", "A", "concept", ["obs_a"]),
      makeNode("n2", "B", "concept", ["obs_b"]),
      // n3 is unreachable from the matched node.
      makeNode("n3", "Lonely", "concept", ["obs_lonely"]),
    ];
    const edges = [makeEdge("e1", "n1", "n2", "related_to", 0.7)];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["A"], 5);
    expect(results.find((r) => r.obsId === "obs_a")).toBeDefined();
    expect(results.find((r) => r.obsId === "obs_b")).toBeDefined();
    expect(results.find((r) => r.obsId === "obs_lonely")).toBeUndefined();
  });

  it("clamps near-zero edge weights without dividing by zero", async () => {
    const nodes = [
      makeNode("n1", "Anchor", "concept", ["obs_anchor"]),
      makeNode("n2", "Weak", "concept", ["obs_weak"]),
    ];
    // weight: 0 is malformed but we shouldn't crash on it; the clamp
    // floor at 0.01 means traversal completes with a very high cost
    // rather than throwing or producing Infinity.
    const edges = [makeEdge("e1", "n1", "n2", "related_to", 0)];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["Anchor"], 2);
    const weak = results.find((r) => r.obsId === "obs_weak");
    expect(weak).toBeDefined();
    expect(Number.isFinite(weak!.score)).toBe(true);
  });

  it("scores startNode observations at 1.0 via the fallback path, not 0.5 via the path-scoring loop (#328 review)", async () => {
    // Regression for a bug surfaced by inline review on #463: if the
    // traversal includes a length-1 path for the startNode itself,
    // the generic path-scoring loop in searchByEntities computes
    // avgWeight=0.5 (empty edgeWeights → fallback) and pathLength=1,
    // yielding score=0.5, then marks the obs as visited. The
    // dedicated score=1.0 fallback loop for startNode obs is then
    // skipped via the visitedObs guard — dead code.
    const nodes = [
      makeNode("n1", "React", "library", ["obs_root"]),
      makeNode("n2", "Hook", "concept", ["obs_neighbor"]),
    ];
    const edges = [makeEdge("e1", "n1", "n2", "uses", 0.8)];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["React"], 2);
    const root = results.find((r) => r.obsId === "obs_root");
    expect(root).toBeDefined();
    expect(root!.score).toBe(1.0);
    expect(root!.pathLength).toBe(0);
  });

  it("respects maxDepth bound (Dijkstra stops at edge-count depth)", async () => {
    // Chain n1 -> n2 -> n3 -> n4. With maxDepth=2 we should reach n3
    // but not n4 — edge-count semantics preserved from the old BFS.
    const nodes = [
      makeNode("n1", "Start", "concept", ["obs_1"]),
      makeNode("n2", "Hop1", "concept", ["obs_2"]),
      makeNode("n3", "Hop2", "concept", ["obs_3"]),
      makeNode("n4", "Hop3", "concept", ["obs_4"]),
    ];
    const edges = [
      makeEdge("e1", "n1", "n2", "related_to", 0.8),
      makeEdge("e2", "n2", "n3", "related_to", 0.8),
      makeEdge("e3", "n3", "n4", "related_to", 0.8),
    ];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["Start"], 2);
    expect(results.find((r) => r.obsId === "obs_3")).toBeDefined();
    expect(results.find((r) => r.obsId === "obs_4")).toBeUndefined();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe.each(["searchByEntities", "expandFromChunks"] as const)(
  "GraphRetrieval.%s enumeration",
  (method) => {
    const nodes = [
      makeNode("n1", "Anchor", "concept", ["obs_root"]),
      makeNode("n2", "Neighbor", "concept", ["obs_neighbor"]),
    ];
    const edges = [makeEdge("e1", "n1", "n2")];
    const retrieve = (retrieval: GraphRetrieval, maxResults = 20) =>
      method === "searchByEntities"
        ? retrieval.searchByEntities(["Anchor"], 2, maxResults)
        : retrieval.expandFromChunks(["obs_root"], 2, maxResults);

    beforeEach(() => {
      vi.mocked(logger.warn).mockClear();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("starts both state reads before either one resolves", async () => {
      const nodeRead = deferred<GraphNode[]>();
      const edgeRead = deferred<GraphEdge[]>();
      const kv = {
        list: vi.fn((scope: string) =>
          scope === KV.graphNodes ? nodeRead.promise : edgeRead.promise,
        ),
      };
      let settled = false;
      const result = retrieve(new GraphRetrieval(kv as never)).then((value) => {
        settled = true;
        return value;
      });

      expect(kv.list.mock.calls).toEqual([[KV.graphNodes], [KV.graphEdges]]);
      expect(settled).toBe(false);
      nodeRead.resolve(nodes);
      await Promise.resolve();
      expect(settled).toBe(false);
      edgeRead.resolve(edges);

      expect((await result).map((item) => item.obsId)).toContain("obs_neighbor");
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it.each([KV.graphNodes, KV.graphEdges])(
      "returns an empty stream when %s rejects",
      async (failedScope) => {
        const failure = new Error(`read failed: ${failedScope}`);
        const kv = {
          list: vi.fn(async (scope: string) => {
            if (scope === failedScope) throw failure;
            return scope === KV.graphNodes ? nodes : edges;
          }),
        };

        await expect(retrieve(new GraphRetrieval(kv as never))).resolves.toEqual([]);
        expect(kv.list.mock.calls).toEqual([[KV.graphNodes], [KV.graphEdges]]);
        expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
          "graph retrieval enumeration failed, skipping graph stream",
          { error: failure.message },
        );
      },
    );

    it("reports non-Error failures without rejecting the graph stream", async () => {
      const kv = { list: vi.fn(async () => { throw "state unavailable"; }) };

      await expect(retrieve(new GraphRetrieval(kv as never))).resolves.toEqual([]);
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        "graph retrieval enumeration failed, skipping graph stream",
        { error: "state unavailable" },
      );
    });

    it("returns at six seconds and leaves late state reads uncancelled", async () => {
      vi.useFakeTimers();
      const nodeRead = deferred<GraphNode[]>();
      const edgeRead = deferred<GraphEdge[]>();
      const nodeSettled = vi.fn();
      const edgeSettled = vi.fn();
      nodeRead.promise.then(nodeSettled);
      edgeRead.promise.then(edgeSettled);
      const kv = {
        list: vi.fn((scope: string) =>
          scope === KV.graphNodes ? nodeRead.promise : edgeRead.promise,
        ),
      };
      let settled = false;
      const result = retrieve(new GraphRetrieval(kv as never)).then((value) => {
        settled = true;
        return value;
      });

      await vi.advanceTimersByTimeAsync(5999);
      expect(settled).toBe(false);
      expect(logger.warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(await result).toEqual([]);
      expect(nodeSettled).not.toHaveBeenCalled();
      expect(edgeSettled).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        "graph retrieval enumeration failed, skipping graph stream",
        { error: "graph-retrieval enumeration: exceeded 6000ms budget" },
      );

      nodeRead.resolve(nodes);
      edgeRead.resolve(edges);
      await Promise.all([nodeRead.promise, edgeRead.promise]);

      expect(nodeSettled).toHaveBeenCalledWith(nodes);
      expect(edgeSettled).toHaveBeenCalledWith(edges);
      expect(await result).toEqual([]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("uses results received before the deadline and clears its timer", async () => {
      vi.useFakeTimers();
      const nodeRead = deferred<GraphNode[]>();
      const edgeRead = deferred<GraphEdge[]>();
      const kv = {
        list: vi.fn((scope: string) =>
          scope === KV.graphNodes ? nodeRead.promise : edgeRead.promise,
        ),
      };
      const result = retrieve(new GraphRetrieval(kv as never));

      await vi.advanceTimersByTimeAsync(5999);
      nodeRead.resolve(nodes);
      edgeRead.resolve(edges);

      expect((await result).map((item) => item.obsId)).toContain("obs_neighbor");
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("filters stale nodes and edges while preserving scores and output limits", async () => {
      const staleNode = {
        ...makeNode("n3", "Anchor-old", "concept", ["obs_stale_node"]),
        stale: true,
      };
      const blockedNode = makeNode("n4", "Blocked", "concept", ["obs_stale_edge"]);
      const staleEdge = { ...makeEdge("e3", "n1", "n4"), stale: true };
      const kv = mockKV(
        [...nodes, staleNode, blockedNode],
        [...edges, makeEdge("e2", "n1", "n3"), staleEdge],
      );
      const retrieval = new GraphRetrieval(kv as never);

      const results = await retrieve(retrieval);
      expect(results.map((item) => item.obsId)).toEqual(
        method === "searchByEntities"
          ? ["obs_root", "obs_neighbor"]
          : ["obs_neighbor"],
      );
      expect(results[0].score).toBe(method === "searchByEntities" ? 1 : 1 / 6);
      expect(await retrieve(retrieval, 1)).toEqual(results.slice(0, 1));
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("returns empty for an empty graph without warning", async () => {
      await expect(retrieve(new GraphRetrieval(mockKV() as never))).resolves.toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  },
);

describe("GraphRetrieval.temporalQuery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves state failures instead of converting them to an empty stream", async () => {
    const kv = { list: vi.fn(async () => { throw new Error("temporal read failed"); }) };

    await expect(new GraphRetrieval(kv as never).temporalQuery("Anchor"))
      .rejects.toThrow("temporal read failed");
  });

  it("retains sequential state reads without the graph-stream timeout", async () => {
    vi.useFakeTimers();
    const nodeRead = deferred<GraphNode[]>();
    const edgeRead = deferred<GraphEdge[]>();
    const kv = {
      list: vi.fn((scope: string) =>
        scope === KV.graphNodes ? nodeRead.promise : edgeRead.promise,
      ),
    };
    let settled = false;
    const result = new GraphRetrieval(kv as never).temporalQuery("Anchor").then((value) => {
      settled = true;
      return value;
    });

    expect(kv.list.mock.calls).toEqual([[KV.graphNodes]]);
    await vi.advanceTimersByTimeAsync(6001);
    expect(settled).toBe(false);
    nodeRead.resolve([makeNode("n1", "Anchor")]);
    await Promise.resolve();
    expect(kv.list.mock.calls).toEqual([[KV.graphNodes], [KV.graphEdges]]);
    edgeRead.resolve([]);

    expect((await result).entity?.name).toBe("Anchor");
  });
});
