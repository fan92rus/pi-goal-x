/** Install the packed artifact, then exercise its runtime without checkout imports. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,cpSync,realpathSync,lstatSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const evidence=process.env.PI_GOAL_PACKAGE_EVIDENCE??mkdtempSync(path.join(tmpdir(),'goal-package-evidence-'));
mkdirSync(evidence,{recursive:true});
const project=realpathSync(mkdtempSync(path.join(tmpdir(),'goal-installed-smoke-')));
const run=(command,args,cwd)=>execFileSync(command,args,{cwd,encoding:'utf8',maxBuffer:8*1024*1024,timeout:120000});
try {
 const [packed]=JSON.parse(run('npm',['pack','--json','--pack-destination',evidence],root));
 const tarball=path.join(evidence,packed.filename);
 writeFileSync(path.join(project,'package.json'),JSON.stringify({private:true,type:'module'}));
 const peers=['@earendil-works/pi-ai','@earendil-works/pi-coding-agent','@earendil-works/pi-tui','typebox'].map(name=>`${name}@${JSON.parse(readFileSync(path.join(root,'node_modules',name,'package.json'),'utf8')).version}`);
 writeFileSync(path.join(evidence,'install.log'),run('npm',['install','--no-audit','--no-fund',tarball,...peers],project));
 const installed=path.join(project,'node_modules/pi-goal-x');
 const entry=path.join(installed,'extensions/goal.ts');
 assert.equal(lstatSync(installed).isSymbolicLink(),false,'package is installed, not linked');
 assert.equal(realpathSync(entry),entry,'entry does not resolve into the checkout');
 assert.ok(!realpathSync(entry).startsWith(root),'smoke loaded checkout code');
 const files=['stabilization-utils.ts','tui-test-utils.ts','goal-stabilization-lifecycle.test.ts','goal-update-goal.test.ts','goal-task-count.test.ts','goal-context-usage.test.ts','goal-keyboard-focus.test.ts','update-goal-sdk-worker.mjs'];
 mkdirSync(path.join(installed,'tests'));
 for(const file of files)cpSync(path.join(root,'tests',file),path.join(installed,'tests',file));
 const tests=files.filter(file=>file.endsWith('.test.ts')).map(file=>`tests/${file}`);
 const output=run(process.execPath,['--experimental-strip-types','--test','--test-concurrency=2',...tests],installed);
 assert.match(output,/(?:#|ℹ)\s+fail 0/);
 assert.match(output,/(?:#|ℹ)\s+skipped 0/);
 writeFileSync(path.join(evidence,'tests.log'),output);
 const sdk=run(process.execPath,['--experimental-strip-types','tests/update-goal-sdk-worker.mjs'],installed);
 assert.equal(JSON.parse(sdk.trim().split('\n').at(-1)).archived,true);
 writeFileSync(path.join(evidence,'responses.log'),sdk);
 const version=JSON.parse(readFileSync(path.join(installed,'package.json'),'utf8')).version;
 const report={version,source:run('git',['rev-parse','HEAD'],root).trim(),tarball,integrity:packed.integrity,sha256:createHash('sha256').update(readFileSync(tarball)).digest('hex'),installedEntry:entry,passed:true};
 writeFileSync(path.join(evidence,'package.json'),JSON.stringify(report,null,2)+'\n');
 console.log(`Installed package PASS: ${version}; lifecycle, tool input, skipped tasks, focus, context and Responses/auditor smoke. Evidence: ${evidence}`);
} finally {rmSync(project,{recursive:true,force:true});}
