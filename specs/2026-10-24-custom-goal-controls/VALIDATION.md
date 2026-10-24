# Validation

## Review follow-up for #106

The review run passed **1,186 tests**, with zero failures/skips, and the manifest
self-check. It includes all 16 command editors and slash/shortcut routes, all
44 key editors, runtime dispatch, disable/default/inherit/reset, cancellation,
invalid-input correction and bounded layouts at 40/72/110 × 16/20/32.

All **ten actual Pi 1.4 CLI cases** pass: controls, settings paths, unsent editor
text, command shortcuts, combined pause, goal-first immediate stop, goal-first
natural finish, native interruption with a custom pause key, custom dialog keys,
and multi-question answer editing with letter-based controls. Terminal captures
include the saved pause selection, inherited source, recovery-only entry,
custom navigation and preserved typed answers. Settings-only cases send zero
provider requests. The local provider verifies the output file before approving
completion; no paid provider was used.

The full tests, RPC lifecycle and ten CLI cases ran together in about 70 seconds
locally, versus about 135 seconds if their measured individual times were added.
This is evidence on this machine, not a hosted-runner speed guarantee. The prior
green Actions run used eight jobs, 226 elapsed seconds and 552 summed job-seconds:
[baseline run 40084436857](https://github.com/tmonk/pi-goal-x/actions/runs/40084436857).
The new workflow has three jobs and retains all seven SDK versions, the two
minimum Node checks, context checks and the benchmark gate. It also retains
completed jobs for prose-only PRs. Path tests include mixed changes and deleted
runtime files; the parallel runner's failure test verifies that later checks
still finish and the failure remains visible. Publication safeguards pass their
six existing tests, and both workflow files pass actionlint 1.7.12.

Final review commands:

```sh
npm run check
npm run lint
node --test scripts/test-ci.mjs scripts/test-publish-workflow.mjs
python3 -B scripts/test-update-ranking.py
node scripts/ci-checks.mjs
node experiments/continuation/compatibility.mjs
npm run context:gate
npm run context:provider-check
node --experimental-strip-types experiments/context/retention-check.mjs
npm pack --dry-run
npm audit --omit=dev
```

Review evidence is in `evidence/review-*.json` and `evidence/terminal/review/`.
The original implementation evidence below is retained.

The first hosted three-job run exposed two RPC tests silently skipping when
invoked outside npm. The runner now adds the checkout's local executables to
PATH and rejects skipped tests or a missing summary. Its corrected local run
passed all 1,186 tests with zero skips, all ten terminal cases, and eleven
workflow/publication tests. Both executable discovery and skip rejection have
regression tests; the earlier timing samples above remain historical evidence.

2026-10-24. Base: `codex/continuation-defaults-and-prompt-profile` at 1e7a693.
Development SDK: Pi 1.4.0, also verified as the current npm release. No PR patch,
branch or contributor code was fetched or reused.

## Result

- **1,177 tests passed**, zero failures or skips, across 86 discovered files.
  The runner's manifest self-check passed in the same full run.
- TypeScript, ESLint, package dry run and whitespace checks passed. README is
  unchanged; the published package includes `docs/controls.md` and the runtime
  modules.
- Seven isolated SDK installations passed type checking, 39 actual-SDK checks
  per host and provider checks: 0.83.0, 0.84.1, 0.85.1, 0.86.0, 0.87.0, 1.0.0
  and 1.4.0. On the current SDK, the new case resumes a turn-only interruption
  behind an abort-settlement barrier, then reaches independently audited
  completion. Unit checks also cover the older settlement-event shape.
- The same fast-resume workflow passed on actual Node 22.15.0 / Pi 0.83.0 and
  Node 22.19.0 / Pi 1.4.0. Executor system prefixes remained stable and the
  independent auditor read the resulting artifact.
- The context gate passed all 24 fixtures. Six real SDK provider payloads and
  three Responses payloads passed their checks; retained histories through
  4 MiB passed. Default prompt fixtures stay unchanged; customised command
  hints use the preferred spelling without rewriting objective text.
- The 105-row performance gate passed against a separate copy of the parent
  commit measured on the same machine. The ordinary settings path keeps its
  existing small dashboard shape; optional control maps are copied only when
  configured. There are no model calls or new model tools for configuration.

Machine-readable results are in [checks.json](evidence/checks.json),
[compatibility.json](evidence/compatibility.json) and
[the performance gate](evidence/performance-gate.txt).

## Actual Pi CLI walkthrough

`npm run test:controls-cli` starts the installed CLI in a real PTY with isolated
agent/project settings and a local scripted provider. A separate extension
only observes `session_start` for readiness. The provider makes cancellation
and request counts repeatable; no paid model or external service is used.

All five scenarios passed:

1. Open Controls through `/goal-settings`; add `/goal edit`, reload and invoke
   it; record F6; reject an auditor-key conflict; change global/project scope;
   remove an override; inspect the 72×20 pause preview; rename Resume to
   `/work continue`; stop a running request, wait past its original response
   time without another request, pause on the second press, cancel a settings
   edit and resume to audited completion. Held time is not charged.
2. Open settings through an F10 command shortcut, save a command change, close
   both screens and find the original unsent editor text intact. No model
   requests occur. The shortcut context correctly offers `/reload` guidance.
3. Default combined stop: one Escape pauses the goal and stops the running
   request; no write or additional request occurs while paused. Resume
   completes and archives the goal.
4. Goal-first: the first Escape pauses the goal while work is still visible;
   the second stops the request immediately. Resume reaches audited completion.
5. Goal-first without a second press: the in-flight turn finishes, the goal
   remains paused and no second provider request is made. Resume completes it.

The controls, combined-stop and immediate goal-first cases use four requests
each, including the cancelled request and completion audit; the editor-only
case uses none. The last case
uses three, since the in-flight write finishes before resumption. See
[cli.json](evidence/cli.json) for the exact cases and counts.

Selected actual terminal frames:

- [Commands at 110×32](evidence/terminal/controls-ui/01-controls-wide.txt)
- [Saved alias](evidence/terminal/controls-ui/02-alias-saved.txt)
- [Conflict feedback](evidence/terminal/controls-ui/03-conflict.txt)
- [Inherited key](evidence/terminal/controls-ui/04-inherited-key.txt)
- [Pause preview at 72×20](evidence/terminal/controls-ui/05-pausing-narrow.txt)
- [Turn stopped](evidence/terminal/controls-ui/06-turn-stopped.txt)
- [Goal paused](evidence/terminal/controls-ui/07-goal-paused.txt)
- [Unsent editor text preserved](evidence/terminal/editor-controls/editor-preserved.txt)
- [Goal-first turn boundary](evidence/terminal/goal-first-finish/turn-finished.txt)

## Regression coverage

Controls tests cover all 44 public shortcut paths, command routing and
completion, reserved names, disabled lists, independent scope inheritance,
caller-owned arrays/provenance, legacy key aliases, native Pi key conflicts,
concurrent edits, inherited conflicts, recorded and manually entered keys,
comma keys, cancelled edits, input failures and UI bounds at 40/72/110 columns
and 16/20/32 rows. Existing questionnaire, confirmation, audit, modal, tool
profile, focus, scheduler and session-safety suites remain green.

Interruption checks include late callbacks, goal replacement, session changes,
refused resume, resume before settlement, both old and current abort events,
immediate second-press stop and deterministic goal-first turn boundaries.
