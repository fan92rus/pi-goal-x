import { randomUUID } from "node:crypto";

/**
 * Layer-2 guard probe (2026-10-13): "is an async subagent running?" for the
 * goal continuation guard. Talks to the pi-subagents in-process event-bus RPC
 * (docs/extension-api.md: `subagents:rpc:v1:request` method `status`,
 * reply `data.fleet.totalActive`). pi-subagents' request handler is async, so
 * the probe waits a short window for the reply; no reply (pi-subagents absent)
 * → `available: false` and callers fail open (deliver as before).
 */
export interface SubagentProbeEvents {
	on(event: string, handler: (payload: unknown) => void): unknown;
	emit(event: string, payload: unknown): unknown;
}

export interface SubagentProbeResult {
	/** false = pi-subagents is absent or the RPC did not answer in the window. */
	available: boolean;
	/** Active async run count (authoritative when available). */
	active: number;
}

export const SUBAGENT_PROBE_WINDOW_MS = 250;

export async function probeSubagentActivity(
	events: SubagentProbeEvents | undefined,
	windowMs: number = SUBAGENT_PROBE_WINDOW_MS,
): Promise<SubagentProbeResult> {
	if (!events?.on || !events?.emit) return { available: false, active: 0 };
	const requestId = randomUUID();
	const replyEvent = `subagents:rpc:v1:reply:${requestId}`;
	let reply: unknown;
	let done = false;
	const off = events.on(replyEvent, (payload: unknown) => {
		reply = payload;
		done = true;
	});
	try {
		events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "status", params: {} });
		if (!done) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => resolve(), windowMs);
				if (done) { clearTimeout(timer); resolve(); }
			});
		}
	} finally {
		(typeof off === "function") && off();
	}
	if (!done) return { available: false, active: 0 };
	const rec = reply as { success?: boolean; data?: { fleet?: { totalActive?: number } } } | undefined;
	if (!rec || rec.success !== true) return { available: false, active: 0 };
	const total = rec.data?.fleet?.totalActive;
	return { available: true, active: typeof total === "number" ? total : 0 };
}
