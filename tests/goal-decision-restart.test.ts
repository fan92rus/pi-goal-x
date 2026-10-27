/**
 * Restart through the real session_start hook (specs/2026-10-27-adaptive-decisions,
 * TECH §6, E5.2): a decision still open when a session starts lost its consultants
 * with the previous session, so it is invalidated. Nothing is relaunched.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { createDecision, getDecisions, type DecisionDraft } from "../extensions/goal-decision-record.ts";
import { readGoalLedger } from "../extensions/goal-ledger.ts";
import { parseGoalFile } from "../extensions/storage/goal-files.ts";
import { goalStorageContext } from "../extensions/storage/goal-root.ts";

function createHarness(cwd: string) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const pi = {
		registerTool: () => {},
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendUserMessage: () => {},
		sendMessage: () => {},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		hasUI: false,
	};
	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: {
			getBranch: () => [] as unknown[],
			getCwd: () => cwd,
			getSessionId: () => "decision-restart-session",
			getRoot: () => cwd,
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			confirm: async () => false,
			custom: async () => undefined,
		},
		getSystemPrompt: () => "base",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, {});
	return { handlers, commands, ctx };
}

const DRAFT: DecisionDraft = {
	objective: "Create hello.txt",
	policyVersion: "policy-1",
	question: "Write the file as plain text?",
	options: ["plain text", "markdown"],
	route: "research",
	routeJustification: { skipped: [], reasons: {} },
	authorityBasis: "The request asks for hello.txt.",
	facts: [],
	unknowns: ["expected encoding"],
	consultants: [],
	generation: "gen-1",
};

test("session start invalidates a decision left open by the previous session, journals it as restarted, and relaunches nothing", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-decision-restart-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("goal-direct")!.handler("Create hello.txt", h.ctx);
		const goalFile = readdirSync(path.join(cwd, ".pi", "goals")).find((name) => name.startsWith("active_goal_"));
		const goalId = goalFile ? parseGoalFile(path.join(cwd, ".pi", "goals", goalFile))?.id : undefined;
		assert.ok(goalId, "the direct command created an active goal");

		const storage = goalStorageContext(h.ctx);
		const created = createDecision(storage, goalId, DRAFT);
		assert.equal(created.ok, true);
		if (!created.ok) return;

		await h.handlers.get("session_start")?.({ reason: "resume" }, h.ctx);

		const listed = getDecisions(storage, goalId);
		assert.equal(listed.ok, true);
		if (listed.ok) {
			assert.deepEqual(listed.value.map((record) => [record.id, record.status, record.consultants.length]), [[created.value.id, "invalidated", 0]]);
		}
		const journal = readGoalLedger(storage).events.filter((event) => event.type === "decision_recorded");
		assert.deepEqual(journal.map((event) => event.type === "decision_recorded" ? [event.decisionId, event.status, event.reason] : []), [[created.value.id, "invalidated", "restarted"]]);
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});
