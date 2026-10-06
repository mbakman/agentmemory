import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isMain } from './manifest.mjs';

export function seedLaunchConfig(template, directory) {
  if (!isAbsolute(directory)) throw new Error('Configuration directory must be absolute');
  const lines = template.split('\n');
  for (const name of ['iii-state', 'iii-stream']) {
    const workers = lines.map((line, index) => ({ index, match: line.match(/^(\s*)-\s+name:\s*(\S+)\s*$/) })).filter(row => row.match?.[2] === name);
    if (workers.length !== 1) throw new Error('Template must seed both persistent store workers');
    const worker = workers[0];
    let end = lines.findIndex((line, index) => index > worker.index && /^\s*-\s+name:/.test(line) && line.search(/\S/) === worker.match[1].length);
    if (end < 0) end = lines.length;
    const block = lines.slice(worker.index, end).join('\n');
    if (!/^\s+store_method:\s*file_based\s*$/m.test(block)
      || !/^\s+file_path:\s*['"]?\/[^\n]+$/m.test(block)
      || !/^\s+save_interval_ms:\s*[1-9]\d*\s*$/m.test(block)) throw new Error('Template must contain explicit file store paths and save intervals');
  }
  const blocks = lines.map((line, index) => ({ index, match: line.match(/^(\s*)-\s+name:\s+configuration\s*$/) })).filter(row => row.match);
  if (blocks.length !== 1) throw new Error('Template must contain one explicit configuration worker');
  if (lines.some(line => /^\s*-\s+name:\s+iii-exec\s*$/.test(line))) throw new Error('Template must not start an application worker');
  const { index: start, match } = blocks[0];
  const indent = match[1].length;
  let end = lines.findIndex((line, index) => index > start && /^\s*-\s+name:/.test(line) && line.search(/\S/) === indent);
  if (end < 0) end = lines.length;
  const block = lines.slice(start, end).join('\n');
  if (!/adapter:\s*\n\s+name:\s+fs\s*\n/.test(block)) throw new Error('Configuration worker must use the fs adapter');
  const dirs = lines.map((line, index) => ({ index, match: line.match(/^(\s*)directory:\s*.+$/) })).filter(row => row.index > start && row.index < end && row.match);
  if (dirs.length !== 1) throw new Error('Configuration worker must have one explicit directory');
  lines[dirs[0].index] = `${dirs[0].match[1]}directory: ${JSON.stringify(directory)}`;
  return lines.join('\n');
}

export async function prepareEngineStart(templatePath, parent) {
  if (!isAbsolute(templatePath) || !isAbsolute(parent)) throw new Error('Template and parent paths must be absolute');
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('Parent must be an owner-only directory owned by this user');
  const template = await readFile(templatePath, 'utf8');
  seedLaunchConfig(template, '/validation-only');
  const root = await mkdtemp(join(await realpath(parent), 'engine-start-'));
  await chmod(root, 0o700);
  const persisted = join(root, 'persisted-config');
  await mkdir(persisted, { mode: 0o700 });
  const rendered = seedLaunchConfig(template, persisted);
  await writeFile(join(root, 'pristine.yaml'), template, { flag: 'wx', mode: 0o600 });
  const config = join(root, 'engine.yaml');
  await writeFile(config, rendered, { flag: 'wx', mode: 0o600 });
  const hash = text => createHash('sha256').update(text).digest('hex');
  const result = { root, config, persisted, templatePath, templateSha256: hash(template), launchSha256: hash(rendered), startedProcess: false };
  await writeFile(join(root, 'preparation.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return result;
}

if (await isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: launch-config.mjs ABSOLUTE_PRISTINE_YAML ABSOLUTE_PRIVATE_PARENT\nRequire explicit state and stream file stores. Prepare a fresh engine YAML and empty persisted-config directory for every start.\nRetain prior start directories. This command launches no process.');
  } else if (args.length !== 2) {
    console.error('Usage: launch-config.mjs ABSOLUTE_PRISTINE_YAML ABSOLUTE_PRIVATE_PARENT');
    process.exitCode = 2;
  } else {
    prepareEngineStart(...args).then(result => console.log(JSON.stringify(result))).catch(() => {
      console.error('Engine configuration preparation failed. Check template and private parent permissions.');
      process.exitCode = 2;
    });
  }
}
