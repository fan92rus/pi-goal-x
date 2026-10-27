/**
 * Decision router (specs/2026-10-27-adaptive-decisions, TECH §4, E3.1 + E3.2).
 *
 * The router turns a model-authored fork proposal into a route. Validation and
 * route floors are code, not model judgement:
 *
 *   - structure: required fields, options >= 2, non-blank authority basis,
 *     ≤300 chars per text field (TECH §3 write-boundary caps);
 *   - floors: unknowns ⇒ at least `research`; materialRisk ⇒ at least
 *     `critique`; a forbidden category (money, data deletion, production,
 *     secrets) ⇒ at least `ask-human`;
 *   - a self-assessed route below a floor is accepted only with a non-empty
 *     skip justification for every skipped consultation, recorded in
 *     routeJustification; otherwise the router escalates with reason "route floor".
 *
 * Semantic limits (documented, PRODUCT "Authority model"): `materialRisk` is
 * classified by the proposing model on the two semantic axes "hard to reverse"
 * and "departs from the literal request". Absent or explicit-true means
 * material (unsure ⇒ conservative default, TECH §4); only an explicit
 * `materialRisk: false` lowers the floor. FORBIDDEN_CATEGORIES matching is
 * best-effort keyword matching over question, options, facts and unknowns and
 * is not a semantic check.
 *
 * Route execution:
 *   - `direct`: the agent chooses among options (applyDirectResolution). The
 *     validator never picks an option. Only `bounded-auto` may record it.
 *   - `ask-human` / escalation: applyAskHuman writes an `escalated` record and
 *     returns the instruction to fall back to goal_question / the blocker ladder.
 *   - `research` / `critique` / `research+critique`: consultants are not built
 *     yet. resolveConsultationRoute is a STUB that returns "consultations-pending";
 *     E4 (goal-decision-consultant.ts) replaces it.
 *
 * This module does not register any tool (E6) and imports no host runtime. It
 * writes only through goal-decision-record.ts.
 */

import { Type, type Static } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import type { GoalDecisionSettings } from "./goal-decision-policy.ts";
import {
	createDecision,
	setDecisionStatus,
	type DecisionDraft,
	type DecisionRecord,
	type DecisionRoute,
	type DecisionStoreError,
} from "./goal-decision-record.ts";
import type { GoalStorageContext } from "./storage/goal-root.ts";

/** Per-field cap enforced at the router write boundary (TECH §3). */
export const DECISION_TEXT_MAX = 300;

const RouteSchema = Type.Union([
	Type.Literal("direct"),
	Type.Literal("research"),
	Type.Literal("critique"),
	Type.Literal("research+critique"),
	Type.Literal("ask-human"),
]);
const TextSchema = Type.String({ minLength: 1, maxLength: DECISION_TEXT_MAX });

/**
 * Proposal the model submits (TECH §4 input schema). Non-blank checks beyond
 * minLength (whitespace-only text) are applied by validateProposal.
 */
export const DecisionProposalSchema = Type.Object({
	question: TextSchema,
	options: Type.Array(TextSchema, { minItems: 2, maxItems: 8 }),
	selfRoute: RouteSchema,
	authorityBasis: TextSchema,
	/** Per route: the reason a consultation required by the floor is skipped (TECH §4). */
	skipJustifications: Type.Optional(Type.Object({
		direct: Type.Optional(TextSchema),
		research: Type.Optional(TextSchema),
		critique: Type.Optional(TextSchema),
		"research+critique": Type.Optional(TextSchema),
		"ask-human": Type.Optional(TextSchema),
	})),
	facts: Type.Array(TextSchema, { maxItems: 16 }),
	unknowns: Type.Array(TextSchema, { maxItems: 16 }),
	materialRisk: Type.Optional(Type.Boolean()),
	risks: Type.Optional(Type.Array(TextSchema, { maxItems: 16 })),
	revisitWhen: Type.Optional(TextSchema),
});

export type DecisionProposal = Static<typeof DecisionProposalSchema>;
export type RouteJustification = DecisionRecord["routeJustification"];

/** Escalation rank of each route: the effective route of an escalation is the higher-ranked of selfRoute and floor. */
const ROUTE_RANK: Readonly<Record<DecisionRoute, number>> = {
	direct: 0,
	research: 1,
	critique: 2,
	"research+critique": 3,
	"ask-human": 4,
};

/** Which consultations a self-assessed route performs. `ask-human` covers everything by escalating. */
const ROUTE_COVERAGE: Readonly<Record<DecisionRoute, { research: boolean; critique: boolean }>> = {
	direct: { research: false, critique: false },
	research: { research: true, critique: false },
	critique: { research: false, critique: true },
	"research+critique": { research: true, critique: true },
	"ask-human": { research: true, critique: true },
};

// ── forbidden categories ────────────────────────────────────────────────────

export type ForbiddenCategoryId = "money" | "data-deletion" | "production" | "secrets";

/**
 * Best-effort keyword barrier (TECH §4). A match on question, options, facts
 * or unknowns forces the `ask-human` floor. Lack of a match proves nothing: a
 * semantic check is the proposing model's responsibility and is not
 * implemented here.
 */
export const FORBIDDEN_CATEGORIES: ReadonlyArray<{ id: ForbiddenCategoryId; pattern: RegExp }> = [
	{
		id: "money",
		pattern: /\b(spend|spending|payment|payments|paid|pay for|purchase|purchases|buy|billing|invoice|invoices|subscription|subscriptions|money)\b/i,
	},
	{
		id: "data-deletion",
		pattern: /\b(delete|deletes|deleting|deletion|truncate|truncating|wipe|wiping|purge|purging|destroy|destroying)\b|\bdrop (table|database|column|collection)\b|\brm -r/i,
	},
	{
		id: "production",
		pattern: /\bproduction\b|\bprod\b|\bdeploy(s|ed|ing|ment)?\b/i,
	},
	{
		id: "secrets",
		pattern: /\bapi[ _-]?keys?\b|\bsecrets?\b|\bpasswords?\b|\bcredentials?\b|\bprivate keys?\b|\b(access|auth|api|bearer) tokens?\b/i,
	},
];

/** Categories matched in any of the given texts, in FORBIDDEN_CATEGORIES order. */
export function forbiddenCategoriesIn(texts: readonly string[]): ForbiddenCategoryId[] {
	return FORBIDDEN_CATEGORIES
		.filter(({ pattern }) => texts.some((text) => pattern.test(text)))
		.map(({ id }) => id);
}

// ── validation ──────────────────────────────────────────────────────────────

export type ProposalValidation = { ok: true; proposal: DecisionProposal } | { ok: false; reason: string };

function isBlank(text: string): boolean {
	return text.trim() === "";
}

/**
 * Structural validation of a model-submitted proposal. Never throws on input.
 * A failure never touches the decision store.
 */
export function validateProposal(input: unknown): ProposalValidation {
	for (const error of Value.Errors(DecisionProposalSchema, input)) {
		return { ok: false, reason: `${error.instancePath || "/"}: ${error.message}` };
	}
	const proposal = input as DecisionProposal;
	const blankTexts: Array<[string, string]> = [
		["question", proposal.question],
		["authorityBasis", proposal.authorityBasis],
		...proposal.options.map((text, index): [string, string] => [`options/${index}`, text]),
		...proposal.facts.map((text, index): [string, string] => [`facts/${index}`, text]),
		...proposal.unknowns.map((text, index): [string, string] => [`unknowns/${index}`, text]),
		...(proposal.risks ?? []).map((text, index): [string, string] => [`risks/${index}`, text]),
	];
	if (proposal.revisitWhen !== undefined) blankTexts.push(["revisitWhen", proposal.revisitWhen]);
	for (const [field, text] of blankTexts) {
		if (isBlank(text)) return { ok: false, reason: `/${field}: must not be blank` };
	}
	for (const [route, text] of Object.entries(proposal.skipJustifications ?? {})) {
		if (!Object.hasOwn(ROUTE_RANK, route)) return { ok: false, reason: `/skipJustifications/${route}: unknown route` };
		if (isBlank(text)) return { ok: false, reason: `/skipJustifications/${route}: must not be blank` };
	}
	return { ok: true, proposal };
}

// ── route floor and decision ────────────────────────────────────────────────

export interface RouteFloor {
	/** Lowest route the proposal may resolve to. */
	route: DecisionRoute;
	needResearch: boolean;
	needCritique: boolean;
	forbidden: ForbiddenCategoryId[];
}

/**
 * Minimum route implied by the proposal's facts. A forbidden category wins over
 * everything: the floor is `ask-human`.
 */
export function routeFloor(proposal: DecisionProposal): RouteFloor {
	const forbidden = forbiddenCategoriesIn([
		proposal.question,
		...proposal.options,
		...proposal.facts,
		...proposal.unknowns,
	]);
	const needResearch = proposal.unknowns.length > 0;
	// Undefined materialRisk is "unsure" ⇒ conservative default: material (TECH §4).
	// Only an explicit `false` from the proposing model lowers the floor.
	const needCritique = proposal.materialRisk !== false;
	let route: DecisionRoute;
	if (forbidden.length > 0) route = "ask-human";
	else if (needResearch && needCritique) route = "research+critique";
	else if (needResearch) route = "research";
	else if (needCritique) route = "critique";
	else route = "direct";
	return { route, needResearch, needCritique, forbidden };
}

export type RouteDecision =
	| { ok: true; route: DecisionRoute; routeJustification: RouteJustification }
	| { ok: false; floor: DecisionRoute; detail: string };

const NO_SKIPS: RouteJustification = { skipped: [], reasons: {} };

/**
 * Applies the route floor to the self-assessed route.
 *
 * - `ask-human` is accepted as submitted (the caller escalates).
 * - A forbidden category fails with floor `ask-human`. No skip can waive it.
 * - Every consultation required by the floor but missing from the self-assessed
 *   route needs a non-empty skipJustifications entry keyed by that route
 *   (`research` or `critique`). Missing justification fails with detail.
 *
 * Accepted routes are recorded as submitted, with the skipped consultations and
 * their reasons in routeJustification.
 */
export function decideRoute(proposal: DecisionProposal): RouteDecision {
	if (proposal.selfRoute === "ask-human") return { ok: true, route: "ask-human", routeJustification: NO_SKIPS };
	const floor = routeFloor(proposal);
	if (floor.forbidden.length > 0) {
		return { ok: false, floor: floor.route, detail: `forbidden category: ${floor.forbidden.join(", ")}` };
	}
	const covered = ROUTE_COVERAGE[proposal.selfRoute];
	const missing: Array<"research" | "critique"> = [];
	if (floor.needResearch && !covered.research) missing.push("research");
	if (floor.needCritique && !covered.critique) missing.push("critique");
	if (missing.length === 0) return { ok: true, route: proposal.selfRoute, routeJustification: NO_SKIPS };

	const reasons: Record<string, string> = {};
	for (const route of missing) {
		const reason = proposal.skipJustifications?.[route]?.trim();
		if (!reason) {
			return { ok: false, floor: floor.route, detail: `skipping ${route} needs a non-empty skipJustifications.${route}` };
		}
		reasons[route] = reason;
	}
	return { ok: true, route: proposal.selfRoute, routeJustification: { skipped: missing, reasons } };
}

// ── store context and results ───────────────────────────────────────────────

/**
 * Goal-scoped context for writes. The proposal does not carry the goal, so the
 * caller supplies it together with the objective and settings identity used
 * for the record's authority anchor and policyVersion.
 */
export interface DecisionStoreContext {
	storage: GoalStorageContext;
	goalId: string;
	/** Goal objective at decision time; only its excerpt and hash are stored. */
	objective: string;
	/** Settings snapshot id the decision was made under (TECH §2). */
	policyVersion: string;
	/** Goal scheduler generation at launch (TECH §3). */
	generation: string;
}

export type DecisionApplyResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface DecisionOutcomeText {
	decisionId: string;
	text: string;
}

export type DecisionResolution =
	/** decisionMode is manual: the router is inactive and nothing was written. */
	| { kind: "refused"; reason: string }
	/** Structural validation failed: nothing was written. */
	| { kind: "invalid"; reason: string }
	/** Route `direct` is allowed. The agent picks among options via applyDirectResolution. */
	| { kind: "direct"; routeJustification: RouteJustification }
	/** Consultations are required; see resolveConsultationRoute (E4 stub). */
	| { kind: "consultations-pending"; route: "research" | "critique" | "research+critique"; routeJustification: RouteJustification }
	/** Escalated: an `escalated` record was written; `text` tells the model to ask the owner. */
	| { kind: "ask-human"; reason: string; decisionId: string; text: string }
	/** Escalation could not be written. */
	| { kind: "store-error"; reason: string };

function storeFailure(error: DecisionStoreError): string {
	return `decision store ${error.code}: ${error.message}`;
}

/** Higher-ranked of two routes, used as the effective route when escalating. */
function escalatedRoute(selfRoute: DecisionRoute, floor: DecisionRoute): DecisionRoute {
	return ROUTE_RANK[selfRoute] >= ROUTE_RANK[floor] ? selfRoute : floor;
}

function draftFor(storeCtx: DecisionStoreContext, proposal: DecisionProposal, route: DecisionRoute, routeJustification: RouteJustification): DecisionDraft {
	return {
		objective: storeCtx.objective,
		policyVersion: storeCtx.policyVersion,
		question: proposal.question,
		options: proposal.options,
		route,
		routeJustification,
		authorityBasis: proposal.authorityBasis,
		facts: proposal.facts,
		unknowns: proposal.unknowns,
		consultants: [],
		generation: storeCtx.generation,
	};
}

function formatOptions(options: readonly string[]): string {
	return options.map((option, index) => `${index + 1}) ${option}`).join("; ");
}

function escalationText(decisionId: string, reason: string, proposal: DecisionProposal): string {
	return [
		`Decision ${decisionId} escalated (${reason}). Do not choose this fork yourself.`,
		`Question: ${proposal.question}`,
		`Options: ${formatOptions(proposal.options)}`,
		"Ask the owner with goal_question (or the blocker ladder if no answer), then continue with the answer.",
	].join("\n");
}

// ── writes ──────────────────────────────────────────────────────────────────

/**
 * Writes an `escalated` DecisionRecord (router writer) and returns the
 * instruction to fall back to goal_question / the blocker ladder. The effective
 * route is the higher of the self-assessed route and the floor. `reason` is
 * kept in routeJustification.reasons["ask-human"].
 *
 * An invalid proposal returns { ok:false } and writes nothing. If the record is
 * created but the status write fails, an `open` record remains and is reported.
 */
export function applyAskHuman(storeCtx: DecisionStoreContext, input: unknown, reason: string): DecisionApplyResult<DecisionOutcomeText> {
	const validated = validateProposal(input);
	if (!validated.ok) return { ok: false, reason: validated.reason };
	return persistEscalation(storeCtx, validated.proposal, reason);
}

function persistEscalation(storeCtx: DecisionStoreContext, proposal: DecisionProposal, reason: string): DecisionApplyResult<DecisionOutcomeText> {
	const route = escalatedRoute(proposal.selfRoute, routeFloor(proposal).route);
	const created = createDecision(storeCtx.storage, storeCtx.goalId, draftFor(storeCtx, proposal, route, { skipped: [], reasons: { "ask-human": reason } }));
	if (!created.ok) return { ok: false, reason: storeFailure(created.error) };
	const escalated = setDecisionStatus(storeCtx.storage, storeCtx.goalId, created.value.id, "escalated", { writer: "router", expectedRevision: 0 });
	if (!escalated.ok) return { ok: false, reason: storeFailure(escalated.error) };
	return { ok: true, value: { decisionId: created.value.id, text: escalationText(created.value.id, reason, proposal) } };
}

/**
 * Records a `direct` resolution chosen by the agent: `decided` status with
 * outcome `{ chosen, source: "agent", risks, revisitWhen }`, and returns the
 * text the model continues with.
 *
 * Refused (nothing written) when: decisionMode is not `bounded-auto`; the
 * proposal is invalid; `chosen` is not one of the options; or the proposal does
 * not resolve to `direct`. The acceptance-time mode freshness check (TECH §2/§6)
 * belongs to the runtime guard (E5), not here.
 */
export function applyDirectResolution(
	storeCtx: DecisionStoreContext,
	input: unknown,
	chosen: string,
	policy: GoalDecisionSettings,
): DecisionApplyResult<DecisionOutcomeText> {
	if (policy.mode !== "bounded-auto") {
		return { ok: false, reason: `direct resolution requires decisionMode bounded-auto (current: ${policy.mode})` };
	}
	const validated = validateProposal(input);
	if (!validated.ok) return { ok: false, reason: validated.reason };
	const proposal = validated.proposal;
	if (!proposal.options.includes(chosen)) return { ok: false, reason: "chosen must be exactly one of the options" };
	const decided = decideRoute(proposal);
	if (!decided.ok) return { ok: false, reason: `route floor: ${decided.detail}; escalate with applyAskHuman` };
	if (decided.route !== "direct") return { ok: false, reason: `route is ${decided.route}, not direct; follow resolveDecision` };

	const outcome = {
		chosen,
		source: "agent" as const,
		risks: proposal.risks ?? [],
		...(proposal.revisitWhen === undefined ? {} : { revisitWhen: proposal.revisitWhen }),
	};
	const created = createDecision(storeCtx.storage, storeCtx.goalId, { ...draftFor(storeCtx, proposal, "direct", decided.routeJustification), outcome });
	if (!created.ok) return { ok: false, reason: storeFailure(created.error) };
	const id = created.value.id;
	const settled = setDecisionStatus(storeCtx.storage, storeCtx.goalId, id, "decided", { writer: "acceptance-guard", expectedRevision: 0 });
	if (!settled.ok) return { ok: false, reason: storeFailure(settled.error) };

	const lines = [
		`Decision ${id} resolved by the agent (route: direct, source: agent).`,
		`Question: ${proposal.question}`,
		`Chosen: ${chosen}`,
		`Authority: ${proposal.authorityBasis}`,
		`Risks: ${outcome.risks.length > 0 ? outcome.risks.join("; ") : "none recorded"}`,
	];
	if (outcome.revisitWhen !== undefined) lines.push(`Revisit when: ${outcome.revisitWhen}`);
	lines.push("Continue with the chosen option. Do not ask the owner about this fork again unless a revisit condition holds.");
	return { ok: true, value: { decisionId: id, text: lines.join("\n") } };
}

// ── resolution ──────────────────────────────────────────────────────────────

/**
 * STUB (E4): research / critique routes run consultants (TECH §5), which are not
 * implemented yet. The stub returns "consultations-pending" and writes nothing.
 * E4 replaces this function with the runner and the record write.
 */
export function resolveConsultationRoute(route: "research" | "critique" | "research+critique"): { kind: "consultations-pending"; route: typeof route } {
	return { kind: "consultations-pending", route };
}

/**
 * Routes a proposal without choosing an option (the agent's job for `direct`):
 *
 *   - manual mode ⇒ refused, nothing written;
 *   - invalid ⇒ invalid, nothing written;
 *   - route floor violated, or self-route `ask-human` ⇒ escalated (record written);
 *   - `direct` ⇒ kind "direct"; the caller then calls applyDirectResolution;
 *   - research / critique ⇒ consultations-pending (E4 stub).
 */
export function resolveDecision(input: unknown, policy: GoalDecisionSettings, storeCtx: DecisionStoreContext): DecisionResolution {
	if (policy.mode === "manual") return { kind: "refused", reason: "decisionMode is manual; the decision router is inactive" };
	const validated = validateProposal(input);
	if (!validated.ok) return { kind: "invalid", reason: validated.reason };
	const proposal = validated.proposal;
	const decided = decideRoute(proposal);
	if (!decided.ok) return escalate(storeCtx, proposal, `route floor: ${decided.detail}`);
	if (decided.route === "ask-human") return escalate(storeCtx, proposal, "selfRoute ask-human");
	if (decided.route === "direct") return { kind: "direct", routeJustification: decided.routeJustification };
	return { ...resolveConsultationRoute(decided.route), routeJustification: decided.routeJustification };
}

function escalate(storeCtx: DecisionStoreContext, proposal: DecisionProposal, reason: string): DecisionResolution {
	const written = persistEscalation(storeCtx, proposal, reason);
	if (!written.ok) return { kind: "store-error", reason: written.reason };
	return { kind: "ask-human", reason, decisionId: written.value.decisionId, text: written.value.text };
}
