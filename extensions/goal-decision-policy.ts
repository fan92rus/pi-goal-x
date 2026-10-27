/**
 * Adaptive decision policy settings (specs/2026-10-27-adaptive-decisions, TECH §2).
 *
 * Keys in the same settings files as goal-settings.ts:
 *
 *     decisionMode:    "manual" | "advisory" | "bounded-auto"   (default "manual")
 *     decisionCritic:  { provider?, model?, thinkingLevel? }
 *     decisionLimits:  { maxRounds?, consultantDeadlineMs?, maxParallelConsultants?, maxConsultationsPerGoal? }
 *
 * Resolution per leaf: project layer > global layer > built-in default, the
 * same layering as goal-settings.ts. `decisionMode` is authoritative only at
 * the project layer: a global `decisionMode` is ignored, so a user-level file
 * cannot switch autonomous acceptance on in every project. Invalid values fail
 * safe: mode becomes "manual", and an invalid limit or critic leaf becomes its
 * built-in default (critic: unset) even when a lower layer sets it. Nothing
 * here throws on file content.
 *
 * goal-settings.ts keeps an in-process settings cache that another session's
 * write does not invalidate. Decision settings are therefore read from disk on
 * every call here, and acceptance-time checks use readModeFreshFromDisk().
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { GOAL_THINKING_LEVELS, goalGlobalSettingsPath, goalSettingsPath, type ThinkingLevel } from "./goal-settings.ts";

export const GOAL_DECISION_MODES = ["manual", "advisory", "bounded-auto"] as const;
export type GoalDecisionMode = typeof GOAL_DECISION_MODES[number];

export interface GoalDecisionCriticSettings {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface GoalDecisionLimits {
	/** Maximum consultation rounds per deliberation. */
	maxRounds: number;
	/** Wall-clock deadline per consultant, in milliseconds. */
	consultantDeadlineMs: number;
	/** Maximum consultants running at the same time. */
	maxParallelConsultants: number;
	/** Cross-route cap: total consultant launches per goal (decision router and blocker oracle). */
	maxConsultationsPerGoal: number;
}

/** Resolved decision settings (concrete defaults filled). */
export interface GoalDecisionSettings {
	mode: GoalDecisionMode;
	critic?: GoalDecisionCriticSettings;
	limits: GoalDecisionLimits;
}

export const DEFAULT_GOAL_DECISION_LIMITS: Readonly<GoalDecisionLimits> = Object.freeze({
	maxRounds: 2,
	consultantDeadlineMs: 120_000,
	maxParallelConsultants: 2,
	maxConsultationsPerGoal: 6,
});

export const DECISION_MODE_KEY = "decisionMode";
export const DECISION_CRITIC_KEY = "decisionCritic";
export const DECISION_LIMITS_KEY = "decisionLimits";

const THINKING_LEVELS = new Set<string>(GOAL_THINKING_LEVELS);
const LIMIT_KEYS = ["maxRounds", "consultantDeadlineMs", "maxParallelConsultants", "maxConsultationsPerGoal"] as const;

// ── leaf parsers (never throw) ──────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Positive safe integer from a number or a plain decimal string ("3"). */
function asPositiveInteger(value: unknown): number | undefined {
	const n = typeof value === "number"
		? value
		: typeof value === "string" && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : NaN;
	return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

/**
 * Parse a `decisionMode` value. Anything other than an exact allowed mode
 * (after trimming) is "manual", the fail-safe default.
 */
export function parseMode(value: unknown): GoalDecisionMode {
	const text = asNonEmptyString(value);
	return text && (GOAL_DECISION_MODES as readonly string[]).includes(text) ? text as GoalDecisionMode : "manual";
}

/**
 * One `decisionLimits` layer. A key present in the layer is always set: an
 * invalid value becomes that key's built-in default and shadows lower layers.
 * A missing key or a missing object leaves the key unset, so the next layer
 * applies. A present non-object value means every default.
 */
type LimitsLayer = Partial<GoalDecisionLimits>;

function parseLimitsLayer(value: unknown): LimitsLayer {
	if (value === undefined) return {};
	if (!isPlainObject(value)) return { ...DEFAULT_GOAL_DECISION_LIMITS };
	const layer: LimitsLayer = {};
	for (const key of LIMIT_KEYS) {
		if (Object.hasOwn(value, key)) layer[key] = asPositiveInteger(value[key]) ?? DEFAULT_GOAL_DECISION_LIMITS[key];
	}
	return layer;
}

/**
 * Normalize a `decisionLimits` value into concrete limits. Invalid or missing
 * keys take their built-in default; a non-object value gives all defaults.
 */
export function normalizeLimits(value: unknown): GoalDecisionLimits {
	return { ...DEFAULT_GOAL_DECISION_LIMITS, ...parseLimitsLayer(value) };
}

/** One `decisionCritic` layer. An undefined leaf is unset and inherits from lower layers. */
type CriticLayer = { [K in keyof GoalDecisionCriticSettings]?: GoalDecisionCriticSettings[K] };

/**
 * Parse one `decisionCritic` layer. A present invalid leaf is unset and
 * shadows lower layers, as with limits. A present non-object value unsets
 * every leaf.
 */
function parseCriticLayer(value: unknown): CriticLayer {
	if (value === undefined) return {};
	if (!isPlainObject(value)) return { provider: undefined, model: undefined, thinkingLevel: undefined };
	const layer: CriticLayer = {};
	if (Object.hasOwn(value, "provider")) layer.provider = asNonEmptyString(value.provider);
	if (Object.hasOwn(value, "model")) layer.model = asNonEmptyString(value.model);
	if (Object.hasOwn(value, "thinkingLevel")) {
		const text = asNonEmptyString(value.thinkingLevel);
		layer.thinkingLevel = text !== undefined && THINKING_LEVELS.has(text) ? text as ThinkingLevel : undefined;
	}
	return layer;
}

// ── file reads (no cache) ───────────────────────────────────────────────────

interface RawSettingsFile {
	/** Exact file text, or "" when the file is missing or unreadable. */
	text: string;
	/** Parsed top-level object; empty for missing, invalid JSON, or non-object content. */
	record: Record<string, unknown>;
}

function readRawSettingsFile(target: string): RawSettingsFile {
	let text: string;
	try {
		text = fs.readFileSync(target, "utf8");
	} catch {
		return { text: "", record: {} };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { text, record: {} };
	}
	return { text, record: isPlainObject(parsed) ? parsed : {} };
}

// ── resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve decision settings from the global and project files, reading both
 * from disk on every call. `decisionMode` is read from the project layer only.
 */
export function resolveDecisionSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): GoalDecisionSettings {
	const project = readRawSettingsFile(goalSettingsPath(cwd, env)).record;
	const global = readRawSettingsFile(goalGlobalSettingsPath(env)).record;

	const criticLayer: CriticLayer = { ...parseCriticLayer(global[DECISION_CRITIC_KEY]), ...parseCriticLayer(project[DECISION_CRITIC_KEY]) };
	const critic: GoalDecisionCriticSettings = {};
	if (criticLayer.provider !== undefined) critic.provider = criticLayer.provider;
	if (criticLayer.model !== undefined) critic.model = criticLayer.model;
	if (criticLayer.thinkingLevel !== undefined) critic.thinkingLevel = criticLayer.thinkingLevel;

	const limits: GoalDecisionLimits = {
		...DEFAULT_GOAL_DECISION_LIMITS,
		...parseLimitsLayer(global[DECISION_LIMITS_KEY]),
		...parseLimitsLayer(project[DECISION_LIMITS_KEY]),
	};

	return {
		mode: parseMode(project[DECISION_MODE_KEY]),
		...(Object.keys(critic).length > 0 ? { critic } : {}),
		limits,
	};
}

/** Stable snapshot id: first 16 hex chars of sha256 over the raw project file text. */
function snapshotIdOf(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * Read `decisionMode` straight from the project settings file, bypassing every
 * in-process cache. Acceptance-time checks use this so a mode switch made by
 * another session takes effect. snapshotId identifies the exact file content
 * the mode came from. A missing file and an empty file share one id.
 */
export function readModeFreshFromDisk(cwd: string, env: NodeJS.ProcessEnv = process.env): { mode: GoalDecisionMode; snapshotId: string } {
	const { text, record } = readRawSettingsFile(goalSettingsPath(cwd, env));
	return { mode: parseMode(record[DECISION_MODE_KEY]), snapshotId: snapshotIdOf(text) };
}
