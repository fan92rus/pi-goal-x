import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";

test("real SDK: optional and redundant tool fields normalize without weakening batch validation", {timeout: 15000}, async () => {
	const {NODE_TEST_CONTEXT: _dropped, ...env} = process.env;
	const {stdout} = await promisify(execFile)(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../tool-input-sdk-worker.mjs", import.meta.url))], {env, timeout: 12000});
	const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
	assert.equal(result.passed, true);
	assert.equal(result.cases, 12);
});
