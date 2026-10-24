# Continuation defaults: product plan and comparative validation

## Confirmed user direction

On 2026-10-23 the user asked for a full plan, tested as a human would use the
extension, prioritizing correctness, efficiency and ease of use for standard
users. The user explicitly confirmed this interpretation:

> Someone starts `/goal`, expects useful work to continue immediately, and uses
> ordinary pause/resume controls. Long-running background orchestration and extra
> cost controls are optional.

The standard user does not configure execution contracts, classify tools, declare
readiness after each response, or diagnose why a progress detector delayed work.
Optimize this experience first. A specialized workload is evidence for an option,
not automatically evidence for changing every user's default.

## Scope and deliverables

1. A complete product and implementation plan covering defaults, opt-in behavior,
   compatibility, UI, persistence, costs, failure recovery and rollout.
2. A comparative evaluation of the original implicit default, the current branch's
   unconditional idle backoff and a candidate opt-in design. Use real goal
   commands and user-visible outputs, plus repeatable boundary probes.
3. A reproducible report with actual requests, delays, artifacts, user actions,
   failures and limitations. Distinguish scripted provider tests, real-model
   sessions and terminal interaction; none alone proves broad user usability.
4. A sourced comparison with official Codex and Claude Code documentation, plus
   measured context growth, prompt-prefix stability and local dispatch costs.
   Treat their policies as alternatives to evaluate, not proof that one is right
   for Pi. Keep differences between ordinary agent turns and goal continuation
   explicit.

## Context, speed and usability requirements

The user's further direction on 2026-10-23 makes all three release criteria, rather
than incidental observations:

- Default continuation adds no model call to classify progress and no artificial
  timer delay. Avoid serial work when existing independent work can run together.
- Keep system/tool prefixes stable, retain small history triggers, and inject
  current state at the request tail. Do not repeat full objectives or add a new
  ready declaration to each ordinary execution. Preserve Pi's compaction and
  provider-cache behavior; a cache hit is not free context or zero cost.
- Explicit waiting makes zero model requests before its event/deadline. UI timer
  updates and opening settings also require no inference. Measure actual request
  payloads and local dispatch separately from remote inference latency.
- Disabled optional pacing does not serialize goal content or classify tool
  activity. Long task lists must not introduce proportional default pacing work.
- One ordinary start/confirm flow, clear running/paused/completed status and the
  existing pause/resume controls remain sufficient. Advanced settings must show
  scope, effective value and source, explain consequences, and support undoing a
  pending delay. Avoid implementation jargon in normal status messages.
- Test bounded no-tool continuation guards from the comparison products against
  useful reasoning and unfamiliar tools as well as repeated empty replies. Report
  their false stops and the candidate's remaining idle-loop cost honestly. Do not
  claim universal optimality or silently change the confirmed default persona.

Use reproducible, offline measurements for scheduler and context comparisons.
Existing real-model observations establish successful workflows, not a statistically
valid speed ranking. Record budgets, baselines, evidence limitations and remaining
production gates in the technical plan and evaluation report.

The new SDK measurements exposed a prefix transition after the first work tool,
shared by the original and candidate policies. A minimal reproduction without
pi-goal-x confirms the host's custom-turn prompt/profile mismatch in Pi 1.0. Do
not call the live path perfectly cache-stable. Before release, ensure the correct
execution prompt/profile is applied at the first executor request through a
supported host path or upstream fix. Retain the reproduction and compatibility
limitation; do not patch private host state. Neither a passing fixed-state context
gate nor an unchanged tool schema proves that a live system prefix stayed identical.

The comparative evaluation is complete. On 2026-10-24 the user authorized full
production implementation, including the Pi 1.0 prompt/profile resolution and
fresh end-to-end standard-user tests. Port the validated default-off behavior,
finish preference/persistence/UI edge cases, and retain #90 independently.
Historical evaluation evidence describes the prototype; release evidence must
exercise the resulting production sources.

Use the documented Pi 1.0 `context_with_system` boundary to align goal continuation
requests with the host's current effective prompt and declared tools. Preserve
other extensions' additional instructions, tool/result pairing, explicit cache
markers, host history and old-host behavior. No private SDK state, extra inference
or synthetic user authorization is permitted. Test the first request after direct
creation, drafting, resume and reload, as well as the first tool follow-up.

## Desired default

- `/goal` discusses and confirms the objective; ordinary execution then continues
  promptly until completion, a real blocker, explicit pause or a configured limit.
- Successful reasoning, prose writing, research, stock tools, third-party tools and
  final verification receive the same continuation opportunity. No work-tool
  allowlist, goal-file mutation or prose pattern is required to continue.
- Preserve implicit continuation, `strictExecutionContract: false`, no configured
  autonomous-run cap, and no token budget unless the user selects one.
- Preserve completion auditing and human-owned focus/lifecycle controls. Elapsed
  silence, missing task updates and an unfamiliar tool do not prove failure.
- Default status is understandable without scheduler terminology. No new question
  or setting is required during ordinary creation.
- Safety for stale/duplicate dispatches, ownership, cancellation and budgets is
  common to all policies. Provider-error recovery retains its separate backoff.

Default efficiency means no artificial delay or protocol overhead on ordinary
work. It does not promise zero wasted requests when an executor persistently
chooses no action: that guarantee conflicts with unrestricted implicit reasoning.
State this tradeoff plainly rather than claiming a perfect progress detector.

## Optional behaviors to evaluate

### Idle backoff

Candidate: one discoverable global/project setting, `idleContinuationBackoff`,
default `false`. Explicit `true` enables the existing durable idle delay ladder.
Use a user-facing label such as "Slow repeated idle replies (opt-in)" in settings;
the user should not need to understand the implementation term "backoff".
Explicit project `false` overrides a global `true`; removing an override inherits.
It does not enable strict contracts, renew allowance, resume a paused goal, impose
a token budget or change audited completion.

The tool/content heuristic is a documented approximation for opted-in workloads.
Custom tools and reasoning can be paced; repeated recognized tool activity can
evade pacing. Do not label this semantic progress detection or guaranteed loop
termination. Show a pending delay with a useful next time and the existing resume
control. Turning it off cancels the pending delay without replaying or double
charging a dispatch. Turning it on applies at the next eligible settlement and
does not retroactively declare an execution idle.

Evaluate whether the option is actually useful enough to ship. The exact ladder
is secondary to preserving default behavior and explaining its consequences.

### Background dependency waits

An explicit active-but-waiting goal is the efficient solution when a known
dependency is the only remaining action. Completion events should wake it without
polling the model; an actual deadline or explicitly bounded check may also wake it.
Waits must be chosen explicitly, survive reopening, preserve allowance, reject
duplicates and stale results, and yield to user input and pause/resume.

The shipped strict ready/wait protocol is already opt-in. Test it as the existing
advanced route. Assess decoupling optional waits from mandatory ready declarations
as a separate follow-up; it is not a prerequisite for the standard default or a
reason to add producer-specific inference. An unintegrated producer cannot be
promised automatic completion wakeups. Unknown tool results must not park a goal.

### Stall recovery

Do not silently introduce a default pause/quiet state based on a tool allowlist.
If bounded stall recovery is later desirable, make its policy explicit and test
false positives with reasoning, unfamiliar tools and long work before adoption.
It is separate from provider-error recovery and independent completion auditing.

Terminal inspection found a large existing settings menu. Put the optional idle
control beside other advanced execution controls; do not add it to goal creation
or make standard users choose a scheduling policy. Prototype the row and its
inherit/override actions before claiming the option is discoverable and usable.

The actual terminal inspection also exposed a settings usability defect: the
current menu displays "Editing: project" and has code for a `Scope:` action, but
does not offer that action. A standard user cannot discover a global-scope switch
in this menu. The plan must include a visible scope selector and test it through
actual keyboard interaction before claiming global/project opt-in is easy to use.

## Alternatives and decision criteria

| Policy | Standard workflows | Repeated idle replies | Main risk |
| --- | --- | --- | --- |
| Original implicit default | Immediate, no protocol | Can repeat without bound | Optional limits may be needed |
| Current branch default backoff | Can delay legitimate work | Slower, still unbounded | Whitelist changes all users' behavior |
| Candidate opt-in backoff | Original default preserved | User can select pacing | Approximate detector needs honest labeling |
| Mandatory ready/wait | Extra declarations | Explicit scheduler control | Protocol cost and false repair pauses |
| Explicit dependency wait | Prompt work outside the wait | Zero model requests while waiting | Needs an identified producer/wake route |

Accept a default only if all standard journeys complete without artificial
scheduling delay, extra configuration or scheduler repair prompts. Choose optional
features by measured savings and a clear recovery path, not by one pathological
transcript. Do not claim any policy is universally optimal.

## Human-style acceptance journeys

| ID | User journey | Observable acceptance |
| --- | --- | --- |
| H1 | `/goal` a small coding change, confirm, inspect result | Correct artifact and tests; completion audit; no scheduling setup |
| H2 | A research/analysis goal spanning responses without tools | Continuation is immediate; coherent completed answer |
| H3 | A writing task followed by verification and completion | Final review is reached without arbitrary pacing |
| H4 | Productive work through an unfamiliar/custom tool | Same continuation behavior as built-in tools |
| H5 | Pause/Escape, inspect, resume | Clear paused status; no work while paused; prompt resume |
| H6 | Edit an option, inherit/override, reopen | Setting and pending work follow explicit choices; no allowance reset |
| H7 | Opt into idle backoff and repeatedly return `Standing by` | Delay is visible, durable and enforced without spending while waiting |
| H8 | Wait for a supported background producer, then finish | No model polling while waiting; exactly one wake; useful final work |
| H9 | Unknown/generic background-looking output | No unsolicited parking or lost tool results |
| H10 | Provider failure, cancellation, reload and stale completion | Recovery/control safeguards remain intact |

Use normal user commands and dialog choices for end-to-end journeys. Do not seed
goal records or force internal goal tools and call that human-style validation.
Boundary fixtures may do so, but must be reported separately. At least one actual
terminal walkthrough checks readable status and discoverable controls; real-model
work checks spontaneous behavior without a scripted tool sequence.

## Release decision

Keep the standard default immediate unless evidence contradicts the confirmed
workflow. If the candidate passes, revise the issue branch so backoff is opt-in,
with its settings, docs, compatibility and tests complete before merge. Separate
producer integrations and experimental stall policies from that fix. Preserve
README scope; put details in advanced usage, changelog and this spec.

The evaluation supports this direction: default backoff can delay useful reasoning
and custom-tool work, while repeated recognized-tool polling can bypass it. It is
an approximate opt-in cost control, not a general correctness guarantee. Both
policies completed the actual coding task; the controlled counterexamples decide
which policy satisfies the confirmed default requirements.

The first prototype exposed a release-blocking failure: disabling an already
pending delay left it in force. The corrected prototype now passes both the SDK
regression and a real keyboard opt-out during a running goal. Production must port
that fix and honor old saved `idle` metadata with no explicit opt-in. Preference
file/UI checks and runtime preference changes require separate evidence.

The recommended default still allows an executor that repeatedly chooses no action
to consume unbounded runs when the user has selected no limits. Be explicit about
that retained tradeoff. Do not claim that an opt-in feature eliminates the reported
#100 loop for every default user or close the issue on that basis.

## Implementation result — 2026-10-24

The approved default and opt-in behavior are implemented. The public request
projection resolves the Pi prompt/profile gate; direct creation, confirmation,
resume and reload have permanent SDK coverage. Supported-host checks include the
reported Pi 1.4 environment. The settings scope selector, live opt-out and compact
delay display were exercised through the actual terminal.

See [production implementation and validation](IMPLEMENTATION.md) for current
release evidence. Earlier prototype reports remain historical. The default-loop
tradeoff above remains explicit; producer integration and a bounded stall policy
remain separate decisions.
