import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTaskProgress } from "../extensions/goal-tool-inputs.ts";

const update = {task_id: "child", status: "complete", evidence: "verified"};

test("matching redundant batch fields and empty optional fields preserve ordered updates", () => {
	const input = {...update, reason: " ", updates: [update, {task_id: "parent", status: "complete"}]};
	const before = structuredClone(input);
	assert.deepEqual(normalizeTaskProgress(input), {ok: true, batch: true, updates: input.updates});
	assert.deepEqual(input, before, "normalization leaves the received arguments untouched");
	assert.deepEqual(normalizeTaskProgress({task_id: "", status: "", reason: "", updates: [update]}), {ok: true, batch: true, updates: [update]});
});

test("every meaningful root field must repeat the same batch entry", () => {
	for (const fields of [{task_id: "other"}, {status: "start"}, {evidence: "different"}, {reason: "skip this"}]) {
		assert.equal(normalizeTaskProgress({...fields, updates: [update]}).ok, false);
	}
	assert.equal(normalizeTaskProgress({task_id: "child", status: "start", updates: [update, {task_id: "other", status: "start"}]}).ok, false);
});

test("empty batches accompany valid single-task inputs only", () => {
	assert.deepEqual(normalizeTaskProgress({...update, updates: []}), {ok: true, batch: false, updates: [update]});
	for (const input of [{updates: []}, {task_id: " ", status: "start", updates: []}, {task_id: "child", status: "", updates: []}]) assert.equal(normalizeTaskProgress(input).ok, false);
});

test("malformed batches never fall back to valid single-task fields", () => {
	for (const updates of [null, {}, "bad", [null], [3], [update, {task_id: "other", status: "bogus"}], [{...update, evidence: 2}], [{...update, unexpected: true}], Array(101).fill(update)]) {
		assert.equal(normalizeTaskProgress({...update, updates}).ok, false, JSON.stringify(updates));
	}
});

test("identifiers retain their meaning while whitespace is normalized", () => {
	assert.deepEqual(normalizeTaskProgress({task_id: " - ", status: "start", evidence: " "}), {ok: true, batch: false, updates: [{task_id: "-", status: "start"}]});
	for (const input of [undefined, null, [], {...update, reason: 3}, {...update, status: "bogus"}]) assert.equal(normalizeTaskProgress(input).ok, false);
});
