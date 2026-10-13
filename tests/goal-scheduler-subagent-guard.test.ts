import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import type { GoalCore } from "../extensions/goal-state.ts";
import { goalFocusDetails } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { invalidateGoalSettingsCache } from "../extensions/goal-settings.ts";
import { SUBAGENT_DEFER_FUSE_MS, SUBAGENT_DEFER_RECHECK_MS } from "../extensions/goal-scheduler.ts";

interface Fixture {
	cwd: string;
	ctx: ExtensionContext;
	core: GoalCore;
	sent: any[];
	notifications: string[];
	subagentActive: { value: number };
	pi: any;
	respond: boolean;
	queueCalls(): number;
	listenerCount(event: string): number;
	begin(): void;
	settled(): void;
}

async function fixture(t: TestContext, strict: boolean): Promise<Fixture> {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-subagent-guard-"));
	const prior = process.env.PI_GOAL_GLOBAL_SETTINGS_FILE;
	process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = path.join(cwd, "absent-global.json");
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ strictExecutionContract: strict, maxAutonomousRuns: 50 }));
	invalidateGoalSettingsCache();
	const handlers: Record<string, Function> = {};
	const tools = new Map<string, any>();
	const sent: any[] = [];
	const notifications: string[] = [];
	const listeners = new Map<string, Set<Function>>();
	const subagentActive = { value: 0 };
	let respond = true;
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {},
		on: (event: string, handler: Function) => { handlers[event] = handler; },
		getActiveTools: () => ["read", "write", "bash"], setActiveTools: () => {}, appendEntry: () => {}, registerMessageRenderer: () => {},
		sendMessage: (message: unknown) => { sent.push(message); },
		events: {
			on: (name: string, fn: Function) => {
				const set = listeners.get(name) ?? new Set<Function>(); set.add(fn); listeners.set(name, set);
				return () => { set.delete(fn); if (set.size === 0) listeners.delete(name); };
			},
			emit: (name: string, event: unknown) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(event); },
		},
	};
	// Fake pi-subagents RPC responder: authoritative active-run count.
	pi.events.on("subagents:rpc:v1:request", (raw: any) => {
		if (!respond || typeof raw?.requestId !== "string") return;
		pi.events.emit(`subagents:rpc:v1:reply:${raw.requestId}`, {
			version: 1, requestId: raw.requestId, success: true,
			data: { fleet: { version: 1, entries: [], totalActive: subagentActive.value, omitted: 0 } },
		});
	});
	const goalSeed = { objective: "Seed", autoContinue: true, sisyphus: false } as any;
	goalSeed.id = "subagent-guard-fixture";
	writeActiveGoalFile({ cwd } as any, goalSeed);
	const ctx = {
		cwd, hasUI: false, isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
		getSystemPrompt: () => "base",
		sessionManager: { getSessionId: () => "owner", getCwd: () => cwd, getRoot: () => cwd, getBranch: () => [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goalSeed.id, "created") }] },
		ui: { notify: (message: string) => notifications.push(message), setStatus: () => {}, setWidget: () => {} },
	} as unknown as ExtensionContext;
	goalExtension(pi as any);
	const core = (pi as any)._goalCore as GoalCore;
	await core.loadState(ctx);
	let queueCalls = 0;
	const runtime = core.runtime as any;
	const originalQueueContinuation = runtime.queueContinuation.bind(runtime);
	runtime.queueContinuation = (...args: unknown[]) => { queueCalls++; return originalQueueContinuation(...args); };
	core.scheduler.attach(ctx);
	pi.events.emit("subagents:rpc:v1:ready", {}); // pi-subagents present → guard armed
	t.after(() => {
		core.scheduler.shutdown(); core.runtime.clearContinuationState();
		rmSync(cwd, { recursive: true, force: true });
		if (prior === undefined) delete process.env.PI_GOAL_GLOBAL_SETTINGS_FILE; else process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = prior;
		invalidateGoalSettingsCache();
	});
	return {
		cwd, ctx, core, sent, notifications, subagentActive, pi, get respond() { return respond; }, set respond(v: boolean) { respond = v; },
		queueCalls: () => queueCalls,
		listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
		begin: () => core.scheduler.begin(ctx),
		settled: () => core.scheduler.settled(ctx),
	};
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const advance = async (t: TestContext, ms: number) => {
	await flush();
	let left = ms;
	while (left > 0) {
		const step = Math.min(left, 30_000);
		t.mock.timers.tick(step);
		left -= step;
		await flush();
	}
	// Trailing delivery timers (0–50ms) armed by the last flushed chain.
	for (let i = 0; i < 3; i++) { t.mock.timers.tick(100); await flush(); }
};

const kickoff = (h: Fixture) => h.core.replaceGoal({ objective: "Work automatically", autoContinue: true, sisyphus: false }, h.ctx);

test("attach replaces all subagent and goal-wake listeners instead of accumulating them", async t => {
	const h = await fixture(t, false);
	const events = ["pi-goal:wake", "subagent:async-complete", "subagents:rpc:v1:ready"];
	const before = events.map(event => h.listenerCount(event));
	h.core.scheduler.attach(h.ctx);
	h.core.scheduler.attach(h.ctx);
	assert.deepEqual(events.map(event => h.listenerCount(event)), before);
});

test("ready continuation is deferred while a subagent runs, delivered on completion", async t => {
	const h = await fixture(t, false);
	h.subagentActive.value = 2;
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	kickoff(h);
	assert.equal(h.queueCalls(), 0, "must not arm a continuation while the async activity probe is unresolved");
	await advance(t, 50);
	assert.equal(h.queueCalls(), 0, "must not queue while subagents are alive");
	assert.equal(h.sent.length, 0, "deferred while subagents are alive");
	assert.equal(h.core.state.goal?.status, "active", "deferral is silent — no pause");
	await advance(t, SUBAGENT_DEFER_RECHECK_MS);
	assert.equal(h.sent.length, 0, "recheck with the subagent still alive keeps deferring");
	h.subagentActive.value = 0;
	h.pi.events.emit("subagent:async-complete", { runId: "r1" });
	await advance(t, 50);
	assert.equal(h.sent.length, 1, "delivered right after the subagent completes");
});

test("fuse forces delivery even when the subagent never finishes", async t => {
	const h = await fixture(t, false);
	h.subagentActive.value = 2;
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	kickoff(h);
	await advance(t, 50);
	assert.equal(h.sent.length, 0);
	await advance(t, SUBAGENT_DEFER_FUSE_MS + SUBAGENT_DEFER_RECHECK_MS + 50);
	assert.equal(h.sent.length, 1, "fuse expired → delivered despite the still-active subagent");
});

test("absent pi-subagents fails open and is cached (no per-turn probe windows)", async t => {
	const h = await fixture(t, false);
	h.respond = false; // no RPC reply at all
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	kickoff(h);
	await advance(t, 400); // probe window 250ms → unavailable → deliver
	assert.equal(h.sent.length, 1, "fail-open delivery");
	// Second delivery round must not wait another probe window.
	h.begin();
	h.settled();
	await advance(t, 1);
	assert.equal(h.sent.length, 2, "cached verdict delivers immediately");
});

test("waiting-phase checks are not deferred by the guard", async t => {
	const h = await fixture(t, true);
	h.subagentActive.value = 2;
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	kickoff(h);
	await advance(t, 50);
	assert.equal(h.sent.length, 0, "kickoff is ready-phase → deferred");
	h.subagentActive.value = 0;
	h.pi.events.emit("subagent:async-complete", { runId: "r0" });
	await advance(t, 50);
	assert.equal(h.sent.length, 1, "kickoff delivered after completion");
	const r = h.core.scheduler.declare(h.ctx, {
		kind: "wait", reason: "Await fixture job", deadline: new Date(Date.now() + 60_000).toISOString(),
		polling: { interval_seconds: 1, max_checks: 2 },
	});
	assert.equal(r.terminate, true, "wait declared");
	h.settled(); // turn ends → scheduler arms the polling check
	h.subagentActive.value = 5; // unrelated subagents alive during the wait
	await advance(t, 1_000 + 400);
	assert.equal(h.sent.length, 2, "polling check delivered despite active subagents (guard skips waiting phase)");
});
