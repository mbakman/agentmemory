import { createHash } from "node:crypto";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("A native value is not JSON serializable");
  return result;
}

export function valueMultiset(values) {
  if (!Array.isArray(values)) throw new Error("Expected a native value array");
  const counts = new Map();
  for (const value of values) {
    const digest = createHash("sha256").update(canonicalJson(value)).digest("hex");
    counts.set(digest, (counts.get(digest) ?? 0) + 1);
  }
  const members = [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([sha256, count]) => ({ sha256, count }));
  return {
    count: values.length, uniqueValues: members.length, members,
    sha256: createHash("sha256").update(JSON.stringify(members)).digest("hex"),
  };
}

export function compareValueMultisets(before, after) {
  const source = new Map(before.members.map(({ sha256, count }) => [sha256, count]));
  const copy = new Map(after.members.map(({ sha256, count }) => [sha256, count]));
  const differences = [...new Set([...source.keys(), ...copy.keys()])].sort()
    .filter((hash) => (source.get(hash) ?? 0) !== (copy.get(hash) ?? 0))
    .map((sha256) => ({ sha256, before: source.get(sha256) ?? 0, after: copy.get(sha256) ?? 0 }));
  return { equal: differences.length === 0, beforeCount: before.count, afterCount: after.count, differences };
}
