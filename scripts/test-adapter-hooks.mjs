import * as nodeModule from "node:module";

if (typeof nodeModule.registerHooks !== "function") {
	throw new Error("Fast tests require Node 22.15+; use npm run test:serial with older Node versions.");
}

const adapters = new Map([
	["@earendil-works/pi-ai", new URL("../tests/stubs/pi-ai.ts", import.meta.url).href],
	["@earendil-works/pi-coding-agent", new URL("../tests/stubs/pi-coding-agent.ts", import.meta.url).href],
	["@earendil-works/pi-tui", new URL("../tests/stubs/pi-tui.ts", import.meta.url).href],
]);

// Deterministic UI language for tests: settings-row explanations are
// locale-aware (PI_GOAL_LANG → LANG → Intl), pin English regardless of host.
process.env.PI_GOAL_LANG = process.env.PI_GOAL_LANG ?? "en";

nodeModule.registerHooks({
	resolve(specifier, context, nextResolve) {
		const url = adapters.get(specifier);
		return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
	},
});
