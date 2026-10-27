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

## 2026-10-27 — E5.3 (keyed accounting + budget gating)

- `GoalAccounting.chargeKeyed(childRunId, tokens | "unknown", seconds)`: accepted once per key (a repeat returns zero); `"unknown"` settles the key with no token charge; accepted amounts fold into the next `charge()` (the turn-level flush), and `pendingKeyedTokens()` exposes them to the gate.
- Keys are decision-scoped (`<decisionId>/consultant-N`): `childRunId` restarts at `consultant-1` in every deliberation, so a bare childRunId key would drop the second deliberation's charge. Record `childRunId` values are unchanged.
- Seconds are not charged from the router: a consultant runs inside the agent turn, whose elapsed time `charge()` already counts (charging again would double-count `activeSeconds`).
- Budget gate (`reserveLaunch`, before the cap reservation): launch refused when `budgetRemaining` is 0 (pending keyed tokens counted); the route ends `ask-human` with the budget line. The gate is off when no budget is set.
- Runner honesty fix: an assistant `message_end` without `totalTokens` makes the run's usage `unknown` (previously a partial sum was reported as known).
- Not wired yet (E6): `ConsultationDeps.budget` needs the live goal view and the goal's `GoalAccounting`.
- Tests: accounting 4 (new), consultant 1 (new), router budget/keyed 6 (new).

## 2026-10-27 — E5 (gx-gqf, выполнен через agile_run/agile-loop, bd-epic federation)

- gx-gqf.1 acceptance guard `goal-decision-runtime.ts`: accept только при совпадении decisionId/childRunId (идемпотентно)/snapshotId/objectiveHash/generation, свежее чтение режима при приёмке, ignore-пути не пишут ничего; 21 тест. Коммит cb4ff68.
- gx-gqf.2 pause/cancel/restart/orphan: сигнал отмены гасит волны, неустранимые дети => orphaned (grace 5s — новое значение, ратифицировано владельцем), session_start инвалидирует открытые записи пула как restarted (fail-closed, пул целиком), поздние результаты в невалидированные записи не пишутся; 14 тестов. Ревьюер сверил abort/subscribe/dispose с реальным SDK. Коммит b519588.
- gx-gqf.3 keyed accounting: chargeKeyed на GoalAccounting (childRunId-идемпотентность), usage из session-subscribe, бюджет-гейт beforeLaunch через budgetRemaining, unknown usage честный. Коммит f871405.
- Известное: bd-экспорт в git не коммитится by design (stealth init) — final-bd-close отчитал closed=false с точной нотой; closes в bd durable.

## 2026-10-27 — E6.1 (goal_decision: visibility, router wiring, advisory prefill)

- `goal_decision` is registered lazily by `ensureDecisionTool` only when decisionMode is not `manual` and a goal is active (pi tools cannot be unregistered); `installGoalToolProfile(…, decisionEnabled)` advertises it through `applicableGoalTools` only while the goal is active. Manual registers nothing.
- `executeDecisionTool`: validate, then `resolveDecision` with the injected runner, signal and budget (live goal, `GoalAccounting`). bounded-auto: `direct` via `applyDirectResolution`, consulted routes via `acceptDecisionResolution` (fresh mode, snapshot, objective, generation). advisory: `runGoalQuestionnaire` with the recommended option prefilled; an answer is recorded `decided` (source human); a cancelled, unavailable or failed dialog escalates and keeps the no-answer meaning.
- Known gaps left for later: the lifecycle prompt (goal-core-tools.ts) is not updated yet (the tool description carries the routing guidance); `GoalRecord.activeDecisionId` is still not wired, so the per-result `acceptConsultantResult` guard is not on the tool path (the resolution-level guard is).
- Tests: `tests/goal-decision-tool.test.ts` 22 cases (visibility, lazy registration, every outcome, end-to-end through `session_start` and the registered tool); `tests/goal-decision-runtime.test.ts` +5 (`acceptDecisionResolution`); `tests/goal-tool-names.test.ts` registry updated. `npm test` 1377/1377.

## 2026-10-27 — E6.3 (project mode switch + decision journal/status)

- Journal: every terminal state of a DecisionRecord appends one `decision_recorded` ledger event (`goal-decision-journal.ts`: route, request hash, chosen, source, risks, revisit, consultant tokens or `unknown`, reason). Written from `goal_decision` calls and from the session_start restart invalidation (`restarted`). Best-effort append; the record stays the authority.
- Surface: decision events are activity events (feed line `Decision <id> <status>: …`); the dashboard shows one `Decision` line (last entry) in the compact dashboard and `/goal-status`, omitted when no decision exists (manual unchanged).
- Mode switch: the project `decisionMode` is written through `mutateSettingsLayer`; a global value stays ignored; a switch to manual during a critic run is rejected at acceptance and journaled as `invalidated: mode-manual`.
- Not changed: a direct bounded-auto decision has no deliberation window and is still recorded from the mode read at call start (`applyDirectResolution`), not from a fresh acceptance read.
- Tests: `tests/goal-decision-journal.test.ts` 15 cases; `tests/goal-decision-restart.test.ts` restart assertion extended. `npm test` 1392/1392, `npm run check` clean.

## 2026-10-27 — E6.2 (prompts, tool descriptions, oracle-path compatibility)

- Routing text appears only while goal_decision is advertised for the active goal (`GoalCore.decisionToolEnabled` and goal status active): one inserted lifecycle line `DECISION_FORK_RULE` in the injected policy (`goal-prompts.ts`) and the same sentence in the `get_goal` verbose lifecycle line (`goal-core-tools.ts`). `goal_decision` has promptGuidelines (pi shows them only for active tools) and a description that excludes blockers and objective changes.
- Manual: no registration and no routing text; the prompt and `get_goal` output are otherwise unchanged. Paused and blocked prompts carry no routing text; the blocker/oracle path is untouched.
- The TECH §7 decision fingerprint space landed as the pure `buildDecisionFingerprint` (`decision:<goalId>:<hash(question + options + objectiveHash)>`), namespace-distinct from the blocker fingerprint; no decision writes to the attempt-ledger yet — recording stays E6.3. `goal_question` keeps its static description in every mode, so the routing hint lives in the dynamic lifecycle prompt.
- Tests: `tests/goal-decision-tool.test.ts` +6 (28 cases); +1 test (goal-decision-record.test.ts). `npm test` 1384/1384.

## Pre-existing issues tracked

- gx-43n.5 (reparented to gx-773): 7 Windows-environment test failures (golden paths, shell harness, lock fault-injection, path asserts, recover bin) + manifest selfcheck red on HEAD Windows.
## 2026-10-27 — E6 (gx-443, agile_run)

- gx-443.1 `goal_decision` тул: регистрация только при mode != manual и активной цели (ensureDecisionTool + applicableGoalTools на session_start/before_agent_start); bounded-auto возвращает текст решения через acceptance-guard; advisory открывает runGoalQuestionnaire с prefill; ask-human/отменённый диалог — прежняя семантика blocker-ladder; 22+5 тестов + e2e. Коммит 17d4d85.
- gx-443.2 промпты/описания тулов, oracle-путь не тронут, ручной режим байт-в-байт. Коммит cebc576.
- gx-443.3 проектный переключатель decisionMode (проектный слой авторитетен), переключение в manual посреди обсуждения останавливает автономную приёмку (fresh-read в guard), журнал решений + status-строка. Коммит 708f8ab.
- Инцидент: первое ревью 443.1 умерло на schema-missing (structured_output не вызван) — движок восстановил через rework+повторное ревью; отчёт failed-ревьюера при этом содержал полный approved-вердикт.
