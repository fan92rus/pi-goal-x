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
 *   - `research` / `critique` / `research+critique`: resolveConsultations runs
 *     the read-only consultants (goal-decision-consultant.ts, TECH §5). Every
 *     launch is appended to the record; any failed, refused, or blocking
 *     consultation escalates to ask-human. The per-goal cross-route cap
 *     (maxConsultationsPerGoal, shared with the blocker oracle) is checked
 *     before each wave and reserved per real launch. The token budget gates
 *     every launch (E5.3): a launch with no budget left is refused, ends the
 *     route with the budget line, and each finished consultant's usage is
 *     charged to GoalAccounting under its decision-scoped key.
 *   - Cancellation (TECH §6, E5.2): the injected signal is passed to every
 *     consultant. Once it fires, no further wave or critic starts, the open
 *     record is invalidated (`cancelled`), and the route returns `cancelled`.
 *     A child that outlives the grace period is recorded with `orphaned`.
 *
 * Tool surface (E6.1, TECH §4): `registerDecisionTool` registers `goal_decision`, which is
 * advertised only for an active goal when decisionMode is not manual (`ensureDecisionTool`;
 * manual never registers it). `executeDecisionTool` runs one call:
 *   - bounded-auto: a `direct` route is recorded by applyDirectResolution; a consulted route is
 *     accepted by acceptDecisionResolution (fresh mode and binding checks) and the recommended
 *     option is the decision. The text says what was decided.
 *   - advisory: the owner answers the questionnaire with the recommendation prefilled. An answer
 *     is recorded as decided (source human). A cancelled, unavailable, or failed dialog
 *     escalates the record, and the model falls back to the blocker ladder.
 *   - any escalation returns the ask-human instruction.
 *
 * This module writes only through goal-decision-record.ts and the runtime guard, and calls
 * consultants only through the injected runner.
 */

import { Type, type Static } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { budgetLine, budgetRemaining, type BudgetLike, type GoalAccounting } from "./goal-accounting.ts";
import { goalDetails, renderGoalResult } from "./goal-format.ts";
import { runConsultant, type ConsultantModel, type ConsultantRole, type ConsultantRunResult, type CriticPayload, type ResearcherPayload } from "./goal-decision-consultant.ts";
import { readModeFreshFromDisk, resolveDecisionSettings, type GoalDecisionCriticSettings, type GoalDecisionSettings } from "./goal-decision-policy.ts";
import { acceptDecisionResolution, invalidateOpenDecision, type DecisionResolutionOutcome, type ResolutionAcceptanceVerdict } from "./goal-decision-runtime.ts";
import { journalDecision } from "./goal-decision-journal.ts";
import type { GoalRecord, GoalStatus } from "./goal-record.ts";
import { DIALOG_UNAVAILABLE_HINT, runGoalQuestionnaire, type GoalQuestionnaireResult } from "./goal-questionnaire.ts";
import type { ThinkingLevel } from "./goal-settings.ts";
import type { GoalCore } from "./goal-state.ts";
import { DECISION_TOOL_NAME } from "./goal-tool-names.ts";
import {
	createDecision,
	getConsultationsLaunched,
	getDecisions,
	incrementConsultations,
	reserveConsultations,
	setDecisionStatus,
	updateDecision,
	type ConsultantResult,
	type DecisionDraft,
	type DecisionRecord,
	type DecisionRoute,
	type DecisionStoreError,
} from "./goal-decision-record.ts";
import { goalStorageContext, type GoalStorageContext } from "./storage/goal-root.ts";

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
	/**
	 * Consultants ran and none escalated (TECH §5). The record stays `open`: only the
	 * acceptance guard (E5) writes `decided`.
	 */
	| { kind: "consulted"; decisionId: string; route: ConsultedRoute; routeJustification: RouteJustification; facts: string[]; risks: string[]; text: string }
	/** Escalated: an `escalated` record was written; `text` tells the model to ask the owner. */
	| { kind: "ask-human"; reason: string; decisionId: string; text: string }
	/**
	 * The deliberation was cancelled (pause, interrupt, abort; TECH §6). `decisionId` is
	 * set when a record existed: it was invalidated, and nothing else ran.
	 */
	| { kind: "cancelled"; decisionId?: string; reason: string }
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

	return { ok: true, value: { decisionId: id, text: resolutionText(id, "direct", proposal, outcome) } };
}

/** Text the model continues with once a resolution is recorded as `decided` (TECH §4, §8). */
function resolutionText(decisionId: string, route: DecisionRoute, proposal: DecisionProposal, outcome: DecisionResolutionOutcome): string {
	const human = outcome.source === "human";
	const lines = [
		human
			? `Decision ${decisionId} answered by the owner (route: ${route}, source: human).`
			: `Decision ${decisionId} resolved by the agent (route: ${route}, source: ${outcome.source}).`,
		`Question: ${proposal.question}`,
		`Chosen: ${outcome.chosen ?? "none"}`,
		`Authority: ${proposal.authorityBasis}`,
		`Risks: ${outcome.risks.length > 0 ? outcome.risks.join("; ") : "none recorded"}`,
	];
	if (outcome.revisitWhen !== undefined) lines.push(`Revisit when: ${outcome.revisitWhen}`);
	lines.push(human
		? "Continue with the owner's answer."
		: "Continue with the chosen option. Do not ask the owner about this fork again unless a revisit condition holds.");
	return lines.join("\n");
}

// ── consultants (TECH §5) ───────────────────────────────────────────────────

/** Routes that run consultants. `direct` and `ask-human` never reach resolveConsultations. */
export type ConsultedRoute = "research" | "critique" | "research+critique";

/**
 * Consultant runner seam. Production passes runConsultant; tests pass fakes.
 * `ctx.model` is the proposing (executor) model: researchers are read-only and
 * run on it. The critic never does (cross-model rule, resolveCriticModel).
 */
export type ConsultantRunner = typeof runConsultant;

export interface ConsultationDeps {
	ctx: ExtensionContext;
	runConsultant: ConsultantRunner;
	/** Cancels the deliberation and every in-flight consultant (pause, interrupt, abort). */
	signal?: AbortSignal;
	/**
	 * Token budget (TECH §3, §6, E5.3). `goal` is read before every launch; a launch needs
	 * remaining > 0, or no budget set. `accounting` receives each finished consultant's
	 * keyed usage, and its pending tokens count as spent. Absent ⇒ no gate and no charge.
	 */
	budget?: { goal: () => BudgetLike; accounting: GoalAccounting };
}

export type CriticModelResolution =
	| { ok: true; model: ConsultantModel; thinkingLevel?: ThinkingLevel }
	| { ok: false; reason: string };

function modelKey(model: unknown): string | undefined {
	const { provider, id } = (model ?? {}) as { provider?: unknown; id?: unknown };
	return typeof provider === "string" && typeof id === "string" ? `${provider}/${id}` : undefined;
}

/**
 * Critic model from settings.decisionCritic (TECH §5). The explicit provider and
 * model must both be set and must resolve in the registry. A critic equal to the
 * proposing model (`authorModel`) is refused: cross-model review is the point.
 *
 * Nothing is substituted silently. Unset, unresolvable, and same-model are all
 * refusals, and the caller escalates to ask-human. The same-model degraded mode
 * of TECH §5 (`crossModelDegraded`) is deferred to E6, when a model resolver
 * exists; until then a mandatory critique fails closed (owner decision D5).
 */
export function resolveCriticModel(ctx: ExtensionContext, settings: GoalDecisionSettings, authorModel?: ConsultantModel): CriticModelResolution {
	const critic: GoalDecisionCriticSettings | undefined = settings.critic;
	if (!critic?.provider || !critic.model) {
		return { ok: false, reason: "config: decisionCritic provider and model are not set; the executor model is not used as critic" };
	}
	const found = (ctx.modelRegistry as unknown as { find?: (provider: string, id: string) => unknown } | undefined)?.find?.(critic.provider, critic.model);
	if (!found) return { ok: false, reason: `config: critic model not found: ${critic.provider}/${critic.model}` };
	const key = modelKey(found);
	if (key !== undefined && key === modelKey(authorModel)) {
		return { ok: false, reason: `config: critic model ${key} is the proposing model; cross-model review is required` };
	}
	return {
		ok: true,
		model: found as ConsultantModel,
		...(critic.thinkingLevel === undefined ? {} : { thinkingLevel: critic.thinkingLevel }),
	};
}

/** Caps text at the router write boundary (TECH §3): at most DECISION_TEXT_MAX chars, a cut marked with an ellipsis. */
function clipText(text: string): string {
	if (text.length <= DECISION_TEXT_MAX) return text;
	let cut = text.slice(0, DECISION_TEXT_MAX - 1);
	if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
	return `${cut}…`;
}

function bulletList(items: readonly string[]): string {
	return items.length === 0 ? " none" : `\n${items.map((item) => `- ${item}`).join("\n")}`;
}

/**
 * Minimized consultant request (TECH §5): question, options, authority basis,
 * facts, unknowns, and the role's own question. Never the goal record, the
 * objective, or record metadata (ids, policyVersion, generation).
 */
function consultationRequest(proposal: DecisionProposal, facts: readonly string[], roleQuestion: string): string {
	return [
		`Question: ${proposal.question}`,
		`Options: ${formatOptions(proposal.options)}`,
		`Authority basis: ${proposal.authorityBasis}`,
		`Facts:${bulletList(facts)}`,
		`Unknowns:${bulletList(proposal.unknowns)}`,
		`Your question: ${roleQuestion}`,
	].join("\n");
}

const CRITIC_QUESTION = "Which objections apply to the proposed options, given the facts and any research findings? Report each with severity blocker, major, or minor and its evidence.";

/** One researcher per unknown; with no unknowns, one researcher on the question itself. */
function researchQuestionsOf(proposal: DecisionProposal): string[] {
	return proposal.unknowns.length > 0 ? [...proposal.unknowns] : [proposal.question];
}

/**
 * Consultant rounds (TECH §5, maxRounds) count PHASES, not launches (owner decision):
 * the research phase is one round however many unknowns it covers (its chunks of
 * maxParallelConsultants do not add rounds), and the critique phase is one round.
 * The total must fit maxRounds before anything launches. A research phase that
 * is insufficient escalates at once (runResearch), so no second research round
 * exists in v1.
 */
function roundsNeeded(route: ConsultedRoute): number {
	const coverage = ROUTE_COVERAGE[route];
	return (coverage.research ? 1 : 0) + (coverage.critique ? 1 : 0);
}

type Preflight =
	| { ok: true; researcher?: ConsultantModel; critic?: { model: ConsultantModel; thinkingLevel?: ThinkingLevel } }
	| { ok: false; reason: string };

/** Checks that need no launch: round budget and models. Failing here writes an escalated record and launches nothing. */
function preflight(deps: ConsultationDeps, policy: GoalDecisionSettings, proposal: DecisionProposal, route: ConsultedRoute): Preflight {
	const rounds = roundsNeeded(route);
	if (rounds > policy.limits.maxRounds) {
		return { ok: false, reason: `consultation rounds exhausted: route ${route} needs ${rounds}, maxRounds is ${policy.limits.maxRounds}` };
	}
	const coverage = ROUTE_COVERAGE[route];
	const result: Extract<Preflight, { ok: true }> = { ok: true };
	if (coverage.research) {
		if (!deps.ctx.model) return { ok: false, reason: "config: no executor model is available for the researcher" };
		result.researcher = deps.ctx.model;
	}
	if (coverage.critique) {
		const critic = resolveCriticModel(deps.ctx, policy, deps.ctx.model);
		if (!critic.ok) return { ok: false, reason: critic.reason };
		result.critic = { model: critic.model, thinkingLevel: critic.thinkingLevel };
	}
	return result;
}

/** Working state of one consultation run: the record is replaced after each write (revision moves). */
interface ConsultationFlow {
	storeCtx: DecisionStoreContext;
	proposal: DecisionProposal;
	policy: GoalDecisionSettings;
	deps: ConsultationDeps;
	route: ConsultedRoute;
	routeJustification: RouteJustification;
	record: DecisionRecord;
	/** Consultant launches so far; the next childRunId is consultant-<launched + 1>. */
	launched: number;
}

interface LaunchedConsultant<R extends ConsultantRole> {
	entry: ConsultantResult;
	result: ConsultantRunResult<R>;
}

/** Capped record entry for one launch (TECH §3/§5): summary ≤300, payload with capped strings, usage only when reported. */
function consultantEntry(
	childRunId: string,
	role: ConsultantRole,
	model: string,
	seconds: number,
	result: ConsultantRunResult<ConsultantRole>,
): ConsultantResult {
	if (!result.ok) {
		return {
			role,
			childRunId,
			model,
			usage: "unknown",
			summary: clipText(`${result.errorCode}: ${result.message}`),
			schemaPayload: null,
			...(result.orphaned ? { orphaned: true as const } : {}),
		};
	}
	const usage: ConsultantResult["usage"] = result.usage?.tokens === undefined ? "unknown" : { tokens: result.usage.tokens, seconds };
	if (role === "researcher") {
		const payload = result.payload as ResearcherPayload;
		const claims = payload.findings.map((finding) => finding.claim);
		return {
			role,
			childRunId,
			model,
			usage,
			summary: clipText(`${payload.verdict}: ${claims.join("; ") || "no findings"}`),
			schemaPayload: {
				verdict: payload.verdict,
				findings: payload.findings.map((finding) => ({ claim: clipText(finding.claim), evidence: clipText(finding.evidence), source: clipText(finding.source) })),
				remainingUnknowns: payload.remainingUnknowns.map(clipText),
			},
		};
	}
	const payload = result.payload as CriticPayload;
	return {
		role,
		childRunId,
		model,
		usage,
		summary: clipText(`${payload.verdict}: ${payload.objections.map((objection) => `${objection.severity}: ${objection.evidence}`).join("; ") || "no objections"}`),
		schemaPayload: {
			verdict: payload.verdict,
			objections: payload.objections.map((objection) => ({ severity: objection.severity, evidence: clipText(objection.evidence) })),
		},
	};
}

/**
 * Pre-launch gate (runConsultant calls it only after the model check, so config
 * refusals never count). The token budget is checked first (TECH §3, E5.3): a
 * launch with nothing left is refused with the budget line. Then one launch is
 * reserved under the per-goal cap. A refusal launches nothing and counts nothing.
 */
function reserveLaunch(flow: ConsultationFlow): { ok: true } | { ok: false; reason: string } {
	const budget = flow.deps.budget;
	if (budget) {
		const goal = budget.goal();
		const live: BudgetLike = { ...goal, usage: { tokensUsed: goal.usage.tokensUsed + budget.accounting.pendingKeyedTokens() } };
		const remaining = budgetRemaining(live);
		if (remaining !== null && remaining <= 0) return { ok: false, reason: budgetLine(live) ?? "token budget exhausted" };
	}
	const reserved = reserveConsultations(flow.storeCtx.storage, flow.storeCtx.goalId, flow.policy.limits.maxConsultationsPerGoal);
	if (reserved.ok) return { ok: true };
	return { ok: false, reason: reserved.error.code === "capped" ? reserved.error.message : storeFailure(reserved.error) };
}

/**
 * Cap check before a wave of `size` launches (TECH §5): launched + size must fit
 * under maxConsultationsPerGoal. On overflow the route escalates with no launch.
 */
function checkCapBeforeWave(flow: ConsultationFlow, size: number): DecisionResolution | undefined {
	const cap = flow.policy.limits.maxConsultationsPerGoal;
	const counted = getConsultationsLaunched(flow.storeCtx.storage, flow.storeCtx.goalId);
	if (!counted.ok) return { kind: "store-error", reason: storeFailure(counted.error) };
	if (counted.value + size > cap) return escalateConsulted(flow, `consultation cap reached (${counted.value}/${cap})`);
	return undefined;
}

async function launchConsultant<R extends ConsultantRole>(
	flow: ConsultationFlow,
	args: { role: R; prompt: string; model: ConsultantModel; thinkingLevel?: ThinkingLevel },
): Promise<LaunchedConsultant<R>> {
	flow.launched += 1;
	const childRunId = `consultant-${flow.launched}`;
	const started = Date.now();
	let result: ConsultantRunResult<R>;
	try {
		result = await flow.deps.runConsultant({
			ctx: flow.deps.ctx,
			role: args.role,
			prompt: args.prompt,
			model: args.model,
			thinkingLevel: args.thinkingLevel,
			deadlineMs: flow.policy.limits.consultantDeadlineMs,
			signal: flow.deps.signal,
			beforeLaunch: () => reserveLaunch(flow),
		});
	} catch (error) {
		// runConsultant reports its own failures; a thrown runner is still a failed run, never a silent pass.
		result = { ok: false, errorCode: "provider", message: error instanceof Error ? error.message : String(error) };
	}
	const seconds = Number(((Date.now() - started) / 1000).toFixed(3));
	if (flow.deps.budget) {
		// Keyed per decision: childRunId restarts at consultant-1 in every deliberation. Seconds are not
		// charged: the consultant runs inside the agent turn, whose elapsed time charge() already counts.
		flow.deps.budget.accounting.chargeKeyed(`${flow.record.id}/${childRunId}`, keyedTokens(result), 0);
	}
	return { result, entry: consultantEntry(childRunId, args.role, modelKey(args.model) ?? "unknown", seconds, result) };
}

/** Tokens to charge for one finished launch: the reported total, or "unknown" (never estimated). */
function keyedTokens(result: ConsultantRunResult<ConsultantRole>): number | "unknown" {
	return result.ok && result.usage?.tokens !== undefined ? result.usage.tokens : "unknown";
}

/** Appends launch entries and new facts in one revision-checked write. Returns the store error text, if any. */
function appendConsultants(flow: ConsultationFlow, entries: ConsultantResult[], facts: string[]): string | undefined {
	const { storeCtx, record } = flow;
	const updated = updateDecision(storeCtx.storage, storeCtx.goalId, record.id, (draft) => ({
		...draft,
		consultants: [...draft.consultants, ...entries],
		facts: [...draft.facts, ...facts],
	}), record.revision);
	if (!updated.ok) return storeFailure(updated.error);
	flow.record = updated.value;
	return undefined;
}

/** Escalates a record that already has consultant entries: reason stored, status `escalated` (router writer). */
function escalateConsulted(flow: ConsultationFlow, rawReason: string): DecisionResolution {
	const reason = clipText(rawReason);
	const marked = markEscalated(flow.storeCtx, flow.record.id, reason);
	if (!marked.ok) return { kind: "store-error", reason: marked.reason };
	return { kind: "ask-human", reason, decisionId: flow.record.id, text: escalationText(flow.record.id, reason, flow.proposal) };
}

/** Moves an open record to `escalated` (router writer) and keeps the reason in routeJustification. */
function markEscalated(storeCtx: DecisionStoreContext, decisionId: string, reason: string): { ok: true } | { ok: false; reason: string } {
	const listed = getDecisions(storeCtx.storage, storeCtx.goalId);
	if (!listed.ok) return { ok: false, reason: storeFailure(listed.error) };
	const record = listed.value.find((candidate) => candidate.id === decisionId);
	if (!record) return { ok: false, reason: `decision ${decisionId} not found` };
	const reasoned = updateDecision(storeCtx.storage, storeCtx.goalId, record.id, (draft) => ({
		...draft,
		routeJustification: { ...draft.routeJustification, reasons: { ...draft.routeJustification.reasons, "ask-human": reason } },
	}), record.revision);
	if (!reasoned.ok) return { ok: false, reason: storeFailure(reasoned.error) };
	const escalated = setDecisionStatus(storeCtx.storage, storeCtx.goalId, record.id, "escalated", { writer: "router", expectedRevision: reasoned.value.revision });
	if (!escalated.ok) return { ok: false, reason: storeFailure(escalated.error) };
	return { ok: true };
}

/**
 * The deliberation was cancelled while it ran (TECH §6): the open record is
 * invalidated through the acceptance guard, and no further consultant starts.
 * Consultant entries already appended stay in the record.
 */
function cancelDeliberation(flow: ConsultationFlow): DecisionResolution {
	const { storeCtx, record } = flow;
	const invalidated = invalidateOpenDecision(storeCtx.storage, storeCtx.goalId, record.id, "cancelled", "the deliberation was cancelled before it completed");
	if (invalidated.kind === "store-error") return { kind: "store-error", reason: invalidated.reason };
	return { kind: "cancelled", decisionId: record.id, reason: "the deliberation was cancelled; the record is invalidated" };
}

function consultedResolution(flow: ConsultationFlow, risks: string[]): DecisionResolution {
	const { record, proposal, route, routeJustification } = flow;
	const lines = [
		`Decision ${record.id} consulted (route: ${route}; consultant runs: ${flow.launched}).`,
		`Question: ${proposal.question}`,
		`Options: ${formatOptions(proposal.options)}`,
		`Facts: ${record.facts.join("; ") || "none recorded"}`,
		`Risks: ${risks.length > 0 ? risks.join("; ") : "none recorded"}`,
		"Choose one option. The record stays open until the decision is accepted.",
	];
	return { kind: "consulted", decisionId: record.id, route, routeJustification, facts: record.facts, risks, text: lines.join("\n") };
}

/** Research phase (one round): unknowns in concurrent chunks of maxParallelConsultants. Undefined means every chunk passed. */
async function runResearch(flow: ConsultationFlow, researcher: ConsultantModel): Promise<DecisionResolution | undefined> {
	const { proposal, policy } = flow;
	const questions = researchQuestionsOf(proposal);
	const width = policy.limits.maxParallelConsultants;
	for (let start = 0; start < questions.length; start += width) {
		if (flow.deps.signal?.aborted) return cancelDeliberation(flow);
		const wave = questions.slice(start, start + width);
		const capped = checkCapBeforeWave(flow, wave.length);
		if (capped !== undefined) return capped;
		const launches = await Promise.all(wave.map((question) => launchConsultant(flow, {
			role: "researcher",
			prompt: consultationRequest(proposal, proposal.facts, `Answer with evidence from the repository: ${question}`),
			model: researcher,
		})));
		const findingFacts = launches.flatMap(({ result }) => (result.ok
			? result.payload.findings.map((finding) => clipText(`${finding.claim} (source: ${finding.source})`))
			: []));
		const stored = appendConsultants(flow, launches.map(({ entry }) => entry), findingFacts);
		if (stored !== undefined) return { kind: "store-error", reason: stored };
		if (flow.deps.signal?.aborted) return cancelDeliberation(flow);
		const problem = researchProblem(launches);
		if (problem !== undefined) return escalateConsulted(flow, problem);
	}
	return undefined;
}

function researchProblem(launches: ReadonlyArray<LaunchedConsultant<"researcher">>): string | undefined {
	for (const { result } of launches) {
		if (!result.ok) return `consultant researcher ${result.errorCode}: ${result.message}`;
	}
	for (const { result } of launches) {
		if (result.ok && result.payload.verdict === "insufficient") return "researcher verdict insufficient";
	}
	return undefined;
}

/** Critic wave: one launch on the proposal plus the facts gathered so far (including research findings). */
async function runCritic(flow: ConsultationFlow, critic: { model: ConsultantModel; thinkingLevel?: ThinkingLevel }): Promise<DecisionResolution> {
	if (flow.deps.signal?.aborted) return cancelDeliberation(flow);
	const capped = checkCapBeforeWave(flow, 1);
	if (capped !== undefined) return capped;
	const launch = await launchConsultant(flow, {
		role: "critic",
		prompt: consultationRequest(flow.proposal, flow.record.facts, CRITIC_QUESTION),
		model: critic.model,
		thinkingLevel: critic.thinkingLevel,
	});
	const stored = appendConsultants(flow, [launch.entry], []);
	if (stored !== undefined) return { kind: "store-error", reason: stored };
	if (flow.deps.signal?.aborted) return cancelDeliberation(flow);
	const problem = criticProblem(launch.result);
	if (problem !== undefined) return escalateConsulted(flow, problem);
	const risks = launch.result.ok
		? launch.result.payload.objections
			.filter((objection) => objection.severity !== "blocker")
			.map((objection) => clipText(`${objection.severity}: ${objection.evidence}`))
		: [];
	return consultedResolution(flow, risks);
}

/** A blocker objection is never waived, whatever the verdict (TECH §5); an unsound verdict also escalates (fail closed). */
function criticProblem(result: ConsultantRunResult<"critic">): string | undefined {
	if (!result.ok) return `consultant critic ${result.errorCode}: ${result.message}`;
	const blocker = result.payload.objections.find((objection) => objection.severity === "blocker");
	if (blocker) return `critic blocker objection: ${blocker.evidence}`;
	if (result.payload.verdict === "unsound") return "critic verdict unsound";
	return undefined;
}

/**
 * Runs the consultations required by a research, critique, or research+critique
 * route (TECH §5). Order: round and model preflight (no launch on failure), then
 * the research phase (chunks of maxParallelConsultants), then the critic, which
 * starts only after the research findings are fixed into the record. A failed,
 * refused, or blocking consultation escalates to ask-human; an unsound critic
 * verdict escalates too (fail closed, even without a blocker objection). A clean
 * run returns `consulted` with the record still `open`.
 */
export async function resolveConsultations(
	storeCtx: DecisionStoreContext,
	proposal: DecisionProposal,
	route: ConsultedRoute,
	routeJustification: RouteJustification,
	policy: GoalDecisionSettings,
	deps: ConsultationDeps,
): Promise<DecisionResolution> {
	// Cancelled before anything was written: nothing to invalidate, nothing launches.
	if (deps.signal?.aborted) return { kind: "cancelled", reason: "the deliberation was cancelled before any consultant launched" };
	const pre = preflight(deps, policy, proposal, route);
	if (!pre.ok) return escalate(storeCtx, proposal, pre.reason);
	const created = createDecision(storeCtx.storage, storeCtx.goalId, draftFor(storeCtx, proposal, route, routeJustification));
	if (!created.ok) return { kind: "store-error", reason: storeFailure(created.error) };
	const flow: ConsultationFlow = { storeCtx, proposal, policy, deps, route, routeJustification, record: created.value, launched: 0 };
	if (pre.researcher) {
		const failed = await runResearch(flow, pre.researcher);
		if (failed !== undefined) return failed;
	}
	if (pre.critic) return runCritic(flow, pre.critic);
	return consultedResolution(flow, []);
}

// ── blocker oracle accounting (TECH §5 cross-route cap, §7) ─────────────────

/**
 * Counts one blocker-oracle consultation against the per-goal cap, then runs it.
 * The count is taken before `run` starts. A reached cap never stops the oracle:
 * it keeps its own per-fingerprint limit (goal-core-tools.ts). A store failure
 * is best-effort, as for other ledger writes on this path.
 */
export async function runCountedOracle<T>(storage: GoalStorageContext, goalId: string, cap: number, run: () => Promise<T>): Promise<T> {
	incrementConsultations(storage, goalId, cap);
	return run();
}

// ── resolution ──────────────────────────────────────────────────────────────

/**
 * Routes a proposal. Consultants run asynchronously, so this is async:
 *
 *   - manual mode ⇒ refused, nothing written;
 *   - invalid ⇒ invalid, nothing written;
 *   - route floor violated, or self-route `ask-human` ⇒ escalated (record written);
 *   - `direct` ⇒ kind "direct"; the caller then calls applyDirectResolution;
 *   - research / critique / research+critique ⇒ resolveConsultations (consulted or ask-human).
 */
export async function resolveDecision(
	input: unknown,
	policy: GoalDecisionSettings,
	storeCtx: DecisionStoreContext,
	deps: ConsultationDeps,
): Promise<DecisionResolution> {
	if (policy.mode === "manual") return { kind: "refused", reason: "decisionMode is manual; the decision router is inactive" };
	const validated = validateProposal(input);
	if (!validated.ok) return { kind: "invalid", reason: validated.reason };
	const proposal = validated.proposal;
	const decided = decideRoute(proposal);
	if (!decided.ok) return escalate(storeCtx, proposal, `route floor: ${decided.detail}`);
	if (decided.route === "ask-human") return escalate(storeCtx, proposal, "selfRoute ask-human");
	if (decided.route === "direct") return { kind: "direct", routeJustification: decided.routeJustification };
	return resolveConsultations(storeCtx, proposal, decided.route, decided.routeJustification, policy, deps);
}

function escalate(storeCtx: DecisionStoreContext, proposal: DecisionProposal, reason: string): DecisionResolution {
	const written = persistEscalation(storeCtx, proposal, reason);
	if (!written.ok) return { kind: "store-error", reason: written.reason };
	return { kind: "ask-human", reason, decisionId: written.value.decisionId, text: written.value.text };
}

// ── tool surface (E6.1, TECH §4, §8) ────────────────────────────────────────

/** The focused goal as the tool reads it at each step: status, objective, scheduler generation, budget. */
export interface DecisionGoalView {
	id: string;
	status: GoalStatus;
	objective: string;
	/** Scheduler generation (TECH §3); "" when the goal has no scheduler state. */
	generation: string;
	tokenBudget?: number;
	usage: { tokensUsed: number };
}

/** Everything one goal_decision call reads or calls. Production passes the live session; tests inject fakes. */
export interface DecisionToolDeps {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	storage: GoalStorageContext;
	ctx: ExtensionContext;
	/** The focused goal, read live at each step; null when no goal is focused. */
	readGoal: () => DecisionGoalView | null;
	runConsultant: ConsultantRunner;
	signal?: AbortSignal;
	accounting: GoalAccounting;
	/** Owner dialog with the recommended option prefilled (advisory). */
	ask: (question: string, options: string[], recommended: number, context: string) => Promise<GoalQuestionnaireResult>;
}

/** What one call needs after the route is known. */
interface ResolutionContext {
	deps: DecisionToolDeps;
	goal: DecisionGoalView;
	storeCtx: DecisionStoreContext;
	proposal: DecisionProposal;
	route: DecisionRoute;
	decisionId: string;
	/** Zero-based index of the option the model recommends (bounded-auto: takes). Validated in range. */
	recommended: number;
	/** Proposal risks plus consultant risks; recorded in the outcome. */
	risks: string[];
	trace: CallTrace;
}

/** What one goal_decision call wrote, for the journal (TECH §8): filled in as the record ids and reasons become known. */
interface CallTrace {
	goalId?: string;
	decisionId?: string;
	/** Why the record was invalidated or cancelled; kept out of the record itself. */
	reason?: string;
}

/**
 * Runs one goal_decision call and returns the text the model continues with. Nothing
 * throws: a path that does not decide tells the model to ask the owner (or fall back to
 * the blocker ladder), and a decision is only reported after the record is written.
 */
export async function executeDecisionTool(proposalInput: unknown, recommended: unknown, deps: DecisionToolDeps): Promise<string> {
	const trace: CallTrace = {};
	const text = await decideFork(proposalInput, recommended, deps, trace);
	// Journal the terminal state once per call (TECH §8). Best-effort: the record is the authority.
	if (trace.goalId !== undefined && trace.decisionId !== undefined) journalDecision(deps.storage, trace.goalId, trace.decisionId, trace.reason);
	return text;
}

async function decideFork(proposalInput: unknown, recommended: unknown, deps: DecisionToolDeps, trace: CallTrace): Promise<string> {
	const goal = deps.readGoal();
	if (!goal || goal.status !== "active") {
		return "goal_decision applies to an active goal, and no active goal is focused. Ask the owner with goal_question or in chat instead.";
	}
	trace.goalId = goal.id;
	const policy = resolveDecisionSettings(deps.cwd, deps.env);
	if (policy.mode === "manual") return "decisionMode is manual: goal_decision is inactive. Ask the owner with goal_question.";
	const validated = validateProposal(proposalInput);
	if (!validated.ok) return `Invalid decision proposal (${validated.reason}). Nothing was recorded; fix the proposal or ask with goal_question.`;
	const { proposal } = validated;
	if (typeof recommended !== "number" || !Number.isInteger(recommended) || recommended < 0 || recommended >= proposal.options.length) {
		return `recommended must be the zero-based index of one of the ${proposal.options.length} options. Nothing was recorded; resubmit the proposal.`;
	}

	const chosen = proposal.options[recommended] as string;
	const storeCtx: DecisionStoreContext = {
		storage: deps.storage,
		goalId: goal.id,
		objective: goal.objective,
		policyVersion: readModeFreshFromDisk(deps.cwd, deps.env).snapshotId,
		generation: goal.generation,
	};
	const consultation: ConsultationDeps = {
		ctx: deps.ctx,
		runConsultant: deps.runConsultant,
		signal: deps.signal,
		budget: { goal: () => deps.readGoal() ?? goal, accounting: deps.accounting },
	};
	const resolution = await resolveDecision(proposalInput, policy, storeCtx, consultation);
	const context = (decisionId: string, route: DecisionRoute, risks: string[]): ResolutionContext => ({
		deps, goal, storeCtx, proposal, route, decisionId, recommended, risks, trace,
	});
	switch (resolution.kind) {
		case "refused":
			return `${resolution.reason}. Ask the owner with goal_question.`;
		case "invalid":
			return `Invalid decision proposal (${resolution.reason}). Nothing was recorded; fix the proposal or ask with goal_question.`;
		case "store-error":
			return `The decision could not be recorded (${resolution.reason}). Ask the owner with goal_question.`;
		case "cancelled":
			if (resolution.decisionId !== undefined) {
				trace.decisionId = resolution.decisionId;
				trace.reason = "cancelled";
			}
			return `The deliberation was cancelled (${resolution.reason}). No decision was taken; continue on the normal blocker ladder.`;
		case "ask-human":
			trace.decisionId = resolution.decisionId;
			return resolution.text;
		case "direct": {
			if (policy.mode === "bounded-auto") {
				const applied = applyDirectResolution(storeCtx, proposalInput, chosen, policy);
				if (!applied.ok) return `The decision was not recorded (${applied.reason}). Ask the owner with goal_question.`;
				trace.decisionId = applied.value.decisionId;
				return applied.value.text;
			}
			const created = createDecision(deps.storage, goal.id, draftFor(storeCtx, proposal, "direct", resolution.routeJustification));
			if (!created.ok) return `The decision could not be recorded (${storeFailure(created.error)}). Ask the owner with goal_question.`;
			trace.decisionId = created.value.id;
			return ownerDecides(context(created.value.id, "direct", proposal.risks ?? []));
		}
		case "consulted": {
			trace.decisionId = resolution.decisionId;
			const risks = [...(proposal.risks ?? []), ...resolution.risks];
			const consulted = context(resolution.decisionId, resolution.route, risks);
			if (policy.mode === "bounded-auto") return settle(consulted, "agent", outcomeOf(consulted, "agent", chosen));
			return ownerDecides(consulted);
		}
	}
}

function outcomeOf(rc: ResolutionContext, source: "agent" | "human", chosen: string): DecisionResolutionOutcome {
	return {
		chosen,
		source,
		risks: rc.risks,
		...(rc.proposal.revisitWhen === undefined ? {} : { revisitWhen: rc.proposal.revisitWhen }),
	};
}

/** Accepts a final resolution through the runtime guard and returns the text for the model (TECH §6, §8). */
function settle(rc: ResolutionContext, source: "agent" | "human", outcome: DecisionResolutionOutcome): string {
	const verdict = acceptDecisionResolution({
		storage: rc.deps.storage,
		goalId: rc.goal.id,
		cwd: rc.deps.cwd,
		env: rc.deps.env,
		goal: rc.goal,
		decisionId: rc.decisionId,
		source,
		outcome,
	});
	if (verdict.kind === "decided") return resolutionText(rc.decisionId, rc.route, rc.proposal, outcome);
	if (verdict.kind === "invalidated") rc.trace.reason = `${verdict.reason}: ${verdict.detail}`;
	if (source === "human") {
		return `The owner answered "${outcome.chosen ?? ""}", but decision ${rc.decisionId} was not recorded (${describeRejection(verdict)}). Use the answer for this fork.`;
	}
	return `Decision ${rc.decisionId} was not accepted (${describeRejection(verdict)}). Nothing was decided; ask the owner with goal_question or continue on the blocker ladder.`;
}

function describeRejection(verdict: Exclude<ResolutionAcceptanceVerdict, { kind: "decided" }>): string {
	switch (verdict.kind) {
		case "invalidated":
			return `invalidated: ${verdict.reason}: ${verdict.detail}`;
		case "ignored":
			return `ignored: ${verdict.reason}`;
		case "store-error":
			return `store error: ${verdict.reason}`;
	}
}

/**
 * Advisory (TECH §4, §8): the owner answers with the recommendation prefilled. An answer is
 * recorded as decided (source human). A cancelled, unavailable, or failed dialog escalates the
 * open record, and the meaning stays as today: no answer means the blocker ladder.
 */
async function ownerDecides(rc: ResolutionContext): Promise<string> {
	const option = rc.proposal.options[rc.recommended] as string;
	const context = `Recommended: ${option}. Risks: ${rc.risks.join("; ") || "none recorded"}.`;
	const escalate = (reason: string, text: string): string => {
		const marked = markEscalated(rc.storeCtx, rc.decisionId, reason);
		return marked.ok ? text : `${text} (The escalation was not recorded: ${marked.reason}.)`;
	};
	let answer: GoalQuestionnaireResult;
	try {
		answer = await rc.deps.ask(rc.proposal.question, rc.proposal.options, rc.recommended, context);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return escalate(`dialog failed: ${message}`, `Decision ${rc.decisionId} escalated: the owner dialog failed (${message}). Treat it as no answer and continue with the normal blocker ladder.`);
	}
	if (answer.unavailable === true) {
		return escalate("no dialog", `Decision ${rc.decisionId} escalated. ${DIALOG_UNAVAILABLE_HINT} No dialog — treat it as no answer and continue with the normal blocker ladder.`);
	}
	if (answer.cancelled) {
		return escalate("dialog cancelled", `Decision ${rc.decisionId} escalated: the owner cancelled the question — treat it as no answer. Continue with the normal blocker ladder.`);
	}
	const picked = answer.answers[0];
	if (picked === undefined) {
		return escalate("no answer", `Decision ${rc.decisionId} escalated: the owner gave no answer. Treat it as no answer and continue with the normal blocker ladder.`);
	}
	return settle(rc, "human", outcomeOf(rc, "human", picked.answer));
}

/** Tool parameters: the proposal plus the zero-based recommended option (TECH §4 input schema). */
const DecisionToolParametersSchema = Type.Object({
	...DecisionProposalSchema.properties,
	recommended: Type.Integer({ minimum: 0, description: "Zero-based index of your recommended option. In bounded-auto this is the option you take." }),
}, { additionalProperties: false });

const DECISION_TOOL_DESCRIPTION = "Resolve a technical fork inside the active goal from the user's original request, instead of asking first. Submit the question, 2-8 options, the zero-based index of your recommended option, the authority basis from the request, facts, unknowns, and risks. Set materialRisk to false only when the choice is clearly reversible and departs from nothing in the request; an absent materialRisk counts as material. The router validates the proposal, runs read-only research or critique when the route needs it, then either returns the decision to continue with (bounded-auto) or asks the owner with your recommendation pre-selected (advisory). Any escalation tells you to ask with goal_question. Forks about money, data deletion, production, or secrets always escalate.";

/** Registers goal_decision on the core's pi. Pi tools cannot be unregistered, so ensureDecisionTool calls this at most once per core. */
export function registerDecisionTool(core: GoalCore): void {
	const { pi } = core;
	pi.registerTool(defineTool({
		name: DECISION_TOOL_NAME,
		label: "Decide Fork",
		description: DECISION_TOOL_DESCRIPTION,
		promptSnippet: "Resolve a technical fork inside the active goal from the original request, recording the rationale, instead of asking first.",
		parameters: DecisionToolParametersSchema,
		async execute(_id, params, signal, _update, ctx) {
			const { recommended, ...proposalInput } = params;
			const text = await executeDecisionTool(proposalInput, recommended, {
				cwd: ctx.cwd,
				storage: goalStorageContext(ctx),
				ctx,
				readGoal: () => decisionGoalView(core.state.goal),
				runConsultant,
				signal,
				accounting: core.accounting,
				ask: async (question, options, recommendedIndex, context) => {
					core.enterGoalModal();
					try {
						return await runGoalQuestionnaire(ctx, [{ id: "decision", question, context, options, recommended: recommendedIndex }]);
					} finally {
						core.exitGoalModal();
					}
				},
			});
			return { content: [{ type: "text", text }], details: goalDetails(core.state.goal) };
		},
		renderCall() { return new Text(DECISION_TOOL_NAME, 0, 0); },
		renderResult(result, options, theme) { return renderGoalResult(result, options, theme); },
	}));
}

function decisionGoalView(goal: GoalRecord | null): DecisionGoalView | null {
	if (!goal) return null;
	return {
		id: goal.id,
		status: goal.status,
		objective: goal.objective,
		generation: goal.scheduler?.generation ?? "",
		...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
		usage: { tokensUsed: goal.usage.tokensUsed },
	};
}

const registeredCores = new WeakSet<GoalCore>();

/**
 * Registers goal_decision the first time a session has both a non-manual decisionMode and an
 * active goal (TECH §4). A manual project, or a session without an active goal, registers nothing,
 * so its tool surface is unchanged. Returns whether the router is enabled; the caller passes that to
 * installGoalToolProfile, which advertises the tool only while the goal is active.
 */
export function ensureDecisionTool(core: GoalCore, cwd: string, env?: NodeJS.ProcessEnv): boolean {
	const enabled = resolveDecisionSettings(cwd, env).mode !== "manual";
	if (enabled && !registeredCores.has(core) && core.state.goal?.status === "active") {
		registerDecisionTool(core);
		registeredCores.add(core);
	}
	return enabled;
}
