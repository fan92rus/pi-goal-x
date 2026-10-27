import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { nowIso } from "./goal-record.ts";
import { GOALS_DIR, atomicWriteGoalFile } from "./storage/goal-files.ts";
import { acquireGoalLock, type GoalLock } from "./storage/goal-lock.ts";
import { goalStoragePath, type GoalStorageContext } from "./storage/goal-root.ts";

/**
 * DecisionRecord schema and per-goal sidecar storage (TECH §3, E2.2).
 *
 * Each goal owns `decisions/<goalId>.json` inside the goal storage root: a JSON
 * array of records, capped at DECISION_LOG_CAP (oldest evicted first). Every
 * mutation is a whole-file atomic replacement made under an exclusive lock and
 * guarded by the record's `revision`: a stale writer gets a typed conflict and
 * nothing is written. Corrupt or foreign files are reported as typed read
 * errors and are never overwritten.
 *
 * The per-goal consultation counter (TECH §5, cross-route cap) lives in its own
 * sidecar `decisions/<goalId>.consultations.json` under the same per-goal
 * decision lock, so the record array format stays unchanged.
 */

export const DECISION_LOG_CAP = 50;
export const DECISIONS_DIR = `${GOALS_DIR}/decisions`;
export const OBJECTIVE_EXCERPT_MAX = 400;

const RouteSchema = Type.Union([
	Type.Literal("direct"),
	Type.Literal("research"),
	Type.Literal("critique"),
	Type.Literal("research+critique"),
	Type.Literal("ask-human"),
]);

const StatusSchema = Type.Union([
	Type.Literal("open"),
	Type.Literal("decided"),
	Type.Literal("escalated"),
	Type.Literal("superseded"),
	Type.Literal("expired"),
	Type.Literal("invalidated"),
]);

const RequestAnchorSchema = Type.Object({
	objectiveExcerpt: Type.String({ maxLength: OBJECTIVE_EXCERPT_MAX }),
	objectiveHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
});

const UsageSchema = Type.Union([
	Type.Object({ tokens: Type.Integer({ minimum: 0 }), seconds: Type.Number({ minimum: 0 }) }),
	Type.Literal("unknown"),
]);

/** One consultant run (researcher or critic). Summaries are capped per TECH §5. */
export const ConsultantResultSchema = Type.Object({
	role: Type.Union([Type.Literal("researcher"), Type.Literal("critic")]),
	childRunId: Type.String({ minLength: 1 }),
	model: Type.String(),
	usage: UsageSchema,
	summary: Type.String({ maxLength: 300 }),
	schemaPayload: Type.Unknown(),
});

const OutcomeSchema = Type.Object({
	chosen: Type.Optional(Type.String()),
	source: Type.Union([Type.Literal("agent"), Type.Literal("human"), Type.Literal("consultant")]),
	risks: Type.Array(Type.String()),
	revisitWhen: Type.Optional(Type.String()),
});

export const DecisionRecordSchema = Type.Object({
	id: Type.String({ pattern: "^dec-[0-9a-f]{12}$" }),
	goalId: Type.String({ minLength: 1 }),
	createdAt: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" }),
	requestAnchor: RequestAnchorSchema,
	policyVersion: Type.String(),
	question: Type.String(),
	options: Type.Array(Type.String()),
	route: RouteSchema,
	routeJustification: Type.Object({
		skipped: Type.Array(Type.String()),
		reasons: Type.Record(Type.String(), Type.String()),
	}),
	authorityBasis: Type.String(),
	facts: Type.Array(Type.String()),
	unknowns: Type.Array(Type.String()),
	consultants: Type.Array(ConsultantResultSchema),
	outcome: Type.Optional(OutcomeSchema),
	status: StatusSchema,
	revision: Type.Integer({ minimum: 0 }),
	generation: Type.String(),
});

export type DecisionRoute = Static<typeof RouteSchema>;
export type DecisionStatus = Static<typeof StatusSchema>;
export type ConsultantResult = Static<typeof ConsultantResultSchema>;
export type DecisionRecord = Static<typeof DecisionRecordSchema>;

/** Who may write each terminal status (single writer per status, TECH §3). */
export type DecisionStatusWriter = "acceptance-guard" | "router" | "archival";

/** Every status other than `open` is terminal; a terminal record never changes status again. */
export const DECISION_STATUS_WRITERS: Readonly<Record<Exclude<DecisionStatus, "open">, DecisionStatusWriter>> = {
	decided: "acceptance-guard",
	invalidated: "acceptance-guard",
	escalated: "router",
	superseded: "router",
	expired: "archival",
};

/**
 * Transition validator: only `open` moves, and only to a terminal status.
 * `superseded` is therefore also only reachable from `open`.
 */
export function isDecisionTransitionAllowed(from: DecisionStatus, to: DecisionStatus): boolean {
	return from === "open" && to !== "open";
}

export interface DecisionRequestAnchor {
	objectiveExcerpt: string;
	objectiveHash: string;
}

/**
 * Authority provenance for a decision: a ≤400-unit excerpt of the trimmed
 * objective plus the sha256 (hex) of the full raw objective for staleness checks.
 */
export function objectiveAnchor(objective: string): DecisionRequestAnchor {
	let excerpt = objective.trim().slice(0, OBJECTIVE_EXCERPT_MAX);
	// Never keep a lone high surrogate at the cut point.
	if (excerpt.length === OBJECTIVE_EXCERPT_MAX && /[\uD800-\uDBFF]$/.test(excerpt)) excerpt = excerpt.slice(0, -1);
	return {
		objectiveExcerpt: excerpt,
		objectiveHash: createHash("sha256").update(objective, "utf8").digest("hex"),
	};
}

export type DecisionStoreErrorCode =
	| "invalid-input"
	| "corrupt"
	| "foreign"
	| "io"
	| "locked"
	| "not-found"
	| "conflict"
	| "invalid-transition"
	| "forbidden-writer"
	| "capped";

export interface DecisionStoreError {
	code: DecisionStoreErrorCode;
	message: string;
	/** Present on `conflict`: the revision currently stored for the record. */
	currentRevision?: number;
}

export type DecisionStoreResult<T> = { ok: true; value: T } | { ok: false; error: DecisionStoreError };

/** Caller-supplied fields; id, goalId, createdAt, status and revision are assigned by the store. */
export interface DecisionDraft extends Omit<DecisionRecord, "id" | "goalId" | "createdAt" | "requestAnchor" | "status" | "revision"> {
	/** Goal objective at decision time; only its excerpt and hash are persisted. */
	objective: string;
}

const GOAL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const IDENTITY_FIELDS = ["id", "goalId", "createdAt", "requestAnchor"] as const;

function ok<T>(value: T): DecisionStoreResult<T> {
	return { ok: true, value };
}

function fail<T>(code: DecisionStoreErrorCode, message: string, currentRevision?: number): DecisionStoreResult<T> {
	return { ok: false, error: { code, message, ...(currentRevision === undefined ? {} : { currentRevision }) } };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Converts unexpected throws (path/root resolution, filesystem) into a typed `io` error. */
function guarded<T>(run: () => DecisionStoreResult<T>): DecisionStoreResult<T> {
	try {
		return run();
	} catch (error) {
		return fail("io", errorMessage(error));
	}
}

function invalidGoalId<T>(goalId: string): DecisionStoreResult<T> {
	return fail("invalid-input", `Invalid goal id for decision storage: ${JSON.stringify(goalId)}.`);
}

function recordProblem(value: unknown): string | undefined {
	for (const error of Value.Errors(DecisionRecordSchema, value)) return `${error.instancePath || "/"}: ${error.message}`;
	return undefined;
}

function decisionFileRel(goalId: string): string {
	return `${DECISIONS_DIR}/${goalId}.json`;
}

function consultationFileRel(goalId: string): string {
	return `${DECISIONS_DIR}/${goalId}.consultations.json`;
}

function newDecisionId(): string {
	return `dec-${randomBytes(6).toString("hex")}`;
}

/** Missing file reads as an empty list; anything unparseable or foreign is a typed error. */
function readDecisionFile(ctx: GoalStorageContext, goalId: string): DecisionStoreResult<DecisionRecord[]> {
	const filePath = goalStoragePath(ctx, decisionFileRel(goalId));
	let text: string;
	try {
		if (fs.lstatSync(filePath).isSymbolicLink()) return fail("io", `Refusing symlinked decision file for goal ${goalId}.`);
		text = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
		return fail("io", errorMessage(error));
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return fail("corrupt", `Decision file for goal ${goalId} is not valid JSON.`);
	}
	if (!Array.isArray(parsed)) return fail("corrupt", `Decision file for goal ${goalId} must contain a JSON array.`);
	for (const [index, entry] of parsed.entries()) {
		const problem = recordProblem(entry);
		if (problem) return fail("corrupt", `Decision ${index} in goal ${goalId} is invalid: ${problem}`);
		if (entry.goalId !== goalId) return fail("foreign", `Decision ${index} in goal ${goalId} belongs to goal ${String(entry.goalId)}.`);
	}
	return ok(parsed as DecisionRecord[]);
}

/** Whole-file atomic replacement (temp + rename, see goal-files.ts). Returns the error, if any. */
function writeDecisionFile(ctx: GoalStorageContext, goalId: string, records: DecisionRecord[]): DecisionStoreError | null {
	try {
		atomicWriteGoalFile(ctx, DECISIONS_DIR, decisionFileRel(goalId), `${JSON.stringify(records, null, 2)}\n`);
		return null;
	} catch (error) {
		return { code: "io", message: errorMessage(error) };
	}
}

/**
 * Exclusive per-goal decision lock, separate from the goal mutation lock so
 * decision writes never make goal mutations fail fast on contention.
 */
function withDecisionLock<T>(ctx: GoalStorageContext, goalId: string, run: () => DecisionStoreResult<T>): DecisionStoreResult<T> {
	let lock: GoalLock;
	try {
		lock = acquireGoalLock(ctx, `${goalId}.decisions`);
	} catch (error) {
		return fail("locked", `Decision store for goal ${goalId} is busy: ${errorMessage(error)}`);
	}
	try {
		return run();
	} finally {
		lock.release();
	}
}

/** Read-modify-write of one record under the lock; `next` builds the replacement from the current record. */
function commitDecision(
	ctx: GoalStorageContext,
	goalId: string,
	id: string,
	expectedRevision: number,
	next: (current: DecisionRecord) => DecisionStoreResult<DecisionRecord>,
): DecisionStoreResult<DecisionRecord> {
	return guarded(() => {
		if (!GOAL_ID_PATTERN.test(goalId)) return invalidGoalId(goalId);
		return withDecisionLock(ctx, goalId, () => {
			const listed = readDecisionFile(ctx, goalId);
			if (!listed.ok) return listed;
			const records = listed.value;
			const index = records.findIndex((record) => record.id === id);
			const current = records[index];
			if (!current) return fail("not-found", `No decision ${id} for goal ${goalId}.`);
			if (current.revision !== expectedRevision) {
				return fail("conflict", `Decision ${id} is at revision ${current.revision}, not ${expectedRevision}.`, current.revision);
			}
			const built = next(current);
			if (!built.ok) return built;
			const replacement: DecisionRecord = { ...built.value, revision: current.revision + 1 };
			const problem = recordProblem(replacement);
			if (problem) return fail("invalid-input", `Decision ${id} failed validation: ${problem}`);
			records[index] = replacement;
			const written = writeDecisionFile(ctx, goalId, records);
			if (written) return { ok: false, error: written };
			return ok(replacement);
		});
	});
}

/**
 * Appends a new `open` record at revision 0 and evicts the oldest records beyond
 * DECISION_LOG_CAP. Nothing is written when the draft fails validation.
 */
export function createDecision(ctx: GoalStorageContext, goalId: string, draft: DecisionDraft): DecisionStoreResult<DecisionRecord> {
	return guarded(() => {
		if (!GOAL_ID_PATTERN.test(goalId)) return invalidGoalId(goalId);
		const { objective, ...fields } = draft;
		return withDecisionLock(ctx, goalId, () => {
			const listed = readDecisionFile(ctx, goalId);
			if (!listed.ok) return listed;
			const records = listed.value;
			const taken = new Set(records.map((record) => record.id));
			let id = newDecisionId();
			while (taken.has(id)) id = newDecisionId();
			const record: DecisionRecord = {
				...fields,
				id,
				goalId,
				createdAt: nowIso(),
				requestAnchor: objectiveAnchor(objective),
				status: "open",
				revision: 0,
			};
			const problem = recordProblem(record);
			if (problem) return fail("invalid-input", `Decision draft failed validation: ${problem}`);
			records.push(record);
			records.splice(0, Math.max(0, records.length - DECISION_LOG_CAP));
			const written = writeDecisionFile(ctx, goalId, records);
			if (written) return { ok: false, error: written };
			return ok(record);
		});
	});
}

/** Lock-free read: atomic replacement means readers see the old or the new file, never a partial one. */
export function getDecisions(ctx: GoalStorageContext, goalId: string): DecisionStoreResult<DecisionRecord[]> {
	return guarded(() => {
		if (!GOAL_ID_PATTERN.test(goalId)) return invalidGoalId(goalId);
		return readDecisionFile(ctx, goalId);
	});
}

/**
 * Replaces the record's content under the revision check. `mutate` receives a
 * clone; it may not change identity fields (id, goalId, createdAt, requestAnchor)
 * or `status` (use setDecisionStatus). The stored revision is bumped by the store.
 */
export function updateDecision(
	ctx: GoalStorageContext,
	goalId: string,
	id: string,
	mutate: (draft: DecisionRecord) => DecisionRecord,
	expectedRevision: number,
): DecisionStoreResult<DecisionRecord> {
	return commitDecision(ctx, goalId, id, expectedRevision, (current) => {
		let next: DecisionRecord;
		try {
			next = mutate(structuredClone(current));
		} catch (error) {
			return fail("invalid-input", `Decision mutation failed: ${errorMessage(error)}`);
		}
		if (next.status !== current.status) return fail("invalid-transition", "Decision status changes go through setDecisionStatus.");
		for (const field of IDENTITY_FIELDS) {
			if (!isDeepStrictEqual(next[field], current[field])) return fail("invalid-input", `Decision ${field} is immutable.`);
		}
		return ok(next);
	});
}

export interface DecisionStatusRequest {
	/** Caller role; must be the single writer allowed for the target status. */
	writer: DecisionStatusWriter;
	expectedRevision: number;
}

/**
 * Moves an `open` record to a terminal status. Rejected: `open` as target,
 * writers other than the status owner (`forbidden-writer`), and any move from a
 * terminal status (`invalid-transition`).
 */
export function setDecisionStatus(
	ctx: GoalStorageContext,
	goalId: string,
	id: string,
	status: DecisionStatus,
	request: DecisionStatusRequest,
): DecisionStoreResult<DecisionRecord> {
	if (status === "open") return fail("invalid-transition", "Decisions cannot return to open.");
	const owner = DECISION_STATUS_WRITERS[status];
	if (owner !== request.writer) return fail("forbidden-writer", `Only ${owner} may set decision status ${status}.`);
	return commitDecision(ctx, goalId, id, request.expectedRevision, (current) => {
		if (!isDecisionTransitionAllowed(current.status, status)) {
			return fail("invalid-transition", `Decision ${id} cannot move from ${current.status} to ${status}.`);
		}
		return ok({ ...current, status });
	});
}

// ── per-goal consultation counter (TECH §5 cross-route cap) ─────────────────

const ConsultationCounterSchema = Type.Object({
	goalId: Type.String({ minLength: 1 }),
	consultationsLaunched: Type.Integer({ minimum: 0 }),
});

/** Launch count after an update, and the cap it is measured against. `capped` means launched >= cap. */
export interface ConsultationCount {
	launched: number;
	cap: number;
	capped: boolean;
}

/** Missing file reads as zero launches; anything unparseable or foreign is a typed error. */
function readConsultationFile(ctx: GoalStorageContext, goalId: string): DecisionStoreResult<number> {
	const filePath = goalStoragePath(ctx, consultationFileRel(goalId));
	let text: string;
	try {
		if (fs.lstatSync(filePath).isSymbolicLink()) return fail("io", `Refusing symlinked consultation counter for goal ${goalId}.`);
		text = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok(0);
		return fail("io", errorMessage(error));
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return fail("corrupt", `Consultation counter for goal ${goalId} is not valid JSON.`);
	}
	for (const error of Value.Errors(ConsultationCounterSchema, parsed)) {
		return fail("corrupt", `Consultation counter for goal ${goalId} is invalid: ${error.instancePath || "/"}: ${error.message}`);
	}
	const counter = parsed as { goalId: string; consultationsLaunched: number };
	if (counter.goalId !== goalId) return fail("foreign", `Consultation counter for goal ${goalId} belongs to goal ${counter.goalId}.`);
	return ok(counter.consultationsLaunched);
}

function writeConsultationFile(ctx: GoalStorageContext, goalId: string, launched: number): DecisionStoreError | null {
	try {
		atomicWriteGoalFile(ctx, DECISIONS_DIR, consultationFileRel(goalId), `${JSON.stringify({ goalId, consultationsLaunched: launched }, null, 2)}\n`);
		return null;
	} catch (error) {
		return { code: "io", message: errorMessage(error) };
	}
}

/** Lock-free read of the goal's launch count (atomic replacement: readers see old or new, never partial). */
export function getConsultationsLaunched(ctx: GoalStorageContext, goalId: string): DecisionStoreResult<number> {
	return guarded(() => {
		if (!GOAL_ID_PATTERN.test(goalId)) return invalidGoalId(goalId);
		return readConsultationFile(ctx, goalId);
	});
}

/** Read-modify-write of the counter under the per-goal decision lock. */
function commitConsultations(ctx: GoalStorageContext, goalId: string, cap: number, n: number, enforceCap: boolean): DecisionStoreResult<ConsultationCount> {
	return guarded(() => {
		if (!GOAL_ID_PATTERN.test(goalId)) return invalidGoalId(goalId);
		if (!Number.isSafeInteger(n) || n < 1) return fail("invalid-input", `Consultation increment must be a positive integer, got ${n}.`);
		if (!Number.isSafeInteger(cap) || cap < 1) return fail("invalid-input", `Consultation cap must be a positive integer, got ${cap}.`);
		return withDecisionLock(ctx, goalId, () => {
			const current = readConsultationFile(ctx, goalId);
			if (!current.ok) return current;
			const launched = current.value + n;
			if (enforceCap && launched > cap) return fail("capped", `consultation cap reached (${current.value}/${cap})`);
			const written = writeConsultationFile(ctx, goalId, launched);
			if (written) return { ok: false, error: written };
			return ok({ launched, cap, capped: launched >= cap });
		});
	});
}

/**
 * Counts `n` consultant launches unconditionally (oracle path, TECH §7). The
 * cap is only reported (`capped`); the caller decides what to do with it.
 */
export function incrementConsultations(ctx: GoalStorageContext, goalId: string, cap: number, n = 1): DecisionStoreResult<ConsultationCount> {
	return commitConsultations(ctx, goalId, cap, n, false);
}

/**
 * Counts `n` consultant launches only if they all fit under `cap` (router path).
 * On overflow nothing is written and the failure has code `capped`.
 */
export function reserveConsultations(ctx: GoalStorageContext, goalId: string, cap: number, n = 1): DecisionStoreResult<ConsultationCount> {
	return commitConsultations(ctx, goalId, cap, n, true);
}
