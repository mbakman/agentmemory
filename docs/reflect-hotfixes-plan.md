# Persist the reflect hotfixes

Status: complete on 2026-10-05. Source implementation, tests, clean npm installations, and live deployment are verified. Both Fable reviews returned READY. Source commit `ff0c2f8f237caee41fc4872d937f83d87dd59e89` is pushed to `origin/fix/reflect-hotfixes`.

## Intent and goal

Make the reflect hotfixes part of the fork source. Prove that clean npm installations retain the fixes.
Keep the completed insight CLI work separate from this maintenance work.

The issue is a difference between source and installation. The installed bundles contain fixes that the source does not contain.
An npm installation replaces those bundles. Manual bundle patches therefore do not provide a reproducible release.

The deliverables are a separate worktree and branch, source changes, regression tests, configuration documentation, a verified tarball, and deployment evidence.
The deployment record must include a rollback procedure and proof that the daemon uses the live stores.

## Verified starting point

Checked on 2026-10-05:

- Canonical repository: `/Users/bakman/Repos/agentmemory`.
- Source commit: `2cde0bb8c6df9eaaf5ffffdb0e04096992503aab`, branch `fix/insights-cli`.
- Fork: `https://github.com/mbakman/agentmemory.git`; upstream: `https://github.com/rohitg00/agentmemory.git`.
- No linked worktree or `fix/reflect-hotfixes` branch exists.
- Preserve the existing untracked `docs/insights-cli-progress.md`.
- Package version is `0.9.29`. The SDK dependency and installed engine are `0.11.2`.
- Source worker and HTTP template timeouts remain `180000` milliseconds.
- Installed bundles contain the reflect cooldown, prompt budget, and `600000` millisecond worker timeout.
- The liveness endpoint returns `status: ok`. Guarded native insight search returns one real result with `truncated: true`.
- Worker PID `7449` and engine PID `7470` match the existing PID files. Recapture process identities before deployment.
- The engine uses `/Users/bakman/data/iii-config.yaml`. That file matches the pinned template byte for byte.
- The pinned template uses `/Users/bakman/.agentmemory/data/state_store.db` and `/Users/bakman/.agentmemory/data/stream_store`.
- `npm exec -- tsc --noEmit` reports 30 existing errors. The command exits with status 2.
- Baseline log: `/tmp/agentmemory-reflect-plan.bHz0FT/tsc-baseline.log`. One existing error is in `src/triggers/events.ts`.

Archive authority: `/Users/bakman/.agentmemory/backups/dist-patched-v2-0.9.29-20261003/`.

- `patches-a-g.src.diff`: SHA-256 `edc9c7f6f37b5262781ca166dc28bddbeff7ca272ea2d4013d01f577022b5214`.
- `patches-a-g.index.diff`: SHA-256 `e56024c928710d35b8bf0fd1fa5b00f0cf49dd46bdb59321d7849ca1b770f916`.

Both checksums match the archive manifest. The pristine archive already contains the separate timeout patch.
The a-g diffs therefore do not describe the timeout change.

## Source changes and tests

Create the sibling worktree `/Users/bakman/Repos/agentmemory-wt/reflect-hotfixes` on branch `fix/reflect-hotfixes` from the exact source commit above.
Keep the worktree outside the main checkout. A nested worktree would cause duplicate Vitest test discovery.
Use the canonical `~/Repos/` path for navigation. Git can record the physical path behind that symlink.
Copy this plan into the new worktree for the maintenance commit. No local Git exclude change is required.
Preserve the original progress file and unrelated work. Install project dependencies through npm in the new worktree.

Port the archive behavior into TypeScript. Export and reuse `withTimeout`, `LIVE_ENUMERATION_BUDGET_MS`, and `readSnapshot` from `src/functions/graph.ts`.
Import `logger` from `../logger.js` in reflect and graph retrieval. Import `getEnvVar` from `../config.js` in reflect.
Capture each cooldown timestamp with `new Date().toISOString()`. Do not import the private `nowIso` helper from slots.
The advisor found no import cycle through the existing graph helper dependencies.
Keep iii-engine as the state and invocation layer. Keep the package version, dependencies, endpoints, and MCP tools unchanged.

| Behavior | Source change | Required regression coverage |
| --- | --- | --- |
| Graph snapshot | Reflect reads `KV.graphSnapshot/current` through `readSnapshot()`. It uses `topNodes` and `topEdges`. | Seed version-1 snapshots in reflect fixtures. Test absent, empty, wrong-version, and failed reads. Assert no live graph enumeration. |
| Graph retrieval | Both retrieval methods enumerate nodes and edges concurrently. Use the existing six-second timeout. Warn and return an empty graph stream on failure. | Test both methods, concurrent starts, either read rejecting, deadline boundaries, late results, stale filtering, and successful limits. |
| Clustering | Continue after visited seeds. Cap each cluster at 15 concepts. Use the node ID map. Limit Jaccard seeds and peers to 300. | Test disconnected clusters, both cluster caps, frequency bounds, ordering, and the seed limit. |
| Selected records | Select the ten strongest facts, ten strongest active lessons, and five newest crystals. Require at least three supporting records. | Test selection order, caps, support threshold, and unique fixture IDs. |
| Prompt budget | Default to 12000 characters. Apply the 2000 minimum to valid positive settings. Truncate items after 800 characters and append an ellipsis. Keep complete lines. | Add `test/reflect-prompt.test.ts`. Test defaults, invalid settings, minimum, custom values, ordering, complete lines, and unchanged input arrays. |
| Cooldown | Store normalized concept keys in `KV.config` at `reflect:recentClusters`. Default to seven days. Return and audit `clustersCooledDown`. | Test normalization, duration overrides, zero, invalid values, expiry boundary, skipped synthesis, persistence failures, counters, and pipeline forwarding. |
| Session extraction | Gate the session-stop observation read and extraction trigger with `isGraphExtractionEnabled()`. Preserve direct graph-function behavior. | Test enabled, disabled, empty, and failed reads. Preserve independent summary, slot-reflect, consolidation, and debounce behavior. |

Preserve these archive details:

- Jaccard frequency is between 2 and `max(2, floor(totalDocs * 0.25))`, inclusive. Sort by descending frequency.
- The prompt setting reads raw `process.env.AGENTMEMORY_REFLECT_PROMPT_CHARS`. Preserve the unbounded concept header.
- Prompt truncation does not remove the IDs of selected source records from the insight provenance.
- The cooldown setting uses `getEnvVar("AGENTMEMORY_REFLECT_CLUSTER_COOLDOWN_MS")`. Invalid or negative values use the default.
- A cooldown value of zero disables cooldown reads and writes. A timestamp exactly at the cutoff remains valid.
- Cooldown keys use lowercase, unique, sorted concept names joined with `|`. Preserve their shared scope across projects.
- Stamp the cooldown after synthesis resolves, before parsing or insight persistence.
- Empty or malformed output and later insight-write failures still stamp the cooldown. Provider rejection does not stamp it.
- Persist the cooldown once when changed. Log persistence failures without failing the reflect response.
- Preserve the nested consolidation result. Pipeline `force` does not bypass the reflect cooldown.
- The graph timeout does not cancel the underlying state reads.

Update the conflicting wiring assertion at `test/graph-heuristic-extract.test.ts:95` and the unconditional-extraction comment at `src/triggers/events.ts:110`.
Require the gate before the session-stop extraction trigger. Preserve the direct heuristic and function-registration assertions at test lines 104-118.
Keep manual graph extraction and graph-build endpoints unchanged. The archive gate applies only to the session-stop caller.
Convert the reflect synthesis, insufficient-support, and reinforcement fixtures at `test/reflect.test.ts:153`, `:180`, and `:196` to version-1 snapshots.
Convert the provider-failure fixture at `:236` too, so it exercises rejection through graph clustering.
Include `topNodes`, `topEdges`, `topDegrees`, `stats`, `updatedAt`, and `dirty` in each snapshot fixture.
Add a case where live nodes exist without a snapshot; require `usedFallback: true`.
Set `AGENTMEMORY_REFLECT_CLUSTER_COOLDOWN_MS=0` in the immediate reinforcement test and restore the setting after the test.
Use controlled environment settings and fake time in cooldown tests.

Set `invocationTimeoutMs` in `src/index.ts` and `default_timeout` in both shipped HTTP templates to `600000` milliseconds.
The Docker HTTP template extension is intentional. It aligns the two npm-shipped templates with the longer worker timeout.
The archive Docker template has `180000`. Leave separate deployment and evaluation scripts outside this maintenance change.
Keep the separate provider timeout unchanged. Keep host-specific store paths in the pinned runtime configuration.
Document the two reflect settings in `.env.example` and README. Regenerate the skill configuration reference through `npm run skills:gen`.
Inspect generated changes and include only files required by this maintenance work.

## Verification and deployment

1. Run focused regressions, `npm run build`, `npm test`, `npm run skills:check`, and `git diff --check`.
   Compare TypeScript diagnostics against the recorded baseline. Compare diagnostic signatures without line numbers; report any new errors.
2. Pack the source build with `npm pack --pack-destination <fresh scratch directory>`.
   Install the same tarball into two fresh npm prefixes. Include optional dependencies, as in the production installation.
   Keep npm lifecycle and permission controls intact. Do not use `--omit=optional`.
3. Compare installed `dist` files and configuration templates against the source build and each other.
   Inspect installed bundles with `rg -a` for cooldown counters, the cooldown key, graph retrieval timeout, and the longer worker timeout.
   Match `clustersCooledDown`, `reflect:recentClusters`, `graph-retrieval enumeration`, and `invocationTimeoutMs: 6e5` in the JavaScript bundles.
   Verify both installed HTTP templates contain `default_timeout: 600000`. This checks required content as well as byte parity.
   Run the existing installed entrypoint suite against each prefix by setting its `PATH` explicitly.
   Use mock HTTP servers for these checks. Do not import server bundles or register a second live worker.
4. Request the second Fable advisor review after source, tests, and package proof. Resolve findings before global installation.
5. Capture fresh liveness, insight, observation recall, process, configuration, and store baselines.
   Include `~/.agentmemory/engine-state.json`, `iii.pid`, and `worker.pid` in the metadata baseline and durable backup.
   Use known observation hits. An empty MCP recall response does not prove a healthy read path.
6. Archive the installed patched package and pinned configuration under a fresh durable backup directory.
   Preserve any required embedding cache. Record the tested and rollback tarball checksums.
7. Send SIGTERM to the identified worker, then to the detached engine. Wait until both processes retire.
   Do not use `agentmemory stop`, SIGKILL, manual PID-file deletion, or store cleanup.
   If either process survives, stop deployment and report the process identity.
8. Install the verified tarball with `/opt/homebrew/bin/npm install --global --prefix /opt/homebrew <tarball> --no-audit --no-fund`.
   Restart through the existing tmux session with `AGENTMEMORY_III_CONFIG=$HOME/.agentmemory/iii-config.yaml` explicitly set.
   Launch from `$HOME` and retain the current data-directory resolution. Do not add a new `--data-dir` override.
   Capture startup output in the existing server log. This operation has a brief planned service interruption.
9. Verify one worker and one engine, PID-file agreement, pinned configuration, and live state and stream paths.
   Compare the engine's resolved `/Users/bakman/data/iii-config.yaml` against the pinned template.
   A rewrite of that configuration file is expected. Require stale `~/data/state_store.db` and `~/data/stream_store` modification times to remain unchanged.
   Verify liveness and observation recall hits. If stale process metadata blocks startup, report it without manual metadata deletion.
   Test both installed insight entrypoints and run the installed entrypoint suite.
   Run one reflect-only consolidation. Verify response counters and logs, including the absence of `Reflect tier failed`.
10. If validation fails, stop the new worker and engine gracefully. Reinstall the rollback tarball and restore the pinned configuration.
    Restart with the same explicit configuration setting. Preserve database writes and all stores.

Record exact commands, outputs, package checksums, and archive-to-source-to-test references in this plan as implementation proceeds.
Commit and push `fix/reflect-hotfixes` with author and committer `Baha Akman <bakman@nvidia.com>`.
Do not add a co-author trailer. A merge or pull request is outside this plan.

Reinstall the tested fork artifact to retain these fixes. A registry installation of upstream `0.9.29` does not contain the source port.

## Advisor reviews and completion criteria

Use `claude-fable-5-1`, effort `max`, and `ultracode: false` for consultation only.
Use strict read-only tools. Codex retains implementation and deployment control.

- First review: archive mapping, source plan, test coverage, packaging proof, and rollout procedure.
- Second review: final source diff, test evidence, tarball contents, and deployment readiness.
- Additional consultation: only for an unresolved failure or behavior conflict. Reuse the advisor session.

First advisor session: `faf8acd8-409c-436f-a9b6-6b0353e8f48a`. Runtime messages confirm model `claude-fable-5-1`.
The first review returned `NEEDS CHANGES`. The focused revision review returned `READY`, with no OPEN findings.
All nine findings are CLOSED in this plan. This disposition does not claim that source implementation is complete:

- F1: Correct the conflicting graph gate test and comment. Limit the gate to the session-stop caller.
- F2: Convert the three graph fixtures to snapshots. Disable cooldown in the immediate reinforcement test.
- F3: Use a sibling worktree outside the main Vitest discovery tree.
- F4: Name the required imports, helper exports, and timestamp expression.
- F5: State the intentional Docker template extension. Keep host paths in the runtime configuration.
- F6: Check the rendered configuration file and stale stores separately. Capture process metadata.
- F7: Check installed behavior and required bundle content, with explicit prefix paths and production optional dependencies.
- F8: Inspect generated skill references and hook scripts before commit.
- F9: Preserve archive boundary behavior and use fake timers for timeout tests.

The focused disposition completed the first review on 2026-10-05.
The advisor also confirmed the emitted timeout notation and recommended the additional provider-failure snapshot fixture. Both are included above.
The second review completed on 2026-10-05 with verdict READY. It confirmed archive parity and the required regression coverage. All F1-F9 findings remain CLOSED.
The advisor used `claude-fable-5-1` with its native 1000000-token context window, effort `max`, and fast mode off. Review transcript: `/tmp/agentmemory-reflect-implementation.BcVL5P/fable-implementation-review.md`.
The only new documentation finding was corrected: `.env.example` now names the 600-second worker timeout. Provider budgets remain unchanged.

Implementation is complete only when source, regression tests, clean installations, installed commands, and live daemon validation pass.
The implementation evidence must show that no manual bundle patches are required after installation.

## Implementation progress

- Created sibling worktree `~/Repos/agentmemory-wt/reflect-hotfixes`, branch `fix/reflect-hotfixes`, from `2cde0bb8c6df9eaaf5ffffdb0e04096992503aab`.
- Preserved the main checkout and its two untracked documentation files.
- `npm install --no-audit --no-fund` added 266 packages. Existing npm script gates remain active.
- Source ports, regression tests, timeout changes, and configuration documentation are complete.
- `npm run build` completed in 3714 ms. `npm test` passed 154 test files and 1924 tests; one file and one test were skipped by the existing suite.
- Focused graph and event tests passed 64 tests. Focused reflect, prompt, and pipeline tests passed 77 tests.
- `npm run skills:check` passed all 17 skills. `git diff --check` reported no errors. Generated changes affect only the configuration reference.
- `npm exec -- tsc --noEmit` still reports 30 errors and exits 2. Sorted diagnostic signatures, with line and column numbers removed, exactly match the baseline.
- Pre-review tarball SHA-256: `83f2391dbe44286b0bd73a82dc1f59954ad54f3710d91e60dd34e74bc50fb0b5`. After the advisor's comment correction, rebuilt successfully in 3383 ms and packed the final artifact.
- Final tarball: `/tmp/agentmemory-reflect-implementation.BcVL5P/final-package/agentmemory-agentmemory-0.9.29.tgz`. Durable copy: `/Users/bakman/.agentmemory/backups/reflect-source-port.5E8cTs/tested-fork-0.9.29.tgz`. SHA-256: `8f1d6df04cc496c2ef1d6d152e4f196c0d10fdcc466ddd9b8ec439ccb2f73718`.
- Installed that tarball with optional dependencies into two fresh prefixes under `/tmp/agentmemory-reflect-implementation.BcVL5P/`. Each added 186 packages. Existing npm script gates remain active.
- Both installed `dist` trees match the source build byte for byte. Required graph timeout, cooldown, counter, and worker timeout markers are present.
- Each prefix passed `PATH=<prefix>/bin:$PATH AGENTMEMORY_TEST_INSTALLED=1 npm exec -- vitest run test/insights-cli-entrypoints.test.ts`: 91 tests per prefix. These tests use mock HTTP servers and cover both commands, limits, empty results, authentication, connection failure, timeout, and malformed responses.
- Durable rollback package, pinned configuration, process metadata, and embedding cache are saved at `/Users/bakman/.agentmemory/backups/reflect-source-port.5E8cTs/`. Rollback tarball SHA-256: `d1e0f9f8b4ce81e87cdb6f22cf718a69a888693f1cebee6540aa642a56fe163f`.
- Build, test, TypeScript, package, and clean-prefix logs are in `/tmp/agentmemory-reflect-implementation.BcVL5P/`. Durable deployment evidence is in `/Users/bakman/.agentmemory/backups/reflect-source-port.5E8cTs/`.
- Final artifact checks use two additional fresh prefixes (`prefix-3` and `prefix-4`) after the comment correction. Both installed builds and HTTP templates match the final source build byte for byte.
- Fresh runtime baseline records worker 7449, engine 7470, liveness `ok`, insight `ins_140c66d4d16bc568`, and observation hits `obs_muvumwgk_781043bb2a13` and `obs_muvvajn3_3eefae21dfab`.
- Captured 1109 stale-store path, modification-time, change-time, and size records. Saved fresh process metadata and the server-log byte offset in the durable backup. Resolved and pinned engine configurations match byte for byte.
- Both final clean prefixes passed 91 installed command tests each. The final global installation passed the same 91 tests.
- Sent SIGTERM to worker 7449 and then engine 7470. Both retired gracefully. Installed the exact final tarball with `/opt/homebrew/bin/npm install --global --prefix /opt/homebrew /Users/bakman/.agentmemory/backups/reflect-source-port.5E8cTs/tested-fork-0.9.29.tgz --no-audit --no-fund`: 186 packages changed in six seconds. Optional dependencies were included; npm script gates remained active.
- Compared the global `dist` tree and both HTTP templates against the final build: no differences. Restored the saved embedding cache as data; no bundle edits were made.
- Restarted `agentmemory:0.0` from `$HOME` with `AGENTMEMORY_III_CONFIG="$HOME/.agentmemory/iii-config.yaml" /opt/homebrew/bin/agentmemory --verbose 2>&1 | tee -i -a "$HOME/.agentmemory/server.log"`.
- The deployment window began at 23:28:18 UTC; liveness returned `ok` at 23:29:53 UTC. Initial WebSocket reconnection completed without a restart or rollback. The later liveness check reports streams port 3112 and viewer port 3113.
- Exactly one worker (40519) and one engine (40542) match the new PID files. Engine metadata and resolved configuration retain `/Users/bakman/data/iii-config.yaml`; it matches the pinned configuration byte for byte. The live state and stream paths remain under `/Users/bakman/.agentmemory/data/`.
- All 1109 stale-store metadata records remained unchanged through deployment and reflect validation. Known observation recall returned `obs_mu5ip2fv_45a7ed131d86` and `obs_mu5kwrbs_ca3782ceeab5`.
- Both insight entrypoints ran in `zsh -f -c` behind the required help probe and returned `ins_140c66d4d16bc568` with limit 1 and `truncated: true`.
- `memory_consolidate({"tier":"reflect"})` returned `success: true`, with nested `clustersCooledDown: 4`, `clustersProcessed: 0`, `clustersSkipped: 0`, `newInsights: 0`, `reinforced: 0`, and `usedFallback: true`. The log records the same counters and contains no reflect-tier, cluster-synthesis, or cooldown-persistence failure. Existing cooldown records correctly suppress repeated synthesis; new synthesis behavior is covered by the focused tests.
- Durable evidence files: `global-install.log`, `global-entrypoints.log`, `processes-before.txt`, `processes-after.txt`, `livez-before.json`, `livez-after.json`, `insights-before.json`, `insights-after.jsonl`, `recall-after.json`, `reflect-result.json`, `reflect-validation.log`, and the three stale-store manifests.
- Source and tests committed as `ff0c2f8f237caee41fc4872d937f83d87dd59e89` and pushed to `https://github.com/mbakman/agentmemory`, branch `fix/reflect-hotfixes`. Author and committer are Baha Akman <bakman@nvidia.com>; no co-author trailer was added.
- No implementation or deployment step remains. A branch merge or pull request is outside this plan. Existing TypeScript errors remain at the baseline of 30; the integration test excluded by `npm test` was not run.

## Rollback procedure

Recapture the running worker and engine identities from the PID files and `ps` before rollback. Send SIGTERM to the worker first and wait for exit; then send SIGTERM to the engine and wait for exit. Stop if either survives. Do not remove metadata files or stores.

Reinstall the saved patched package with `/opt/homebrew/bin/npm install --global --prefix /opt/homebrew /Users/bakman/.agentmemory/backups/reflect-source-port.5E8cTs/agentmemory-agentmemory-0.9.29.tgz --no-audit --no-fund`. Restore `iii-config.yaml` from that backup to `/Users/bakman/.agentmemory/iii-config.yaml`. Restore `embedding-cache/.` to the installed transformer's `.cache/` directory.

Restart in the existing tmux pane from `$HOME` with the explicit configuration command above. Verify liveness, PID agreement, resolved configuration, known recall and insight hits, and unchanged stale stores. Preserve all database writes. The rollback was prepared but was not needed or exercised.

For a later reinstall of this source port, use the durable `tested-fork-0.9.29.tgz` artifact or build this maintenance branch. An upstream registry reinstall of version 0.9.29 still lacks these fork changes.
