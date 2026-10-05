import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerReflectFunctions } from "../src/functions/reflect.js";
import { KV } from "../src/state/schema.js";
import { logger } from "../src/logger.js";
import type { Insight, GraphNode, GraphEdge, GraphSnapshot, SemanticMemory, Lesson, Crystal, AuditEntry } from "../src/types.js";

let fixtureId = 0;

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
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

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function makeConceptNode(name: string): GraphNode {
  return {
    id: `node_${name}`,
    type: "concept",
    name,
    properties: {},
    sourceObservationIds: [],
    createdAt: "2026-04-01T00:00:00Z",
  };
}

function makeEdge(src: string, tgt: string): GraphEdge {
  return {
    id: `edge_${src}_${tgt}`,
    type: "related_to",
    sourceNodeId: `node_${src}`,
    targetNodeId: `node_${tgt}`,
    weight: 1,
    sourceObservationIds: [],
    createdAt: "2026-04-01T00:00:00Z",
  };
}

function makeSemantic(fact: string, id?: string): SemanticMemory {
  return {
    id: id || `sem_${fixtureId++}`,
    fact,
    confidence: 0.8,
    sourceSessionIds: [],
    sourceMemoryIds: [],
    accessCount: 1,
    lastAccessedAt: "2026-04-01T00:00:00Z",
    strength: 0.8,
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
  };
}

function makeLesson(content: string, tags: string[], id?: string): Lesson {
  return {
    id: id || `lsn_${fixtureId++}`,
    content,
    context: "",
    confidence: 0.7,
    reinforcements: 0,
    source: "manual",
    sourceIds: [],
    tags,
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    decayRate: 0.05,
  };
}

function makeCrystal(narrative: string, lessons: string[], id?: string): Crystal {
  return {
    id: id || `crys_${fixtureId++}`,
    narrative,
    keyOutcomes: [],
    filesAffected: [],
    lessons,
    sourceActionIds: [],
    createdAt: "2026-04-01T00:00:00Z",
  };
}

function makeSnapshot(nodes: GraphNode[], edges: GraphEdge[]): GraphSnapshot {
  return {
    version: 1,
    topNodes: nodes,
    topEdges: edges,
    topDegrees: {},
    stats: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      nodesByType: { concept: nodes.length },
      edgesByType: { related_to: edges.length },
    },
    updatedAt: "2026-10-05T12:00:00.000Z",
    dirty: false,
  };
}

async function seedSnapshot(
  kv: ReturnType<typeof mockKV>,
  names: string[],
  links: Array<[string, string]>,
) {
  await kv.set(KV.graphSnapshot, "current", makeSnapshot(
    names.map(makeConceptNode),
    links.map(([source, target]) => makeEdge(source, target)),
  ));
}

async function seedSupportedCluster(kv: ReturnType<typeof mockKV>) {
  await seedSnapshot(kv, ["alpha", "bravo"], [["alpha", "bravo"]]);
  for (let i = 0; i < 3; i++) {
    await kv.set(KV.semantic, `support_${i}`, makeSemantic(`alpha bravo finding${i}`, `support_${i}`));
  }
}

const XML_RESPONSE = `<insights>
<insight confidence="0.85" title="Defense in Depth">
Security requires layered protection: input validation, safe APIs, and deny-lists together.
</insight>
<insight confidence="0.7" title="Testing at Boundaries">
Focus test effort on system boundaries where trust transitions occur.
</insight>
</insights>`;

describe("Reflect", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let provider: { name: string; compress: ReturnType<typeof vi.fn>; summarize: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    fixtureId = 0;
    vi.clearAllMocks();
    vi.stubEnv("AGENTMEMORY_REFLECT_CLUSTER_COOLDOWN_MS", undefined);
    vi.stubEnv("AGENTMEMORY_REFLECT_PROMPT_CHARS", undefined);
    sdk = mockSdk();
    kv = mockKV();
    provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(XML_RESPONSE),
    };
    registerReflectFunctions(sdk as never, kv as never, provider as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("mem::reflect", () => {
    it("returns empty when no graph nodes or memories exist", async () => {
      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        newInsights: number;
        clustersProcessed: number;
      };

      expect(result.success).toBe(true);
      expect(result.newInsights).toBe(0);
      expect(result.clustersProcessed).toBe(0);
    });

    it("synthesizes insights from graph concept clusters", async () => {
      await seedSnapshot(kv, ["security", "validation", "testing"], [
        ["security", "validation"], ["security", "testing"],
      ]);

      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection attacks"));
      await kv.set("mem:lessons", "lsn_1", makeLesson("Use execFile for security", ["security"]));

      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        newInsights: number;
      };

      expect(result.success).toBe(true);
      expect(result.newInsights).toBe(2);
      expect(provider.summarize).toHaveBeenCalled();

      const insights = await kv.list<Insight>("mem:insights");
      expect(insights.length).toBe(2);
      expect(insights[0].title).toBeTruthy();
      expect(insights[0].sourceConceptCluster.length).toBeGreaterThan(0);
    });

    it("skips clusters with fewer than 3 supporting items", async () => {
      await seedSnapshot(kv, ["sparse", "topic"], [["sparse", "topic"]]);
      await kv.set("mem:semantic", "sem_1", makeSemantic("One sparse fact"));

      const result = (await sdk.trigger("mem::reflect", {})) as {
        clustersSkipped: number;
        newInsights: number;
      };

      expect(result.clustersSkipped).toBe(1);
      expect(result.newInsights).toBe(0);
      expect(provider.summarize).not.toHaveBeenCalled();
    });

    it("deduplicates insights by fingerprint", async () => {
      vi.stubEnv("AGENTMEMORY_REFLECT_CLUSTER_COOLDOWN_MS", "0");
      await seedSnapshot(kv, ["security", "validation"], [["security", "validation"]]);
      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection"));

      await sdk.trigger("mem::reflect", {});
      const first = await kv.list<Insight>("mem:insights");
      expect(first.length).toBe(2);

      const result = (await sdk.trigger("mem::reflect", {})) as {
        reinforced: number;
        newInsights: number;
      };

      expect(result.reinforced).toBe(2);
      expect(result.newInsights).toBe(0);

      const after = await kv.list<Insight>("mem:insights");
      expect(after.length).toBe(2);
      expect(after[0].reinforcements).toBe(1);
    });

    it("falls back to Jaccard grouping when graph is empty", async () => {
      await kv.set("mem:semantic", "sem_1", makeSemantic("security validation is important"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("security testing prevents bugs"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("validation testing framework"));
      await kv.set("mem:lessons", "lsn_1", makeLesson("Use security headers", ["security", "validation"]));

      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        usedFallback: boolean;
      };

      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
    });

    it("handles LLM failure gracefully", async () => {
      provider.summarize.mockRejectedValue(new Error("LLM timeout"));

      await seedSnapshot(kv, ["concept_a", "concept_b"], [["concept_a", "concept_b"]]);
      await kv.set("mem:semantic", "sem_1", makeSemantic("fact about concept_a"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("fact about concept_b"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("concept_a and concept_b together"));

      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        newInsights: number;
      };

      expect(result.success).toBe(true);
      expect(result.newInsights).toBe(0);
      expect(provider.summarize).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith("reflect: cluster synthesis failed", expect.objectContaining({ error: "LLM timeout" }));
    });
  });

  describe("reflect snapshot and clustering limits", () => {
    beforeEach(() => {
      provider.summarize.mockResolvedValue("");
    });

    it("uses the snapshot without enumerating live graph scopes", async () => {
      await seedSupportedCluster(kv);
      const list = vi.spyOn(kv, "list");
      const get = vi.spyOn(kv, "get");
      const result = await sdk.trigger("mem::reflect", {});
      expect(result.usedFallback).toBe(false);
      expect(provider.summarize).toHaveBeenCalledOnce();
      expect(get).toHaveBeenCalledWith(KV.graphSnapshot, "current");
      expect(list).not.toHaveBeenCalledWith(KV.graphNodes);
      expect(list).not.toHaveBeenCalledWith(KV.graphEdges);
    });

    it.each(["absent", "empty", "wrong-version", "failed"])(
      "falls back when the snapshot is %s even with live graph nodes",
      async (kind) => {
        await kv.set(KV.graphNodes, "node_alpha", makeConceptNode("alpha"));
        await kv.set(KV.graphNodes, "node_bravo", makeConceptNode("bravo"));
        await kv.set(KV.graphEdges, "edge", makeEdge("alpha", "bravo"));
        if (kind === "empty") await kv.set(KV.graphSnapshot, "current", makeSnapshot([], []));
        if (kind === "wrong-version") {
          await kv.set(KV.graphSnapshot, "current", { ...makeSnapshot([], []), version: 2 });
        }
        if (kind === "failed") {
          const get = kv.get.bind(kv);
          vi.spyOn(kv, "get").mockImplementation(async (scope, key) => {
            if (scope === KV.graphSnapshot) throw new Error("snapshot unavailable");
            return get(scope, key);
          });
        }
        const list = vi.spyOn(kv, "list");
        const result = await sdk.trigger("mem::reflect", {});
        expect(result.usedFallback).toBe(true);
        expect(result.clustersProcessed).toBe(0);
        expect(list).not.toHaveBeenCalledWith(KV.graphNodes);
        expect(list).not.toHaveBeenCalledWith(KV.graphEdges);
        if (kind === "failed") {
          expect(logger.warn).toHaveBeenCalledWith("Graph snapshot read failed", { error: "snapshot unavailable" });
        }
      },
    );

    it("continues past visited graph seeds to process disconnected clusters", async () => {
      await seedSnapshot(kv, ["alpha", "bravo", "charlie", "delta"], [
        ["alpha", "bravo"], ["charlie", "delta"],
      ]);
      for (const name of ["alpha", "charlie"]) {
        for (let i = 0; i < 3; i++) {
          const id = `${name}_${i}`;
          await kv.set(KV.semantic, id, makeSemantic(`${name} fact${i}`, id));
        }
      }
      const result = await sdk.trigger("mem::reflect", {});
      expect(result.clustersProcessed).toBe(2);
      expect(provider.summarize).toHaveBeenCalledTimes(2);
      expect(provider.summarize.mock.calls.map((call) => call[1].split("\n")[2]))
        .toEqual(["## Concept Cluster: alpha, bravo", "## Concept Cluster: charlie, delta"]);
    });

    it("caps graph clusters at fifteen concepts and respects maxClusters", async () => {
      const names = Array.from({ length: 19 }, (_, i) => `concept${i}`);
      await seedSnapshot(kv, names, names.slice(1).map((name) => [names[0], name]));
      for (let i = 0; i < 3; i++) {
        await kv.set(KV.semantic, `support_${i}`, makeSemantic(`${names.join(" ")} source${i}`, `support_${i}`));
      }
      const result = await sdk.trigger("mem::reflect", { maxClusters: 1 });
      expect(result.clustersProcessed).toBe(1);
      expect(provider.summarize).toHaveBeenCalledOnce();
      const header = provider.summarize.mock.calls[0][1].split("\n")[2];
      expect(header).toBe(`## Concept Cluster: ${names.slice(0, 15).join(", ")}`);
    });

    it("caps the requested graph cluster count at twenty", async () => {
      const names: string[] = [];
      const links: Array<[string, string]> = [];
      for (let i = 0; i < 21; i++) {
        const pair: [string, string] = [`first${i}`, `second${i}`];
        names.push(...pair);
        links.push(pair);
        for (let j = 0; j < 3; j++) {
          const id = `support_${i}_${j}`;
          await kv.set(KV.semantic, id, makeSemantic(`${pair[0]} finding${j}`, id));
        }
      }
      await seedSnapshot(kv, names, links);
      const result = await sdk.trigger("mem::reflect", { maxClusters: 99 });
      expect(result.clustersProcessed).toBe(20);
      expect(provider.summarize).toHaveBeenCalledTimes(20);
    });

    it("uses only the 300 most frequent Jaccard seeds and peers, in fifteen-concept groups", async () => {
      const terms = Array.from({ length: 302 }, (_, i) => `term${String(i).padStart(4, "0")}`);
      await kv.set(KV.semantic, "sem_a", makeSemantic(terms.join(" "), "sem_a"));
      await kv.set(KV.semantic, "sem_b", makeSemantic(terms.join(" "), "sem_b"));
      await kv.set(KV.lessons, "lsn_a", makeLesson(terms.join(" "), [], "lsn_a"));
      const result = await sdk.trigger("mem::reflect", { maxClusters: 20 });
      const clusters = provider.summarize.mock.calls.map((call) =>
        call[1].split("\n")[2].replace("## Concept Cluster: ", "").split(", "),
      );
      expect(result.usedFallback).toBe(true);
      expect(result.clustersProcessed).toBe(20);
      expect(clusters).toHaveLength(20);
      expect(clusters.every((cluster) => cluster.length === 15)).toBe(true);
      expect(clusters.flat()).toEqual(terms.slice(0, 300));
    });

    it("includes the document-frequency bounds and excludes frequent or singleton terms", async () => {
      for (let i = 0; i < 12; i++) {
        const terms = ["ubiquitous", `singleton${i}`];
        if (i < 4) terms.push("overfreq");
        if (i < 3) terms.push("highalpha", "highbravo");
        if (i < 2) terms.push("lowalpha", "lowbravo");
        const id = `sem_${i}`;
        await kv.set(KV.semantic, id, makeSemantic(terms.join(" "), id));
      }
      const result = await sdk.trigger("mem::reflect", {});
      expect(result.clustersProcessed).toBe(1);
      expect(provider.summarize.mock.calls[0][1].split("\n")[2])
        .toBe("## Concept Cluster: highalpha, highbravo, lowalpha, lowbravo");
    });

    it.each(["node", "edge"])("filters a stale snapshot %s", async (kind) => {
      await seedSupportedCluster(kv);
      await kv.set(KV.graphSnapshot, "current", makeSnapshot(
        [makeConceptNode("alpha"), { ...makeConceptNode("bravo"), stale: kind === "node" }],
        [{ ...makeEdge("alpha", "bravo"), stale: kind === "edge" }],
      ));
      const result = await sdk.trigger("mem::reflect", {});
      expect(result.usedFallback).toBe(true);
      expect(provider.summarize).not.toHaveBeenCalled();
    });
  });

  describe("reflect supporting record selection", () => {
    it("selects strongest active facts and lessons and newest crystals, retaining omitted prompt provenance", async () => {
      vi.stubEnv("AGENTMEMORY_REFLECT_PROMPT_CHARS", "2000");
      await seedSnapshot(kv, ["alpha", "bravo"], [["alpha", "bravo"]]);
      for (let i = 0; i < 12; i++) {
        const fact = { ...makeSemantic(`alpha FACT${i} ${"x".repeat(900)}`, `fact_${i}`), confidence: i / 12 };
        const lesson = { ...makeLesson(`alpha LESSON${i} ${"y".repeat(900)}`, ["alpha"], `lesson_${i}`), confidence: i / 12, project: "/one" };
        await kv.set(KV.semantic, fact.id, fact);
        await kv.set(KV.lessons, lesson.id, lesson);
      }
      await kv.set(KV.lessons, "deleted", { ...makeLesson("alpha deleted", ["alpha"], "deleted"), deleted: true, confidence: 1, project: "/one" });
      await kv.set(KV.lessons, "other-project", { ...makeLesson("alpha other", ["alpha"], "other-project"), confidence: 1, project: "/two" });
      for (let i = 0; i < 7; i++) {
        await kv.set(KV.crystals, `crystal_${i}`, {
          ...makeCrystal(`CRYSTAL${i}`, ["alpha"], `crystal_${i}`),
          createdAt: `2026-10-0${i + 1}T00:00:00Z`,
        });
      }
      await sdk.trigger("mem::reflect", { project: "/one" });
      const [insight] = await kv.list<Insight>(KV.insights);
      expect(insight.sourceMemoryIds).toEqual(Array.from({ length: 10 }, (_, i) => `fact_${11 - i}`));
      expect(insight.sourceLessonIds).toEqual(Array.from({ length: 10 }, (_, i) => `lesson_${11 - i}`));
      expect(insight.sourceCrystalIds).toEqual(["crystal_6", "crystal_5", "crystal_4", "crystal_3", "crystal_2"]);
      const prompt = provider.summarize.mock.calls[0][1];
      expect(prompt).toContain("FACT11");
      expect(prompt).not.toContain("FACT9");
      expect(prompt.length).toBeLessThanOrEqual(2000);
    });

    it("requires three sources across facts, lessons, and crystals", async () => {
      await seedSnapshot(kv, ["alpha", "bravo"], [["alpha", "bravo"]]);
      await kv.set(KV.semantic, "fact", makeSemantic("alpha fact", "fact"));
      await kv.set(KV.lessons, "lesson", makeLesson("bravo lesson", ["bravo"], "lesson"));
      const sparse = await sdk.trigger("mem::reflect", {});
      expect(sparse.clustersSkipped).toBe(1);
      expect(provider.summarize).not.toHaveBeenCalled();
      await kv.set(KV.crystals, "crystal", makeCrystal("Completed work", ["alpha"], "crystal"));
      const supported = await sdk.trigger("mem::reflect", {});
      expect(supported.clustersProcessed).toBe(1);
      expect(provider.summarize).toHaveBeenCalledOnce();
    });
  });

  describe("reflect cluster cooldown", () => {
    const now = Date.parse("2026-10-05T12:00:00.000Z");
    const key = "reflect:recentClusters";

    beforeEach(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(now);
      await seedSupportedCluster(kv);
    });

    it("uses a seven-day cooldown, retains the exact cutoff, and expires afterward", async () => {
      await sdk.trigger("mem::reflect", {});
      const firstState = await kv.get<Record<string, string>>(KV.config, key);
      expect(firstState).toEqual({ "alpha|bravo": new Date(now).toISOString() });
      const immediate = await sdk.trigger("mem::reflect", {});
      expect(immediate).toMatchObject({ clustersProcessed: 0, clustersSkipped: 0, clustersCooledDown: 1, newInsights: 0 });
      vi.setSystemTime(now + 604800000);
      expect((await sdk.trigger("mem::reflect", {})).clustersCooledDown).toBe(1);
      vi.setSystemTime(now + 604800001);
      expect((await sdk.trigger("mem::reflect", {})).clustersProcessed).toBe(1);
      expect(provider.summarize).toHaveBeenCalledTimes(2);
      const audits = await kv.list<AuditEntry>(KV.audit);
      expect(audits[1].details).toMatchObject({ clustersProcessed: 0, clustersSkipped: 0, clustersCooledDown: 1 });
    });

    it.each([undefined, "", "invalid", "-1", "Infinity"])("uses the default for cooldown setting %s", async (setting) => {
      vi.stubEnv("AGENTMEMORY_REFLECT_CLUSTER_COOLDOWN_MS", setting);
      await kv.set(KV.config, key, { "alpha|bravo": new Date(now - 2 * 86400000).toISOString() });
      expect((await sdk.trigger("mem::reflect", {})).clustersCooledDown).toBe(1);
      expect(provider.summarize).not.toHaveBeenCalled();
    });

    it("applies a custom cooldown and the inclusive cutoff", async () => {
      vi.stubEnv("AGENTMEMORY_REFLECT_CLUSTER_COOLDOWN_MS", "1000");
      await kv.set(KV.config, key, { "alpha|bravo": new Date(now - 1000).toISOString() });
      expect((await sdk.trigger("mem::reflect", {})).clustersCooledDown).toBe(1);
      vi.setSystemTime(now + 1);
      expect((await sdk.trigger("mem::reflect", {})).clustersCooledDown).toBe(0);
      expect(provider.summarize).toHaveBeenCalledOnce();
    });

    it("disables all cooldown reads and writes when set to zero", async () => {
      vi.stubEnv("AGENTMEMORY_REFLECT_CLUSTER_COOLDOWN_MS", "0");
      const get = vi.spyOn(kv, "get");
      const set = vi.spyOn(kv, "set");
      await sdk.trigger("mem::reflect", {});
      const repeated = await sdk.trigger("mem::reflect", {});
      expect(repeated).toMatchObject({ clustersCooledDown: 0, reinforced: 2 });
      expect(provider.summarize).toHaveBeenCalledTimes(2);
      expect(get.mock.calls.some(([scope, name]) => scope === KV.config && name === key)).toBe(false);
      expect(set.mock.calls.some(([scope, name]) => scope === KV.config && name === key)).toBe(false);
    });

    it("normalizes case, order, and duplicates in a project-independent key", async () => {
      await seedSnapshot(kv, ["Bravo", "Alpha", "ALPHA"], [["Bravo", "Alpha"], ["Bravo", "ALPHA"]]);
      await sdk.trigger("mem::reflect", { project: "/one" });
      expect(await kv.get(KV.config, key)).toEqual({ "alpha|bravo": new Date(now).toISOString() });
      await seedSnapshot(kv, ["alpha", "bravo"], [["alpha", "bravo"]]);
      expect((await sdk.trigger("mem::reflect", { project: "/two" })).clustersCooledDown).toBe(1);
      expect(provider.summarize).toHaveBeenCalledOnce();
    });

    it("prunes invalid and expired entries and persists once", async () => {
      await kv.set(KV.config, key, {
        invalid: "invalid timestamp",
        expired: new Date(now - 604800001).toISOString(),
        boundary: new Date(now - 604800000).toISOString(),
        current: new Date(now).toISOString(),
      });
      const set = vi.spyOn(kv, "set");
      await sdk.trigger("mem::reflect", {});
      expect(await kv.get(KV.config, key)).toEqual({
        boundary: new Date(now - 604800000).toISOString(),
        current: new Date(now).toISOString(),
        "alpha|bravo": new Date(now).toISOString(),
      });
      expect(set.mock.calls.filter(([scope, name]) => scope === KV.config && name === key)).toHaveLength(1);
    });

    it.each([[], "not an object", null])("ignores unsupported stored cooldown shape %j", async (stored) => {
      await kv.set(KV.config, key, stored);
      expect((await sdk.trigger("mem::reflect", {})).clustersProcessed).toBe(1);
      expect(await kv.get(KV.config, key)).toEqual({ "alpha|bravo": new Date(now).toISOString() });
    });

    it("continues synthesis after a cooldown state read failure", async () => {
      const get = kv.get.bind(kv);
      vi.spyOn(kv, "get").mockImplementation(async (scope, name) => {
        if (scope === KV.config && name === key) throw new Error("state read failed");
        return get(scope, name);
      });
      const result = await sdk.trigger("mem::reflect", {});
      expect(result).toMatchObject({ success: true, newInsights: 2, clustersCooledDown: 0 });
      expect(await get(KV.config, key)).toEqual({ "alpha|bravo": new Date(now).toISOString() });
    });

    it("logs cooldown persistence failure without failing reflect", async () => {
      const set = kv.set.bind(kv);
      vi.spyOn(kv, "set").mockImplementation(async (scope, name, value) => {
        if (scope === KV.config && name === key) throw new Error("state write failed");
        return set(scope, name, value);
      });
      expect(await sdk.trigger("mem::reflect", {})).toMatchObject({ success: true, newInsights: 2 });
      expect(logger.warn).toHaveBeenCalledWith("reflect: failed to persist recent clusters", { error: "state write failed" });
    });

    it.each(["", "malformed", '<insight confidence="0.5" title="Empty"> </insight>'])(
      "stamps cooldown after resolved output %j, even without an insight",
      async (output) => {
        provider.summarize.mockImplementation(async () => {
          vi.setSystemTime(now + 100);
          return output;
        });
        const result = await sdk.trigger("mem::reflect", {});
        expect(result.newInsights).toBe(0);
        expect(await kv.get(KV.config, key)).toEqual({ "alpha|bravo": new Date(now + 100).toISOString() });
        expect((await sdk.trigger("mem::reflect", {})).clustersCooledDown).toBe(1);
        expect(provider.summarize).toHaveBeenCalledOnce();
      },
    );

    it("stamps cooldown before parsing a response that fails during coercion", async () => {
      provider.summarize.mockResolvedValue({ toString() { throw new Error("parse coercion failed"); } });
      expect((await sdk.trigger("mem::reflect", {})).newInsights).toBe(0);
      expect(await kv.get(KV.config, key)).toEqual({ "alpha|bravo": new Date(now).toISOString() });
      expect(logger.warn).toHaveBeenCalledWith("reflect: cluster synthesis failed", expect.objectContaining({ error: "parse coercion failed" }));
    });

    it("retains the stamp when later insight persistence fails", async () => {
      const set = kv.set.bind(kv);
      vi.spyOn(kv, "set").mockImplementation(async (scope, name, value) => {
        if (scope === KV.insights) throw new Error("insight write failed");
        return set(scope, name, value);
      });
      expect((await sdk.trigger("mem::reflect", {})).newInsights).toBe(0);
      expect(await kv.get(KV.config, key)).toEqual({ "alpha|bravo": new Date(now).toISOString() });
      expect((await sdk.trigger("mem::reflect", {})).clustersCooledDown).toBe(1);
      expect(provider.summarize).toHaveBeenCalledOnce();
    });

    it("does not stamp or suppress a retry after provider rejection", async () => {
      provider.summarize.mockRejectedValueOnce(new Error("provider rejected"));
      const set = vi.spyOn(kv, "set");
      await sdk.trigger("mem::reflect", {});
      expect(await kv.get(KV.config, key)).toBeNull();
      expect(set.mock.calls.some(([scope, name]) => scope === KV.config && name === key)).toBe(false);
      expect((await sdk.trigger("mem::reflect", {})).clustersProcessed).toBe(1);
      expect(provider.summarize).toHaveBeenCalledTimes(2);
    });

    it("does not persist unchanged state when synthesis is cooled down", async () => {
      await kv.set(KV.config, key, { "alpha|bravo": new Date(now).toISOString() });
      const set = vi.spyOn(kv, "set");
      expect((await sdk.trigger("mem::reflect", {})).clustersCooledDown).toBe(1);
      expect(set.mock.calls.some(([scope, name]) => scope === KV.config && name === key)).toBe(false);
    });

    it("counts insufficient support as skipped before checking cooldown", async () => {
      await kv.set(KV.config, key, { "alpha|bravo": new Date(now).toISOString() });
      const list = kv.list.bind(kv);
      vi.spyOn(kv, "list").mockImplementation(async (scope) => {
        const rows = await list(scope);
        return scope === KV.semantic ? rows.slice(0, 2) : rows;
      });
      expect(await sdk.trigger("mem::reflect", {})).toMatchObject({ clustersProcessed: 0, clustersSkipped: 1, clustersCooledDown: 0 });
      expect(provider.summarize).not.toHaveBeenCalled();
    });

    it("separates processed, skipped, and cooled clusters in the response and audit", async () => {
      await seedSnapshot(kv, ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"], [
        ["alpha", "bravo"], ["charlie", "delta"], ["echo", "foxtrot"],
      ]);
      await kv.set(KV.config, key, { "alpha|bravo": new Date(now).toISOString() });
      for (let i = 0; i < 3; i++) {
        await kv.set(KV.semantic, `charlie_${i}`, makeSemantic(`charlie finding${i}`, `charlie_${i}`));
      }
      await kv.set(KV.semantic, "echo", makeSemantic("echo one finding", "echo"));
      const result = await sdk.trigger("mem::reflect", {});
      expect(result).toMatchObject({ clustersProcessed: 1, clustersSkipped: 1, clustersCooledDown: 1 });
      expect(provider.summarize).toHaveBeenCalledOnce();
      const [audit] = await kv.list<AuditEntry>(KV.audit);
      expect(audit.details).toMatchObject({ clustersProcessed: 1, clustersSkipped: 1, clustersCooledDown: 1 });
    });
  });

  describe("mem::insight-list", () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      await kv.set("mem:insights", "ins_1", {
        id: "ins_1", title: "Insight A", content: "Content A", confidence: 0.9,
        reinforcements: 2, sourceConceptCluster: ["security"], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], project: "/app",
        tags: ["security"], createdAt: now, updatedAt: now, decayRate: 0.05,
      });
      await kv.set("mem:insights", "ins_2", {
        id: "ins_2", title: "Insight B", content: "Content B", confidence: 0.4,
        reinforcements: 0, sourceConceptCluster: ["testing"], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], project: "/other",
        tags: ["testing"], createdAt: now, updatedAt: now, decayRate: 0.05,
      });
    });

    it("lists all non-deleted insights sorted by confidence", async () => {
      const result = (await sdk.trigger("mem::insight-list", {})) as { insights: Insight[] };
      expect(result.insights.length).toBe(2);
      expect(result.insights[0].confidence).toBe(0.9);
    });

    it("filters by project", async () => {
      const result = (await sdk.trigger("mem::insight-list", { project: "/app" })) as { insights: Insight[] };
      expect(result.insights.length).toBe(1);
    });

    it("filters by minConfidence", async () => {
      const result = (await sdk.trigger("mem::insight-list", { minConfidence: 0.5 })) as { insights: Insight[] };
      expect(result.insights.length).toBe(1);
    });
  });

  describe("mem::insight-search", () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      await kv.set("mem:insights", "ins_1", {
        id: "ins_1", title: "Defense in Depth", content: "Security requires layered protection",
        confidence: 0.85, reinforcements: 1, sourceConceptCluster: ["security"],
        sourceMemoryIds: [], sourceLessonIds: [], sourceCrystalIds: [],
        tags: ["security"], createdAt: now, updatedAt: now, decayRate: 0.05,
      });
    });

    it("finds insights matching query", async () => {
      const result = (await sdk.trigger("mem::insight-search", {
        query: "security layered protection",
      })) as { insights: Array<Insight & { score: number }> };

      expect(result.insights.length).toBe(1);
      expect(result.insights[0].title).toBe("Defense in Depth");
    });

    it("rejects empty query", async () => {
      const result = (await sdk.trigger("mem::insight-search", { query: "" })) as { success: boolean };
      expect(result.success).toBe(false);
    });
  });

  describe("mem::insight-decay-sweep", () => {
    it("decays old insights incrementally", async () => {
      await kv.set("mem:insights", "ins_old", {
        id: "ins_old", title: "Old", content: "Old insight", confidence: 0.8,
        reinforcements: 1, sourceConceptCluster: [], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], tags: [],
        createdAt: new Date(Date.now() - 21 * 86400000).toISOString(),
        updatedAt: new Date(Date.now() - 21 * 86400000).toISOString(),
        decayRate: 0.05,
      });

      const result = (await sdk.trigger("mem::insight-decay-sweep", {})) as { decayed: number };
      expect(result.decayed).toBe(1);

      const after = await kv.get<Insight>("mem:insights", "ins_old");
      expect(after!.confidence).toBeLessThan(0.8);
      expect(after!.lastDecayedAt).toBeDefined();
    });

    it("soft-deletes low-confidence unreinforced insights", async () => {
      await kv.set("mem:insights", "ins_weak", {
        id: "ins_weak", title: "Weak", content: "Weak insight", confidence: 0.12,
        reinforcements: 0, sourceConceptCluster: [], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], tags: [],
        createdAt: new Date(Date.now() - 21 * 86400000).toISOString(),
        updatedAt: new Date(Date.now() - 21 * 86400000).toISOString(),
        decayRate: 0.05,
      });

      const result = (await sdk.trigger("mem::insight-decay-sweep", {})) as { softDeleted: number };
      expect(result.softDeleted).toBe(1);

      const after = await kv.get<Insight>("mem:insights", "ins_weak");
      expect(after!.deleted).toBe(true);
    });
  });
});
