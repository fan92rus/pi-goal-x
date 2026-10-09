import * as fs from "node:fs";

/**
 * Bounded retry for atomic renames on Windows: a concurrent reader of the
 * target file (antivirus real-time scan, search indexer, another pi session)
 * holds it open without FILE_SHARE_DELETE, so renameSync intermittently fails
 * with EPERM/EACCES/EBUSY even though the write itself is fine. Every failed
 * attempt retries on the SAME temp file; the temp is discarded only when
 * giving up, so a failed write no longer leaves `.tmp` litter behind.
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

function discardTempFileSync(tempPath: string): void {
	try {
		fs.rmSync(tempPath, { force: true });
	} catch {
		// best effort: a leftover temp costs nothing but disk space
	}
}

/** renameSync with bounded retry on transient Windows sharing violations. */
export function renameAtomicSync(tempPath: string, target: string): void {
	for (let attempt = 0; ; attempt++) {
		try {
			fs.renameSync(tempPath, target);
			return;
		} catch (error) {
			if (!isRetryableRenameError(error) || attempt >= RETRY_DELAYS_MS.length) {
				discardTempFileSync(tempPath);
				throw error;
			}
			sleepSync(RETRY_DELAYS_MS[attempt]);
		}
	}
}

/** Async counterpart of renameAtomicSync for promise-based writers. */
export async function renameAtomicAsync(tempPath: string, target: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.promises.rename(tempPath, target);
			return;
		} catch (error) {
			if (!isRetryableRenameError(error) || attempt >= RETRY_DELAYS_MS.length) {
				try {
					await fs.promises.rm(tempPath, { force: true });
				} catch {
					// best effort
				}
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
		}
	}
}
