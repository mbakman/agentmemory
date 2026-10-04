import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInsightArgs, searchInsights } from "../src/cli/insights.js";

const insight = {
  id: "ins_1", title: "Boundary checks", content: "Validate incoming requests.",
  confidence: 0.8, score: 0.7, tags: ["validation"], sourceMemoryIds: ["private_1"],
};

afterEach(() => vi.unstubAllGlobals());

describe("insight CLI arguments", () => {
  it("defaults to ten results and preserves quoted multiword queries", () => {
    expect(parseInsightArgs(["boundary checks"])).toEqual({
      query: "boundary checks", limit: 10, json: false, deprecatedPool: false,
    });
  });

  it("supports native flags, compatibility max, and the deprecated pool", () => {
    expect(parseInsightArgs(["checks", "--limit=3", "--json"]).limit).toBe(3);
    expect(parseInsightArgs(["checks", "3", "3000", "--json"], true)).toEqual({
      query: "checks", limit: 3, json: true, deprecatedPool: true,
    });
    expect(parseInsightArgs(["--", "--query"], true).query).toBe("--query");
  });

  it.each([
    [], [" "], ["checks", "--limit"], ["checks", "--limit", "0"],
    ["checks", "--limit", "-1"], ["checks", "--limit", "2.5"],
    ["checks", "--limit", "3x"], ["checks", "--limit", "9007199254740992"],
    ["checks", "--limit=2", "--limit=3"], ["checks", "--unknown"],
    ["unquoted", "query"],
  ])("rejects invalid native arguments %j", (...args) => {
    expect(() => parseInsightArgs(args)).toThrow();
  });

  it("rejects ambiguous or invalid compatibility arguments", () => {
    expect(() => parseInsightArgs(["checks", "3", "--limit=2"], true)).toThrow();
    expect(() => parseInsightArgs(["checks", "3", "bad"], true)).toThrow();
  });
});

describe("native insight search client", () => {
  it("sends a bounded native search with auth and strips source IDs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      success: true, insights: [insight, { ...insight, id: "ins_2" }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchInsights(parseInsightArgs(["checks", "--limit=1"]), {
      AGENTMEMORY_URL: "https://memory.example/prefix/", AGENTMEMORY_SECRET: "test-secret",
    });
    expect(fetchMock.mock.calls[0][0].toString()).toBe("https://memory.example/prefix/agentmemory/insights/search");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST", headers: { Authorization: "Bearer test-secret" },
      body: JSON.stringify({ query: "checks", limit: 1 }),
    });
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty("sourceMemoryIds");
  });

  it("respects the port fallback and treats an explicit empty response as success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true, insights: [] }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await searchInsights(parseInsightArgs(["none"]), { III_REST_PORT: "3211" })).toEqual([]);
    expect(fetchMock.mock.calls[0][0].toString()).toBe("http://localhost:3211/agentmemory/insights/search");
  });

  it.each([401, 403, 500, 404])("classifies HTTP %i failures", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("failure", { status })));
    await expect(searchInsights(parseInsightArgs(["checks"]), {}))
      .rejects.toThrow(status === 401 || status === 403 ? "authentication failed" : "backend failure");
  });

  it.each([
    {}, { insights: [] }, { success: true }, { success: true, insights: null },
    { success: true, insights: [{}] },
    { success: true, insights: [{ ...insight, score: "bad" }] },
  ])("rejects malformed success payload %j", async (data) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(data)));
    await expect(searchInsights(parseInsightArgs(["checks"]), {})).rejects.toThrow("malformed response");
  });

  it("distinguishes non-JSON, backend rejection, and connection failure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("<html>error</html>"))
      .mockResolvedValueOnce(Response.json({ success: false, error: "failed" }))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    const options = parseInsightArgs(["checks"]);
    await expect(searchInsights(options, {})).rejects.toThrow("malformed response");
    await expect(searchInsights(options, {})).rejects.toThrow("backend failure");
    await expect(searchInsights(options, {})).rejects.toThrow("connection failed");
  });

  it("rejects invalid configuration before sending a request", async () => {
    const options = parseInsightArgs(["checks"]);
    await expect(searchInsights(options, { AGENTMEMORY_URL: "invalid" })).rejects.toThrow("configuration error");
    await expect(searchInsights(options, { AGENTMEMORY_URL: "https://user:secret@example.com" })).rejects.toThrow("configuration error");
    await expect(searchInsights(options, { AGENTMEMORY_INSIGHTS_TIMEOUT_MS: "0" })).rejects.toThrow("positive integer");
  });
});
