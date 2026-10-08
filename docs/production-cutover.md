# Production cutover plan — 2026-10-06

Status: READY FOR PLAN. Fable accepted this procedure at effort `max`. The maintenance window remains blocked by execution gates.
The user authorized cutover execution and waived RAM capacity checks on 2026-10-08. The remaining data preservation and functional gates still apply.
Private review evidence is `cutover-plan-20261006.FzaCiC/fable-final-acceptance.md` under `~/.agentmemory-labs/`.
Reversible staging and current blockers are recorded in [the preflight report](production-cutover-preflight.md).

## Intent, problem, and deliverables

Protect the existing memory and deploy the tested fork with engine `0.22.1`.
The application version remains `0.9.29`. The SDK, npm helpers, engine, worker helper, and console must match `0.22.1`.
The problem is a coordinated change of runtime, persisted indexes, audit layout, capture behavior, and consumer authentication.
A working CLI alone does not prove this change is safe.

Deliver a reviewed source branch, a pinned deployment image, a fresh cold backup, a measured migration, and a rollback procedure.
Keep both insight commands and the source reflect fixes.
Publish source only to `https://github.com/mbakman/agentmemory`. Use Rohit's remote only to fetch source.
Do not merge `main`, change production, or delete retained files during planning.

## Verified inputs and planning checks

Source: `codex/upstream-0221` in `~/Repos/agentmemory-wt/upstream-0221`, starting this plan at `2a65f6a30bda7a6be216147bd6e95b8c5c2a1149`.
The worktree was clean. `origin` fetch and push point to the user's fork.
The isolated rehearsal passed; see [readiness evidence](upstream-readiness.md) and [restore procedure](cold-backup-restore.md).
Those results concern the earlier image. A new backup must preserve the then-current production state.

The designated npm artifact is `~/.agentmemory-labs/cold-20261006.3DMTEk/packages/startup-rebuild-fix/agentmemory-agentmemory-0.9.29.tgz`.
Its SHA-256 is `ba4df8ace65915e102cd016d04973d3bb063d8a48dfe640f5fcee3a279704d53`.
The dependency lock is `packages/upstream-0221.package-lock.json` under the same root.
Its SHA-256 is `0dd2b555862995b3c000c31ff613285d26ab2eafe98eaa95464dc8e77f5a5d88`.
Both hashes were checked again during planning.
Use the tested artifact and dependency contents. Do not resolve new dependency ranges during the outage.
The artifact contains the runtime change later committed as `566aa1b5`; embedded plugin metadata still names its earlier build HEAD.
The final clean build proved runtime content equality. Tarball byte reproducibility is not claimed.

At 13:23–13:25 EDT, production worker `73154` and engine `73177` remained available.
The application reports `0.9.29`; engine and SDK remain `0.11.2`.
REST, stream, and viewer listeners remain `3111`, `3112`, and `3113`. WebSocket remains `49134`.
`GET /agentmemory/livez` returned HTTP 200 with viewer port `3113`.
`GET /agentmemory/health` returned HTTP 503 with the existing memory alert; state connectivity remained good.

The Mac has 48 GiB RAM. `memory_pressure` reported 46% system memory free in the first sample.
Two kernel samples reported `kern.memorystatus_vm_pressure_level: 2`. Swap use was about 19.4 GB of 20.48 GB.
The old health calculation uses `heapUsed / heapTotal`, not physical RAM or the V8 heap limit.
The new source uses the V8 limit when available at [src/health/thresholds.ts](../src/health/thresholds.ts).
These facts do not prove a physical RAM shortage or a safe peak memory budget.
The user waived the RAM capacity gate on 2026-10-08. These historical observations no longer block execution.
Private planning evidence is in `~/.agentmemory-labs/cutover-plan-20261006.FzaCiC/`.

The deployed Codex, Claude, and Cursor MCP configurations use unpinned `npx -y @agentmemory/mcp`.
The current cache resolves shim `0.9.30` and implementation `0.9.30`.
The tested consumer stage pins shim `0.9.29` and implementation `0.9.30` with a complete lockfile.
The matching implementation can return seven local tools and empty recall after HTTP 401.
`AGENTMEMORY_FORCE_PROXY=1` does not prevent that fallback.
Consumer exit status zero is insufficient. Require the reviewed remote tool inventory and a known recall hit.
Codex has six global capture registrations. Claude has twelve. Cursor's global hook file has no agentmemory registration.
Do not add a new Cursor capture integration in this cutover. Validate the capture registrations that already exist.

## Gates before the maintenance window

1. Obtain approval to execute this procedure, with a bounded writer pause. Planning approval alone is insufficient.
2. Finish Fable review with `claude-fable-5-1`, native 1M context, effort `max`. Close plan blockers.
3. Stage the complete runtime, dependencies, managed hook assets, and consumer lock outside production.
4. Prove helper discovery and the exact launch command. No implicit helper install or second app worker is permitted.
5. RAM capacity, pressure, swapout, peak measurement, and the 4 GiB RAM reserve are waived by the user.
   Complete the mapped full-worker functional launch without RAM monitoring. Do not change heap limits or stop unrelated programs automatically.
6. Require at least three fresh full-image copies plus 10 GiB reserve on each relevant volume.
   The earlier image was 5.8 GB; measure the current image. Planning found 107 GiB disk space available.
7. Identify every writer, supervisor, detached capture drain, and scheduled task. Confirm the pause through host state and process checks.
8. Stage the original-runtime recovery paths and commands. Check them before shutdown.
9. Record the approved consumer inventory, known recall IDs, insight IDs, index coverage, feature flags, and capture retry state.

A gate failure leaves production unchanged. Stop preparation at the failed gate and record the reason.

### Capture paths and automatic writes

Freeze and inventory every spool path below, including record counts, retry envelopes, sent marks, and payload hashes.
Record absence without creating a directory. Do not limit the backup to the explicit worker spool.

| Path | Reason | New archive destination |
| --- | --- | --- |
| `/Users/bakman/.agentmemory/data/capture-spool` | Explicit worker and resumed hook path | Within `archive/agentmemory/data/` |
| `/Users/bakman/data/capture-spool` | Derived default when a hook or worker uses HOME as cwd and finds `data/iii-config.yaml` | `archive/assets/spools/home-legacy/` |
| `/Users/bakman/Library/Application Support/agentmemory/capture-spool` | macOS default for ordinary project cwds and the proposed fresh worker cwd | `archive/assets/spools/macos-default/` |
| `<each host cwd>/data/capture-spool` when its legacy store or config exists | Additional cwd-specific default | A separate mapped directory under `archive/assets/spools/` |

The new worker drains its explicit spool and a derived default after stripping the two explicit data/spool variables.
See [serverSpoolTargets](../src/functions/capture.ts) and [default path resolution](../src/cli-data-dir.ts).
Its proposed cwd is the fresh `CUT_RUN`, so its second path is the macOS default above.
Verify that cwd has no legacy `data/state_store.db` or `data/iii-config.yaml` before launch.
The original recovery cwd is HOME, so its derived legacy path differs.
Inventory the real hook parent cwds and explicit overrides. Add any extra path to the backup and rollback map.
Check for symlinks and overlapping paths; preserve the targets once with an explicit source map.

Startup spool drain can add observations before the migration inventory. Account for each input envelope and resulting receipt or observation.
Never classify all capture changes as harmless. Explain payload hashes, deduplication, retry changes, and any prune removal individually.
The new worker also retries capture every ten seconds, prunes hourly, updates health every thirty seconds,
and sweeps recent-search diagnostics hourly. These automatic writers remain enabled under the initial comparison flags.
Keep ordinary agents paused and record these changes through acceptance and the first service observation period.

## Stage and publish while production runs

Create an owner-only task directory with `umask 077` and `mktemp -d` under `~/.agentmemory-labs/`.
Initialize the variables in the execution command sheet during this preparation, before Phase A.
Use fresh paths for evidence, package staging, original restore, migration, and rollback.
Keep the existing archive sealed. Never run a worker against an archive.

Prepare the complete installed package from the preserved npm workflow and lock.
Prefer a copy of the tested installed package and its full dependency tree.
If a fresh installation is needed, use a private prefix with scripts disabled, then compare every dependency against the tested tree.
A tarball-only `npm install -g` can resolve changed dependency ranges; it is not sufficient.
Use Node `26.11.0` and npm `11.20.0`. Separate build, full tests, skill checks, and isolated functional restart passed on 2026-10-08.
The original Node `26.10.0` and libraries remain archived for the original-runtime restore proof.
Preserve executable modes and the local embedding cache. Test the staged package through non-interactive shells.

Stage the verified engine, worker helper, and console as one versioned asset set.
Put that asset directory first in `PATH` for both the engine and app.
Engine `0.22.1` resolves helpers from `PATH`, then `~/.local/bin`; sibling placement alone does not select them.
Use a permanent versioned release path. Leave unrelated global iii installations unchanged.
Required binary hashes are:

| Asset | SHA-256 |
| --- | --- |
| iii `0.22.1` | `6452e54b05e73bee301e05bd8b75c0a6eb1986d8cb37664c4465859612110ed2` |
| iii-worker `0.22.1` | `2da172266a0996445442764316d56889a9b533d52cbfd62a7a05120c8fb6daf3` |
| iii-console `0.22.1` | `adaa02f693e31c6bc30905c405626e301ffa6ed39b321a669d85b29e394226c2` |

The installed host worker helper is `0.24.4`; it rejects the new engine's required command.
Do not mix it with engine `0.22.1`.
The binary hashes above were checked during this plan. They come from the earlier verified official `iii/v0.22.1` assets,
engine source `e7de3820d1e558f3762edf95e4440552444d48d3`, and the preserved release checksum records.
They are extracted-binary hashes, distinct from the download archive hashes pinned in source.
Place exact reviewed configuration outside the engine's default watched `./config` directory.
Use absolute store paths. Omit an `iii-exec` app launcher because the procedure starts exactly one app worker.

Prepare targeted edits to each MCP command, its approved environment, and any hook environment.
Select the existing fork plugin bridge as the proposed MCP entrypoint.
Use `/opt/homebrew/bin/node` with `/opt/homebrew/lib/node_modules/@agentmemory/agentmemory/plugin/scripts/plugin-bridge.mjs`.
This bridge uses the tested fork's resolver and reports proxy errors without a local fallback store.
It must pass a fresh stdio protocol test before activation. That test has not yet run for this proposed change.
Keep the locked shim only as rollback evidence. Do not rely on `FORCE_PROXY` to repair its fallback behavior.

The Codex MCP edit is limited to this block; use equivalent targeted JSON edits for Claude and Cursor:

```toml
[mcp_servers.agentmemory]
command = "/opt/homebrew/bin/node"
args = ["/opt/homebrew/lib/node_modules/@agentmemory/agentmemory/plugin/scripts/plugin-bridge.mjs"]

[mcp_servers.agentmemory.env]
AGENTMEMORY_URL = "http://127.0.0.1:3111"
```

Preserve existing unrelated fields, tool approvals, and environment entries after private review.
Preserve existing API authentication. Use the normal local secret resolver; never print or rotate the secret during cutover.
Record only the presence and usability of the secret in the live `.env` and `~/.agentmemory/secret` before the freeze.
Preflight found neither a configured secret nor a stored secret; the effective old worker environment was not inspected.
New startup can generate a secret. If it logs `Generated an API secret`, record that authentication becomes enforced.
Prove every bridge, hook, drain, insight command, and viewer reaches the new daemon through the approved secret resolver.
Check explicit consumer overrides privately; a stale override can supersede the generated file and must be corrected before activation.
Verify existing hook commands resolve to the new package's scripts. Preserve the generated file in the upgraded image and its sealed backup.
Keep that new file out of the original-runtime rollback image. Wrong-secret HTTP 401 remains a release gate.
Set `AGENTMEMORY_URL=http://127.0.0.1:3111`, `AGENTMEMORY_DATA_DIR=/Users/bakman/.agentmemory/data`,
and `AGENTMEMORY_CAPTURE_SPOOL_DIR=/Users/bakman/.agentmemory/data/capture-spool` where hooks and drains need them.
Capture settings alone do not pause HTTP writes. Pause host agent actions and hook execution.
Set the aligned data and spool variables in the existing hook commands or their verified host environment.
Variables in an MCP block do not reach independent lifecycle hooks. A GUI host does not necessarily inherit shell startup settings.
Restart only the affected MCP child connections after activation. Preserve host settings for rollback.
Do not reinstall all skills or replace unrelated harness settings.

After execution approval permits publication, inspect the source diff for private data.
Push only the reviewed branch and create a PR in the fork:

```sh
cd "$HOME/Repos/agentmemory-wt/upstream-0221"
git remote get-url --push origin
git push origin HEAD:refs/heads/codex/upstream-0221
gh pr create --repo mbakman/agentmemory --base main --head codex/upstream-0221 \
  --title "Preserve insights and reflect fixes with iii 0.22.1" --body-file "$CUTOVER_ROOT/pr-body.md"
```

Require the origin URL to be exactly `https://github.com/mbakman/agentmemory.git` before the push.
Use a reviewed PR body. Attach the created PR to this Codex chat. Do not merge it as part of cutover.

## Maintenance phase A: freeze, drain, and seal

Pause ordinary agent work, capture hooks, detached drain children, MCP writers, and direct REST writers.
Run the maintenance executor without capture hooks. This app has no general maintenance or read-only mode.
Record supervisors and verify that stopped production processes cannot respawn.

Record fresh PIDs, full commands, executable hashes, listeners, resolved configuration, and retry/queue state.
Do not signal the historical PIDs from this document without verifying them again.
Check pending work and shutdown logs. A zero invocation count alone cannot prove drain.
Send SIGTERM to the verified worker first. Keep its engine running. Allow 120 seconds; never escalate to SIGKILL.
If the worker remains alive, stop the maintenance sequence and recover service without a competing worker.

After worker exit, capture complete readable native state and stream value lists:

```sh
cd "$HOME/Repos/agentmemory-wt/upstream-0221"
node scripts/preservation/inventory.mjs \
  --sdk "$PACKAGE_CURRENT/node_modules/iii-sdk/dist/index.mjs" \
  --url ws://127.0.0.1:49134 --out "$CUTOVER_ROOT/native-before" \
  --timeout-ms 60000 --max-bytes 536870912 --concurrency 2
```

Use the fresh original package for this inventory. Keep outputs owner-only.
`PACKAGE_CURRENT` selects the old SDK before activation and SDK `0.22.1` after activation. Use the correct phase's SDK for each inventory.
Record queue counts, retry envelopes, active work, and every failed or oversized read.
The inventory lists readable values and preserves duplicates. It cannot prove arbitrary key mapping or enumerate every pending queue payload.
Do not convert failed reads to empty arrays.

Wait at least three configured persistence intervals and at least 15 seconds.
Check stable file hashes, temporary writes, pending work, and unexpected writers.
Copy the candidate stores and load them with the old engine on isolated ports.
Compare the final readable RAM values with that candidate. A detected mismatch blocks final engine shutdown.
Require candidate files to match the final cold archive before using that comparison as archive evidence.
Then send SIGTERM to the verified engine. Allow 30 seconds. Confirm no respawn; run filesystem synchronization.

Copy the complete cold application image, both stores, resolved configuration, package dependencies, engine assets,
embedding cache, durable sidecars, managed hook assets, host settings, and retry state.
Include stale temporary files as forensic evidence. Preserve external evidence references as text.
Exclude unrelated customer dumps and repositories. Keep credentials private.
Use the [full backup path map](cold-backup-restore.md#source-and-archive-path-map).
Compare file coverage, size, SHA-256, relevant metadata, symlinks, and hardlink relationships.
Seal the new archive and record the seal hash outside it.

Before activation, load another independent copy with the exact original runtime.
Compare native values and known recall/insight results. Stop the copy gracefully.
If backup, candidate, or original restore fails, recover unchanged production immediately.
Keep the outage budget at 20 minutes for this phase. Do not force process termination to meet that budget.
If the gate cannot finish within the budget, return to old production and schedule a new freeze and fresh final backup.

## Maintenance phase B: activate and measure

Prepare the new application image as a sibling copy of the fresh cold image.
The old canonical image remains a rollback hold after activation.
Move stale PID files within the new copy to a forensic subdirectory where required.
Do not copy old engine launch metadata into a new identity without reviewing it.
Stage the npm package as a sibling of `/opt/homebrew/lib/node_modules/@agentmemory/agentmemory`.
The two existing `/opt/homebrew/bin` symlinks continue to use this canonical package path.
Preserve the complete original package in a fresh hold directory.

Set the initial worker environment explicitly:

```text
AGENTMEMORY_DATA_DIR=/Users/bakman/.agentmemory/data
AGENTMEMORY_CAPTURE_SPOOL_DIR=/Users/bakman/.agentmemory/data/capture-spool
AGENTMEMORY_STATE_BACKEND=file
AGENTMEMORY_DROP_STALE_INDEX=false
EMBEDDING_PROVIDER=local
AGENTMEMORY_ALLOW_AGENT_SDK=false
FALLBACK_PROVIDERS=
AGENTMEMORY_AUTO_COMPRESS=false
AGENTMEMORY_INJECT_CONTEXT=false
GRAPH_EXTRACTION_ENABLED=false
CONSOLIDATION_ENABLED=false
AGENTMEMORY_SLOTS=false
AGENTMEMORY_REFLECT=false
AUTO_FORGET_ENABLED=false
LESSON_DECAY_ENABLED=false
INSIGHT_DECAY_ENABLED=false
SNAPSHOT_ENABLED=false
CLAUDE_MEMORY_BRIDGE=false
AGENTMEMORY_SESSION_SWEEP_ENABLED=false
AGENTMEMORY_GRAPH_COMPACT_ON_BOOT=false
AGENTMEMORY_AUDIT_RETENTION_MONTHS=0
```

Leave full vector backfill disabled. Do not set `AGENTMEMORY_VECTOR_BACKFILL=all`.
Explicitly blank all provider-key variables in the child environment, while preserving API authentication privately.
Use a reviewed local-only egress profile for the initial engine and worker comparison.
The process environment must override `.env`; an unset variable can be hydrated from that file.
`AGENTMEMORY_PROVIDER=noop` does not disable provider selection. Do not use it as a model-call safeguard.

Rename the original application and package directories to fresh hold paths, then rename the staged replacements into their canonical paths.
Check each destination is absent before every rename. Record each completed operation for reversal.
Preserve both pinned and resolved old engine configuration. Do not overwrite it in place.
Start the exact new engine directly with reviewed YAML and no update check.
Then start the installed app directly with Node and the explicit environment.
Ordinary CLI engine startup removes persisted builtin configuration entries; avoid that path in this procedure.
Require exactly one registered app worker. Additional engine builtin workers and `iii-worker-ops` are expected.

### Execution path and command sheet

These are future execution commands. None ran during planning.
Use a fresh shell and retain the selected variables in the private operation record.
The commands do not replace the gates above.

```sh
umask 077
CUTOVER_ROOT="$(mktemp -d "$HOME/.agentmemory-labs/cutover-execution-XXXXXX")"
CUTOVER_TAG="$(basename "$CUTOVER_ROOT")"
CUTOVER_REPO="$HOME/Repos/agentmemory-wt/upstream-0221"
REHEARSAL_ROOT="$HOME/.agentmemory-labs/cold-20261006.3DMTEk"
TESTED_PACKAGE="$REHEARSAL_ROOT/upgrade-0221/pkg-patched/lib/node_modules/@agentmemory/agentmemory"
PACKAGE_CURRENT=/opt/homebrew/lib/node_modules/@agentmemory/agentmemory
APP_CURRENT="$HOME/.agentmemory"
APP_STAGE="$HOME/.agentmemory.stage-$CUTOVER_TAG"
APP_HOLD="$HOME/.agentmemory.hold-$CUTOVER_TAG"
PACKAGE_STAGE="/opt/homebrew/lib/node_modules/@agentmemory/agentmemory.stage-$CUTOVER_TAG"
PACKAGE_HOLD="/opt/homebrew/lib/node_modules/@agentmemory/agentmemory.hold-$CUTOVER_TAG"
CUT_RELEASE="$HOME/.local/share/agentmemory/releases/iii-0.22.1-$CUTOVER_TAG"
CUT_ASSETS="$CUT_RELEASE/bin"
CUT_ENGINE_TEMPLATE="$CUTOVER_ROOT/config/production-0221.yaml"
CUT_PROFILE="$CUTOVER_ROOT/config/production-local-only.sb"
CUT_RUN="$CUTOVER_ROOT/run-prod"
mkdir -p "$CUT_ASSETS" "$CUTOVER_ROOT/config" "$CUT_RUN" "$CUTOVER_ROOT/tmp" "$CUTOVER_ROOT/logs"
cp -p "$REHEARSAL_ROOT/upgrade-0221/bin/iii" "$CUT_ASSETS/iii"
cp -p "$REHEARSAL_ROOT/upgrade-0221/bin/iii-worker" "$CUT_ASSETS/iii-worker"
cp -p "$REHEARSAL_ROOT/upgrade-0221/bin/iii-console" "$CUT_ASSETS/iii-console"
printf '%s  %s\n' \
  6452e54b05e73bee301e05bd8b75c0a6eb1986d8cb37664c4465859612110ed2 "$CUT_ASSETS/iii" \
  2da172266a0996445442764316d56889a9b533d52cbfd62a7a05120c8fb6daf3 "$CUT_ASSETS/iii-worker" \
  adaa02f693e31c6bc30905c405626e301ffa6ed39b321a669d85b29e394226c2 "$CUT_ASSETS/iii-console" \
  | shasum -a 256 -c -
```

Before copying to `APP_STAGE` or `PACKAGE_STAGE`, require the selected stage and hold paths to be absent.
Copy the tested package with `cp -a "$TESTED_PACKAGE" "$PACKAGE_STAGE"` and compare complete file manifests.
After the new backup seals, copy its `archive/agentmemory` to `APP_STAGE` with the same command form.
Do not stage application credentials in a lab HOME. This copy is the future production image.

Create the reviewed pristine engine YAML from the integrated template. Preserve HTTP timeout `600000`, loopback listeners, and save intervals `2000` ms.
Set state and stream paths to the canonical production paths. Add an explicit worker-manager at loopback `49134`.
Remove `iii-exec` from the staged YAML only. Use an explicit `configuration` worker with filesystem adapter.
Its template directory is a placeholder. `launch-config.mjs` replaces it with a fresh `$CUT_RUN/engine-start-XXXXXX/persisted-config`.
The tool creates that directory empty with owner-only access. Do not pre-create a shared configuration directory.
Review the exact YAML diff before the window.
Use the pinned engine's configuration names; do not carry an old persisted module configuration into this fresh directory.
Never launch the pristine template itself. Engine startup strips seeded builtin blocks from its input YAML.
On every engine start, use `launch-config.mjs` to copy the pristine template into a fresh start directory with empty persisted configuration.
Keep the prior start directories and their rewritten YAML as forensic evidence. Do not reuse the stripped YAML or its persisted configuration.
Preflight proved that reuse can initialize the state adapter in memory. An empty inventory cannot detect that fault.
The corrected mapped test preserves nonempty state and stream values across restart with a fresh seed on both starts.
The worker's audit delay and capture durability estimate read `data/iii-config.runtime.yaml` and the recognized persisted state YAML paths.
They do not discover this new YAML path automatically. Inspect those paths in the staged copy and record the computed interval.
Accept the conservative `5000` ms fallback when those paths are absent; it is longer than the engine's `2000` ms interval.
If a stale readable configuration produces a smaller interval, block launch and correct the staged configuration through a reviewed edit.
Keep the 15-second minimum drain. A timer estimate is not a flush barrier.

Create and test the exact local-only Seatbelt profile before the window.
Allow normal file, process, Mach, and signal access. Deny external networking.
Allow bind, inbound, and outbound traffic only on loopback `3111`, `3112`, `3113`, and `49134`.
Run positive and negative network probes and an isolated startup with copied assets and mapped trial ports.
Do not claim the production profile is tested from the earlier lab result.

Use a shared shell environment array for the two reviewed launch commands:

```sh
CUT_ENV=(
  "HOME=/Users/bakman" "TMPDIR=$CUTOVER_ROOT/tmp"
  "PATH=$CUT_ASSETS:/opt/homebrew/bin:/usr/bin:/bin:/Users/bakman/.local/bin"
  "AGENTMEMORY_DATA_DIR=/Users/bakman/.agentmemory/data"
  "AGENTMEMORY_RUNTIME_DIR=/Users/bakman/.agentmemory"
  "AGENTMEMORY_CAPTURE_SPOOL_DIR=/Users/bakman/.agentmemory/data/capture-spool"
  "AGENTMEMORY_URL=http://127.0.0.1:3111" "AGENTMEMORY_VERBOSE=1"
  "AGENTMEMORY_TOOLS=all"
  "III_ENGINE_URL=ws://127.0.0.1:49134" "III_ENGINE_PORT=49134"
  "III_REST_PORT=3111" "III_STREAM_PORT=3112" "III_STREAMS_PORT=3112" "III_VIEWER_PORT=3113"
  "III_TELEMETRY_ENABLED=false" "OTEL_ENABLED=false"
  "OPENAI_API_KEY=" "MINIMAX_API_KEY=" "ANTHROPIC_API_KEY="
  "GEMINI_API_KEY=" "GOOGLE_API_KEY=" "OPENROUTER_API_KEY=" "FALLBACK_PROVIDERS="
  "EMBEDDING_PROVIDER=local" "AGENTMEMORY_IMAGE_EMBEDDINGS=false"
  "AGENTMEMORY_STATE_BACKEND=file" "AGENTMEMORY_DROP_STALE_INDEX=false"
  "AGENTMEMORY_VECTOR_BACKFILL="
  "AGENTMEMORY_INDEX_SAVE_INTERVAL_MS=600000"
  "AGENTMEMORY_ALLOW_AGENT_SDK=false" "AGENTMEMORY_AUTO_COMPRESS=false" "AGENTMEMORY_INJECT_CONTEXT=false"
  "GRAPH_EXTRACTION_ENABLED=false" "CONSOLIDATION_ENABLED=false"
  "AGENTMEMORY_SLOTS=false" "AGENTMEMORY_REFLECT=false"
  "AUTO_FORGET_ENABLED=false" "LESSON_DECAY_ENABLED=false" "INSIGHT_DECAY_ENABLED=false"
  "SNAPSHOT_ENABLED=false" "CLAUDE_MEMORY_BRIDGE=false"
  "AGENTMEMORY_SESSION_SWEEP_ENABLED=false" "AGENTMEMORY_GRAPH_COMPACT_ON_BOOT=false"
  "AGENTMEMORY_AUDIT_RETENTION_MONTHS=0"
)
```

The existing `.env` supplies local API authentication privately. Blank provider keys override its provider credentials.
Do not print the merged environment. Do not set `AGENTMEMORY_SECRET` to an empty value as a pause mechanism.
The model cache inside `node_modules/@huggingface/transformers/.cache` must match the tested image.
The selected `pkg-patched` tree includes the cache used by the full runtime rehearsal.
The installed CLI matrix tree does not contain this cache. Do not substitute that tree without copying and checking the cache separately.
The selected bridge's SHA-256 matches the source build; preserve that equality and still run its actual stdio protocol test.

Only after cold backup and restore pass, perform the reviewed renames:

```sh
(
  set -eu
  test -d "$APP_STAGE"
  test ! -e "$APP_HOLD"
  test ! -L "$APP_HOLD"
  test -d "$PACKAGE_STAGE"
  test ! -e "$PACKAGE_HOLD"
  test ! -L "$PACKAGE_HOLD"
  mv "$APP_CURRENT" "$APP_HOLD"
  mv "$APP_STAGE" "$APP_CURRENT"
  mv "$PACKAGE_CURRENT" "$PACKAGE_HOLD"
  mv "$PACKAGE_STAGE" "$PACKAGE_CURRENT"
)
```

Treat a failed precondition or command as a stop. Run commands individually and record completion after each command.
These four operations are not one atomic transaction. Reverse only the operations that completed.
Move old `iii.pid`, `worker.pid`, `engine-state.json`, and any legacy `engine.json`, if present in the new copy, to its forensic directory before launch.
Direct engine launch does not create the CLI's engine metadata. Record its actual PID and hash separately.
The direct app manages its own `worker.pid`. Never use a stale engine PID file as signal authority.

Before each engine start, prepare and record its fresh seed. Run this again for the required restart:

```sh
set -eu
cd "$CUTOVER_REPO"
CUT_START_RECORD="$(mktemp "$CUTOVER_ROOT/config/engine-start-XXXXXX.json")"
node scripts/preservation/launch-config.mjs "$CUT_ENGINE_TEMPLATE" "$CUT_RUN" > "$CUT_START_RECORD"
CUT_ENGINE_CONFIG="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).config)' "$CUT_START_RECORD")"
test -f "$CUT_ENGINE_CONFIG"
```

The preparation command requires explicit state and stream file stores. A stripped YAML fails that check.
It changes only the configuration directory. State and stream storage paths stay at their reviewed locations.
It does not start or stop any process. The shell stops on preparation failure before any engine launch.

In one supervised terminal, launch the engine and capture private logs:

```sh
cd "$CUT_RUN"
env -i "${CUT_ENV[@]}" /usr/bin/sandbox-exec -f "$CUT_PROFILE" \
  "$CUT_ASSETS/iii" --config "$CUT_ENGINE_CONFIG" --no-update-check \
  > "$CUTOVER_ROOT/logs/engine-first.log" 2>&1
```

After engine-only inventory passes, use a second supervised terminal with the same recorded environment array:

```sh
cd "$CUT_RUN"
env -i "${CUT_ENV[@]}" /usr/bin/sandbox-exec -f "$CUT_PROFILE" \
  /opt/homebrew/bin/node "$PACKAGE_CURRENT/dist/index.mjs" \
  > "$CUTOVER_ROOT/logs/worker-first.log" 2>&1
```

Keep the operator connection or persistent tmux sessions alive. Record the worker and engine identities from the listeners and native worker list.
Use fresh log names on every start. Direct Node avoids CLI onboarding and configuration removal.
The initial index checkpoint interval is pinned to `600000` ms. Record its effective status value and the engine state/stream intervals.
Functional writes can remain pending until that checkpoint. The required restart flush must preserve them before writer release.

Capture an engine-only inventory before the app starts. Compare it with the fresh old-runtime baseline.
After app startup, capture migration values before functional writes.
Compare protected records, raw observation sources, sessions, slots, cooldowns, streams, and index contents.
Compare vector ID, session, dimension, and Float32 bytes. Preserve duplicate audit values.
Apply only proved migration changes: v3 vector buckets, monthly audit migration, verified session index metadata, and measured capture recovery.
Do not hard-code the earlier record counts. Derive the expected sets from this fresh backup.
Record stock `index_persist` audit removal as an explicit policy change; the fresh archive retains those rows.
Any unexplained loss, truncation, read gap, or index mismatch blocks acceptance.
Keep raw blockers and each separate reviewed exception.

`Ready` and `livez.viewerPort` alone do not prove index readiness.
The app can log a rebuild failure and then emit `Ready` at [src/index.ts](../src/index.ts).
MCP `initialize` also succeeds without backend access; it cannot replace the actual `tools/list` and known-query checks.
Run the consumer probe after the status and index readiness gates.
Use `--known-id` for Phase-B recall acceptance. Exact result hashes used in the old-runtime self-test can change after index coverage improves.
Inspect authenticated `GET /agentmemory/status` through the existing secret resolver.
Require these measured gates:

- The viewer uses `3113`; state connectivity is good; the app engine version matches `0.22.1`.
- The actual engine PID, executable hash, and SDK registration match the release. The status version field alone is insufficient.
- `index.keywordRebuildRunning` and `index.bm25Incomplete` are false.
- BM25 count and breakdown match the fresh source-derived eligible set.
- Existing vectors retain their bytes. Any incremental vector additions have identified source records.
- Index persistence has no save in progress, pending changes, pending log error, or vector shortfall.
- Audit migration is done. Startup capture recovery and pruning are measured and explained.
- No fatal, migration, loader, index flush, or unexpected helper error appears in the logs.
- Check health connectivity and non-memory faults. RAM pressure or heap alerts alone do not block acceptance under the user's waiver.

Use a 120-second initial readiness observation window. If it fails, inspect actual progress before deciding recovery.
Do not promote the runtime because a timeout expired or a listener answered.

## Acceptance checks and release of writers

Keep ordinary consumers paused until all checks pass:

1. Known recall returns the baseline IDs; steady queries complete within 10 seconds.
2. Both installed insight commands return the expected IDs and obey limit two. A native empty result is a real empty result.
   Keep insight search inside its required CLI help guard. Authentication and backend failures remain distinct from empty results.
3. The actual pinned MCP consumer initializes and returns the approved tool inventory.
   In the full-tool profile, require 54 remote tools and a known recall hit. Reject seven-tool fallback and fallback stderr.
   Wrong authentication and an unused port must produce visible failures through the proposed bridge.
   Check Codex, Claude, and Cursor separately. Reuse existing credentials through their normal resolver.
4. Send one identified capture fixture through the installed hook. Verify the receipt, one stored observation, and exact raw payload hash.
   Replay it and require deduplication. Record the fixture delta separately from migration.
   `agentmemory capture --json` can exit zero with `server.error`; inspect the JSON fields too.
5. Stop the new worker gracefully, drain the engine, capture the native inventory, stop the engine, and restart both.
   Recheck persistence, known queries, viewer, MCP authentication, capture payload, and replay deduplication.
   Keep the same verified egress profile and initial environment during this restart. Record the new post-restart PIDs and hashes.
6. Observe ten minutes with writers paused. Check queue/capture state, index errors, and process identities.

The new worker has a four-second flush bound and an eight-second internal exit timer.
A shutdown exit alone does not prove an index flush. Flush warnings or an internal hard exit block the restart proof.
The executor never adds forced termination.

After acceptance, resume capture and ordinary consumers with pinned commands and aligned paths.
Keep generation, decay, retention, graph compaction, and full vector backfill disabled during the first service observation period.
Do not silently restore all previous feature flags. Re-enable the prior approved features in a separate recorded step after service acceptance.
The current production flags include compression, consolidation, slots, reflect, and lesson decay.
Preserve those settings privately so their temporary disablement is visible and reversible.

## Rollback and preservation of later writes

Before ordinary writers resume, rollback restores the fresh pre-cutover image and exact original runtime together.
Only measured startup changes and identified test writes occur in this phase.
First stop the new worker and engine gracefully, with the same drain and checksum checks.
Preserve the complete upgraded image, logs, and test receipts in a fresh sealed hold.
Reverse the recorded package and application renames. Restore reviewed original configuration and launch assets.
Start the exact old engine, then the old worker. Check recall, both insight commands, viewer, authentication, and capture settings.
Keep the failed upgraded image for investigation. Do not delete it.

For a completed activation, first seal the stopped upgraded image and preserve changed host settings.
After that seal passes, the reverse path uses fresh sibling names:

```sh
APP_FAILED="$HOME/.agentmemory.failed-$CUTOVER_TAG"
PACKAGE_FAILED="/opt/homebrew/lib/node_modules/@agentmemory/agentmemory.failed-$CUTOVER_TAG"
(
  set -eu
  test -d "$APP_HOLD"
  test ! -e "$APP_FAILED"
  test ! -L "$APP_FAILED"
  test -d "$PACKAGE_HOLD"
  test ! -e "$PACKAGE_FAILED"
  test ! -L "$PACKAGE_FAILED"
  mv "$APP_CURRENT" "$APP_FAILED"
  mv "$APP_HOLD" "$APP_CURRENT"
  mv "$PACKAGE_CURRENT" "$PACKAGE_FAILED"
  mv "$PACKAGE_HOLD" "$PACKAGE_CURRENT"
)
```

Run this block only when all four activation renames completed and both new processes stopped gracefully.
For partial activation, use the recorded operation list to reverse only completed operations.
Restore only the changed agentmemory blocks and hook commands in host settings. Do not replace unrelated settings wholesale.
The old package may not contain the new bridge. Restore its prior consumer command before reconnecting hosts.
The original `.local/bin` engine assets were retained. Use the pinned recovery environment below with the restored package.
Preserve the original environment privately. The initial provider-key blanks must not become rollback settings.

After ordinary writers resume, an older backup does not contain their new writes.
There is no demonstrated generic lossless replay for all engine stores.
Export/import does not cover arbitrary config, slots, capture state, streams, and audits. Do not use it as a full restore.
If later rollback is needed, pause every writer and take a new complete cold image of the upgraded state first.
That image must include the versioned release, explicit engine YAML, filesystem configuration directory, launch environment,
network profile, host settings, complete npm tree, and embedding cache, in addition to the application and both stores.
Preserve all source payloads, updates, tombstones, capture receipts, pending spool records, slots, cooldowns, streams, and audit values.
Restore the old runtime and its pre-cutover stores on a separate copy.
Reconcile later writes with a separately reviewed and tested procedure before declaring all new memory available on the old runtime.
Do not replay an old spool blindly into the wrong generation.

This plan makes no automatic zero-loss rollback promise after ordinary writes resume.
The later image protects the new data physically; it does not make that data readable in the old runtime automatically.
Before writer release, accept this boundary or require a separate reconciliation implementation.
For an urgent service rollback, report the exact data visibility window and keep the later image sealed.
If this boundary is unacceptable, keep writers paused and block release until a reconciliation procedure is proved.

Recovery before activation uses the original configuration and package unchanged:

```sh
cd "$HOME"
RECOVERY_PATH=/Users/bakman/.local/bin:/opt/homebrew/bin:/usr/bin:/bin
env PATH="$RECOVERY_PATH" /bin/sh -c 'command -v iii; iii --version; command -v node; node --version'
```

Require `/Users/bakman/.local/bin/iii`, engine `0.11.2`, and the recorded Node path/version and executable hashes.
The currently verified old engine hash is `341d45266f39ed78e30d4b3d74730662fe97e7706e1a23a5c877646462215ca8`.
This PATH resolution and engine version were checked during planning. Repeat them before the window and any recovery.
Do not execute recovery through `CUT_ENV`. Do not inherit the new release PATH, network profile, or feature overrides.
Prepare an owner-only original launch environment before shutdown. Keep its credentials private.
Use a fresh original shell environment, unset newer launch overrides, and pin the old PATH:

```sh
cd "$HOME"
env -u AGENTMEMORY_III_VERSION -u III_ENGINE_URL -u III_ENGINE_PORT \
  -u III_REST_PORT -u III_STREAM_PORT -u III_STREAMS_PORT -u III_VIEWER_PORT \
  -u AGENTMEMORY_URL -u AGENTMEMORY_DATA_DIR -u AGENTMEMORY_RUNTIME_DIR \
  -u AGENTMEMORY_STATE_BACKEND -u AGENTMEMORY_DROP_STALE_INDEX -u AGENTMEMORY_IMAGE_EMBEDDINGS \
  -u AGENTMEMORY_TOOLS -u EMBEDDING_PROVIDER -u AGENTMEMORY_VERBOSE \
  -u AGENTMEMORY_CAPTURE_SPOOL_DIR -u AGENTMEMORY_VECTOR_BACKFILL \
  -u AGENTMEMORY_INDEX_SAVE_INTERVAL_MS \
  -u AGENTMEMORY_ALLOW_AGENT_SDK -u AGENTMEMORY_AUTO_COMPRESS -u AGENTMEMORY_INJECT_CONTEXT \
  -u GRAPH_EXTRACTION_ENABLED -u CONSOLIDATION_ENABLED -u AGENTMEMORY_SLOTS -u AGENTMEMORY_REFLECT \
  -u AUTO_FORGET_ENABLED -u LESSON_DECAY_ENABLED -u INSIGHT_DECAY_ENABLED \
  -u SNAPSHOT_ENABLED -u CLAUDE_MEMORY_BRIDGE -u AGENTMEMORY_SESSION_SWEEP_ENABLED \
  -u AGENTMEMORY_GRAPH_COMPACT_ON_BOOT -u AGENTMEMORY_AUDIT_RETENTION_MONTHS \
  PATH="$RECOVERY_PATH" AGENTMEMORY_III_CONFIG="$HOME/.agentmemory/iii-config.yaml" \
  /opt/homebrew/bin/agentmemory --verbose 2>&1 | tee -i -a "$HOME/.agentmemory/server.log"
```

The archived original `.env` and required original parent credentials remain the source for the old runtime.
Verify the effective original flags privately. If the recorded launch needs an explicit parent override, restore that exact approved value.
Stop if any original value cannot be recovered; do not substitute a new provider or permit an automatic engine install.
Use `--no-engine` only when the verified original engine remains alive.
For that worker-only case, use the same pinned recovery environment with `--no-engine --verbose` as the CLI arguments.
Never use `agentmemory stop`, SIGKILL, cleanup deletion, or binary-only rollback.

## Completion evidence and remaining work

Save the fresh seal, all physical comparisons, native inventories, migration exceptions, coverage sets, runtime hashes,
consumer pins, applied settings diffs, functional results, restart results, rollback result, and Fable verdict privately.
Publish only source and a sanitized PR description to the fork.
Update this document with actual versions, paths, IDs, times, and gate results during execution.

Separate maintenance items remain: the pre-existing vector gap, records outside the session walk, malformed session metadata,
dependency findings, and a complete reconciliation mechanism for writes after cutover.
Do not fix these by deletion or combine them with the cutover.
