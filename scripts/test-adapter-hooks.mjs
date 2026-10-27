import * as nodeModule from "node:module";

if (typeof nodeModule.registerHooks !== "function") {
	throw new Error("Tests require Node 22.19 or newer.");
}

const adapters = new Map([
	["@earendil-works/pi-ai", new URL("../tests/stubs/pi-ai.ts", import.meta.url).href],
	["@earendil-works/pi-coding-agent", new URL("../tests/stubs/pi-coding-agent.ts", import.meta.url).href],
	["@earendil-works/pi-tui", new URL("../tests/stubs/pi-tui.ts", import.meta.url).href],
]);

// Deterministic UI language for tests: settings-row explanations are
// locale-aware (PI_GOAL_LANG → LANG → Intl), pin English regardless of host.
process.env.PI_GOAL_LANG = process.env.PI_GOAL_LANG ?? "en";

// Tests must not observe the delegation state of the process that launched
// them (e.g. an orchestrator running `npm test` from inside a pi subagent):
// isDelegatedGoalSession() would hide the goal commands and fail ~300 tests.
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_SUBAGENT_DEPTH;

nodeModule.registerHooks({
	resolve(specifier, context, nextResolve) {
		const url = adapters.get(specifier);
		return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
	},
});
