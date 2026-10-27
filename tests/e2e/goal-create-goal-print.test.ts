import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";

// The `pi -p` shape: a create_goal turn followed by the goal-x continuation turn, awaited by prompt().
test("real SDK: pi -p shape creates a goal, runs the continuation turn and prints its final text", {timeout: 30000}, async () => {
	const result = await runWorker([]);
	assert.equal(result.passed, true);
	assert.equal(result.goalCreated, true);
	assert.equal(result.lastAssistantText, "FINAL TEXT after the goal was created.");
	assert.deepEqual(result.errors, []);
	assert.ok(result.providerRequests >= 2, "the continuation turn reaches the provider before prompt() resolves");
});

// Pinned behavior: update_goal completion terminates the run, so pi -p prints no text after it.
test("real SDK: pi -p shape completes the goal in the continuation turn without a boundary error and prints no text", {timeout: 30000}, async () => {
	const result = await runWorker(["--complete"]);
	assert.equal(result.passed, true);
	assert.equal(result.goalCompleted, true);
	assert.equal(result.lastMessageRole, "custom");
	assert.equal(result.providerRequests, 2);
	assert.deepEqual(result.errors, []);
});

interface WorkerResult {
	passed: boolean;
	goalCreated?: boolean;
	goalCompleted?: boolean;
	lastAssistantText?: string;
	lastMessageRole?: string;
	providerRequests: number;
	errors: string[];
}

async function runWorker(args: string[]): Promise<WorkerResult> {
	// The worker is a root session: scrub NODE_TEST_CONTEXT (nested runner output) and any inherited
	// subagent markers, which would make the goal extension register as a delegated child.
	const {NODE_TEST_CONTEXT: _dropped, PI_SUBAGENT_CHILD: _child, PI_SUBAGENT_DEPTH: _depth, ...env} = process.env;
	const {stdout} = await promisify(execFile)(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../create-goal-print-sdk-worker.mjs", import.meta.url)), ...args], {env, timeout: 25000});
	return JSON.parse(stdout.trim().split("\n").at(-1)!);
}
