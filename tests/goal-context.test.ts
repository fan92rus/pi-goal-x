import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerGoalContext } from "../extensions/goal-context.ts";
import { filterGoalSessionContext } from "../extensions/goal-session-safety.ts";

test("one full-transcript transform per request, including the first and a new session", async () => {
	const handlers = new Map<string, Function>();
	let count = 0;
	registerGoalContext({ on: (name: string, handler: Function) => handlers.set(name, handler) } as unknown as ExtensionAPI,
		messages => { count++; return [...messages, {role: "user", content: "goal state"}]; });
	assert.equal(handlers.size, 1);
	assert.equal(handlers.has("context"), false);
	const handler = handlers.get("context_with_system")!;
	for (const session of ["first", "first", "replacement"]) {
		const messages = [{role: "user", content: session}];
		const result = await handler({messages}, {} as ExtensionContext);
		assert.equal(result.messages[0], messages[0]);
		assert.equal(result.messages.length, 2);
	}
	assert.equal(count, 3);
});

for (const child of [false, true]) test(`full transcript filtering preserves system deltas and tool pairs (${child ? "child" : "parent"})`, () => {
	let handler: Function;
	registerGoalContext({on: (_: string, fn: Function) => {handler = fn;}} as unknown as ExtensionAPI,
		messages => filterGoalSessionContext(messages, child));
	const head = {role: "system", content: "stable prompt", toolsAdded: [{name: "read"}]};
	const delta = {role: "system", content: "", sections: {fixture: "updated"}, toolsRemoved: [{name: "read"}]};
	const call = {role: "assistant", content: [{type: "toolCall", id: "call", name: "read", arguments: {path: "sample"}}]};
	const result = {role: "toolResult", toolCallId: "call", content: [{type: "text", text: "sample"}]};
	const audit = {role: "custom", customType: "pi-goal-audit-event", content: "display only"};
	const checkpoint = {role: "custom", customType: "pi-goal-event", content: "checkpoint", details: {goalId: "g", kind: "checkpoint"}};
	const output = handler!({messages: [head, call, audit, result, delta, checkpoint]}, {} as ExtensionContext).messages;
	assert.deepEqual(output, [head, call, result, delta, ...(!child ? [checkpoint] : [])]);
	assert.equal(output[0], head);
	assert.equal(output[3], delta);
});

test("unchanged full transcript is left to Pi", () => {
	let handler: Function;
	registerGoalContext({on: (_: string, fn: Function) => {handler = fn;}} as unknown as ExtensionAPI,
		messages => filterGoalSessionContext(messages));
	assert.equal(handler!({messages: [{role: "system", content: "prompt"}]}, {} as ExtensionContext), undefined);
});
