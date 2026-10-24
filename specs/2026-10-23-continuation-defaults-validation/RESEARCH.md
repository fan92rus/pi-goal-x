# Codex / Claude Code comparison and design consequences

Official documentation read on 2026-10-23. These are documented policies, not
results from running Codex or Claude Code. Product versions and providers differ;
the local experiments below exercise Pi and explicitly modeled guard policies.

## What the products actually document

| Concern | Codex | Claude Code | Consequence for Pi |
| --- | --- | --- | --- |
| Goal continuation | Active goal, idle thread, no queued user input or pending work; a tool-free continuation suppresses the next automatic continuation. [Goals cookbook](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) | A separate small model evaluates the completion condition after turns; repeated tool-free responses eventually yield control with the goal still set. [Goal documentation](https://code.claude.com/docs/en/goal) | Preserve safe settlement boundaries and user priority. Evaluate no-tool guards for false stops rather than treating tool use as proof of useful work. |
| Loop protection | The documented goal rule limits empty continuation. Goal completion requires evidence, and budget exhaustion differs from success. [Goals cookbook](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) | Stop hooks have a cap of eight consecutive continuations, reset by tool use; `stop_hook_active` also lets custom hooks avoid recursion. [Hooks reference](https://code.claude.com/docs/en/hooks#stop) | A finite no-tool cap bounds text-only loops, but any tool can reset it. This is a scheduling policy, not semantic progress detection. |
| Background work | Pending thread work prevents goal continuation. [Goals cookbook](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) | Known running subagent/shell work defers goal evaluation; completion delivers a new turn. Interactive idle check-ins are bounded. [Goal documentation](https://code.claude.com/docs/en/goal#background-work-defers-evaluation) | Prefer registered producer events. Do not spend model calls repeatedly asking whether a known dependency finished. Generic `{status, id}` is insufficient to identify one. |
| Cache structure | Stable instructions/tools first; changes can be appended instead of rewriting the prefix. [Prompt Caching 201](https://developers.openai.com/cookbook/examples/prompt_caching_201#42-stabilize-the-prefix) | Stable prompt/project context precedes appended conversation; exact-prefix matching makes early changes expensive. [Claude Code caching](https://code.claude.com/docs/en/prompt-caching#how-the-cache-is-organized) | Keep Pi's existing bounded checkpoints, retained request tails and stable tool profiles. Adding a boolean preference should add no default prompt bytes. |
| Context lifecycle | Compaction preserves state with fewer tokens; it is a distinct operation. [Compaction guide](https://developers.openai.com/api/docs/guides/compaction) | Compaction replaces history and rebuilds its conversation cache; automatic context management is part of the harness. [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works#the-context-window), [caching](https://code.claude.com/docs/en/prompt-caching#compacting-the-conversation) | Reuse host compaction. Do not compact on every idle reply or add a second competing summarizer to the scheduler. |

The ordinary agent loop and goal continuation are different boundaries. A normal
agent can take many tool steps inside one execution; a goal scheduler decides
whether another execution may begin after that execution settles. Counting tool
calls inside one response as autonomous runs would misread these comparisons.

Neither cited product promises that arbitrary tool activity proves progress. The
sources do not establish a universally best idle interval, prove that a cap is
appropriate for every model, or guarantee provider cache savings for Pi.

## Decisions and inferences for this codebase

**Keep useful work prompt.** The confirmed persona needs no scheduling protocol.
Our controlled fixture contains distinct reasoning responses before an artifact
and another does real work through an unfamiliar tool. An allowlist cannot give
these ordinary workflows reliable semantics. Keep implicit continuation as the
default; keep tool/progress detection out of its authorization path.

**Do not copy an evaluator into every turn.** Claude's evaluator is a coherent
architecture, but Pi already verifies requested completion with an independent
auditor that can examine evidence. Adding another model judgment at every
settlement would add requests, context and serial latency. No experiment shows
that its benefit warrants that overhead here. Preserve the existing independent
completion audit; audit only at the appropriate completion boundary. These two
checks offer different evidence and should not be described as equivalent.

**Keep known waits outside inference.** An explicit producer/token/wake contract
can avoid all model polling while waiting. This requires an actual integration
and durable state. The current strict wait route is optional and tested. Removing
its mandatory ready protocol and supporting specific producers should be a
separate feature, with events tested before it is advertised. No default inference
from tool names, prose or generic status objects belongs in this fix.

**Keep pacing optional, and describe its limits.** Backoff reduces request rate
for repeated text-only responses without forcing a hard stop. It cannot terminate
a loop, guarantee productive work or replace the existing run/token limits. A
user who needs a finite bound should choose a run allowance or token budget. One
advanced default-off option remains defensible for users who prefer slowing idle
retries to stopping; it is not a general progress detector or the complete fix for
all forms of #100. Do not add more tuning controls without evidence.

**Do not silently substitute a no-tool cap for the agreed default.** The local
policy models test one initial execution plus either one or eight additional
consecutive tool-free executions. They demonstrate the tradeoff; they do not
reproduce either competing runtime. A cap stops the repeated text fixture but
also interrupts the twelve-step distinct reasoning fixture. Calls to an unfamiliar
tool reset such a cap, as do useless recognized tools. If we later prefer this
policy, make that product change explicit and test recovery/status first.

**Retain the unresolved default-loop tradeoff in release scope.** Immediate
unrestricted continuation cannot simultaneously guarantee finite cost for an
executor that never decides to act or finish. The user's confirmed default favors
continuity, with optional cost controls. Keep that choice visible in the decision
record; do not label the default universally optimal or close #100 by claiming
that opt-in pacing prevents every user's loop. A stronger default loop guard
would need a new, explicit product decision, not an undocumented optimization.

## Review checklist derived from the comparison

- Goal start, settlement, user input, pause and resume remain understandable.
- Waiting shows a reason and a recovery action; running status never implies
  active model work during a parked dependency wait.
- Put advanced cost controls in settings, show global/project provenance, and
  apply opting out promptly. No extra creation dialog or required declaration.
- Prefer local relative delay text such as "Next attempt in 30s"; detailed status
  may also show local time. Avoid a raw UTC timestamp as the only recovery clue.
- State the difference between a hard allowance, pacing and dependency waiting in
  advanced help. Leave README's existing scope intact.
- Measure full requests and artifacts. Report input, output and cached tokens
  separately. Cached input remains input and a successful cache does not establish
  that an extra model call was necessary.

The local comparison also found a host issue that documentation alone would not
have exposed: Pi 1.0's custom trigger can start with stale or missing prompt
guidance. A [minimal two-tool reproduction](../../experiments/continuation/profile-boundary.mjs)
loads no goal extension and records both cases in [structured evidence](evidence/profile-boundary-results.json).
Apply the same evidence standard to the proposed design: keep this as an explicit
compatibility gate, rather than assuming a cache technique from another harness
automatically works here.

See [PERFORMANCE.md](PERFORMANCE.md) for actual measurements, limitations and release
budgets, and [TECH.md](TECH.md#8-context-speed-and-comparison-protocol) for reproduction.
