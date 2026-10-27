/**
 * Decision journal (specs/2026-10-27-adaptive-decisions, TECH §8, E6.3).
 *
 * Every terminal state of a DecisionRecord is journaled as one `decision_recorded`
 * ledger event: the per-resolution log entry of PRODUCT "User-facing surface"
 * (route and why, link to the original request, chosen option, source, key risks,
 * consultant tokens spent, revisit condition). The record stays the authority; the
 * ledger append is best-effort, so a failed append is reported and changes nothing
 * else. Text fields are capped here at the write boundary (TECH §5: ≤300 chars).
 */

import { appendGoalEvent, type GoalLedgerEvent } from "./goal-ledger.ts";
import { getDecisions, type DecisionRecord } from "./goal-decision-record.ts";
import { nowIso } from "./goal-record.ts";
import type { GoalStorageContext } from "./storage/goal-root.ts";

const JOURNAL_TEXT_MAX = 300;

function capText(text: string): string {
	return text.length <= JOURNAL_TEXT_MAX ? text : `${text.slice(0, JOURNAL_TEXT_MAX - 1)}…`;
}

/**
 * Journal entry for a record in a terminal state; undefined while the record is `open`.
 * `reason` explains an invalidation or cancellation (it is not stored on the record). An
 * escalated record's reason is the one stored in routeJustification when none is passed.
 */
export function decisionJournalEvent(record: DecisionRecord, reason?: string, at: string = nowIso()): GoalLedgerEvent | undefined {
	if (record.status === "open") return undefined;
	const { outcome } = record;
	const routeWhy = Object.entries(record.routeJustification.reasons)
		.filter(([key]) => key !== "ask-human")
		.map(([route, why]) => capText(`${route}: ${why}`))
		.join("; ");
	const consultantTokens = record.consultants.reduce<number | "unknown">((sum, entry) => (
		sum === "unknown" || entry.usage === "unknown" ? "unknown" : sum + entry.usage.tokens
	), 0);
	const explicitReason = reason ?? (record.status === "escalated" ? record.routeJustification.reasons["ask-human"] : undefined);
	return {
		type: "decision_recorded",
		goalId: record.goalId,
		decisionId: record.id,
		status: record.status,
		route: record.route,
		question: capText(record.question),
		authorityBasis: capText(record.authorityBasis),
		routeWhy,
		requestHash: record.requestAnchor.objectiveHash.slice(0, 16),
		...(outcome?.chosen === undefined ? {} : { chosen: capText(outcome.chosen) }),
		...(outcome === undefined ? {} : { source: outcome.source }),
		risks: (outcome?.risks ?? []).map(capText),
		...(outcome?.revisitWhen === undefined ? {} : { revisitWhen: capText(outcome.revisitWhen) }),
		consultantTokens,
		...(explicitReason === undefined ? {} : { reason: capText(explicitReason) }),
		at,
	};
}

/**
 * Appends the journal entry of one record. Returns `{ ok: false }` when the record cannot be
 * read or appended, or is still open; the caller keeps its own outcome either way.
 */
export function journalDecision(storage: GoalStorageContext, goalId: string, decisionId: string, reason?: string): { ok: true } | { ok: false; reason: string } {
	const listed = getDecisions(storage, goalId);
	if (!listed.ok) return { ok: false, reason: `decision store ${listed.error.code}: ${listed.error.message}` };
	const record = listed.value.find((candidate) => candidate.id === decisionId);
	if (!record) return { ok: false, reason: `decision ${decisionId} not found` };
	const event = decisionJournalEvent(record, reason);
	if (!event) return { ok: false, reason: `decision ${decisionId} is still open` };
	const appended = appendGoalEvent(storage, event);
	return appended.ok ? { ok: true } : { ok: false, reason: `ledger append failed: ${String(appended.error)}` };
}
