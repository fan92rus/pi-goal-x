#!/usr/bin/env node
/**
 * upstream-sync.mjs — auto-sync of the fan92rus/pi-goal-x fork with upstream
 * (tmonk/pi-goal-x), following the pi livecraft pattern but running LOCALLY
 * (scheduled task) so conflict hand-off can reach the SelfHeal orchestrator
 * on localhost — GitHub-hosted runners cannot reach the LAN orchestrator.
 *
 * Flow (hourly task, `--publish` enables the npm stage):
 *   1. guards: repo root, branch main, clean worktree
 *   2. git fetch upstream --tags; latest upstream release tag (v*, version sort)
 *   3. tag already ancestor of main → up to date (publish may still run)
 *   4. git merge --no-commit <tag>
 *        - conflicts → git merge --abort → POST {SELFHEAL_URL}/enqueue-conflict
 *          {repoTag:"fan92rus/pi-goal-x", tag} → SelfHeal spawns the resolver
 *          agent (model + per-repo contract from its config) → exit 3
 *   5. checks: npm install; npm run check; unit + integration tests via the
 *      adapter-hook invocation (`npm test` runner is broken on Windows).
 *      Gate: failing-test NAME SET after merge ⊆ baseline
 *      (scripts/upstream-sync-test-baseline.json). A NEW failing name must
 *      reproduce on pre-merge HEAD to count as env drift (then it is added to
 *      the baseline with a maintenance commit); otherwise it is a merge
 *      regression → merge abort, exit 4.
 *   6. git commit (completes the merge) → git push origin main
 *   7. publish (--publish, npm auth required): package.json is temporarily
 *      renamed to @fan92rus/pi-goal-x with version `<upstream>-fan.<n>`
 *      (collision loop against npm), published, then restored — the repo
 *      keeps the upstream package name, so package.json merges stay clean.
 *
 * State: .git/upstream-sync-state.json (local, never committed).
 * Logs:  D:/tmp/pi-goalx-sync-YYYYMMDD.log (kept: last 14).
 * Exit codes: 0 ok/skip, 2 usage/environment, 3 conflict handed to SelfHeal,
 *             4 gate failure (regression), 5 publish attempted but failed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "origin";
const UPSTREAM = "upstream";
const BRANCH = "main";
const FORK_PACKAGE = "@fan92rus/pi-goal-x";
const PUBLISH_TAG = "fan";
const BASELINE = JSON.parse(fs.readFileSync(path.join(REPO, "scripts", "upstream-sync-test-baseline.json"), "utf8"));
const SELFHEAL_URL = process.env.SELFHEAL_URL ?? "http://localhost:5080";
// Windows: npm — это .cmd-шимм, который spawnSync без shell не исполняет
// (Node ≥18.20, CVE-2024-27980, EINVAL), а с shell — ломает кавычки аргументов.
// Надёжный способ — node npm-cli.js напрямую; фолбэки для нестандартных установок.
function resolveNpm() {
	if (process.platform !== "win32") return { cmd: "npm", prefix: [], shell: false };
	const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	if (fs.existsSync(cli)) return { cmd: process.execPath, prefix: [cli], shell: false };
	return { cmd: "npm.cmd", prefix: [], shell: true };
}
const NPM = resolveNpm();
const LOG_DIR = "D:/tmp";
const PUBLISH = process.argv.includes("--publish");

const now = new Date();
const stamp = now.toISOString().replaceAll("[:TZ]", "-").slice(0, 19);
const logFile = path.join(LOG_DIR, `pi-goalx-sync-${stamp.replaceAll(":", "").slice(0, 8)}.log`);
fs.mkdirSync(LOG_DIR, { recursive: true });
const logStream = fs.createWriteStream(logFile, { flags: "a" });
function log(msg) {
	const line = `[${new Date().toISOString()}] ${msg}`;
	console.log(line);
	logStream.write(line + "\n");
}
function die(code, msg) { log(`FATAL(${code}): ${msg}`); logStream.end(); process.exit(code); }

function sh(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { cwd: REPO, encoding: "utf8", shell: false, ...opts });
	if (r.status !== 0 && !opts.allowFail) {
		die(2, `${cmd} ${args.join(" ")} failed (${r.status}): ${(r.stderr || r.stdout || "").slice(0, 400)}`);
	}
	return r;
}
function shOut(cmd, args) {
	return execFileSync(cmd, args, { cwd: REPO, encoding: "utf8" }).trim();
}

async function enqueueConflict(tag) {
	log(`conflict merging ${tag} — handing off to SelfHeal at ${SELFHEAL_URL}`);
	try {
		const res = await fetch(`${SELFHEAL_URL}/enqueue-conflict`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ repoTag: "fan92rus/pi-goal-x", tag }),
		});
		const body = await res.text();
		log(`enqueue-conflict: HTTP ${res.status} ${body.slice(0, 300)}`);
		return res.ok;
	} catch (e) {
		log(`enqueue-conflict FAILED: ${e.message}`);
		return false;
	}
}

/** Run one test suite; return { failed: Map<name, file> } parsed from TAP. */
function runTests(kind, args, outFile) {
	const r = spawnSync(process.execPath, ["--experimental-strip-types", "--import", "./scripts/test-adapter-hooks.mjs", "--test", ...args], {
		cwd: REPO, encoding: "utf8", timeout: 10 * 60_000, shell: false,
	});
	fs.writeFileSync(outFile, (r.stdout || "") + (r.stderr || ""));
	const failed = new Map();
	const lines = ((r.stdout || "") + "\n" + (r.stderr || "")).split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^not ok \d+ - (.+?)(?:\s+#\s+\w+)?$/);
		if (!m) continue;
		const name = m[1].trim();
		let file = "(unknown)";
		for (let j = i + 1; j < Math.min(i + 14, lines.length); j++) {
			const loc = lines[j].match(/location:\s*'([^']+?)"/) ?? lines[j].match(/location:\s*'([^']+)'/);
			if (loc) { file = loc[1].replace(/^.*[\\/]tests[\\/]/, "tests/"); break; }
			if (/^ok \d+/.test(lines[j]) || /^# Subtest/.test(lines[j])) break;
		}
		failed.set(name, file);
	}
	return { failed, exitCode: r.status, log: outFile };
}

function unknownFailures(kind, failed) {
	const base = new Set(BASELINE[kind] ?? []);
	return [...failed.entries()].filter(([name]) => !base.has(name));
}

// ── guards ───────────────────────────────────────────────────────────────────
log(`=== upstream-sync start (repo ${REPO}, publish=${PUBLISH}) ===`);
if (shOut("git", ["branch", "--show-current"]) !== BRANCH) die(2, `must run on ${BRANCH}`);
if (shOut("git", ["status", "--porcelain"]).length > 0) die(2, "worktree not clean — refusing to sync");

// GitHub workflow upstream-sync.yml — основной мерджер; не гоняемся с ним.
// (gh отсутствует/упал → продолжаем: fail-open, локальная задача всё ещё резерв.)
try {
	const gh = spawnSync("gh", ["run", "list", "--workflow=upstream-sync.yml", "--status", "in-progress", "--json", "databaseId"],
		{ encoding: "utf8", shell: false, timeout: 30_000 });
	if (gh.status === 0 && JSON.parse(gh.stdout || "[]").length > 0) {
		log("GitHub upstream-sync run in progress — exiting to avoid a race");
		logStream.end();
		process.exit(0);
	}
} catch { /* gh not available — continue */ }

// ── fetch + latest tag ───────────────────────────────────────────────────────
sh("git", ["fetch", UPSTREAM, "--tags"]);
sh("git", ["fetch", ORIGIN]);
const tag = shOut("git", ["tag", "--list", "v*", `--sort=-v:refname`, "--merged", `${UPSTREAM}/${BRANCH}`]).split("\n")[0]?.trim();
if (!tag) die(2, "no upstream release tags found");

const stateFile = path.join(REPO, ".git", "upstream-sync-state.json");
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
let merged = false;

if (sh("git", ["merge-base", "--is-ancestor", tag, BRANCH], { allowFail: true }).status === 0) {
	log(`upstream tag ${tag} already merged — nothing to sync`);
} else {
	log(`merging upstream ${tag} into ${BRANCH} (no-commit)`);
	const m = sh("git", ["merge", "--no-commit", "--no-ff", tag], { allowFail: true });
	if (m.status !== 0) {
		const conflicted = shOut("git", ["diff", "--name-only", "--diff-filter=U"]);
		sh("git", ["merge", "--abort"], { allowFail: true });
		const ok = await enqueueConflict(tag);
		die(ok ? 3 : 2, `merge conflict with ${tag} in: ${conflicted.split("\n").join(", ")} — SelfHeal hand-off ${ok ? "queued" : "FAILED (enqueue manually)"}`);
	}

	// ── checks on the merged tree ──────────────────────────────────────────
	log("checks: npm install");
	sh(NPM.cmd, [...NPM.prefix, "install", "--no-audit", "--no-fund"], { timeout: 5 * 60_000, shell: NPM.shell });
	log("checks: npm run check (tsc)");
	sh(NPM.cmd, [...NPM.prefix, "run", "check"], { timeout: 3 * 60_000, shell: NPM.shell });

	log("checks: unit + integration (adapter-hook invocation)");
	const unit = runTests("unit", ["tests/*.test.ts"], path.join(LOG_DIR, "pi-goalx-sync-after-unit.log"));
	const integ = runTests("integration", ["tests/integration/*.test.ts"], path.join(LOG_DIR, "pi-goalx-sync-after-int.log"));
	const unknownUnit = unknownFailures("unit", unit.failed);
	const unknownInteg = unknownFailures("integration", integ.failed);
	log(`unit: ${unit.failed.size} failed (${unknownUnit.length} unknown), integration: ${integ.failed.size} failed (${unknownInteg.length} unknown)`);

	let unknown = [...unknownUnit, ...unknownInteg];
	if (unknown.length > 0) {
		// Reproduce unknown failures on PRE-merge HEAD: env drift vs regression.
		log(`unknown failures: ${unknown.map(([n]) => n).join(" | ")} — reproducing on pre-merge HEAD`);
		const files = [...new Set(unknown.map(([, f]) => f))];
		sh("git", ["merge", "--abort"], { allowFail: true });
		sh(NPM.cmd, [...NPM.prefix, "install", "--no-audit", "--no-fund"], { timeout: 5 * 60_000, shell: NPM.shell });
		const still = [];
		for (const f of files) {
			const kind = f.includes("integration") ? "integration" : "unit";
			const rerun = runTests(kind, [f], path.join(LOG_DIR, "pi-goalx-sync-preregression.log"));
			for (const [name] of rerun.failed) if (unknown.some(([n]) => n === name)) still.push(name);
		}
		const drift = unknown.filter(([n]) => still.includes(n));
		const regression = unknown.filter(([n]) => !still.includes(n));
		if (regression.length > 0) {
			die(4, `merge REGRESSION (fails only after merge): ${regression.map(([n]) => n).join(", ")} — merge aborted, see ${path.join(LOG_DIR, "pi-goalx-sync-after-unit.log")}`);
		}
		// env drift: extend baseline with a maintenance commit, then re-merge
		for (const [name, ] of drift) {
			const kind = unit.failed.has(name) ? "unit" : "integration";
			BASELINE[kind].push(name);
		}
		fs.writeFileSync(path.join(REPO, "scripts", "upstream-sync-test-baseline.json"), JSON.stringify(BASELINE, null, 2) + "\n");
		sh("git", ["add", "scripts/upstream-sync-test-baseline.json"]);
		sh("git", ["commit", "-m", `chore: upstream-sync baseline drift after env change (${drift.map(([n]) => n).join(", ")}) [upstream-sync]`]);
		log(`env drift accepted into baseline: ${drift.map(([n]) => n).join(", ")}`);
		m.status = sh("git", ["merge", "--no-commit", "--no-ff", tag], { allowFail: true }).status;
		if (m.status !== 0) die(2, "re-merge after baseline update failed unexpectedly");
	}

	sh("git", ["commit", "--no-edit"]);
	log(`merge committed: ${shOut("git", ["rev-parse", "--short", "HEAD"])}`);
	merged = true;
	sh("git", ["push", ORIGIN, BRANCH]);
	log(`pushed ${BRANCH} → ${ORIGIN}`);
	state.lastSyncedTag = tag;
}

// ── publish (optional) ───────────────────────────────────────────────────────
if (PUBLISH) {
	const head = shOut("git", ["rev-parse", "HEAD"]);
	const who = spawnSync(NPM.cmd, [...NPM.prefix, "whoami"], { encoding: "utf8", shell: NPM.shell, timeout: 60_000 });
	if (who.status !== 0) {
		log("publish SKIPPED: npm not authenticated (npm whoami failed). Run `npm login` or set a token in ~/.npmrc.");
	} else if (state.lastPublishedSha === head && !merged) {
		log(`publish SKIPPED: HEAD ${head.slice(0, 8)} already published as ${state.lastPublishedVersion}`);
	} else {
		const pkgPath = path.join(REPO, "package.json");
		const pkgRaw = fs.readFileSync(pkgPath, "utf8");
		const pkg = JSON.parse(pkgRaw);
		const base = pkg.version;
		let version = null;
		for (let n = 0; n < 100; n++) {
			const candidate = `${base}-fan.${n}`;
			const view = spawnSync(NPM.cmd, [...NPM.prefix, "view", `${FORK_PACKAGE}@${candidate}`, "version"], { encoding: "utf8", shell: NPM.shell, timeout: 60_000 });
			if (view.status !== 0) { version = candidate; break; }
		}
		if (!version) die(5, "could not find a free -fan.N version after 100 attempts");
		pkg.name = FORK_PACKAGE;
		pkg.version = version;
		// npm trusted publishing проверяет repository.url против публикующего
		// GitHub-репо — должен быть форк, не upstream.
		pkg.repository = { type: "git", url: `git+https://github.com/fan92rus/pi-goal-x.git` };
		fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
		const pub = spawnSync(NPM.cmd, [...NPM.prefix, "publish", "--access", `public`, `--tag`, PUBLISH_TAG], { cwd: REPO, encoding: "utf8", shell: NPM.shell, timeout: 5 * 60_000 });
		fs.writeFileSync(pkgPath, pkgRaw); // restore the upstream-shaped package.json
		if (pub.status !== 0) {
			log(`publish FAILED: ${(pub.stderr || pub.stdout || "").slice(0, 500)}`);
			die(5, `npm publish failed — repo state restored, nothing corrupted`);
		}
		log(`published ${FORK_PACKAGE}@${version} (tag ${PUBLISH_TAG}) from ${head.slice(0, 8)}`);
		state.lastPublishedSha = head;
		state.lastPublishedVersion = version;
	}
}

fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
// rotate: keep last 14 sync logs
const logs = fs.readdirSync(LOG_DIR).filter((f) => f.startsWith("pi-goalx-sync-")).sort();
for (const old of logs.slice(0, Math.max(0, logs.length - 14))) {
	try { fs.rmSync(path.join(LOG_DIR, old), { force: true }); } catch {}
}
log("=== upstream-sync done ===");
logStream.end();
