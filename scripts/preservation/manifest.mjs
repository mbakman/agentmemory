import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function fileType(stat) {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isSocket()) return "socket";
  if (stat.isFIFO()) return "fifo";
  if (stat.isBlockDevice()) return "block-device";
  if (stat.isCharacterDevice()) return "character-device";
  return "unknown";
}

export async function createManifest(root, { exclude = [] } = {}) {
  const source = await realpath(root);
  const exclusions = exclude.map((entry) => {
    if (!entry || isAbsolute(entry)) throw new Error("Exclusions must be relative paths");
    const normalized = relative(source, resolve(source, entry)).split(sep).join("/");
    if (!normalized || normalized === ".." || normalized.startsWith("../")) {
      throw new Error("Exclusions must be below the manifest root");
    }
    return normalized;
  }).sort();
  const entries = [];
  async function visit(path, name) {
    if (exclusions.some((entry) => name === entry || name.startsWith(`${entry}/`))) return;
    const before = await lstat(path, { bigint: true });
    const type = fileType(before);
    const entry = {
      path: name, type, size: Number(before.size), mode: Number(before.mode & 0o7777n),
      uid: Number(before.uid), gid: Number(before.gid), mtimeNs: before.mtimeNs.toString(),
      birthtimeNs: before.birthtimeNs.toString(), dev: before.dev.toString(),
      ino: before.ino.toString(), nlink: Number(before.nlink),
    };
    if (type === "file") {
      entry.sha256 = await sha256File(path);
      const after = await lstat(path, { bigint: true });
      if (["size", "mtimeNs", "ctimeNs", "ino", "dev"].some((key) => before[key] !== after[key])) {
        throw new Error(`File changed during hashing: ${name}`);
      }
    } else if (type === "symlink") entry.target = await readlink(path);
    entries.push(entry);
    if (type === "directory") {
      for (const child of (await readdir(path)).sort()) {
        await visit(resolve(path, child), name === "." ? child : `${name}/${child}`);
      }
    }
  }
  await visit(source, ".");
  return { schema: 1, root: source, capturedAt: new Date().toISOString(), exclude: exclusions, entries };
}

function hardlinkGroups(entries) {
  const groups = new Map();
  for (const entry of entries.filter((item) => item.type === "file" && item.nlink > 1)) {
    const key = `${entry.dev}:${entry.ino}`;
    groups.set(key, [...(groups.get(key) ?? []), entry.path]);
  }
  return [...groups.values()].filter((paths) => paths.length > 1).map((paths) => paths.sort().join("\n")).sort();
}

export function compareManifests(before, after, { metadata = false, hardlinks = true, ignoreRootMetadata = false } = {}) {
  const errors = [];
  const left = new Map(before.entries.map((entry) => [entry.path, entry]));
  const right = new Map(after.entries.map((entry) => [entry.path, entry]));
  const rootMetadataApplied = ignoreRootMetadata && left.get(".")?.type === "directory" && right.get(".")?.type === "directory";
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const source = left.get(path);
    const copy = right.get(path);
    if (!source || !copy) {
      errors.push({ path, reason: source ? "missing" : "unexpected" });
      continue;
    }
    const rootMetadataException = ignoreRootMetadata && path === "." && source.type === "directory" && copy.type === "directory";
    const fields = rootMetadataException ? ["type"] : ["type", "mode"];
    if (source.type === "file") fields.push("size", "sha256");
    if (source.type === "symlink") fields.push("target");
    if (metadata && !rootMetadataException) fields.push("uid", "gid", "mtimeNs");
    for (const field of fields) {
      if (source[field] !== copy[field]) errors.push({ path, reason: field, before: source[field], after: copy[field] });
    }
  }
  if (hardlinks && JSON.stringify(hardlinkGroups(before.entries)) !== JSON.stringify(hardlinkGroups(after.entries))) {
    errors.push({ path: ".", reason: "hardlink-relationships" });
  }
  return {
    schema: 1, equal: errors.length === 0, comparedAt: new Date().toISOString(),
    beforeFiles: before.entries.filter((entry) => entry.type === "file").length,
    afterFiles: after.entries.filter((entry) => entry.type === "file").length,
    metadata, hardlinks, ignoreRootMetadata,
    metadataExceptions: rootMetadataApplied ? [{ path: ".", type: "directory", fields: metadata ? ["mode", "uid", "gid", "mtimeNs"] : ["mode"], reason: "Independent restore uses an owner-only root directory" }] : [],
    errors,
  };
}

export async function writePrivateJson(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

export async function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  try { return await realpath(process.argv[1]) === fileURLToPath(moduleUrl); }
  catch { return false; }
}

async function main(args) {
  const [command, ...rest] = args;
  const values = new Map();
  const exclude = [];
  for (let i = 0; i < rest.length; i++) {
    const option = rest[i];
    if (option === "--metadata" || option === "--ignore-hardlinks" || option === "--ignore-root-metadata") values.set(option, true);
    else if (["--root", "--out", "--before", "--after", "--exclude"].includes(option) && rest[i + 1]) {
      const value = rest[++i];
      if (option === "--exclude") exclude.push(value);
      else values.set(option, value);
    } else throw new Error(`Unknown or incomplete option: ${option}`);
  }
  if (command === "scan" && values.has("--root") && values.has("--out")) {
    const manifest = await createManifest(values.get("--root"), { exclude });
    await writePrivateJson(values.get("--out"), manifest);
    console.log(JSON.stringify({ entries: manifest.entries.length, files: manifest.entries.filter((entry) => entry.type === "file").length }));
  } else if (command === "compare" && values.has("--before") && values.has("--after") && values.has("--out")) {
    const [before, after] = await Promise.all([values.get("--before"), values.get("--after")].map(async (path) => JSON.parse(await readFile(path, "utf8"))));
    const result = compareManifests(before, after, { metadata: values.has("--metadata"), hardlinks: !values.has("--ignore-hardlinks"), ignoreRootMetadata: values.has("--ignore-root-metadata") });
    await writePrivateJson(values.get("--out"), result);
    console.log(JSON.stringify({ equal: result.equal, differences: result.errors.length, files: result.beforeFiles }));
    if (!result.equal) process.exitCode = 1;
  } else throw new Error("Usage: manifest.mjs scan --root DIR --out FILE [--exclude RELATIVE] | compare --before FILE --after FILE --out FILE [--metadata] [--ignore-hardlinks] [--ignore-root-metadata]");
}

if (await isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 2; });
}
