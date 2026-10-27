/**
 * Adaptive decision policy settings (E2.1): mode parsing, limit normalization,
 * layered resolution (project > global > defaults, mode from project only),
 * and the cache-bypassing fresh read used at acceptance time.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	DEFAULT_GOAL_DECISION_LIMITS,
	normalizeLimits,
	parseMode,
	readModeFreshFromDisk,
	resolveDecisionSettings,
} from "../extensions/goal-decision-policy.ts";
import { invalidateGoalSettingsCache, loadGoalSettings } from "../extensions/goal-settings.ts";

const DEFAULTS = { maxRounds: 2, consultantDeadlineMs: 120_000, maxParallelConsultants: 2, maxConsultationsPerGoal: 6 };

function withTempDir(fn: (dir: string) => void): void {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goal-decision-policy-")));
	try {
		fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Explicit env: global file inside the temp dir, so the real home is never read. */
function envFor(dir: string): NodeJS.ProcessEnv {
	return { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(dir, "global-settings.json") };
}

function projectFile(dir: string): string {
	return path.join(dir, ".pi", "pi-goal-x-settings.json");
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

function writeRaw(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text, "utf8");
}

function sha16(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** Mirror of the policy snapshot format: sha256(globalText || NUL || projectText)[0:16]. */
function sha16Both(globalText: string, projectText: string): string {
	return createHash("sha256").update(globalText, "utf8").update("\u0000").update(projectText, "utf8").digest("hex").slice(0, 16);
}

describe("parseMode", () => {
	it("accepts exactly the three allowed modes", () => {
		assert.equal(parseMode("manual"), "manual");
		assert.equal(parseMode("advisory"), "advisory");
		assert.equal(parseMode("bounded-auto"), "bounded-auto");
	});

	it("maps every other value to manual (fail-safe)", () => {
		for (const invalid of ["BOUNDED-AUTO", "auto", "bounded_auto", "", "   ", 1, true, null, undefined, ["bounded-auto"], { mode: "advisory" }]) {
			assert.equal(parseMode(invalid), "manual", `expected manual for ${JSON.stringify(invalid)}`);
		}
	});

	it("trims surrounding whitespace before matching", () => {
		assert.equal(parseMode("  advisory \n"), "advisory");
	});
});

describe("normalizeLimits", () => {
	it("returns the built-in defaults for missing or non-object values", () => {
		for (const value of [undefined, null, "x", 5, true, [], [1, 2]]) {
			assert.deepEqual(normalizeLimits(value), DEFAULTS, `defaults for ${JSON.stringify(value)}`);
		}
		assert.deepEqual(DEFAULT_GOAL_DECISION_LIMITS, DEFAULTS);
	});

	it("keeps valid integers and plain decimal strings", () => {
		assert.deepEqual(
			normalizeLimits({ maxRounds: 3, consultantDeadlineMs: "5000", maxParallelConsultants: " 1 " }),
			{ maxRounds: 3, consultantDeadlineMs: 5000, maxParallelConsultants: 1, maxConsultationsPerGoal: 6 },
		);
	});

	it("falls back per key: an invalid key gets its own default, valid keys survive", () => {
		assert.deepEqual(
			normalizeLimits({ maxRounds: 0, consultantDeadlineMs: "abc", maxParallelConsultants: 1.5 }),
			DEFAULTS,
		);
		assert.deepEqual(
			normalizeLimits({ maxRounds: 4, consultantDeadlineMs: -1 }),
			{ maxRounds: 4, consultantDeadlineMs: 120_000, maxParallelConsultants: 2, maxConsultationsPerGoal: 6 },
		);
	});

	it("rejects non-integers, signs, exponents, unsafe numbers and wrong types", () => {
		for (const bad of ["1e3", "-2", "", "2.5", "0x10", 0, 2 ** 53, true, null, [], {}]) {
			assert.deepEqual(normalizeLimits({ maxRounds: bad }), DEFAULTS, `maxRounds from ${JSON.stringify(bad)}`);
		}
	});

	it("maxConsultationsPerGoal: valid positive integers are kept, anything else falls back to 6", () => {
		assert.equal(normalizeLimits({ maxConsultationsPerGoal: 3 }).maxConsultationsPerGoal, 3);
		assert.equal(normalizeLimits({ maxConsultationsPerGoal: " 9 " }).maxConsultationsPerGoal, 9);
		for (const bad of [0, -1, "0", "x", 2.5, null, true]) {
			assert.equal(normalizeLimits({ maxConsultationsPerGoal: bad }).maxConsultationsPerGoal, 6, `from ${JSON.stringify(bad)}`);
		}
	});

	it("ignores unknown keys in the limits object", () => {
		assert.deepEqual(normalizeLimits({ foo: 9, maxRounds: 3 }), { maxRounds: 3, consultantDeadlineMs: 120_000, maxParallelConsultants: 2, maxConsultationsPerGoal: 6 });
	});
});

describe("resolveDecisionSettings: file content", () => {
	it("no files resolves to manual, default limits, no critic", () => {
		withTempDir((dir) => {
			assert.deepEqual(resolveDecisionSettings(dir, envFor(dir)), { mode: "manual", limits: DEFAULTS });
		});
	});

	it("broken JSON in the project file is manual; the global layer still applies", () => {
		withTempDir((dir) => {
			writeRaw(projectFile(dir), "{not json");
			writeJson(path.join(dir, "global-settings.json"), { decisionCritic: { model: "gm" }, decisionLimits: { maxRounds: 1 } });
			assert.deepEqual(resolveDecisionSettings(dir, envFor(dir)), {
				mode: "manual",
				critic: { model: "gm" },
				limits: { maxRounds: 1, consultantDeadlineMs: 120_000, maxParallelConsultants: 2, maxConsultationsPerGoal: 6 },
			});
		});
	});

	it("an empty project file is manual with default limits", () => {
		withTempDir((dir) => {
			writeRaw(projectFile(dir), "");
			assert.deepEqual(resolveDecisionSettings(dir, envFor(dir)), { mode: "manual", limits: DEFAULTS });
		});
	});

	it("non-object JSON content is manual with default limits", () => {
		withTempDir((dir) => {
			for (const text of ["[]", "\"bounded-auto\"", "null", "42"]) {
				writeRaw(projectFile(dir), text);
				assert.deepEqual(resolveDecisionSettings(dir, envFor(dir)), { mode: "manual", limits: DEFAULTS }, text);
			}
		});
	});

	it("unrelated and goal-settings keys in the same file do not change decision settings", () => {
		withTempDir((dir) => {
			writeJson(projectFile(dir), { disableTasks: true, bogus: 1, decisionMode: "advisory" });
			assert.deepEqual(resolveDecisionSettings(dir, envFor(dir)), { mode: "advisory", limits: DEFAULTS });
		});
	});

	it("an unknown decisionMode string in the project file is manual", () => {
		withTempDir((dir) => {
			writeJson(projectFile(dir), { decisionMode: "auto" });
			assert.equal(resolveDecisionSettings(dir, envFor(dir)).mode, "manual");
		});
	});

	it("critic leaves: empty provider and unknown thinkingLevel are unset, valid model kept", () => {
		withTempDir((dir) => {
			writeJson(projectFile(dir), { decisionCritic: { provider: "  ", model: "m", thinkingLevel: "turbo" } });
			assert.deepEqual(resolveDecisionSettings(dir, envFor(dir)).critic, { model: "m" });
		});
	});

	it("a non-object decisionCritic yields no critic at all", () => {
		withTempDir((dir) => {
			writeJson(projectFile(dir), { decisionCritic: "gpt" });
			assert.equal("critic" in resolveDecisionSettings(dir, envFor(dir)), false);
		});
	});

	it("critic thinkingLevel accepts a known level", () => {
		withTempDir((dir) => {
			writeJson(projectFile(dir), { decisionCritic: { provider: "p", model: "m", thinkingLevel: "high" } });
			assert.deepEqual(resolveDecisionSettings(dir, envFor(dir)).critic, { provider: "p", model: "m", thinkingLevel: "high" });
		});
	});
});

describe("resolveDecisionSettings: layering", () => {
	it("decisionMode from the global layer is the default (owner revision, post-E7)", () => {
		withTempDir((dir) => {
			writeJson(path.join(dir, "global-settings.json"), { decisionMode: "bounded-auto" });
			assert.equal(resolveDecisionSettings(dir, envFor(dir)).mode, "bounded-auto");
		});
	});

	it("global decisionMode does not override a project decisionMode", () => {
		withTempDir((dir) => {
			writeJson(path.join(dir, "global-settings.json"), { decisionMode: "bounded-auto" });
			writeJson(projectFile(dir), { decisionMode: "advisory" });
			assert.equal(resolveDecisionSettings(dir, envFor(dir)).mode, "advisory");
			assert.equal(readModeFreshFromDisk(dir, envFor(dir)).mode, "advisory");
		});
	});

	it("decisionMode from the project layer applies", () => {
		withTempDir((dir) => {
			writeJson(projectFile(dir), { decisionMode: "bounded-auto" });
			assert.equal(resolveDecisionSettings(dir, envFor(dir)).mode, "bounded-auto");
		});
	});

	it("project overrides global per critic leaf and per limit key; absent leaves inherit", () => {
		withTempDir((dir) => {
			writeJson(path.join(dir, "global-settings.json"), {
				decisionCritic: { provider: "gp", model: "gm", thinkingLevel: "low" },
				decisionLimits: { maxRounds: 1, consultantDeadlineMs: 5000 },
			});
			writeJson(projectFile(dir), {
				decisionCritic: { model: "pm" },
				decisionLimits: { maxParallelConsultants: 1 },
			});
			assert.deepEqual(resolveDecisionSettings(dir, envFor(dir)), {
				mode: "manual",
				critic: { provider: "gp", model: "pm", thinkingLevel: "low" },
				limits: { maxRounds: 1, consultantDeadlineMs: 5000, maxParallelConsultants: 1, maxConsultationsPerGoal: 6 },
			});
		});
	});

	it("an invalid project limit shadows a valid global limit and becomes the default", () => {
		withTempDir((dir) => {
			writeJson(path.join(dir, "global-settings.json"), { decisionLimits: { maxRounds: 1 } });
			writeJson(projectFile(dir), { decisionLimits: { maxRounds: 0 } });
			assert.equal(resolveDecisionSettings(dir, envFor(dir)).limits.maxRounds, 2);
		});
	});

	it("an invalid project critic leaf shadows the global leaf (unset)", () => {
		withTempDir((dir) => {
			writeJson(path.join(dir, "global-settings.json"), { decisionCritic: { model: "gm", thinkingLevel: "low" } });
			writeJson(projectFile(dir), { decisionCritic: { thinkingLevel: "turbo" } });
			assert.deepEqual(resolveDecisionSettings(dir, envFor(dir)).critic, { model: "gm" });
		});
	});

	it("a non-object project decisionLimits resets every limit to default over the global layer", () => {
		withTempDir((dir) => {
			writeJson(path.join(dir, "global-settings.json"), { decisionLimits: { maxRounds: 1, consultantDeadlineMs: 5000 } });
			writeJson(projectFile(dir), { decisionLimits: 7 });
			assert.deepEqual(resolveDecisionSettings(dir, envFor(dir)).limits, DEFAULTS);
		});
	});

	it("two projects sharing one global file resolve their own modes", () => {
		withTempDir((root) => {
			const env = envFor(root);
			const a = path.join(root, "proj-a");
			const b = path.join(root, "proj-b");
			writeJson(path.join(root, "global-settings.json"), { decisionMode: "advisory" });
			writeJson(projectFile(a), { decisionMode: "bounded-auto" });
			writeJson(projectFile(b), { decisionMode: "manual" });
			assert.equal(resolveDecisionSettings(a, env).mode, "bounded-auto");
			assert.equal(resolveDecisionSettings(b, env).mode, "manual");
			assert.equal(readModeFreshFromDisk(a, env).mode, "bounded-auto");
			assert.equal(readModeFreshFromDisk(b, env).mode, "manual");
		});
	});
});

describe("readModeFreshFromDisk", () => {
	it("missing files are manual, with the snapshot id of two empty slots", () => {
		withTempDir((dir) => {
			assert.deepEqual(readModeFreshFromDisk(dir, envFor(dir)), { mode: "manual", snapshotId: sha16Both("", "") });
		});
	});

	it("sees a change written directly to the file between two calls", () => {
		withTempDir((dir) => {
			const env = envFor(dir);
			writeJson(projectFile(dir), { decisionMode: "advisory" });
			const first = readModeFreshFromDisk(dir, env);
			assert.equal(first.mode, "advisory");

			writeJson(projectFile(dir), { decisionMode: "manual" });
			const second = readModeFreshFromDisk(dir, env);
			assert.equal(second.mode, "manual");
			assert.notEqual(second.snapshotId, first.snapshotId);
		});
	});

	it("snapshotId is 16 lowercase hex chars over global||NUL||project, stable on re-read", () => {
		withTempDir((dir) => {
			const env = envFor(dir);
			const text = JSON.stringify({ decisionMode: "bounded-auto" });
			writeRaw(projectFile(dir), text);
			const first = readModeFreshFromDisk(dir, env);
			const second = readModeFreshFromDisk(dir, env);
			assert.match(first.snapshotId, /^[0-9a-f]{16}$/);
			assert.equal(first.snapshotId, sha16Both("", text));
			assert.equal(second.snapshotId, first.snapshotId);
		});
	});

	it("snapshotId changes on any byte change, even when the mode stays the same", () => {
		withTempDir((dir) => {
			const env = envFor(dir);
			writeRaw(projectFile(dir), "{\"decisionMode\":\"advisory\"}");
			const before = readModeFreshFromDisk(dir, env);
			writeRaw(projectFile(dir), "{\"decisionMode\":\"advisory\"} ");
			const after = readModeFreshFromDisk(dir, env);
			assert.equal(after.mode, before.mode);
			assert.notEqual(after.snapshotId, before.snapshotId);
		});
	});

	it("the global layer alone can enable a mode (default without project)", () => {
		withTempDir((dir) => {
			writeJson(path.join(dir, "global-settings.json"), { decisionMode: "bounded-auto" });
			assert.equal(readModeFreshFromDisk(dir, envFor(dir)).mode, "bounded-auto");
		});
	});

	it("broken project JSON is manual, and its snapshot id covers both slots", () => {
		withTempDir((dir) => {
			writeRaw(projectFile(dir), "{\"decisionMode\":");
			assert.deepEqual(readModeFreshFromDisk(dir, envFor(dir)), { mode: "manual", snapshotId: sha16Both("", "{\"decisionMode\":") });
		});
	});
});

describe("warm in-process cache vs fresh read (why acceptance uses readModeFreshFromDisk)", () => {
	it("goal-settings keeps serving the cached file after a direct write; the fresh read and resolveDecisionSettings see it", () => {
		withTempDir((dir) => {
			const env = envFor(dir);
			writeJson(projectFile(dir), { disableTasks: false, decisionMode: "advisory" });
			invalidateGoalSettingsCache();
			assert.equal(loadGoalSettings(dir, env).disableTasks, false, "warm the goal-settings cache");

			// Another session writes the file directly; this process's cache is not invalidated.
			writeJson(projectFile(dir), { disableTasks: true, decisionMode: "bounded-auto" });
			assert.equal(loadGoalSettings(dir, env).disableTasks, false, "cached read still serves the old snapshot");

			assert.equal(readModeFreshFromDisk(dir, env).mode, "bounded-auto");
			assert.equal(resolveDecisionSettings(dir, env).mode, "bounded-auto");

			invalidateGoalSettingsCache();
			assert.equal(loadGoalSettings(dir, env).disableTasks, true, "after explicit invalidation the cache is fresh again");
		});
	});
});

describe("global default mode layering (owner revision, post-E7)", () => {
	it("the global file defines the default mode; an absent project key falls through to it", () => {
		withTempDir((dir) => {
			const env = envFor(dir);
			writeJson(path.join(dir, "global-settings.json"), { decisionMode: "advisory" });
			assert.equal(resolveDecisionSettings(dir, env).mode, "advisory");
			assert.equal(readModeFreshFromDisk(dir, env).mode, "advisory");
			writeJson(projectFile(dir), {});
			assert.equal(resolveDecisionSettings(dir, env).mode, "advisory");
			assert.equal(readModeFreshFromDisk(dir, env).mode, "advisory");
		});
	});

	it("the project key overrides the global default in both readers", () => {
		withTempDir((dir) => {
			const env = envFor(dir);
			writeJson(path.join(dir, "global-settings.json"), { decisionMode: "advisory" });
			writeJson(projectFile(dir), { decisionMode: "bounded-auto" });
			assert.equal(resolveDecisionSettings(dir, env).mode, "bounded-auto");
			assert.equal(readModeFreshFromDisk(dir, env).mode, "bounded-auto");
		});
	});

	it("a present-but-invalid project mode fails safe to manual without falling through to global", () => {
		withTempDir((dir) => {
			const env = envFor(dir);
			writeJson(path.join(dir, "global-settings.json"), { decisionMode: "advisory" });
			writeJson(projectFile(dir), { decisionMode: "yolo" });
			assert.equal(resolveDecisionSettings(dir, env).mode, "manual");
			assert.equal(readModeFreshFromDisk(dir, env).mode, "manual");
		});
	});

	it("an invalid global mode with no project key is manual", () => {
		withTempDir((dir) => {
			const env = envFor(dir);
			writeJson(path.join(dir, "global-settings.json"), { decisionMode: 42 });
			assert.equal(resolveDecisionSettings(dir, env).mode, "manual");
			assert.equal(readModeFreshFromDisk(dir, env).mode, "manual");
		});
	});

	it("editing the global file alone invalidates the snapshot and flips the default", () => {
		withTempDir((dir) => {
			const env = envFor(dir);
			writeJson(projectFile(dir), {});
			writeJson(path.join(dir, "global-settings.json"), { decisionMode: "advisory" });
			const first = readModeFreshFromDisk(dir, env);
			assert.equal(first.mode, "advisory");

			writeJson(path.join(dir, "global-settings.json"), { decisionMode: "bounded-auto" });
			const second = readModeFreshFromDisk(dir, env);
			assert.equal(second.mode, "bounded-auto");
			assert.notEqual(second.snapshotId, first.snapshotId);
		});
	});

	it("global critic/limits keep layering under a global mode default", () => {
		withTempDir((dir) => {
			const env = envFor(dir);
			writeJson(path.join(dir, "global-settings.json"), {
				decisionMode: "advisory",
				decisionCritic: { model: "reviewer-x" },
				decisionLimits: { maxRounds: 1 },
			});
			const resolved = resolveDecisionSettings(dir, env);
			assert.equal(resolved.mode, "advisory");
			assert.deepEqual(resolved.critic, { model: "reviewer-x" });
			assert.equal(resolved.limits.maxRounds, 1);
			assert.equal(resolved.limits.consultantDeadlineMs, 120000);
		});
	});
});
