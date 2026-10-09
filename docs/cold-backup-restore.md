# Cold backup and original restore

The accepted final backup is now `~/.agentmemory-labs/cutover-final-20261008.Kd7M2q/archive`.
The October 6 archive below remains a historical backup point. Later maintenance retired inactive test-store and runtime-copy directories.
Reconstruct an independent test runtime from a retained archive before reusing these historical commands.
See [production-cutover-results.md](production-cutover-results.md) for the final restore proof and [maintenance-wrap-up.md](maintenance-wrap-up.md) for retained paths.

The cold backup and original-runtime restore passed on 2026-10-06. Unchanged production was restarted after the backup.
Upstream migration preserved the protected records and vectors on an isolated copy. Final restart and review results are recorded in the readiness report. This guide does not authorize a production upgrade or rollback window.

## Backup identity and proof

| Item | Recorded result |
| --- | --- |
| Private task root | `/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk` |
| Sealed archive | `archive/` under the task root |
| File count and bytes | 18,737 files; 5,797,804,200 bytes |
| Application file comparison | 5,335 files matched |
| Live-store file comparison | 4,865 files matched; this is a subset of the application image |
| Installed package comparison | 13,081 files matched |
| Native value comparison | 400,233 values matched; zero read gaps or value differences |
| Original runtime | agentmemory `0.9.29`, iii-sdk `0.11.2`, iii-engine `0.11.2` |
| Original restored indexes | 118,589 BM25 documents; 117,750 vectors; 384 dimensions |
| Production identities after recovery | Worker `73154`; engine `73177`. Recapture identities before any later action. |

The seal manifest is `evidence/archive-seal-final.json`. Its SHA-256 is:

```text
cc26147271de6a8bc1695505ad3e299e90dc4a72b5f04c95ae15c850c10b5d05
```

The archive and its parent have owner-only access. Archived credentials remain private. Test runtimes do not load them.
External evidence references remain stored text. Unrelated customer dumps and repositories are outside this backup.

FULL means the complete persisted application image and its required runtime assets.
Engine `0.11.2` has no flush barrier. This proof cannot guarantee every acknowledged RAM write or unfinished request.
Values-only APIs cannot prove arbitrary key mapping. Value comparisons preserve duplicate multiplicity.
The RAM inventory had 385 empty scopes without persisted files. Every missing scope returned an actual empty list.
The old engine removes empty scope files. The report lists these names as expected RAM metadata differences.
Strict `complete` remains false in that comparison. There are no remaining native read gaps.
Counts include state values, stream copies, and targeted reads. They do not count distinct memories.

## Source and archive path map

All archive paths below are relative to the sealed `archive/` directory.

| Original source | Archive path | Use during restore |
| --- | --- | --- |
| `/Users/bakman/.agentmemory/` | `agentmemory/` | Complete application image, configuration, sidecars, existing backups, reports, and durable assets |
| `/Users/bakman/.agentmemory/data/state_store.db/` | `agentmemory/data/state_store.db/` | Native state files, including stale temporary files |
| `/Users/bakman/.agentmemory/data/stream_store/` | `agentmemory/data/stream_store/` | Native stream files |
| `/Users/bakman/data/iii-config.yaml` | `resolved-iii-config.yaml` | Exact live resolved configuration; inspect privately before a production restore |
| `/opt/homebrew/lib/node_modules/@agentmemory/agentmemory/` | `assets/pkg/agentmemory/` | Exact installed package and complete dependency tree |
| `/Users/bakman/.local/bin/iii` | `assets/bin/iii` | Original engine binary |
| Original Node and iii support executables | `assets/bin/` | Exact Node, iii-worker, and iii-console binaries |
| Required runtime libraries | `assets/lib/` | Copied Node and native dependency libraries |
| Hugging Face embedding cache | `assets/cache/huggingface/` | Independent local cache copy |
| Claude, Codex, Cursor, iii, and shell configuration | `assets/host-config/` | Private recovery evidence; do not activate in a test HOME |
| Installed agentmemory skills and recall rule | `assets/managed/` | Managed consumer assets for review and targeted recovery |

The `state_store.db` path is a directory of engine files. Do not treat it as a standalone SQLite database.
The restore proof applies to this host. Node uses its sibling `lib/libnode.147.dylib` through RPATH.
Some native libraries retain absolute Homebrew load paths. Cross-host relocation has not been proved.
The archived `iii-worker` reports `0.24.4`. It is a host asset, not an engine `0.11.2` dependency.
Engine `0.22.1` invokes `worker-manager-daemon`; that archived helper rejects the command.
The isolated upgrade uses the SHA-verified `0.22.1` worker and console assets from the same official release as the engine.
Any later cutover must use those aligned assets. It must not reuse the archived helper with the new engine.

## Verify the untouched archive

These commands read the archive and write fresh private evidence. Do not write inside `archive/`.

```sh
TASK_REPO="$HOME/Repos/agentmemory-wt/preservation-lab"
TASK_ROOT="$HOME/.agentmemory-labs/cold-20261006.3DMTEk"
TASK_ARCHIVE="$TASK_ROOT/archive"
TASK_VERIFY="$(mktemp -d "$TASK_ROOT/seal-check-XXXXXX")"
cd "$TASK_REPO"
shasum -a 256 "$TASK_ROOT/evidence/archive-seal-final.json"
node scripts/preservation/manifest.mjs scan \
  --root "$TASK_ARCHIVE" --out "$TASK_VERIFY/archive-current.json"
node scripts/preservation/manifest.mjs compare \
  --before "$TASK_ROOT/evidence/archive-seal-final.json" \
  --after "$TASK_VERIFY/archive-current.json" \
  --out "$TASK_VERIFY/seal-comparison.json" --metadata
```

Require the exact seal checksum above and an equal file comparison. Stop the restore if either check fails.
Keep the archive untouched. The comparison checks coverage, size, SHA-256, permissions, times, and hardlink relationships.

## Prepare an independent original-runtime copy

Use one fresh root for each experiment. Check disk capacity and port availability before copying or launching.

| Purpose | REST | Stream | Viewer | WebSocket |
| --- | ---: | ---: | ---: | ---: |
| Original restore | 4211 | 4212 | 4213 | 50234 |
| Upgrade test | 4311 | 4312 | 4313 | 50334 |
| Original rollback proof | 4411 | 4412 | 4413 | 50434 |

Do not use production ports `3111–3113` or `49134`. If a proposed port is occupied, preserve that runtime and choose a new set.

```sh
df -h "$TASK_ROOT"
du -sk "$TASK_ARCHIVE"
lsof -nP -iTCP:4211 -iTCP:4212 -iTCP:4213 -iTCP:50234 -sTCP:LISTEN
TASK_LAB="$(mktemp -d "$TASK_ROOT/restore-original-XXXXXX")"
TASK_BASE=4211
TASK_WS=50234
cd "$TASK_REPO"
node scripts/preservation/lab.mjs "$TASK_LAB" "$TASK_BASE" "$TASK_WS"
ditto "$TASK_ARCHIVE/agentmemory/data" "$TASK_LAB/data"
ditto "$TASK_ARCHIVE/assets/pkg/agentmemory" "$TASK_LAB/pkg/agentmemory"
ditto "$TASK_ARCHIVE/assets/bin" "$TASK_LAB/bin"
ditto "$TASK_ARCHIVE/assets/lib" "$TASK_LAB/lib"
ditto "$TASK_ARCHIVE/assets/cache" "$TASK_LAB/cache"
```

For rollback proof, use a different fresh root, `TASK_BASE=4411`, and `TASK_WS=50434`.
Never use symlinks or hardlinks from writable lab storage to production or the archive.
Keep archived `.env`, host configuration, PID files, and live configuration outside the lab HOME.
Keep the lab root owner-only. If its mode differs from the source root, use the documented root-only metadata exception.
All descendant file checks still apply.

Create launch argument files from the maintained clean environment. This command writes configuration; it does not launch a process.
The profile denies production paths, archive reads, writes outside the lab, production ports, and external network traffic.

```sh
node --input-type=module - "$TASK_REPO" "$TASK_LAB" "$TASK_BASE" "$TASK_WS" "$TASK_ARCHIVE" <<'NODE'
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [repo, lab, base, ws, archive] = process.argv.slice(2);
const { runtimeEnv, sandboxProfile } = await import(pathToFileURL(join(repo, 'scripts/preservation/lab.mjs')));
const ports = { rest: +base, stream: +base + 1, viewer: +base + 2, ws: +ws };
const profile = join(lab, 'config/runtime-private.sb');
await writeFile(profile, sandboxProfile(lab, ports, [
  '/Users/bakman/.agentmemory', '/Users/bakman/data', '/Users/bakman/.iii',
  '/opt/homebrew/lib/node_modules/@agentmemory/agentmemory', archive,
]), { mode: 0o600, flag: 'wx' });
const environment = Object.entries(runtimeEnv(lab, ports, 'none')).map(([key, value]) => `${key}=${value}`);
const sandbox = ['/usr/bin/sandbox-exec', '-f', profile];
const commands = {
  'engine-only-launch.args': [join(lab, 'bin/iii'), '--config', join(lab, 'config/engine-only.yaml')],
  'engine-launch.args': [join(lab, 'bin/iii'), '--config', join(lab, 'config/worker.yaml')],
  'worker-launch.args': [join(lab, 'bin/node'), join(lab, 'pkg/agentmemory/dist/index.mjs')],
};
for (const [name, command] of Object.entries(commands)) {
  await writeFile(join(lab, 'config', name), [...environment, ...sandbox, ...command].join('\0') + '\0', { mode: 0o600, flag: 'wx' });
}
NODE
```

Generation, scheduled retention, capture, graph extraction, and telemetry are disabled in this environment.
The initial worker uses `EMBEDDING_PROVIDER=none`. Do not copy credentials into the lab or enable an external model.
Local-vector proof needs another fresh copy, the copied local cache, and a reviewed `local` embedding setting.
Retest the sandbox after any profile change. Require denied production-path reads, outside-lab writes, production-port connections, and external connections.

## Prove engine-only restoration first

Launch the exact old engine without an application worker. Keep process logs private.

```sh
cd "$TASK_LAB"
xargs -0 /usr/bin/env -i < "$TASK_LAB/config/engine-only-launch.args" \
  > "$TASK_LAB/logs/engine-only.log" 2>&1
```

Run the following in a separate terminal after the WebSocket listener is ready:

```sh
cd "$TASK_REPO"
/usr/bin/env -i HOME="$TASK_LAB/home" TMPDIR="$TASK_LAB/tmp" \
  PATH="$TASK_LAB/bin:/usr/bin:/bin" OTEL_ENABLED=false III_TELEMETRY_ENABLED=false \
  /usr/bin/sandbox-exec -f "$TASK_LAB/config/runtime-private.sb" \
  "$TASK_LAB/bin/node" scripts/preservation/inventory.mjs \
  --sdk "$TASK_LAB/pkg/agentmemory/node_modules/iii-sdk/dist/index.mjs" \
  --url "ws://127.0.0.1:$TASK_WS" --out "$TASK_LAB/run/native"
node scripts/preservation/compare-inventory.mjs \
  --before "$TASK_ROOT/evidence/candidate-combined.json" \
  --after "$TASK_LAB/run/native/summary.json" \
  --out "$TASK_LAB/run/native-comparison.json"
```

Record every failed or oversized read as a gap. Use fresh supplemental outputs to close measured large-scope gaps.
Do not convert failed reads to empty lists. Do not omit a scope to make the comparison pass.
The existing baseline composition is recorded in `candidate-combined.json`; its native values remain in the candidate's private run directories.
Compare file coverage before worker startup. Capture loader errors. Only identified stale temporary files can receive a documented exception.
Use `manifest.mjs compare --ignore-root-metadata` only for the deliberate owner-only root directory difference.
Use `compare-inventory.mjs --allow-absent-empty-scopes` only for successful zero-value source reads. Preserve the raw comparison too.

## Prove the original worker and full restart

Gracefully stop the verified engine-only process. Preserve its copy and evidence.
Repeat the preparation above with another fresh `TASK_LAB` before the functional worker test.
Verify each PID and command before SIGTERM. Allow 30 seconds for the engine. Do not force termination.

```sh
cd "$TASK_LAB"
xargs -0 /usr/bin/env -i < "$TASK_LAB/config/engine-launch.args" \
  > "$TASK_LAB/logs/engine.log" 2>&1
```

After the engine WebSocket listener is ready, launch exactly one application worker in another terminal:

```sh
cd "$TASK_LAB"
xargs -0 /usr/bin/env -i < "$TASK_LAB/config/worker-launch.args" \
  > "$TASK_LAB/logs/worker.log" 2>&1
```

Wait for the worker's Ready log before any query. For local-vector proof, also require the persisted-index load message.
An HTTP listener alone does not prove index readiness. An early query can start a lazy rebuild.
Test known recall IDs, both installed insight entrypoints, limits, a real empty result, and the viewer.
Keep native insight search inside its CLI help probe. Preserve exit-code distinctions between an empty result and a backend failure.
If indexes rebuild, verify the rebuild counts and known recall results. A successful process exit is insufficient.

For restart proof, stop the verified worker with SIGTERM first. Allow 120 seconds. Keep the engine running.
Check pending work, shutdown logs, process exit, and unexpected writers. An invocation count of zero is insufficient.
Wait at least three persistence intervals; this runtime requires at least 15 seconds.
Compare all store hashes and metadata for stability. Record active temporary writes and loader gaps.
Then stop the verified engine with SIGTERM. Allow 30 seconds. Confirm that it exits without respawn.
Run filesystem synchronization. Restart the same lab engine and worker. Wait for Ready again, then repeat the functional checks.
Never use `agentmemory stop`, SIGKILL, cleanup deletion, or an archive file as writable storage.

Completed proof: the original Noop runtime passed a full engine and worker restart.
The original local-vector runtime also passed both starts, with 118,589 BM25 documents and 117,750 vectors loaded.
Its three known recall IDs matched production on both starts. Both insight commands, limit two, empty results, and viewer access passed.
The worker and engine exited gracefully. All 4,865 store files were stable across the final 15-second drain check; no temporary files were active.
Private evidence includes `original-vector-proof/run/vector-proof.json` and `rollback-original/run/` under the task root.

## Production recovery and future rollback boundary

The exact unchanged production recovery command is recorded in `evidence/recovery.txt`:

```sh
cd "$HOME" && AGENTMEMORY_III_CONFIG="$HOME/.agentmemory/iii-config.yaml" \
  /opt/homebrew/bin/agentmemory --verbose 2>&1 | tee -i -a "$HOME/.agentmemory/server.log"
```

If the original engine remains alive after a failed backup step, the recorded worker-only recovery is:

```sh
cd "$HOME" && AGENTMEMORY_III_CONFIG="$HOME/.agentmemory/iii-config.yaml" \
  /opt/homebrew/bin/agentmemory --no-engine --verbose 2>&1 | tee -i -a "$HOME/.agentmemory/server.log"
```

These commands are for verified production recovery. They are not lab launch commands.
Never use `--no-engine` after the engine has stopped. Recapture executable hashes, configuration, listeners, and process identities first.

A production rollback needs a separate authorized window. Prepare and review the exact paths and commands before that window.
Rollback restores the pre-migration stores and the original runtime together. A binary-only rollback cannot restore the removed legacy indexes.
This boundary was measured on a cold migrated copy with engine `0.11.2` alone. No old application worker ran.
The four legacy root index keys were absent. The v3 vector metadata and monthly audit metadata remained.
Some unreferenced legacy shard generations remained; the missing root manifests prevent the old reader from using them.
Evidence is `negative-binary-rollback/run/binary-rollback-proof.json` under the private task root.
Its negative-test inventory retains unconfigured queue reads and absent-key reads as coverage gaps. All state and stream lists succeeded.
The fresh backup preserves writes made after a cutover. Restoring this older image does not automatically restore those later writes.
A later cutover plan must define reconciliation or explicitly state that rollback data window.
Use these steps as the future procedure; none is executed by this guide:

1. Verify the seal. Make a fresh cold backup of the then-current production state and package. Preserve writes made after this archive.
2. Restore the old image into owner-only sibling directories on the same volumes. Stage the complete package, dependencies, engine, and required libraries.
3. Keep archived PID files as forensic evidence. Prepare fresh runtime identities. Relocate stale PID files within the staged copy where required.
4. Review configuration and credentials privately. Review which managed consumer assets need targeted recovery. Do not replace unrelated harness configuration.
5. Pause writers in the authorized window. Stop the verified worker, drain the engine, then stop the verified engine gracefully.
6. Rename the current application and package directories to fresh hold names with `mv`. Rename staged replacements into the canonical paths.
7. Retain the displaced directories and configuration. Do not delete or overwrite them. Use fresh hold names for binaries and resolved configuration too.
8. Start the verified original runtime with the recorded production command. Check configuration, ports, viewer, known recall IDs, and guarded insight search.
9. If recovery fails, stop verified processes gracefully and reverse the reviewed renames. Preserve the failed copy for investigation.

Example reviewable path pattern: `.agentmemory.restore-TIMESTAMP` becomes `.agentmemory`, while the current image becomes `.agentmemory.hold-TIMESTAMP`.
Use the same pattern within `/opt/homebrew/lib/node_modules/@agentmemory/` for the installed package.
No overwrite, global npm reinstall, main merge, production upgrade, or cleanup is part of this backup plan.

## Upgrade isolation and drain

Use `AGENTMEMORY_DATA_DIR` equal to the actual engine store directory. A future production launch must use `/Users/bakman/.agentmemory/data`.
Use a new lab HOME and its newly generated API secret. Never load the archived credentials into a trial.
The comparison run disables LLM generation, Agent-SDK fallback, graph extraction, consolidation, slots, reflect, auto-forget, lesson decay, insight decay, snapshots, session sweeps, graph compaction on boot, and audit retention. It disables capture spooling and context injection. It retains on-device embeddings with the archived cache. Stock audit, index, session-index, and capture startup work still runs and must be measured.
Take the migration inventory before functional tests. Record the effective viewer stream cap; this run uses the default `500`.
For the new worker, the public `/agentmemory/livez` response includes `viewerPort` only after the worker completes its keyword rebuild.
Wait for that readiness result before ordinary tests. A separate early-request regression is intentional and records its own timing.
The engine save interval is `2000` ms. After worker exit, wait at least three intervals; the rehearsal uses at least `15` seconds.
Compare file hashes and metadata, check temporary writes, then stop the verified engine gracefully. Stable files support the drain check; they do not prove a flush barrier.
