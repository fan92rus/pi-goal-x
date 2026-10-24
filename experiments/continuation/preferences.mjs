/** Candidate preference data checks, separately labeled from the terminal UI. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {output,roots} from './prepare.mjs';
const settings=await import(pathToFileURL(path.join(roots.candidate,'extensions/goal-settings.ts')));
const cwd=path.join(output,'preferences');fs.rmSync(cwd,{recursive:true,force:true});fs.mkdirSync(cwd,{recursive:true});
const env={...process.env,PI_GOAL_GLOBAL_SETTINGS_FILE:path.join(cwd,'global.json')};
const observations=[];
function check(label,expected,source){const snapshot=settings.loadSettingsSnapshot(cwd,env);assert.equal(snapshot.value.idleContinuationBackoff,expected);assert.equal(snapshot.provenance.get('idleContinuationBackoff')?.source,source);observations.push({label,value:expected,source});}
check('absent',false,'default');
settings.mutateSettingsLayer({scope:'global',cwd,env,mutation:{op:'set',path:['idleContinuationBackoff'],value:true}});check('global opt-in',true,'global');
settings.mutateSettingsLayer({scope:'project',cwd,env,mutation:{op:'set',path:['idleContinuationBackoff'],value:false}});check('project explicit false',false,'project');
settings.invalidateGoalSettingsCache();check('reopen cached settings',false,'project');
settings.mutateSettingsLayer({scope:'project',cwd,env,mutation:{op:'unset',path:['idleContinuationBackoff']}});check('remove project override',true,'global');
settings.mutateSettingsLayer({scope:'global',cwd,env,mutation:{op:'unset',path:['idleContinuationBackoff']}});check('remove global override',false,'default');
for(const value of ['not-a-boolean',1,null])assert.throws(()=>settings.mutateSettingsLayer({scope:'project',cwd,env,mutation:{op:'set',path:['idleContinuationBackoff'],value}}));
settings.mutateSettingsLayer({scope:'project',cwd,env,mutation:{op:'set',path:['idleContinuationBackoff'],value:'true'}});check('existing string-boolean compatibility',true,'project');
fs.writeFileSync(path.join(output,'preference-results.json'),JSON.stringify({evidence:'SDK settings data checks; not a UI walkthrough',passed:true,observations,invalidValuesRejected:3},null,2)+'\n');
console.log(JSON.stringify({passed:true,observations:observations.length,invalidValuesRejected:3}));
