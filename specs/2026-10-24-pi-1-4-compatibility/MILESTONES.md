# Implementation log

- User requested current Pi throughout the branch/PR. Verified 1.4.0 for all
  three SDK packages through npm and the official release on 2026-10-24.
- Existing branch is `codex/continuation-defaults-and-prompt-profile`, PR #105.
  The unrelated untracked `2026-10-01-open-pr-disposition` spec remains untouched.
- Current development pins are 1.0.0 despite seven-host compatibility coverage.
  Current release docs confirm native custom-run prompt preparation since 1.2,
  event shape changes and provider transcript/cache improvements. Wrote product
  and technical scope before implementation.

## Implementation

- Pinned all three SDK packages to exact 1.4.0 and regenerated the lockfile from
  the earlier locked tree. Updated compatible security fixes without keeping an
  exploratory broad lint-tool update. Clean installation and full audit pass.
- Audited current event, transcript/tool, UI, child-session, model and provider
  APIs. Native custom startup is detected through its public event protocol;
  current hosts bypass request projection, retaining structured deltas. Old
  affected structured hosts retain the repair; classic hosts remain native.
- Added settlement abort handling for cancelled startup, completed turns and
  provider recovery, with replacement-goal protection. A new actual-SDK journey
  cancels before any request and resumes to audited completion.
- Found `max` missing from the extension's thinking lists despite SDK support.
  Shared the seven choices across settings, auditor parsing and selector;
  verified auditor/Oracle persistence through unit/integration and actual UI.
- CLI tools resolve the local ESM SDK version/binary. The PTY bridge now executes
  that binary; probe metadata no longer hard-codes 1.0. Historical captures retain
  their real versions. CI includes the installed CLI lifecycle, Pi 1.0 fallback
  and the current host's minimum Node version.

## Failed attempts and fixes

- The first metadata resolver used CommonJS resolution on an import-only SDK
  export and failed before starting. Switched to `import.meta.resolve()`.
- The first added-instruction fixture wrote an unsupported `addendum` option.
  Corrected it to the public `systemPromptOptions.sections` field. All current
  SDK executor payloads preserve the section through tool turns.
- A legacy draft test could see no goal and idle before creation had finished,
  then read a missing artifact. Tightened completion to require the file too;
  all seven host runs then pass. This was a harness race, not a reason to narrow
  compatibility or remove an initial request from the measurements.
- Local CLI selection initially changed argv while Python still called global
  `pi`. Discarded that probe and fixed `execvp` to use argv[0]. Fresh terminal
  startup shows 1.4.0. The global installation was not modified.
- The old CLI check waited its full deadline even after three-request audited
  completion. Detect the completion tool result promptly and retain the final
  on-disk ledger/archive verification.
- One terminal capture reached its own 240-second ceiling during extended
  exploration. Finished settings in a separate current-SDK project, with zero
  provider calls, and retained the method limitation in the evidence.
- Adding `max` correctly broke the selector's old six-level count assertion;
  updated it and verified the actual menu and persisted values. Final full suite
  passes rather than treating that assertion as an ignored failure.

## Final validation

- Clean install, typecheck, lint and explicit helper lint pass. Full suite:
  **1,150 passed, no failures/skips**, 85 files. No discovery-manifest change.
- Seven SDK versions pass typecheck, 38 real SDK checks per host and provider
  serialization. Actual Node 22.15/Pi 0.83 and Node 22.19/Pi 1.4 runs each pass
  all 38 checks. Root development uses Pi 1.4.0 and Node 26.10.0.
- Existing 24-fixture context gate passes without baseline updates; six provider
  plus three Responses payloads and 4 MiB retention checks pass. Repeated
  72-capture/19-scenario campaign has no added default payload or pacing snapshot
  and one candidate executor prefix variant. Same-SDK 105-row runtime gate passes.
- Installed CLI smoke: Pi 1.4, three requests, independent audit and archival.
  Real terminal confirmation, Escape/pause, narrow status and resume produce the
  correct artifact; settings inheritance/override removal and both `max` choices
  persist with no model calls. Actual SDK checks independently read the result
  in the auditor and preserve an external extension's prompt section.
- Real-model current-SDK coding goal passes: 20 requests/59.7s, two normal dialog
  choices, five artifact tests, independent assertions and audit, no scheduling
  declarations. SDK-reported cost $0.003069; not a causal comparison or invoice.
- Package dry run, six publication checks, five ranking checks and full dependency
  audit pass; zero vulnerabilities. `VALIDATION.md` links compact evidence.
- The earlier continuation report now links this current-SDK follow-up. README,
  global installation and the user-owned untracked spec remain untouched. Existing
  PR #105 is the destination; #100's opt-in instructions remain applicable.
