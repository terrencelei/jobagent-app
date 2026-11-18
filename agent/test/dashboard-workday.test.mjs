import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {runWorkday,outcome} from '../src/dashboard-workday.mjs';
import {webpageAcceptance} from '../src/application-acceptance.mjs';
test('Workday child receives posting jurisdiction and standing submission authorization',async()=>{
 const root=await mkdtemp(join(tmpdir(),'workday-context-')),run=join(root,'run');await mkdir(run);await mkdir(join(root,'state'));let sent,argsSeen;
 await writeFile(join(root,'profile.json'),JSON.stringify({resumePath:'old.pdf',answers:{}}));await writeFile(join(root,'old.pdf'),'old resume');await writeFile(join(root,'selected.pdf'),'selected resume');
 await writeFile(join(run,'request.json'),JSON.stringify({job:{id:12,company:'Fixture',title:'Engineer',url:'https://fixture.wd1.myworkdayjobs.com/jobs/12',location:'Rome, NY',salaryMin:70000},profilePath:join(root,'profile.json'),autoSubmit:true,resumePath:join(root,'selected.pdf')}));
 const spawnImpl=(_command,args)=>{argsSeen=args;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
  setTimeout(async()=>{sent=JSON.parse(await readFile(join(run,'jobs.json'),'utf8'))[0];await writeFile(join(root,'state/jobagent-12.json'),JSON.stringify({status:'at_review',updatedAt:new Date().toISOString()}));child.emit('close',0);},10);return child;
 };
 try{await runWorkday(run,{root,spawnImpl});assert.equal(sent.location,'Rome, NY');assert.equal(sent.salaryMin,70000);assert.ok(argsSeen.includes('--submit'));const profile=JSON.parse(await readFile(argsSeen[2]));assert.equal(profile.resumePath,join(root,'selected.pdf'));assert.equal(JSON.parse(await readFile(join(run,'state.json'))).resumePath,join(root,'selected.pdf'));}finally{await rm(root,{recursive:true,force:true});}
});

test('Workday completion requires positive webpage evidence or a mailbox acknowledgement',()=>{
 const job={id:'jobagent-12',company:'Fixture',url:'https://fixture.wd1.myworkdayjobs.com/jobs/12'};
 const webpageEvidence=webpageAcceptance({job,url:job.url,text:'We have received your application',submittedAt:'2026-10-15T12:00:00Z',now:'2026-10-15T12:00:10Z'});
 assert.equal(outcome({status:'submitted',canonicalUrl:job.url,webpageEvidence}).status,'completed');
 assert.equal(outcome({status:'submitted',canonicalUrl:job.url}).status,'submitted_pending_receipt');
 assert.equal(outcome({status:'submitted',canonicalUrl:job.url,webpageEvidence:{...webpageEvidence,quote:'Submit clicked'}}).status,'submitted_pending_receipt');
});

test('Workday optional writing approval blocks submission and preserves its employer-optional context',()=>{
 const question={question:'Why do you want to work here?',kind:'textarea',required:true,employerRequired:false,
  approvalReason:'Optional application-strengthening answer requested for review',maxWords:200};
 const result=outcome({status:'needs_approval'},{step:'Application Questions',questions:[question]});
 assert.equal(result.status,'needs_approval');
 assert.equal(result.questions[0].required,true);
 assert.equal(result.questions[0].employerRequired,false);
 assert.equal(result.questions[0].approvalReason,question.approvalReason);
 assert.equal(result.questions[0].maxWords,200);
 assert.equal(result.questions[0].type,'textarea');
 assert.equal(result.questions[0].draft,undefined);
});
