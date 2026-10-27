import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConsultantModel, ConsultantRole, ConsultantRunResult, CriticPayload, ResearcherPayload, RunConsultantArgs } from "../extensions/goal-decision-consultant.ts";
import { GoalAccounting } from "../extensions/goal-accounting.ts";
import { DEFAULT_GOAL_DECISION_LIMITS, type GoalDecisionCriticSettings, type GoalDecisionMode, type GoalDecisionSettings } from "../extensions/goal-decision-policy.ts";
import {
	applyAskHuman,
	applyDirectResolution,
	decideRoute,
	forbiddenCategoriesIn,
	resolveCriticModel,
	resolveDecision,
	routeFloor,
	validateProposal,
	type ConsultantRunner,
	type ConsultationDeps,
	type DecisionProposal,
	type DecisionStoreContext,
} from "../extensions/goal-decision.ts";
import { DECISIONS_DIR, getConsultationsLaunched, getDecisions, incrementConsultations, type DecisionRecord } from "../extensions/goal-decision-record.ts";

const OBJECTIVE = "Migrate the local cache to WAL mode end to end";
const GOAL = "goal-a";

const AUTHOR_MODEL = { provider: "fixture", id: "author-model" } as unknown as ConsultantModel;
const CRITIC_MODEL = { provider: "fixture", id: "critic-model" } as unknown as ConsultantModel;
const MODELS: Record<string, unknown> = {
	"fixture/author-model": AUTHOR_MODEL,
	"fixture/critic-model": CRITIC_MODEL,
};

const RESEARCH_OK: ResearcherPayload = {
	findings: [{ claim: "The cache uses the rollback journal", evidence: "src/cache.ts sets journal_mode=DELETE", source: "src/cache.ts" }],
	remainingUnknowns: [],
	verdict: "answered",
};

const CRITIC_OK: CriticPayload = {
	objections: [{ severity: "minor", evidence: "WAL needs -shm files on network drives" }],
	verdict: "sound",
};

function policy(mode: GoalDecisionMode = "bounded-auto"): GoalDecisionSettings {
	return { mode, limits: { ...DEFAULT_GOAL_DECISION_LIMITS } };
}

function criticPolicy(
	limits: Partial<GoalDecisionSettings["limits"]> = {},
	critic: GoalDecisionCriticSettings = { provider: "fixture", model: "critic-model", thinkingLevel: "high" },
): GoalDecisionSettings {
	return { mode: "bounded-auto", critic, limits: { ...DEFAULT_GOAL_DECISION_LIMITS, ...limits } };
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

// ── consultant fakes (injected runner; no sessions, no network) ─────────────

type AnyRunResult = ConsultantRunResult<ConsultantRole>;
type Responder = (args: RunConsultantArgs<ConsultantRole>, index: number) => AnyRunResult;

interface RunnerCall {
	role: ConsultantRole;
	prompt: string;
	model: unknown;
	deadlineMs: number;
	thinkingLevel: unknown;
}

interface FakeRunner {
	runner: ConsultantRunner;
	calls: RunnerCall[];
	/** Start and end markers in the order they happened. */
	events: string[];
	/** Largest number of launches running at the same time. */
	maxLive: number;
}

/**
 * Fake runner: records every launch, delays each one, and answers through `respond`.
 * Mirrors runConsultant's order: `preGate` (config refusals) first, then
 * beforeLaunch; a refused gate launches nothing and is not recorded in `calls`.
 */
function fakeRunner(respond: Responder, delayMs = 5, preGate?: (args: RunConsultantArgs<ConsultantRole>) => AnyRunResult | undefined): FakeRunner {
	const fake: FakeRunner = { runner: undefined as never, calls: [], events: [], maxLive: 0 };
	let live = 0;
	fake.runner = (async (args: RunConsultantArgs<ConsultantRole>) => {
		const early = preGate?.(args);
		if (early) return early;
		if (args.beforeLaunch) {
			const gate = args.beforeLaunch();
			if (!gate.ok) return { ok: false, errorCode: "budget", message: gate.reason };
		}
		fake.calls.push({ role: args.role, prompt: args.prompt, model: args.model, deadlineMs: args.deadlineMs, thinkingLevel: args.thinkingLevel });
		const index = fake.calls.length;
		live += 1;
		fake.maxLive = Math.max(fake.maxLive, live);
		fake.events.push(`start ${args.role} ${index}`);
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		const result = respond(args, index);
		live -= 1;
		fake.events.push(`end ${args.role} ${index}`);
		return result;
	}) as unknown as ConsultantRunner;
	return fake;
}

function fakeCtx(model: unknown, cwd: string): ExtensionContext {
	return {
		cwd,
		model,
		modelRegistry: { find: (provider: string, id: string) => MODELS[`${provider}/${id}`] },
	} as unknown as ExtensionContext;
}

function depsFor(fake: FakeRunner, cwd: string, model: unknown = AUTHOR_MODEL): ConsultationDeps {
	return { ctx: fakeCtx(model, cwd), runConsultant: fake.runner };
}

/** Deps for paths that must not launch: any launch rejects the promise, which fails the test. */
function noLaunchDeps(): ConsultationDeps {
	return depsFor(fakeRunner(() => { throw new Error("no consultant may launch on this path"); }), "unused");
}

const researcherAnswers = (): AnyRunResult => ({ ok: true, payload: RESEARCH_OK, usage: { tokens: 42 } });

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

test("a skip justification keeps a route below the floor and is recorded in routeJustification", async t => {
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
	const resolved = await resolveDecision(input, policy(), storeCtx(t), noLaunchDeps());
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

test("resolveDecision escalates forbidden proposals to ask-human and writes an escalated record", async t => {
	const ctx = storeCtx(t);
	const resolved = await resolveDecision(proposal({ question: "Delete production data before migrating?" }), policy(), ctx, noLaunchDeps());
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind !== "ask-human") return;
	assert.equal(resolved.reason, "route floor: forbidden category: data-deletion, production");
	const [record] = storedRecords(ctx);
	assert.equal(record?.status, "escalated");
	assert.equal(record?.route, "ask-human");
	assert.equal(record?.id, resolved.decisionId);
});

// ── resolveDecision ─────────────────────────────────────────────────────────

test("resolveDecision returns direct for a valid direct proposal without writing the store", async t => {
	const ctx = storeCtx(t);
	const resolved = await resolveDecision(proposal(), policy(), ctx, noLaunchDeps());
	assert.deepEqual(resolved, { kind: "direct", routeJustification: { skipped: [], reasons: {} } });
	assert.equal(sidecarExists(ctx), false);
});

test("research, critique, and research+critique routes run consultants and write one record each", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner((args) => (args.role === "researcher" ? researcherAnswers() : { ok: true, payload: CRITIC_OK }));
	const deps = depsFor(fake, ctx.cwd);

	const research = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["u"] }), criticPolicy(), ctx, deps);
	assert.equal(research.kind, "consulted");
	if (research.kind === "consulted") assert.equal(research.route, "research");

	const critique = await resolveDecision(proposal({ selfRoute: "critique", materialRisk: true }), criticPolicy(), ctx, deps);
	assert.equal(critique.kind, "consulted");
	if (critique.kind === "consulted") assert.equal(critique.route, "critique");

	const both = await resolveDecision(proposal({ selfRoute: "research+critique", unknowns: ["u"], materialRisk: true }), criticPolicy(), ctx, deps);
	assert.equal(both.kind, "consulted");
	if (both.kind === "consulted") assert.equal(both.route, "research+critique");

	assert.deepEqual(fake.calls.map((call) => call.role), ["researcher", "critic", "researcher", "critic"]);
	const records = storedRecords(ctx);
	assert.deepEqual(records.map((record) => record.status), ["open", "open", "open"]);
	assert.deepEqual(records.map((record) => record.consultants.length), [1, 1, 2]);
});

test("manual mode never launches a consultant", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(researcherAnswers);
	const resolved = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["u"] }), policy("manual"), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "refused");
	assert.equal(fake.calls.length, 0);
	assert.equal(sidecarExists(ctx), false);
});

test("missing skip justification escalates with reason route floor and writes an escalated record", async t => {
	const ctx = storeCtx(t);
	const resolved = await resolveDecision(proposal({ materialRisk: true }), policy(), ctx, noLaunchDeps());
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind !== "ask-human") return;
	assert.match(resolved.reason, /^route floor: skipping critique needs a non-empty skipJustifications\.critique/);
	const [record] = storedRecords(ctx);
	assert.equal(record?.status, "escalated");
	assert.equal(record?.route, "critique", "escalated route is the higher of selfRoute and floor");
	assert.deepEqual(record?.routeJustification.reasons, { "ask-human": resolved.reason });
});

test("selfRoute ask-human escalates and records the route as ask-human", async t => {
	const ctx = storeCtx(t);
	const resolved = await resolveDecision(proposal({ selfRoute: "ask-human" }), policy(), ctx, noLaunchDeps());
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind !== "ask-human") return;
	assert.equal(resolved.reason, "selfRoute ask-human");
	assert.equal(storedRecords(ctx)[0]?.route, "ask-human");
});

test("resolveDecision refuses in manual mode and writes nothing", async t => {
	const ctx = storeCtx(t);
	const resolved = await resolveDecision(proposal({ question: "Delete production rows?" }), policy("manual"), ctx, noLaunchDeps());
	assert.equal(resolved.kind, "refused");
	assert.equal(sidecarExists(ctx), false);
});

test("resolveDecision reports invalid proposals and writes nothing", async t => {
	const ctx = storeCtx(t);
	const resolved = await resolveDecision(proposal({ options: ["only one"] }), policy(), ctx, noLaunchDeps());
	assert.equal(resolved.kind, "invalid");
	assert.equal(sidecarExists(ctx), false);
});

// ── consultations: outcomes ─────────────────────────────────────────────────

test("research happy path: one researcher answered gives a consulted outcome with findings in facts, record open", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(researcherAnswers);
	const resolved = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["write volume"] }), policy(), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "consulted");
	if (resolved.kind !== "consulted") return;
	assert.equal(resolved.route, "research");
	assert.deepEqual(resolved.facts, ["cache is a local sqlite file", "The cache uses the rollback journal (source: src/cache.ts)"]);
	assert.deepEqual(resolved.risks, []);
	assert.match(resolved.text, /Choose one option/);

	assert.equal(fake.calls.length, 1);
	assert.equal(fake.calls[0]?.role, "researcher");
	assert.equal(fake.calls[0]?.model, AUTHOR_MODEL, "researchers run on the proposing model");
	assert.equal(fake.calls[0]?.deadlineMs, 120_000);

	const [record] = storedRecords(ctx);
	assert.equal(record?.id, resolved.decisionId);
	assert.equal(record?.status, "open", "only the acceptance guard decides a record");
	assert.deepEqual(record?.facts, resolved.facts);
	assert.equal(record?.revision, 1);
	assert.equal(record?.consultants.length, 1);
	const entry = record?.consultants[0];
	assert.equal(entry?.role, "researcher");
	assert.equal(entry?.childRunId, "consultant-1");
	assert.equal(entry?.model, "fixture/author-model");
	assert.deepEqual(entry?.usage, { tokens: 42, seconds: (entry?.usage as { seconds: number }).seconds });
	assert.equal(entry?.summary, "answered: The cache uses the rollback journal");
	assert.equal((entry?.schemaPayload as { verdict: string }).verdict, "answered");
});

test("a consultant that reports no tokens is recorded with usage unknown, never a fabricated number", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(() => ({ ok: true, payload: RESEARCH_OK }));
	const resolved = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["u"] }), policy(), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "consulted");
	assert.equal(storedRecords(ctx)[0]?.consultants[0]?.usage, "unknown");
});

test("research insufficient escalates to ask-human and no critic is launched", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(() => ({ ok: true, payload: { findings: [], remainingUnknowns: ["write volume"], verdict: "insufficient" } }));
	const resolved = await resolveDecision(proposal({ selfRoute: "research+critique", unknowns: ["write volume"], materialRisk: true }), criticPolicy(), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind !== "ask-human") return;
	assert.equal(resolved.reason, "researcher verdict insufficient");
	assert.match(resolved.text, /escalated \(researcher verdict insufficient\)/);
	assert.deepEqual(fake.calls.map((call) => call.role), ["researcher"]);
	const [record] = storedRecords(ctx);
	assert.equal(record?.status, "escalated");
	assert.equal(record?.consultants.length, 1);
	assert.deepEqual(record?.routeJustification.reasons, { "ask-human": "researcher verdict insufficient" });
});

test("a researcher that returns no valid result escalates with its error code and records the failed run", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(() => ({ ok: false, errorCode: "invalid_output", message: "Consultant researcher returned no structured result." }));
	const resolved = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["u"] }), policy(), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind !== "ask-human") return;
	assert.equal(resolved.reason, "consultant researcher invalid_output: Consultant researcher returned no structured result.");
	const [record] = storedRecords(ctx);
	assert.equal(record?.status, "escalated");
	const entry = record?.consultants[0];
	assert.equal(entry?.usage, "unknown");
	assert.equal(entry?.schemaPayload, null);
	assert.equal(entry?.summary, "invalid_output: Consultant researcher returned no structured result.");
});

test("a runner that throws is a failed provider run: escalated, recorded, and never a silent pass", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(() => {
		throw new Error("boom");
	});
	const resolved = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["u"] }), policy(), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind === "ask-human") assert.equal(resolved.reason, "consultant researcher provider: boom");
	const [record] = storedRecords(ctx);
	assert.equal(record?.status, "escalated");
	assert.equal(record?.consultants[0]?.summary, "provider: boom");
});

test("research+critique runs the critic after the researcher, on the critic model, with the findings in its prompt", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner((args) => (args.role === "researcher" ? researcherAnswers() : { ok: true, payload: CRITIC_OK, usage: { tokens: 9 } }));
	const resolved = await resolveDecision(proposal({ selfRoute: "research+critique", unknowns: ["write volume"], materialRisk: true }), criticPolicy(), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "consulted");
	if (resolved.kind !== "consulted") return;

	assert.deepEqual(fake.events, ["start researcher 1", "end researcher 1", "start critic 2", "end critic 2"]);
	assert.deepEqual(fake.calls.map((call) => call.role), ["researcher", "critic"]);
	assert.equal(fake.calls[1]?.model, CRITIC_MODEL, "critic runs on decisionCritic, never on the proposing model");
	assert.equal(fake.calls[1]?.thinkingLevel, "high");
	assert.match(fake.calls[1]?.prompt ?? "", /- The cache uses the rollback journal \(source: src\/cache\.ts\)/, "critic sees the research findings");
	assert.deepEqual(resolved.risks, ["minor: WAL needs -shm files on network drives"]);

	const [record] = storedRecords(ctx);
	assert.deepEqual(record?.consultants.map((entry) => [entry.role, entry.childRunId, entry.model]), [
		["researcher", "consultant-1", "fixture/author-model"],
		["critic", "consultant-2", "fixture/critic-model"],
	]);
	assert.equal(record?.revision, 2);
	assert.equal(record?.status, "open");
});

test("critic-only route runs one critique session and records the critic run", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(() => ({ ok: true, payload: CRITIC_OK, usage: { tokens: 7 } }));
	const resolved = await resolveDecision(proposal({ selfRoute: "critique", materialRisk: true }), criticPolicy(), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "consulted");
	if (resolved.kind !== "consulted") return;
	assert.equal(resolved.route, "critique");
	assert.equal(fake.calls.length, 1);
	assert.equal(fake.calls[0]?.role, "critic");
	assert.equal(fake.calls[0]?.model, CRITIC_MODEL);
	assert.equal(storedRecords(ctx)[0]?.consultants[0]?.model, "fixture/critic-model");
});

test("a blocker objection escalates to ask-human even when the critic verdict is sound", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner((args) => (args.role === "researcher"
		? researcherAnswers()
		: { ok: true, payload: { objections: [{ severity: "blocker", evidence: "reads race the writer" }], verdict: "sound" } }));
	const resolved = await resolveDecision(proposal({ selfRoute: "research+critique", unknowns: ["u"], materialRisk: true }), criticPolicy(), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind !== "ask-human") return;
	assert.equal(resolved.reason, "critic blocker objection: reads race the writer");
	const [record] = storedRecords(ctx);
	assert.equal(record?.status, "escalated");
	assert.equal(record?.consultants.length, 2);
});

test("an unsound critic verdict escalates even without a blocker objection", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(() => ({ ok: true, payload: { objections: [{ severity: "major", evidence: "option 2 loses data" }], verdict: "unsound" } }));
	const resolved = await resolveDecision(proposal({ selfRoute: "critique", materialRisk: true }), criticPolicy(), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind === "ask-human") assert.equal(resolved.reason, "critic verdict unsound");
});

test("a critic that fails with a config error escalates to ask-human and is recorded", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(() => ({ ok: false, errorCode: "config", message: "Consultant critic model is not configured." }));
	const resolved = await resolveDecision(proposal({ selfRoute: "critique", materialRisk: true }), criticPolicy(), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind === "ask-human") assert.equal(resolved.reason, "consultant critic config: Consultant critic model is not configured.");
	assert.equal(storedRecords(ctx)[0]?.consultants[0]?.role, "critic");
});

test("mandatory critique without a configured critic escalates with config and launches nothing", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(researcherAnswers);
	const resolved = await resolveDecision(proposal({ selfRoute: "critique", materialRisk: true }), policy(), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind !== "ask-human") return;
	assert.match(resolved.reason, /^config: decisionCritic provider and model are not set/);
	assert.equal(fake.calls.length, 0);
	const [record] = storedRecords(ctx);
	assert.equal(record?.status, "escalated");
	assert.equal(record?.route, "critique");
	assert.deepEqual(record?.consultants, []);
});

test("a configured critic that equals the proposing model is refused: no same-model fallback", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(researcherAnswers);
	const resolved = await resolveDecision(proposal({ selfRoute: "critique", materialRisk: true }), criticPolicy(), ctx, depsFor(fake, ctx.cwd, CRITIC_MODEL));
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind === "ask-human") assert.match(resolved.reason, /^config: critic model fixture\/critic-model is the proposing model/);
	assert.equal(fake.calls.length, 0);
});

test("a configured critic missing from the registry escalates with config and launches nothing", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(researcherAnswers);
	const resolved = await resolveDecision(proposal({ selfRoute: "critique", materialRisk: true }), criticPolicy({}, { provider: "fixture", model: "missing-model" }), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind === "ask-human") assert.equal(resolved.reason, "config: critic model not found: fixture/missing-model");
	assert.equal(fake.calls.length, 0);
});

test("resolveCriticModel: explicit critic resolves; unset, provider-only, and proposing-model critics are refused", () => {
	const ctx = fakeCtx(AUTHOR_MODEL, "unused");
	const explicit = resolveCriticModel(ctx, criticPolicy(), AUTHOR_MODEL);
	assert.deepEqual(explicit, { ok: true, model: CRITIC_MODEL, thinkingLevel: "high" });

	const unset = resolveCriticModel(ctx, policy(), AUTHOR_MODEL);
	assert.equal(unset.ok, false);
	if (!unset.ok) assert.match(unset.reason, /not set; the executor model is not used as critic/);

	const providerOnly = resolveCriticModel(ctx, criticPolicy({}, { provider: "fixture" }), AUTHOR_MODEL);
	assert.equal(providerOnly.ok, false);

	const same = resolveCriticModel(fakeCtx(CRITIC_MODEL, "unused"), criticPolicy(), CRITIC_MODEL);
	assert.equal(same.ok, false);
	if (!same.ok) assert.match(same.reason, /cross-model review is required/);
});

// ── consultations: rounds and parallelism ───────────────────────────────────

test("parallel researchers: at most maxParallelConsultants run at once and the next chunk starts after the previous one settles", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(researcherAnswers);
	const resolved = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["u1", "u2", "u3"] }), policy(), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "consulted");
	assert.equal(fake.calls.length, 3);
	assert.equal(fake.maxLive, 2, "never more than maxParallelConsultants (2) at once");
	const settled = (label: string) => fake.events.indexOf(label);
	assert.ok(settled("start researcher 3") > settled("end researcher 1"), "chunk 2 starts after chunk 1 settles");
	assert.ok(settled("start researcher 3") > settled("end researcher 2"), "chunk 2 starts after chunk 1 settles");
	assert.deepEqual(fake.calls.map((call) => call.prompt.match(/Answer with evidence from the repository: (\S+)/)?.[1]), ["u1", "u2", "u3"]);
	assert.deepEqual(storedRecords(ctx)[0]?.consultants.map((entry) => entry.childRunId), ["consultant-1", "consultant-2", "consultant-3"]);
});

test("maxParallelConsultants 1 runs researchers one at a time", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(researcherAnswers);
	const resolved = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["u1", "u2"] }), criticPolicy({ maxParallelConsultants: 1 }, undefined), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "consulted");
	assert.equal(fake.maxLive, 1);
});

test("maxRounds is enforced before any launch: research+critique on one unknown needs two rounds", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(researcherAnswers);
	const resolved = await resolveDecision(proposal({ selfRoute: "research+critique", unknowns: ["u"], materialRisk: true }), criticPolicy({ maxRounds: 1 }), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind === "ask-human") assert.equal(resolved.reason, "consultation rounds exhausted: route research+critique needs 2, maxRounds is 1");
	assert.equal(fake.calls.length, 0);
	const [record] = storedRecords(ctx);
	assert.equal(record?.status, "escalated");
	assert.deepEqual(record?.consultants, []);
});

test("rounds count phases: three unknowns with critique fit maxRounds 2 (chunks add no round)", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner((args) => (args.role === "researcher" ? researcherAnswers() : { ok: true, payload: CRITIC_OK }));
	const resolved = await resolveDecision(proposal({ selfRoute: "research+critique", unknowns: ["u1", "u2", "u3"], materialRisk: true }), criticPolicy(), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "consulted");
	assert.deepEqual(fake.calls.map((call) => call.role), ["researcher", "researcher", "researcher", "critic"]);
	assert.equal(fake.maxLive, 2);
	assert.equal(storedRecords(ctx)[0]?.consultants.length, 4);
});

test("research-only with many unknowns is one round: maxRounds 1 allows it", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(researcherAnswers);
	const resolved = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["u1", "u2", "u3"] }), criticPolicy({ maxRounds: 1 }), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "consulted");
	assert.equal(fake.calls.length, 3);
});

// ── consultations: prompt minimization ──────────────────────────────────────

test("consultant prompts carry only the minimized request, never the objective, record metadata, or ids", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner((args) => (args.role === "researcher" ? researcherAnswers() : { ok: true, payload: CRITIC_OK }));
	await resolveDecision(proposal({ selfRoute: "research+critique", unknowns: ["write volume"], materialRisk: true }), criticPolicy(), ctx, depsFor(fake, ctx.cwd));
	const researcherCritic = fake.calls.map((call) => call.prompt);
	assert.equal(researcherCritic.length, 2);
	for (const prompt of researcherCritic) {
		assert.match(prompt, /^Question: Use WAL mode for the local cache\?$/m);
		assert.match(prompt, /^Options: 1\) WAL; 2\) rollback journal$/m);
		assert.match(prompt, /^Authority basis: The request asks for the cache migration end to end\.$/m);
		assert.match(prompt, /^- cache is a local sqlite file$/m);
		assert.match(prompt, /^- write volume$/m);
		assert.doesNotMatch(prompt, /dec-[0-9a-f]{12}/, "no decision id");
		for (const forbidden of [OBJECTIVE, GOAL, "policy-1", "gen-1", ctx.cwd]) assert.equal(prompt.includes(forbidden), false, forbidden);
	}
	assert.match(researcherCritic[0] ?? "", /^Your question: Answer with evidence from the repository: write volume$/m);
	assert.match(researcherCritic[1] ?? "", /^Your question: Which objections apply/m);
});

test("the proposal itself reaches the critic: its question, options, and unknowns are present", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(() => ({ ok: true, payload: CRITIC_OK }));
	await resolveDecision(proposal({ selfRoute: "critique", materialRisk: true, unknowns: ["u"], skipJustifications: { research: "u is not needed here" } }), criticPolicy(), ctx, depsFor(fake, ctx.cwd));
	const prompt = fake.calls[0]?.prompt ?? "";
	assert.match(prompt, /^Question: Use WAL mode for the local cache\?$/m);
	assert.match(prompt, /^Options: 1\) WAL; 2\) rollback journal$/m);
	assert.match(prompt, /^- u$/m);
});

// ── escalation helpers, direct resolution ───────────────────────────────────

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

test("invalid proposals never touch the store across every write entry point", async t => {
	const ctx = storeCtx(t);
	const bad = proposal({ question: "" });
	assert.equal(applyAskHuman(ctx, bad, "x").ok, false);
	assert.equal(applyDirectResolution(ctx, bad, "WAL", policy()).ok, false);
	assert.equal((await resolveDecision(bad, policy(), ctx, noLaunchDeps())).kind, "invalid");
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

// ── cross-route consultation cap (TECH §5) ──────────────────────────────────

const RESEARCH_CRITIQUE = (unknowns: string[]) => proposal({ selfRoute: "research+critique", unknowns, materialRisk: true });

function countedLaunches(ctx: DecisionStoreContext): number {
	const counted = getConsultationsLaunched(ctx.storage, ctx.goalId);
	if (!counted.ok) throw new Error(`${counted.error.code}: ${counted.error.message}`);
	return counted.value;
}

test("the cap allows six launches per goal: three research+critique decisions run, the next one escalates before any launch", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner((args) => (args.role === "researcher" ? researcherAnswers() : { ok: true, payload: CRITIC_OK }));
	const deps = depsFor(fake, ctx.cwd);
	for (let index = 1; index <= 3; index += 1) {
		const resolved = await resolveDecision(RESEARCH_CRITIQUE(["u"]), criticPolicy(), ctx, deps);
		assert.equal(resolved.kind, "consulted", `decision ${index}`);
	}
	assert.equal(fake.calls.length, 6);
	assert.equal(countedLaunches(ctx), 6);

	const seventh = await resolveDecision(RESEARCH_CRITIQUE(["u"]), criticPolicy(), ctx, deps);
	assert.equal(seventh.kind, "ask-human");
	if (seventh.kind === "ask-human") assert.equal(seventh.reason, "consultation cap reached (6/6)");
	assert.equal(fake.calls.length, 6, "the refused wave launches nothing");
	assert.equal(countedLaunches(ctx), 6);
	const last = storedRecords(ctx).at(-1);
	assert.equal(last?.status, "escalated");
	assert.deepEqual(last?.consultants, []);
	assert.equal(last?.routeJustification.reasons["ask-human"], "consultation cap reached (6/6)");
});

test("a wave that would overflow the cap is refused whole: no launch from it, and the counter does not move", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(researcherAnswers);
	const deps = depsFor(fake, ctx.cwd);
	const cap3 = policy();
	cap3.limits.maxConsultationsPerGoal = 3;
	const first = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["u1", "u2"] }), cap3, ctx, deps);
	assert.equal(first.kind, "consulted");
	assert.equal(countedLaunches(ctx), 2);

	const second = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["v1", "v2"] }), cap3, ctx, deps);
	assert.equal(second.kind, "ask-human");
	if (second.kind === "ask-human") assert.equal(second.reason, "consultation cap reached (2/3)");
	assert.equal(fake.calls.length, 2, "a wave of 2 at 2/3 launches nothing");
	assert.equal(countedLaunches(ctx), 2);
});

test("a second wave that overflows is refused after the first wave ran; its launches are counted", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(researcherAnswers);
	const cap3 = policy();
	cap3.limits.maxConsultationsPerGoal = 3;
	const resolved = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["u1", "u2", "u3", "u4"] }), cap3, ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind === "ask-human") assert.equal(resolved.reason, "consultation cap reached (2/3)");
	assert.equal(fake.calls.length, 2, "wave 1 (two launches, 2/3) ran; wave 2 (two more, would be 4/3) did not");
	assert.equal(countedLaunches(ctx), 2);
	assert.equal(storedRecords(ctx)[0]?.consultants.length, 2);
});

test("a launch refused before the gate (config) is not counted", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(
		(args) => (args.role === "researcher" ? researcherAnswers() : { ok: true, payload: CRITIC_OK }),
		5,
		(args) => (args.role === "critic" ? { ok: false, errorCode: "config", message: "critic model is not configured" } : undefined),
	);
	const resolved = await resolveDecision(RESEARCH_CRITIQUE(["u"]), criticPolicy(), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "ask-human");
	assert.equal(fake.calls.length, 1, "only the researcher launched");
	assert.equal(countedLaunches(ctx), 1, "the refused critic is not counted");
});

test("a launch refused by the gate after the wave check (cap taken by another writer) launches nothing and counts nothing", async t => {
	const ctx = storeCtx(t);
	let external = false;
	const fake = fakeRunner(researcherAnswers);
	const racing: ConsultantRunner = (async (args: RunConsultantArgs<ConsultantRole>) => {
		if (!external) {
			// Another writer (e.g. the oracle) takes two launches between the wave check and the first gate.
			external = true;
			const seeded = incrementConsultations(ctx.storage, ctx.goalId, 3, 2);
			assert.equal(seeded.ok, true);
		}
		return fake.runner(args);
	}) as unknown as ConsultantRunner;
	const cap3 = policy();
	cap3.limits.maxConsultationsPerGoal = 3;
	const resolved = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["u1", "u2"] }), cap3, ctx, { ctx: fakeCtx(AUTHOR_MODEL, ctx.cwd), runConsultant: racing });
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind === "ask-human") assert.match(resolved.reason, /researcher budget: consultation cap reached \(3\/3\)/);
	assert.equal(fake.calls.length, 1, "the first gate passes (2+1 <= 3); the second is refused");
	assert.equal(countedLaunches(ctx), 3, "external 2 + one real launch; the refused gate adds nothing");
});

test("the cap is read from the policy: with a cap of 1 the critic wave is refused after the researcher ran", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(researcherAnswers);
	const resolved = await resolveDecision(RESEARCH_CRITIQUE(["u"]), criticPolicy({ maxConsultationsPerGoal: 1 }), ctx, depsFor(fake, ctx.cwd));
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind === "ask-human") assert.equal(resolved.reason, "consultation cap reached (1/1)");
	assert.deepEqual(fake.calls.map((call) => call.role), ["researcher"]);
	assert.equal(countedLaunches(ctx), 1);
});

// ── cancellation (TECH §6, E5.2) ────────────────────────────────────────────

const ORPHANED_RUN: AnyRunResult = {
	ok: false,
	errorCode: "aborted",
	message: "Consultant researcher was cancelled. It did not stop within 5000 ms and is marked orphaned.",
	orphaned: true,
};

test("a cancel during the research wave ends the route: record invalidated, no further wave and no critic", async t => {
	const ctx = storeCtx(t);
	const controller = new AbortController();
	const fake = fakeRunner((args) => {
		if (args.role === "researcher") controller.abort();
		return args.role === "researcher" ? researcherAnswers() : { ok: true, payload: CRITIC_OK };
	});
	const deps: ConsultationDeps = { ...depsFor(fake, ctx.cwd), signal: controller.signal };
	const resolved = await resolveDecision(
		proposal({ selfRoute: "research+critique", unknowns: ["write volume", "disk layout"], materialRisk: true }),
		criticPolicy({ maxParallelConsultants: 1 }),
		ctx,
		deps,
	);

	assert.equal(resolved.kind, "cancelled");
	if (resolved.kind !== "cancelled") return;
	assert.deepEqual(fake.calls.map((call) => call.role), ["researcher"], "neither the second unknown nor the critic launches");
	const [record] = storedRecords(ctx);
	assert.equal(resolved.decisionId, record?.id);
	assert.equal(record?.status, "invalidated");
	assert.deepEqual(record?.consultants.map((entry) => entry.childRunId), ["consultant-1"], "the completed launch stays recorded");
});

test("a cancel during the critic wave invalidates the record after the critic run is recorded", async t => {
	const ctx = storeCtx(t);
	const controller = new AbortController();
	const fake = fakeRunner((args) => {
		if (args.role === "critic") controller.abort();
		return args.role === "researcher" ? researcherAnswers() : { ok: true, payload: CRITIC_OK };
	});
	const deps: ConsultationDeps = { ...depsFor(fake, ctx.cwd), signal: controller.signal };
	const resolved = await resolveDecision(proposal({ selfRoute: "research+critique", unknowns: ["write volume"], materialRisk: true }), criticPolicy(), ctx, deps);

	assert.equal(resolved.kind, "cancelled");
	const [record] = storedRecords(ctx);
	assert.equal(record?.status, "invalidated");
	assert.deepEqual(record?.consultants.map((entry) => entry.role), ["researcher", "critic"]);
});

test("an already-cancelled signal writes nothing and launches nothing", async t => {
	const ctx = storeCtx(t);
	const controller = new AbortController();
	controller.abort();
	const fake = fakeRunner(researcherAnswers);
	const deps: ConsultationDeps = { ...depsFor(fake, ctx.cwd), signal: controller.signal };
	const resolved = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["write volume"] }), policy(), ctx, deps);

	assert.equal(resolved.kind, "cancelled");
	if (resolved.kind === "cancelled") assert.equal(resolved.decisionId, undefined);
	assert.equal(fake.calls.length, 0);
	assert.equal(sidecarExists(ctx), false);
});

test("an orphaned child is recorded with orphaned: true and the route ends cancelled", async t => {
	const ctx = storeCtx(t);
	const controller = new AbortController();
	const fake = fakeRunner(() => {
		controller.abort();
		return ORPHANED_RUN;
	});
	const deps: ConsultationDeps = { ...depsFor(fake, ctx.cwd), signal: controller.signal };
	const resolved = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["write volume"] }), policy(), ctx, deps);

	assert.equal(resolved.kind, "cancelled");
	const [record] = storedRecords(ctx);
	assert.equal(record?.status, "invalidated");
	const entry = record?.consultants[0];
	assert.equal(entry?.orphaned, true);
	assert.equal(entry?.usage, "unknown");
	assert.equal(entry?.schemaPayload, null);
});

test("a settled child carries no orphaned marker in the record", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(researcherAnswers);
	await resolveDecision(proposal({ selfRoute: "research", unknowns: ["write volume"] }), policy(), ctx, depsFor(fake, ctx.cwd));

	const [record] = storedRecords(ctx);
	assert.equal(record?.consultants[0] && "orphaned" in record.consultants[0], false);
});

// ── budget gating and keyed accounting (TECH §3, §6, E5.3) ──────────────────

const budgetDeps = (fake: FakeRunner, cwd: string, tokenBudget: number | undefined, tokensUsed: number, accounting = new GoalAccounting()): ConsultationDeps => ({
	...depsFor(fake, cwd),
	budget: { goal: () => ({ tokenBudget, usage: { tokensUsed } }), accounting },
});

test("budget gate: an exhausted budget refuses the launch before any consultant starts and escalates with the budget line", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(researcherAnswers);
	const resolved = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["write volume"] }), policy(), ctx, budgetDeps(fake, ctx.cwd, 100, 100));
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind === "ask-human") assert.equal(resolved.reason, "consultant researcher budget: token budget: 100/100 used, 0 remaining");
	assert.equal(fake.calls.length, 0, "the refused launch never starts");
	assert.equal(countedLaunches(ctx), 0, "a budget refusal reserves no consultation");
	assert.equal(storedRecords(ctx)[0]?.status, "escalated");
});

test("budget gate: consultant tokens charged to accounting count against the budget before the next launch", async t => {
	const ctx = storeCtx(t);
	const accounting = new GoalAccounting();
	// The researcher reports 42 tokens; the critic gate then sees 50 - 42 = 8 left and still launches.
	const fake = fakeRunner((args) => (args.role === "researcher" ? researcherAnswers() : { ok: true, payload: CRITIC_OK }));
	const fits = await resolveDecision(RESEARCH_CRITIQUE(["u"]), criticPolicy(), ctx, budgetDeps(fake, ctx.cwd, 50, 0, accounting));
	assert.equal(fits.kind, "consulted");
	assert.deepEqual(fake.calls.map((call) => call.role), ["researcher", "critic"]);
	assert.equal(accounting.pendingKeyedTokens(), 42, "the critic reported no usage: only the researcher's 42 tokens are charged");
});

test("budget gate: a critic launch is refused when earlier consultant usage already spent the budget", async t => {
	const ctx = storeCtx(t);
	const accounting = new GoalAccounting();
	const fake = fakeRunner((args) => (args.role === "researcher" ? { ok: true, payload: RESEARCH_OK, usage: { tokens: 60 } } : { ok: true, payload: CRITIC_OK }));
	const resolved = await resolveDecision(RESEARCH_CRITIQUE(["u"]), criticPolicy(), ctx, budgetDeps(fake, ctx.cwd, 50, 0, accounting));
	assert.equal(resolved.kind, "ask-human");
	if (resolved.kind === "ask-human") assert.equal(resolved.reason, "consultant critic budget: token budget: 60/50 used, 0 remaining");
	assert.deepEqual(fake.calls.map((call) => call.role), ["researcher"], "the critic never launches");
	assert.equal(accounting.pendingKeyedTokens(), 60);
});

test("keyed accounting: two deliberations on one accounting each charge their consultant-1 (childRunId is keyed per decision)", async t => {
	const ctx = storeCtx(t);
	const accounting = new GoalAccounting();
	const fake = fakeRunner(researcherAnswers);
	const deps = budgetDeps(fake, ctx.cwd, undefined, 0, accounting);
	const first = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["u"] }), policy(), ctx, deps);
	const second = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["v"] }), policy(), ctx, deps);
	assert.equal(first.kind, "consulted");
	assert.equal(second.kind, "consulted");
	const records = storedRecords(ctx);
	assert.deepEqual(records.map((record) => record.consultants[0]?.childRunId), ["consultant-1", "consultant-1"]);
	assert.equal(accounting.pendingKeyedTokens(), 84);
});

test("keyed accounting: a consultant that reports no usage is recorded as unknown and charges no tokens", async t => {
	const ctx = storeCtx(t);
	const accounting = new GoalAccounting();
	const fake = fakeRunner(() => ({ ok: true, payload: RESEARCH_OK }));
	const resolved = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["u"] }), policy(), ctx, budgetDeps(fake, ctx.cwd, 10, 0, accounting));
	assert.equal(resolved.kind, "consulted");
	assert.equal(storedRecords(ctx)[0]?.consultants[0]?.usage, "unknown");
	assert.equal(accounting.pendingKeyedTokens(), 0);
});

test("budget gate: without a budget the launch is never refused, whatever the usage so far", async t => {
	const ctx = storeCtx(t);
	const fake = fakeRunner(researcherAnswers);
	const resolved = await resolveDecision(proposal({ selfRoute: "research", unknowns: ["u"] }), policy(), ctx, budgetDeps(fake, ctx.cwd, undefined, 999_999));
	assert.equal(resolved.kind, "consulted");
	assert.equal(fake.calls.length, 1);
});
