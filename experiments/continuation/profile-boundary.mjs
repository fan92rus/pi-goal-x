/** Observe native custom-turn prompt preparation without loading pi-goal-x. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager,defineTool} from '@earendil-works/pi-coding-agent';
import {Type} from '@earendil-works/pi-ai';
import {output} from './prepare.mjs';
import {piVersion} from '../../scripts/pi-host.mjs';

const results=[];
for(const direct of [false,true]){
 const cwd=path.join(output,`profile-boundary-${piVersion}`,direct?'fresh-custom':'after-confirm');
 fs.rmSync(cwd,{recursive:true,force:true});fs.mkdirSync(cwd,{recursive:true});
 const requests=[],errors=[];let piApi,confirmed=false,started=false,workDone=false,settled=0,session,nativePreparation=false;
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;const payload=JSON.parse(body);
  const names=payload.tools.map(t=>t.function.name),draft=names.includes('confirm_plan');
  const leading=[];for(const message of payload.messages){if(!['system','developer'].includes(message.role))break;leading.push(message);}
  const prompt=JSON.stringify(leading);
  requests.push({phase:draft?'draft':'execution',leadingMessages:leading.length,hasDraftGuidance:prompt.includes('DRAFT_ONLY_GUIDANCE'),hasWorkGuidance:prompt.includes('EXECUTION_ONLY_GUIDANCE'),tools:names});
  const action=draft?'confirm_plan':!workDone?'finish_work':null;
  res.writeHead(200,{'content-type':'text/event-stream'});
  const emit=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'boundary',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`);
  if(action){emit({role:'assistant',tool_calls:[{index:0,id:`c_${requests.length}`,type:'function',function:{name:action,arguments:'{}'}}]});emit({},'tool_calls');}
  else{emit({role:'assistant',content:'Done.'});emit({},'stop');}res.end('data: [DONE]\n\n');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const runtime=await ModelRuntime.create({authPath:path.join(cwd,'auth.json'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
  runtime.registerProvider('fixture',{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'fixture',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:512}]});
  const loader=new DefaultResourceLoader({cwd,agentDir:path.join(cwd,'agent'),noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,extensionFactories:[pi=>{
   piApi=pi;
   pi.on('before_agent_start',event=>{if(event.messageType==='custom')nativePreparation=true;});
   pi.registerTool(defineTool({name:'confirm_plan',label:'Confirm',description:'Confirm the plan.',promptSnippet:'DRAFT_ONLY_GUIDANCE',parameters:Type.Object({}),async execute(){confirmed=true;pi.setActiveTools(['finish_work']);return{content:[{type:'text',text:'Confirmed.'}],details:{},terminate:true};}}));
   pi.registerTool(defineTool({name:'finish_work',label:'Finish',description:'Finish the work.',promptSnippet:'EXECUTION_ONLY_GUIDANCE',parameters:Type.Object({}),async execute(){workDone=true;fs.writeFileSync(path.join(cwd,'result.txt'),'correct\n');return{content:[{type:'text',text:'Saved.'}],details:{}};}}));
   pi.on('session_start',()=>pi.setActiveTools([direct?'finish_work':'confirm_plan']));
   pi.on('agent_settled',()=>{
    settled++;
    if(confirmed&&!started){started=true;pi.sendMessage({customType:'boundary-test',content:'Execute the confirmed work.',display:false},{triggerTurn:true,deliverAs:'followUp'});}
   });
  }]});
  await loader.reload();
  ({session}=await createAgentSession({cwd,agentDir:path.join(cwd,'agent'),modelRuntime:runtime,model:runtime.getModel('fixture','fixture'),resourceLoader:loader,sessionManager:SessionManager.create(cwd,path.join(cwd,'sessions')),settingsManager:SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}})}));
  await session.bindExtensions({onError:event=>errors.push(event.error)});
  if(direct)piApi.sendMessage({customType:'boundary-test',content:'Execute the work.',display:false},{triggerTurn:true});
  else await session.prompt('Confirm the plan, then execute it.');
  const deadline=Date.now()+5000;while((!workDone||!session.isIdle||settled<(direct?1:2))&&Date.now()<deadline)await delay(10);
  assert.equal(fs.readFileSync(path.join(cwd,'result.txt'),'utf8'),'correct\n');assert.deepEqual(errors,[]);
  const execution=requests.filter(r=>r.phase==='execution');assert.equal(execution.length,2);
  assert.equal(execution[1].hasWorkGuidance,true);
  if(nativePreparation){assert.equal(execution[0].hasWorkGuidance,true);assert.equal(execution[0].hasDraftGuidance,false);}
  results.push({scenario:direct?'fresh custom trigger':'custom trigger after a terminating profile change',goalExtensionLoaded:false,nativePreparation,initialPromptCorrect:execution[0].hasWorkGuidance&&!execution[0].hasDraftGuidance,requests,artifact:'correct\n',errors});
 }finally{if(session){await session.abort();session.dispose();}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
const record={sdk:piVersion,meaning:'native host behavior with two fixture tools; pi-goal-x is not imported; historical SDK observations are not overwritten',results};
fs.writeFileSync(process.env.PI_GOAL_PROFILE_EVIDENCE??path.join(output,`profile-boundary-results-${piVersion}.json`),JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify(record));
