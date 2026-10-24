/** Offline request equality and scheduler-entry measurements for one source copy. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';

const [root,mode]=process.argv.slice(2);
process.env.PI_GOAL_GLOBAL_SETTINGS_FILE=path.join(root,'profile-global.json');
fs.writeFileSync(process.env.PI_GOAL_GLOBAL_SETTINGS_FILE,'{}');
const load=relative=>import(pathToFileURL(path.join(root,relative)));
const digest=value=>createHash('sha256').update(value).digest('hex');
let result;
if(mode==='context'){
 const {captureOne}=await load('experiments/context/capture-context.mjs');
 const {FIXTURES}=await load('experiments/context/fixtures.mjs');
 const {measureContext,serializeRequest}=await load('experiments/context/measure-context.mjs');
 const rows=[];
 for(const fixture of Object.keys(FIXTURES).sort()){
  const captured=await captureOne(fixture);
  const serialized=serializeRequest(captured);
  rows.push({fixture,breakdown:measureContext(captured),requestSHA256:digest(serialized.total),
   prefixSHA256:digest(serialized.system+'\n'+serialized.tools+'\n'+serialized.hostTools)});
 }
 result={mode,rows};
}else{
 assert.equal(mode,'entry');
 const {GoalScheduler}=await load('extensions/goal-scheduler.ts');
 const {invalidateGoalSettingsCache}=await load('extensions/goal-settings.ts');
 const rows=[];
 for(const optIn of [false,true])for(const tasks of [10,50,1000]){
  const cwd=path.join(root,'profile',`${tasks}-${optIn}`);
  fs.mkdirSync(path.join(cwd,'.pi'),{recursive:true});
  fs.writeFileSync(path.join(cwd,'.pi/pi-goal-x-settings.json'),JSON.stringify(optIn?{idleContinuationBackoff:true}:{}));
  invalidateGoalSettingsCache();
  const goal={id:'profile',objective:'Produce and verify a correct result.',taskList:{tasks:Array.from({length:tasks},(_,i)=>({id:`t${i}`,title:`Implement task ${i}`,status:'pending'}))}};
  const core={state:{goal},runtime:{clearContinuationTimer(){}}};
  const scheduler=new GoalScheduler(core);
  let snapshots=0;
  if(scheduler.goalContent){const original=scheduler.goalContent.bind(scheduler);scheduler.goalContent=g=>{snapshots++;return original(g);};}
  const op=()=>{
   // Instrument logical-run entry only; no timer, storage mutation or inference.
   scheduler.inRun=false;scheduler.begin({cwd});
   for(let i=0;i<20;i++)scheduler.recordWork?.();
  };
  for(let i=0;i<100;i++)op();
  snapshots=0;const times=[];
  for(let i=0;i<100;i++){const start=performance.now();for(let j=0;j<10;j++)op();times.push((performance.now()-start)/10);}
  times.sort((a,b)=>a-b);
  rows.push({tasks,oversizedStressFixture:tasks>50,optIn,samples:100,operationsPerSample:10,workEventsPerOperation:20,snapshots,
   p50Ms:times[50],p95Ms:times[95],goalJSONBytes:Buffer.byteLength(JSON.stringify(goal))});
  if(tasks===50){
   const cold=[];snapshots=0;
   for(let i=0;i<100;i++){invalidateGoalSettingsCache();const start=performance.now();op();cold.push(performance.now()-start);}
   cold.sort((a,b)=>a-b);
   rows.at(-1).coldSettings={samples:100,operationsPerSample:1,snapshots,p50Ms:cold[50],p95Ms:cold[95]};
  }
  scheduler.shutdown();
 }
 result={mode,method:'100 warm-up operations; 100 samples of 10 begin + 20 recordWork calls; cached settings; no storage or model work',rows};
}
process.stdout.write(JSON.stringify(result)+'\n');
// Fixture hooks may arm host timers. All measured work has settled.
process.exit(0);
