export interface TaskProgressInput {
	task_id: string;
	status: "start" | "complete" | "skipped" | "pending";
	evidence?: string;
	reason?: string;
}

type Result = {ok: true; updates: TaskProgressInput[]; batch: boolean} | {ok: false; message: string};
const fields = ["task_id", "status", "evidence", "reason"] as const;
const statuses = new Set(["start", "complete", "skipped", "pending"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Normalize transport noise without discarding a meaningful task instruction. */
export function normalizeTaskProgress(input: unknown): Result {
	const fail = (message: string): Result => ({ok: false, message});
	if (!object(input)) return fail("Provide task_id and status, or an updates batch.");
	const normalize = (raw: Record<string, unknown>): Partial<TaskProgressInput> | undefined => {
		const result: Record<string, string> = {};
		for (const field of fields) {
			const value = raw[field];
			if (value === undefined) continue;
			if (typeof value !== "string") return;
			if (value.trim()) result[field] = value.trim();
		}
		if (result.status && !statuses.has(result.status)) return;
		return result as Partial<TaskProgressInput>;
	};
	const complete = (value: Partial<TaskProgressInput>): value is TaskProgressInput => !!value.task_id && !!value.status;
	const root = normalize(input);
	if (!root) return fail("Task fields must be strings; status must be start, complete, skipped, or pending.");
	if (input.updates === undefined || (Array.isArray(input.updates) && input.updates.length === 0)) {
		return complete(root) ? {ok: true, updates: [root], batch: false}
			: fail("Provide task_id and status, or a non-empty updates batch.");
	}
	if (!Array.isArray(input.updates) || input.updates.length > 100) return fail("updates must contain 1–100 valid task updates.");
	const updates: TaskProgressInput[] = [];
	for (const entry of input.updates) {
		if (!object(entry) || Object.keys(entry).some(key => !fields.includes(key as typeof fields[number]))) return fail("updates must contain 1–100 valid task updates.");
		const normalized = normalize(entry);
		if (!normalized || !complete(normalized)) return fail("updates must contain 1–100 valid task updates.");
		updates.push(normalized);
	}
	if (!updates.some(entry => fields.every(field => root[field] === undefined || root[field] === entry[field]))) {
		return fail("Top-level task fields conflict with updates. Put each instruction in updates and omit the top-level task fields.");
	}
	return {ok: true, updates, batch: true};
}
