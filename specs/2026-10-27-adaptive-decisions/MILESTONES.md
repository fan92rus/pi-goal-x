# Milestones — adaptive decisions (E1–E7)

## 2026-10-27 — E1 closed (gx-cbc)

- PRODUCT.md drafted, cross-model review r1 (glm-5.3-flash): blocked → F1 (option-comparison criteria) + F2 (sandbox/tool-permissions boundary) majors fixed with F3–F9; live grep verification. Owner approved.
- TECH.md drafted, review r1: 1 blocker (cross-session mode pickup — in-process settings cache) + 3 majors (budget gating, cross-route consultation cap, context minimization) fixed; fix-verification r1.1 ok; stale §7 clause removed. Owner approved.
- Key supervisor decisions: file keys flat `decisionMode`/`decisionCritic`/`decisionLimits` (literal to PRODUCT; resolved shape stays module API); snapshotId = sha256(raw project file)[0:16], missing file = sha256("")[0:16]; store permissive on field lengths, caps enforced by router at write boundary (E3/E4); literal oldest-eviction cap 50.
- MATRIX.md: 22 scenarios with expected outcomes.

## 2026-10-27 — E2 (gx-43n)

- gx-43n.1 `goal-decision-policy.ts` (worker haiku-5-5, review glm-5.3-flash ok): layered resolve (mode authoritative at project layer only), invalid→manual fail-safe, `readModeFreshFromDisk` + snapshotId; 32 unit tests.
- gx-43n.2 `goal-decision-record.ts` (worker haiku-5-5, review glm-5.3-flash ok): TypeBox schema, sidecar cap 50, atomic write + revision conflict, single-writer transition matrix, objectiveAnchor sha256; 11 unit tests; reviewer's inter-process race probe: 2×60 updates, 0 lost.
- gx-43n.4 (orchestrator): whitelist decision keys in `parseSettingsLayer` + opaque carry in `GoalSettingsResolvedShape` + `buildPersistedLayer`. r1 fix-verification caught B1 regression (silent key wipe on mutation) → B1 fixed per prescription; r2 verdict ok (7/7 probes).
- gx-43n.3 (orchestrator): runner Windows fixes — `--import` needs file:// URL, absolute `D:\` test paths rejected by ESM loader (HEAD could not run the suite at all); relative test paths + manifest separator normalization; manifest refreshed.
- Full suite on Windows: 1219 tests, 1206 pass, 13 fail — all pre-existing Windows-environment cases, listed in gx-43n.5; decision modules 43/43 green.
- Supervisor decisions log: D1 store-permissive (router owns caps), D2 literal eviction, model policy haiku workers / glm-flash reviewers (owner-approved).

## 2026-10-27 — E3 (gx-97b)

- `goal-decision.ts` (worker haiku-5-5, review glm-5.3-flash ok after owner decisions D1–D7): DecisionProposal schema (caps options≤8, facts/unknowns/risks≤16), validateProposal, routeFloor (unknowns⇒research, material⇒critique with conservative absent=true default, forbidden categories⇒ask-human scanning question/options/facts/unknowns, fail-closed v1), resolveDecision direct/ask-human outcomes via DecisionRecord, consultations stub for E4, no tool registration (E6 wires `goal_decision`).
- Post-review owner fixes applied and re-verified: D2 conservative materialRisk default (was bypassable by omitting the field), D3 scan scope, D4 caps — reviewer probed final code, 31/31 tests.
- Runner follow-up: manifest entries normalized to `./tests/...` (trailing-separator rel bug — selfcheck matched both broken sides, caught during E3 merge).
- Suite: 1250 tests, 1237 pass, same 13 pre-existing Windows-env failures (gx-43n.5).

## 2026-10-27 — E4 (gx-ufd)

- gx-ufd.1 `goal-decision-consultant.ts` (worker haiku-5-5, review glm-5.3-flash ok): runConsultant — fresh in-memory session, tools read/grep/find/ls + один submit (нет write/edit/bash/делегации), createSession-шов, дедлайн-таймер + AbortSignal, типизированные payload researcher/critic, invalid_output/config/aborted/budget-коды, beforeLaunch-хук (точка бюджет-гейта E5), usage из session-событий (никогда не выдумывается); 16 unit-тестов на инъекции; selfcheck-orphan решается оркестратором на мерже (практика с E2).

## 2026-10-27 — E5.2 (pause/cancel/restart/orphan)

- Cancellation: the router passes its AbortSignal to every consultant; a fired signal stops further waves and the critic, invalidates the open record (`cancelled`, acceptance-guard writer) and returns `cancelled`. Consultant entries already appended stay in the record.
- Orphans: a cancelled child whose `abort()` has not settled within `CANCEL_GRACE_MS` (5 000 ms, new numeric value, not in TECH §9 — owner to confirm) is reported `orphaned`, is never awaited beyond the grace period and is not disposed; its record entry carries `orphaned: true`. A late submit after cancellation is refused by the submit tool.
- Restart: `session_start` invalidates every open record of the active goal pool (`restarted`); nothing is relaunched. Consulted-but-unaccepted records are open too and are invalidated the same way (fail closed).
- Late results: acceptance already rejected a non-active goal; invalidated records answer `not-open`, so a late delivery cannot resume a stopped goal.
- Tests: consultant 3, router 5, runtime 5, restart through the real `session_start` hook 1 (14 cases). `npm test` 1339/1339.
- Not wired yet (E6): the `goal_decision` tool must pass its execute signal into `ConsultationDeps.signal`.

## Pre-existing issues tracked

- gx-43n.5 (reparented to gx-773): 7 Windows-environment test failures (golden paths, shell harness, lock fault-injection, path asserts, recover bin) + manifest selfcheck red on HEAD Windows.
