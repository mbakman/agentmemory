# Preservation tools

Use these tools with private, owner-only evidence storage. They do not stop processes, launch engines, or change application state.
Every output path must be new. Evidence files use mode `0600`; new directories use mode `0700`.

## Physical file coverage

```sh
node scripts/preservation/manifest.mjs scan --root SOURCE --out PRIVATE/source.json
node scripts/preservation/manifest.mjs scan --root ARCHIVE --out PRIVATE/archive.json
node scripts/preservation/manifest.mjs compare --before PRIVATE/source.json --after PRIVATE/archive.json --out PRIVATE/file-comparison.json --metadata
```

The scan includes hidden files and stale temporary files. It records SHA-256, file size, permissions, modification time, owner, symlink targets, and hardlink identities.
It does not follow symlinks. A file that changes during hashing fails the scan.
The comparison checks file coverage, type, permissions, size, SHA-256, symlink targets, and hardlink relationships.
`--metadata` also checks owner, group, and modification time. Birth time and source inode identities remain evidence; they are not compared across filesystems.
Use `--exclude RELATIVE` only for an explicit approved exclusion. Each exclusion is recorded in the manifest.
Use `--ignore-hardlinks` only when the copy method intentionally expands hardlinks; record that metadata gap.
Use `--ignore-root-metadata` when the independent restore root must remain owner-only. It skips mode, owner, group, and modification time only for directory `.`.
The comparison records this exception. All descendant metadata and every coverage, type, size, hash, and symlink check remain active.

## Native RAM inventories

```sh
node scripts/preservation/inventory.mjs \
  --sdk /ABSOLUTE/PACKAGE/node_modules/iii-sdk/dist/index.mjs \
  --url ws://127.0.0.1:50234 --out PRIVATE/new-inventory
node scripts/preservation/compare-inventory.mjs \
  --before PRIVATE/source-inventory/summary.json \
  --after PRIVATE/restored-inventory/summary.json \
  --out PRIVATE/value-comparison.json
```

The probe registers one temporary SDK worker. It disables SDK telemetry and closes the worker in `finally`.
Read defaults are six concurrent requests, a 20-second timeout, and a 20-MiB response limit. The size limit applies after receipt.
Use `--concurrency 1` to reduce load. Use `--timeout-ms N` and `--max-bytes N` for a measured exception.
Use repeated `--scope NAME` for targeted comparisons. A filtered inventory is not a complete inventory.
Use repeated `--skip-scope NAME` to skip an identified unsafe read; the result records a coverage gap.
`--metadata-only` captures workers, queue metadata, scopes, and stream groups without value lists.

Full values are written privately for each readable state scope and stream group. A multiset compares canonical JSON values and duplicate counts.
The engine APIs return values without arbitrary keys or pagination. These results cannot prove arbitrary key mapping.
Failures, malformed replies, timeouts, and oversized reads remain coverage gaps. They are never converted to empty lists.
The default targeted read preserves `mem:config/reflect:recentClusters`. Add known keys with `--targets PRIVATE/targets.json`:

```json
[
  { "scope": "mem:config", "key": "reflect:recentClusters" },
  { "scope": "mem:memories", "key": "KNOWN_MEMORY_ID" }
]
```

Native stream payloads at engine commit `2b445957701f94dc5f56f900af314e9d59f3b0f7`:

| Function | Payload | Result |
| --- | --- | --- |
| `stream::list_all` | `{}` | `{ "stream": [{ "id": "NAME", "groups": ["GROUP"] }], "count": N }` |
| `stream::list_groups` | `{ "stream_name": "NAME" }` | Group-name array |
| `stream::list` | `{ "stream_name": "NAME", "group_id": "GROUP" }` | Complete value array |

`stream::list_all` splits colon-bearing group identifiers. The tool therefore uses `stream::list_groups` for each stream's group coverage.
Queue evidence includes topics, topic statistics, dead-letter counts, and the first 100 dead-letter messages per topic.
The queue API does not provide a complete pending-payload inventory. Zero active invocations alone does not prove a drain.

Exit codes: physical comparison `0` means equal and `1` means different. Inventory `1` means coverage gaps.
Native comparison `0` means readable equality and complete coverage, `1` means a detected difference, and `3` means a coverage gap.
Usage or tool failures use `2`. A comparison with gaps cannot support a strict zero-loss claim.

Use `compare-inventory.mjs --allow-absent-empty-scopes` only for the old engine's known empty-scope persistence behavior.
The old engine removes a scope's persisted file when the scope has no values. Such scope names can remain in RAM until restart.
This option permits a missing state scope only when its source native read succeeded and returned zero values.
The result lists `expectedEmptyScopeAbsences` and reports the raw `physicalScopeCoverage` separately.
These names are RAM metadata, not persisted records. The exception does not permit missing records, failed reads, targets, stream groups, or unexpected scopes.
Coverage gaps remain gaps. Any applied empty-scope exception keeps strict `complete` false.

## Migration policy

Run `migration-report.mjs --before SUMMARY --after SUMMARY --out PRIVATE/report.json --markdown PRIVATE/report.md --viewer-cap 500` after the startup inventory and before functional tests.
The cap must match the runtime's effective viewer setting. The report records the cap.
The report compares every protected value and duplicate count. It reconstructs legacy vector shards and v3 buckets using logical IDs, sessions, dimensions, and Float32 bytes.
It permits only verified stock audit migration and exact viewer pruning. Runtime health, metrics, and access updates remain visible; a lower record count blocks acceptance.
Vectors must match exactly. Added vectors or resumed audit duplicate loss remain review blockers. Do not deduplicate the source evidence to make a comparison pass.

`--startup-metadata-proof PRIVATE.json` can review the sole `mem:config/session-index-generation` addition. Use native targeted reads from an untouched original copy and the migrated copy.
The proof must show that the generation key changes from absent to `1`, graph compaction markers stay absent, and both cooldown digests match the inventories.
The whole configuration multiset must have exactly one added value `1` and no removed values. Any other configuration change blocks acceptance.
The original blocker remains in `rawBlockers`. The report records the narrow review and its source line. This exception does not prove arbitrary key mapping.

`migration-report.mjs --allow-absent-empty-scopes` can review an empty state scope that disappears after an engine restart.
Its source read must succeed and return zero values. Both added and removed value counts must be zero.
The original blocker remains in `rawBlockers`; the report records the exception. Nonempty scopes, streams, and failed reads stay protected.

## Index coverage and file reconciliation

Use `node scripts/preservation/coverage-report.mjs --help` for its exact inputs.
The tool reads captured native inventories and physical manifests. It does not connect to a server.
It computes stored record ID sets, source-derived keyword eligibility, vector intersections, and missing or orphan vector IDs.
It follows the source's session-scope walk and text predicates. It records malformed session values and records outside that walk.
It compares logical vector bytes and reconciles file additions and removals by scope and active legacy manifests.
Unreferenced legacy generations remain visible. The result does not authorize their deletion.
Outputs contain counts and hashes. They omit raw IDs, source payloads, and embeddings.
The source-derived keyword set is not a direct capture of the in-memory BM25 ID list.
