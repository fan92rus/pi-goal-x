import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { fs as wfs, rename as wrename, renameSync as wrenameSync } from "../extensions/storage/fs.ts";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

test("facade passes through non-rename fs API", () => {
  const dir = tempDir("fs-facade-passthrough");
  try {
    wfs.writeFileSync(path.join(dir, "a.txt"), "hello", "utf8");
    assert.equal(wfs.readFileSync(path.join(dir, "a.txt"), "utf8"), "hello");
    assert.equal(typeof wfs.readdirSync, "function");
    assert.ok(wfs.constants.F_OK !== undefined);
    assert.ok(typeof wfs.Stats === "function");
    assert.ok(wfs.lstatSync(path.join(dir, "a.txt")).isFile());
  } finally {
    cleanup(dir);
  }
});

test("facade passes through fs.promises API", async () => {
  const dir = tempDir("fs-facade-promises");
  try {
    await wfs.promises.writeFile(path.join(dir, "b.txt"), "world", "utf8");
    assert.equal(await wfs.promises.readFile(path.join(dir, "b.txt"), "utf8"), "world");
    const entries = await wfs.promises.readdir(dir);
    assert.deepEqual(entries, ["b.txt"]);
  } finally {
    cleanup(dir);
  }
});

test("facade renameSync and promises.rename succeed on free targets", async () => {
  const dir = tempDir("fs-facade-rename-ok");
  try {
    const src = path.join(dir, "src.txt");
    wfs.writeFileSync(src, "payload", "utf8");
    wrenameSync(src, path.join(dir, "dst-sync.txt"));
    assert.equal(wfs.readFileSync(path.join(dir, "dst-sync.txt"), "utf8"), "payload");

    const src2 = path.join(dir, "src2.txt");
    wfs.writeFileSync(src2, "payload2", "utf8");
    await wrename(src2, path.join(dir, "dst-async.txt"));
    assert.equal(await wfs.promises.readFile(path.join(dir, "dst-async.txt"), "utf8"), "payload2");
  } finally {
    cleanup(dir);
  }
});

test("non-retryable rename errors surface immediately (no backoff)", () => {
  const dir = tempDir("fs-facade-enoent");
  try {
    const missing = path.join(dir, "does-not-exist.txt");
    const t0 = Date.now();
    assert.throws(() => wrenameSync(missing, path.join(dir, "dst.txt")), (err: NodeJS.ErrnoException) => err.code === "ENOENT");
    assert.ok(Date.now() - t0 < 500, "ENOENT must not run the retry ladder");
  } finally {
    cleanup(dir);
  }
});

test("retryable rename errors run the ladder, surface honestly, keep the source file", () => {
  const dir = tempDir("fs-facade-retry");
  try {
    const src = path.join(dir, "busy.txt");
    wfs.writeFileSync(src, "still-here", "utf8");
    // Renaming a file onto an existing directory fails with EPERM on Windows
    // (retryable — the exact class this fix targets) and EISDIR on POSIX
    // (non-retryable). Both branches assert the correct contract.
    const t0 = Date.now();
    let err: NodeJS.ErrnoException | undefined;
    try {
      wrenameSync(src, dir);
    } catch (e) {
      err = e as NodeJS.ErrnoException;
    }
    const elapsed = Date.now() - t0;
    assert.ok(err, "rename onto an existing directory must fail");
    if (err.code === "EPERM") {
      assert.ok(elapsed >= 1400, `EPERM must run the full ~1.6s ladder, took ${elapsed}ms`);
    } else {
      assert.ok(elapsed < 500, `non-retryable ${err.code} must surface immediately, took ${elapsed}ms`);
    }
    assert.equal(wfs.readFileSync(src, "utf8"), "still-here", "facade must never delete the caller's file");
  } finally {
    cleanup(dir);
  }
});

test("async retry path behaves like the sync one", async () => {
  const dir = tempDir("fs-facade-retry-async");
  try {
    const src = path.join(dir, "busy.txt");
    wfs.writeFileSync(src, "still-here", "utf8");
    const t0 = Date.now();
    let err: NodeJS.ErrnoException | undefined;
    try {
      await wrename(src, dir);
    } catch (e) {
      err = e as NodeJS.ErrnoException;
    }
    const elapsed = Date.now() - t0;
    assert.ok(err, "async rename onto an existing directory must fail");
    if (err.code === "EPERM") {
      assert.ok(elapsed >= 1400, `EPERM must run the full ~1.6s ladder, took ${elapsed}ms`);
    } else {
      assert.ok(elapsed < 500, `non-retryable ${err.code} must surface immediately, took ${elapsed}ms`);
    }
  } finally {
    cleanup(dir);
  }
});
