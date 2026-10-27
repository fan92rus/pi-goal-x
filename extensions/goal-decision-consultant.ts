/**
 * Read-only decision consultants (specs/2026-10-27-adaptive-decisions, TECH §5, E4.1).
 *
 * `runConsultant` is generalized from `runBlockerOracle` (goal-oracle.ts; the
 * oracle itself is unchanged). One consultation is one fresh, isolated, in-memory
 * agent session:
 *
 *   - tools are exactly read/grep/find/ls plus one role-specific submit tool;
 *     no write/edit/bash and no nested delegation tool is ever exposed;
 *   - the result is a payload that passed the role schema at submit time, or an
 *     errorCode. There is no prose path;
 *   - the deadline timer and the AbortSignal both cancel the child
 *     (session.abort()) and return `aborted`. The runner never waits on a child
 *     that ignores cancellation: the prompt is raced against cancellation;
 *   - the caller minimizes the prompt, resolves the model, and supplies the
 *     budget gate (`beforeLaunch`). This module reads no settings and writes no
 *     decision record (E4.2 owns the record write, E5 the accounting).
 *
 * Registers no tool. Imports no host runtime beyond the pi SDK seams used by the
 * oracle and the completion auditor.
 */

import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";

import { createAgentSession, defineTool, SessionManager, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { makeAuditorResourceLoader, resolveAuditorSessionModelOptions } from "./goal-auditor.ts";
import type { ThinkingLevel } from "./goal-settings.ts";

/** Per-field cap for consultant text. The write-boundary caps (TECH §3) are enforced by the router, not here. */
export const CONSULTANT_TEXT_MAX = 1000;
/** Per-array cap for consultant lists. */
export const CONSULTANT_LIST_MAX = 16;

const ConsultantText = Type.String({ minLength: 1, maxLength: CONSULTANT_TEXT_MAX, pattern: "\\S" });

/** Researcher payload (TECH §5): findings, remaining unknowns, and a verdict. */
export const ResearcherPayloadSchema = Type.Object({
	findings: Type.Array(
		Type.Object({
			claim: ConsultantText,
			evidence: ConsultantText,
			source: ConsultantText,
		}),
		{ maxItems: CONSULTANT_LIST_MAX },
	),
	remainingUnknowns: Type.Array(ConsultantText, { maxItems: CONSULTANT_LIST_MAX }),
	verdict: Type.Union([Type.Literal("answered"), Type.Literal("insufficient")]),
});

/** Critic payload (TECH §5): objections with severity, and a verdict. */
export const CriticPayloadSchema = Type.Object({
	objections: Type.Array(
		Type.Object({
			severity: Type.Union([Type.Literal("blocker"), Type.Literal("major"), Type.Literal("minor")]),
			evidence: ConsultantText,
		}),
		{ maxItems: CONSULTANT_LIST_MAX },
	),
	verdict: Type.Union([Type.Literal("sound"), Type.Literal("unsound")]),
});

export type ResearcherPayload = Static<typeof ResearcherPayloadSchema>;
export type CriticPayload = Static<typeof CriticPayloadSchema>;

export const CONSULTANT_ROLES = ["researcher", "critic"] as const;
export type ConsultantRole = typeof CONSULTANT_ROLES[number];

export interface ConsultantPayloadByRole {
	researcher: ResearcherPayload;
	critic: CriticPayload;
}

interface RoleSpec {
	toolName: string;
	toolLabel: string;
	toolDescription: string;
	systemPrompt: string;
	instructions: string;
	schema: TSchema;
}

const ROLE_SPECS: { readonly [R in ConsultantRole]: RoleSpec } = {
	researcher: {
		toolName: "submit_researcher_findings",
		toolLabel: "Submit Researcher Findings",
		toolDescription: "Submit your structured research findings. This is the ONLY way to return a result.",
		systemPrompt: "You are a read-only researcher for one pending decision. Inspect the repository with read-only tools and report evidence. Never modify files. Return findings only through submit_researcher_findings.",
		instructions: "You are a read-only researcher. Answer the open questions in the request with evidence from the repository. Do not decide the fork and do not mutate files.",
		schema: ResearcherPayloadSchema,
	},
	critic: {
		toolName: "submit_critic_objections",
		toolLabel: "Submit Critic Objections",
		toolDescription: "Submit your structured objections. This is the ONLY way to return a result.",
		systemPrompt: "You are a read-only critic of one proposed decision. Look for concrete objections with evidence. Never modify files. Return objections only through submit_critic_objections.",
		instructions: "You are a read-only critic. Test the proposed option against the request and the evidence. Report objections with severity blocker, major, or minor. Do not decide the fork and do not mutate files.",
		schema: CriticPayloadSchema,
	},
};

export type ConsultantErrorCode = "config" | "budget" | "provider" | "aborted" | "invalid_output";

export type ConsultantRunResult<R extends ConsultantRole> =
	| { ok: true; payload: ConsultantPayloadByRole[R]; usage?: { tokens?: number } }
	| { ok: false; errorCode: ConsultantErrorCode; message: string };

/** Result of the pre-launch budget gate (E5 supplies the real check). */
export type ConsultantLaunchGate = { ok: true } | { ok: false; reason: string };

/** Minimal session surface the runner uses; the pi AgentSession satisfies it. */
export interface ConsultantSession {
	prompt: (text: string) => Promise<void>;
	abort: () => void;
	dispose?: () => void;
	subscribe?: (listener: (event: unknown) => void) => () => void;
}

type CreateSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
export type ConsultantModel = NonNullable<CreateSessionOptions["model"]>;
export type ConsultantSessionFactory = (options: CreateSessionOptions) => Promise<{ session: ConsultantSession }>;

export interface RunConsultantArgs<R extends ConsultantRole> {
	ctx: ExtensionContext;
	role: R;
	/** Already minimized by the caller: question, options, objective excerpt, specific unknowns only. */
	prompt: string;
	/** Resolved by the caller from settings (critic for `critic`). Missing ⇒ `config`. */
	model?: ConsultantModel;
	thinkingLevel?: ThinkingLevel;
	/** Wall-clock deadline for the whole consultation, including session creation. */
	deadlineMs: number;
	signal?: AbortSignal;
	/** Pre-launch gate; a refusal returns `budget` and launches nothing. */
	beforeLaunch?: () => ConsultantLaunchGate;
	/** Injectable session factory for tests (same seam as the oracle and the auditor). */
	createSession?: ConsultantSessionFactory;
}

/** Escape `&`, `<`, `>` so request text cannot close the wrapping tag. */
function escapePromptPayload(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Full consultant prompt: role instructions, the submit-tool reminder, and the minimized request. */
export function buildConsultantPrompt(role: ConsultantRole, request: string): string {
	const spec = ROLE_SPECS[role];
	return [
		spec.instructions,
		`Return your result only through ${spec.toolName}.`,
		"",
		"<consultation_request>",
		escapePromptPayload(request),
		"</consultation_request>",
	].join("\n");
}

/** First schema violation as `path: message`, or undefined when the value is valid. */
function firstSchemaError(schema: TSchema, value: unknown): string | undefined {
	for (const error of Value.Errors(schema, value)) return `${error.instancePath || "/"}: ${error.message}`;
	return undefined;
}

/** Sum of assistant `totalTokens` from session events; undefined when none arrived. */
function readAssistantTokens(event: unknown): number | undefined {
	const message = (event as { type?: unknown; message?: { role?: unknown; usage?: { totalTokens?: unknown } } } | null)?.message;
	if ((event as { type?: unknown } | null)?.type !== "message_end" || message?.role !== "assistant") return undefined;
	const total = message.usage?.totalTokens;
	return typeof total === "number" && Number.isFinite(total) ? total : undefined;
}

/** Ignore a session that finishes creation after the consultation was already cancelled. */
function discardLateSession(creating: Promise<{ session: ConsultantSession }>): void {
	creating.then(
		({ session }) => {
			void session.abort();
			session.dispose?.();
		},
		() => {},
	);
}

/**
 * Run ONE isolated read-only consultation for `role` and return its validated
 * payload. See the module header for the safety properties.
 */
export async function runConsultant<R extends ConsultantRole>(args: RunConsultantArgs<R>): Promise<ConsultantRunResult<R>> {
	const spec = ROLE_SPECS[args.role];
	const fail = (errorCode: ConsultantErrorCode, message: string): ConsultantRunResult<R> => ({ ok: false, errorCode, message });

	if (!args.model) {
		return fail("config", `Consultant ${args.role} model is not configured. The executor model is NOT used silently.`);
	}
	if (args.signal?.aborted) return fail("aborted", `Consultant ${args.role} was cancelled before launch.`);
	if (args.beforeLaunch) {
		const gate = args.beforeLaunch();
		if (!gate.ok) return fail("budget", gate.reason);
	}

	// `run` is an object so cancellation written from callbacks stays visible to the flow below.
	const run: {
		cancelReason?: "deadline" | "signal";
		session?: ConsultantSession;
		submitted?: { payload: unknown };
		tokens?: number;
	} = {};
	let wakeCancelled: () => void = () => {};
	const cancelled = new Promise<undefined>((resolve) => {
		wakeCancelled = () => resolve(undefined);
	});
	const cancel = (reason: "deadline" | "signal"): void => {
		if (run.cancelReason) return;
		run.cancelReason = reason;
		if (run.session) void run.session.abort();
		wakeCancelled();
	};
	const onSignalAbort = (): void => cancel("signal");
	const timer = setTimeout(() => cancel("deadline"), args.deadlineMs);
	args.signal?.addEventListener("abort", onSignalAbort, { once: true });
	const abortedResult = (): ConsultantRunResult<R> => fail(
		"aborted",
		run.cancelReason === "deadline"
			? `Consultant ${args.role} exceeded its ${args.deadlineMs} ms deadline.`
			: `Consultant ${args.role} was cancelled.`,
	);

	const submitTool = defineTool({
		name: spec.toolName,
		label: spec.toolLabel,
		description: spec.toolDescription,
		promptSnippet: `Submit structured ${args.role} output via ${spec.toolName}.`,
		parameters: spec.schema,
		async execute(_toolCallId, params) {
			const error = firstSchemaError(spec.schema, params);
			if (error) throw new Error(`Invalid ${spec.toolName} payload: ${error}`);
			if (run.cancelReason) {
				return { content: [{ type: "text", text: "Consultation was cancelled; result not recorded." }], details: {} };
			}
			if (run.submitted) {
				return { content: [{ type: "text", text: "Result already recorded; the first submission stands." }], details: {} };
			}
			run.submitted = { payload: params };
			return { content: [{ type: "text", text: "Result recorded." }], details: {} };
		},
	});

	let unsubscribe: (() => void) | undefined;
	try {
		const create = args.createSession ?? createAgentSession;
		const creating = create({
			cwd: args.ctx.cwd,
			model: args.model,
			thinkingLevel: args.thinkingLevel,
			...resolveAuditorSessionModelOptions(args.ctx),
			sessionManager: SessionManager.inMemory(args.ctx.cwd),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			resourceLoader: makeAuditorResourceLoader(spec.systemPrompt),
			// Read-only profile: NO bash/write/edit, and no delegation tools.
			tools: ["read", "grep", "find", "ls", spec.toolName],
			customTools: [submitTool],
		});
		const created = await Promise.race([creating, cancelled]);
		if (!created) {
			discardLateSession(creating);
			return abortedResult();
		}
		run.session = created.session;
		if (run.cancelReason) {
			void run.session.abort();
			return abortedResult();
		}
		unsubscribe = run.session.subscribe?.((event) => {
			const tokens = readAssistantTokens(event);
			if (tokens !== undefined) run.tokens = (run.tokens ?? 0) + tokens;
		});
		await Promise.race([run.session.prompt(buildConsultantPrompt(args.role, args.prompt)), cancelled]);
	} catch (error) {
		if (run.cancelReason) return abortedResult();
		return fail("provider", error instanceof Error ? error.message : String(error));
	} finally {
		clearTimeout(timer);
		args.signal?.removeEventListener("abort", onSignalAbort);
		unsubscribe?.();
		run.session?.dispose?.();
	}

	if (run.cancelReason) return abortedResult();
	if (!run.submitted) return fail("invalid_output", `Consultant ${args.role} returned no structured result.`);
	return {
		ok: true,
		payload: run.submitted.payload as ConsultantPayloadByRole[R],
		...(run.tokens === undefined ? {} : { usage: { tokens: run.tokens } }),
	};
}
