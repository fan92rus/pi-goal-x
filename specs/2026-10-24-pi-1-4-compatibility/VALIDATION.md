# Pi 1.4 implementation and validation

2026-10-24. Branch: `codex/continuation-defaults-and-prompt-profile`, PR #105.
Pi 1.4.0 was verified as the current published release for all three SDK packages
through npm and the [official release](https://github.com/earendil-works/pi/releases/tag/v1.4.0).

## Changes

Development dependencies and the lockfile now use exact 1.4.0 versions of pi-ai,
pi-coding-agent and pi-tui. Existing overrides use undici 8.12.2 and brace-expansion
5.0.12; the lockfile also takes the compatible js-yaml 4.3.2 fix. Unrelated lint
tool versions remain pinned by the earlier lockfile. The full dependency audit
reports zero vulnerabilities.

The API review covered startup/settlement, prompt and tool state, child sessions,
UI dialogs, model/thinking configuration and provider serialization. The current
SDK types compile the whole extension and test tree. Three relevant runtime gaps
were addressed:

- Pi's public user/custom startup protocol identifies native prompt preparation
  introduced in 1.2. Current hosts retain their structured prompt/tool deltas;
  affected older hosts retain the request-only projection. No SDK internals or
  persisted transcripts are patched.
- `agent_settled.aborted` cancels continuation and recovery, including startup
  cancellation before the first model request. Only the associated goal is
  paused; replacement goals are protected. Older signal-based handling remains.
- Auditor/Oracle parsing and the settings selector share all seven thinking
  choices, including `max`. The selected model's supported level remains Pi's
  responsibility; the default is unchanged.

CLI probes now resolve the checkout's ESM SDK entry, version and published binary
path rather than a global executable. The PTY bridge executes that configured
binary. Reusable measurements record the actual SDK, and the standalone native
prompt probe no longer assumes the old bug exists or overwrites its historical
1.0 evidence. The CLI lifecycle is now part of CI; Pi 1.0 fallback coverage is
explicit, and the current host also runs at Node 22.19.

## Release checks

| Check | Result |
| --- | --- |
| Clean `npm ci --ignore-scripts` | Pass; all three development SDKs resolve to 1.4.0 |
| Typecheck and lint | Pass, including explicit continuation-helper lint |
| Full suite | **1,150 passed**, zero failures/skips, 85 files |
| Context gate | All 24 existing fixtures pass; no baseline refresh |
| Provider boundaries | Six SDK payloads and three Responses compatibility payloads pass |
| Native prompt probe without pi-goal-x | Fresh custom and post-confirmation first requests both have correct execution guidance |
| Host matrix | 0.83.0, 0.84.1, 0.85.1, 0.86.0, 0.87.0, 1.0.0, 1.4.0: typecheck, 38 SDK checks and provider payloads pass per host |
| Actual minimum-Node runs | 38 checks pass on Node 22.15/Pi 0.83 and on Node 22.19/Pi 1.4 |
| Runtime benchmark | All 105 rows pass against main on the same installed SDK/machine |
| Context/continuation campaign | 72 fixed-state captures and 19 SDK scenarios pass; one candidate executor prefix variant, zero default pacing snapshots |
| Retention | Text, tool output and image histories through 4 MiB pass |
| Package/maintenance | Dry run, six publication checks, five ranking checks pass |
| Dependency audit | Zero vulnerabilities, including development dependencies |

The main local run used Node 26.10.0 on macOS arm64. Minimum-Node checks used the
actual pinned Node executables, not a version emulation. The extension retains
its Node 22.15 floor for older hosts; Pi 1.4 itself requires Node 22.19 or newer.

## User workflows

Five real-SDK journeys start through ordinary commands: drafting, direct creation,
pause/resume, paused-session reload/resume and startup abort/resume. They reach
correct artifacts and a real auditor tool read. On current Pi, every executor
request retains another extension's custom prompt section, starts with execution
guidance and keeps its prefix stable. Startup cancellation pauses before any
provider request, then ordinary resume completes the goal.

The actual Pi 1.4 terminal walkthrough covers rich confirmation, Escape during a
pending write, narrow status, resume, audit and archival. While paused, the fixture
made two requests in total and had not written the file. Completion produced the
exact file in five total requests. A separate settings-only terminal verifies
global opt-in, project inheritance, explicit false and override removal, then
selects and persists `max` for both the auditor and Oracle. Settings made zero
provider requests. These were agent-operated walkthroughs, not a user study.

A real OpenRouter `deepseek/deepseek-v4-flash` coding goal completed on SDK 1.4.0
with ordinary wording, two normal dialog choices and independent audit. The
five artifact tests and separate assertions passed: **20 requests, 59.7 seconds,
zero scheduling declarations**, SDK-reported cost **$0.003069**. This is one
nondeterministic observation, not a causal speed/cost comparison or billing receipt.

## Reproduction and evidence

```sh
npm ci --ignore-scripts
npm run check
npm run lint
npm run test:all
node scripts/live-session-check.mjs
npm run context:gate
npm run context:provider-check
node experiments/continuation/compatibility.mjs
```

Structured evidence: [checks](evidence/checks.json),
[compatibility](evidence/compatibility.json),
[native prompt probe](evidence/native-profile.json),
[SDK draft](evidence/sdk-draft.json), [direct](evidence/sdk-direct.json),
[pause](evidence/sdk-pause.json), [reload](evidence/sdk-reload.json),
[startup abort](evidence/sdk-abort.json),
[CLI lifecycle](evidence/cli-smoke.txt), [terminal](evidence/terminal.json),
[real model](evidence/real-model.json),
[context/speed](evidence/efficiency.json) and [runtime gate](evidence/runtime-gate.txt).
Readable terminal frames are in [evidence/terminal](evidence/terminal).

The first attempted terminal probe still launched the global 1.0 executable
because the Python bridge ignored its configured binary; it was discarded and
the bridge fixed. A later lifecycle capture hit its 240-second harness ceiling
during settings exploration; the separate current-SDK settings run completes
that evidence. A legacy SDK harness initially mistook an empty pre-creation state
for completion; it now waits for the artifact as well as idle/archival. These
failures and fixes are recorded in `MILESTONES.md`; prior 1.0 evidence is retained.

PR #105 still leaves #100 open. Default continuation remains immediate and
unlimited unless a user chooses controls. `idleContinuationBackoff: true` slows
repeated idle replies; a finite run allowance gives a hard stop. No global Pi
installation, README layout, real settings or unrelated spec was changed.
