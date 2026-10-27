import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ConsultantRole, ConsultantRunResult } from "../extensions/goal-decision-consultant.ts";
import {
	acceptConsultantResult,
	type AcceptanceInput,
	type AcceptanceVerdict,
	type ConsultantLaunchBinding,
	type GoalAcceptanceView,
} from "../extensions/goal-decision-runtime.ts";
import {
	DECISIONS_DIR,
	createDecision,
	getDecisions,
	objectiveAnchor,
	setDecisionStatus,
	type ConsultantResult,
	type DecisionDraft,
	type DecisionRecord,
} from "../extensions/goal-decision-record.ts";
import { readModeFreshFromDisk } from "../extensions/goal-decision-policy.ts";
import { goalSettingsPath } from "../extensions/goal-settings.ts";

const OBJECTIVE = "Migrate the storage layer to the new schema";
const GOAL = "goal-a";
const NOW = 1_000_000;
const DEADLINE_MS = 120_000;

interface Ctx {
	cwd: string;
	env: NodeJS.ProcessEnv;
	storage: { cwd: string };
}

function setup(t: test.TestContext): Ctx {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-decision-runtime-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return { cwd, env: { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(cwd, "global-settings.json") }, storage: { cwd } };
}

/** Writes the project settings file (raw text) and returns the snapshot id the policy module reads for it. */
function writeProject(ctx: Ctx, text: string): string {
	const file = goalSettingsPath(ctx.cwd, ctx.env);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text, "utf8");
	return readModeFreshFromDisk(ctx.cwd, ctx.env).snapshotId;
}

function writeMode(ctx: Ctx, mode: string): string {
	return writeProject(ctx, JSON.stringify({ decisionMode: mode }));
}

function draft(policyVersion: string, overrides: Partial<DecisionDraft> = {}): DecisionDraft {
	return {
		objective: OBJECTIVE,
		policyVersion,
		question: "Use WAL mode?",
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

function openRecord(ctx: Ctx, policyVersion: string, overrides: Partial<DecisionDraft> = {}): DecisionRecord {
	const created = createDecision(ctx.storage, GOAL, draft(policyVersion, overrides));
	if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`);
	return created.value;
}

function goalView(decisionId: string | undefined, overrides: Partial<GoalAcceptanceView> = {}): GoalAcceptanceView {
	return { status: "active", objective: OBJECTIVE, activeDecisionId: decisionId, generation: "gen-1", ...overrides };
}

function launch(decisionId: string, overrides: Partial<ConsultantLaunchBinding> = {}): ConsultantLaunchBinding {
	return { decisionId, childRunId: "consultant-1", role: "researcher", deadlineAt: NOW + DEADLINE_MS, ...overrides };
}

const RESEARCHER_OK = {
	findings: [{ claim: "WAL is supported", evidence: "pragma list", source: "src/db.ts" }],
	remainingUnknowns: [],
	verdict: "answered",
};
const CRITIC_OK = { objections: [], verdict: "sound" };

function ok(payload: unknown): ConsultantRunResult<ConsultantRole> {
	return { ok: true, payload } as ConsultantRunResult<ConsultantRole>;
}

/** Accepts against the open record unless `launch.decisionId` names another one. */
function accept(ctx: Ctx, overrides: Partial<AcceptanceInput> = {}): AcceptanceVerdict {
	const decisionId = overrides.launch?.decisionId ?? openedId(ctx);
	return acceptConsultantResult({
		storage: ctx.storage,
		goalId: GOAL,
		cwd: ctx.cwd,
		env: ctx.env,
		goal: goalView(decisionId),
		launch: launch(decisionId),
		result: ok(RESEARCHER_OK),
		now: NOW,
		...overrides,
	});
}

/** The most recent record id (tests open one record per case). */
function openedId(ctx: Ctx): string {
	const listed = getDecisions(ctx.storage, GOAL);
	const last = listed.ok ? listed.value[listed.value.length - 1] : undefined;
	if (!last) throw new Error("no decision recorded");
	return last.id;
}

function storedRecord(ctx: Ctx, id: string): DecisionRecord {
	const listed = getDecisions(ctx.storage, GOAL);
	if (!listed.ok) throw new Error(`${listed.error.code}: ${listed.error.message}`);
	const found = listed.value.find((record) => record.id === id);
	if (!found) throw new Error(`no record ${id}`);
	return found;
}

function consultantEntry(childRunId: string): ConsultantResult {
	return { role: "researcher", childRunId, model: "fixture/model", usage: "unknown", summary: "answered", schemaPayload: RESEARCHER_OK };
}

test("accepts a valid researcher result and writes nothing to the record", t => {
	const ctx = setup(t);
	const snapshot = writeMode(ctx, "bounded-auto");
	const record = openRecord(ctx, snapshot);
	const before = readFileSync(path.join(ctx.cwd, DECISIONS_DIR, `${GOAL}.json`), "utf8");

	const verdict = accept(ctx, { launch: launch(record.id) });

	assert.equal(verdict.kind, "accepted");
	if (verdict.kind !== "accepted") return;
	assert.equal(verdict.decisionId, record.id);
	assert.equal(verdict.childRunId, "consultant-1");
	assert.equal(verdict.role, "researcher");
	assert.deepEqual(verdict.payload, RESEARCHER_OK);
	assert.equal(verdict.mode, "bounded-auto");
	assert.equal(readFileSync(path.join(ctx.cwd, DECISIONS_DIR, `${GOAL}.json`), "utf8"), before, "acceptance must not rewrite the record");
	assert.equal(storedRecord(ctx, record.id).status, "open");
});

test("accepts a valid critic result and reports the mode read fresh at acceptance", t => {
	const ctx = setup(t);
	const record = openRecord(ctx, writeMode(ctx, "advisory"));

	const verdict = accept(ctx, { launch: launch(record.id, { role: "critic", childRunId: "consultant-2" }), result: ok(CRITIC_OK) });

	assert.equal(verdict.kind, "accepted");
	if (verdict.kind === "accepted") {
		assert.equal(verdict.role, "critic");
		assert.equal(verdict.mode, "advisory");
	}
});

test("a sibling consultant settling after another sibling is accepted (out-of-order between parallel launches)", t => {
	const ctx = setup(t);
	const record = openRecord(ctx, writeMode(ctx, "bounded-auto"), { consultants: [consultantEntry("consultant-1")] });

	const verdict = accept(ctx, { launch: launch(record.id, { childRunId: "consultant-2" }) });

	assert.equal(verdict.kind, "accepted");
});

test("a duplicate delivery of an already settled childRunId is ignored and changes nothing", t => {
	const ctx = setup(t);
	const record = openRecord(ctx, writeMode(ctx, "bounded-auto"), { consultants: [consultantEntry("consultant-1")] });
	const revision = storedRecord(ctx, record.id).revision;

	const verdict = accept(ctx, { launch: launch(record.id, { childRunId: "consultant-1" }) });

	assert.deepEqual(verdict, { kind: "ignored", reason: "duplicate" });
	assert.equal(storedRecord(ctx, record.id).revision, revision);
	assert.equal(storedRecord(ctx, record.id).status, "open");
});

test("a result for a superseded decision is ignored (stale identity)", t => {
	const ctx = setup(t);
	const old = openRecord(ctx, writeMode(ctx, "bounded-auto"));
	const current = openRecord(ctx, writeMode(ctx, "bounded-auto"), { question: "Use a second table?" });

	const verdict = accept(ctx, { launch: launch(old.id), goal: goalView(current.id) });

	assert.deepEqual(verdict, { kind: "ignored", reason: "stale-decision" });
	assert.equal(storedRecord(ctx, old.id).status, "open", "a stale delivery must not touch the old record");
});

test("a goal with no active decision ignores the result", t => {
	const ctx = setup(t);
	const record = openRecord(ctx, writeMode(ctx, "bounded-auto"));

	const verdict = accept(ctx, { launch: launch(record.id), goal: goalView(undefined) });

	assert.deepEqual(verdict, { kind: "ignored", reason: "stale-decision" });
});

test("an unknown decision id is ignored", t => {
	const ctx = setup(t);
	const record = openRecord(ctx, writeMode(ctx, "bounded-auto"));

	const verdict = accept(ctx, { launch: launch("dec-000000000000"), goal: goalView("dec-000000000000") });

	assert.deepEqual(verdict, { kind: "ignored", reason: "unknown-decision" });
	assert.equal(storedRecord(ctx, record.id).status, "open");
});

test("a result for a record already in a terminal status is ignored (not-open)", t => {
	const ctx = setup(t);
	const record = openRecord(ctx, writeMode(ctx, "bounded-auto"));
	const escalated = setDecisionStatus(ctx.storage, GOAL, record.id, "escalated", { writer: "router", expectedRevision: record.revision });
	assert.equal(escalated.ok, true);

	const verdict = accept(ctx, { launch: launch(record.id) });

	assert.deepEqual(verdict, { kind: "ignored", reason: "not-open" });
	assert.equal(storedRecord(ctx, record.id).status, "escalated");
});

test("a paused goal invalidates the open record and later deliveries cannot revive it", t => {
	const ctx = setup(t);
	const record = openRecord(ctx, writeMode(ctx, "bounded-auto"));

	const paused = accept(ctx, { launch: launch(record.id), goal: goalView(record.id, { status: "paused" }) });
	assert.equal(paused.kind, "invalidated");
	if (paused.kind === "invalidated") assert.equal(paused.reason, "goal-not-active");
	assert.equal(storedRecord(ctx, record.id).status, "invalidated");

	const late = accept(ctx, { launch: launch(record.id, { childRunId: "consultant-2" }) });
	assert.deepEqual(late, { kind: "ignored", reason: "not-open" });
});

test("a settings snapshot changed by another session invalidates the record (fresh read, no cache)", t => {
	const ctx = setup(t);
	const record = openRecord(ctx, writeMode(ctx, "bounded-auto"));
	writeMode(ctx, "advisory");

	const verdict = accept(ctx, { launch: launch(record.id) });

	assert.equal(verdict.kind, "invalidated");
	if (verdict.kind === "invalidated") assert.equal(verdict.reason, "settings-snapshot");
	assert.equal(storedRecord(ctx, record.id).status, "invalidated");
});

test("switching the project to manual invalidates the record with mode-manual", t => {
	const ctx = setup(t);
	const record = openRecord(ctx, writeMode(ctx, "bounded-auto"));
	writeMode(ctx, "manual");

	const verdict = accept(ctx, { launch: launch(record.id) });

	assert.equal(verdict.kind, "invalidated");
	if (verdict.kind === "invalidated") assert.equal(verdict.reason, "mode-manual");
});

test("a changed objective invalidates the record (objective hash mismatch)", t => {
	const ctx = setup(t);
	const record = openRecord(ctx, writeMode(ctx, "bounded-auto"));

	const verdict = accept(ctx, { launch: launch(record.id), goal: goalView(record.id, { objective: `${OBJECTIVE} and drop the old table` }) });

	assert.equal(verdict.kind, "invalidated");
	if (verdict.kind === "invalidated") assert.equal(verdict.reason, "objective-changed");
	assert.equal(storedRecord(ctx, record.id).status, "invalidated");
});

test("a changed scheduler generation invalidates the record", t => {
	const ctx = setup(t);
	const record = openRecord(ctx, writeMode(ctx, "bounded-auto"));

	const verdict = accept(ctx, { launch: launch(record.id), goal: goalView(record.id, { generation: "gen-2" }) });

	assert.equal(verdict.kind, "invalidated");
	if (verdict.kind === "invalidated") assert.equal(verdict.reason, "generation-changed");
});

test("a goal that lost its scheduler state no longer matches the recorded generation", t => {
	const ctx = setup(t);
	const record = openRecord(ctx, writeMode(ctx, "bounded-auto"));

	const verdict = accept(ctx, { launch: launch(record.id), goal: goalView(record.id, { generation: undefined }) });

	assert.equal(verdict.kind, "invalidated");
	if (verdict.kind === "invalidated") assert.equal(verdict.reason, "generation-changed");
});

test("a result exactly at the deadline is accepted, one millisecond later it is rejected", t => {
	const ctx = setup(t);
	const record = openRecord(ctx, writeMode(ctx, "bounded-auto"));

	const atDeadline = accept(ctx, { launch: launch(record.id, { deadlineAt: NOW }), now: NOW });
	assert.equal(atDeadline.kind, "accepted");

	const late = accept(ctx, { launch: launch(record.id, { deadlineAt: NOW - 1 }), now: NOW });
	assert.equal(late.kind, "invalidated");
	if (late.kind === "invalidated") assert.equal(late.reason, "deadline-exceeded");
	assert.equal(storedRecord(ctx, record.id).status, "invalidated");
});

test("a failed consultant run invalidates the record with the run's error code", t => {
	const ctx = setup(t);
	const record = openRecord(ctx, writeMode(ctx, "bounded-auto"));

	const verdict = accept(ctx, { launch: launch(record.id), result: { ok: false, errorCode: "provider", message: "rate limited" } });

	assert.equal(verdict.kind, "invalidated");
	if (verdict.kind === "invalidated") {
		assert.equal(verdict.reason, "consultant-failed");
		assert.match(verdict.detail, /provider: rate limited/);
	}
});

test("a payload that fails the role schema invalidates the record (schema-invalid)", t => {
	const ctx = setup(t);
	const researcher = openRecord(ctx, writeMode(ctx, "bounded-auto"));
	const badVerdict = accept(ctx, { launch: launch(researcher.id), result: ok({ ...RESEARCHER_OK, verdict: "maybe" }) });
	assert.equal(badVerdict.kind, "invalidated");
	if (badVerdict.kind === "invalidated") assert.equal(badVerdict.reason, "schema-invalid");
});

test("a critic payload delivered under the researcher role is a schema failure", t => {
	const ctx = setup(t);
	const record = openRecord(ctx, writeMode(ctx, "bounded-auto"));

	const verdict = accept(ctx, { launch: launch(record.id, { role: "researcher" }), result: ok(CRITIC_OK) });

	assert.equal(verdict.kind, "invalidated");
	if (verdict.kind === "invalidated") assert.equal(verdict.reason, "schema-invalid");
});

test("a missing project settings file reads as manual and invalidates the record", t => {
	const ctx = setup(t);
	const record = openRecord(ctx, readModeFreshFromDisk(ctx.cwd, ctx.env).snapshotId);

	const verdict = accept(ctx, { launch: launch(record.id) });

	assert.equal(verdict.kind, "invalidated");
	if (verdict.kind === "invalidated") assert.equal(verdict.reason, "mode-manual");
});

test("the objective hash covers the raw objective, so trailing whitespace counts as a change", t => {
	const ctx = setup(t);
	const record = openRecord(ctx, writeMode(ctx, "bounded-auto"));
	assert.equal(record.requestAnchor.objectiveHash, objectiveAnchor(OBJECTIVE).objectiveHash);

	const verdict = accept(ctx, { launch: launch(record.id), goal: goalView(record.id, { objective: `${OBJECTIVE}\n` }) });
	assert.equal(verdict.kind, "invalidated");
	if (verdict.kind === "invalidated") assert.equal(verdict.reason, "objective-changed");
});

test("an unreadable decision store is reported as a store error and nothing is accepted", t => {
	const ctx = setup(t);
	const record = openRecord(ctx, writeMode(ctx, "bounded-auto"));
	writeFileSync(path.join(ctx.cwd, DECISIONS_DIR, `${GOAL}.json`), "{not json", "utf8");

	const verdict = accept(ctx, { launch: launch(record.id) });

	assert.equal(verdict.kind, "store-error");
});
