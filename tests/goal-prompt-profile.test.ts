import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("real SDK: prompt/profile repair preserves instructions, schemas, metadata and history", { timeout: 15000 }, async () => {
	const { NODE_TEST_CONTEXT: _dropped, ...env } = process.env;
	const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--test", fileURLToPath(new URL("./prompt-profile-sdk-worker.ts", import.meta.url))], { env, timeout: 10000 });
	assert.match(stdout, /(?:#|ℹ) fail 0/);
	assert.match(stdout, stdout.includes("profile-transcript-support=true") ? /(?:#|ℹ) pass 6/ : /(?:#|ℹ) skipped 6/);
});
