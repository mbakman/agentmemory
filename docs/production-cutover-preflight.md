# Production cutover preparation — 2026-10-06

Execution update — 2026-10-08: production now runs engine, SDK, and helpers `0.22.1`, with application `0.9.29`.
The fresh cold backup, original restore, migration, installed commands, graceful restart, and final preservation review passed. Writers resumed at `2026-10-08T21:27:16Z`.
See [the current cutover results](production-cutover-results.md). The sections below retain the historical preparation evidence and its limits.
The user waived RAM capacity checks. Those checks no longer block execution.

Private evidence: `~/.agentmemory-labs/cutover-preflight-mgHfKS/`.
Initial evidence is `evidence/preflight-summary.json`; corrections are in `preflight-summary-after-review.json`.
Final checks are in `evidence/post-review-checks.json`. Keep evidence and memory payloads private.
The procedure remains [production-cutover.md](production-cutover.md).

## Staged release

The complete tested installed package is copied to:

```text
/opt/homebrew/lib/node_modules/@agentmemory/agentmemory.stage-cutover-preflight-mgHfKS
```

The source is the earlier tested `upgrade-0221/pkg-patched` tree.
All 13,256 files and 15,127 entries match, including descendant metadata, symlinks, and hardlink relationships.
The comparison permits only the documented owner-only root metadata exception.
The four local model cache files are included. No dependency range was resolved again.
The designated tarball, lockfile, and bridge hashes match the reviewed values.

The three engine assets are retained together at:

```text
/Users/bakman/.local/share/agentmemory/releases/iii-0.22.1-cutover-preflight-mgHfKS/bin
```

Their SHA-256 checks pass. A non-interactive shell selects this directory first.
The engine, worker helper, and console each report `0.22.1`.
The staged package has SDK and npm helpers `0.22.1`.
The canonical installed package, global engine assets, and host settings have not changed.
No application image was copied from live production.
Do not run a global npm or Homebrew package change while this sibling stage is retained.

## Launch and isolation checks

The private configuration contains an explicit filesystem configuration worker and fresh persistence directory.
State and stream paths are absolute. Save intervals are `2000` ms. HTTP timeout is `600000` ms.
There is no `iii-exec` application launcher.
The production configuration was not launched.

A mapped empty engine ran on `4411`, `4412`, and `50434` with a clean HOME.
No application worker or model started. The viewer port `4413` therefore had no application listener.
The engine selected the staged `iii-worker` and accepted `worker-manager-daemon`.
Seven builtin values were saved in the separate `persisted-config` directory.
Engine startup then rewrote their YAML blocks to references to those saved values.
The worker-manager block stayed in the launch YAML.
Retain each start directory and both YAML copies. Never relaunch a rewritten YAML.
Back up the configuration directory as part of the full runtime image.

The first empty inventory reported a gap for the default `reflect:recentClusters` target.
No application had created that key. That raw gap remains in the evidence.
An explicit empty target list then produced a complete empty inventory: zero scopes, streams, values, or read gaps.
This check proves transport and empty-engine startup. It does not prove memory migration.
The engine restarted and exited after SIGTERM, but that first restart did not activate the persisted state adapter.
Its log showed initial production port defaults, extra in-memory warnings, and a restart-tier adapter warning.
The complete empty inventory proved transport only. It did not prove file storage.
These failed restart logs remain in the evidence.

The corrected sequence uses [launch-config.mjs](../scripts/preservation/launch-config.mjs) before every engine start.
It copies a pristine template and creates a fresh empty configuration directory. It preserves prior directories.
It rejects a stripped state/stream template and does not start a process.
A subsequent test wrote one synthetic state value and one stream value, then restarted with a fresh seed.
Both values, their complete payloads, and duplicate multiplicity matched after restart.
Only the expected queue and cron in-memory warnings remained. No state adapter change warning appeared.
The initial HTTP adapter used trial port `4411`. The strict profile continued to deny production ports.
All engine starts and their owned helpers exited gracefully. No application worker started.

The exact production network profile passed small positive and negative probes.
It permits production loopback access and rejects external connections and an unapproved bind with `EPERM`.
Its mapped twin permits trial traffic and rejects production ports.
The strict lab profile also rejects production file reads and writes outside the lab with `EPERM`.
No production process used these profiles. Full worker launch and restart under the profile remain gates.

The currently recognized state YAML lookup paths are absent.
The worker would use the conservative `5000` ms interval estimate and `6500` ms capture durability estimate.
Repeat this check on the fresh staged application image before launch.

## Consumer and command checks

The maintained [consumer probe](../scripts/preservation/consumer-probe.mjs) speaks MCP over stdio.
It checks the full tool inventory and known recall IDs. Evidence contains counts and hashes.
It does not save raw memory, IDs, credentials, or stderr text.
Nineteen offline tests cover success, auth failure, refused connection, timeout, malformed output, inventory fallback, and missing known recall.

The staged bridge reached 54 tools and the expected two recall IDs against unchanged production.
An unused port produced `unreachable` and exit `1`, with no fallback store.
The old backend accepted a deliberately wrong secret and returned the same two IDs.
This is an observed control failure. The effective old server secret was not inspected.
Presence-only inspection found no secret declaration in the live `.env` and no stored secret file.
Old authentication permits requests when no secret is configured; new startup always resolves a usable secret.
If startup generates a secret, verify every consumer through the approved resolver and review explicit overrides privately.
Preserve the generated file with the upgraded image. Do not put it in the old-runtime rollback image.
Require fresh wrong-secret rejection on the new runtime. The old-runtime check cannot close that gate.
These pre-freeze recalls can update access metadata. They did not change the production runtime.

Both staged insight entrypoints returned two known results with truncation reported.
A distinctive absent token returned zero results and `truncated: false`.
The CLI probe guard was used. The commands ran in a non-interactive shell.

## Capacity and checks

All eleven samples from 18:10:51 through 18:15:52 UTC reported kernel memory pressure level `2`.
Swapouts increased by 161,348 pages, or 2,643,525,632 bytes.
Small preparation tasks overlapped the samples. This is failed observational evidence, not a clean promotion sample.
The current image estimate is 5.45 GiB, using live application/package sizes and earlier runtime asset sizes.
Three copies plus the 10 GiB reserve require about 26.36 GiB; available space was about 100.62 GiB.
Refresh every source size and the disk reserve before the maintenance window.
The full new worker peak and the 4 GiB memory reserve have not been proved.

Commands run in this preparation:

- `npm run build`: passed; build completed in about 5.3 seconds.
- `npm test -- --maxWorkers=2`: final review corrections passed with 243 files and 2,914 tests; two tests skipped.
- `npm run skills:check`: passed for all 17 skills.
- Package manifest comparison: equal across all 13,256 files, with the explicit root exception.
- Staged asset SHA-256 checks and PATH/version checks: passed.
- Staged stdio, insight, and network probes: results and limits recorded above.

The canonical worktree path resolves to `/Users/bakman/.codex/worktrees/upstream-memory/agentmemory`.
Both names identify the same source at baseline `e3ab8321943bb351524df59ada8eefd0e77c111f` plus the recorded preparation diff.
The refusal/fallback diagnostics in the full suite come from injected network probes, not live production requests.

## Remaining execution gates

1. RAM capacity, pressure, and reserve checks are waived by the user. Do not pause optional apps for those checks.
2. Complete the mapped full-worker functional launch with the selected toolchain and tested isolation profile.
3. Confirm a bounded writer pause and execution approval. Account for supervisors, hooks, and detached drains.
4. Take a fresh full cold backup. Compare candidate RAM values and prove the original restore before activation.
5. Activate the prepared images. Measure migration, enforce MCP auth, and verify capture and graceful restart.
6. Apply the targeted consumer edits and accept the rollback visibility boundary before ordinary writers resume.

Production was not stopped. No canonical activation, host setting change, push, main merge, or cleanup occurred.
The earlier sealed backup stays untouched. It cannot replace the fresh cutover backup.

Fable `claude-fable-5-1` accepted the revised preparation at effort `max` after the restart and auth findings closed.
The verdict is READY FOR PREPARATION. It leaves all production execution gates open.
