/** Isolated policy copies for the continuation product evaluation. */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const repository = fileURLToPath(new URL('../../', import.meta.url));
export const output = path.resolve(repository, process.env.PI_GOAL_COMPARISON_OUTPUT ?? 'experiments/runs/continuation-defaults');
export const roots = Object.fromEntries(['original', 'current', 'candidate'].map(policy => [policy, path.join(output, policy)]));

export function prepare() {
 fs.mkdirSync(output, {recursive:true});
 for (const [policy, root] of Object.entries(roots)) {
  fs.mkdirSync(root, {recursive:true});
  execFileSync('tar', ['-xf', '-', '-C', root], {input:execFileSync('git', ['archive', policy === 'original' ? '64c5ace' : '3551bcc', 'extensions'], {cwd:repository})});
  if (!fs.existsSync(path.join(root, 'node_modules'))) fs.symlinkSync(path.join(repository, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
 }
 const root = roots.candidate;
 function edit(file, before, after) {
  const target = path.join(root, 'extensions', file);
  const source = fs.readFileSync(target, 'utf8');
  if (!source.includes(before)) throw new Error(`Prototype patch anchor missing in ${file}`);
  fs.writeFileSync(target, source.replace(before, after));
 }
 // Prototype only. Production implementation must port and permanently test
 // all preference, persistence and runtime paths in the technical plan.
 edit('goal-settings.ts', 'strictExecutionContract?: boolean;', 'strictExecutionContract?: boolean;\n\tidleContinuationBackoff?: boolean;');
 edit('goal-settings.ts', '\t"strictExecutionContract",', '\t"strictExecutionContract",\n\t"idleContinuationBackoff",');
 edit('goal-settings.ts', '\t\t\tcase "strictExecutionContract":', '\t\t\tcase "idleContinuationBackoff":\n\t\t\tcase "strictExecutionContract":');
 edit('goal-settings.ts', '\tconst strictExecutionContract = track(', '\tconst idleContinuationBackoff = track("idleContinuationBackoff", resolveLeaf<boolean>({projectValue: project.layer.idleContinuationBackoff, globalValue: global.layer.idleContinuationBackoff, defaultValue: false}));\n\tconst strictExecutionContract = track(');
 edit('goal-settings.ts', '\n\t\tstrictExecutionContract,', '\n\t\tidleContinuationBackoff,\n\t\tstrictExecutionContract,');
 edit('goal-settings.ts', '\tif (settings.strictExecutionContract !== undefined)', '\tif (settings.idleContinuationBackoff !== undefined) persisted.idleContinuationBackoff = settings.idleContinuationBackoff;\n\tif (settings.strictExecutionContract !== undefined)');
 edit('goal-commands.ts', 'section: "Goal behavior" | "Task tracking" | "Completion auditor" | "Blocker Oracle";', 'section: "Goal behavior" | "Task tracking" | "Completion auditor" | "Blocker Oracle" | "Advanced execution";');
 edit('goal-commands.ts', '\t\t{ key: "disableTasks",', '\t\t{ key: "idleContinuationBackoff", label: "slow repeated idle replies (opt-in)", section: "Advanced execution", kind: "boolean" },\n\t\t{ key: "disableTasks",');
 edit('goal-commands.ts', 'if (key === "strictExecutionContract"', 'if (key === "idleContinuationBackoff" || key === "strictExecutionContract"');
 edit('goal-commands.ts', '\t\t\t\tlet lastSection: string | null = null;', '\t\t\t\toptions.push(`Scope: ${scope} (select to switch)`);\n\t\t\t\tlet lastSection: string | null = null;');
 edit('goal-commands.ts', 'applyEffectiveSettings();', 'applyEffectiveSettings();\n\t\t\t\tif (mutation.path[0] === "idleContinuationBackoff") core.scheduler.schedule(ctx);');
 edit('goal-scheduler.ts', 'private runHadWork = false;', 'private runHadWork = false;\n\tprivate runPacingEnabled = false;');
 edit('goal-scheduler.ts', 'this.runGoalContent = this.goalContent(this.core.state.goal);', 'this.runPacingEnabled = loadGoalSettings(ctx.cwd).idleContinuationBackoff === true;\n\t\tthis.runGoalContent = this.runPacingEnabled ? this.goalContent(this.core.state.goal) : undefined;');
 edit('goal-scheduler.ts', 'if (this.inRun) this.runHadWork = true;', 'if (this.inRun && this.runPacingEnabled) this.runHadWork = true;');
 edit('goal-scheduler.ts', 'this.implicitReady(state); this.paceIdle(state, current);', 'this.implicitReady(state); if (loadGoalSettings(ctx.cwd).idleContinuationBackoff && this.runPacingEnabled) this.paceIdle(state, current); else state.idle = undefined;');
 edit('goal-scheduler.ts', 'let s = this.state(ctx, g);', 'let s = this.state(ctx, g);\n\t\t\tif (!loadGoalSettings(ctx.cwd).idleContinuationBackoff && s.idle) s = this.update(ctx, state => { state.idle = undefined; }).scheduler!;');
 edit('goal-scheduler.ts', 'if (this.idleDelay(s) > 0) { deferred = true; return; }', 'if (!loadGoalSettings(ctx.cwd).idleContinuationBackoff) s.idle = undefined;\n\t\t\t\tif (this.idleDelay(s) > 0) { deferred = true; return; }');
 edit('goal-scheduler.ts', '(s.phase === "waiting" || this.idleDelay(s) > 0)', '(s.phase === "waiting" || (!!this.ctx && loadGoalSettings(this.ctx.cwd).idleContinuationBackoff === true && this.idleDelay(s) > 0))');
 const difference=spawnSync('diff', ['-ru', path.join(roots.current,'extensions'), path.join(root,'extensions')], {encoding:'utf8'});
 if(difference.error||![0,1].includes(difference.status))throw difference.error??new Error(difference.stderr);
 fs.writeFileSync(path.join(output, 'prototype.diff'), difference.stdout);
 return {output, roots};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
 console.log(JSON.stringify(prepare()));
}
