/** `pi -p` shape: one prompt that creates a goal, then a second turn that prints the final text. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';
import goalExtension from '../extensions/goal.ts';

const complete=process.argv.includes('--complete');
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'goal-print-sdk-'));
fs.mkdirSync(path.join(cwd,'.pi'));
fs.writeFileSync(path.join(cwd,'.pi/pi-goal-x-settings.json'),JSON.stringify({maxAutonomousRuns:2}));
process.env.PI_GOAL_GLOBAL_SETTINGS_FILE=path.join(cwd,'absent-global');
const finalText='FINAL TEXT after the goal was created.';
const requests=[];
const errors=[];
let session,core;
const server=http.createServer(async(req,res)=>{
	let body='';for await(const chunk of req)body+=chunk;requests.push(JSON.parse(body));
	res.writeHead(200,{'content-type':'text/event-stream'});
	const emit=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`);
	if(requests.length===1){
		emit({role:'assistant',tool_calls:[{index:0,id:'call-create-goal',type:'function',function:{name:'create_goal',arguments:JSON.stringify({objective:'Write result.txt containing the verified result.'})}}]});
		emit({},'tool_calls');
	}else if(complete){
		emit({role:'assistant',tool_calls:[{index:0,id:'call-update-goal',type:'function',function:{name:'update_goal',arguments:JSON.stringify({status:'complete',completion_summary:'Verified the goal in the continuation turn.'})}}]});
		emit({},'tool_calls');
	}else{
		emit({role:'assistant',content:finalText});
		emit({},'stop');
	}
	res.end('data: [DONE]\n\n');
});
try{
	await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
	const runtime=await ModelRuntime.create({authPath:path.join(cwd,'auth'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
	runtime.registerProvider('fixture',{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'fixture',models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:512}]});
	const loader=new DefaultResourceLoader({cwd,agentDir:cwd,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,extensionFactories:[pi=>{goalExtension(pi,{runCompletionAuditor:async()=>({approved:true,disapproved:false,output:'Approved fixture.'})});core=pi._goalCore;}]});
	await loader.reload();
	({session}=await createAgentSession({cwd,agentDir:cwd,modelRuntime:runtime,model:runtime.getModel('fixture','fixture'),resourceLoader:loader,sessionManager:SessionManager.create(cwd,path.join(cwd,'sessions')),settingsManager:SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}})}));
	await session.bindExtensions({mode:'print',onError:event=>errors.push(`${event.extensionPath}: ${event.error}`)});
	// Exactly what `pi -p` does: await the prompt, print the last assistant text, then dispose.
	await session.prompt('Create a goal with create_goal for writing result.txt, then reply with the final text.');
	const last=session.state.messages.at(-1);
	const lastText=last?.role==='assistant'?last.content.filter(part=>part.type==='text').map(part=>part.text).join(''):'';
	const completed=session.state.messages.some(message=>message.role==='toolResult'&&message.toolName==='update_goal');
	const result=complete?{
		passed:!core.state.goal&&completed&&last?.role!=='assistant'&&lastText===''&&errors.length===0&&requests.length===2,
		goalCompleted:!core.state.goal&&completed,
		providerRequests:requests.length,
		lastMessageRole:last?.role,
		errors,
	}:{
		passed:!!core.state.goal&&lastText===finalText&&errors.length===0&&requests.length>=2,
		goalCreated:!!core.state.goal,
		providerRequests:requests.length,
		lastAssistantText:lastText,
		errors,
	};
	console.log(JSON.stringify({...result,mode:complete?'complete':'text'}));
	assert.equal(result.passed,true,JSON.stringify(result));
}finally{
	core?.scheduler.shutdown();core?.runtime.clearContinuationState();
	if(session){await session.abort();session.dispose();}
	server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
	fs.rmSync(cwd,{recursive:true,force:true});
}
