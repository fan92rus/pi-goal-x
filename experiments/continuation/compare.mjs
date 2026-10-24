/** Real SDK, controlled provider. These are scenario probes, not human/model studies. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager,defineTool} from '@earendil-works/pi-coding-agent';
import {Type} from '@earendil-works/pi-ai';
import {output,roots} from './prepare.mjs';

const results=[];
const gapProbe=process.argv.includes('--probe-opt-out');
const text = value => ({text:value});
const tool = (name,args) => ({tool:name,args});
function steps(scenario) {
 const finish=[tool('write',{path:'result.txt',content:'verified result\n'}),text('The artifact is ready for its final check.'),tool('update_goal',{status:'complete'})];
 if(scenario==='reasoning') return [text('Compare the assumptions: the first option depends on a changing input.'),text('The stable option satisfies both requirements; I will now record the conclusion.'),...finish];
 if(scenario==='ordinary') return [tool('write',{path:'draft.txt',content:'first draft\n'}),text('Draft saved.'),tool('read',{path:'draft.txt'}),text('The draft matches the requested scope.'),...finish];
 if(scenario==='custom') return [tool('publish_report',{stage:1}),text('The first report section is saved.'),tool('publish_report',{stage:2}),text('The second report section is saved.'),...finish];
 if(scenario==='generic-status') return [tool('lookup_invoice',{id:'invoice-1'}),...finish];
 if(scenario==='wait') return [tool('update_goal',{continuation:{kind:'wait',reason:'Await the registered fixture producer',deadline:new Date(Date.now()+10_000).toISOString()}}),...finish];
 if(scenario==='busy-poll')return Array.from({length:4},()=>[tool('bash',{command:'ls .'}),text('Standing by.')]).flat();
 return [text('Standing by.'),text('Standing by.'),text('Standing by.'),text('Standing by.')];
}

async function run(policy,scenario,optIn=false) {
 const id=`${policy}-${scenario}${optIn?'-enabled':''}`;
 const cwd=path.join(output,'cases',id);
 fs.rmSync(cwd,{recursive:true,force:true});
 fs.mkdirSync(path.join(cwd,'.pi'),{recursive:true});
 const settings={...(optIn?{idleContinuationBackoff:true}:{}),...(scenario==='wait'?{strictExecutionContract:true}:{})};
 fs.writeFileSync(path.join(cwd,'.pi/pi-goal-x-settings.json'),JSON.stringify(settings));
 process.env.PI_GOAL_GLOBAL_SETTINGS_FILE=path.join(cwd,'global.json');
 fs.writeFileSync(process.env.PI_GOAL_GLOBAL_SETTINGS_FILE,'{}');
 let session,core,piApi,step=0,done=false,stopReason,waitSeen=false,waitQuiet=false,signalAt,optOutRequested=false;
 const requests=[],settlements=[],dialogs=[],commands=[],errors=[];
 const plan=steps(scenario);
 const began=Date.now();
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  const payload=JSON.parse(body);
  const audit=/read-only completion auditor/i.test(JSON.stringify(payload.messages?.[0]));
  const action=audit?text('The fixture artifact is present with the verified expected content.\n<approved/>'):(plan[step++]??text('Standing by.'));
  requests.push({at:Date.now()-began,audit,action:action.tool??'text'});
  res.writeHead(200,{'content-type':'text/event-stream'});
  const emit=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`);
  if(action.tool){emit({role:'assistant',tool_calls:[{index:0,id:`call_${requests.length}`,type:'function',function:{name:action.tool,arguments:JSON.stringify(action.args)}}]});emit({},'tool_calls');}
  else{emit({role:'assistant',content:action.text});emit({},'stop');}
  res.end('data: [DONE]\n\n');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const runtime=await ModelRuntime.create({authPath:path.join(cwd,'auth.json'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
  runtime.registerProvider('fixture',{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'fixture',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:512}]});
  const {default:extension}=await import(pathToFileURL(path.join(roots[policy],'extensions/goal.ts')));
  const loader=new DefaultResourceLoader({cwd,agentDir:path.join(cwd,'agent'),noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,extensionFactories:[pi=>{
   pi.registerTool(defineTool({name:'publish_report',label:'Publish report',description:'Save a completed report section in the current project.',parameters:Type.Object({stage:Type.Number()}),async execute(_id,args){fs.appendFileSync(path.join(cwd,'custom-report.txt'),`section ${args.stage}\n`);return{content:[{type:'text',text:`Section ${args.stage} saved.`}],details:{saved:true}};}}));
   pi.registerTool(defineTool({name:'lookup_invoice',label:'Look up invoice',description:'Read an invoice record.',parameters:Type.Object({id:Type.String()}),async execute(_id,args){return{content:[{type:'text',text:'Invoice awaits payment; this does not block the goal.'}],details:{id:args.id,status:'pending'}};}}));
   extension(pi);core=pi._goalCore;piApi=pi;
   pi.on('agent_settled',()=>{
    const g=core.state.goal,s=g?.scheduler;
    settlements.push({at:Date.now()-began,status:g?.status??'archived',phase:s?.phase,idle:s?.idle,used:s?.used});
    if(scenario==='opt-out'&&s?.idle?.nextAt>Date.now()&&!optOutRequested){
     optOutRequested=true;
     fs.writeFileSync(path.join(cwd,'.pi/pi-goal-x-settings.json'),JSON.stringify({idleContinuationBackoff:false}));
     // Stronger than UI refresh: explicitly ask scheduling to reconsider the
     // changed preference. A complete implementation must drop the delay.
     core.scheduler.schedule(session.extensionRunner.createContext());
     setTimeout(()=>{if(!done){stopReason='opt-out-still-paced';done=true;core.scheduler.shutdown();core.runtime.clearContinuationState();}},220);
     return;
    }
    if(scenario==='opt-out'&&optOutRequested&&!s?.idle){stopReason='opt-out-resumed';done=true;core.scheduler.shutdown();core.runtime.clearContinuationState();return;}
    if(scenario==='wait'&&s?.phase==='waiting'&&!waitSeen){
     waitSeen=true;const count=requests.length;const token=s.wait.token;
     setTimeout(()=>{waitQuiet=requests.length===count;signalAt=Date.now()-began;piApi.events.emit('pi-goal:wake',{goalId:g.id,waitToken:token});piApi.events.emit('pi-goal:wake',{goalId:g.id,waitToken:token});},220);
    }
    if(!g){done=true;stopReason='completed';}
    else if(s?.idle?.nextAt>Date.now()) {stopReason='paced';done=true;}
    else if(['idle','busy-poll'].includes(scenario)&&settlements.length>=4){stopReason='harness-ceiling';done=true;}
    if(done&&stopReason!=='paced'){core.scheduler.shutdown();core.runtime.clearContinuationState();}
   });
  }]});
  await loader.reload();
  ({session}=await createAgentSession({cwd,agentDir:path.join(cwd,'agent'),modelRuntime:runtime,model:runtime.getModel('fixture','fixture'),resourceLoader:loader,sessionManager:SessionManager.create(cwd,path.join(cwd,'sessions')),settingsManager:SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}})}));
  await session.bindExtensions({onError:event=>errors.push(event.error)});
  const command='/goal-direct Produce result.txt containing exactly verified result followed by a newline. Verify it and complete the goal.';
  commands.push(command);await session.prompt(command);
  const deadline=Date.now()+10_000;
  while(!done&&Date.now()<deadline)await delay(10);
  if(!done)throw new Error('Scenario timeout');
  const count=requests.length;await delay(150);assert.equal(requests.length,count,'no requests after stop or during observed quiet interval');
  const artifact=fs.existsSync(path.join(cwd,'result.txt'))?fs.readFileSync(path.join(cwd,'result.txt'),'utf8'):null;
  if(scenario==='opt-out')assert.notEqual(stopReason,'opt-out-still-paced','Known prototype gap: opting out leaves an already queued delay active');
  if(scenario==='opt-out')assert.equal(settlements.at(-1).used,settlements.find(s=>s.idle?.runs===2).used+1,'opting out must not reset consumed allowance');
  const expectedPace=(policy==='current'||optIn)&&['reasoning','custom','idle'].includes(scenario);
  assert.equal(stopReason,scenario==='opt-out'?'opt-out-resumed':expectedPace?'paced':['idle','busy-poll'].includes(scenario)?'harness-ceiling':'completed');
  if(stopReason==='completed')assert.equal(artifact,'verified result\n');
  if(scenario==='wait'){assert.equal(waitQuiet,true);assert.equal(requests.filter(r=>r.audit).length,1);}
  assert.deepEqual(errors,[]);
  const result={id,policy,scenario,optIn,passed:true,stopReason,startedAtMs:began,settings,finalSettings:JSON.parse(fs.readFileSync(path.join(cwd,'.pi/pi-goal-x-settings.json'),'utf8')),requests,settlements,commands,dialogs,artifact,customArtifact:fs.existsSync(path.join(cwd,'custom-report.txt'))?fs.readFileSync(path.join(cwd,'custom-report.txt'),'utf8'):null,waitQuiet,signalAt,quietWindowMs:150,elapsedMs:Date.now()-began,errors};
  results.push(result);console.log(JSON.stringify({id,stopReason,requests:requests.length,elapsedMs:result.elapsedMs}));
 }catch(error){results.push({id,policy,scenario,optIn,passed:false,error:error.stack,stopReason,finalSettings:JSON.parse(fs.readFileSync(path.join(cwd,'.pi/pi-goal-x-settings.json'),'utf8')),requests,settlements});console.log(JSON.stringify({id,passed:false,error:error.message}));}
 finally {core?.scheduler.shutdown();core?.runtime.clearContinuationState();if(session){await session.abort();session.dispose();}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.writeFileSync(path.join(output,gapProbe?'prototype-gap-results.json':'controlled-results.json'),JSON.stringify({evidence:'actual SDK with scripted provider; user-command entry, controlled model behavior',results},null,2)+'\n');}
}

if(gapProbe){await run('candidate','opt-out',true);}
else{
for(const scenario of ['ordinary','reasoning','custom','idle','generic-status','busy-poll'])for(const policy of ['original','current','candidate'])await run(policy,scenario);
await run('candidate','idle',true);
await run('candidate','wait');
}
process.exitCode=results.every(r=>r.passed)?0:1;
