# Continuation default evaluation — 2026-10-23

This report records the prototype evaluation. The approved production changes
and fresh release evidence are in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## Decision

Preserve immediate implicit continuation for the standard user. Offer the existing
idle backoff only through an explicit, default-off choice. Keep strict execution
contracts and background orchestration optional. Do not introduce an automatic
default stall/pause rule based on recognized tools.

The evidence rejects unconditional backoff as the general default: it delays
productive reasoning and unfamiliar tools, and still permits a rapid loop if the
agent repeatedly calls a recognized tool. It can reduce spending for users who
choose its tradeoffs, but cannot establish whether an execution is useful.

This is a validated product direction and implementation plan, **not a merge-ready
production replacement**. The initial prototype's opt-out defect was fixed and
verified; that fix and its tests must be ported before shipping. The original #90
fix remains independently useful.

The subsequent context/speed review adds a release gate: Pi 1.0 custom-triggered
execution can initially carry stale or missing prompt guidance. A minimal
reproduction without this extension confirms host behavior. See
[performance evidence and budgets](PERFORMANCE.md) and the
[official Codex/Claude comparison](RESEARCH.md). The prototype is not being
presented as perfectly cache-stable or ready to merge.

## What was actually tested

- Original implicit policy: source at `64c5ace`.
- Current unconditional backoff: source at `3551bcc`.
- Candidate: an isolated copy of `3551bcc`, with explicit default-off preference,
  layered settings support, a plain-language settings row and a visible scope
  switch. [Prototype patch](evidence/prototype.patch).
- Installed CLI and real SDK: Pi 1.0.0. Node 26.10.0.
- 20 controlled scenarios using the actual SDK and a local scripted provider.
  Entry is the real `/goal-direct` command, not a seeded goal record or a direct
  scheduler call. These probe policy boundaries; the model behavior is scripted.
- Three successful real-model `/goal` journeys, with normal confirmation choices,
  spontaneous tool selection, independent auditor sessions and separately checked
  code/tests. One uses ordinary wording without mentioning the auditor.
- Three actual interactive terminal sessions: goal creation/pause/resume/completion,
  global/project preference selection, and opting out during a paced goal. Keys are sent to the installed CLI;
  captured terminal bytes are replayed through xterm for readable screen evidence.
- 72 offline request captures (24 fixtures against all three policies), 19 more
  SDK scenarios using `/goal` with draft confirmation, and warm/cold settings-entry
  microbenchmarks. No additional external model calls.
- Two minimal host-only prompt/profile reproductions, with no goal extension.

This is an agent-operated walkthrough, not a study of representative human users.
The real-model sample uses one provider/model, and no broad statistical performance
claim follows from it. Terminal evidence checks text and interaction, not graphical
theme contrast across terminal applications.

## Controlled comparison

Counts include auditor requests. A paced case is sampled while its saved due time
is approximately 30 seconds away; it is then stopped by the harness. It is delayed,
rather than proven incapable of eventual completion. The quiet interval is sampled
with its timer still armed. Long-delay enforcement already has deterministic
coverage on `3551bcc`; this evaluation does not pretend to wait through hours of
repeated idle work.

| Scenario | Original default | Current default backoff | Candidate default |
| --- | --- | --- | --- |
| Built-in-tool coding/review sequence | Completed, 8 calls | Completed, 8 calls | Completed, 8 calls |
| Two distinct reasoning responses, then record result | Completed, 6 calls | 2 calls, then ~30s delay | Completed, 6 calls |
| Save two report sections with a custom tool | Completed, 8 calls | 4 calls, then ~30s delay | Completed, 8 calls |
| Repeated `Standing by` replies | 4 calls; harness stopped loop | 2 calls, then ~30s delay | 4 calls; harness stopped loop |
| Generic invoice result `{status: pending, id}` | Completed, 5 calls | Completed, 5 calls | Completed, 5 calls |
| Repeat `bash: ls .` and `Standing by` | 8 calls; harness stopped loop | 8 calls; harness stopped loop | 8 calls; harness stopped loop |

Two additional candidate probes:

- Explicitly enable idle backoff: 2 calls, then the same ~30s delay. The option
  changes the selected workload without changing standard-user behavior.
- Opt into the existing strict wait route: 5 calls including one auditor call;
  no provider request during the observed waiting interval. Two identical producer
  wake signals produce one useful wake. The result file is verified and archived.

All **20 probes reproduced their expected observations**. This includes deliberately
observing the current policy's undesirable default behavior; `passed: true` in the
data does not mean that behavior meets the product acceptance criteria.
[Structured results](evidence/controlled-results.json).

The repeated `ls` case also prevents an overstated efficiency claim. An activity
heuristic can be both over-sensitive to useful work and insensitive to useless
work. It is a cost-control option with limitations, not semantic progress tracking.

## Context, speed and official product comparison

The additional [performance campaign](PERFORMANCE.md) found no added default bytes
in equal-state requests, no extra classification inference, zero optional goal
snapshots while disabled and local continuation around 4–5ms. Explicit waits remain
quiet until their wake. A configured four-run allowance stops through the product;
modeled no-tool guards also stop idle text, but interrupt a distinct reasoning
sequence. Byte counts, local dispatch time, actual model usage and policy-model
results are reported separately.

The live leading prompt changes after the first work tool in original and
candidate sessions. [Host-only evidence](evidence/profile-boundary-results.json)
reproduces the mismatch independently. The implementation plan now requires a
supported fix/compatibility resolution before claiming the first execution has
the correct prompt and stable cache prefix. Fixed-state equality alone is insufficient.

[Official documentation research](RESEARCH.md) covers Codex Goals, Claude Code
Goals/Stop hooks, known background waits, prompt caching and compaction. It supports
event wakes and stable prefixes, while exposing a real policy choice around
no-tool guards. No competing product was run, and their guard rules are not being
represented as progress proofs or silently copied into the default.

## Real-model journeys

Provider/model: `openrouter/deepseek/deepseek-v4-flash`, medium thinking. Each
project starts with a broken `normalizeName`, a tiny package and failing tests.
The objective is to trim/collapse whitespace, add coverage and pass the test suite.
No tool sequence, readiness declaration or completion call is forced.

| Run | Result | Executor / auditor calls | Elapsed | SDK-reported usage cost |
| --- | --- | --- | --- | --- |
| Current policy, explicit auditor wording | Passed | 11 / 8 | 71.4s | $0.00267 |
| Candidate, same objective wording | Passed | 16 / 5 | 66.9s | $0.00412 |
| Candidate, ordinary wording; no auditor terminology | Passed | 8 / 4 | 74.1s | $0.00153 |

All three produced the correct implementation, added passing tests, introduced no
dependencies, passed independent mixed-whitespace assertions and completed through
the real auditor. The ordinary-wording run passed four tests. Users selected the
normal auditor preference and confirmed the draft; **zero extra scheduling
declarations** were required. The actual terminal rich-confirmation UI combines
the auditor toggle with the draft confirmation, while primitive RPC uses separate
choices. [Results and artifacts](evidence/real-model-results.json).

These are not controlled timing/cost comparisons: model choices and auditor work
vary. Both policies handle this ordinary tool-rich task, while the controlled
reasoning/custom-tool counterexamples expose the default-policy difference. Costs
come from SDK usage reports, not an invoice or a claim about provider pricing.
The queued-opt-out correction was made afterward; its affected paths were checked
through the controlled SDK regression and actual terminal interaction rather than
repeating the paid coding runs.

The explicit-auditor wording led to unnecessary implementation/documentation
searches in drafting. The ordinary-wording run exercised automatic review without
that wording. Standard users should not have to name internal mechanisms. This
observation does not justify bundling a drafting redesign into the scheduler fix.

## Actual keyboard walkthrough

1. Started a clean Pi session with the candidate's default settings and typed
   `/goal Create greeting.txt ...`.
2. Read the real rich confirmation, left the auditor enabled and pressed Enter.
   The screen showed a running goal with no budget or scheduling setup.
3. Pressed Escape during visible work. The goal became paused and the operation
   aborted. At inspection there were two provider requests, and the artifact did
   not exist. No additional request occurred while paused.
4. Used `/goal-status`, including a 72-column, 20-row viewport. The paused state
   and ordinary controls remained visible. Decorative status borders wrapped;
   this does not establish pixel-perfect layout for every terminal.
5. Used `/goal-resume`. The file was written correctly, the independent fixture
   auditor approved it and the goal archived. The complete journey made five
   provider requests: draft, interrupted work, resumed work, completion and audit.
6. Opened `/goal-settings`, found the existing scope-switch omission, prototyped
   its visible row and reloaded the extension through `/reload`.
7. Selected global scope, enabled "slow repeated idle replies (opt-in)", opened a
   second project, observed inheritance, set a project override to false, and used
   "Use inherited value" to remove it. The persisted values and visible source
   labels matched each choice. These settings interactions made no model calls.

Screens: [confirmation](evidence/terminal-confirm.txt),
[running](evidence/terminal-running.txt), [paused](evidence/terminal-paused.txt),
[narrow status](evidence/terminal-narrow-status.txt),
[completed](evidence/terminal-complete.txt),
[existing settings](evidence/terminal-settings-before.txt),
[candidate default off](evidence/terminal-opt-in-default.txt),
[global opt-in](evidence/terminal-opt-in-global.txt),
[inherited value](evidence/terminal-opt-in-inherited.txt),
[project false](evidence/terminal-opt-in-project-false.txt),
[restored inheritance](evidence/terminal-opt-in-restored-inheritance.txt).
[Action/request trace](evidence/terminal-journeys.json).

A third terminal walkthrough tested the runtime change after fixing the first
prototype. A goal inherited the global opt-in and visibly delayed repeated idle
replies. While it was running, the operator opened settings and chose a project
override of false. The next productive provider request started about **16ms after
the preference file changed**, without `/goal-resume`; the correct artifact then
passed audit and archived. This is a local dispatch observation, not a provider
latency benchmark. [Visible pacing](evidence/terminal-runtime-paced.txt),
[completed after opt-out](evidence/terminal-runtime-opt-out-complete.txt),
[runtime action/request trace](evidence/terminal-runtime-opt-out.json).

The settings data checks additionally passed seven resolution/reopen observations
and rejected three unsupported values. Existing `"true"`/`"false"` string
compatibility is retained. [Preference results](evidence/preference-results.json).

## Defects and failed attempts retained

**Existing settings scope defect:** the current menu renders `Editing: project`,
but no selectable `Scope:` row. Its handler therefore cannot be reached through
the menu. A visible scope row worked in the actual prototype walkthrough. This
must be included when implementing global/project opt-in, with regression coverage.

**Initial failing prototype gate:** turn off backoff while a delay is already pending,
then explicitly ask scheduling to reconsider. The preference file says false, but
no immediate continuation occurs; the old delay remains. This is a real prototype
failure retained in [before-fix evidence](evidence/prototype-gap.json).

The corrected prototype re-evaluates scheduling on UI preference mutation, drops
disabled metadata before admission, checks the flag for accounting and avoids
pacing snapshots when off. The **same SDK gate now passes**: opting out admits the
next request immediately with consumption preserved. The actual terminal journey
above confirms the UI path. [After-fix evidence](evidence/prototype-opt-out-results.json).
Production must port these rules and cover restoration, enable/disable races and
status consistently; the old failure is not accepted as optional behavior.

Other evaluation setbacks:

- An incomplete headless UI stub omitted `setStatus`; switched controlled probes
  to the SDK's complete headless UI. The separate terminal test exercises real UI.
- A configured OpenCode key was expired. Switched to an already configured provider;
  no credential values were copied into evidence.
- The first real-model attempt hit a 20-request harness ceiling during review,
  despite producing correct code/tests. Increased the bounded ceiling to 40 and
  made execution errors fail promptly. Successful retries are reported separately.
  [Failed-attempt record](evidence/failed-attempts.json).
- An initial preference assertion rejected the repository's existing string-boolean
  compatibility; corrected the plan and probe to use the established normalization.
- Prototype typecheck caught the new settings section missing from its type union;
  fixed the prototype union and rechecked successfully.

## Implementation sequence and merge gates

1. Preserve #90 independently. Restore the original default continuation contract.
2. Implement the default-off option fully across settings, scheduling, claim,
   restoration, UI/status and accounting. Fix the demonstrated opt-out failure and
   ignore old pacing metadata when there is no explicit opt-in.
3. Add the visible scope selector and plain-language option/help. No extra question
   belongs in ordinary goal creation. Keep pacing bookkeeping off in default mode.
4. Add permanent tests for default reasoning/custom tools, preference inheritance,
   UI choices, queued enable/disable/reopen, stale callbacks, budgets, cancellation,
   ownership and audited completion. Promote the now-passing prototype regression
   to a permanent test, preserving its historical failure evidence.
5. Run typecheck, lint, all unit/integration/e2e tests, discovery self-check and the
   context gate before merging the production change. Keep detailed docs out of
   README. Separate optional producer adapters and stall recovery from this change.
6. Resolve the measured first-execution prompt/profile compatibility gate, using
   the standalone host reproduction and supported APIs. Verify fresh/drafted,
   resumed and reloaded requests across the supported SDK matrix; preserve the
   observations until a real fix is verified.

The production replacement is **not implemented in this planning commit**. In this
evaluation, repository typecheck/lint, explicit experiment lint, Python syntax and
the candidate extension typecheck passed. The earlier 1,127-test result belongs to
`3551bcc`; it is not presented as a rerun of a future production implementation.

The default can still loop if an executor keeps choosing no action and the user
has selected no limits. The candidate deliberately preserves that known tradeoff
instead of slowing every user through an unreliable classifier. It must not be
advertised as eliminating all default loops or as proof that #100 can be closed.

## Reproduce

With dependencies installed, from the repository root:

```sh
node experiments/continuation/prepare.mjs
node --experimental-strip-types experiments/continuation/compare.mjs
node --experimental-strip-types experiments/continuation/preferences.mjs
# Regression for the initially failing, now-corrected opt-out behavior:
node --experimental-strip-types experiments/continuation/compare.mjs --probe-opt-out

# Optional real-model run using existing configured credentials:
PI_GOAL_EVAL_PROVIDER=openrouter \
PI_GOAL_EVAL_MODEL=deepseek/deepseek-v4-flash \
PI_GOAL_EVAL_ORDINARY_WORDING=1 \
PI_GOAL_EVAL_ATTEMPT=ordinary \
node --experimental-strip-types experiments/continuation/live.mjs candidate

node --experimental-strip-types experiments/continuation/terminal.mjs
# In another terminal, append JSON actions to the printed actions.jsonl path.
# Example: {"text":"/goal Your objective\r"}
node experiments/continuation/screen.mjs
# End the terminal bridge by appending {"stop":true}.

# After running all walkthroughs, regenerate compact review evidence:
node experiments/continuation/summarize.mjs
```

Generated projects, sessions and full result files live under ignored
`experiments/runs/continuation-defaults`; the ordinary-wording real-model project
uses a separate temporary directory recorded in its result. Preparation overwrites
the disposable policy copies and controlled probes overwrite their own case
directories. Compact evidence is committed here for review. Real-model runs are
optional, bounded and require working provider access; scripted tests do not.
