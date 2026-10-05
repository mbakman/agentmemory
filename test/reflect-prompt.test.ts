import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReflectPrompt } from "../src/prompts/reflect.js";

function largeCluster() {
  return {
    concepts: ["alpha", "bravo"],
    facts: Array.from({ length: 30 }, (_, i) => ({
      fact: `${String(i).padStart(2, "0")}${"f".repeat(798)}`,
      confidence: 0.9,
    })),
    lessons: [],
    crystalNarratives: [],
  };
}

describe("reflect prompt budget", () => {
  beforeEach(() => {
    vi.stubEnv("AGENTMEMORY_REFLECT_PROMPT_CHARS", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses a 12000-character default and keeps complete fact lines", () => {
    const cluster = largeCluster();
    const prompt = buildReflectPrompt(cluster);
    const lines = prompt.split("\n").filter((line) => line.startsWith("- "));
    expect(prompt.length).toBeLessThanOrEqual(12000);
    expect(lines).toHaveLength(14);
    expect(lines).toEqual(cluster.facts.slice(0, 14).map((fact) => `- [confidence=0.9] ${fact.fact}`));
    expect(prompt.endsWith(lines[13])).toBe(true);
  });

  it.each(["", "invalid", "0", "-1", "Infinity"])("uses the default for invalid setting %s", (setting) => {
    const defaultPrompt = buildReflectPrompt(largeCluster());
    vi.stubEnv("AGENTMEMORY_REFLECT_PROMPT_CHARS", setting);
    expect(buildReflectPrompt(largeCluster())).toBe(defaultPrompt);
  });

  it.each(["1", "1999", "2000"])("applies the 2000-character minimum for setting %s", (setting) => {
    vi.stubEnv("AGENTMEMORY_REFLECT_PROMPT_CHARS", setting);
    const prompt = buildReflectPrompt(largeCluster());
    expect(prompt.length).toBeLessThanOrEqual(2000);
    expect(prompt.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(2);
  });

  it("uses a larger custom budget", () => {
    vi.stubEnv("AGENTMEMORY_REFLECT_PROMPT_CHARS", "4000");
    const prompt = buildReflectPrompt(largeCluster());
    expect(prompt.length).toBeLessThanOrEqual(4000);
    expect(prompt.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(4);
  });

  it("preserves parseInt handling of a numeric prefix", () => {
    vi.stubEnv("AGENTMEMORY_REFLECT_PROMPT_CHARS", "4000suffix");
    const prefixed = buildReflectPrompt(largeCluster());
    vi.stubEnv("AGENTMEMORY_REFLECT_PROMPT_CHARS", "4000");
    expect(buildReflectPrompt(largeCluster())).toBe(prefixed);
  });

  it("truncates all record types at 800 characters and adds an ellipsis", () => {
    const prompt = buildReflectPrompt({
      concepts: ["alpha"],
      facts: [{ fact: "f".repeat(801), confidence: 0.9 }],
      lessons: [{ content: "l".repeat(801), confidence: 0.8 }],
      crystalNarratives: ["c".repeat(801)],
    });
    expect(prompt).toContain(`- [confidence=0.9] ${"f".repeat(800)}…`);
    expect(prompt).toContain(`- [confidence=0.8] ${"l".repeat(800)}…`);
    expect(prompt).toContain(`- ${"c".repeat(800)}…`);
    expect(prompt).not.toContain("f".repeat(801));
    expect(prompt).not.toContain("l".repeat(801));
    expect(prompt).not.toContain("c".repeat(801));
  });

  it("does not truncate an item at exactly 800 characters", () => {
    const prompt = buildReflectPrompt({
      concepts: ["alpha"], facts: [{ fact: "f".repeat(800), confidence: 0.5 }],
      lessons: [], crystalNarratives: [],
    });
    expect(prompt).toContain("f".repeat(800));
    expect(prompt).not.toContain("…");
  });

  it("orders facts and lessons by confidence without changing the input arrays", () => {
    const cluster = {
      concepts: ["alpha", "bravo"],
      facts: [{ fact: "weak fact", confidence: 0.1 }, { fact: "strong fact", confidence: 0.9 }],
      lessons: [{ content: "weak lesson", confidence: 0.2 }, { content: "strong lesson", confidence: 0.8 }],
      crystalNarratives: ["second newest", "newest"],
    };
    const original = structuredClone(cluster);
    const prompt = buildReflectPrompt(cluster);
    expect(prompt.indexOf("strong fact")).toBeLessThan(prompt.indexOf("weak fact"));
    expect(prompt.indexOf("strong lesson")).toBeLessThan(prompt.indexOf("weak lesson"));
    expect(prompt.indexOf("second newest")).toBeLessThan(prompt.indexOf("\n- newest"));
    expect(cluster).toEqual(original);
  });

  it("stops a section at the first line that does not fit and permits later sections", () => {
    vi.stubEnv("AGENTMEMORY_REFLECT_PROMPT_CHARS", "2000");
    const prompt = buildReflectPrompt({
      concepts: ["alpha"],
      facts: [
        { fact: "a".repeat(800), confidence: 0.9 },
        { fact: "b".repeat(800), confidence: 0.8 },
        { fact: "c".repeat(800), confidence: 0.7 },
        { fact: "short fact after blocked line", confidence: 0.6 },
      ],
      lessons: [{ content: "short lesson fits", confidence: 0.9 }],
      crystalNarratives: ["short summary fits"],
    });
    expect(prompt).toContain("a".repeat(800));
    expect(prompt).toContain("b".repeat(800));
    expect(prompt).not.toContain("c".repeat(800));
    expect(prompt).not.toContain("short fact after blocked line");
    expect(prompt).toContain("short lesson fits");
    expect(prompt).toContain("short summary fits");
    expect(prompt.length).toBeLessThanOrEqual(2000);
  });

  it("keeps the complete concept header even when it exceeds the budget", () => {
    vi.stubEnv("AGENTMEMORY_REFLECT_PROMPT_CHARS", "2000");
    const concepts = ["concept".repeat(500)];
    const prompt = buildReflectPrompt({
      concepts, facts: [{ fact: "omitted", confidence: 1 }],
      lessons: [{ content: "omitted", confidence: 1 }], crystalNarratives: ["omitted"],
    });
    expect(prompt.length).toBeGreaterThan(2000);
    expect(prompt.endsWith(`## Concept Cluster: ${concepts[0]}`)).toBe(true);
    expect(prompt).not.toContain("## Known Facts");
    expect(prompt).not.toContain("## Lessons Learned");
    expect(prompt).not.toContain("## Completed Work Summaries");
  });

  it("omits empty sections", () => {
    const prompt = buildReflectPrompt({ concepts: [], facts: [], lessons: [], crystalNarratives: [] });
    expect(prompt).toBe("Synthesize higher-order insights from this cluster of related memories:\n\n## Concept Cluster: ");
  });

  it("converts non-string record text with the archive fallback", () => {
    const prompt = buildReflectPrompt({
      concepts: ["alpha"], facts: [{ fact: 42, confidence: 0.5 }],
      lessons: [{ content: null, confidence: 0.5 }], crystalNarratives: [false],
    } as never);
    expect(prompt).toContain("- [confidence=0.5] 42");
    expect(prompt).toContain("\n- [confidence=0.5] \n");
    expect(prompt).toContain("- false");
  });
});
