# Production cutover results — 2026-10-08

Status: cutover complete. Engine `0.22.1` is active, and ordinary capture and consumers are released.
The application remains `0.9.29`. The SDK, npm helpers, engine, worker helper, and console use `0.22.1`.
The source branch is `codex/upstream-0221`. Source is published only to [mbakman/agentmemory](https://github.com/mbakman/agentmemory/pull/1).
The PR remains a draft. No main merge occurred.

## Backup and restore

The final cold archive is `~/.agentmemory-labs/cutover-final-20261008.Kd7M2q/archive`.
It contains 21,361 regular files. All 5,551 application files matched their source by content and relevant metadata.
All 5,081 candidate store files matched the final archive byte for byte.
Seal SHA-256: `1e3958f8f00ba0dfeda142f3a373572e48d6e2a5a42f3d8e4286d70b11d68d40`.

An independent restore with engine `0.11.2` loaded all 428,320 saved values, 2,918 persisted scopes, and one stream.
The complete restore comparison had zero read gaps or value differences. Recall, both insight commands, all 54 MCP tools, and the viewer passed.
The old live engine also had 776 empty RAM scope names without persisted files. This measured metadata exception remains explicit.
The backup contract covers the complete persisted application and required same-host runtime assets.
Engine `0.11.2` has no flush barrier. These checks cannot prove preservation of every unfinished request or acknowledged RAM write.
Values-only APIs cannot prove arbitrary key mapping. This archive is not a portable backup of the operating system.

## Actual production results

Engine-only loading on `0.22.1` preserved all 428,320 saved values exactly, with no read gaps.
Initial worker migration preserved all 160,127 observations, 142 memories, raw sources, slots, cooldowns, and 117,750 original vectors.
Vector comparisons included IDs, sessions, dimensions, and Float32 bytes. Startup added zero vectors, matching the fresh source-derived expected set.
Audit migration removed 14,328 `index_persist` rows under the upstream policy. All 26,230 other audit rows remained exact.
The private cold archive retains the removed rows.

Both installed insight commands returned the same two results, obeyed the limit, and omitted source-memory ID lists.
An absent token returned zero results. Authentication and refused-connection errors returned exit `1` with a diagnostic.
Wrong-secret REST access returned HTTP 401. The pinned MCP bridge reported authentication and connection failures without local fallback.
Codex, Claude, and Cursor received targeted MCP settings changes. Each configured profile passed the exact 54-tool inventory and both known recall IDs.
The cached older implementation also passed against the new secret. Existing host connections were not replaced automatically.
New host connections use the pinned bridge. The shell compatibility function delegates to the installed executable.

One installed-hook fixture retained its exact raw input and output, one observation, and one completed capture receipt.
It added one vector and one BM25 document. The full worker and engine stopped after SIGTERM, without forced termination.
Restart used a fresh configuration seed, the same local-only network profile, and new persistent tmux commands.
Engine `51543` and worker `51930` reached Ready at `2026-10-08T20:38:48.944Z`.
The restarted index loaded 117,751 vectors and 157,544 BM25 documents. Known recall and both insight commands passed.
No worker flush timeout or fatal error appeared in the recorded restart logs.
The final native inventory contains 531,620 values in 2,777 state scopes, with zero read gaps.
All original records and vector bytes remain exact. The fixture survived once; replay created no additional observation or completion.
All physical changes reconcile: `5,081 - 389 + 248 = 4,940` files. The reviewed report contains no unexplained changes.
Five controlled insight-search audit additions and one fixture viewer addition are identified.

## Capture boundary

Pausing host settings did not stop commands cached by active sessions. Temporary installed-hook guards stopped those commands during restart.
All 12 guards were removed. Original file hashes and nanosecond modification times match the tested image.
The full 13,256-file package comparison found no content difference. Its sole hook-directory timestamp difference was restored and verified.
Raw differences and the separate reviewed closure remain retained privately.
Sixty-eight requests reached the existing 500-observation session limit and remained durable dead letters.
Client spool statistics also report 21 rejected attempts before the first worker was Ready. Their payload mapping is not proved.
This is a maintenance capture coverage gap. It does not change the proved preservation of the sealed application image.
No strict zero-loss claim covers these unfinished or unacknowledged attempts.

## Checks and operation

Current Node `26.11.0` and npm `11.20.0` passed `npm run build`, `npm test -- --maxWorkers=2`, and `npm run skills:check`.
The suite passed 2,914 tests in 243 files; two tests were skipped. All 17 skills passed.
Service observation recorded 17 successful status and viewer samples over 818 seconds.
The 20:47:37–20:53:31 UTC interval was unsampled. No continuous coverage claim is made.
Every observed index was ready, with no pending or retrying capture. The 68 explained dead letters stayed constant during observation.
Fable `claude-fable-5-1`, native 1M context, effort `max`, returned final READY with no new blocker.
All 44 identity-matched paused MCP clients resumed at `2026-10-08T21:27:16Z`.
All 18 original capture registrations resumed with explicit local URL, data, spool, and Node paths. Unrelated hooks remained unchanged.
Post-release status and viewer returned HTTP 200. The existing standalone fallback file retained its baseline SHA-256.
RAM pressure, swap, peak, and reserve checks were waived by the user. No further RAM measurements were taken.
Generation, compression, consolidation, slots, reflect, decay, retention, graph compaction, and full vector backfill remain disabled for initial acceptance.
Local embeddings, capture, retrieval, insight search, and viewer access remain active.
Restore the prior approved generation features in a separate recorded step after service acceptance.
There are 39,828 eligible documents without vectors. This is a pre-existing coverage gap, including records added since the earlier rehearsal.
BM25 covers the eligible set. Full vector backfill remains a separate recorded decision.

The running engine and helpers come from `~/.local/share/agentmemory/releases/iii-0.22.1-cutover-preflight-mgHfKS/bin`.
The global older engine assets remain preserved. The production launch selects the reviewed release directory explicitly.
The engine and worker run in `agentmemory-engine-0221` and `agentmemory-worker-0221` tmux sessions.
Private launch commands, logs, profiles, configuration seeds, and comparison evidence remain under the final cutover root.
Every later engine start must use [launch-config.mjs](../scripts/preservation/launch-config.mjs) with the pristine template and a fresh start directory.
Never reuse a launched engine YAML. Startup rewrites its persistent module configuration.

## Rollback

The original image remains at `~/.agentmemory.hold-cutover-final-20261008.Kd7M2q`.
The original package remains at `/opt/homebrew/lib/node_modules/@agentmemory/agentmemory.hold-cutover-final-20261008.Kd7M2q`.
Rollback restores the whole image, package, configuration, and original engine together. Binary-only rollback is unsafe.
Stop verified processes gracefully. Seal the upgraded image before any reversal. Keep the generated secret with that upgraded image.
After ordinary writers resume, take a new full image and reconcile later writes before rollback.
The pre-cutover archive alone cannot preserve records added after writer release.
Follow [the rollback procedure](production-cutover.md#rollback-and-preservation-of-later-writes).
No cleanup deletion or main merge is part of this cutover.
