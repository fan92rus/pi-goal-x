/**
 * Runtime acceptance guard (specs/2026-10-27-adaptive-decisions, TECH §6, E5.1).
 *
 * A consultant result may influence a decision only while every binding it was
 * launched under still holds. `acceptConsultantResult` checks, in order:
 *
 *   - identity: the record exists, its decisionId is the goal's activeDecisionId,
 *     the record is still `open`, and this childRunId is not already settled in
 *     the record (idempotent: a duplicate is ignored, never re-applied);
 *   - bindings (fresh at acceptance): goal status is `active` (not paused or
 *     otherwise stopped); the project settings file is re-read from disk, its
 *     mode is not `manual`, and its snapshot id equals the record's policyVersion;
 *     the current objective hash equals the record's requestAnchor.objectiveHash;
 *     the current scheduler generation equals the record's generation;
 *   - delivery: not past the launch deadline; the consultant run succeeded and its
 *     payload passes the role schema.
 *
 * Stale, duplicate, out-of-order, and terminal-record deliveries are ignored and
 * write nothing. A result that arrives for the current decision but fails a
 * binding or the delivery checks invalidates the record (`invalidated`; the
 * acceptance guard is its only writer). Acceptance itself writes nothing: the
 * caller persists the accepted result (and any `decided` status) afterwards.
 *
 * Cancelling in-flight children on pause, accounting, and the resolution text
 * belong to later stages; this module only decides whether a result is accepted.
 */

import { Value } from "typebox/value";
import {
	CriticPayloadSchema,
	ResearcherPayloadSchema,
	type ConsultantRole,
	type ConsultantRunResult,
	type CriticPayload,
	type ResearcherPayload,
} from "./goal-decision-consultant.ts";
import { readModeFreshFromDisk, type GoalDecisionMode } from "./goal-decision-policy.ts";
import { getDecisions, objectiveAnchor, setDecisionStatus, type DecisionRecord } from "./goal-decision-record.ts";
import type { GoalStatus } from "./goal-record.ts";
import type { GoalStorageContext } from "./storage/goal-root.ts";

/** Goal state read at acceptance time. `generation` is the scheduler generation (undefined when the goal has no scheduler state). */
export interface GoalAcceptanceView {
	status: GoalStatus;
	objective: string;
	activeDecisionId?: string;
	generation?: string;
}

/** What the launcher captured when the consultant was started. */
export interface ConsultantLaunchBinding {
	decisionId: string;
	childRunId: string;
	role: ConsultantRole;
	/** Epoch milliseconds after which the result is no longer accepted (launch time + consultantDeadlineMs). */
	deadlineAt: number;
}

export interface AcceptanceInput {
	storage: GoalStorageContext;
	goalId: string;
	/** Project root whose settings file is re-read from disk (cache-bypassing). */
	cwd: string;
	env?: NodeJS.ProcessEnv;
	goal: GoalAcceptanceView;
	launch: ConsultantLaunchBinding;
	result: ConsultantRunResult<ConsultantRole>;
	/** Epoch milliseconds; defaults to Date.now(). */
	now?: number;
}

export type IgnoredReason = "unknown-decision" | "stale-decision" | "not-open" | "duplicate";

export type InvalidationReason =
	| "goal-not-active"
	| "mode-manual"
	| "settings-snapshot"
	| "objective-changed"
	| "generation-changed"
	| "deadline-exceeded"
	| "consultant-failed"
	| "schema-invalid";

export type AcceptanceVerdict =
	| { kind: "accepted"; decisionId: string; childRunId: string; role: ConsultantRole; payload: ResearcherPayload | CriticPayload; mode: GoalDecisionMode }
	| { kind: "ignored"; reason: IgnoredReason }
	| { kind: "invalidated"; reason: InvalidationReason; detail: string }
	| { kind: "store-error"; reason: string };

const PAYLOAD_SCHEMAS = {
	researcher: ResearcherPayloadSchema,
	critic: CriticPayloadSchema,
} as const;

interface Problem {
	reason: InvalidationReason;
	detail: string;
}

type FreshSettings = ReturnType<typeof readModeFreshFromDisk>;

/**
 * Checks that the goal, settings, objective, and generation still match the record.
 * `settings` is the project settings read fresh from disk by the caller.
 */
function bindingProblem(input: AcceptanceInput, record: DecisionRecord, settings: FreshSettings): Problem | undefined {
	const { goal } = input;
	if (goal.status !== "active") return { reason: "goal-not-active", detail: `goal status is ${goal.status}` };
	if (settings.mode === "manual") return { reason: "mode-manual", detail: "decisionMode is manual" };
	if (settings.snapshotId !== record.policyVersion) {
		return { reason: "settings-snapshot", detail: `settings snapshot ${settings.snapshotId} differs from ${record.policyVersion}` };
	}
	if (objectiveAnchor(goal.objective).objectiveHash !== record.requestAnchor.objectiveHash) {
		return { reason: "objective-changed", detail: "goal objective changed since the decision" };
	}
	if (goal.generation !== record.generation) {
		return { reason: "generation-changed", detail: "goal scheduler generation changed since the decision" };
	}
	return undefined;
}

/** Deadline, run success, and role schema of the delivered result. Narrows to the validated payload on success. */
function deliveredPayload(input: AcceptanceInput): { ok: true; payload: ResearcherPayload | CriticPayload } | { ok: false; problem: Problem } {
	const { launch, result } = input;
	const now = input.now ?? Date.now();
	if (now > launch.deadlineAt) {
		return { ok: false, problem: { reason: "deadline-exceeded", detail: `result arrived ${now - launch.deadlineAt} ms after the deadline` } };
	}
	if (!result.ok) return { ok: false, problem: { reason: "consultant-failed", detail: `${result.errorCode}: ${result.message}` } };
	const schema = PAYLOAD_SCHEMAS[launch.role];
	if (!Value.Check(schema, result.payload)) {
		const [first] = Value.Errors(schema, result.payload);
		return { ok: false, problem: { reason: "schema-invalid", detail: `${first?.instancePath || "/"}: ${first?.message ?? "does not match the role schema"}` } };
	}
	return { ok: true, payload: result.payload as ResearcherPayload | CriticPayload };
}

/**
 * Decides whether a consultant result may be accepted for the goal's active
 * decision. See the module comment for the order of checks and the write rules.
 */
export function acceptConsultantResult(input: AcceptanceInput): AcceptanceVerdict {
	const { storage, goalId, launch, goal } = input;
	const listed = getDecisions(storage, goalId);
	if (!listed.ok) return { kind: "store-error", reason: `decision store ${listed.error.code}: ${listed.error.message}` };

	const record = listed.value.find((candidate) => candidate.id === launch.decisionId);
	if (!record) return { kind: "ignored", reason: "unknown-decision" };
	if (goal.activeDecisionId !== record.id) return { kind: "ignored", reason: "stale-decision" };
	if (record.status !== "open") return { kind: "ignored", reason: "not-open" };
	if (record.consultants.some((entry) => entry.childRunId === launch.childRunId)) return { kind: "ignored", reason: "duplicate" };

	const settings = readModeFreshFromDisk(input.cwd, input.env);
	const binding = bindingProblem(input, record, settings);
	if (binding) return invalidate(input, record, binding);
	const delivered = deliveredPayload(input);
	if (!delivered.ok) return invalidate(input, record, delivered.problem);
	return {
		kind: "accepted",
		decisionId: record.id,
		childRunId: launch.childRunId,
		role: launch.role,
		payload: delivered.payload,
		mode: settings.mode,
	};
}

/** Moves the open record to `invalidated` (acceptance guard is its only writer). A concurrent change is a store error, nothing else. */
function invalidate(input: AcceptanceInput, record: DecisionRecord, problem: Problem): AcceptanceVerdict {
	const written = setDecisionStatus(input.storage, input.goalId, record.id, "invalidated", { writer: "acceptance-guard", expectedRevision: record.revision });
	if (!written.ok) return { kind: "store-error", reason: `decision store ${written.error.code}: ${written.error.message}` };
	return { kind: "invalidated", reason: problem.reason, detail: problem.detail };
}
