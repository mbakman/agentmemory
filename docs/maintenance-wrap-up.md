# Maintenance wrap-up - 2026-10-08

The engine `0.22.1` and application `0.9.29` remain active.
Cleanup did not restart production. The engine and worker remain tmux children.
Both installed insight commands returned two compact results with truncation after cleanup.
The viewer returned HTTP 200.

## Cleanup and retained recovery assets

The user approved removal of inactive leftovers.
Fifty-nine inactive test-store and runtime-copy directories were removed.
The observed free-space increase was 18,253,652 KiB, approximately 17.4 GiB.
Free space increased from approximately 63.7 GiB to 81.1 GiB.
APFS clone sharing means the reported copy sizes exceed recovered space.
Concurrent filesystem activity can also affect this delta.

The exact removal receipt is private at:
`~/.agentmemory-labs/cutover-final-20261008.Kd7M2q/evidence/cleanup-receipt.json`.

Every listed path is absent. The protected production paths and original holds remain.
The final archive seal, designated npm artifact, and dependency lock retain their expected hashes.
Keep all native inventories, reports, comparisons, logs, configurations, spools, source artifacts, and the pristine tested package.
Earlier test runtimes must be reconstructed from a retained archive before another restore test.

Three physical archives remain:

| Archive | Disposition |
| --- | --- |
| `cutover-final-20261008.Kd7M2q/archive` | Keep as the accepted final backup |
| `cold-20261006.3DMTEk/archive` | Earlier physical state; optional retirement, approximately 5.45 GiB |
| `cutover-execution-20261008.ofhuBX/archive` | Earlier physical state; optional retirement, approximately 5.75 GiB |

These paths are under `~/.agentmemory-labs`.
The two earlier archives are not byte-identical duplicates of the final state.
Specific path approval is required before giving up those earlier backup points.
The original application and package hold paths remain protected.
Later production writes still require a new full image and reconciliation before rollback.

## Harness readout

The maintained `consumer-probe.mjs` used each deployed profile's settings.
Each profile reported `usable=true`, exactly 54 tools, and both known recall records, with no fallback.
The private results are under `evidence/harness-audit-20261008` in the final cutover root.

| Harness | Shared-store tools | Automatic capture | Current connection boundary |
| --- | --- | --- | --- |
| Cursor | Guarded insight CLI, `memory_recall`, deliberate `memory_save` | No global agentmemory capture hook | Fresh profile passed; existing UI reconnect is unverified |
| Claude Code | Same shared-store tools | 12 active hook registrations | Fresh profile passed; older sessions can retain the cached bridge |
| Codex | Same tools; all 54 are exposed | 6 active hook registrations | Current app uses the pinned bridge; direct recall passed |

All profiles use the canonical installed plugin bridge, loopback URL, production data directory, and capture spool.
No further npm package deployment is needed.
Reconnect an older MCP session to adopt the pinned bridge.
Existing cached clients resumed during cutover; resumption does not prove a host configuration reload.

The shared recall rule incorrectly stated that every harness automatically captured sessions.
Its opening sentence now states the actual capture difference.
The canonical helper source and deployed Cursor copy match.
Targeted Claude and Codex guidance edits preserve unrelated rules.
The helper source change remains local; no GitLab push or broad synchronization occurred.

Hooks capture action telemetry. Durable conclusions need a deliberate `memory_save`.
Context injection remains off. Existing insights remain searchable while reflect is disabled.
Claude native memory and the Codex memory folder remain separate systems.
Automatic synchronization with those systems was not proved.

## Obsidian update

The user authorized updates in `Baha_NVIDIA_Vault`.
The CLI updated and verified these notes:

- `Projects/AI Tools/agentmemory/agentmemory.md`
- `Projects/AI Tools/agentmemory/Cheatsheet.md`
- `Projects/AI Tools/agentmemory/2026-10-08_Production_Cutover_and_Harness_Status.md`
- `Projects/AI Tools/agentmemory/2026-10-04_Insights_CLI_and_Reinstall_Recovery.md`
- `MacOS/agentmemory Reflect Timeout — Root Cause and Runbook.md`

The main note and cheatsheet describe the current runtime and manual retrieval policy.
The new dated note records backup proof, harness differences, cleanup, remaining decisions, and proof limits.
Historical incident notes now mark the installed-bundle patch maintenance item as closed for the designated package.
The original historical reports remain available.
Uncached reads through the Obsidian CLI and vault API verified the saved content.
The normal CLI read returned stale cached text after overwrite, so it was not accepted as write verification.

No product code changed during this cleanup and documentation work.
The cutover build, test, and skill results remain in [production-cutover-results.md](production-cutover-results.md).
Those suites were not repeated for these documentation edits.

## Remaining decisions

Keep generation and scheduled destructive features disabled until their separate restoration step.
The 39,828-record vector coverage gap and 500-observation session cap remain separate decisions.
Twenty-one unmapped rejected maintenance spool attempts remain an explicit capture coverage gap.
The draft fork PR is not merged into main.

