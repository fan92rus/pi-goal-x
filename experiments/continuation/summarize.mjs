/** Save compact, reviewable evidence without credentials or full provider payloads. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {output,roots,repository} from './prepare.mjs';

const evidence=path.join(repository,'specs/2026-10-23-continuation-defaults-validation/evidence');
fs.mkdirSync(evidence,{recursive:true});
const read=file=>JSON.parse(fs.readFileSync(path.join(output,file),'utf8'));
const write=(file,value)=>fs.writeFileSync(path.join(evidence,file),JSON.stringify(value,null,2)+'\n');
const controlled=read('controlled-results.json');
assert.equal(controlled.results.length,20);assert.ok(controlled.results.every(r=>r.passed));
write('controlled-results.json',{evidence:controlled.evidence,meaning:'passed means the observed policy behavior matched the probe expectation; it is not an endorsement of that policy as the default',results:controlled.results.map(r=>({id:r.id,passed:r.passed,stopReason:r.stopReason,requests:r.requests.length,auditRequests:r.requests.filter(v=>v.audit).length,elapsedMs:r.elapsedMs,commands:r.commands,settings:r.settings,settlements:r.settlements,savedDelayAtObservationMs:r.settlements.at(-1)?.idle?.nextAt?(r.settlements.at(-1).idle.nextAt-r.startedAtMs-r.settlements.at(-1).at):null,quietWindowMs:r.quietWindowMs,waitQuiet:r.waitQuiet,signalAt:r.signalAt,artifact:r.artifact,customArtifact:r.customArtifact}))});
const gap=read('prototype-gap-results.json');
if(gap.results[0].passed===false)write('prototype-gap.json',{evidence:gap.evidence,meaning:'historical failing gate before the prototype fix',results:gap.results.map(r=>({id:r.id,passed:r.passed,error:r.error.split('\n')[0],stopReason:r.stopReason,finalSettings:r.finalSettings,requests:r.requests.length,settlements:r.settlements}))});
else write('prototype-opt-out-results.json',{evidence:gap.evidence,meaning:'same runtime gate after the prototype fix; opting out resumes immediately',results:gap.results.map(r=>({id:r.id,passed:r.passed,stopReason:r.stopReason,finalSettings:r.finalSettings,requests:r.requests.length,settlements:r.settlements}))});
write('preference-results.json',read('preference-results.json'));
const live=[];
for(const id of ['current-openrouter','candidate-openrouter-2','candidate-openrouter-ordinary']){
 const r=read(`live-${id}.json`);assert.equal(r.passed,true);
 const cwd=r.fixtureCwd??path.join(output,'live',id);
 const sessions=fs.readdirSync(path.join(cwd,'sessions')).filter(file=>file.endsWith('.jsonl')).flatMap(file=>fs.readFileSync(path.join(cwd,'sessions',file),'utf8').trim().split('\n').map(JSON.parse));
 const executorRequests=sessions.filter(e=>e.type==='message'&&e.message?.role==='assistant'&&e.message.stopReason!=='error').length;
 const pkg=JSON.parse(fs.readFileSync(path.join(cwd,'package.json'),'utf8'));
 assert.equal(Object.keys(pkg.dependencies??{}).length,0);
 live.push({id,evidence:r.evidence,provider:r.provider,model:r.model,thinking:r.thinking,ordinaryWording:r.ordinaryWording??false,passed:r.passed,elapsedMs:r.elapsedMs,requests:r.requests.length,executorRequests,auditorRequests:r.requests.length-executorRequests,usageReportedCostUSD:r.chargedOrReservedUSD??r.costUSD,usage:r.requests.reduce((sum,item)=>({input:sum.input+item.input,output:sum.output+item.output,cacheRead:sum.cacheRead+item.cacheRead,cacheWrite:sum.cacheWrite+item.cacheWrite}),{input:0,output:0,cacheRead:0,cacheWrite:0}),extraSchedulingDeclarations:r.extraSchedulingDeclarations,commands:r.commands,choices:r.dialogs.filter(d=>d.kind!=='notice').map(d=>({kind:d.kind,title:d.title.split('\n')[0],answer:d.answer})),toolSequence:r.tools.map(t=>t.name),artifactTestsPass:r.artifactTestsPass,independentAssertions:r.independentAssertions,completed:r.completed,noDependencies:true,finalSource:r.finalSource,testOutput:r.testOutput,errors:r.errors});
}
write('real-model-results.json',{meaning:'three observed runs of one model; cost is SDK-reported usage, not an invoice or a general performance comparison',results:live});
const failed=read('live-candidate-openrouter.json');
write('failed-attempts.json',{attempts:[{kind:'provider setup',provider:'opencode-go',result:'configured API key expired; switched to an already configured provider; no credential values copied'},{kind:'evaluation ceiling',provider:failed.provider,model:failed.model,requests:failed.requests.length,artifactTestsPass:failed.artifactTestsPass,completed:failed.completed,passed:failed.passed,explanation:'20-request harness ceiling interrupted independent review; raised to 40 and made execution errors fail promptly',usageReportedCostUSD:failed.chargedOrReservedUSD??failed.costUSD}]});
const terminal=path.join(output,'terminal');
const requestLog=JSON.parse(fs.readFileSync(path.join(terminal,'requests.json'),'utf8'));
const hostFile=path.join(terminal,'host.json');
const host=fs.existsSync(hostFile)?`Pi ${JSON.parse(fs.readFileSync(hostFile,'utf8')).sdk}`:'not recorded';
assert.equal(fs.readFileSync(path.join(terminal,'greeting.txt'),'utf8'),'Hello from goal\n');
write('terminal-journeys.json',{evidence:'actual installed Pi CLI in a pseudo-terminal; scripted provider, operator keyboard actions and xterm text snapshots',host,lifecycle:{actions:fs.readFileSync(path.join(terminal,'actions.jsonl'),'utf8').trim().split('\n').map(JSON.parse),requests:requestLog.map(item=>({...item,at:item.at-requestLog[0].at})),artifact:'Hello from goal\n',archivedFiles:fs.readdirSync(path.join(terminal,'.pi/goals/archived')),operatorObservations:{pauseKey:'Escape',requestsWhilePaused:2,artifactExistedWhilePaused:false,narrowViewport:{rows:20,columns:72},resumeCommand:'/goal-resume'}},settings:{actions:fs.readFileSync(path.join(output,'terminal-settings/actions.jsonl'),'utf8').trim().split('\n').map(JSON.parse),finalGlobal:JSON.parse(fs.readFileSync(path.join(terminal,'global.json'),'utf8')),finalProject:JSON.parse(fs.readFileSync(path.join(output,'terminal-settings/.pi/pi-goal-x-settings.json'),'utf8')),modelRequests:0,observedTransitions:['default false','global true','project inherits true','project false overrides global true','remove project override restores inherited true']}});
const runtimeTerminal=path.join(output,'terminal-opt-out');
const runtimeRequests=JSON.parse(fs.readFileSync(path.join(runtimeTerminal,'requests.json'),'utf8'));
const changedAt=fs.statSync(path.join(runtimeTerminal,'.pi/pi-goal-x-settings.json')).mtimeMs;
const dispatchDelay=runtimeRequests.find(item=>!item.optedIn).at-changedAt;
assert.ok(dispatchDelay>=0&&dispatchDelay<1000);assert.equal(fs.readFileSync(path.join(runtimeTerminal,'greeting.txt'),'utf8'),'Hello from goal\n');
write('terminal-runtime-opt-out.json',{evidence:'actual keyboard setting mutation while a paced goal runs',changedAt,dispatchDelayMs:dispatchDelay,settings:JSON.parse(fs.readFileSync(path.join(runtimeTerminal,'.pi/pi-goal-x-settings.json'),'utf8')),actions:fs.readFileSync(path.join(runtimeTerminal,'actions.jsonl'),'utf8').trim().split('\n').map(JSON.parse),requests:runtimeRequests,artifact:'Hello from goal\n',archivedFiles:fs.readdirSync(path.join(runtimeTerminal,'.pi/goals/archived'))});
const patch=fs.readFileSync(path.join(output,'prototype.diff'),'utf8').split(roots.current).join('current').split(roots.candidate).join('candidate');
fs.writeFileSync(path.join(evidence,'prototype.patch'),patch);
console.log(JSON.stringify({controlled:20,realModel:live.length,optOutGatePassed:gap.results[0].passed,evidence}));
