import test from "node:test";
import assert from "node:assert/strict";
import * as piAI from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { alignGoalPromptProfile, registerGoalPromptProfile } from "../extensions/goal-prompt-profile.ts";

const modern = typeof (piAI as unknown as { getCurrentSystemMessage?: unknown }).getCurrentSystemMessage === "function";
console.log(`profile-transcript-support=${modern}`);
const tool = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} } });

test("goal profile repair uses the current prompt from the first request and is request-local", { skip: !modern }, () => {
	const messages = [
		{ role: "system", content: "", sections: { preamble: "Host", tools: "Draft-only tools", rules: "Draft-only rules" }, toolsAdded: [tool("confirm_plan")], timestamp: 10 },
		{ role: "user", content: "Checkpoint", timestamp: 11 },
		{ role: "system", content: "", toolsAdded: [tool("finish_work")], toolsRemoved: [{ name: "confirm_plan" }], timestamp: 12 },
	];
	const before = structuredClone(messages);
	const fixed = alignGoalPromptProfile(messages, "Current execution prompt")!;
	assert.equal(fixed[0]!.content, "Current execution prompt");
	assert.deepEqual(fixed[0]!.toolsAdded, [tool("finish_work")]);
	assert.equal(fixed[1], messages[1]);
	assert.equal(fixed.length, 2);
	assert.deepEqual(messages, before, "persisted host history is not edited");
	assert.deepEqual(alignGoalPromptProfile(fixed, "Current execution prompt"), fixed, "same profile remains byte-stable");
});

test("profile repair supplies a head for fresh custom turns and keeps tool/result adjacency", { skip: !modern }, () => {
	const messages = [
		{ role: "user", content: "Checkpoint" },
		{ role: "system", content: "", toolsAdded: [tool("write")] },
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: {} }] },
		{ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "Saved" }] },
	];
	const fixed = alignGoalPromptProfile(messages, "Current host")!;
	assert.equal(fixed[0]!.role, "system");
	assert.deepEqual(fixed[0]!.toolsAdded, [tool("write")]);
	assert.equal(fixed.at(-2), messages[2]);
	assert.equal(fixed.at(-1), messages[3]);
	const withNote = [messages[0]!, { role: "system", content: "External note" }, ...messages.slice(1)];
	const withNoteFixed = alignGoalPromptProfile(withNote, "Current host")!;
	assert.equal(withNoteFixed[0]!.content, "Current host", "a later instruction is not a head override");
	assert.ok(withNoteFixed.some(message => message.content === "External note"));
});

test("profile repair preserves extra system instructions, custom sections and metadata", { skip: !modern }, () => {
	const extraContent = [{ type: "text", text: "Keep the external guard", cache_control: { type: "ephemeral" } }];
	const messages = [
		{ role: "system", content: "", sections: { tools: "Old host tools", external_guard: "External section" }, timestamp: 1 },
		{ role: "user", content: "Work" },
		{ role: "system", content: extraContent, timestamp: 2, externalMetadata: "retained" },
	];
	const fixed = alignGoalPromptProfile(messages, "Forced/custom current host prompt")!;
	assert.equal(fixed[0]!.content, "Forced/custom current host prompt");
	assert.deepEqual(fixed[0]!.sections, { external_guard: "External section" });
	assert.equal(fixed[2]!.content, extraContent);
	assert.equal(fixed[2]!.externalMetadata, "retained");
	assert.deepEqual(fixed, alignGoalPromptProfile(fixed, "Forced/custom current host prompt"));
});

test("profile repair respects an explicit head override and additive leading instructions", { skip: !modern }, () => {
	const override = [{ role: "system", content: [{ type: "text", text: "External override", cache_control: { type: "ephemeral" } }] }, { role: "user", content: "Work" }];
	assert.equal(alignGoalPromptProfile(override, "Host prompt")![0]!.content, override[0]!.content);
	const extra = [{ role: "system", content: "External instruction", sections: { preamble: "Stale SDK prompt" } }, { role: "user", content: "Work" }];
	assert.equal(alignGoalPromptProfile(extra, "Current SDK prompt")![0]!.content, "Current SDK prompt\n\nExternal instruction");
	const cached = [{ type: "text", text: "External instruction", cache_control: { type: "ephemeral" } }];
	const extraCached = [{ ...extra[0]!, content: cached }, extra[1]!];
	const fixedContent = alignGoalPromptProfile(extraCached, "Current SDK prompt")![0]!.content as unknown[];
	assert.equal(fixedContent[1], cached[0], "additive leading content keeps its cache marker");
});

for (const native of [false, true]) test(`profile integration ${native ? "keeps native custom-turn preparation" : "repairs the legacy custom-turn path"}`, { skip: !modern }, () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	registerGoalPromptProfile({ on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(event, handler); } } as unknown as ExtensionAPI, () => true);
	const ctx = { getSystemPrompt: () => "Current SDK prompt" } as ExtensionContext;
	if (native) handlers.get("before_agent_start")!({ messageType: "custom", message: { content: "Checkpoint" } }, ctx);
	const messages = [{ role: "system", content: "", sections: { rules: "Keep native sections" }, toolsAdded: [tool("write")] }, { role: "user", content: "Work" }];
	const before = structuredClone(messages);
	const result = handlers.get("context_with_system")!({ messages }, ctx) as { messages: { content: unknown }[] } | undefined;
	if (native) {
		assert.equal(result, undefined, "no projection or serialization changes on prepared hosts");
		assert.equal(handlers.get("context")!({ messages }, ctx), undefined);
	} else assert.equal(result?.messages[0]!.content, "Current SDK prompt");
	assert.deepEqual(messages, before);
});
