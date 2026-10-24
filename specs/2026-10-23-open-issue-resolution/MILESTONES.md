# Implementation log

## Assessment and branch

- Retrieved the full current open issue set (#90 and #100) and all comments
  (none). Fetched origin and confirmed the working branch starts at current
  `origin/main` (`64c5ace`).
- Read the user overview, architecture, runtime design, earlier implicit
  continuation decision, scheduler/audit paths and existing regression suites.
- Accepted both issues. Chose durable exponential idle pacing to preserve
  reasoning-only continuation and human-owned lifecycle controls. Explicitly
  supersedes the September spec's acceptance of unpaced unproductive loops;
  does not adopt the broader background-task detector from PR #83.
- Created `codex/fix-open-issues-90-100`. The pre-existing untracked
  `specs/2026-10-01-open-pr-disposition/` is unrelated and will remain untouched.

## Implementation and targeted validation

- Added regressions before changing runtime code: 11 of 57 focused tests failed
  on the original implementation, reproducing stale session/idle getters and
  repeated immediate continuation despite inspection-only activity.
- Audit flush now recognizes only Pi's stale-context error and reports an invalid
  callback before changing the queue. Settlement skips the obsolete runner;
  session/tree transitions clear old intent.
- Added optional durable pacing metadata, a bounded idle ladder, whole-execution
  work tracking and content-only goal snapshots. Fixed the existing `args` to
  `input` mismatch so goal-file reads and echo calls remain excluded.
- Added claim-time due checks, waiting-time accounting protection, restore/resume,
  producer takeover, stop-boundary and corruption coverage. All 65 focused tests
  pass; the typecheck passes.
- Actual SDK/local-provider workers pass: an unlimited idle goal issues only its
  initial request and one immediate continuation before pacing, then reacts
  promptly to producer input and resume while preserving allowance enforcement.
  Reload during an earlier settlement handler invalidates the real SDK context;
  the old goal handler safely skips it and the replacement runner remains usable.

## Full-suite follow-up

- Initial full unit/self-check run: 1074/1075 passed. The sole failure was the
  older golden explicitly requiring a second immediate idle dispatch; updated
  it to assert a still-active, ready, declaration-free goal with saved pacing.
- Integration 31/31, typecheck, lint and context gate (24 unchanged fixtures)
  passed. Ordinary prompt baselines need no regeneration: the due-time line
  appears only while an actual idle delay is pending.

## Final validation

- `npm run test:selfcheck`: discovery manifest matches (77 unit, 1 integration,
  5 e2e files); unit tests **1075/1075 passed**.
- `npm run test:integration`: **31/31 passed**.
- `npm run test:e2e`: **21/21 passed**, including actual SDK reload invalidation,
  uncapped idle pacing, producer/resume responsiveness, strict contracts,
  compaction/retry and sustained 503/429 recovery.
- `npm run check`, `npm run lint`, `npm run context:gate` (24 fixtures) and
  `git diff --check`: passed.
- Rechecked GitHub at completion: #90 and #100 remain the complete open issue
  set. Fixes are prepared on this branch; no issue state was changed.
- Reviewed the runtime diff against the assessment: no completion/focus ownership
  changes, new tool/schema arguments, pacing settings or background-producer
  assumptions. Unknown/custom tools can still be paced if they neither register
  recognized work nor change goal content; continuation remains available.
- The unrelated pre-existing untracked spec and README are untouched.

## Follow-up product steering

- User requested a full plan and human-style evaluation, confirming that ordinary
  `/goal` work should continue promptly and specialized controls should be opt-in.
- The initial default-backoff choice is provisional and must not be merged as
  final policy. See `../2026-10-23-continuation-defaults-validation/` for the full
  replacement plan, comparative/terminal/real-model results and merge blockers.
- #90 stays independently accepted. The production opt-in revision is pending;
  the validation result above describes `3551bcc`, not that future revision.

## Final production revision — 2026-10-24

- Retained #90 independently and replaced unconditional pacing with the approved
  default-off option. Resolved the Pi prompt/profile gate through public APIs.
- Final suite: 1,145 tests pass. Seven host boundaries through Pi 1.4, real CLI
  settings/pause/resume, a real-model coding goal and context/runtime gates pass.
- See `../2026-10-23-continuation-defaults-validation/IMPLEMENTATION.md` for current
  evidence and limits. #100 remains related rather than auto-closed: unlimited
  implicit continuation can still loop without optional controls.
