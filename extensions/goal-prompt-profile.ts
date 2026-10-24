import * as piAI from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Message = { role: string; content?: unknown; sections?: Record<string, string | null>; [key: string]: unknown };
type SystemState = Message & { toolsAdded?: unknown[] };
const transcript = piAI as unknown as {
	getCurrentSystemMessage?: (messages: readonly Message[]) => SystemState | undefined;
};
const hostSections = new Set(["preamble", "tools", "rules", "docs", "addendum", "project_context", "skills", "cwd"]);
const messageText = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content)
	? content.map(part => typeof part?.text === "string" ? part.text : "").join("") : "";

/**
 * Pi 1.0's custom-trigger path skips prompt preparation until the first tool
 * response. Project the current public host prompt and transcript tool state at
 * its documented full-context boundary; never change persisted host history.
 */
export function alignGoalPromptProfile(messages: readonly Message[], prompt: string): Message[] | undefined {
	if (!transcript.getCurrentSystemMessage || !prompt) return;
	const current = transcript.getCurrentSystemMessage(messages);
	const firstSystem = messages[0]?.role === "system" ? messages[0] : undefined;
	const firstText = messageText(firstSystem?.content);
	// A content-only head can be an explicit override from another full-context
	// handler. Respect it. Extra content alongside SDK sections is additive.
	const content = firstText && !firstSystem?.sections ? firstSystem!.content
		: firstText && !prompt.includes(firstText)
			? Array.isArray(firstSystem?.content) ? [{ type: "text", text: `${prompt}\n\n` }, ...firstSystem.content] : `${prompt}\n\n${firstText}`
			: prompt;
	const extraSections = Object.fromEntries(Object.entries(current?.sections ?? {}).filter(([name, value]) =>
		!hostSections.has(name) && typeof value === "string" && !prompt.includes(value)));
	const head: Message = {
		...firstSystem, role: "system", content, timestamp: firstSystem?.timestamp ?? 0,
		sections: Object.keys(extraSections).length ? extraSections : undefined,
		toolsAdded: current?.toolsAdded, toolsRemoved: undefined,
	};
	const output = [head];
	for (const message of messages) {
		if (message.role !== "system") { output.push(message); continue; }
		if (message === firstSystem) continue;
		// Additional instructions from other extensions stay at their original
		// history boundary. Only host prompt/tool deltas have been replayed.
		const text = messageText(message.content);
		if (text && !prompt.includes(text)) output.push({ ...message, sections: undefined, toolsAdded: undefined, toolsRemoved: undefined });
	}
	return output;
}

export function registerGoalPromptProfile(
	pi: ExtensionAPI,
	isGoalContinuation: (ctx: ExtensionContext) => boolean,
): void {
	// Classic hosts have no transcript helpers. Structured hosts before the
	// full-context event expose system messages through the ordinary hook.
	if (!transcript.getCurrentSystemMessage) return;
	let hostPreparesCustomTurns = false;
	pi.on("before_agent_start", event => {
		// Pi 1.2 introduced this public protocol together with native custom-
		// turn preparation. Keep its structured prompt/tool deltas untouched.
		const kind = (event as unknown as { messageType?: string }).messageType;
		if (kind === "user" || kind === "custom") hostPreparesCustomTurns = true;
	});
	type FullContextOn = (event: "context_with_system", handler: (event: { messages: Message[] }, ctx: ExtensionContext) => unknown) => unknown;
	(pi.on as unknown as FullContextOn)("context_with_system", (event, ctx) => {
		if (hostPreparesCustomTurns || !isGoalContinuation(ctx)) return;
		const messages = alignGoalPromptProfile(event.messages, ctx.getSystemPrompt());
		return messages ? { messages } : undefined;
	});
	pi.on("context", (event, ctx) => {
		if (hostPreparesCustomTurns) return;
		// Modern hosts strip system messages from this event and restore them
		// before context_with_system; let that public boundary own the repair.
		const full = event.messages as unknown as Message[];
		if (!full.some(message => message.role === "system") || !isGoalContinuation(ctx)) return;
		const messages = alignGoalPromptProfile(full, ctx.getSystemPrompt());
		return messages ? { messages: messages as unknown as typeof event.messages } : undefined;
	});
}
