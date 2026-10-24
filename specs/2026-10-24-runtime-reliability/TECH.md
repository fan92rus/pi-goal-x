# Implementation and verification

Work on `codex/runtime-reliability-and-tool-inputs` from the released main branch.

## Run admission

Use scheduler admission state to distinguish an internally rejected checkpoint from user cancellation. Preserve that rejection across Pi's startup event order and until settlement. Denied runs must not execute goal tools, start goal accounting, pause/recover the current goal, or overwrite its saved dispatch. Reset transient admission at the proper run/session boundaries and let existing valid intent schedule after rejection. Repeated agent_start events retain the original run identity. Creating a different goal mid-run saves a kickoff for it; settlement schedules that explicit intent without inventing continuation for an arbitrary focus change. Exercise the complete SDK lifecycle, including actual mid-run goal creation, same-goal stale generations and subsequent legitimate work.

Accounting must also reject a mismatch between an already-bound run and the focused goal, including before the queued stale message arrives. Start replacement accounting only when its fresh run begins. Assert the replacement's exact usage at each provider request so creation tokens cannot leak across focus changes.

## Context transforms

Pi 1.4 provides context_with_system and native custom-turn prompt preparation. Register the transform directly, preserve system messages and their positions, and remove the older custom-turn profile projection entirely. Update capture/test harnesses to dispatch the full-transcript event. Test parent/delegated filtering and actual provider payloads, including prompt/tool deltas, model changes and compaction boundaries.

## Tool inputs

Normalize task progress input once at the tool boundary. Keep schema and execution consistent, reject malformed arrays/entries, permit an empty array only with valid single-task input, and require every meaningful redundant root field to match one batch entry. Keep batches ordered and atomic. Normalize only genuinely empty optional detail IDs; `-` remains a real ID. Validate through the SDK boundary and retain the existing mutation/rollback tests.

The measured schema change adds 73 serialized characters (about 18 estimated tokens) only when task tools are active. All 24 fixture semantic counts and goal-message sizes stay unchanged. Refresh the committed context baseline for that intentional schema delta; keep the full-transcript capture asserting that the original host head is preserved.

## Atomic replacement

Add a small rename helper used explicitly by atomic goal, settings and checkpoint writers. Retry only supported transient Windows errors with a short bounded synchronous schedule and an asynchronous counterpart; never unlink a destination to force success. Callers retain temporary-file cleanup and locking. Tests inject errors to cover deterministic timing and use a separate Windows process holding a file without delete sharing to prove real recovery. Run native Windows checks using a temporary job on this PR, record its tested commit and results, then remove that job before completion. Keep the native test available for manual use without adding recurring CI.

## Evidence and credit

Record reproducers, design decisions, setbacks and validation in MILESTONES.md. Track source PRs, authors and adapted contributions in CONTRIBUTIONS.md. Use separate commits with accurate co-author trailers for adapted contributions and explicit contributor/PR links in the final PR. Run full tests with zero skips, types/lint, context/provider and performance gates, actual CLI workflows and the focused Windows check before marking the PR ready. Keep one regular validation job against Pi 1.4, including the declared Node minimum; remove the older-host compatibility matrix and its legacy glue. Retain historical specs/changelog entries as records.

Before merging, verify package and lockfile peer floors and development SDK pins, installed/transitive Pi versions, active source imports/hooks, CI, current docs, tests and runnable experiments. Replace the remaining test for absent legacy settlement fields with the current explicit boolean protocol. Release 0.34.0 using the existing trusted-publishing workflow; preserve co-author history with a merge commit. Follow the dedicated release spec for artifact verification.
