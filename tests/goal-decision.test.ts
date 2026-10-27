import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_GOAL_DECISION_LIMITS, type GoalDecisionMode, type GoalDecisionSettings } from "../extensions/goal-decision-policy.ts";
import {
	applyAskHuman,
	applyDirectResolution,
	decideRoute,
	forbiddenCategoriesIn,
	resolveConsultationRoute,
	resolveDecision,
	routeFloor,
	validateProposal,
	type DecisionProposal,
	type DecisionStoreContext,
} from "../extensions/goal-decision.ts";
import { DECISIONS_DIR, getDecisions, type DecisionRecord } from "../extensions/goal-decision-record.ts";

const OBJECTIVE = "Migrate the local cache to WAL mode end to end";
const GOAL = "goal-a";

function policy(mode: GoalDecisionMode = "bounded-auto"): GoalDecisionSettings {
	return { mode, limits: { ...DEFAULT_GOAL_DECISION_LIMITS } };
}

function proposal(overrides: Partial<DecisionProposal> = {}): DecisionProposal {
	return {
		question: "Use WAL mode for the local cache?",
		options: ["WAL", "rollback journal"],
		selfRoute: "direct",
		authorityBasis: "The request asks for the cache migration end to end.",
		facts: ["cache is a local sqlite file"],
		unknowns: [],
		materialRisk: false,
		...overrides,
	};
}

function storeCtx(t: test.TestContext): DecisionStoreContext & { cwd: string } {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-decision-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return { cwd, storage: { cwd }, goalId: GOAL, objective: OBJECTIVE, policyVersion: "policy-1", generation: "gen-1" };
}

function storedRecords(ctx: DecisionStoreContext): DecisionRecord[] {
	const result = getDecisions(ctx.storage, ctx.goalId);
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

function sidecarExists(ctx: { cwd: string }): boolean {
	return existsSync(path.join(ctx.cwd, DECISIONS_DIR, `${GOAL}.json`));
}

// ── validation ──────────────────────────────────────────────────────────────

test("a valid direct proposal passes validation and routes to direct", () => {
	const result = validateProposal(proposal());
	assert.equal(result.ok, true);
	const decided = decideRoute(proposal());
	assert.deepEqual(decided, { ok: true, route: "direct", routeJustification: { skipped: [], reasons: {} } });
});

test("validation rejects structural violations with a reason", () => {
	const cases: Array<[string, unknown]> = [
		["empty question", proposal({ question: "" })],
		["whitespace-only question", proposal({ question: "   " })],
		["one option", proposal({ options: ["WAL"] })],
		["blank option", proposal({ options: ["WAL", "  "] })],
		["empty authorityBasis", proposal({ authorityBasis: "" })],
		["blank authorityBasis", proposal({ authorityBasis: "\t " })],
		["unknown selfRoute", { ...proposal(), selfRoute: "guess" }],
		["missing facts", (({ facts: _facts, ...rest }) => rest)(proposal())],
		["non-array unknowns", { ...proposal(), unknowns: "write volume" }],
		["unknown skip route", { ...proposal(), skipJustifications: { bogus: "because" } }],
		["blank skip justification", proposal({ selfRoute: "research", skipJustifications: { critique: " " } })],
		["question over 300 chars", proposal({ question: "x".repeat(301) })],
		["non-object input", "use WAL"],
		["null input", null],
	];
	for (const [name, input] of cases) {
		const result = validateProposal(input);
		assert.equal(result.ok, false, name);
		if (!result.ok) assert.notEqual(result.reason, "", name);
	}
});

test("validation accepts a question of exactly 300 characters", () => {
	assert.equal(validateProposal(proposal({ question: "x".repeat(300) })).ok, true);
});

// ── route floors ────────────────────────────────────────────────────────────

test("unknowns raise the floor to research: direct without justification escalates with route floor", () => {
	const input = proposal({ unknowns: ["write volume"] });
	assert.equal(routeFloor(proposal({ unknowns: ["write volume"] })).route, "research");
	const decided = decideRoute(input);
	assert.equal(decided.ok, false);
	if (!decided.ok) {
		assert.equal(decided.floor, "research");
		assert.match(decided.detail, /skipping research needs a non-empty skipJustifications\.research/);
	}
});

test("materialRisk true raises the floor to critique", () => {
	assert.equal(routeFloor(proposal({ materialRisk: true })).route, "critique");
	const decided = decideRoute(proposal({ materialRisk: true, selfRoute: "research", unknowns: [] }));
	assert.equal(decided.ok, false);
	if (!decided.ok) assert.equal(decided.floor, "critique");
});

test("unknowns and materialRisk together raise the floor to research+critique", () => {
	assert.equal(routeFloor(proposal({ unknowns: ["u"], materialRisk: true })).route, "research+critique");
	const decided = decideRoute(proposal({ unknowns: ["u"], materialRisk: true, selfRoute: "critique" }));
	assert.equal(decided.ok, false, "critique alone does not cover the research floor");
});

test("materialRisk absent is conservative: material (critique floor); explicit false is not", () => {
	assert.equal(routeFloor(proposal({ materialRisk: undefined })).needCritique, true);
	assert.equal(routeFloor(proposal({ materialRisk: undefined })).route, "critique");
	assert.equal(routeFloor(proposal({ materialRisk: false })).needCritique, false);
	assert.equal(decideRoute(proposal({ materialRisk: false })).ok, true);
	assert.equal(decideRoute(proposal({ materialRisk: undefined, selfRoute: "direct" })).ok, false);
});

test("a skip justification keeps a route below the floor and is recorded in routeJustification", t => {
	const input = proposal({
		selfRoute: "direct",
		unknowns: ["write volume"],
		skipJustifications: { research: "write volume is irrelevant to choosing the journal mode" },
	});
	const decided = decideRoute(input);
	assert.deepEqual(decided, {
		ok: true,
		route: "direct",
		routeJustification: {
			skipped: ["research"],
			reasons: { research: "write volume is irrelevant to choosing the journal mode" },
		},
	});
	const resolved = resolveDecision(input, policy(), storeCtx(t));
	assert.equal(resolved.kind, "direct");
	if (resolved.kind === "direct") assert.deepEqual(resolved.routeJustification.skipped, ["research"]);
});

test("a critique route skipping research records research as skipped", () => {
	const decided = decideRoute(proposal({
		selfRoute: "critique",
		materialRisk: true,
		unknowns: ["u"],
		skipJustifications: { research: "the unknown is answered by the repo fact list" },
	}));
	assert.equal(decided.ok, true);
	if (decided.ok) {
		assert.equal(decided.route, "critique");
		assert.deepEqual(decided.routeJustification.skipped, ["research"]);
	}
});

test("over-routing (research when nothing requires it) is accepted without justification", () => {
	assert.deepEqual(decideRoute(proposal({ selfRoute: "research" })), {
		ok: true,
		route: "research",
		routeJustification: { skipped: [], reasons: {} },
	});
});

// ── forbidden categories ────────────────────────────────────────────────────

test("forbidden words in the question force ask-human even when selfRoute is direct", () => {
	const input = proposal({ question: "Should the migration delete production rows first?", options: ["yes", "no"] });
	const decided = decideRoute(input);
	assert.equal(decided.ok, false);
	if (!decided.ok) {
		assert.equal(decided.floor, "ask-human");
		assert.match(decided.detail, /forbidden category: data-deletion, production/);
	}
});

test("forbidden words in the options force ask-human: spend money and api key", () => {
	assert.equal(decideRoute(proposal({ options: ["spend money on a paid tier", "keep free"] })).ok, false);
	assert.equal(decideRoute(proposal({ options: ["store the api key in the repo", "env var"] })).ok, false);
});

test("forbidden categories cannot be waived by skip justifications", () => {
	const decided = decideRoute(proposal({
		question: "Rotate the api key now?",
		selfRoute: "critique",
		materialRisk: true,
		skipJustifications: { research: "x", critique: "y" },
	}));
	assert.equal(decided.ok, false);
	if (!decided.ok) assert.equal(decided.floor, "ask-human");
});

test("forbiddenCategoriesIn matches the best-effort keyword families", () => {
	assert.deepEqual(forbiddenCategoriesIn(["spend money"]), ["money"]);
	assert.deepEqual(forbiddenCategoriesIn(["DROP TABLE users"]), ["data-deletion"]);
	assert.deepEqual(forbiddenCategoriesIn(["ship to Production"]), ["production"]);
	assert.deepEqual(forbiddenCategoriesIn(["rotate the API_KEY"]), ["secrets"]);
	assert.deepEqual(forbiddenCategoriesIn(["use WAL", "rollback journal"]), []);
});

test("resolveDecision escalates forbidden proposals to ask-human and writes an escalated record", t => {
	const ctx = storeCtx(t);
	const resolved = resolveDecision(proposal({ question: "Delete production data before migrating?" }), policy(), ctx);
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind !== "ask-human") return;
	assert.equal(resolved.reason, "route floor: forbidden category: data-deletion, production");
	const [record] = storedRecords(ctx);
	assert.equal(record?.status, "escalated");
	assert.equal(record?.route, "ask-human");
	assert.equal(record?.id, resolved.decisionId);
});

// ── resolveDecision ─────────────────────────────────────────────────────────

test("resolveDecision returns direct for a valid direct proposal without writing the store", t => {
	const ctx = storeCtx(t);
	const resolved = resolveDecision(proposal(), policy(), ctx);
	assert.deepEqual(resolved, { kind: "direct", routeJustification: { skipped: [], reasons: {} } });
	assert.equal(sidecarExists(ctx), false);
});

test("research and critique routes return consultations-pending and write nothing (E4 stub)", t => {
	const ctx = storeCtx(t);
	const research = resolveDecision(proposal({ selfRoute: "research", unknowns: ["u"] }), policy(), ctx);
	assert.equal(research.kind, "consultations-pending");
	if (research.kind === "consultations-pending") assert.equal(research.route, "research");

	const critique = resolveDecision(proposal({ selfRoute: "critique", materialRisk: true }), policy(), ctx);
	assert.equal(critique.kind, "consultations-pending");
	if (critique.kind === "consultations-pending") assert.equal(critique.route, "critique");

	const both = resolveDecision(proposal({ selfRoute: "research+critique", unknowns: ["u"], materialRisk: true }), policy(), ctx);
	assert.equal(both.kind, "consultations-pending");
	if (both.kind === "consultations-pending") assert.equal(both.route, "research+critique");

	assert.deepEqual(resolveConsultationRoute("critique"), { kind: "consultations-pending", route: "critique" });
	assert.equal(sidecarExists(ctx), false);
});

test("missing skip justification escalates with reason route floor and writes an escalated record", t => {
	const ctx = storeCtx(t);
	const resolved = resolveDecision(proposal({ materialRisk: true }), policy(), ctx);
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind !== "ask-human") return;
	assert.match(resolved.reason, /^route floor: skipping critique needs a non-empty skipJustifications\.critique/);
	const [record] = storedRecords(ctx);
	assert.equal(record?.status, "escalated");
	assert.equal(record?.route, "critique", "escalated route is the higher of selfRoute and floor");
	assert.deepEqual(record?.routeJustification.reasons, { "ask-human": resolved.reason });
});

test("selfRoute ask-human escalates and records the route as ask-human", t => {
	const ctx = storeCtx(t);
	const resolved = resolveDecision(proposal({ selfRoute: "ask-human" }), policy(), ctx);
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind !== "ask-human") return;
	assert.equal(resolved.reason, "selfRoute ask-human");
	assert.equal(storedRecords(ctx)[0]?.route, "ask-human");
});

test("resolveDecision refuses in manual mode and writes nothing", t => {
	const ctx = storeCtx(t);
	const resolved = resolveDecision(proposal({ question: "Delete production rows?" }), policy("manual"), ctx);
	assert.equal(resolved.kind, "refused");
	assert.equal(sidecarExists(ctx), false);
});

test("resolveDecision reports invalid proposals and writes nothing", t => {
	const ctx = storeCtx(t);
	const resolved = resolveDecision(proposal({ options: ["only one"] }), policy(), ctx);
	assert.equal(resolved.kind, "invalid");
	assert.equal(sidecarExists(ctx), false);
});

// ── direct resolution ───────────────────────────────────────────────────────

test("applyDirectResolution writes a decided record with source agent and returns text with the chosen option", t => {
	const ctx = storeCtx(t);
	const result = applyDirectResolution(ctx, proposal({ risks: ["WAL needs shared-memory files"], revisitWhen: "the cache moves off local disk" }), "WAL", policy());
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.match(result.value.text, /Chosen: WAL\b/);
	assert.match(result.value.text, /source: agent/);
	assert.match(result.value.text, /Risks: WAL needs shared-memory files/);
	assert.match(result.value.text, /Revisit when: the cache moves off local disk/);

	const [record] = storedRecords(ctx);
	assert.equal(record?.id, result.value.decisionId);
	assert.equal(record?.status, "decided");
	assert.equal(record?.route, "direct");
	assert.equal(record?.revision, 1);
	assert.deepEqual(record?.outcome, {
		chosen: "WAL",
		source: "agent",
		risks: ["WAL needs shared-memory files"],
		revisitWhen: "the cache moves off local disk",
	});
	assert.equal(record?.requestAnchor.objectiveExcerpt, OBJECTIVE);
});

test("applyDirectResolution refuses anything but bounded-auto and writes nothing", t => {
	for (const mode of ["manual", "advisory"] as const) {
		const ctx = storeCtx(t);
		const result = applyDirectResolution(ctx, proposal(), "WAL", policy(mode));
		assert.equal(result.ok, false, mode);
		assert.equal(sidecarExists(ctx), false, mode);
	}
});

test("applyDirectResolution refuses a chosen value that is not one of the options", t => {
	const ctx = storeCtx(t);
	const result = applyDirectResolution(ctx, proposal(), "invented option", policy());
	assert.equal(result.ok, false);
	assert.equal(sidecarExists(ctx), false);
});

test("applyDirectResolution refuses a proposal that does not resolve to direct", t => {
	const ctx = storeCtx(t);
	const floorBlocked = applyDirectResolution(ctx, proposal({ unknowns: ["u"] }), "WAL", policy());
	assert.equal(floorBlocked.ok, false);
	const research = applyDirectResolution(ctx, proposal({ selfRoute: "research", unknowns: ["u"] }), "WAL", policy());
	assert.equal(research.ok, false);
	if (!research.ok) assert.match(research.reason, /route is research, not direct/);
	assert.equal(sidecarExists(ctx), false);
});

test("applyDirectResolution never picks an option itself and records only the agent's choice", t => {
	const ctx = storeCtx(t);
	const result = applyDirectResolution(ctx, proposal(), "rollback journal", policy());
	assert.equal(result.ok, true);
	if (result.ok) assert.match(result.value.text, /Chosen: rollback journal/);
	assert.equal(storedRecords(ctx)[0]?.outcome?.chosen, "rollback journal");
});

// ── escalation ──────────────────────────────────────────────────────────────

test("applyAskHuman writes an escalated record and returns text with the reason", t => {
	const ctx = storeCtx(t);
	const result = applyAskHuman(ctx, proposal({ options: ["keep SQLite", "switch to Postgres"] }), "beyond original request");
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.match(result.value.text, /escalated \(beyond original request\)/);
	assert.match(result.value.text, /goal_question/);
	assert.match(result.value.text, /Options: 1\) keep SQLite; 2\) switch to Postgres/);

	const [record] = storedRecords(ctx);
	assert.equal(record?.status, "escalated");
	assert.equal(record?.revision, 1);
	assert.equal(record?.outcome, undefined);
	assert.deepEqual(record?.routeJustification.reasons, { "ask-human": "beyond original request" });
});

test("applyAskHuman with an invalid proposal returns a failure and writes nothing", t => {
	const ctx = storeCtx(t);
	const result = applyAskHuman(ctx, proposal({ authorityBasis: " " }), "anything");
	assert.equal(result.ok, false);
	assert.equal(sidecarExists(ctx), false);
});

// ── no store writes on invalid input ────────────────────────────────────────

test("invalid proposals never touch the store across every write entry point", t => {
	const ctx = storeCtx(t);
	const bad = proposal({ question: "" });
	assert.equal(applyAskHuman(ctx, bad, "x").ok, false);
	assert.equal(applyDirectResolution(ctx, bad, "WAL", policy()).ok, false);
	assert.equal(resolveDecision(bad, policy(), ctx).kind, "invalid");
	assert.equal(sidecarExists(ctx), false);
	assert.deepEqual(storedRecords(ctx), []);
});

test("forbidden category named in unknowns raises the floor to ask-human (D3)", () => {
	const floor = routeFloor(proposal({ unknowns: ["whether the payment provider prod api key is in scope"], materialRisk: false }));
	assert.equal(floor.route, "ask-human");
	assert.equal(decideRoute(proposal({ unknowns: ["prod api key handling"], selfRoute: "direct", materialRisk: false })).ok, false);
});

test("array caps: options<=8, facts/unknowns/risks<=16 (D4)", () => {
	assert.equal(validateProposal(proposal({ options: Array.from({ length: 9 }, (_, i) => `o${i}`) })).ok, false);
	assert.equal(validateProposal(proposal({ facts: Array.from({ length: 17 }, (_, i) => `f${i}`) })).ok, false);
	assert.equal(validateProposal(proposal({ unknowns: Array.from({ length: 17 }, (_, i) => `u${i}`) })).ok, false);
	assert.equal(validateProposal(proposal({ risks: Array.from({ length: 17 }, (_, i) => `r${i}`) })).ok, false);
	assert.equal(validateProposal(proposal({ options: ["a", "b"], facts: Array.from({ length: 16 }, (_, i) => `f${i}`) })).ok, true);
});
