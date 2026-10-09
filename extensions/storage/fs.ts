import * as nodeFs from "node:fs";

/**
 * fs facade for goal state writes: identical to node:fs except that
 * renameSync() and promises.rename() retry transient Windows sharing
 * violations before giving up.
 *
 * On Windows, rename fails with EPERM/EACCES/EBUSY when any process holds
 * the target file open without FILE_SHARE_DELETE (another pi session, an
 * antivirus real-time scan, the search indexer). Goal state is written via
 * temp+rename on every checkpoint, so each write races those holders and a
 * bare rename intermittently aborts a checkpoint. The retry re-attempts the
 * SAME rename with short backoff; non-retryable errors and exhausted retries
 * surface the original error untouched. Nothing is deleted here: callers own
 * their temp files.
 */
const RETRYABLE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800]; // ~1.6s worst case

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRetryableRenameError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === "string" && RETRYABLE_CODES.has(code);
}

/** renameSync with bounded retry on transient Windows sharing violations. */
export function renameSync(from: string, to: string): void {
	for (let attempt = 0; ; attempt++) {
		try {
			nodeFs.renameSync(from, to);
			return;
		} catch (error) {
			if (!isRetryableRenameError(error) || attempt >= RETRY_DELAYS_MS.length) throw error;
			sleepSync(RETRY_DELAYS_MS[attempt]);
		}
	}
}

/** Async counterpart of renameSync for promise-based writers. */
export async function rename(from: string, to: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await nodeFs.promises.rename(from, to);
			return;
		} catch (error) {
			if (!isRetryableRenameError(error) || attempt >= RETRY_DELAYS_MS.length) throw error;
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
		}
	}
}

const promises = { ...nodeFs.promises } as typeof nodeFs.promises;
promises.rename = rename;

const fs = { ...nodeFs } as typeof nodeFs;
fs.renameSync = renameSync;
fs.promises = promises;

export { fs };
