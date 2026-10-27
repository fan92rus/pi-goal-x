/** Real-adapter payload comparison. onPayload always stops before dispatch. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {ModelRuntime, convertToLlm} from '@earendil-works/pi-coding-agent';
import {cacheGoalHistory} from '../../extensions/goal-prompt-cache.ts';
import {LiveTailRetention} from '../../extensions/goal-live-retention.ts';
import {captureOne} from './capture-context.mjs';
import {FIXTURES, userMessage, assistantMessage} from './fixtures.mjs';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const prefix = (a, b) => { let n=0; while(n<a.length && n<b.length && a[n].hash===b[n].hash) n++; return n; };
const textBlock = block => typeof block.content === 'string' ? block.content : undefined;
const root = fileURLToPath(new URL('../../', import.meta.url));

export function summarize(payload, transients=[]) {
 const blocks=payload.input??payload.messages;
 assert.ok(Array.isArray(blocks) && blocks.length, 'adapter omitted model-visible input');
 const markers=[];
 function visit(value, trail=[]) {
  if(!value || typeof value!=='object') return;
  if(value.cache_control || value.cachePoint) {
   assert.ok(!transients.includes(value.text), 'cache marker on a transient block');
   markers.push({path:trail, value:value.cache_control??value.cachePoint});
  }
  for(const [key, child] of Object.entries(value)) visit(child,[...trail,key]);
 }
 visit(payload);
 return {
  immutable:digest({system:payload.system,instructions:payload.instructions,systemMessages:blocks.filter(b=>b.role==='system'||b.role==='developer'),tools:payload.tools}),
  options:digest(Object.fromEntries(Object.entries(payload).filter(([k])=>!['system','instructions','tools','messages','input'].includes(k)))),
  blocks:blocks.map(block=>({hash:digest(block),bytes:Buffer.byteLength(JSON.stringify(block)),raw:block,...(textBlock(block)===undefined?{}:{text:textBlock(block)})})),
  bytes:Buffer.byteLength(JSON.stringify(payload)), markers,
 };
}

/** No payload normalization: a permitted display delta must match an exact block. */
export function compareReports(baseline, candidate) {
 assert.equal(candidate.version,baseline.version);
 assert.ok(baseline.rows.length>0,'empty baseline');
 assert.deepEqual(candidate.rows.map(r=>r.id),baseline.rows.map(r=>r.id),'missing/reordered scenario');
 const differences=[];
 for(let i=0;i<baseline.rows.length;i++) {
  const a=baseline.rows[i], b=candidate.rows[i];
  assert.equal(b.immutable,a.immutable,`${b.id}: immutable prefix changed`);
  assert.equal(b.options,a.options,`${b.id}: cache/provider options changed`);
  assert.deepEqual(b.markers,a.markers,`${b.id}: cache markers changed`);
  assert.equal(b.blocks.length,a.blocks.length,`${b.id}: unexpected block count`);
  for(let j=0;j<a.blocks.length;j++) {
   if(a.blocks[j].hash===b.blocks[j].hash) continue;
   assert.ok(!b.id.endsWith('/context-explicit-true'),`${b.id}: explicit opt-in differs from release`);
   let edits=0;
   const expected=value=>{
    if(typeof value==='string' && value.startsWith('Goal snapshot:') && value.includes('\nContext snapshot: unavailable\n')) {edits++;return value.replace('\nContext snapshot: unavailable\n','\n');}
    if(Array.isArray(value))return value.map(expected);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,expected(v)]));
    return value;
   };
   const approved=expected(a.blocks[j].raw);
   assert.ok(edits>0,`${b.id}: unexplained block ${j}`);
   assert.deepEqual(b.blocks[j].raw,approved,`${b.id}: unexpected counter edit`);
   differences.push({scenario:b.id,block:j,reason:'default-context-display-off',removedBytes:a.blocks[j].bytes-b.blocks[j].bytes});
  }
  if(a.reuse) {
   assert.equal(b.reuse?.blocks,a.reuse.blocks,`${b.id}: warm-prefix blocks lost`);
   const removed=a.blocks.slice(0,a.reuse.blocks).reduce((sum,block,j)=>sum+block.bytes-b.blocks[j].bytes,0);
   assert.equal(b.reuse.bytes,a.reuse.bytes-removed,`${b.id}: reusable history lost`);
  }
 }
 return {scenarios:candidate.rows.length,approvedDifferences:differences};
}

export async function buildReport() {
 const work=mkdtempSync(path.join(tmpdir(),'goal-cache-report-'));
 const rows=[];
 const samples=[];
 try {
  const runtime=await ModelRuntime.create({authPath:path.join(work,'auth.json'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
  for(const flavor of ['openai-responses','openai-completions','anthropic-messages','anthropic-compatible-completions']) {
   const api=flavor==='anthropic-compatible-completions'?'openai-completions':flavor;
   runtime.registerProvider('cache-report',{baseUrl:'http://127.0.0.1:1/v1',api,apiKey:'fixture-only',models:[{id:'fixture',name:'fixture',reasoning:false,input:['text','image'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:128}]});
   const model=runtime.getModel('cache-report','fixture');
   if(flavor==='anthropic-compatible-completions') model.compat={cacheControlFormat:'anthropic',supportsLongCacheRetention:true};
   for(const tier of ['none','short','long']) {
    const serialize=async (id,captured,messages=captured.messages) => {
     let payload;
     const transients=messages.filter(m=>m.customType==='pi-goal-live-context').map(m=>m.content);
     await runtime.streamSimple(model,{systemPrompt:captured.baseSystem+captured.extensionSystem,messages:convertToLlm(messages),tools:[...captured.hostTools,...captured.tools].map(t=>({name:t.name,description:t.description,parameters:t.schema}))},{sessionId:'cache-report-fixed-session',cacheRetention:tier,onPayload:value=>{
      payload=value;
      cacheGoalHistory(payload,transients);
      throw new Error('Captured before dispatch');
     }}).result();
     assert.ok(payload,`${id}: missing provider payload`);
     // Tool descriptions may contain the known physical SDK/fixture root only.
     const normalized=JSON.parse(JSON.stringify(payload).replaceAll(realpathSync(path.join(root,'node_modules/@earendil-works/pi-coding-agent')),'/sdk'));
     const row={id:`${flavor}/${tier}/${id}`,...summarize(normalized,transients)};
     rows.push(row);
     if(samples.length<2) samples.push({id:row.id,payload:normalized});
     return row;
    };
    for(const id of Object.keys(FIXTURES)) await captureOne(id,{inspect:async captured=>{await serialize(id,captured);}});
    for(const value of [false,true]) await captureOne('active-regular-no-tasks',{settings:{showContextUsage:value},inspect:async captured=>{await serialize(`context-explicit-${value}`,captured);}});
    await captureOne('active-regular-no-tasks',{inspect:async (captured,{capture,baseMessages})=>{
     const base=[...baseMessages];
     let previous;
     for(let n=0;n<4;n++) {
      const messages=await capture.runContext(base);
      const current=await serialize(`advance-${n}`,captured,messages);
      if(previous) {
       const count=prefix(previous.blocks,current.blocks);
       // Explicit marker movement is covered separately; raw bytes stay recorded.
       current.reuse={blocks:count,bytes:previous.blocks.slice(0,count).reduce((s,b)=>s+b.bytes,0)};
       if(flavor.startsWith('openai')) assert.equal(count,previous.blocks.length,'unchanged-policy prefix lost');
      }
      const retry=await serialize(`retry-${n}`,captured,await capture.runContext(base));
      assert.deepEqual(retry.blocks,current.blocks,'identical retry changed');
      previous=current;
      base.push(assistantMessage(`progress ${n}`),userMessage(`continue ${n}`));
     }
    }});
   }
  }
  // Long deterministic corpus: current bounds and reset counts, including image content.
  const retention=new LiveTailRetention();
  const history=[userMessage('bounded history')];
  let last, breaks=0;
  for(let n=0;n<1000;n++) {
   const fresh={state:'unchanging policy',counters:`Goal snapshot: ${n}`};
   const result=retention.apply('bounded',history,fresh);
   if(last && JSON.stringify(result.messages.slice(0,last.length))!==JSON.stringify(last)) breaks++;
   assert.ok(result.transientContents.length<=32,'tail bound exceeded');
   assert.ok(result.transientContents.slice(1).reduce((s,t)=>s+Buffer.byteLength(t),0)<=4096,'counter byte bound exceeded');
   assert.deepEqual(retention.apply('bounded',history,fresh),result,'retry changed at capacity');
   last=result.messages;
  }
  assert.ok(breaks>2 && breaks<40,'unexpected reset frequency');
  let source='archived-release';
  try {source=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();} catch { /* Gate assigns the pinned archive SHA. */ }
  return {version:1,source,node:process.version,lockfile:digest(readFileSync(path.join(root,'package-lock.json'))),sdk:JSON.parse(readFileSync(path.join(root,'node_modules/@earendil-works/pi-coding-agent/package.json'),'utf8')).version,corpus:{transitions:1000,breaks},rows,samples};
 } finally {rmSync(work,{recursive:true,force:true});}
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const candidate=await buildReport();
 const baselinePath=process.argv.find(a=>a.startsWith('--baseline='))?.slice(11);
 const output=process.argv.find(a=>a.startsWith('--output='))?.slice(9);
 if(output) writeFileSync(output,JSON.stringify(candidate,null,2)+'\n');
 const result=baselinePath?compareReports(JSON.parse(readFileSync(baselinePath,'utf8')),candidate):{scenarios:candidate.rows.length,corpus:candidate.corpus};
 console.log(JSON.stringify(result,null,2));
}
