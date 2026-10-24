/** Isolated declared-host checks; never replaces this checkout's dependencies. */
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {repository,output} from './prepare.mjs';

const run=promisify(execFile);
const versions=process.argv.slice(2).length?process.argv.slice(2):['0.83.0','0.84.1','0.85.1','0.86.0','0.87.0','1.0.0','1.4.0'];
const results=[];
const root=path.join(output,'production-hosts');fs.mkdirSync(root,{recursive:true});
const installed=JSON.parse(fs.readFileSync(path.join(repository,'node_modules/@earendil-works/pi-coding-agent/package.json'),'utf8')).version;
async function check(sdk){
 const logs=path.join(root,sdk);fs.mkdirSync(logs,{recursive:true});
 const cwd=sdk===installed?repository:logs;
 if(cwd!==repository){
 for(const dir of ['extensions','tests','scripts','experiments/context'])fs.cpSync(path.join(repository,dir),path.join(cwd,dir),{recursive:true});
 fs.copyFileSync(path.join(repository,'tsconfig.json'),path.join(cwd,'tsconfig.json'));
 const pkg=JSON.parse(fs.readFileSync(path.join(repository,'package.json'),'utf8'));
 const dependencies=Object.fromEntries(['pi-ai','pi-coding-agent','pi-tui'].map(name=>[`@earendil-works/${name}`,sdk]));
 Object.assign(dependencies,{typebox:pkg.devDependencies.typebox,'@xterm/headless':pkg.devDependencies['@xterm/headless'],'@types/node':JSON.parse(fs.readFileSync(path.join(repository,'node_modules/@types/node/package.json'),'utf8')).version});
 fs.writeFileSync(path.join(cwd,'package.json'),JSON.stringify({private:true,type:'module',dependencies,overrides:pkg.overrides}));
 }
 const phases=[];
 try{
  for(const [phase,cmd,args] of [
   ...(cwd===repository?[]:[['install','npm',['install','--ignore-scripts','--no-package-lock','--no-audit','--no-fund']]]),
   ['typecheck',path.join(repository,'node_modules/.bin/tsc'),['--noEmit']],
   ['sdk',process.execPath,['--experimental-strip-types','--import','./scripts/test-adapter-hooks.mjs','--test','tests/e2e/goal-prompt-cache-sdk.test.ts','tests/e2e/goal-scheduler-sdk.test.ts','tests/e2e/goal-continuation-user.test.ts','tests/goal-prompt-profile.test.ts','tests/goal-rpc-dialogs.test.ts','tests/goal-widget-lifetime.test.ts']],
   ['providers',process.execPath,['--experimental-strip-types','experiments/context/provider-crosscheck.mjs']],
  ]){
   try{const result=await run(cmd,args,{cwd,env:{...process.env,PI_GOAL_CONTEXT_CAPTURE_CWD:path.join(logs,'context-fixture')},timeout:180000,maxBuffer:4*1024*1024});fs.writeFileSync(path.join(logs,`${phase}.log`),result.stdout+result.stderr);phases.push({phase,passed:true});}
   catch(error){fs.writeFileSync(path.join(logs,`${phase}.log`),String(error.stdout??'')+String(error.stderr??error.message));phases.push({phase,passed:false});throw error;}
  }
  results.push({sdk,passed:true,phases});
 }catch(error){results.push({sdk,passed:false,phases,error:String(error.message).slice(0,200)});}
 console.log(JSON.stringify(results.at(-1)));
 fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({node:process.version,results},null,2)+'\n');
}
for(let i=0;i<versions.length;i+=2)await Promise.all(versions.slice(i,i+2).map(check));
process.exitCode=results.every(r=>r.passed)?0:1;
