# Upstream catch-up readiness — 2026-10-06

The isolated backup, restore, migration, and restart gates passed. Final rehearsal acceptance remains pending. No production upgrade is approved by this report.

Production remains on agentmemory `0.9.29` and iii-engine `0.11.2`. The lab uses the preserved fork with engine, SDK, npm helpers, worker helper, and console at `0.22.1`. The application package version remains `0.9.29`.

The source branch is `codex/upstream-0221`. It merges baseline `cffc4dd8e80730c57a8925d4656a92c6aed09d89` with upstream `d03e88f6a08c8eb602fd1dc4174a2f5124862274`. Runtime correction commit `566aa1b5e6fba63048e8fce5b0b0df0f9b9e124b` prevents overlapping startup keyword rebuilds. The fork insight commands and reflect fixes remain in source. See [integration decisions](upstream-catch-up.md).

## Measured gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Full cold image | Passed. 18,737 files; 5,797,804,200 bytes. Application files, both stores, configuration, assets, dependencies, cache, and original runtime are archived. | [Restore guide](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/RESTORE-updated.md), [seal](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/evidence/archive-seal-final.json) |
| Original restore | Passed. 400,233 readable values matched, with zero read gaps or value differences. Recall, both insight commands, viewer, and graceful restart passed. | [Restore guide](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/RESTORE-updated.md) |
| Engine-only upgrade | Passed before the worker started. All 400,233 readable values matched under engine `0.22.1`. | [Native comparison](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/upgrade-0221/logs/native-vs-original.json) |
| Stock migration | READY. All 117,750 legacy vectors matched by ID, session, dimension, and Float32 bytes. All 25,011 non-index audit values matched. Stock migration removed 12,768 `index_persist` audit rows. Protected records, source payloads, slots, and cooldowns had no unexplained changes. | [Reviewed migration](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/upgrade-0221/run/migration-reviewed.json) |
| Upgrade restart | READY. Complete inventories before and after restart contain 505,018 values. All 117,751 vectors matched. The extra vector belongs to one controlled capture observation. No read gaps or unexplained changes remain in the reviewed comparison. | [Reviewed restart](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/upgrade-0221/run/restart-reviewed.json) |
| Early recall | Passed. An early HTTP request waited 12.287 seconds and returned after one 35,399 ms rebuild of 147,466 BM25 documents. The worker loaded 117,751 vectors. | [HTTP timing](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/upgrade-0221/run/patched-first-query.json), [worker log](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/upgrade-0221/logs/worker-patched.log) |
| Capture replay | Passed after restart. One observation remained, its raw marker matched, and duplicate receipts remained completed. | [Capture probe](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/consumer-probes/capture-after-restart.json) |
| Actual MCP shim | Default secret discovery and explicit authentication reached 54 remote tools. Invalid authentication received HTTP 401, then fell back to seven local tools. The tested shim is `0.9.29`; its resolved implementation is `0.9.30`. Forced proxy failure remains pending. | [Consumer evidence](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/consumer-probes/README.md) |
| Original rollback after upgrade | Passed on another untouched archive copy. The original engine restored all 400,233 values with zero gaps or differences. | [Rollback comparison](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/rollback-after-upgrade/run/native-equal.json) |
| Source and package | Build passed. Full suite passed 2,863 tests, with two skipped. All 17 skills and 93 installed CLI tests passed. Advisor additions passed all 19 focused tests, including rejection recovery and async teardown. Final merged suite and package linkage remain pending. | [Package evidence](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/packages/startup-rebuild-fix/test.log), [installed CLI](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/packages/startup-rebuild-fix/installed-cli.log), [advisor regressions](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/packages/startup-rebuild-fix/advisor-regression.log) |
| Final review | Pending. Fable accepted the source mechanism, subject to added tests and remaining evidence. Binary-only rollback proof, file-count reconciliation, and exact vector coverage remain pending. | [Fable review](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/evidence/fable-startup-review.md) |

The tested runtime package is [agentmemory-agentmemory-0.9.29.tgz](/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/packages/startup-rebuild-fix/agentmemory-agentmemory-0.9.29.tgz). SHA-256: `ba4df8ace65915e102cd016d04973d3bb063d8a48dfe640f5fcee3a279704d53`. Later test and report edits do not change runtime code. Final assembly must record its source commit and package checksum.

## Proof limits

FULL covers the complete persisted application image and required runtime assets. Engine `0.11.2` has no flush barrier. The proof cannot guarantee every acknowledged RAM write or unfinished request.

Value comparisons preserve duplicates and raw payload text. Values-only APIs cannot prove arbitrary engine key mapping. Inventory counts include state values, stream copies, and targeted reads. They do not count distinct memories.

The RAM comparison includes 385 empty scopes without persisted files. Their reads returned empty lists. This is a documented physical coverage exception; strict completeness remains false for that RAM comparison. The final archive restore has no native read gaps.

The new BM25 rebuild contains 147,466 documents. The original persisted snapshot contained 118,589 documents, a difference of 28,777. Preserving 117,751 vectors does not prove every indexed document has a vector. An idle backfill counter also does not prove full vector coverage. Exact ID coverage remains pending.

Only `mem::search` waits for the shared startup rebuild. Other search and context readers can return partial results before Ready. Tests disable context injection. Generation, scheduled retention, external model calls, and production access were disabled in the isolated comparisons.

## Requirements before any cutover

1. Close the pending rehearsal gates. Obtain Fable acceptance with effort `max`. Keep all raw comparison blockers and reviewed exceptions in the evidence.
2. Set `AGENTMEMORY_DATA_DIR=/Users/bakman/.agentmemory/data` explicitly. Align engine storage, audit migration, and capture spool. The CLI sets this variable from its data directory resolution at [src/cli.ts:357](/Users/bakman/Repos/agentmemory-wt/upstream-0221/src/cli.ts:357).
3. Pin and review the actual consumer implementation. Verify authentication and remote mode for each deployed consumer. Require 54 remote tools in the tested full-tool profile. Seven local fallback tools do not prove backend access.
4. Install the verified `0.22.1` engine, worker helper, and console together. The archived `iii-worker` is `0.24.4` and rejects the engine's `worker-manager-daemon` command.
5. Take a new cold backup during a separate approved maintenance window. Rollback must restore the old store and runtime together. Stock migration removes legacy index references at [src/state/index-persistence.ts:697](/Users/bakman/Repos/agentmemory-wt/upstream-0221/src/state/index-persistence.ts:697).
6. Define how to preserve writes made after cutover before using an older backup for rollback. Restoring that backup alone discards later writes. Set measurable service, capture, authentication, and recall checks for the cutover.
7. Make a separate decision about full vector backfill and the known dependency findings. The current audit has nine moderate and two high findings. Automatic repair changes the required helper pin and was not applied.

This work does not merge main, push a branch, upgrade global packages, or deploy the new runtime to production.
