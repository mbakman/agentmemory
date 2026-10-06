import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareEngineStart, seedLaunchConfig } from '../scripts/preservation/launch-config.mjs';

const template = `workers:
  - name: configuration
    config:
      adapter:
        name: fs
        config:
          directory: /original/config
      ttl_seconds: 0
  - name: iii-state
    config:
      adapter:
        name: kv
        config:
          file_path: /protected/state
          store_method: file_based
          save_interval_ms: 2000
  - name: iii-stream
    config:
      adapter:
        name: kv
        config:
          file_path: /protected/stream
          store_method: file_based
          save_interval_ms: 2000
`;

describe('engine configuration preparation', () => {
  it('creates independent empty configuration directories and preserves the pristine template on every start', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'agentmemory-engine-start-'));
    const source = join(parent, 'source.yaml');
    await writeFile(source, template, { mode: 0o600 });
    const first = await prepareEngineStart(source, parent);
    await writeFile(join(first.persisted, 'iii-state.yaml'), 'old persisted settings');
    await writeFile(first.config, 'stripped YAML from the previous engine');
    const second = await prepareEngineStart(source, parent);
    expect(second.root).not.toBe(first.root);
    expect(await readdir(second.persisted)).toEqual([]);
    expect(await readFile(second.config, 'utf8')).toBe(seedLaunchConfig(template, second.persisted));
    expect(await readFile(source, 'utf8')).toBe(template);
    expect(await readFile(join(first.persisted, 'iii-state.yaml'), 'utf8')).toBe('old persisted settings');
    expect(await readFile(join(second.root, 'pristine.yaml'), 'utf8')).toBe(template);
    expect(second.templateSha256).toBe(first.templateSha256);
    expect((await stat(second.root)).mode & 0o777).toBe(0o700);
    expect((await stat(second.config)).mode & 0o777).toBe(0o600);
    expect(second.startedProcess).toBe(false);
  });

  it('changes only the configuration directory and safely quotes paths with spaces', () => {
    const directory = '/private/start directory/persisted-config';
    const result = seedLaunchConfig(template, directory);
    expect(result.replace(JSON.stringify(directory), '/original/config')).toBe(template);
    expect(result).toContain('file_path: /protected/state');
    expect(result).toContain('save_interval_ms: 2000');
  });

  it('rejects implicit, duplicate, non-filesystem or application-launching configuration', () => {
    for (const invalid of [template.replace('- name: configuration', '- name: implicit'), template + '  - name: configuration\n', template.replace('name: fs', 'name: bridge'), template.replace('          directory: /original/config\n', ''), template + '  - name: iii-exec\n', template.replace('          file_path: /protected/state\n', ''), template.replace('store_method: file_based', 'store_method: in_memory')]) {
      expect(() => seedLaunchConfig(invalid, '/private/new')).toThrow();
    }
    expect(() => seedLaunchConfig(template, 'relative')).toThrow('absolute');
  });

  it('refuses unsafe parents before creating a start directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'agentmemory-engine-parent-'));
    const source = join(parent, 'source.yaml');
    await writeFile(source, template);
    await chmod(parent, 0o755);
    await expect(prepareEngineStart(source, parent)).rejects.toThrow('owner-only');
    await chmod(parent, 0o700);
    const link = join(parent, 'parent-link');
    await symlink(parent, link);
    await expect(prepareEngineStart(source, link)).rejects.toThrow('owner-only');
    expect((await readdir(parent)).sort()).toEqual(['parent-link', 'source.yaml']);
  });
});
