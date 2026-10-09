import { readFile } from "node:fs/promises";
import { isMain, writePrivateJson } from "./manifest.mjs";
import { compareValueMultisets } from "./values.mjs";

function identity(entry) {
  return JSON.stringify([entry.kind, entry.scope ?? null, entry.key ?? null, entry.stream ?? null, entry.group ?? null]);
}

export function compareInventories(before, after, { allowAbsentEmptyScopes = false } = {}) {
  const differences = [];
  const gaps = [];
  const restoredScopes = new Set(after.stateScopes);
  const expectedEmptyScopeAbsences = allowAbsentEmptyScopes ? before.stateScopes.filter((scope) => {
    const entry = before.entries.find((item) => item.kind === "state" && item.scope === scope);
    return !restoredScopes.has(scope) && entry?.status === "ok" && entry.multiset?.count === 0;
  }).sort() : [];
  const absentEmptyScopes = new Set(expectedEmptyScopeAbsences);
  const physicalScopeCoverage = JSON.stringify([...before.stateScopes].sort()) === JSON.stringify([...after.stateScopes].sort());
  const scopeCoverage = JSON.stringify(before.stateScopes.filter((scope) => !absentEmptyScopes.has(scope)).sort()) === JSON.stringify([...after.stateScopes].sort());
  const streamCoverage = JSON.stringify(before.streams) === JSON.stringify(after.streams);
  if (!scopeCoverage) differences.push({ kind: "state-scope-coverage", before: before.stateScopes, after: after.stateScopes });
  if (!streamCoverage) differences.push({ kind: "stream-group-coverage", before: before.streams, after: after.streams });
  const source = new Map(before.entries.map((entry) => [identity(entry), entry]));
  const restored = new Map(after.entries.map((entry) => [identity(entry), entry]));
  let compared = 0;
  let valueCount = 0;
  for (const key of [...new Set([...source.keys(), ...restored.keys()])].sort()) {
    const left = source.get(key);
    const right = restored.get(key);
    if (left?.kind === "state" && !right && absentEmptyScopes.has(left.scope)) continue;
    if (!left || !right) {
      differences.push({ identity: key, reason: left ? "missing-entry" : "unexpected-entry" });
    } else if (left.status !== "ok" || right.status !== "ok") {
      gaps.push({ identity: key, before: left.status, after: right.status, beforeError: left.error, afterError: right.error });
    } else {
      const result = compareValueMultisets(left.multiset, right.multiset);
      compared++;
      valueCount += left.multiset.count;
      if (!result.equal) differences.push({ identity: key, ...result });
    }
  }
  const metadataGaps = [...(before.coverageGaps ?? []), ...(after.coverageGaps ?? [])].filter((gap) => gap.kind === "metadata");
  return {
    schema: 1, comparedAt: new Date().toISOString(), readableEqual: differences.length === 0,
    complete: before.complete === true && after.complete === true && gaps.length === 0 && metadataGaps.length === 0 && expectedEmptyScopeAbsences.length === 0,
    comparedEntries: compared, comparedValues: valueCount, scopeCoverage, physicalScopeCoverage, streamCoverage,
    allowAbsentEmptyScopes, expectedEmptyScopeAbsences,
    differences, gaps, metadataGaps,
    limitation: "Values-only APIs cannot prove arbitrary key mapping; duplicate multiplicity is compared.",
  };
}

async function main(args) {
  const values = new Map();
  let allowAbsentEmptyScopes = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--allow-absent-empty-scopes") {
      allowAbsentEmptyScopes = true;
      continue;
    }
    if (!["--before", "--after", "--out"].includes(args[i]) || !args[i + 1]) throw new Error("Usage: compare-inventory.mjs --before FILE --after FILE --out FILE");
    values.set(args[i], args[++i]);
  }
  if (values.size !== 3) throw new Error("Provide --before, --after, and --out");
  const [before, after] = await Promise.all([values.get("--before"), values.get("--after")].map(async (path) => JSON.parse(await readFile(path, "utf8"))));
  const result = compareInventories(before, after, { allowAbsentEmptyScopes });
  await writePrivateJson(values.get("--out"), result);
  console.log(JSON.stringify({ readableEqual: result.readableEqual, complete: result.complete, comparedEntries: result.comparedEntries, comparedValues: result.comparedValues, differences: result.differences.length, gaps: result.gaps.length + result.metadataGaps.length, expectedEmptyScopeAbsences: result.expectedEmptyScopeAbsences.length, physicalScopeCoverage: result.physicalScopeCoverage }));
  if (!result.readableEqual) process.exitCode = 1;
  else if (!result.complete) process.exitCode = 3;
}

if (await isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 2; });
}
