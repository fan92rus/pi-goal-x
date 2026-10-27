/**
 * Decision journal and status surface (specs/2026-10-27-adaptive-decisions, TECH §8, E6.3):
 * every terminal state writes one `decision_recorded` ledger event, the activity feed and the
 * dashboard show it, and a project decisionMode switch made through the settings API takes effect
 * at acceptance. Consultants and the owner dialog are injected; no session, network, or UI is used.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GoalAccounting } from "../extensions/goal-accounting.ts";
import type { ConsultantModel, ConsultantRole, ConsultantRunResult, CriticPayload, ResearcherPayload, RunConsultantArgs } from "../extensions/goal-decision-consultant.ts";
import { decisionJournalEvent, journalDecision } from "../extensions/goal-decision-journal.ts";
import { createDecision, getDecisions, type DecisionRecord } from "../extensions/goal-decision-record.ts";
import { executeDecisionTool, type ConsultantRunner, type DecisionGoalView, type DecisionToolDeps } from "../extensions/goal-decision.ts";
import { deriveGoalActivity } from "../extensions/goal-activity.ts";
import { latestDecisionForGoal, readGoalLedger, type GoalLedgerEvent } from "../extensions/goal-ledger.ts";
import { buildGoalStatusText } from "../extensions/goal-status.ts";
import { resolveDecisionSettings } from "../extensions/goal-decision-policy.ts";
import { mutateSettingsLayer } from "../extensions/goal-settings.ts";
import { createGoal, type GoalRecord } from "../extensions/goal-record.ts";
import { deriveGoalDashboardModel } from "../extensions/widgets/goal-dashboard-model.ts";

const GOAL = "goal-a";
const OBJECTIVE = "Migrate the local cache to WAL mode end to end";
const AUTHOR_MODEL = { provider: "fixture", id: "author-model" } as unknown as ConsultantModel;
const CRITIC_MODEL = { provider: "fixture", id: "critic-model" } as unknown as ConsultantModel;
const MODELS: Record<string, unknown> = { "fixture/author-model": AUTHOR_MODEL, "fixture/critic-model": CRITIC_MODEL };
const CRITIC_SETTINGS = { decisionCritic: { provider: "fixture", model: "critic-model", thinkingLevel: "high" } };

const RESEARCH_OK: ResearcherPayload = {
	findings: [{ claim: "The cache uses the rollback journal", evidence: "src/cache.ts sets journal_mode=DELETE", source: "src/cache.ts" }],
	remainingUnknowns: [],
	verdict: "answered",
};
const CRITIC_OK: CriticPayload = {
	objections: [{ severity: "minor", evidence: "WAL needs -shm files on network drives" }],
	verdict: "sound",
};

type AnyRunResult = ConsultantRunResult<ConsultantRole>;

function writeSettings(cwd: string, settings: Record<string, unknown>): void {
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify(settings));
}

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/** Proposal without the materialRisk key: absent counts as material (TECH §4). */
function unsureProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const { materialRisk: _omitted, ...rest } = proposal(overrides);
	return rest;
}

interface Harness {
	cwd: string;
	env: NodeJS.ProcessEnv;
	launches: ConsultantRole[];
	deps: DecisionToolDeps;
	records(): DecisionRecord[];
	ledger(): GoalLedgerEvent[];
}

interface HarnessOptions {
	mode: string;
	critic?: boolean;
	/** Runs before each launch that passes the budget gate. */
	beforeLaunch?: (role: ConsultantRole) => void;
	/** Runs inside the researcher run, before it returns. */
	duringResearch?: () => void;
}

function harness(t: test.TestContext, options: HarnessOptions): Harness {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-decision-journal-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeSettings(cwd, { decisionMode: options.mode, ...(options.critic === true ? CRITIC_SETTINGS : {}) });
	const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(cwd, "global-settings.json") } as NodeJS.ProcessEnv;
	const goal: { current: DecisionGoalView } = {
		current: { id: GOAL, status: "active", objective: OBJECTIVE, generation: "gen-1", usage: { tokensUsed: 0 } },
	};
	const launches: ConsultantRole[] = [];
	const runner = (async (args: RunConsultantArgs<ConsultantRole>): Promise<AnyRunResult> => {
		if (args.beforeLaunch) {
			const gate = args.beforeLaunch();
			if (!gate.ok) return { ok: false, errorCode: "budget", message: gate.reason };
		}
		launches.push(args.role);
		options.beforeLaunch?.(args.role);
		if (args.role === "researcher") {
			options.duringResearch?.();
			return { ok: true, payload: RESEARCH_OK };
		}
		return { ok: true, payload: CRITIC_OK };
	}) as unknown as ConsultantRunner;
	const ctx = {
		cwd,
		model: AUTHOR_MODEL,
		modelRegistry: { find: (provider: string, id: string) => MODELS[`${provider}/${id}`] },
	} as unknown as ExtensionContext;
	const deps: DecisionToolDeps = {
		cwd,
		env,
		storage: { cwd },
		ctx,
		readGoal: () => goal.current,
		runConsultant: runner,
		accounting: new GoalAccounting(),
		ask: async () => ({ questions: [], answers: [], cancelled: true }),
	};
	return {
		cwd,
		env,
		launches,
		deps,
		records() {
			const listed = getDecisions({ cwd }, GOAL);
			if (!listed.ok) throw new Error(`${listed.error.code}: ${listed.error.message}`);
			return listed.value;
		},
		ledger() {
			return readGoalLedger({ cwd }).events.filter((event) => event.type === "decision_recorded");
		},
	};
}

function journaled(h: Harness): Extract<GoalLedgerEvent, { type: "decision_recorded" }> {
	const entries = h.ledger();
	assert.equal(entries.length, 1, "exactly one journal entry per call");
	const [entry] = entries;
	assert.ok(entry && entry.type === "decision_recorded");
	return entry;
}

// ── the journal builder ─────────────────────────────────────────────────────

function recordFixture(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
	return {
		id: "dec-0123456789ab",
		goalId: GOAL,
		createdAt: "2026-10-27T09:00:00.000Z",
		requestAnchor: { objectiveExcerpt: OBJECTIVE, objectiveHash: "a".repeat(64) },
		policyVersion: "policy-1",
		question: "Use WAL mode for the local cache?",
		options: ["WAL", "rollback journal"],
		route: "direct",
		routeJustification: { skipped: [], reasons: {} },
		authorityBasis: "The request asks for the cache migration end to end.",
		facts: [],
		unknowns: [],
		consultants: [],
		status: "decided",
		revision: 1,
		generation: "gen-1",
		outcome: { chosen: "WAL", source: "agent", risks: ["minor: WAL needs -shm files"], revisitWhen: "the cache moves to a network drive" },
		...overrides,
	};
}

test("an open record is not journaled", () => {
	assert.equal(decisionJournalEvent(recordFixture({ status: "open", outcome: undefined })), undefined);
});

test("a decided direct record carries route, link to the request, chosen option, source, risks, revisit and zero tokens", () => {
	const event = decisionJournalEvent(recordFixture(), undefined, "2026-10-27T09:01:00.000Z");
	assert.deepEqual(event, {
		type: "decision_recorded",
		goalId: GOAL,
		decisionId: "dec-0123456789ab",
		status: "decided",
		route: "direct",
		question: "Use WAL mode for the local cache?",
		authorityBasis: "The request asks for the cache migration end to end.",
		routeWhy: "",
		requestHash: "a".repeat(16),
		chosen: "WAL",
		source: "agent",
		risks: ["minor: WAL needs -shm files"],
		revisitWhen: "the cache moves to a network drive",
		consultantTokens: 0,
		at: "2026-10-27T09:01:00.000Z",
	});
});

test("consultant tokens add up over known usage; one unknown usage makes the total unknown", () => {
	const known = recordFixture({
		status: "decided",
		consultants: [
			{ role: "researcher", childRunId: "consultant-1", model: "fixture/author-model", usage: { tokens: 120, seconds: 1 }, summary: "answered", schemaPayload: null },
			{ role: "critic", childRunId: "consultant-2", model: "fixture/critic-model", usage: { tokens: 80, seconds: 1 }, summary: "sound", schemaPayload: null },
		],
	});
	const summed = decisionJournalEvent(known);
	assert.ok(summed && summed.type === "decision_recorded");
	assert.equal(summed.consultantTokens, 200);
	const partial = { ...known, consultants: [...known.consultants, { ...known.consultants[0]!, childRunId: "consultant-3", usage: "unknown" as const }] };
	const event = decisionJournalEvent(partial);
	assert.ok(event && event.type === "decision_recorded");
	assert.equal(event.consultantTokens, "unknown", "unknown usage is never estimated");
});

test("an escalated record takes its reason from routeJustification, and long fields are capped at 300 characters", () => {
	const long = "x".repeat(400);
	const event = decisionJournalEvent(recordFixture({
		status: "escalated",
		outcome: undefined,
		route: "ask-human",
		routeJustification: { skipped: [], reasons: { "ask-human": "dialog cancelled", research: "later" } },
		authorityBasis: long,
	}));
	assert.ok(event && event.type === "decision_recorded");
	assert.equal(event.reason, "dialog cancelled");
	assert.equal(event.routeWhy, "research: later");
	assert.equal(event.authorityBasis.length, 300);
	assert.ok(event.authorityBasis.endsWith("…"));
});

test("journalDecision reads the record and appends one event that the ledger accepts", (t) => {
	const h = harness(t, { mode: "bounded-auto" });
	const storage = h.deps.storage;
	const created = createDecision(storage, GOAL, {
		objective: OBJECTIVE,
		policyVersion: "policy-1",
		question: "Use WAL mode for the local cache?",
		options: ["WAL", "rollback journal"],
		route: "ask-human",
		routeJustification: { skipped: [], reasons: { "ask-human": "no authority" } },
		authorityBasis: "The request asks for the migration.",
		facts: [],
		unknowns: [],
		consultants: [],
		generation: "gen-1",
	});
	assert.equal(created.ok, true);
	if (!created.ok) return;
	assert.deepEqual(journalDecision(storage, GOAL, created.value.id), { ok: false, reason: `decision ${created.value.id} is still open` });
	assert.deepEqual(h.ledger(), []);
	assert.equal(journalDecision(storage, GOAL, "dec-missing000000").ok, false);
});

// ── every terminal state through the tool ───────────────────────────────────

test("bounded-auto direct: one decided entry names the decision, the chosen option and the agent source", async (t) => {
	const h = harness(t, { mode: "bounded-auto" });
	await executeDecisionTool(proposal(), 0, h.deps);
	const [record] = h.records();
	const entry = journaled(h);
	assert.equal(entry.decisionId, record?.id);
	assert.equal(entry.status, "decided");
	assert.equal(entry.route, "direct");
	assert.equal(entry.chosen, "WAL");
	assert.equal(entry.source, "agent");
	assert.equal(entry.consultantTokens, 0);
	assert.equal(readGoalLedger({ cwd: h.cwd }).malformed, 0, "the ledger reads the new event type without malformed entries");
	const latest = latestDecisionForGoal(readGoalLedger({ cwd: h.cwd }).events, GOAL);
	assert.equal(latest?.decisionId, record?.id);
});

test("a forbidden category escalates: one escalated entry carries the floor reason and launches nothing", async (t) => {
	const h = harness(t, { mode: "bounded-auto" });
	await executeDecisionTool(proposal({ question: "Delete the old cache table?", options: ["keep it", "delete it"] }), 1, h.deps);
	const entry = journaled(h);
	assert.equal(entry.status, "escalated");
	assert.match(entry.reason ?? "", /forbidden category: data-deletion/);
	assert.equal(entry.chosen, undefined);
	assert.deepEqual(h.launches, []);
});

test("a switch of decisionMode to manual through the settings API while the critic runs journals the rejection", async (t) => {
	const h = harness(t, {
		mode: "bounded-auto",
		critic: true,
		beforeLaunch: () => mutateSettingsLayer({
			scope: "project",
			cwd: h.cwd,
			env: h.env,
			mutation: { op: "set", path: ["decisionMode"], value: "manual" },
		}),
	});
	const text = await executeDecisionTool(unsureProposal({ selfRoute: "critique" }), 0, h.deps);
	assert.match(text, /was not accepted \(invalidated: mode-manual/);
	assert.equal(resolveDecisionSettings(h.cwd, h.env).mode, "manual", "the project file now says manual");
	const entry = journaled(h);
	assert.equal(entry.status, "invalidated");
	assert.equal(entry.reason, "mode-manual: decisionMode is manual");
	assert.equal(entry.chosen, undefined, "a rejected decision journals no choice");
	assert.equal(entry.consultantTokens, "unknown", "the critic ran but reported no usage");
});

test("a cancelled deliberation journals the invalidation with the cancelled reason", async (t) => {
	const controller = new AbortController();
	const h = harness(t, { mode: "bounded-auto", duringResearch: () => controller.abort() });
	h.deps.signal = controller.signal;
	const text = await executeDecisionTool(proposal({ selfRoute: "research", unknowns: ["how the cache file is opened"] }), 0, h.deps);
	assert.match(text, /cancelled/);
	assert.equal(h.records()[0]?.status, "invalidated");
	const entry = journaled(h);
	assert.equal(entry.status, "invalidated");
	assert.equal(entry.reason, "cancelled");
	assert.equal(entry.consultantTokens, "unknown", "the researcher ran but reported no usage");
});

test("a refused call journals nothing", async (t) => {
	const h = harness(t, { mode: "manual" });
	await executeDecisionTool(proposal(), 0, h.deps);
	assert.deepEqual(h.ledger(), []);
});

// ── project mode switch through the layered settings API ────────────────────

test("the project decisionMode is writable through the settings API and layers over the global default", (t) => {
	const h = harness(t, { mode: "manual" });
	mutateSettingsLayer({ scope: "project", cwd: h.cwd, env: h.env, mutation: { op: "unset", path: ["decisionMode"] } });
	mutateSettingsLayer({ scope: "global", cwd: h.cwd, env: h.env, mutation: { op: "set", path: ["decisionMode"], value: "bounded-auto" } });
	assert.equal(resolveDecisionSettings(h.cwd, h.env).mode, "bounded-auto", "with no project key the global value is the default (owner revision, post-E7)");
	mutateSettingsLayer({ scope: "project", cwd: h.cwd, env: h.env, mutation: { op: "set", path: ["decisionMode"], value: "advisory" } });
	assert.equal(resolveDecisionSettings(h.cwd, h.env).mode, "advisory", "the project layer overrides the global default");
	mutateSettingsLayer({ scope: "project", cwd: h.cwd, env: h.env, mutation: { op: "unset", path: ["decisionMode"] } });
	assert.equal(resolveDecisionSettings(h.cwd, h.env).mode, "bounded-auto", "unsetting the project value falls back to the global default");
});

// ── activity feed and status line ───────────────────────────────────────────

function goalRecord(): GoalRecord {
	return { ...createGoal({ objective: OBJECTIVE, autoContinue: true, sisyphus: false }, Date.UTC(2026, 9, 27, 9, 0, 0)), id: GOAL };
}

function decisionEvent(overrides: Partial<Extract<GoalLedgerEvent, { type: "decision_recorded" }>> = {}): GoalLedgerEvent {
	return {
		type: "decision_recorded",
		goalId: GOAL,
		decisionId: "dec-0123456789ab",
		status: "decided",
		route: "direct",
		question: "Use WAL mode for the local cache?",
		authorityBasis: "The request asks for the migration.",
		routeWhy: "",
		requestHash: "a".repeat(16),
		chosen: "WAL",
		source: "agent",
		risks: [],
		consultantTokens: 0,
		at: "2026-10-27T09:01:00.000Z",
		...overrides,
	};
}

test("the activity feed shows each journal entry as one decision line", () => {
	const items = deriveGoalActivity([decisionEvent()], GOAL);
	assert.deepEqual(items, [{
		at: "2026-10-27T09:01:00.000Z",
		kind: "decision",
		marker: "done",
		text: "Decision dec-0123456789ab decided: “Use WAL mode for the local cache?” → WAL (agent).",
	}]);
});

test("the dashboard model derives the last decision and the status text shows it", () => {
	const goal = goalRecord();
	const events = [decisionEvent({ decisionId: "dec-111111111111", chosen: "rollback journal", source: "human", status: "decided" }), decisionEvent({ decisionId: "dec-222222222222", status: "invalidated", chosen: undefined, source: undefined, reason: "mode-manual: decisionMode is manual" })];
	const model = deriveGoalDashboardModel(goal, { focused: true, otherOpenGoals: 0, ledgerEvents: events });
	assert.deepEqual(model?.lastDecision, { decisionId: "dec-222222222222", status: "invalidated", route: "direct", reason: "mode-manual: decisionMode is manual" });

	const text = buildGoalStatusText({ goal, focused: true, otherOpenGoals: 0, ledgerEvents: events, width: 100 });
	assert.match(text, /Decision invalidated · direct — mode-manual: decisionMode is manual/);
});

test("the status line shows the chosen option and source of a decided entry", () => {
	const goal = goalRecord();
	const text = buildGoalStatusText({ goal, focused: true, otherOpenGoals: 0, ledgerEvents: [decisionEvent()], width: 100 });
	assert.match(text, /Decision decided · direct · WAL \(agent\)/);
});

test("without any journal entry the dashboard has no decision line (manual output unchanged)", () => {
	const goal = goalRecord();
	const model = deriveGoalDashboardModel(goal, { focused: true, otherOpenGoals: 0, ledgerEvents: [] });
	assert.equal(model?.lastDecision, undefined);
	const text = buildGoalStatusText({ goal, focused: true, otherOpenGoals: 0, ledgerEvents: [], width: 100 });
	assert.doesNotMatch(text, /Decision /);
});
