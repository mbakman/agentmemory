import { hydrateProcessEnvFromFile } from "../config.js";

export interface InsightSearchOptions {
  query: string;
  limit: number;
  json: boolean;
  deprecatedPool: boolean;
}

export interface CompactInsight {
  id: string;
  title: string;
  content: string;
  confidence: number;
  score: number;
  tags: string[];
}

export const DEFAULT_INSIGHT_LIMIT = 10;
export const MAX_INSIGHT_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
// Node's timer ceiling: above it AbortSignal.timeout() fires after 1 ms, and from 2^32 it throws.
const MAX_TIMEOUT_MS = 2_147_483_647;
const SEARCH_PATH = "/agentmemory/insights/search";

export const INSIGHTS_HELP = `Usage: agentmemory insights <query> [--limit N] [--json]
       agentmemory-insights <query> [max] [--json]

Search synthesized insights by title, content, and tags using the server's
relevance/confidence/recency ranking. Defaults to ten results.
The obsolete third positional pool argument is accepted but ignored.

Configuration: AGENTMEMORY_URL, III_REST_PORT, AGENTMEMORY_SECRET,
and ~/.agentmemory/.env. AGENTMEMORY_INSIGHTS_TIMEOUT_MS defaults to 10000.
Exit status: 0 for results or an empty search; 1 for failures; 2 for invalid usage.
`;

/** JSON string quoting that also escapes DEL and C1 controls, which JSON.stringify leaves raw. */
function quote(text: string): string {
  return JSON.stringify(text).replace(
    /[\x7f-\x9f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** The first Node-style code (EPIPE, UND_ERR_SOCKET, ...) on an error or its cause chain. */
function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function codeSuffix(error: unknown): string {
  const code = errorCode(error);
  return code ? ` (${code})` : "";
}

function configError(detail: string): Error {
  return new Error(`configuration error: ${detail}`);
}

function positiveInteger(value: string, label: string, max?: number): number {
  const parsed = Number(value);
  if (
    !/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1 ||
    (max !== undefined && parsed > max)
  ) {
    throw new Error(max === undefined
      ? `${label} must be a positive integer`
      : `${label} must be a positive integer no greater than ${max}`);
  }
  return parsed;
}

/**
 * Mirrors the mem::insight-search tokenizer (src/functions/reflect.ts:372,385): lowercase, split on
 * whitespace, and keep terms longer than one UTF-16 unit. `ignored` holds the dropped tokens as typed.
 */
export function splitSearchTerms(query: string): { terms: string[]; ignored: string[] } {
  const terms: string[] = [];
  const ignored: string[] = [];
  for (const token of query.split(/\s+/)) {
    if (!token) continue;
    const lower = token.toLowerCase();
    if (lower.length > 1) terms.push(lower);
    else ignored.push(token);
  }
  return { terms, ignored };
}

export function parseInsightArgs(
  args: string[],
  compatibility = false,
): InsightSearchOptions {
  const positional: string[] = [];
  let limit: number | undefined;
  let json = false;
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
    } else if (!optionsEnded && arg === "--json") {
      json = true;
    } else if (!optionsEnded && (arg === "--limit" || arg.startsWith("--limit="))) {
      if (limit !== undefined) throw new Error("--limit may only be supplied once");
      const value = arg === "--limit" ? args[++i] : arg.slice(8);
      limit = positiveInteger(value ?? "", "limit", MAX_INSIGHT_LIMIT);
    } else if (!optionsEnded && arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const query = positional[0]?.trim();
  if (!query) throw new Error("query is required");
  if (positional.length > (compatibility ? 3 : 1)) {
    throw new Error("quote queries containing spaces; too many positional arguments");
  }
  if (positional[1] !== undefined) {
    if (limit !== undefined) throw new Error("use either max or --limit, not both");
    limit = positiveInteger(positional[1], "max", MAX_INSIGHT_LIMIT);
  }
  // The pool is ignored, so it stays uncapped: existing scripts pass values such as 3000.
  if (positional[2] !== undefined) positiveInteger(positional[2], "pool");
  // Checked last so shape errors are reported first. The server drops one-character terms, so a
  // query made only of them would come back as a successful empty search that never matched anything.
  if (splitSearchTerms(query).terms.length === 0) {
    throw new Error("query has no searchable terms: the server ignores one-character terms; use a term of 2 or more characters (one distinctive term of 4 or more characters works best)");
  }
  return { query, limit: limit ?? DEFAULT_INSIGHT_LIMIT, json, deprecatedPool: positional[2] !== undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function compactInsight(value: unknown, index: number): CompactInsight {
  if (!isRecord(value)) throw new Error(`malformed response: insights[${index}] is not an object`);
  const { id, title, content, confidence, score, tags } = value;
  const invalid: string[] = [];
  if (typeof id !== "string") invalid.push("id");
  if (typeof title !== "string") invalid.push("title");
  if (typeof content !== "string") invalid.push("content");
  if (!isFiniteNumber(confidence)) invalid.push("confidence");
  if (!isFiniteNumber(score)) invalid.push("score");
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) invalid.push("tags");
  if (invalid.length > 0) {
    const named = typeof id === "string" ? ` (id ${quote(id.slice(0, 80))})` : "";
    throw new Error(`malformed response: insights[${index}]${named} has invalid or missing field(s): ${invalid.join(", ")}`);
  }
  return {
    id: id as string,
    title: title as string,
    content: content as string,
    confidence: confidence as number,
    score: score as number,
    tags: tags as string[],
  };
}

function resolveSearchEndpoint(env: NodeJS.ProcessEnv): URL {
  let base: URL;
  if (env.AGENTMEMORY_URL) {
    // The base is validated before the path is joined, and messages never echo the URL, which may
    // carry credentials.
    try {
      base = new URL(env.AGENTMEMORY_URL);
    } catch {
      throw configError("AGENTMEMORY_URL is not a valid URL; expected an http(s) base URL such as http://localhost:3111");
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw configError("AGENTMEMORY_URL must use http or https");
    }
    if (!base.hostname) throw configError("AGENTMEMORY_URL must include a host name");
    if (base.username || base.password) {
      throw configError("AGENTMEMORY_URL must not contain credentials; set AGENTMEMORY_SECRET instead");
    }
    // `search` and `hash` read as "" for a bare "?" or "#", so check the serialized form.
    if (/[?#]/.test(base.href)) {
      throw configError("AGENTMEMORY_URL must not contain a query string or fragment");
    }
  } else {
    // Parse the port the way the daemon does (src/config.ts:197) so the CLI targets the port it bound.
    const port = Number.parseInt(env.III_REST_PORT || "3111", 10) || 3111;
    if (port < 1 || port > 65535) {
      throw configError(`III_REST_PORT must be a port number from 1 to 65535 (got ${quote(env.III_REST_PORT ?? "")})`);
    }
    base = new URL(`http://localhost:${port}`);
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}${SEARCH_PATH}`;
  return base;
}

function resolveTimeout(env: NodeJS.ProcessEnv): number {
  try {
    return positiveInteger(
      env.AGENTMEMORY_INSIGHTS_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS),
      "AGENTMEMORY_INSIGHTS_TIMEOUT_MS",
      MAX_TIMEOUT_MS,
    );
  } catch (error) {
    throw configError(`${(error as Error).message} (milliseconds)`);
  }
}

export async function searchInsights(
  options: InsightSearchOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CompactInsight[]> {
  const endpoint = resolveSearchEndpoint(env);
  const timeout = resolveTimeout(env);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.AGENTMEMORY_SECRET) headers.Authorization = `Bearer ${env.AGENTMEMORY_SECRET}`;
  // parseInsightArgs enforces the cap; this keeps direct callers within it too.
  const body = JSON.stringify({ query: options.query, limit: Math.min(options.limit, MAX_INSIGHT_LIMIT) });
  // Created after every configuration check, so the whole budget goes to the request itself.
  const signal = AbortSignal.timeout(timeout);
  let response: Response;
  try {
    response = await fetch(endpoint, { method: "POST", headers, body, signal });
  } catch {
    if (signal.aborted) throw new Error(`timeout: insight search exceeded ${timeout} ms`);
    throw new Error("connection failed: could not reach the agentmemory search endpoint; check AGENTMEMORY_URL and the running daemon");
  }
  if (!response.ok) {
    // An unread body keeps the connection open, and with it a process that exits naturally,
    // until the timeout fires.
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      throw new Error(`authentication failed (HTTP ${response.status}): set AGENTMEMORY_SECRET to match the server`);
    }
    throw new Error(`backend failure: HTTP ${response.status}`);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (signal.aborted) throw new Error(`timeout: insight search exceeded ${timeout} ms`);
    throw new Error(`connection failed: the response from the insight search endpoint ended before it was complete${codeSuffix(error)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("malformed response: expected JSON from the insight search endpoint");
  }
  if (isRecord(data) && data.success === false) {
    throw new Error("backend failure: server reported success=false");
  }
  if (!isRecord(data) || data.success !== true || !Array.isArray(data.insights)) {
    throw new Error("malformed response: expected success=true and an insights array");
  }
  // Slice before validating: records past the limit are never shown, so they cannot fail the search.
  return data.insights.slice(0, options.limit).map(compactInsight);
}

// A reader that stops early (`| head -n 1`) closes the pipe: EPIPE, or ECONNRESET on a Linux
// socket. That is the reader's choice, not a failure, so the command still exits 0.
const READER_GONE = new Set(["EPIPE", "ECONNRESET"]);
let stdoutGone = false;
let stderrGone = false;
let guardsInstalled = false;

function installOutputGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;
  // A failed stdio write reports the error to its callback and then emits 'error', which crashes
  // the process when nothing listens. The stream is not destroyed, so later writes are attempted
  // and fail again. Permanent no-op listeners make the events harmless; writeOutput's callbacks
  // classify each failure.
  process.stdout.on("error", () => undefined);
  process.stderr.on("error", () => undefined);
}

async function writeOutput(text: string, toStderr = false): Promise<void> {
  if (toStderr ? stderrGone : stdoutGone) return;
  const stream = toStderr ? process.stderr : process.stdout;
  await new Promise<void>((resolve, reject) => {
    stream.write(text, (error) => {
      if (!error) return resolve();
      if (toStderr) {
        // Nowhere is left to report it; keep the exit status already decided.
        stderrGone = true;
        return resolve();
      }
      const code = errorCode(error);
      if (code && READER_GONE.has(code)) {
        stdoutGone = true;
        return resolve();
      }
      reject(new Error(`output failed: could not write to stdout (${code ?? error.message})`));
    });
  });
}

export async function runInsightsCli(args: string[], compatibility = false): Promise<number> {
  installOutputGuards();
  const prefix = "agentmemory insights";
  try {
    if (args[0] === "--help" || args[0] === "-h") {
      await writeOutput(INSIGHTS_HELP);
      return 0;
    }
    let options: InsightSearchOptions;
    try {
      options = parseInsightArgs(args, compatibility);
    } catch (error) {
      await writeOutput(`${prefix}: ${(error as Error).message}\n${INSIGHTS_HELP}`, true);
      return 2;
    }
    if (options.deprecatedPool) {
      await writeOutput("agentmemory-insights: the pool argument is deprecated and ignored; native search searches the full eligible corpus\n", true);
    }
    const { ignored } = splitSearchTerms(options.query);
    if (ignored.length > 0) {
      await writeOutput(`${prefix}: note: ignoring one-character term(s) ${ignored.map(quote).join(", ")}; the server searches only terms of 2 or more characters\n`, true);
    }
    hydrateProcessEnvFromFile();
    const insights = await searchInsights(options);
    if (options.json) {
      await writeOutput(`${JSON.stringify({ success: true, query: options.query, limit: options.limit, insights })}\n`);
    } else if (insights.length === 0) {
      await writeOutput(`No insights match ${JSON.stringify(options.query)}.\n`);
    } else {
      await writeOutput(`Showing ${insights.length} insight(s) for ${JSON.stringify(options.query)} (limit ${options.limit}, ranked by relevance/confidence/recency).\n\n`);
      for (const insight of insights) {
        await writeOutput(`[${insight.confidence.toFixed(2)}; score ${insight.score.toFixed(3)}] ${insight.title}\n${insight.content}\n\n`);
      }
    }
    return 0;
  } catch (error) {
    await writeOutput(`${prefix}: ${(error as Error).message}\n`, true);
    return 1;
  }
}
