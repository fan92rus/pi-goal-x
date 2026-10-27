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

## Pre-existing issues tracked

- gx-43n.5 (reparented to gx-773): 7 Windows-environment test failures (golden paths, shell harness, lock fault-injection, path asserts, recover bin) + manifest selfcheck red on HEAD Windows.
