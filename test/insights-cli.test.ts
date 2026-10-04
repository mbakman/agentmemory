import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseInsightArgs, searchInsights, splitSearchTerms } from "../src/cli/insights.js";

const insight = {
  id: "ins_1", title: "Boundary checks", content: "Validate incoming requests.",
  confidence: 0.8, score: 0.7, tags: ["validation"], sourceMemoryIds: ["private_1"],
};

// A search that reaches fetch without its own stub fails here instead of contacting whatever
// listens on the default port.
beforeEach(() => vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected unstubbed fetch"))));
afterEach(() => vi.unstubAllGlobals());

const emptySearch = () => vi.fn().mockResolvedValue(Response.json({ success: true, insights: [] }));

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the search to fail");
}

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

describe("insight CLI limits and search terms", () => {
  it("caps the limit at 100 and leaves the deprecated pool uncapped", () => {
    expect(parseInsightArgs(["checks", "--limit", "100"]).limit).toBe(100);
    expect(parseInsightArgs(["checks", "100"], true).limit).toBe(100);
    expect(() => parseInsightArgs(["checks", "--limit=101"])).toThrow("limit must be a positive integer no greater than 100");
    expect(() => parseInsightArgs(["checks", "101"], true)).toThrow("max must be a positive integer no greater than 100");
    expect(parseInsightArgs(["checks", "5", "3000"], true)).toMatchObject({ limit: 5, deprecatedPool: true });
  });

  it("mirrors the server's one-character term filter", () => {
    expect(splitSearchTerms("A bc  d")).toEqual({ terms: ["bc"], ignored: ["A", "d"] });
    // Length counts UTF-16 units after lowercasing, as the server does: both of these are kept.
    expect(splitSearchTerms("İ").terms).toHaveLength(1);
    expect(splitSearchTerms("😀").terms).toHaveLength(1);
    expect(() => parseInsightArgs(["a"])).toThrow("no searchable terms");
    expect(() => parseInsightArgs(["a b"])).toThrow("no searchable terms");
    expect(() => parseInsightArgs(["x", "5"], true)).toThrow("no searchable terms");
    expect(parseInsightArgs(["a bc"]).query).toBe("a bc");
  });
});

describe("insight search endpoint and response handling", () => {
  it.each([
    "http://", "http:///", "https://", "http:", "ftp://memory.example", "file:///tmp/x",
    "http://user@memory.example", "http://:pw@memory.example", "http://memory.example/?x=1",
    "http://memory.example/#top", "http://memory.example/base?", "${AGENTMEMORY_URL}",
  ])("rejects invalid AGENTMEMORY_URL %j before fetching", async (url) => {
    const fetchMock = emptySearch();
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchInsights(parseInsightArgs(["checks"]), { AGENTMEMORY_URL: url }))
      .rejects.toThrow(/^configuration error: AGENTMEMORY_URL /);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["http://localhost:3111", "http://localhost:3111/agentmemory/insights/search"],
    ["http://localhost:3111///", "http://localhost:3111/agentmemory/insights/search"],
    ["https://memory.example/prefix", "https://memory.example/prefix/agentmemory/insights/search"],
    ["http://[::1]:3111/", "http://[::1]:3111/agentmemory/insights/search"],
    ["HTTP://Memory.Example:8080/a/b/", "http://memory.example:8080/a/b/agentmemory/insights/search"],
  ])("joins the search path onto base %s", async (base, expected) => {
    const fetchMock = emptySearch();
    vi.stubGlobal("fetch", fetchMock);
    await searchInsights(parseInsightArgs(["checks"]), { AGENTMEMORY_URL: base });
    expect(fetchMock.mock.calls[0][0].toString()).toBe(expected);
  });

  it.each([["abc", 3111], ["3211abc", 3211], ["0", 3111]])(
    "mirrors the daemon's III_REST_PORT parsing for %j", async (port, expected) => {
      const fetchMock = emptySearch();
      vi.stubGlobal("fetch", fetchMock);
      await searchInsights(parseInsightArgs(["checks"]), { III_REST_PORT: port });
      expect(fetchMock.mock.calls[0][0].toString()).toBe(`http://localhost:${expected}/agentmemory/insights/search`);
    });

  it.each(["70000", "-1", "99999999999999999999"])("names III_REST_PORT when %j is unusable", async (port) => {
    const fetchMock = emptySearch();
    vi.stubGlobal("fetch", fetchMock);
    const message = await failure(searchInsights(parseInsightArgs(["checks"]), { III_REST_PORT: port }));
    expect(message).toMatch(/^configuration error: III_REST_PORT /);
    expect(message).not.toContain("AGENTMEMORY_URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores III_REST_PORT when AGENTMEMORY_URL is set", async () => {
    const fetchMock = emptySearch();
    vi.stubGlobal("fetch", fetchMock);
    await searchInsights(parseInsightArgs(["checks"]), { AGENTMEMORY_URL: "http://127.0.0.1:4000", III_REST_PORT: "70000" });
    expect(fetchMock.mock.calls[0][0].toString()).toBe("http://127.0.0.1:4000/agentmemory/insights/search");
  });

  it.each(["2147483648", "4294967296", "1.5", "-5", "abc"])(
    "rejects AGENTMEMORY_INSIGHTS_TIMEOUT_MS=%j before fetching", async (timeout) => {
      const fetchMock = emptySearch();
      vi.stubGlobal("fetch", fetchMock);
      await expect(searchInsights(parseInsightArgs(["checks"]), { AGENTMEMORY_INSIGHTS_TIMEOUT_MS: timeout }))
        .rejects.toThrow("configuration error: AGENTMEMORY_INSIGHTS_TIMEOUT_MS must be a positive integer no greater than 2147483647 (milliseconds)");
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it("accepts the largest timer-safe timeout without aborting early", async () => {
    const fetchMock = emptySearch();
    vi.stubGlobal("fetch", fetchMock);
    await searchInsights(parseInsightArgs(["checks"]), { AGENTMEMORY_INSIGHTS_TIMEOUT_MS: "2147483647" });
    await new Promise((done) => setTimeout(done, 20));
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(false);
  });

  it("classifies an interrupted body as a connection failure", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('{"success":true,"insights":['));
        else controller.error(new TypeError("terminated", { cause: { code: "UND_ERR_RES_CONTENT_LENGTH_MISMATCH" } }));
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    const message = await failure(searchInsights(parseInsightArgs(["checks"]), {}));
    // Pins the classification and the undici code, not how the endpoint is named.
    expect(message).toMatch(/^connection failed: the response from .+ ended before it was complete \(UND_ERR_RES_CONTENT_LENGTH_MISMATCH\)$/);
  });

  it("cancels an unread error body so a stalled response cannot hold the process open", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ pull() {}, cancel }), { status: 503 })));
    await expect(searchInsights(parseInsightArgs(["checks"]), {})).rejects.toThrow("backend failure: HTTP 503");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("names the malformed record and ignores records past the limit", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, insights: [insight, { ...insight, id: "ins_bad", score: "bad", tags: [1] }] }))
      .mockResolvedValueOnce(Response.json({ success: true, insights: [insight, null] }))
      .mockResolvedValueOnce(Response.json({ success: true, insights: [insight, null] })));
    const options = parseInsightArgs(["checks"]);
    expect(await failure(searchInsights(options, {})))
      .toBe('malformed response: insights[1] (id "ins_bad") has invalid or missing field(s): score, tags');
    expect(await failure(searchInsights(options, {}))).toBe("malformed response: insights[1] is not an object");
    // Records past the limit are never shown, so they cannot fail the search.
    await expect(searchInsights(parseInsightArgs(["checks", "--limit=1"]), {})).resolves.toBeTruthy();
  });
});

describe("insight CLI diagnostics", () => {
  const remote = { AGENTMEMORY_URL: "http://127.0.0.1:4555/prefix" };

  it("names the origin and error code when the endpoint cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }))
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: new Error("bad port") })));
    const options = parseInsightArgs(["checks"]);
    expect(await failure(searchInsights(options, remote))).toBe(
      "connection failed: could not reach http://127.0.0.1:4555 (ECONNREFUSED); check AGENTMEMORY_URL and that the agentmemory daemon is running",
    );
    // Without a code there is nothing to add.
    expect(await failure(searchInsights(options, remote))).toBe(
      "connection failed: could not reach http://127.0.0.1:4555; check AGENTMEMORY_URL and that the agentmemory daemon is running",
    );
  });

  it("names the origin when the response ends early or the timeout fires", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('{"success":true,"insights":['));
        else controller.error(new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } }));
      },
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(body))
      .mockImplementationOnce((_url: URL, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      })));
    const options = parseInsightArgs(["checks"]);
    expect(await failure(searchInsights(options, remote))).toBe(
      "connection failed: the response from http://127.0.0.1:4555 ended before it was complete (UND_ERR_SOCKET)",
    );
    expect(await failure(searchInsights(options, { ...remote, AGENTMEMORY_INSIGHTS_TIMEOUT_MS: "20" }))).toBe(
      "timeout: no complete response from http://127.0.0.1:4555 within 20 ms; check the daemon or raise AGENTMEMORY_INSIGHTS_TIMEOUT_MS",
    );
  });

  it.each(["a\nb", "😀", "fixture-secret\nsecond-line"])(
    "maps the unsendable AGENTMEMORY_SECRET %j to a configuration error that never echoes it", async (secret) => {
      const fetchMock = emptySearch();
      vi.stubGlobal("fetch", fetchMock);
      const message = await failure(searchInsights(parseInsightArgs(["checks"]), { AGENTMEMORY_SECRET: secret }));
      expect(message).toBe(
        "configuration error: AGENTMEMORY_SECRET cannot be sent in an HTTP Authorization header; remove line breaks, NUL characters, and characters above U+00FF",
      );
      expect(message).not.toContain(secret);
      expect(message).not.toContain("Bearer");
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it("still sends a secret that fetch can send", async () => {
    const fetchMock = emptySearch();
    vi.stubGlobal("fetch", fetchMock);
    // fetch trims surrounding whitespace from header values, so a trailing newline is sendable.
    await searchInsights(parseInsightArgs(["checks"]), { AGENTMEMORY_SECRET: "test-secret\n" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hints at quoting when a compatibility max or pool is a word", () => {
    expect(() => parseInsightArgs(["database", "performance"], true))
      .toThrow("max must be a positive integer no greater than 100 (quote multi-word queries)");
    expect(() => parseInsightArgs(["db", "5", "tuning"], true))
      .toThrow("pool must be a positive integer (quote multi-word queries)");
    // The word is the likelier mistake, so it is reported instead of the max/--limit conflict.
    expect(() => parseInsightArgs(["database", "performance", "--limit=2"], true))
      .toThrow("(quote multi-word queries)");
    // Numbers that are out of range get no hint.
    expect(() => parseInsightArgs(["db", "0"], true)).toThrow(/^max must be a positive integer no greater than 100$/);
    expect(() => parseInsightArgs(["db", "101"], true)).toThrow(/^max must be a positive integer no greater than 100$/);
    expect(() => parseInsightArgs(["db", "5", "0"], true)).toThrow(/^pool must be a positive integer$/);
    expect(() => parseInsightArgs(["db", "3", "--limit=2"], true)).toThrow(/^use either max or --limit, not both$/);
  });
});
