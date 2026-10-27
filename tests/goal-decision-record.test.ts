import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	DECISION_LOG_CAP,
	DECISIONS_DIR,
	buildDecisionFingerprint,
	createDecision,
	getConsultationsLaunched,
	getDecisions,
	incrementConsultations,
	isDecisionTransitionAllowed,
	objectiveAnchor,
	reserveConsultations,
	setDecisionStatus,
	updateDecision,
	type DecisionDraft,
	type DecisionRecord,
	type DecisionStatus,
	type DecisionStatusWriter,
	type DecisionStoreResult,
} from "../extensions/goal-decision-record.ts";
import { buildBlockerFingerprint } from "../extensions/goal-oracle.ts";
import { createGoal } from "../extensions/goal-record.ts";
import { acquireGoalLock } from "../extensions/storage/goal-lock.ts";

const OBJECTIVE = "Migrate the storage layer to the new schema";
const GOAL = "goal-a";
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function tempCtx(t: test.TestContext): { cwd: string } {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-decisions-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return { cwd };
}

function draft(question = "Use WAL mode?", overrides: Partial<DecisionDraft> = {}): DecisionDraft {
	return {
		objective: OBJECTIVE,
		policyVersion: "policy-1",
		question,
		options: ["yes", "no"],
		route: "research",
		routeJustification: { skipped: ["critique"], reasons: { critique: "reversible local choice" } },
		authorityBasis: "The request asks for the migration end to end.",
		facts: ["repo uses sqlite"],
		unknowns: ["write volume"],
		consultants: [],
		generation: "gen-1",
		...overrides,
	};
}

function okValue<T>(result: DecisionStoreResult<T>): T {
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

function failure<T>(result: DecisionStoreResult<T>): { code: string; message: string; currentRevision?: number } {
	if (result.ok) throw new Error("expected a typed failure, got ok");
	return result.error;
}

function sidecarPath(ctx: { cwd: string }, goalId: string): string {
	return path.join(ctx.cwd, DECISIONS_DIR, `${goalId}.json`);
}

/** Reads the sidecar straight from disk: must always be a parseable JSON array with no temp leftovers. */
function assertDiskValid(ctx: { cwd: string }, goalId: string): DecisionRecord[] {
	const parsed: unknown = JSON.parse(readFileSync(sidecarPath(ctx, goalId), "utf8"));
	assert.ok(Array.isArray(parsed), "sidecar must be a JSON array");
	const leftovers = readdirSync(path.join(ctx.cwd, DECISIONS_DIR)).filter(name => name.endsWith(".tmp"));
	assert.deepEqual(leftovers, [], "no temp files may survive a mutation");
	return parsed as DecisionRecord[];
}

test("create then get round-trips the record with anchor, open status and revision 0", t => {
	const ctx = tempCtx(t);
	const created = okValue(createDecision(ctx, GOAL, draft()));
	assert.match(created.id, /^dec-[0-9a-f]{12}$/);
	assert.equal(created.goalId, GOAL);
	assert.match(created.createdAt, ISO_PATTERN);
	assert.equal(created.status, "open");
	assert.equal(created.revision, 0);
	assert.equal(created.generation, "gen-1");
	assert.deepEqual(created.requestAnchor, objectiveAnchor(OBJECTIVE));
	assert.deepEqual(okValue(getDecisions(ctx, GOAL)), [created]);
	assert.deepEqual(assertDiskValid(ctx, GOAL), [created]);
	assert.deepEqual(okValue(getDecisions(ctx, "never-written")), []);
	assert.equal(existsSync(sidecarPath(ctx, "never-written")), false, "reads never create a sidecar");
});

test("the log is capped at 50 and the oldest records are evicted first", t => {
	const ctx = tempCtx(t);
	assert.equal(DECISION_LOG_CAP, 50);
	const ids: string[] = [];
	for (let i = 0; i < DECISION_LOG_CAP + 2; i++) {
		ids.push(okValue(createDecision(ctx, GOAL, draft(`Q${i}`))).id);
		assertDiskValid(ctx, GOAL);
	}
	const listed = okValue(getDecisions(ctx, GOAL));
	assert.equal(listed.length, DECISION_LOG_CAP);
	assert.deepEqual(listed.map(record => record.id), ids.slice(2));
	assert.equal(listed[0]?.question, "Q2");
	assert.equal(listed[DECISION_LOG_CAP - 1]?.question, `Q${DECISION_LOG_CAP + 1}`);
});

test("two updates with the same expectedRevision: the second gets a typed conflict and the file stays intact", t => {
	const ctx = tempCtx(t);
	const created = okValue(createDecision(ctx, GOAL, draft()));
	const first = okValue(updateDecision(ctx, GOAL, created.id, record => ({ ...record, facts: [...record.facts, "first"] }), 0));
	assert.equal(first.revision, 1);
	assert.deepEqual(assertDiskValid(ctx, GOAL)[0]?.facts, ["repo uses sqlite", "first"]);

	const second = failure(updateDecision(ctx, GOAL, created.id, record => ({ ...record, facts: [...record.facts, "second"] }), 0));
	assert.equal(second.code, "conflict");
	assert.equal(second.currentRevision, 1);
	const onDisk = assertDiskValid(ctx, GOAL);
	assert.equal(onDisk[0]?.revision, 1);
	assert.deepEqual(onDisk[0]?.facts, ["repo uses sqlite", "first"], "the losing write must not be partially applied");

	const staleStatus = failure(setDecisionStatus(ctx, GOAL, created.id, "decided", { writer: "acceptance-guard", expectedRevision: 0 }));
	assert.equal(staleStatus.code, "conflict");
	assert.equal(staleStatus.currentRevision, 1);
	assert.equal(assertDiskValid(ctx, GOAL)[0]?.status, "open");
});

test("corrupt and foreign sidecars are typed read errors and are never overwritten", t => {
	const ctx = tempCtx(t);
	const created = okValue(createDecision(ctx, GOAL, draft()));
	const file = sidecarPath(ctx, GOAL);

	const corruptSamples = [
		"{not json",
		JSON.stringify({ version: 1 }),
		JSON.stringify([{ id: "x" }]),
		JSON.stringify([{ ...created, status: "maybe" }]),
	];
	for (const sample of corruptSamples) {
		writeFileSync(file, sample);
		assert.equal(failure(getDecisions(ctx, GOAL)).code, "corrupt", sample);
		assert.equal(failure(createDecision(ctx, GOAL, draft())).code, "corrupt", sample);
		assert.equal(failure(updateDecision(ctx, GOAL, created.id, record => record, 0)).code, "corrupt", sample);
		assert.equal(readFileSync(file, "utf8"), sample, "a corrupt file must be left untouched");
	}

	const foreign = okValue(createDecision(ctx, "goal-b", draft("other goal's question")));
	writeFileSync(file, JSON.stringify([foreign]));
	assert.equal(failure(getDecisions(ctx, GOAL)).code, "foreign");
	assert.equal(failure(createDecision(ctx, GOAL, draft())).code, "foreign");
	assert.equal(JSON.parse(readFileSync(file, "utf8"))[0].goalId, "goal-b");
});

test("status transitions: only open moves, only to terminal, and each terminal status has one writer", t => {
	const cases: Array<[DecisionStatus, DecisionStatusWriter]> = [
		["decided", "acceptance-guard"],
		["invalidated", "acceptance-guard"],
		["escalated", "router"],
		["superseded", "router"],
		["expired", "archival"],
	];
	for (const [status, writer] of cases) {
		const ctx = tempCtx(t);
		const created = okValue(createDecision(ctx, GOAL, draft()));
		const moved = okValue(setDecisionStatus(ctx, GOAL, created.id, status, { writer, expectedRevision: 0 }));
		assert.equal(moved.status, status);
		assert.equal(moved.revision, 1);
		assert.equal(assertDiskValid(ctx, GOAL)[0]?.status, status);
	}

	const ctx = tempCtx(t);
	const created = okValue(createDecision(ctx, GOAL, draft()));
	assert.equal(failure(setDecisionStatus(ctx, GOAL, created.id, "superseded", { writer: "acceptance-guard", expectedRevision: 0 })).code, "forbidden-writer");
	assert.equal(failure(setDecisionStatus(ctx, GOAL, created.id, "decided", { writer: "router", expectedRevision: 0 })).code, "forbidden-writer");
	assert.equal(failure(setDecisionStatus(ctx, GOAL, created.id, "open", { writer: "acceptance-guard", expectedRevision: 0 })).code, "invalid-transition");
	assert.equal(assertDiskValid(ctx, GOAL)[0]?.status, "open");

	okValue(setDecisionStatus(ctx, GOAL, created.id, "decided", { writer: "acceptance-guard", expectedRevision: 0 }));
	assert.equal(failure(setDecisionStatus(ctx, GOAL, created.id, "open", { writer: "acceptance-guard", expectedRevision: 1 })).code, "invalid-transition");
	assert.equal(failure(setDecisionStatus(ctx, GOAL, created.id, "escalated", { writer: "router", expectedRevision: 1 })).code, "invalid-transition");
	assert.equal(failure(setDecisionStatus(ctx, GOAL, created.id, "invalidated", { writer: "acceptance-guard", expectedRevision: 1 })).code, "invalid-transition");
	const stored = assertDiskValid(ctx, GOAL);
	assert.equal(stored[0]?.status, "decided", "a terminal record never changes");
	assert.equal(stored[0]?.revision, 1);
});

test("transition table: open to any terminal is allowed, everything else is not", () => {
	const all: DecisionStatus[] = ["open", "decided", "escalated", "superseded", "expired", "invalidated"];
	for (const from of all) {
		for (const to of all) {
			assert.equal(isDecisionTransitionAllowed(from, to), from === "open" && to !== "open", `${from} -> ${to}`);
		}
	}
});

test("updateDecision cannot smuggle a status change or rewrite identity fields", t => {
	const ctx = tempCtx(t);
	const created = okValue(createDecision(ctx, GOAL, draft()));
	assert.equal(failure(updateDecision(ctx, GOAL, created.id, record => ({ ...record, status: "decided" }), 0)).code, "invalid-transition");
	assert.equal(failure(updateDecision(ctx, GOAL, created.id, record => ({ ...record, id: "dec-000000000000" }), 0)).code, "invalid-input");
	assert.equal(failure(updateDecision(ctx, GOAL, created.id, record => ({ ...record, requestAnchor: objectiveAnchor("other") }), 0)).code, "invalid-input");
	assert.equal(failure(updateDecision(ctx, GOAL, created.id, record => ({ ...record, route: "bogus" as never }), 0)).code, "invalid-input");
	assert.equal(failure(updateDecision(ctx, GOAL, created.id, () => { throw new Error("boom"); }, 0)).code, "invalid-input");
	assert.equal(failure(updateDecision(ctx, GOAL, "dec-111111111111", record => record, 0)).code, "not-found");
	assert.deepEqual(assertDiskValid(ctx, GOAL), [created]);
	okValue(updateDecision(ctx, GOAL, created.id, record => ({ ...record, outcome: { source: "agent", risks: ["none"] } }), 0));
	assert.equal(assertDiskValid(ctx, GOAL)[0]?.outcome?.source, "agent");
});

test("objective excerpt is capped at 400 and the sha256 hash is stable", t => {
	assert.deepEqual(objectiveAnchor("abc"), {
		objectiveExcerpt: "abc",
		objectiveHash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
	});
	const long = "a".repeat(1000);
	const anchor = objectiveAnchor(long);
	assert.equal(anchor.objectiveExcerpt.length, 400);
	assert.equal(anchor.objectiveExcerpt, "a".repeat(400));
	assert.equal(anchor.objectiveHash, createHash("sha256").update(long).digest("hex"));
	assert.deepEqual(objectiveAnchor(long), anchor, "same objective, same anchor");
	assert.notEqual(objectiveAnchor(`${long}b`).objectiveHash, anchor.objectiveHash, "hash covers the full objective, not only the excerpt");

	assert.equal(objectiveAnchor("  hi \n").objectiveExcerpt, "hi");
	const surrogateCut = `${"a".repeat(399)}\u{1F600}`;
	assert.equal(objectiveAnchor(surrogateCut).objectiveExcerpt, "a".repeat(399), "a cut must not leave a lone high surrogate");

	const ctx = tempCtx(t);
	const created = okValue(createDecision(ctx, GOAL, draft("long objective", { objective: long })));
	assert.equal(created.requestAnchor.objectiveExcerpt.length, 400);
	assert.equal(assertDiskValid(ctx, GOAL)[0]?.requestAnchor.objectiveHash, anchor.objectiveHash);
});

test("decision fingerprint is prefixed, stable, input-sensitive, and disjoint from the blocker fingerprint", () => {
	const hash = objectiveAnchor(OBJECTIVE).objectiveHash;
	const fp = buildDecisionFingerprint(GOAL, "Use WAL mode?", ["yes", "no"], hash);
	assert.match(fp, /^decision:.+:[0-9a-f]{24}$/);
	const goal = { ...createGoal({ objective: OBJECTIVE, autoContinue: true, sisyphus: false }), id: GOAL };
	const blocker = buildBlockerFingerprint(goal, "Use WAL mode?");
	assert.notEqual(fp, blocker);
	assert.match(blocker, /^[0-9a-f]{24}$/, "blocker fingerprint is bare hex");
	assert.notEqual(fp.slice("decision:".length), blocker);
	assert.notEqual(buildDecisionFingerprint(GOAL, "Use WAL mode? ", ["yes", "no"], hash), fp, "question changes the digest");
	assert.notEqual(buildDecisionFingerprint(GOAL, "Use WAL mode?", ["yes", "maybe"], hash), fp, "option changes the digest");
	assert.notEqual(buildDecisionFingerprint(GOAL, "Use WAL mode?", ["yes", "no"], objectiveAnchor(`${OBJECTIVE}!`).objectiveHash), fp, "objective hash changes the digest");
	assert.equal(buildDecisionFingerprint(GOAL, "Use WAL mode?", ["yes", "no"], hash), fp, "repeated calls are stable");
});

test("a held per-goal decision lock yields a typed locked error without touching the file", t => {
	const ctx = tempCtx(t);
	const held = acquireGoalLock(ctx, `${GOAL}.decisions`);
	try {
		assert.equal(failure(createDecision(ctx, GOAL, draft())).code, "locked");
	} finally {
		held.release();
	}
	assert.equal(existsSync(sidecarPath(ctx, GOAL)), false);
	assert.deepEqual(okValue(createDecision(ctx, GOAL, draft())).revision, 0);
});

test("unsafe goal ids and invalid drafts are rejected before any write", t => {
	const ctx = tempCtx(t);
	assert.equal(failure(createDecision(ctx, "../escape", draft())).code, "invalid-input");
	assert.equal(failure(getDecisions(ctx, "a/b")).code, "invalid-input");
	assert.equal(failure(createDecision(ctx, GOAL, { ...draft(), route: "bogus" as never })).code, "invalid-input");
	assert.equal(existsSync(path.join(ctx.cwd, ".pi", "escape.json")), false);
	assert.equal(existsSync(path.join(ctx.cwd, DECISIONS_DIR)), false);
});

test("each step of a create, update, transition sequence leaves a valid sidecar", t => {
	const ctx = tempCtx(t);
	const created = okValue(createDecision(ctx, GOAL, draft()));
	assert.equal(assertDiskValid(ctx, GOAL).length, 1);
	okValue(updateDecision(ctx, GOAL, created.id, record => ({ ...record, unknowns: [] }), 0));
	assert.deepEqual(assertDiskValid(ctx, GOAL)[0]?.unknowns, []);
	okValue(setDecisionStatus(ctx, GOAL, created.id, "decided", { writer: "acceptance-guard", expectedRevision: 1 }));
	const final = assertDiskValid(ctx, GOAL);
	assert.equal(final[0]?.status, "decided");
	assert.equal(final[0]?.revision, 2);
	okValue(createDecision(ctx, GOAL, draft("second")));
	assert.equal(assertDiskValid(ctx, GOAL).length, 2);
});

// ── consultation counter (TECH §5 cross-route cap) ──────────────────────────

function counterPath(ctx: { cwd: string }, goalId: string): string {
	return path.join(ctx.cwd, DECISIONS_DIR, `${goalId}.consultations.json`);
}

test("consultation counter round-trips, starts at zero, and lives beside the record array", t => {
	const ctx = tempCtx(t);
	assert.equal(okValue(getConsultationsLaunched(ctx, GOAL)), 0, "no file reads as zero");
	assert.deepEqual(okValue(incrementConsultations(ctx, GOAL, 6)), { launched: 1, cap: 6, capped: false });
	assert.deepEqual(okValue(incrementConsultations(ctx, GOAL, 6, 4)), { launched: 5, cap: 6, capped: false });
	assert.deepEqual(okValue(incrementConsultations(ctx, GOAL, 6)), { launched: 6, cap: 6, capped: true });
	assert.equal(okValue(getConsultationsLaunched(ctx, GOAL)), 6);
	assert.deepEqual(JSON.parse(readFileSync(counterPath(ctx, GOAL), "utf8")), { goalId: GOAL, consultationsLaunched: 6 });
	assert.equal(existsSync(sidecarPath(ctx, GOAL)), false, "the record array file is not created by counting");
	assert.deepEqual(readdirSync(path.join(ctx.cwd, DECISIONS_DIR)).filter(name => name.endsWith(".tmp")), []);
});

test("incrementConsultations counts past the cap and reports capped; the oracle path never refuses", t => {
	const ctx = tempCtx(t);
	okValue(incrementConsultations(ctx, GOAL, 2, 2));
	assert.deepEqual(okValue(incrementConsultations(ctx, GOAL, 2)), { launched: 3, cap: 2, capped: true });
	assert.equal(okValue(getConsultationsLaunched(ctx, GOAL)), 3);
});

test("reserveConsultations refuses overflow with a capped error and writes nothing", t => {
	const ctx = tempCtx(t);
	assert.deepEqual(okValue(reserveConsultations(ctx, GOAL, 3, 2)), { launched: 2, cap: 3, capped: false });
	const refused = failure(reserveConsultations(ctx, GOAL, 3, 2));
	assert.equal(refused.code, "capped");
	assert.equal(refused.message, "consultation cap reached (2/3)");
	assert.equal(okValue(getConsultationsLaunched(ctx, GOAL)), 2, "a refused reserve is not counted");
	assert.deepEqual(okValue(reserveConsultations(ctx, GOAL, 3)), { launched: 3, cap: 3, capped: true });
	assert.equal(failure(reserveConsultations(ctx, GOAL, 3)).code, "capped");
	assert.equal(okValue(getConsultationsLaunched(ctx, GOAL)), 3);
});

test("counter writes are atomic: a held per-goal lock yields locked and leaves the counter untouched", t => {
	const ctx = tempCtx(t);
	okValue(incrementConsultations(ctx, GOAL, 6));
	const held = acquireGoalLock(ctx, `${GOAL}.decisions`);
	try {
		assert.equal(failure(incrementConsultations(ctx, GOAL, 6)).code, "locked");
		assert.equal(failure(reserveConsultations(ctx, GOAL, 6)).code, "locked");
	} finally {
		held.release();
	}
	assert.equal(okValue(getConsultationsLaunched(ctx, GOAL)), 1);
	assert.deepEqual(readdirSync(path.join(ctx.cwd, DECISIONS_DIR)).filter(name => name.endsWith(".tmp")), []);
});

test("a corrupt or foreign counter file is a typed error and is never overwritten", t => {
	const ctx = tempCtx(t);
	okValue(incrementConsultations(ctx, GOAL, 6));
	writeFileSync(counterPath(ctx, GOAL), "{not json");
	assert.equal(failure(getConsultationsLaunched(ctx, GOAL)).code, "corrupt");
	assert.equal(failure(incrementConsultations(ctx, GOAL, 6)).code, "corrupt");
	assert.equal(readFileSync(counterPath(ctx, GOAL), "utf8"), "{not json");
	writeFileSync(counterPath(ctx, GOAL), JSON.stringify({ goalId: "goal-b", consultationsLaunched: 1 }));
	assert.equal(failure(getConsultationsLaunched(ctx, GOAL)).code, "foreign");
	writeFileSync(counterPath(ctx, GOAL), JSON.stringify({ goalId: GOAL, consultationsLaunched: -1 }));
	assert.equal(failure(getConsultationsLaunched(ctx, GOAL)).code, "corrupt");
});

test("unsafe goal ids and invalid counts are rejected before any write", t => {
	const ctx = tempCtx(t);
	assert.equal(failure(getConsultationsLaunched(ctx, "../escape")).code, "invalid-input");
	assert.equal(failure(incrementConsultations(ctx, "../escape", 6)).code, "invalid-input");
	assert.equal(failure(incrementConsultations(ctx, GOAL, 6, 0)).code, "invalid-input");
	assert.equal(failure(reserveConsultations(ctx, GOAL, 0)).code, "invalid-input");
	assert.equal(existsSync(counterPath(ctx, GOAL)), false);
});
