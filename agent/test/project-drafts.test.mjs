import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {learnApprovals} from '../src/companies.mjs';
import {draftProjects,isShortAnswer,projectDraft,resumeDraft} from '../src/answer-learning.mjs';

const project={key:'capstone',sponsor:'Example Pharma',includeInProseDrafts:true,drafts:{
 intro:'For my capstone, my team is building a robotic dispensing cell.',
 short:'I am also building a robotic dispensing cell for my Example Pharma capstone.',
 contribution:'I set up the ROS 2 environment.',challenge:'Powders flow differently.',approach:'We close the loop on a balance.'}};
const projects=draftProjects({projects:[project,{key:'off',drafts:project.drafts}]});

test('only opted-in projects with intro and short wording are used',()=>{
 assert.deepEqual(projects.map(p=>p.key),['capstone']);
 assert.deepEqual(draftProjects({}),[]);
});

test('short-answer detection skips factual and option questions',()=>{
 assert.ok(isShortAnswer({label:'Tell us about something you built.',type:'textarea'}));
 assert.ok(isShortAnswer({label:'Why do you want to work here?',type:'text',maxWords:150}));
 assert.ok(!isShortAnswer({label:'What city are you located in?',type:'textarea'}));
 assert.ok(!isShortAnswer({label:'Describe your project.',type:'textarea',options:['A','B']}));
 assert.ok(isShortAnswer({label:'Describe your project.',type:'text'}));
 assert.ok(isShortAnswer({label:'Why Apex?',type:'text',required:false}));
 assert.ok(isShortAnswer({label:'Why you?',type:'text',required:false}));
});

test('new prose questions get a topic-shaped capstone draft within word limits',()=>{
 const challenge=projectDraft('Describe a difficult technical challenge.',null,projects);
 assert.equal(challenge.draft,'For my capstone, my team is building a robotic dispensing cell. Powders flow differently. We close the loop on a balance. I set up the ROS 2 environment.');
 const motivation=projectDraft('Why Apex?',null,projects,{company:'Apex',title:'Mechanical Engineering Intern',description:'ROS 2 simulation and testing'});
 assert.match(motivation.draft,/Mechanical Engineering Intern role at Apex/);
 assert.match(motivation.draft,/posting.s focus on ROS 2/);
 assert.doesNotMatch(motivation.draft,/satellite|spacecraft|launched|successfully|improved/);
 assert.equal(projectDraft('Why us?',null,projects),null);
 assert.equal(projectDraft('Why us?',null,projects,{company:'Apex',maxWords:12}),null);
 assert.equal(projectDraft('Why us?',null,projects,{maxWords:5}),null);
 assert.equal(projectDraft('Why us?',null,[]),null);
});

test('approved-example drafts preserve the applicant edit verbatim',()=>{
 const base={draft:'I designed an actuator at my internship.',note:'Draft based on your approved answer.'};
 assert.equal(projectDraft('q',base,projects),base);
 assert.equal(projectDraft('q',base,projects,{maxWords:10}),base);
 const already={...base,draft:'My capstone is a powder dispensing robot.'};
 assert.equal(projectDraft('q',already,projects),already);
});


test('optional fit, achievements and general challenges use confirmed project drafts',()=>{
 for(const label of ['Why you?', 'What achievements are you proud of?', 'Describe a challenge you have had.']){
  const draft=projectDraft(label,null,projects);
  assert.match(draft.draft,/my capstone/);
  assert.match(draft.note,/before approving/);
  assert.ok(draft.draft.split(/\s+/).length<=40);
 }
 assert.equal(projectDraft('Why Apex?',null,[],{company:'Apex'}),null);
});


test('answer-memory bridge returns optional short prose only as review drafts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'optional-prose-memory-'));
 try{
  const profilePath=join(dir,'profile.json'),bankDir=join(dir,'banks');
  await writeFile(profilePath,JSON.stringify({projects:[project]}));
  const approved='I want to build on my robotics work through the engineering internship at Apex.';
  await learnApprovals(bankDir,'Apex',[{question:'Why Apex?',answer:approved,type:'text'}],'1');
  const output=JSON.parse(execFileSync(process.execPath,['tools/answer-memory.mjs'],{input:JSON.stringify({action:'suggest',profilePath,bankDir,runDirectory:dir,items:[{id:'example',job_id:1,company:'Apex',title:'Mechanical Intern',questions:[{label:'Why Apex?',type:'text',required:false},{label:'What challenges have you had?',type:'text',required:false}]}]}),encoding:'utf8'}));
  assert.deepEqual(output[0].facts,{});
  assert.equal(output[0].drafts['Why Apex?'].draft,approved);
  assert.match(output[0].drafts['What challenges have you had?'].draft,/Powders flow differently/);
  assert.match(output[0].drafts['Why Apex?'].note,/Review and edit/);
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('résumé fallback drafts motivation without inventing a completed degree or achievements',()=>{
 const profile={education:[{school:'Example University',field:'Mechanical Engineering',degree:"Bachelor's Degree",to:['6','2027']}],workHistory:[{title:'Engineering Intern',company:'Previous Employer',description:'Designed a fixture for assembly failure analysis.'}]};
 const motivation=resumeDraft('Why Apex?',profile,{company:'Apex',title:'Mechanical Intern'});
 assert.match(motivation.draft,/Mechanical Intern role at Apex/);
 assert.match(motivation.draft,/studies in Mechanical Engineering/);
 assert.doesNotMatch(motivation.draft,/completed|earned|graduated|hold a|degree/);
 assert.match(resumeDraft('What achievements have you had?',profile).draft,/Designed a fixture for assembly failure analysis/);
 assert.match(resumeDraft('Describe a challenge you had.',profile).draft,/assembly failure analysis/);
 assert.equal(resumeDraft('What achievements have you had?',{education:profile.education}),null);
 assert.equal(resumeDraft('Describe a challenge you had.',{education:profile.education}),null);
 assert.equal(resumeDraft('Why Apex?',{},{company:'Apex'}),null);
 assert.equal(resumeDraft('Why Apex?',profile,{company:'Apex',maxWords:5}),null);
});

test('answer-memory uses confirmed résumé education if no prose project is registered',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'resume-prose-memory-'));
 try{
  const profilePath=join(dir,'profile.json');
  await writeFile(profilePath,JSON.stringify({education:[{school:'Example University',field:'Mechanical Engineering',degree:"Bachelor's Degree",to:['6','2027']}]}));
  const output=JSON.parse(execFileSync(process.execPath,['tools/answer-memory.mjs'],{input:JSON.stringify({action:'suggest',profilePath,bankDir:join(dir,'banks'),runDirectory:dir,items:[{id:'example',job_id:1,company:'Apex',title:'Mechanical Intern',questions:[{label:'Why Apex?',type:'text',required:false}]}]}),encoding:'utf8'}));
  assert.deepEqual(output[0].facts,{});
  assert.match(output[0].drafts['Why Apex?'].draft,/studies in Mechanical Engineering/);
  assert.equal(output[0].drafts['Why Apex?'].draftSource.resume,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('factual school and internship-date textareas never receive project prose, even with word limits',()=>{
 for(const label of ['Please list the school or university you will be enrolled in during the internship or co-op?','Please list specific dates of internship availability- Include start date and end date.','What is your expected graduation date?','Please list your school or university.','Please provide your available start date.']){
  assert.equal(isShortAnswer({label,type:'textarea',required:true,maxWords:150}),false,label);
  assert.equal(projectDraft(label,null,projects,{company:'CFS'}),null,label);
 }
});

test('answer-memory isolates CFS motivation drafts from unknown internship enrollment and dates',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'factual-school-draft-'));
 try{
  const profilePath=join(dir,'profile.json'),why='Please tell us what interested you to apply to CFS',school='Please list the school or university you will be enrolled in during the internship or co-op?',dates='Please list specific dates of internship availability- Include start date and end date.';
  await writeFile(profilePath,JSON.stringify({answers:{},education:[{school:'Example University',field:'Mechanical Engineering',to:['6','2027']}],projects:[project]}));
  const output=JSON.parse(execFileSync(process.execPath,['tools/answer-memory.mjs'],{input:JSON.stringify({action:'suggest',profilePath,bankDir:join(dir,'banks'),runDirectory:dir,items:[{id:'example',job_id:1,company:'CFS',title:'Mechanical Engineering Intern',questions:[why,school,dates].map(label=>({label,type:'textarea',required:true,maxWords:150}))}]}),encoding:'utf8'}))[0];
  assert.deepEqual(output.facts,{});
  assert.deepEqual(Object.keys(output.drafts),[why]);
  assert.match(output.drafts[why].draft,/Mechanical Engineering Intern role at CFS/);
  assert.match(output.drafts[why].note,/before approving/);
  assert.equal(output.drafts[school],undefined);assert.equal(output.drafts[dates],undefined);
 }finally{await rm(dir,{recursive:true,force:true});}
});
