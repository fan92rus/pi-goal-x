/**
 * goal_decision tool (specs/2026-10-27-adaptive-decisions, TECH §4, E6.1): visibility gate,
 * lazy registration, and the execute outcomes (bounded-auto text, advisory dialog with the
 * recommendation prefilled, escalations, cancelled dialog). Consultants, the owner dialog, and the
 * abort signal are injected; no session, network, or real UI is used.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piGoalExtension from "../extensions/goal.ts";
import { GoalAccounting } from "../extensions/goal-accounting.ts";
import type { ConsultantModel, ConsultantRole, ConsultantRunResult, CriticPayload, ResearcherPayload, RunConsultantArgs } from "../extensions/goal-decision-consultant.ts";
import { getDecisions, type DecisionRecord } from "../extensions/goal-decision-record.ts";
import {
	ensureDecisionTool,
	executeDecisionTool,
	type ConsultantRunner,
	type DecisionGoalView,
	type DecisionToolDeps,
} from "../extensions/goal-decision.ts";
import { DIALOG_UNAVAILABLE_HINT, type GoalQuestionnaireResult } from "../extensions/goal-questionnaire.ts";
import { createGoal, goalFocusDetails, type GoalRecord, type GoalStateEntry } from "../extensions/goal-record.ts";
import type { GoalCore } from "../extensions/goal-state.ts";
import { goalPromptParts, DECISION_FORK_RULE } from "../extensions/prompts/goal-prompts.ts";
import { applicableGoalTools, DECISION_TOOL_NAME } from "../extensions/goal-tool-names.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { goalStorageContext } from "../extensions/storage/goal-root.ts";

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

function settingsFile(cwd: string): string {
	return path.join(cwd, ".pi", "pi-goal-x-settings.json");
}

function writeSettings(cwd: string, settings: Record<string, unknown>): void {
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	writeFileSync(settingsFile(cwd), JSON.stringify(settings));
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

function answered(text: string): GoalQuestionnaireResult {
	return { questions: [], answers: [{ id: "decision", question: "Use WAL mode for the local cache?", answer: text, wasCustom: false }], cancelled: false };
}

const CANCELLED: GoalQuestionnaireResult = { questions: [], answers: [], cancelled: true };
const UNAVAILABLE: GoalQuestionnaireResult = { questions: [], answers: [], cancelled: true, unavailable: true };

interface AskCall {
	question: string;
	options: string[];
	recommended: number;
	context: string;
}

interface Harness {
	cwd: string;
	env: NodeJS.ProcessEnv;
	goal: { current: DecisionGoalView };
	launches: ConsultantRole[];
	asked: AskCall[];
	deps: DecisionToolDeps;
	records(): DecisionRecord[];
}

interface HarnessOptions {
	mode: string;
	critic?: boolean;
	goal?: Partial<DecisionGoalView>;
	/** Runs before each launch that passes the budget gate; may change the settings file. */
	beforeLaunch?: (role: ConsultantRole) => void;
	answer?: GoalQuestionnaireResult | Error;
	signal?: AbortSignal;
}

function harness(t: test.TestContext, options: HarnessOptions): Harness {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-decision-tool-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeSettings(cwd, { decisionMode: options.mode, ...(options.critic === true ? CRITIC_SETTINGS : {}) });
	const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(cwd, "global-settings.json") } as NodeJS.ProcessEnv;
	const goal = {
		current: { id: GOAL, status: "active", objective: OBJECTIVE, generation: "gen-1", usage: { tokensUsed: 0 }, ...options.goal } as DecisionGoalView,
	};
	const launches: ConsultantRole[] = [];
	const asked: AskCall[] = [];
	const runner = (async (args: RunConsultantArgs<ConsultantRole>): Promise<AnyRunResult> => {
		if (args.beforeLaunch) {
			const gate = args.beforeLaunch();
			if (!gate.ok) return { ok: false, errorCode: "budget", message: gate.reason };
		}
		launches.push(args.role);
		options.beforeLaunch?.(args.role);
		return args.role === "researcher" ? { ok: true, payload: RESEARCH_OK } : { ok: true, payload: CRITIC_OK };
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
		signal: options.signal,
		accounting: new GoalAccounting(),
		ask: async (question, optionList, recommended, context) => {
			asked.push({ question, options: optionList, recommended, context });
			if (options.answer instanceof Error) throw options.answer;
			return options.answer ?? CANCELLED;
		},
	};
	return {
		cwd,
		env,
		goal,
		launches,
		asked,
		deps,
		records() {
			const listed = getDecisions({ cwd }, GOAL);
			if (!listed.ok) throw new Error(`${listed.error.code}: ${listed.error.message}`);
			return listed.value;
		},
	};
}

// ── visibility (applicableGoalTools) ────────────────────────────────────────

function goalRecord(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return { ...createGoal({ objective: OBJECTIVE, autoContinue: true, sisyphus: false }, Date.UTC(2026, 9, 27, 9, 0, 0)), ...overrides };
}

test("goal_decision is advertised only for an active goal while the router is enabled", () => {
	const active = goalRecord();
	assert.ok(applicableGoalTools(active, true, true).includes(DECISION_TOOL_NAME));
	assert.ok(!applicableGoalTools(active, true).includes(DECISION_TOOL_NAME), "manual (default) never advertises it");
	assert.ok(!applicableGoalTools(active, true, false).includes(DECISION_TOOL_NAME));
	assert.ok(!applicableGoalTools({ ...active, status: "paused" }, true, true).includes(DECISION_TOOL_NAME), "paused goal does not");
	assert.ok(!applicableGoalTools(null, true, true).includes(DECISION_TOOL_NAME), "no goal does not");
});

// ── lazy registration (ensureDecisionTool) ──────────────────────────────────

function coreFor(goal: GoalRecord | null): { core: GoalCore; registered: ToolDefinition[] } {
	const registered: ToolDefinition[] = [];
	const core = {
		pi: { registerTool: (definition: ToolDefinition) => { registered.push(definition); } },
		state: { goal },
	} as unknown as GoalCore;
	return { core, registered };
}

test("manual registers nothing, even with an active goal", (t) => {
	const h = harness(t, { mode: "manual" });
	const { core, registered } = coreFor(goalRecord());
	assert.equal(ensureDecisionTool(core, h.cwd, h.env), false);
	assert.deepEqual(registered.map((tool) => tool.name), []);
});

test("advisory registers nothing without an active goal, then registers goal_decision once", (t) => {
	const h = harness(t, { mode: "advisory" });
	const idle = coreFor(null);
	assert.equal(ensureDecisionTool(idle.core, h.cwd, h.env), true);
	assert.deepEqual(idle.registered.map((tool) => tool.name), [], "no goal ⇒ no registration");

	const active = coreFor(goalRecord());
	assert.equal(ensureDecisionTool(active.core, h.cwd, h.env), true);
	assert.equal(ensureDecisionTool(active.core, h.cwd, h.env), true);
	assert.deepEqual(active.registered.map((tool) => tool.name), [DECISION_TOOL_NAME], "tools cannot be unregistered: exactly one registration");
});

// ── executeDecisionTool outcomes ────────────────────────────────────────────

test("manual: nothing is consulted, asked, or recorded", async (t) => {
	const h = harness(t, { mode: "manual" });
	const text = await executeDecisionTool(proposal(), 0, h.deps);
	assert.match(text, /decisionMode is manual/);
	assert.deepEqual(h.records(), []);
	assert.deepEqual(h.launches, []);
	assert.deepEqual(h.asked, []);
});

test("a paused goal is refused before anything is written", async (t) => {
	const h = harness(t, { mode: "bounded-auto", goal: { status: "paused" } });
	const text = await executeDecisionTool(proposal(), 0, h.deps);
	assert.match(text, /applies to an active goal/);
	assert.deepEqual(h.records(), []);
});

test("an invalid proposal is refused and nothing is written", async (t) => {
	const h = harness(t, { mode: "bounded-auto" });
	const text = await executeDecisionTool(proposal({ question: "   " }), 0, h.deps);
	assert.match(text, /Invalid decision proposal/);
	assert.deepEqual(h.records(), []);
});

test("a recommended index outside the options is refused", async (t) => {
	const h = harness(t, { mode: "bounded-auto" });
	const text = await executeDecisionTool(proposal(), 2, h.deps);
	assert.match(text, /recommended must be the zero-based index of one of the 2 options/);
	assert.deepEqual(h.records(), []);
});

test("bounded-auto direct: the recommended option is decided by the agent with no consultant", async (t) => {
	const h = harness(t, { mode: "bounded-auto" });
	const text = await executeDecisionTool(proposal(), 0, h.deps);
	assert.match(text, /resolved by the agent \(route: direct, source: agent\)/);
	assert.match(text, /Chosen: WAL/);
	const [record] = h.records();
	assert.equal(record?.status, "decided");
	assert.equal(record?.outcome?.chosen, "WAL");
	assert.equal(record?.outcome?.source, "agent");
	assert.deepEqual(h.launches, []);
	assert.deepEqual(h.asked, []);
});

test("bounded-auto research+critique: consultants run, the recommended option is decided, and the critic's minor objection is a recorded risk", async (t) => {
	const h = harness(t, { mode: "bounded-auto", critic: true });
	const text = await executeDecisionTool(unsureProposal({ selfRoute: "research+critique", unknowns: ["how the cache file is opened"] }), 1, h.deps);
	assert.match(text, /resolved by the agent \(route: research\+critique, source: agent\)/);
	assert.match(text, /Chosen: rollback journal/);
	assert.match(text, /Risks: minor: WAL needs -shm files on network drives/);
	assert.deepEqual(h.launches, ["researcher", "critic"]);
	const [record] = h.records();
	assert.equal(record?.status, "decided");
	assert.equal(record?.consultants.length, 2);
	assert.equal(record?.outcome?.chosen, "rollback journal");
	assert.deepEqual(record?.outcome?.risks, ["minor: WAL needs -shm files on network drives"]);
});

test("bounded-auto: a forbidden category escalates to ask-human and launches nothing", async (t) => {
	const h = harness(t, { mode: "bounded-auto" });
	const text = await executeDecisionTool(proposal({ question: "Delete the old cache table?", options: ["keep it", "delete it"] }), 1, h.deps);
	assert.match(text, /escalated/);
	assert.match(text, /Ask the owner with goal_question/);
	assert.equal(h.records()[0]?.status, "escalated");
	assert.deepEqual(h.launches, []);
});

test("bounded-auto: an exhausted token budget refuses the first consultant and escalates with the budget line", async (t) => {
	const h = harness(t, { mode: "bounded-auto", critic: true, goal: { tokenBudget: 100, usage: { tokensUsed: 100 } } });
	const text = await executeDecisionTool(unsureProposal({ selfRoute: "research+critique", unknowns: ["how the cache file is opened"] }), 0, h.deps);
	assert.match(text, /escalated/);
	assert.match(text, /budget/i);
	assert.deepEqual(h.launches, [], "the gate refused the launch before any consultant ran");
	assert.equal(h.records()[0]?.status, "escalated");
});

test("bounded-auto: switching decisionMode to manual while the critic runs rejects the decision (fresh read at acceptance)", async (t) => {
	const h = harness(t, {
		mode: "bounded-auto",
		critic: true,
		beforeLaunch: () => writeSettings(h.cwd, { decisionMode: "manual", ...CRITIC_SETTINGS }),
	});
	const text = await executeDecisionTool(unsureProposal({ selfRoute: "critique" }), 0, h.deps);
	assert.match(text, /was not accepted \(invalidated: mode-manual/);
	assert.deepEqual(h.launches, ["critic"]);
	const [record] = h.records();
	assert.equal(record?.status, "invalidated");
	assert.equal(record?.outcome, undefined, "a rejected decision writes no outcome");
});

test("a cancelled signal stops a consulted route before anything is written", async (t) => {
	const controller = new AbortController();
	controller.abort();
	const h = harness(t, { mode: "bounded-auto", signal: controller.signal });
	const text = await executeDecisionTool(proposal({ selfRoute: "research", unknowns: ["how the cache file is opened"] }), 0, h.deps);
	assert.match(text, /cancelled/);
	assert.deepEqual(h.launches, []);
	assert.deepEqual(h.records(), []);
});

test("advisory direct: the dialog gets the recommendation prefilled and the owner's answer is recorded as human", async (t) => {
	const h = harness(t, { mode: "advisory", answer: answered("WAL") });
	const text = await executeDecisionTool(proposal(), 1, h.deps);
	assert.equal(h.asked.length, 1);
	assert.equal(h.asked[0]?.recommended, 1, "the recommended option is prefilled");
	assert.deepEqual(h.asked[0]?.options, ["WAL", "rollback journal"]);
	assert.match(h.asked[0]?.context ?? "", /Recommended: rollback journal/);
	assert.deepEqual(h.launches, [], "advisory with a direct route launches nothing");
	assert.match(text, /answered by the owner \(route: direct, source: human\)/);
	assert.match(text, /Chosen: WAL/);
	const [record] = h.records();
	assert.equal(record?.status, "decided");
	assert.equal(record?.outcome?.source, "human");
	assert.equal(record?.outcome?.chosen, "WAL");
});

test("advisory: a cancelled dialog escalates the record and keeps the no-answer meaning", async (t) => {
	const h = harness(t, { mode: "advisory", answer: CANCELLED });
	const text = await executeDecisionTool(proposal(), 0, h.deps);
	assert.equal(h.asked.length, 1);
	assert.match(text, /cancelled the question — treat it as no answer/);
	assert.match(text, /normal blocker ladder/);
	const [record] = h.records();
	assert.equal(record?.status, "escalated");
	assert.equal(record?.outcome, undefined, "no owner answer means no decision");
});

test("advisory: a host without a dialog escalates with the no-dialog instruction", async (t) => {
	const h = harness(t, { mode: "advisory", answer: UNAVAILABLE });
	const text = await executeDecisionTool(proposal(), 0, h.deps);
	assert.ok(text.includes(DIALOG_UNAVAILABLE_HINT));
	assert.match(text, /treat it as no answer/);
	assert.equal(h.records()[0]?.status, "escalated");
});

test("advisory: a failing dialog escalates instead of throwing", async (t) => {
	const h = harness(t, { mode: "advisory", answer: new Error("boom") });
	const text = await executeDecisionTool(proposal(), 0, h.deps);
	assert.match(text, /owner dialog failed \(boom\)/);
	assert.equal(h.records()[0]?.status, "escalated");
});

test("advisory research: the consultant runs first and the owner decides on the recorded findings", async (t) => {
	const h = harness(t, { mode: "advisory", answer: answered("rollback journal") });
	const text = await executeDecisionTool(proposal({ selfRoute: "research", unknowns: ["how the cache file is opened"] }), 1, h.deps);
	assert.deepEqual(h.launches, ["researcher"]);
	assert.equal(h.asked.length, 1);
	assert.match(text, /answered by the owner \(route: research, source: human\)/);
	const [record] = h.records();
	assert.equal(record?.status, "decided");
	assert.equal(record?.consultants.length, 1);
	assert.equal(record?.outcome?.chosen, "rollback journal");
});

test("advisory forbidden category: escalates without opening a dialog", async (t) => {
	const h = harness(t, { mode: "advisory", answer: answered("x") });
	const text = await executeDecisionTool(proposal({ question: "Store the API key in the cache?", options: ["yes", "no"] }), 0, h.deps);
	assert.equal(h.asked.length, 0);
	assert.match(text, /escalated/);
	assert.equal(h.records()[0]?.status, "escalated");
});

// ── end to end through the real lifecycle and the registered tool ───────────

function sessionFixture(cwd: string, mode: string, goalStatus: GoalRecord["status"] | null) {
	writeSettings(cwd, { decisionMode: mode });
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	const sessionEntries: unknown[] = [];
	if (goalStatus !== null) {
		const goal = { ...goalRecord(), status: goalStatus };
		const written = writeActiveGoalFile({ cwd } as never, goal);
		sessionEntries.push(
			{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") },
			{ type: "custom", customType: "pi-goal-state", data: { version: 3, goal: { ...goal, activePath: written.activePath } } as GoalStateEntry },
		);
	}
	return { cwd, sessionEntries };
}

function mockSession(cwd: string, entries: unknown[]) {
	const registeredTools: ToolDefinition[] = [];
	const lifecycleHandlers = new Map<string, (...args: unknown[]) => unknown>();
	let activeTools: string[] = ["read", "bash"];
	const pi = {
		registerTool: (definition: ToolDefinition) => { registeredTools.push(definition); },
		registerCommand: () => {},
		on: (event: string, handler: (...args: unknown[]) => unknown) => { lifecycleHandlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		hasUI: false,
	};
	piGoalExtension(pi as never);
	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: {
			getBranch: () => entries,
			getCwd: () => cwd,
			getSessionId: () => "test-session",
			getRoot: () => cwd,
			append: () => {},
			appendModelChange: () => {},
			appendThinkingLevelChange: () => {},
			appendCompetingWriteCheck: () => {},
			buildSessionContext: () => ({ messages: [], sessionId: "test", model: null, thinkingLevel: "medium" }),
		},
		getSystemPrompt: () => "",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	return {
		ctx,
		registeredTools,
		activeTools: () => activeTools,
		async startSession() {
			const start = lifecycleHandlers.get("session_start");
			assert.ok(start, "session_start handler must be registered");
			await start({ reason: "start" }, ctx);
		},
		/** The text the goal context hook injects into the next provider request. */
		async injectedContext(): Promise<string> {
			const inject = lifecycleHandlers.get("context_with_system");
			assert.ok(inject, "context_with_system handler must be registered");
			const result = await inject({ messages: [{ role: "user", content: "continue" }] }, ctx) as { messages?: unknown[] } | undefined;
			return JSON.stringify(result?.messages ?? []);
		},
		async getGoalVerbose(): Promise<string> {
			const tool = registeredTools.find((definition) => definition.name === "get_goal");
			assert.ok(tool, "get_goal must be registered");
			const result = await tool.execute("call-verbose", { verbose: true } as never, undefined, undefined, ctx as never);
			return (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
		},
	};
}

test("session: advisory with an active goal registers and advertises goal_decision; the registered tool escalates without a UI", async (t) => {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-decision-session-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const fixture = sessionFixture(cwd, "advisory", "active");
	const session = mockSession(cwd, fixture.sessionEntries);
	await session.startSession();
	assert.ok(session.registeredTools.some((tool) => tool.name === DECISION_TOOL_NAME), "registered");
	assert.ok(session.activeTools().includes(DECISION_TOOL_NAME), "advertised for the active goal");

	const tool = session.registeredTools.find((definition) => definition.name === DECISION_TOOL_NAME);
	assert.ok(tool);
	const result = await tool.execute("call-1", { question: "Use WAL mode?", options: ["WAL", "rollback journal"], recommended: 0, selfRoute: "direct", authorityBasis: "The request asks for the migration.", facts: [], unknowns: [], materialRisk: false } as never, undefined, undefined, session.ctx as never);
	const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
	assert.match(text, /treat it as no answer/, "no UI means the cancelled-dialog meaning");
	const listed = getDecisions(goalStorageContext(session.ctx), (fixture.sessionEntries[1] as { data: { goal: { id: string } } }).data.goal.id);
	assert.ok(listed.ok);
	if (listed.ok) assert.equal(listed.value[0]?.status, "escalated");
});

test("session: manual with an active goal registers nothing and advertises nothing", async (t) => {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-decision-manual-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const session = mockSession(cwd, sessionFixture(cwd, "manual", "active").sessionEntries);
	await session.startSession();
	assert.deepEqual(session.registeredTools.filter((tool) => tool.name === DECISION_TOOL_NAME), []);
	assert.equal(session.activeTools().includes(DECISION_TOOL_NAME), false);
});

test("session: advisory with a paused goal registers nothing", async (t) => {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-decision-paused-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const session = mockSession(cwd, sessionFixture(cwd, "advisory", "paused").sessionEntries);
	await session.startSession();
	assert.deepEqual(session.registeredTools.filter((tool) => tool.name === DECISION_TOOL_NAME), []);
	assert.equal(session.activeTools().includes(DECISION_TOOL_NAME), false);
});

// ── prompt and tool-description routing (E6.2) ──────────────────────────────

test("the fork rule is one inserted lifecycle line: every other prompt line is byte-identical", () => {
	const goal = goalRecord();
	const off = goalPromptParts(goal, {}).state;
	const on = goalPromptParts(goal, {}, undefined, true).state;
	assert.equal(off.includes("goal_decision"), false, "manual (default) prompt never names the tool");
	assert.equal(on.split("\n").filter((line) => line !== `- ${DECISION_FORK_RULE}`).join("\n"), off);
	assert.equal(on.split("\n").length, off.split("\n").length + 1);
	assert.match(on, /A blocker IS a question/, "the blocker rule stays");
});

test("the routed and manual prompts do not leak into each other through the fragment cache", () => {
	const goal = goalRecord();
	assert.equal(goalPromptParts(goal, {}, undefined, true).state.includes(DECISION_FORK_RULE), true);
	assert.equal(goalPromptParts(goal, {}).state.includes(DECISION_FORK_RULE), false);
	assert.equal(goalPromptParts(goal, {}, undefined, true).state.includes(DECISION_FORK_RULE), true);
});

test("session: advisory routes forks through goal_decision in the injected prompt and in get_goal", async (t) => {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-decision-prompt-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const session = mockSession(cwd, sessionFixture(cwd, "advisory", "active").sessionEntries);
	await session.startSession();
	assert.ok((await session.injectedContext()).includes(DECISION_FORK_RULE), "injected prompt routes forks");
	assert.ok((await session.getGoalVerbose()).includes(DECISION_FORK_RULE), "get_goal routes forks");
});

test("session: manual injects no routing text and get_goal keeps today's lifecycle line", async (t) => {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-decision-prompt-manual-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const session = mockSession(cwd, sessionFixture(cwd, "manual", "active").sessionEntries);
	await session.startSession();
	assert.equal((await session.injectedContext()).includes("goal_decision"), false);
	const verbose = await session.getGoalVerbose();
	assert.equal(verbose.includes("goal_decision"), false);
	assert.match(verbose, /A blocker is expressed as a question: when a point cannot be decided alone, ask via goal_question when a UI is available — the ask IS the block\. .*User commands handle pause\/resume\/clear\/focus\.$/s);
});

test("session: a paused goal under advisory keeps the blocked-path prompt with no routing text", async (t) => {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-decision-prompt-paused-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const session = mockSession(cwd, sessionFixture(cwd, "advisory", "paused").sessionEntries);
	await session.startSession();
	const injected = await session.injectedContext();
	assert.match(injected, /\[PI GOAL PAUSED/);
	assert.equal(injected.includes(DECISION_FORK_RULE), false);
	assert.equal((await session.getGoalVerbose()).includes(DECISION_FORK_RULE), false);
});

test("session: the advertised goal_decision describes fork routing and never blockers", async (t) => {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-decision-description-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const session = mockSession(cwd, sessionFixture(cwd, "advisory", "active").sessionEntries);
	await session.startSession();
	const tool = session.registeredTools.find((definition) => definition.name === DECISION_TOOL_NAME) as (ToolDefinition & { promptGuidelines?: string[] }) | undefined;
	assert.ok(tool, "goal_decision registered");
	assert.match(tool.description, /Not for blockers or objective changes: those still go through goal_question\./);
	assert.match(tool.promptGuidelines?.[0] ?? "", /never for a blocker.*goal_question/);
});
