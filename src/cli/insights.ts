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

export const INSIGHTS_HELP = `Usage: agentmemory insights <query> [--limit N] [--json]
       agentmemory-insights <query> [max] [--json]

Search synthesized insights by title, content, and tags using the server's
relevance/confidence/recency ranking. Defaults to ten results.
The obsolete third positional pool argument is accepted but ignored.

Configuration: AGENTMEMORY_URL, III_REST_PORT, AGENTMEMORY_SECRET,
and ~/.agentmemory/.env. AGENTMEMORY_INSIGHTS_TIMEOUT_MS defaults to 10000.
Exit status: 0 for results or an empty search; 1 for failures; 2 for invalid usage.
`;

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
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
      limit = positiveInteger(value ?? "", "limit");
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
    limit = positiveInteger(positional[1], "max");
  }
  if (positional[2] !== undefined) positiveInteger(positional[2], "pool");
  return { query, limit: limit ?? 10, json, deprecatedPool: positional[2] !== undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactInsight(value: unknown): CompactInsight {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.content !== "string" ||
    typeof value.confidence !== "number" || !Number.isFinite(value.confidence) ||
    typeof value.score !== "number" || !Number.isFinite(value.score) ||
    !Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string")
  ) {
    throw new Error("malformed response: invalid insight fields");
  }
  return {
    id: value.id,
    title: value.title,
    content: value.content,
    confidence: value.confidence,
    score: value.score,
    tags: value.tags as string[],
  };
}

export async function searchInsights(
  options: InsightSearchOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CompactInsight[]> {
  const base = (env.AGENTMEMORY_URL || `http://localhost:${env.III_REST_PORT || "3111"}`)
    .replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(`${base}/agentmemory/insights/search`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("invalid URL");
    }
  } catch {
    throw new Error("configuration error: AGENTMEMORY_URL must be an HTTP(S) base URL without credentials");
  }
  const timeout = positiveInteger(env.AGENTMEMORY_INSIGHTS_TIMEOUT_MS || "10000", "AGENTMEMORY_INSIGHTS_TIMEOUT_MS");
  const signal = AbortSignal.timeout(timeout);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.AGENTMEMORY_SECRET) headers.Authorization = `Bearer ${env.AGENTMEMORY_SECRET}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: options.query, limit: options.limit }),
      signal,
    });
  } catch {
    if (signal.aborted) throw new Error(`timeout: insight search exceeded ${timeout} ms`);
    throw new Error("connection failed: could not reach the agentmemory search endpoint; check AGENTMEMORY_URL and the running daemon");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`authentication failed (HTTP ${response.status}): set AGENTMEMORY_SECRET to match the server`);
  }
  if (!response.ok) throw new Error(`backend failure: HTTP ${response.status}`);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    if (signal.aborted) throw new Error(`timeout: insight search exceeded ${timeout} ms`);
    throw new Error("malformed response: expected JSON from the insight search endpoint");
  }
  if (isRecord(data) && data.success === false) {
    throw new Error("backend failure: server reported success=false");
  }
  if (!isRecord(data) || data.success !== true || !Array.isArray(data.insights)) {
    throw new Error("malformed response: expected success=true and an insights array");
  }
  return data.insights.map(compactInsight).slice(0, options.limit);
}

async function writeOutput(text: string, stderr = false): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    (stderr ? process.stderr : process.stdout).write(text, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function runInsightsCli(args: string[], compatibility = false): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    await writeOutput(INSIGHTS_HELP);
    return 0;
  }
  let options: InsightSearchOptions;
  try {
    options = parseInsightArgs(args, compatibility);
  } catch (error) {
    await writeOutput(`agentmemory insights: ${(error as Error).message}\n${INSIGHTS_HELP}`, true);
    return 2;
  }
  if (options.deprecatedPool) {
    await writeOutput("agentmemory-insights: the pool argument is deprecated and ignored; native search searches the full eligible corpus\n", true);
  }
  try {
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
    await writeOutput(`agentmemory insights: ${(error as Error).message}\n`, true);
    return 1;
  }
}
