/**
 * Adaptive decisions rows in the /goal-settings menu (specs/2026-10-27-adaptive-decisions,
 * owner revision post-E7). The menu writes the same flat keys the decision
 * policy reads; these tests pin the resolution/provenance/mutation machinery
 * underneath the "Adaptive decisions" section.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { invalidateGoalSettingsCache, loadSettingsSnapshot, mutateSettingsLayer } from "../extensions/goal-settings.ts";
import { resolveDecisionSettings } from "../extensions/goal-decision-policy.ts";

function withTempDir(fn: (dir: string) => void): void {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goal-settings-decision-")));
	try {
		fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function envFor(dir: string): NodeJS.ProcessEnv {
	return { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "global-settings.json") };
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

test("the snapshot always carries resolved decision defaults", () => {
	withTempDir((dir) => {
		invalidateGoalSettingsCache();
		const snap = loadSettingsSnapshot(dir, envFor(dir));
		assert.equal(snap.value.decisionMode, "manual");
		assert.deepEqual(snap.value.decisionLimits, {
			maxRounds: 2,
			consultantDeadlineMs: 120000,
			maxParallelConsultants: 2,
			maxConsultationsPerGoal: 6,
		});
		assert.deepEqual(snap.value.decisionCritic, {});
		assert.equal(snap.provenance.get("decisionMode")?.source, "default");
	});
});

test("global defines the default mode; the project layer overrides it with provenance", () => {
	withTempDir((dir) => {
		const env = envFor(dir);
		writeJson(path.join(dir, "global-settings.json"), { decisionMode: "advisory" });
		invalidateGoalSettingsCache();
		let snap = loadSettingsSnapshot(dir, env);
		assert.equal(snap.value.decisionMode, "advisory");
		assert.equal(snap.provenance.get("decisionMode")?.source, "global");

		mutateSettingsLayer({ scope: "project", cwd: dir, env, mutation: { op: "set", path: ["decisionMode"], value: "bounded-auto" } });
		snap = loadSettingsSnapshot(dir, env);
		assert.equal(snap.value.decisionMode, "bounded-auto");
		assert.equal(snap.provenance.get("decisionMode")?.source, "project");
	});
});

test("a present-but-invalid project mode fails safe to manual with project provenance", () => {
	withTempDir((dir) => {
		const env = envFor(dir);
		writeJson(path.join(dir, "global-settings.json"), { decisionMode: "advisory" });
		writeJson(path.join(dir, ".pi", "pi-goal-x-settings.json"), { decisionMode: "yolo" });
		invalidateGoalSettingsCache();
		const snap = loadSettingsSnapshot(dir, env);
		assert.equal(snap.value.decisionMode, "manual");
		assert.equal(snap.provenance.get("decisionMode")?.source, "project");
	});
});

test("limit and critic rows mutate nested paths and unset restores the default", () => {
	withTempDir((dir) => {
		const env = envFor(dir);
		invalidateGoalSettingsCache();

		mutateSettingsLayer({ scope: "project", cwd: dir, env, mutation: { op: "set", path: ["decisionLimits", "maxRounds"], value: 1 } });
		mutateSettingsLayer({ scope: "global", cwd: dir, env, mutation: { op: "set", path: ["decisionLimits", "consultantDeadlineMs"], value: 45000 } });
		const snap = loadSettingsSnapshot(dir, env);
		assert.equal(snap.value.decisionLimits?.maxRounds, 1);
		assert.equal(snap.provenance.get("decisionLimits.maxRounds")?.source, "project");
		assert.equal(snap.value.decisionLimits?.consultantDeadlineMs, 45000);
		assert.equal(snap.provenance.get("decisionLimits.consultantDeadlineMs")?.source, "global");

		mutateSettingsLayer({ scope: "project", cwd: dir, env, mutation: { op: "unset", path: ["decisionLimits", "maxRounds"] } });
		assert.equal(loadSettingsSnapshot(dir, env).value.decisionLimits?.maxRounds, 2, "unset falls back to the built-in default");
	});
});

test("the critic provider/model pair is written per leaf and validated per leaf", () => {
	withTempDir((dir) => {
		const env = envFor(dir);
		invalidateGoalSettingsCache();

		mutateSettingsLayer({ scope: "project", cwd: dir, env, mutation: { op: "set", path: ["decisionCritic", "provider"], value: "zai-coding-cn" } });
		mutateSettingsLayer({ scope: "project", cwd: dir, env, mutation: { op: "set", path: ["decisionCritic", "model"], value: "glm-5.3-flash" } });
		mutateSettingsLayer({ scope: "project", cwd: dir, env, mutation: { op: "set", path: ["decisionCritic", "thinkingLevel"], value: "low" } });
		const snap = loadSettingsSnapshot(dir, env);
		assert.deepEqual(snap.value.decisionCritic, { provider: "zai-coding-cn", model: "glm-5.3-flash", thinkingLevel: "low" });
		assert.equal(snap.provenance.get("decisionCritic.model")?.source, "project");

		// A non-string leaf is dropped by the shape check, so the leaf keeps its
		// default (unset) instead of poisoning the resolution.
		mutateSettingsLayer({ scope: "global", cwd: dir, env, mutation: { op: "set", path: ["decisionCritic", "provider"], value: 42 } });
		assert.equal(loadSettingsSnapshot(dir, env).provenance.get("decisionCritic.provider")?.source, "project", "invalid global leaf does not shadow the project leaf");
	});
});

test("what the menu writes is what the decision policy resolves", () => {
	withTempDir((dir) => {
		const env = envFor(dir);
		invalidateGoalSettingsCache();

		mutateSettingsLayer({ scope: "global", cwd: dir, env, mutation: { op: "set", path: ["decisionMode"], value: "advisory" } });
		mutateSettingsLayer({ scope: "global", cwd: dir, env, mutation: { op: "set", path: ["decisionLimits", "maxRounds"], value: 1 } });
		let resolved = resolveDecisionSettings(dir, env);
		assert.equal(resolved.mode, "advisory");
		assert.equal(resolved.limits.maxRounds, 1);

		mutateSettingsLayer({ scope: "project", cwd: dir, env, mutation: { op: "set", path: ["decisionMode"], value: "bounded-auto" } });
		resolved = resolveDecisionSettings(dir, env);
		assert.equal(resolved.mode, "bounded-auto");
		assert.equal(resolved.limits.maxRounds, 1, "the global limit still applies under a project mode override");
	});
});
