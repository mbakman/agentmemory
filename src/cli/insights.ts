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
  createdAt: string | null;
  lastReinforcedAt: string | null;
}

export interface InsightSearchResult {
  insights: CompactInsight[];
  /** More insights matched than the limit allowed. */
  truncated: boolean;
}

export const DEFAULT_INSIGHT_LIMIT = 10;
export const MAX_INSIGHT_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
// Node's timer ceiling: above it AbortSignal.timeout() fires after 1 ms, and from 2^32 it throws.
const MAX_TIMEOUT_MS = 2_147_483_647;
const SEARCH_PATH = "/agentmemory/insights/search";

// Agent docs probe for the subcommand with grep '^Usage: agentmemory insights', so the first line
// must not change.
const USAGE_LINES = `Usage: agentmemory insights <query> [--limit N] [--json]
       agentmemory-insights <query> [max] [--json]`;

/** Follows a usage error in place of the full help. */
export const INSIGHTS_USAGE = `${USAGE_LINES}
Run with --help for matching rules, limits, configuration, and exit codes.
`;

export const INSIGHTS_HELP = `${USAGE_LINES}

Search the synthesized insights stored by a running agentmemory server. The
command only sends one search request; it never starts the server.

How the server matches a query:
  - It lowercases the query and splits it on whitespace into terms. Quotes
    only keep words together for the shell; they do not make a phrase.
  - It ignores one-character terms. A query with no term of two or more
    characters is rejected with exit status 2.
  - Each term is a case-insensitive substring match against an insight's
    title, content, and tags. An insight matching any term is returned;
    matching more of the terms ranks it higher.
  - Insights below 0.1 confidence are never returned.
  - One distinctive term of four or more characters gives the most focused
    results.

Ranking: confidence x share of terms matched x recency.
When more insights match than the limit, text output says so and JSON sets
"truncated": true.

Options:
  --limit N    Number of results, 1 to 100 (default 10).
               agentmemory-insights also accepts N as a positional max.
  --json       Print compact JSON instead of text.
  --help, -h   Show this help.
  --           Stop option parsing, so a query may start with "-".
agentmemory-insights accepts and ignores an obsolete third pool argument.

Configuration: AGENTMEMORY_URL (http or https base URL, optionally with a
path prefix), III_REST_PORT (used when AGENTMEMORY_URL is unset; default
3111), AGENTMEMORY_SECRET, and AGENTMEMORY_INSIGHTS_TIMEOUT_MS (total
request timeout in milliseconds, 1 to 2147483647, default 10000). Values
may also come from ~/.agentmemory/.env.

Exit status:
  0  results printed, no insight matched, or the reader closed the output
     early (for example, piping into head)
  1  configuration, connection, timeout, authentication, backend,
     malformed-response, or output failure (details on stderr)
  2  invalid usage
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

// Text output only (JSON stays raw): server-supplied text must not reach the terminal as control
// sequences.

/** Turns CR and CRLF into \n, then drops C0 and C1 controls other than tab and \n. */
function printable(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

const LINE_BREAK = /[\n\u{2028}\u{2029}]/u;

/**
 * printable, then every whitespace run that holds a line break (\n, U+2028, U+2029) becomes one
 * space. Matching whole runs keeps this linear: matching optional whitespace on both sides of a
 * break instead backtracks quadratically on a long run without one.
 */
function printableLine(text: string): string {
  return printable(text).replace(/\s+/g, (run) => (LINE_BREAK.test(run) ? " " : run)).trim();
}

// A plain ISO-8601 date, or a date-time with an explicit zone. Date.parse reads other forms (a
// date-time without a zone, "Sep 1 2026", "1") as local time or by engine-specific rules, so the date
// printed would depend on the machine.
const ZONED_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** A timestamp as a UTC YYYY-MM-DD date, or undefined when it is missing, in another form, or does not parse. */
function isoDate(timestamp: string | null): string | undefined {
  if (timestamp === null || !ZONED_ISO_TIMESTAMP.test(timestamp)) return undefined;
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return undefined;
  const date = new Date(time).toISOString().slice(0, 10);
  // Years outside 0000-9999 serialize with a sign and six digits.
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

/** "[0.90; score 0.829; created 2026-09-01; reinforced 2026-09-30]", leaving out dates isoDate rejects. */
function resultBracket(insight: CompactInsight): string {
  const fields = [insight.confidence.toFixed(2), `score ${insight.score.toFixed(3)}`];
  const created = isoDate(insight.createdAt);
  if (created) fields.push(`created ${created}`);
  const reinforced = isoDate(insight.lastReinforcedAt);
  if (reinforced) fields.push(`reinforced ${reinforced}`);
  return `[${fields.join("; ")}]`;
}

function truncationFooter(limit: number, compatibility: boolean): string {
  if (limit >= MAX_INSIGHT_LIMIT) {
    return `More insights match than the maximum of ${MAX_INSIGHT_LIMIT} results; use a more distinctive term.`;
  }
  return `More insights match. Raise ${compatibility ? "max" : "--limit"} (maximum ${MAX_INSIGHT_LIMIT}) or use a more distinctive term.`;
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
 * The compatibility form's max and pool. Anything but a plain decimal number in their place is usually
 * the rest of an unquoted multi-word query, so its error says so.
 */
function compatNumber(value: string, label: string, max?: number): number {
  try {
    return positiveInteger(value, label, max);
  } catch (error) {
    // Not Number(value): it also reads "0x1f", "1e3" and "Infinity" as numbers.
    if (/^[+-]?\d+(\.\d+)?$/.test(value)) throw error;
    throw new Error(`${(error as Error).message} (quote multi-word queries)`);
  }
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
  // Only the compatibility form reaches here with a max or pool. Both values are checked before the
  // max/--limit conflict, so a stray query word is reported as one.
  const max = positional[1] === undefined ? undefined : compatNumber(positional[1], "max", MAX_INSIGHT_LIMIT);
  // The pool is ignored, so it stays uncapped: existing scripts pass values such as 3000.
  if (positional[2] !== undefined) compatNumber(positional[2], "pool");
  if (max !== undefined) {
    if (limit !== undefined) throw new Error("use either max or --limit, not both");
    limit = max;
  }
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
    // Timestamps only annotate results, so one that is not a string becomes null instead of failing
    // the search.
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    lastReinforcedAt: typeof value.lastReinforcedAt === "string" ? value.lastReinforcedAt : null,
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

// Anything but tab, printable ASCII and U+0080-U+00FF: C0 controls other than tab, DEL, and code points
// above U+00FF. new Headers() accepts ESC, DEL and most other controls, but fetch then fails while
// sending the request, which would read as a connection failure.
const UNSENDABLE_HEADER_CHARACTER = /[^\t\x20-\x7e\x80-\xff]/;
const UNSENDABLE_SECRET = "AGENTMEMORY_SECRET cannot be sent in an HTTP Authorization header; remove control characters and characters above U+00FF";

/** Plain-object headers for fetch, checked up front so an unsendable secret is a configuration error. */
function requestHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = env.AGENTMEMORY_SECRET;
  if (!secret) return headers;
  if (UNSENDABLE_HEADER_CHARACTER.test(secret)) throw configError(UNSENDABLE_SECRET);
  headers.Authorization = `Bearer ${secret}`;
  // A second line of defense. The TypeError's message quotes the header value, secret included, so it
  // is neither shown nor chained.
  try {
    new Headers(headers);
  } catch {
    throw configError(UNSENDABLE_SECRET);
  }
  return headers;
}

export async function searchInsights(
  options: InsightSearchOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InsightSearchResult> {
  const endpoint = resolveSearchEndpoint(env);
  const timeout = resolveTimeout(env);
  const headers = requestHeaders(env);
  // parseInsightArgs enforces the cap; this keeps direct callers within it too.
  const limit = Math.min(options.limit, MAX_INSIGHT_LIMIT);
  // One record past the limit reveals whether more insights match; it is never returned.
  const body = JSON.stringify({ query: options.query, limit: limit + 1 });
  // Failures name the origin, never the path or the rest of the configured URL.
  const { origin } = endpoint;
  const timedOut = (error: unknown) => new Error(
    `timeout: no complete response from ${origin} within ${timeout} ms${codeSuffix(error)}; check the daemon or raise AGENTMEMORY_INSIGHTS_TIMEOUT_MS`,
  );
  // Created after every configuration check, so the whole budget goes to the request itself.
  const signal = AbortSignal.timeout(timeout);
  let response: Response;
  try {
    response = await fetch(endpoint, { method: "POST", headers, body, signal });
  } catch (error) {
    if (signal.aborted) throw timedOut(error);
    throw new Error(`connection failed: could not reach ${origin}${codeSuffix(error)}; check AGENTMEMORY_URL and that the agentmemory daemon is running`);
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
    if (signal.aborted) throw timedOut(error);
    throw new Error(`connection failed: the response from ${origin} ended before it was complete${codeSuffix(error)}`);
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
  return { insights: data.insights.slice(0, limit).map(compactInsight), truncated: data.insights.length > limit };
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

/** --help or -h anywhere before "--" asks for help; after "--" they are query text. */
function wantsHelp(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

export async function runInsightsCli(args: string[], compatibility = false): Promise<number> {
  installOutputGuards();
  // Usage errors, notices, and failures name the command as it was invoked.
  const prefix = compatibility ? "agentmemory-insights" : "agentmemory insights";
  try {
    if (wantsHelp(args)) {
      await writeOutput(INSIGHTS_HELP);
      return 0;
    }
    let options: InsightSearchOptions;
    try {
      options = parseInsightArgs(args, compatibility);
    } catch (error) {
      await writeOutput(`${prefix}: ${(error as Error).message}\n${INSIGHTS_USAGE}`, true);
      return 2;
    }
    if (options.deprecatedPool) {
      await writeOutput(`${prefix}: the pool argument is deprecated and ignored; native search searches the full eligible corpus\n`, true);
    }
    const { ignored } = splitSearchTerms(options.query);
    if (ignored.length > 0) {
      await writeOutput(`${prefix}: note: ignoring one-character term(s) ${ignored.map(quote).join(", ")}; the server searches only terms of 2 or more characters\n`, true);
    }
    hydrateProcessEnvFromFile();
    const { insights, truncated } = await searchInsights(options);
    if (options.json) {
      await writeOutput(`${JSON.stringify({ success: true, query: options.query, limit: options.limit, truncated, insights })}\n`);
    } else if (insights.length === 0) {
      await writeOutput(`No insights match ${quote(options.query)}.\n`);
    } else {
      const more = truncated ? "; more insights match" : "";
      await writeOutput(`Showing ${insights.length} insight(s) for ${quote(options.query)} (limit ${options.limit}, ranked by relevance/confidence/recency${more}).\n\n`);
      for (const insight of insights) {
        await writeOutput(`${resultBracket(insight)} ${printableLine(insight.title)}\n${printable(insight.content)}\n\n`);
      }
      if (truncated) await writeOutput(`${truncationFooter(options.limit, compatibility)}\n`);
    }
    return 0;
  } catch (error) {
    await writeOutput(`${prefix}: ${(error as Error).message}\n`, true);
    return 1;
  }
}
