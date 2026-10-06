# Upstream catch-up readiness — 2026-10-06

The isolated backup, restore, migration, and restart gates passed. Fable accepted the rehearsal with effort `max`. No production upgrade is approved by this report.

Production remains on agentmemory `0.9.29` and iii-engine `0.11.2`. The lab uses the preserved fork with engine, SDK, npm helpers, worker helper, and console at `0.22.1`. The application package version remains `0.9.29`.

The source branch is `codex/upstream-0221`. It merges baseline `cffc4dd8e80730c57a8925d4656a92c6aed09d89` with upstream `d03e88f6a08c8eb602fd1dc4174a2f5124862274`. Runtime correction commit `566aa1b5e6fba63048e8fce5b0b0df0f9b9e124b` prevents overlapping startup keyword rebuilds. The fork insight commands and reflect fixes remain in source. See [integration decisions](upstream-catch-up.md).

## Measured gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Full cold image | Passed. 18,737 files; 5,797,804,200 bytes. Application files, both stores, configuration, assets, dependencies, cache, and original runtime are archived. A closing full-file comparison confirmed unchanged content and metadata after the rehearsal. | [Restore guide](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/RESTORE-updated.md), [seal](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/evidence/archive-seal-final.json), [closing comparison](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/evidence/archive-untouched-final.json) |
| Original restore | Passed. 400,233 readable values matched, with zero read gaps or value differences. Recall, both insight commands, viewer, and graceful restart passed. | [Restore guide](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/RESTORE-updated.md) |
| Engine-only upgrade | Passed before the worker started. All 400,233 readable values matched under engine `0.22.1`. | [Native comparison](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/upgrade-0221/logs/native-vs-original.json) |
| Stock migration | READY. All 117,750 legacy vectors matched by ID, session, dimension, and Float32 bytes. All 25,011 non-index audit values matched. Stock migration removed 12,768 `index_persist` audit rows. Protected records, source payloads, slots, and cooldowns had no unexplained changes. | [Reviewed migration](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/upgrade-0221/run/migration-reviewed.json) |
| Upgrade restart | READY. Complete inventories before and after restart contain 505,018 values. All 117,751 vectors matched. The extra vector belongs to one controlled capture observation. No read gaps or unexplained changes remain in the reviewed comparison. | [Reviewed restart](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/upgrade-0221/run/restart-reviewed.json) |
| Early recall | Passed. An early HTTP request waited 12.287 seconds and returned after one 35,399 ms rebuild of 147,466 BM25 documents. The worker loaded 117,751 vectors. | [HTTP timing](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/upgrade-0221/run/patched-first-query.json), [worker log](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/upgrade-0221/logs/worker-patched.log) |
| Capture replay | Passed after restart. One observation remained, its raw marker matched, and duplicate receipts remained completed. | [Capture probe](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/consumer-probes/capture-after-restart.json) |
| Actual MCP shim | Default secret discovery and explicit authentication reached 54 remote tools. Invalid authentication received HTTP 401, then fell back to seven local tools even with `AGENTMEMORY_FORCE_PROXY=1`. The tested lockfile pins shim `0.9.29` and implementation `0.9.30`. The flag skips the connection probe; it does not prevent per-call fallback. | [Consumer evidence](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/consumer-probes/README.md), [forced-proxy contract](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/consumer-probes/force-proxy-contract.json) |
| Original rollback after upgrade | Passed on another untouched archive copy. The original engine restored all 400,233 values with zero gaps or differences. | [Rollback comparison](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/rollback-after-upgrade/run/native-equal.json) |
| Binary-only rollback boundary | Proved with engine `0.11.2` on another cold migrated copy. Four legacy index keys are absent; v3 metadata contains 117,751 vectors. Legacy audit values are empty and monthly metadata remains. Nonempty orphan index shards remain but have no legacy manifest. No old application worker ran. | [Native proof](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/negative-binary-rollback/run/binary-rollback-proof.json) |
| Exact index coverage | All original vector IDs, sessions, dimensions, and bytes remain unchanged. The eligible set is unchanged by migration. The functional test adds one eligible observation and vector. The source-derived eligible set matches the ready BM25 count exactly. | [Coverage report](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/upgrade-0221/run/coverage-final-v3.md) |
| Physical store files | Fully reconciled: 4,865 − 389 + 247 = 4,723. Removed files are 261 active BM25 shards, 127 active vector shards, and one legacy audit file. Additions are 236 vector buckets and 11 metadata, audit, index, or fixture files. There are no unexplained additions or removals. | [Physical categories](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/upgrade-0221/run/coverage-final-v3.json) |
| Source and package | Final build passed. Full suite passed 2,891 tests in 241 files, with two skipped. All 17 skills and 93 installed CLI tests passed. Advisor additions passed all 19 focused tests. Runtime source and package content linkage are recorded. | [Final suite](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/packages/final-assembly/test.log), [installed CLI](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/packages/startup-rebuild-fix/installed-cli.log), [release evidence](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/packages/final-assembly/release-evidence.json) |
| Final review | READY for the isolated rehearsal. Fable reviewed backup evidence, source, migration, restart, consumer behavior, coverage, and rollback. All requested recording conditions are complete. | [Fable acceptance](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/evidence/fable-final-acceptance.md) |
| Unchanged production | Known recall IDs, both installed insight names, and viewer passed at closure. Worker `73154` and engine `73177` remain the recovery identities. The health endpoint returned HTTP 503 for the existing memory-pressure alert. | [Read paths](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/evidence/production-final-readpaths.json), [native insights](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/evidence/production-final-insights.json) |

The designated rehearsal package is [agentmemory-agentmemory-0.9.29.tgz](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/packages/startup-rebuild-fix/agentmemory-agentmemory-0.9.29.tgz). SHA-256: `ba4df8ace65915e102cd016d04973d3bb063d8a48dfe640f5fcee3a279704d53`. Its runtime source is commit `566aa1b5e6fba63048e8fce5b0b0df0f9b9e124b`. Final source and validation assembly is `ecc94ffe079a5c1311bcfc639a204018b8b79dc0`. The runtime-source diff between these commits is empty. Later commits contain test and report changes only.

The package was built before the correction commit was created. Its plugin build-info therefore names the earlier HEAD, `7ef78a98`. Per-file hashes prove that all runtime bytes match the final clean source build. Extracted plugin ZIP contents also match. The new tarball differs only in file modes, ZIP metadata, and build-info revision/checksums. That comparison archive is retained as evidence; the tested package remains designated.

The private dependency lock SHA-256 is `0dd2b555862995b3c000c31ff613285d26ab2eafe98eaa95464dc8e77f5a5d88`. Node is `26.10.0`; npm is `11.19.1`. The tested package used `umask 022`. Preserve the source, lock, and designated package together. They reproduce runtime and dependency contents. Bit-identical packaging timestamps are outside this proof. See [content equivalence](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/packages/final-assembly/package-content-equivalence.json).

## Proof limits

FULL covers the complete persisted application image and required runtime assets. Engine `0.11.2` has no flush barrier. The proof cannot guarantee every acknowledged RAM write or unfinished request.

Value comparisons preserve duplicates and raw payload text. Values-only APIs cannot prove arbitrary engine key mapping. Inventory counts include state values, stream copies, and targeted reads. They do not count distinct memories.

The RAM comparison includes 385 empty scopes without persisted files. Their reads returned empty lists. This is a documented physical coverage exception; strict completeness remains false for that RAM comparison. The final archive restore has no native read gaps.

The new BM25 rebuild contains 147,466 documents. The original persisted snapshot contained 118,589 documents, a difference of 28,777. The rebuilt set includes one controlled fixture. The stored original image contains 149,854 observation IDs and 141 memory IDs. All remain preserved.

The ready eligible set contains 147,325 observations and 141 memories. It intersects 117,716 vector IDs. Exactly 29,750 eligible documents lack vectors: 29,725 observations and 25 memories. This gap existed before migration. Thirty-five preserved vectors are outside the eligible set: 26 observations lack title or narrative, and nine are outside the session walk. No vector ID is absent from the stored record sets.

The source walk excludes 2,485 observations that lack title or narrative and 45 text-bearing observations in two scopes outside the session list. Ninety session values have no ID; the coverage tool reproduces the source's scope coercion and records this condition. These pre-existing records remain stored. The eligible ID set follows the verified source walk and matches the runtime count. In-memory BM25 IDs were not separately captured. Idle backfill counters do not prove full vector coverage. Full vector backfill requires a separate decision.

The migrated copy retains 353 legacy files outside the original active manifests: 342 BM25 files, including 13 empty scopes, and 11 vector files. Their presence is documented. No cleanup was performed.

Only `mem::search` waits for the shared startup rebuild. Other search and context readers can return partial results before Ready. Tests disable context injection. Generation, scheduled retention, external model calls, and production access were disabled in the isolated comparisons.

Capture testing proved completed-event replay and deduplication across restart. It did not induce a waiting or dead retry. Those paths have regression coverage in the full suite.

The negative rollback inventory retains six coverage gaps: two queue reads from an engine without a queue module, and four resolved `undefined` reads for deliberately removed legacy keys. Separate native calls confirmed those absences. All state and stream list reads succeeded. These gaps do not support a strict complete-inventory claim for that negative test.

The final upgraded worker exited gracefully. Files stayed stable across 23.494 seconds, longer than three configured persistence intervals. The engine then exited gracefully. All 4,723 files matched the negative-test copy; only the owner-only root directory metadata was excepted. All test runtimes are stopped. Production remains available with its original worker and engine identities.

One post-readiness snapshot measured 1,289.31 MiB RSS for the lab application, 1,027.66 MiB for the engine, and 8.48 MiB for `iii-worker-ops`. These are sampled values, not peak memory measurements. Production retained its pre-existing memory-pressure warning.

## Requirements before any cutover

1. Review a separate production cutover plan. This report accepts the isolated rehearsal only. Keep all raw comparison blockers and reviewed exceptions in the evidence.
2. Set `AGENTMEMORY_DATA_DIR=/Users/bakman/.agentmemory/data` explicitly. Align engine storage, audit migration, and capture spool. The CLI sets this variable from its data directory resolution at [src/cli.ts:357](/Users/bakman/Repos/agentmemory-wt/upstream-0221/src/cli.ts:357).
3. Pin and review the actual consumer implementation. Verify authentication and remote mode for each deployed consumer. Require 54 remote tools in the tested full-tool profile. Seven local fallback tools do not prove backend access.
4. Install the verified `0.22.1` engine, worker helper, and console together. The archived `iii-worker` is `0.24.4` and rejects the engine's `worker-manager-daemon` command.
5. Take a new cold backup during a separate approved maintenance window. Rollback must restore the old store and runtime together. Stock migration removes legacy index references at [src/state/index-persistence.ts:697](/Users/bakman/Repos/agentmemory-wt/upstream-0221/src/state/index-persistence.ts:697).
6. Define how to preserve writes made after cutover before using an older backup for rollback. Restoring that backup alone discards later writes. Set measurable service, capture, authentication, and recall checks for the cutover.
7. Check free memory and service headroom before the window. Make separate decisions about full vector backfill, records outside the session walk, and dependency findings. The audit has nine moderate and two high findings. Automatic repair changes the required helper pin and was not applied.

This work does not merge main, push a branch, upgrade global packages, or deploy the new runtime to production.
