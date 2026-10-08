# Cold backup and upstream rehearsal

Approved scope: preserve the full persisted application image, prove the original restore, then test upstream on independent copies. No production upgrade, main merge, forced termination, or cleanup deletion.

Baseline: `cffc4dd8e80730c57a8925d4656a92c6aed09d89`. Integration target: `d03e88f6a08c8eb602fd1dc4174a2f5124862274`. Production uses package 0.9.29, iii-sdk and engine 0.11.2. Upgrade target is iii 0.22.1.

Private evidence root: `/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk`. Never commit backup files, native values, credentials, or private memory evidence.

## Completion gates

- [x] Prepare private storage, tools, isolation proof, exact recovery command.
- [x] Verify worker and engine identities. Inspect pending work.
- [x] Graceful worker exit; native RAM inventories; persistence wait; candidate comparison.
- [x] Graceful engine exit; cold copy; complete physical checksums.
- [x] Restore unchanged production and verify known recall, insight search, viewer.
- [x] Original engine-only restore comparison, with explicit coverage gaps.
- [x] Original worker restore, both installed commands, recall, viewer, restart.
- [x] Upstream integration worktree, four conflicts resolved, iii 0.22.1 alignment.
- [x] Migration comparisons, regression checks, npm package, installed CLI matrix.
- [x] Original-runtime rollback rehearsal.
- [x] Fable max-effort review and readiness report.

The user permits interruption of other agents for the initial maintenance window. All later tests must leave unchanged production available.

The old engine has no flush barrier. Full physical coverage does not prove preservation of all acknowledged RAM writes or unfinished requests. Values-only APIs do not prove arbitrary key mappings. Failed or oversized native reads must remain coverage gaps.

## Execution record

2026-10-06: Verification worktree created from the common baseline. Production has not been stopped. Backup tools and isolation are in preparation. The earlier Fable plan review returned READY with the listed proof limits.

2026-10-06 13:49 UTC: Verified production worker received SIGTERM and exited. The engine remained alive. Queue depth and DLQ depth were zero before shutdown; this does not establish a complete background-work drain.

Native comparison captured 400,233 values across state, streams, and targeted reads. Every value multiset matched the original-engine candidate. Initial large-scope gaps were closed by separate successful reads. The engine retains 385 empty scopes in RAM without files; the candidate omits those names. Every omitted scope returned an actual empty list. The raw difference report remains private. No nonempty scope was missing.

2026-10-06 13:54:59 UTC: The verified production engine received SIGTERM and exited. Final source store files matched the candidate. Filesystem synchronization preceded the cold copy. All 4,865 store files and all 5,335 application-image files matched size, SHA-256, permissions, owner, group, and modification time. Two historical backup group IDs were corrected on the copy. All 13,081 installed-package files matched, including dependency and embedding-cache files. Symlink timestamps were copied separately.

The full archive has 18,737 files. Final seal manifest SHA-256: `cc26147271de6a8bc1695505ad3e299e90dc4a72b5f04c95ae15c850c10b5d05`. Archive path: `/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/archive`. The archive is inside an owner-only directory. Credentials are archived privately and never activated in the labs.

Production restarted unchanged as worker 73154 and engine 73177. The three known recall hits and three native insight hits matched pre-stop results. Viewer returned HTTP 200. Health retained the pre-existing memory-pressure warning. Production paths, ports, and an external IP address were denied by the tested lab sandbox.

Original worker restore loaded 118,589 BM25 documents and 117,750 vectors. Recall, both insight entrypoints, and viewer passed. The first worker exited gracefully. A worker-only restart produced a local-embedding recall timeout. A native stack sample showed ONNX inference active. The next SIGTERM remained pending; no forced termination occurred. This isolated experiment is preserved. It does not alter the archive or production. A fresh original copy with embeddings disabled is testing a full graceful restart. Local inference and shutdown remain readiness concerns until resolved.

The stalled original experiment later exited gracefully. Its log reported a full rebuild of 147,465 documents. The first recall request was sent before the worker logged Ready. In this source, HTTP registration precedes index loading, and an early search can start a lazy rebuild. This is a possible test race, not proof of store corruption. A new local-vector copy will wait for Ready before each query.

The fresh `rollback-original` copy passed a full graceful engine and worker restart with embeddings disabled. BM25 recall IDs were identical across restart. Both insight commands, limits, empty results, and viewer access passed. Fable accepted this evidence as the gate for isolated upstream integration. A full local-vector restart remains a separate production-readiness gate.

Integration commit `7ef78a98c746f5700a452f58187a451e3f821be6` merges the exact fork and upstream inputs. Its build passed, 2,860 tests passed with two skipped, 17 skills passed, and 93 installed insight CLI cases passed. The source and private npm package are ready for isolated engine 0.22.1 migration tests. Production remains unchanged.

An initial engine launch for `original-vector-proof` used the inherited shell environment before the launch was corrected. No application worker ran during that launch. The engine exited gracefully, then restarted under the clean environment and the filesystem/network sandbox. The initial launch is not counted as an isolation proof. All original-worker and migration tests use the controlled launch.

The controlled original-vector copy passed a full graceful worker and engine restart. Both starts loaded 118,589 BM25 documents and 117,750 vectors. The same three production recall IDs returned before and after restart: HTTP 200 in 1.75 seconds, then 0.45 seconds. No unexpected full rebuild occurred. The first worker exited gracefully; files were stable across at least 15 seconds and no temporary files remained. Both insight commands, a two-result limit, an empty search, and viewer access passed after restart. Evidence: private `original-vector-proof/run/vector-proof.json` and its request/log files. This closes the earlier local-vector reproduction concern for the Ready-gated sequence.

Engine `0.22.1` loaded all 400,233 values before the application started. There were no read gaps or differences. Stock migration retained all protected records, source payloads, slots, and cooldowns. All 117,750 vectors matched by ID, session, dimension, and Float32 bytes. All 25,011 non-index audit rows matched. Stock migration removed 12,768 index-persistence audit rows and added its verified summary. A native targeted read proved the sole configuration addition, `session-index-generation=1`. The raw blocker remains in the reviewed report. Pure migration acceptance is READY.

Source correction `566aa1b5` reserves one startup rebuild before search registration. An actual early HTTP request waited 12.287 seconds and returned the known three IDs after one 35,399 ms rebuild. BM25 contains 147,466 documents, including one controlled fixture. Vector count is 117,751. Idle backlog counters do not prove full vector coverage. Final coverage measurements remain in progress.

The upgrade passed a full graceful worker and engine restart. Complete Ready-gated inventories contain 505,018 values before and after restart. Vector bytes and all protected values match. Empty RAM scopes disappeared after engine restart; the report records this narrow exception and retains its raw blocker. The controlled capture observation and completed dedup receipt survived replay. The application has exactly one registered worker. Official SHA-verified engine, worker helper, and console all use `0.22.1`. Archived helper `0.24.4` remains unchanged.

The actual MCP shim `0.9.29` resolved implementation `0.9.30`. Default and explicit authentication reached 54 remote tools. Invalid authentication produced HTTP 401 and seven local fallback tools, even with `AGENTMEMORY_FORCE_PROXY=1`. This flag skips the connection probe; it does not prevent per-call fallback. A remote-tool inventory and known-hit probe are required before any future cutover. Production consumer resolution remains unverified.

An untouched copy restored with the original engine and worker after the upgrade tests. All 400,233 values matched, with zero gaps. Original local-vector recall, both insight names, viewer, and graceful shutdown passed. This proves full-image rollback on this host. A separate engine-only test is measuring why a binary-only rollback is insufficient.

Fable accepted the startup mechanism and requested rejection recovery, fixture teardown, exact vector coverage, physical file reconciliation, and the binary-only rollback boundary. Commit `0e472a03` adds the two test changes; 19 focused tests passed. Final merged build, test suite, package linkage, and Fable acceptance remain in progress. No production upgrade, main merge, or push occurred.

The final coverage report derives the exact rebuild walk and matches the captured BM25 count: 147,466 eligible documents. All original vector IDs and bytes remain unchanged. Exactly 29,750 eligible documents have no vector, as before migration. Thirty-five vectors belong to stored records excluded by the text/session predicates. No vector is orphaned from the stored record sets. The report preserves the 45 text-bearing observations outside the session walk and 90 session values without IDs as pre-existing coverage facts. It does not claim a direct in-memory BM25 ID dump.

Physical store files reconcile as 4,865 − 389 + 247 = 4,723. All 261 active BM25 and 127 active vector shard files were removed by stock migration, along with one legacy audit file. New files contain vector buckets, monthly audits, indexes, metadata, and the controlled fixture. There are no unexplained additions or removals. The copy retains 353 unreferenced legacy files. No cleanup occurred.

The negative rollback test used engine `0.11.2` alone on another cold migrated copy. The four old root index keys were absent; v3 metadata remained. The old audit scope was empty and monthly metadata remained. Some unreferenced legacy generations remained, but the old reader lacks their manifests. All state and stream list reads succeeded. Unconfigured queue reads and resolved undefined legacy-key reads remain explicit negative-test gaps. Both negative-test engines exited gracefully. The final upgrade drain lasted 23.494 seconds and all copied files matched.

Final source and validation assembly: `ecc94ffe079a5c1311bcfc639a204018b8b79dc0`. `npm run build` passed. `npm test` passed 2,891 tests in 241 files, with two skipped. `npm run skills:check` passed 17 skills. The installed-command matrix passed 93 cases. Runtime code matches the end-to-end tested package `ba4df8ace65915e102cd016d04973d3bb063d8a48dfe640f5fcee3a279704d53`. Exact source, lock, toolchain, and content-equivalence evidence are recorded privately. Plugin ZIP timestamps and build-info revision account for archive-byte differences; bit-identical packaging is not claimed.

Fable `claude-fable-5-1`, native 1M context, effort `max`, accepted the isolated rehearsal as READY with no remaining blocker. No Ultracode consultation occurred. The readiness report records the proof limits and separate cutover requirements. Production closure checks passed known recall, both installed insight names, and viewer access. The original worker and engine identities remain. Health still reports the existing memory-pressure alert. All test runtimes exited gracefully. No forced termination, cleanup deletion, global upgrade, main merge, or push occurred.

The closing physical archive scan matched the sealed manifest: all 18,737 files, zero content or metadata differences. The original seal manifest SHA-256 remains `cc26147271de6a8bc1695505ad3e299e90dc4a72b5f04c95ae15c850c10b5d05`. Evidence is `evidence/archive-untouched-final.json`. The sealed archive remains unchanged.

## Production cutover planning — 2026-10-06

The user authorized preparation of the separate production cutover plan. Execution remains outside this planning request.
The plan is [production-cutover.md](production-cutover.md). Only `mbakman/agentmemory` is a publication destination.
The original backup and rehearsal remain complete. No production process, package, or consumer setting changed during this phase.

- [x] Recheck production identities, listeners, versions, package and lock hashes, capacity, and health.
- [x] Inspect current MCP resolution and capture consumers without printing credentials.
- [x] Define staged activation, writer pause, fresh backup, migration, readiness, restart, and rollback gates.
- [x] Close Fable's plan review at effort `max`.
- [x] Verify the completed document and record the reviewed plan.

Current deployment gates remain open: kernel memory pressure level `2`, unstaged pinned MCP bridge and exact network profile,
unexecuted fresh cold backup, and explicit acceptance of the rollback boundary after ordinary writers resume.
The old heap warning uses allocated V8 heap size. The OS also reports warning pressure; the two measurements must remain distinct.
Private planning evidence is under `/Users/bakman/.agentmemory-labs/cutover-plan-20261006.FzaCiC/`.

Fable returned READY FOR PLAN after the default spool paths and original recovery environment were made explicit.
The plan now records the actual CLI metadata names, phase-specific SDK selection, copied helper hash checks,
and the pinned index checkpoint interval. These are recording corrections, not new runtime changes.
The final acceptance is `fable-final-acceptance.md` in the private planning directory. Execution remains outside this completed planning phase.

Documentation verification passed: shell blocks parsed with `zsh -n`, all seven local links resolved, fences were balanced,
and `git diff --cached --check` reported no errors. A missing-stage guard produced no continuation marker.
Only the cutover plan and this progress record changed. No application build or unit suite was rerun for these documentation edits.

## Cutover preparation — 2026-10-06

Preparation evidence: `/Users/bakman/.agentmemory-labs/cutover-preflight-mgHfKS/`.
See [the preflight report](production-cutover-preflight.md) for asset paths, measured limits, and remaining gates.

- [x] Copy the full tested package and embedding cache to a sibling stage; compare all 13,256 files.
- [x] Stage and verify the aligned engine/helper assets; prove PATH discovery.
- [x] Prepare explicit production YAML and network profiles without activating them.
- [x] Prove mapped empty-engine startup, saved configuration, and native transport.
- [x] Correct the stripped-YAML restart fault and preserve nonempty state and stream fixtures across a fresh-seed restart.
- [x] Add the maintained stdio consumer probe and nineteen offline tests.
- [x] Test the staged bridge and both insight commands against unchanged production.
- [x] Run build, all seventeen skill checks, and the final full suite: 2,914 tests passed with two workers; two skipped.
- [x] RAM capacity gate waived by the user on 2026-10-08. No further RAM pressure, peak, or reserve checks are required.
- [x] Prove the full worker functional launch with the current toolchain and isolation profile.
- [ ] Confirm the writer pause, execution approval, and post-release rollback boundary.
- [ ] Take the fresh cold backup and pass the candidate/original-restore gates.
- [ ] Activate, measure migration, test new-runtime auth/capture/restart, and switch consumers.

The old backend accepted the wrong-secret MCP control. Keep the new-runtime authentication gate open.
Presence-only inspection found no configured or stored secret. Require every consumer to resolve the new secret if startup generates it.
Retain the original failed restart logs. Every future engine start must use a fresh pristine YAML and empty configuration directory.
The normal consumer test found 54 tools and the expected two recall IDs. The refused-port control failed visibly.
Production worker `73154` and engine `73177` were not signaled. No cutover, push, main merge, or cleanup occurred.
Fable accepted the revised preparation at effort `max`. The final review closed both findings; capacity still blocks cutover.

## Capacity recheck — 2026-10-07

Private evidence: `/Users/bakman/.agentmemory-labs/cutover-capacity-20261007.Qzfaqc/`.
The five-minute sample ran from 19:46:21 to 19:51:21 EDT. Eight samples reported pressure level `1`; the last three reported level `2`.
Swapouts increased by 47,305 pages, or 775,045,120 bytes. Pressure therefore fails the required level `1` gate.
No build, migration, test runtime, or new application worker ran during this sample. Existing host workloads continued.
The full new worker peak and 4 GiB reserve remain unproved. Do not activate the staged runtime on this result.

Today's checks reached the original worker `73154` and engine `73177`, with their original start times and commands.
Liveness and viewer requests returned HTTP 200. Observation recall returned three results; guarded insight search returned two results with truncation reported.
All three staged engine asset hashes still match the reviewed release. Disk space was about 109.2 GiB; the full source-size estimate was not refreshed.
No production signal, fresh cutover backup, package activation, consumer edit, push, main merge, or cleanup occurred.
Next required work remains a stable capacity check, full worker launch and memory measurement, and the fresh backup and restore gates before activation.

## Quiet check and isolated engine trial — 2026-10-08

Private evidence: `/Users/bakman/.agentmemory-labs/cutover-capacity-20261008.cXzKmz/`.
The quiet check passed from 14:04:34 to 14:09:35 EDT: eleven pressure-level `1` samples and no swapout growth.
Liveness and viewer requests returned HTTP 200. Recall and guarded insight search each returned two results.
The original worker `73154` and engine `73177` kept their start times and commands. Health retained its existing heap warning; state connectivity was good.

A new private trial copied the earlier migrated rehearsal image, without an archived `.env` or secret.
All 4,723 data files and 13,256 package files match their sources, including the metadata comparison's stated root exception.
Six copied symlink timestamps were corrected; the initial mismatch report remains preserved.
Actual data-read probes denied production and archive reads. Network probes denied production ports and external connections.
The first access-only probe did not test data reads; its result remains preserved separately.

Engine `0.22.1` launched on trial ports `4411`, `4412`, and `50434` with a fresh seeded YAML and cwd `worker-trial/run`.
Its metadata-only inventory found 2,668 state scopes and one stream, with no read gaps. This is not a complete value comparison.
All 111 samples taken while the engine remained present reported pressure level `2`; swapouts did not increase.
The observed engine RSS peak was 467,648,512 bytes. RSS excludes compressed memory and does not prove the full process footprint or startup peak.
The verified trial engine `87684` exited normally after SIGTERM. Its assigned ports became free. The application worker never started.
The larger current production image, full worker peak, capture/restart behavior, and 4 GiB reserve remain unproved.
These observations do not identify which host workload caused the pressure.

Global Node now reports `26.11.0` and npm `11.20.0`; the reviewed toolchain was `26.10.0` and `11.19.1`.
The archived Node `26.10.0` hash still matches. Copied libraries were not proved to be the libraries actually loaded by the inventory process.
Fable at effort `max` returned HOLD for toolchain alignment, dynamic-library proof, and explicit cwd records.
The launch record now states the actual engine cwd and the intended worker cwd. A hardened, unexecuted profile also denies the macOS-default production spool and writes to the trial configuration directory.
The next trial will separately validate the current Node toolchain to match the production command sheet. No global downgrade is planned.
Per-process kernel footprint peaks and native host statistics are required for the RAM budget; free percentages and sampled RSS alone are insufficient.
The user was asked to pause other agent jobs and close optional apps before another full trial. No such pause has been confirmed.

No production signal, fresh cutover backup, activation, consumer edit, push, main merge, or cleanup occurred.
No build or unit suite was run in this status check. Cutover remains blocked on the full runtime and fresh backup gates.

## RAM gate waived — 2026-10-08

The user instructed us to skip RAM checks. This supersedes the earlier capacity blockers and optional-app pause request.
Do not measure RAM pressure, swapout growth, process peaks, or the 4 GiB RAM reserve during further preparation.
RAM or heap alerts alone do not block cutover. This waiver does not change the backup's data inventory or checksum requirements.
Continue with the current-toolchain checks, mapped full-worker launch, fresh backup, restore proof, migration, and functional acceptance.
The earlier trial evidence remains retained. No unrelated application is stopped for capacity.

## Current toolchain and functional restart — 2026-10-08

Node `26.11.0` and npm `11.20.0` passed `npm run build`, `npm test -- --maxWorkers=2`, and `npm run skills:check`.
The suite passed 2,914 tests in 243 files, with two skipped tests. All 17 skills passed.
Private logs: `/Users/bakman/.agentmemory-labs/toolchain-20261008.KjuvCB/`.

The mapped full worker used current Node, the hardened profile, and explicit `worker-trial/run` cwd.
No archived-library equivalence is claimed. Older environment files are superseded by `config/current-node-environment.json`.
The first start loaded 117,751 vectors and rebuilt 147,466 BM25 documents.
The bridge returned the approved 54 tools and both known recall IDs. Both insight commands returned two results.
The native empty query returned zero results. Wrong authentication failed visibly. The viewer returned HTTP 200.
One installed-hook fixture retained its exact raw payload. Graceful restart loaded 117,752 vectors and rebuilt 147,467 BM25 documents.
After replay, one observation and one event remained. Both known recall IDs still matched; keyword rebuild was finished.
Transient connection refusal occurred while the restarted engine loaded its stores. The worker reconnected and reached Ready.
An initial launch used an incorrect package path and exited before startup. Its log remains retained.
An early file scan raced the pending-vector file removal during persistence. This scan did not produce a complete manifest.
These functional results do not prove migration of the newer production image. The fresh backup and migration comparisons remain required.

Fable closed cwd and archived-library findings under the current-Node decision. No new functional launch blocker was found.
The current-toolchain results above close its remaining validation item. RAM capacity checks were not run.
Fresh execution root: `/Users/bakman/.agentmemory-labs/cutover-execution-20261008.ofhuBX/`.
Static runtime assets passed all 30 file comparison groups, covering 15,780 regular files with zero differences.
The live worker and engine remain unchanged. Fresh cold backup, original restore, activation, and consumer switch remain open.
