# Production implementation and validation — 2026-10-24

The initial results below used Pi 1.0.0. The subsequent
[Pi 1.4 compatibility update](../2026-10-24-pi-1-4-compatibility/VALIDATION.md)
updates the development pins, native startup integration, thinking settings,
CLI tools and current release checks. Earlier evidence retains its original SDK.

Branch: `codex/continuation-defaults-and-prompt-profile`, based on `origin/main`
at `64c5ace`, retaining the preceding assessment and evaluation commits.

The ordinary workflow continues immediately after confirmation. Idle pacing is
an explicit global/project option, off by default. The first executor request
now receives the current Pi prompt and tools. The independent stale-context fix
for #90 is retained. The initial implementation left the README and dependency
pins unchanged; the follow-up above updates the SDK pins.

## Implemented behavior

- `idleContinuationBackoff` uses sparse settings, defaults to false, preserves
  explicit project false over global true, and supports removing an override.
  Existing string-boolean normalization and invalid-value diagnostics remain.
- Disabled pacing takes no goal-content snapshot and uses no progress classifier
  to admit continuation. No extra model request, declaration, creation question,
  default run cap or token budget was added.
- Opting in enables the existing 0/30/60/120/240/300-second ladder. Saved delays,
  whole-execution activity, claim admission, ownership and accounting remain
  covered. Old delay metadata is discarded without an effective opt-in.
- Turning pacing off reconsiders a pending dispatch immediately, preserves spent
  runs and does not resume a paused goal. Enabling it mid-execution starts
  observation on a later execution. Explicit `/goal-refresh` also applies edits.
- `/goal-settings` exposes the previously unreachable scope switch and explains
  the heuristic's limitations. Compact status shows the remaining delay, local
  clock time and `/goal-resume` within its existing row, preserving the footer.
- Strict waits, provider recovery, budgets, completion auditing and human-owned
  lifecycle controls retain their own behavior.

## Prompt/profile repair

`extensions/goal-prompt-profile.ts` projects the current public host prompt and
resolved transcript tool declarations into the provider request while an owned
goal is executing. It uses `ctx.getSystemPrompt()` and the SDK's public transcript
helper. It does not edit persisted history, patch SDK state, impersonate a user or
spend an additional model turn to prepare the prompt.

The request projection preserves conversation objects and tool/result adjacency,
additional extension instructions, unknown prompt sections, explicit content-only
head overrides, metadata and cache markers. Tests also cover additive leading
content with cache markers. Actual requests have the execution guidance and
schemas from the first request after direct creation, draft confirmation, resume
and paused-session reload; their executor prefixes remain stable through work.

The integration selects host capabilities: Pi 0.86 exposes system messages in
`context`; 0.87 and later expose `context_with_system`; classic hosts need no
projection. Pi 1.4 additionally distinguishes user prompts from custom triggers
in `before_agent_start`. Checkpoint extraction handles both public shapes, so a
custom checkpoint retains stale-turn rejection and recovery identity.

## Standard-user checks

All projects, settings and sessions were isolated. Terminal checks used the
installed Pi 1.0 CLI, actual keyboard input and a localhost scripted provider.
They were agent-operated walkthroughs, not a study of representative users.

| Journey | Production evidence |
| --- | --- |
| Start `/goal`, confirm and complete | Rich terminal confirmation; exact file; audit and archival. A real-model coding goal also fixed code, added tests and passed its independent audit. |
| Continue reasoning without tools | Twelve distinct reasoning responses in the controlled SDK campaign reach work and completion without pacing. This tests admission, not research quality. |
| Write, use custom tools and verify | Actual SDK commands invoke `publish_report`, write/read the result and complete. Generic `status: pending` data does not park the goal. |
| Escape, inspect and resume | Terminal pause stops the pending write; no artifact or further requests while paused. Narrow `/goal-status` and ordinary `/goal-resume` work. |
| Reopen a paused session | Actual SDK reload preserves pause, then resumes through the public command with the correct first prompt. |
| Choose settings scope and inheritance | Keyboard interaction enables global pacing, sets project false and removes that override. Effective values and files agree; settings make zero model requests. |
| Opt out during a delay | The next productive request starts 19.5ms after the saved preference change in the terminal fixture. Used runs advance from 3 to 4 without renewal; the artifact is audited and archived. This is local dispatch timing. |
| Read delay status at two sizes | Final captures at 110×32 and 72×20 retain the delay, resume command, goal file and footer controls. |
| Explicit producer wait | Controlled SDK wait is quiet before the event and accepts duplicate producer notifications once. This does not add a pi-subagents adapter. |
| Recovery and stale callbacks | Full-suite regressions cover retry/compaction, budgets, ownership, cancellation and the real SDK context invalidation reported in #90. |

Four permanent SDK journeys begin through user commands, without seeded goals:
drafting, direct creation, pause/resume and reload/resume. Each checks the first
prompt and stable executor prefix, correct artifacts, and a real auditor session
that independently reads the result. The terminal fixture checks the artifact
directly before returning audit approval; it is separate from those auditor tests.

The real-model production run used OpenRouter `deepseek/deepseek-v4-flash`, medium
thinking, ordinary objective wording, two normal dialog choices and the existing
sequential RPC dialog fallback. It completed in 75.7 seconds across 18 requests,
with zero scheduling declarations. Its five artifact tests and separate
assertions passed. SDK-reported cost was $0.002819; this is not a billing receipt
or a causal performance comparison. Rich confirmation was checked in the CLI.

## Context and speed

- The production campaign repeats 24 fixed-state captures against original,
  unconditional and default-off sources: 72 captures, with identical parent
  request bytes and matching child size breakdowns. Existing baselines were not
  regenerated.
- Nineteen SDK scenarios cover reasoning, custom work, idle replies, busy polling,
  optional pacing, a real run cap, explicit wait and modeled no-tool guards. Every
  production executor sequence has one system/tool-prefix variant. The historical
  sources still expose the original first-work-tool prefix transition.
- Default pacing observation takes zero goal snapshots at 10, 50 and 1,000 tasks;
  the last is an oversized stress fixture. Warm/cold timings and local dispatch
  distributions are in the evidence. These are not remote inference latencies.
- The existing runtime benchmark passes all 105 rows against `origin/main` on the
  same machine, including bounded checkpoints and agent-free execution checks.
- The 24-fixture context gate, real provider serialization and retained-history
  checks pass. Byte equality at equal state does not imply free context or a live
  cache hit rate. Correcting missing first-request guidance necessarily restores
  that guidance on affected live paths.

## Release checks

| Check | Result |
| --- | --- |
| `npm run check`, `npm run lint` | Pass |
| `npm run test:all` | 1,145 passed; zero failed or skipped |
| Test discovery/self-check | 78 unit, 1 integration, 6 e2e files |
| `npm run context:gate` | All 24 existing fixtures pass |
| `npm run context:provider-check` | Six SDK payloads and three Responses compatibility payloads pass; no HTTP dispatch |
| `experiments/context/retention-check.mjs` | Pass for text, tool output and images through 4 MiB histories |
| Same-machine runtime regression gate | All 105 rows pass against main |
| Isolated host compatibility | 0.83.0, 0.84.1, 0.85.1, 0.86.0, 0.87.0, 1.0.0 and 1.4.0: typecheck, 37 SDK checks and provider serialization pass per host |
| Packaging and maintenance checks | Package dry run, six publication checks and five ranking updater checks pass |

Local runs used Node 26.10.0 on macOS arm64/Apple M2. CI additionally checks Node
22.15 and 24; local host checks do not claim to have exercised those Node versions.
The compatibility workflow now retains the new user/profile regressions and
includes Pi 0.87 and 1.4 alongside its earlier boundaries.

## Limits and issue disposition

Immediate implicit continuation still permits an executor to loop indefinitely
when it never acts or completes and the user has selected no limit. Optional
pacing reduces request rate; it does not guarantee progress or finite spending.
It can delay reasoning/custom tools and be bypassed by repeated recognized work
tools. These are documented choices, not hidden default policy changes.

#90 is fixed. #100 is related and gains an optional mitigation; it must remain
open rather than being described as eliminated for every default user. The open
issue set was rechecked on 2026-10-24: #90 and #100. Producer adapters, optional
waits without mandatory ready declarations and a bounded stall policy remain
separate follow-ups. No upstream message or issue-state change was made.

## Reproduction and retained evidence

From the repository root:

```sh
npm run check
npm run lint
npm run test:all
npm run test:selfcheck
npm run context:gate
npm run context:provider-check
node --experimental-strip-types experiments/context/retention-check.mjs
node experiments/continuation/compatibility.mjs
node --experimental-strip-types experiments/continuation/efficiency.mjs --production
```

For terminal replay use `PI_GOAL_TERMINAL_SOURCE=production` with
`experiments/continuation/terminal.mjs`; its isolated action file accepts typed
input and resize operations. The live-model helper uses
`PI_GOAL_EVAL_PRODUCTION=1` and configured provider/model credentials; it incurs
provider usage. Detailed generated sessions stay in ignored `experiments/runs/`.
Readable screen captures omit right padding; raw PTY bytes remain in those runs.

Committed evidence is under [evidence/production](evidence/production):
[SDK draft](evidence/production/sdk-draft.json),
[direct](evidence/production/sdk-direct.json),
[pause](evidence/production/sdk-pause.json),
[reload](evidence/production/sdk-reload.json),
[terminal journeys](evidence/production/terminal-journeys.json),
[real model](evidence/production/real-model.json),
[context/speed campaign](evidence/production/efficiency.json),
[host checks](evidence/production/compatibility.json) and
[runtime gate](evidence/production/runtime-benchmark-gate.txt). The compact
[release check record](evidence/production/checks.json) lists counts and methods.
