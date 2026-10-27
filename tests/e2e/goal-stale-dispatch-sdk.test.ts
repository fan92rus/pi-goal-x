import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";

for (const handoff of [false, true]) test(`real SDK: rejected dispatches preserve replacement completion${handoff ? " after mid-run creation" : ""}`, {timeout: 30000}, async () => {
	// The worker is a root session: scrub NODE_TEST_CONTEXT (nested runner output) and any inherited
	// subagent markers, which would make the goal extension register as a delegated child.
	const {NODE_TEST_CONTEXT: _dropped, PI_SUBAGENT_CHILD: _child, PI_SUBAGENT_DEPTH: _depth, ...env} = process.env;
	const {stdout} = await promisify(execFile)(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../stale-dispatch-sdk-worker.mjs", import.meta.url)), ...(handoff ? ["--handoff"] : [])], {env, timeout: 25000});
	const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
	assert.equal(result.passed, true);
	assert.equal(result.rejected, handoff ? 1 : 4);
	assert.equal(result.providerRequests, handoff ? 3 : 2);
});
