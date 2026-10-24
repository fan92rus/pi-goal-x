# Validation

PR: [#107](https://github.com/tmonk/pi-goal-x/pull/107). Requires Pi 1.4+ within 1.x and Node 22.19+.

| Check | Result |
| --- | --- |
| Full suite on Node 22.19 | 1,216 pass, zero failures or skips; 91 discovered test files. |
| Installed Pi CLI | All ten walkthroughs pass: settings, editor controls, controls UI, command shortcuts, three pause-order paths, dialog keys, native interrupt and answer editing. Separate drafting/execution/audit/archive lifecycle passes. |
| Actual SDK goal handoff | Four rejected dispatch forms cause zero provider requests and leave replacement bytes unchanged. Mid-run creation then a queued old checkpoint completes in a fresh run: exactly three requests, correct run bindings, usage 0 before replacement work and 16 afterward, one autonomous allowance claim. |
| Actual SDK context | Ordinary, automatic and delegated sessions preserve the first prompt, prompt sections, tool changes, model boundaries and post-compaction prefixes. |
| Actual SDK arguments | Twelve cases cover redundant matching fields, empty optional IDs and batches, literal dash IDs, conflicts, malformed arrays and atomic rollback. |
| Context gate | All 24 fixtures pass. Semantic counts and goal-message sizes are unchanged. Task-enabled schemas add 73 characters, about 18 estimated tokens. |
| Provider boundaries | Six actual SDK serialization payloads pass; no external model requests. |
| Performance | All 105 comparisons against main pass the regression gate. Initial local base/branch runs take 19.3s/18.9s; these are machine-specific observations. |
| Packaging and dependencies | Package dry run passes; production audit reports zero vulnerabilities. |
| Types, lint and workflows | Type check, ESLint, 11 publication/CI tests, five ranking tests and actionlint pass. |
| Windows | Native 15/15 checks pass on Windows Server 2025, Node 22.19, commit 3a9ed4d, including the pool snapshot delta writer. |
| Contributor attribution | GitHub resolves all five co-author trailers to their intended user profiles. See CONTRIBUTIONS.md. |

The [successful CI run on 58f8d66](https://github.com/tmonk/pi-goal-x/actions/runs/40092556890) includes the full Linux checks and the first successful Windows run. The [final Windows check on 3a9ed4d](https://github.com/tmonk/pi-goal-x/actions/runs/40092852584/job/120868921488) passes all 15 tests. Runtime sources and tests are unchanged after that check; the final commit removes the temporary job and records the evidence. Native Windows tests hold files open in a separate .NET process without delete sharing, exercise real OS failures, and verify recovery plus permanent-failure preservation and temporary-file cleanup. Portable simulations remain in the normal suite; native Windows execution is specific to this PR.

Reproduce the regular checks with `node scripts/ci-checks.mjs`, `npm run check`, `npm run lint`, `npm run context:gate` and `npm run context:provider-check`. Run native tests manually from Windows with `node --experimental-strip-types --test tests/goal-atomic-rename.test.ts tests/windows/atomic-rename.test.ts`. The standard-user workflows use Pi's real SDK/CLI with deterministic local provider fixtures and independently verified files.

The final PR keeps one Linux validation job. It removes the older Pi compatibility matrix and the temporary Windows job. Historical specifications and released changelog entries remain as records; README scope is unchanged.
