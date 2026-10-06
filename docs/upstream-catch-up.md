# Isolated upstream integration

This branch merges upstream into the preserved fork. Production remains on the original package and engine.

## Inputs

- Fork baseline: `cffc4dd8e80730c57a8925d4656a92c6aed09d89`.
- Upstream input: `d03e88f6a08c8eb602fd1dc4174a2f5124862274`.
- Branch: `codex/upstream-0221`.
- Workspace: `~/Repos/agentmemory-wt/upstream-0221`.
- Package version: `0.9.29`, as in the upstream input.
- Engine, `iii-sdk`, and `@iii-dev/helpers`: `0.22.1`.

The verification lane controls the backup, restored stores, runtime isolation, and migration evidence. This document covers source integration and package checks.

## Conflict decisions

| File | Decision |
| --- | --- |
| `.env.example` | Keep the upstream controls. Retain both reflect budget and cooldown controls. |
| `INSTALL_FOR_AGENTS.md` | Keep upstream lifecycle guidance. Retain native insight search guidance. |
| `plugin/skills/agentmemory-config/REFERENCE.md` | Regenerate the reference from the merged source. It lists 75 recognized variables. |
| `src/cli.ts` | Keep both the insight command and the upstream console command. |

The merge retains both executable registrations and build targets. Insight search still uses the server search function. The limit remains 1–100, with a default of ten. Compact output, truncation notices, the obsolete pool notice, and exit semantics remain.

The merge also retains the source reflect fixes: graph snapshot fallback, bounded clusters and prompts, persistent seven-day cooldowns, and the graph extraction gate. Worker and HTTP invocation timeouts remain 600,000 ms in both native and Docker configurations.

## Integration corrections

Upstream now creates a local API secret when no explicit secret is set. Both insight commands now use the local secret resolver. They read local credential files only for loopback URLs. Remote servers require an explicit process environment secret. Invalid explicit header values still fail before a request is sent.

Two preserved reflect tests read the legacy audit scope. Upstream now stores new audit entries in monthly scopes. The tests now check `mem:audit:2026-10`; reflect behavior did not change.

## Verification on 2026-10-06

| Command | Observed result |
| --- | --- |
| `npm install --ignore-scripts --package-lock` | Installed 268 packages in this worktree. The installed SDK and helpers both report `0.22.1`. |
| `npm run build` | Build completed. Both CLI entrypoints and shared capture assets are present. |
| `npm test` | 239 files passed; 2 skipped. 2,860 tests passed; 2 skipped. |
| `npm run skills:check` | Lint passed for all 17 skills. |
| `npm pack --pack-destination <private directory> --json` | Created an npm package with 285 files, including `dist/insights-cli.mjs`. |
| `npm install -g --prefix <private prefix> --ignore-scripts <tarball>` | Installed the package into a separate prefix. No global package changed. |
| `AGENTMEMORY_TEST_INSTALLED=1 npm exec -- vitest run test/insights-cli-entrypoints.test.ts` | All 93 installed entrypoint tests passed through non-interactive `zsh -f` shells. |

The installed matrix covers native search requests, default and explicit limits, empty results, local and explicit authentication, connection failures, timeout, malformed responses, redirects, output handling, and usage errors. It uses fixture servers and private test homes.

The first full suite failed only the two legacy audit-scope assertions described above. The final suite passed after those assertions and the authentication regression tests changed.

## Private package evidence

Private evidence is under `/Users/bakman/.agentmemory-labs/cold-20261006.3DMTEk/packages`.

Final package: `final/agentmemory-agentmemory-0.9.29.tgz`.

SHA-256: `7a69d33d39b916d06438fb72a396e8a2917098cfabec7ea14b44e540135d9d84`.

The earlier package used by the installed matrix has SHA-256 `ba0e8384bef5724e460ede88b83e051c8abf8f67aeabadc56616df3db0c7af1b`. The final package differs only in README text about local authentication. Its runtime build is unchanged.

The exact generated dependency lock and package metadata are saved privately as `upstream-0221.package-lock.json` and `upstream-0221.package.json`. The lock SHA-256 is `0dd2b555862995b3c000c31ff613285d26ab2eafe98eaa95464dc8e77f5a5d88`. The repository excludes lock files by policy. Preserve the private pair to reproduce this dependency set with `npm ci --ignore-scripts` in an independent source copy.

Build, suite, skill, installed-command, package, and dependency-tree evidence remains in that private directory.

`npm audit` reports 11 dependency findings: nine moderate and two high. The high findings affect transitive OpenTelemetry packages. Its proposed automatic repair changes helpers to `0.24.4`, beyond the required `0.22.1` pin. No automatic dependency repair was applied.

## Release gate

These checks validate the integrated source and package. The verification lane must still compare migration results, prove rollback, and obtain Fable acceptance. No production cutover, global upgrade, main merge, or push occurs as part of this source integration step.
