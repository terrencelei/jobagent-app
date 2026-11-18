import {tmpdir} from 'node:os';
import test from 'node:test';import assert from 'node:assert/strict';
import{requisitionOf,verifiedReceipt,fetchApplicationReceipt}from'../src/application-receipt.mjs';
const job={company:'NXP Semiconductors',title:'Entry Level NVM Reliability Lab Engineer',url:'https://nxp.wd3.myworkdayjobs.com/en-US/careers/job/Austin/Entry-Level-NVM-Reliability-Lab-Engineer_R-10066302'};
const now=Date.parse('2026-10-08T16:00:00Z');
const receipt={messageId:'1a11c2816dff196e',receivedAt:'2026-10-08T15:59:30Z',sender:'nxp@myworkday.com',subject:'Thank you for applying',body:'NXP Semiconductors has received your application for Entry Level NVM Reliability Lab Engineer (R-10066302).'};
test('requisition ids preserve the Workday R- number and strip only location suffixes',()=>{
 assert.equal(requisitionOf(job.url),'R-10066302');assert.equal(requisitionOf('https://hpe.wd5.myworkdayjobs.com/Jobs/job/City/Engineer_1214998'),'1214998');assert.equal(requisitionOf('https://msd.wd5.myworkdayjobs.com/jobs/job/City/Engineer_R415995-2'),'R415995');
});
test('receipts require an actual id, fresh date, sender, acknowledgement and matching posting',()=>{
 assert.equal(verifiedReceipt(receipt,job,{now,after:now/1000-60}).messageId,receipt.messageId);
 for(const change of [{messageId:'invented'},{receivedAt:'2025-01-01'},{sender:''},{subject:'Verify account',body:'Activate your account for NXP Semiconductors.'},{body:'Other Employer received your application for a Different Engineer.',subject:'Received'},{receivedAt:'2027-01-01'}])assert.equal(verifiedReceipt({...receipt,...change},job,{now,after:now/1000-60}),null);
 assert.equal(verifiedReceipt({...receipt,body:'NXP Semiconductors received your application for Other Engineer (R-10066303).'},job,{now}),null);
 assert.equal(verifiedReceipt({...receipt,body:'NXP Semiconductors received your application for Other Engineer (R-100663020).'},job,{now}),null);
 assert.equal(verifiedReceipt({...receipt,body:'NXP Semiconductors received your application for Mechanical Engineer II.'},{...job,title:'Mechanical Engineer I'},{now}),null);
});
test('selected Codex mailbox supplies verified receipt evidence with no submission or mail writes',async()=>{
 const fresh={...receipt,receivedAt:new Date().toISOString()};let invocation;
 const result=await fetchApplicationReceipt(job,{email:'fixture@example.com',after:new Date().toISOString(),tries:1,execImpl:async(command,args,prompt,options)=>{invocation={command,args,prompt,options};return{code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(fresh)}})};}});
 assert.equal(result.messageId,receipt.messageId);assert.ok(invocation.args.includes('--ephemeral'));assert.ok(!invocation.args.includes('--ignore-user-config'));assert.match(invocation.prompt,/Do not send/);assert.equal(invocation.options.cwd,tmpdir());assert.equal(invocation.options.timeout,90000);
});
test('absence or lookup failure leaves the application awaiting receipt',async()=>{
 assert.equal(await fetchApplicationReceipt(job,{tries:1,execImpl:async()=>({code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'NONE'}})})}),null);
 assert.equal(await fetchApplicationReceipt(job,{tries:1,execImpl:async()=>{throw Error('timeout')}}),null);
});
test('a security-code gate cannot count as an accepted application receipt',()=>{
 assert.equal(verifiedReceipt({...receipt,subject:'Verify your application',body:'Thank you for applying to NXP Semiconductors for Entry Level NVM Reliability Lab Engineer (R-10066302). Your security code is ABC12345. Complete your email verification to submit.'},job,{now}),null);
});

test('Cobot receipts match Collaborative Robotics only on its official Ashby board',()=>{
 const role={company:'Collaborative Robotics',title:'Robotics Assistant',url:'https://jobs.ashbyhq.com/cobot/76f37dcd-57f6-4ed1-a487-83a9bb7749ab/application'};
 const evidence={...receipt,sender:'Cobot Hiring Team <no-reply@ashbyhq.com>',subject:'Thank You For Applying - Cobot',body:'Thanks for applying to the Robotics Assistant role! Our team will review your application. Cobot Hiring Team'};
 assert.ok(verifiedReceipt(evidence,role,{now}));
 assert.equal(verifiedReceipt(evidence,{...role,url:'https://jobs.ashbyhq.com/another-employer/role/application'},{now}),null);
 assert.equal(verifiedReceipt(evidence,{...role,title:'Robotics Data Collection Operator - Seattle'},{now}),null);
});

test('Claude receipt lookup discovers mailbox tools from a neutral directory',async()=>{
 let invocation;const fresh={...receipt,receivedAt:new Date().toISOString()};
 const result=await fetchApplicationReceipt(job,{engine:'claude',email:'fixture@example.com',tries:1,execImpl:async(command,args,prompt,options)=>{invocation={prompt,options};return{code:0,stdout:JSON.stringify([{type:'result',result:JSON.stringify(fresh)}])};}});
 assert.equal(result.messageId,receipt.messageId);assert.match(invocation.prompt,/Use ToolSearch/);assert.equal(invocation.options.cwd,tmpdir());
});

test('FieldAI receipt alias requires its official Lever board and exact role',()=>{
 const role={company:'Field AI',title:'Mechanical Engineer, Robotics Hardware',url:'https://jobs.lever.co/field-ai/c6d6d504-d01a-4ba5-9b33-f3e857f630d4/apply'};
 const evidence={...receipt,sender:'FieldAI <no-reply@hire.lever.co>',subject:'Thank you for your application to FieldAI',body:'FieldAI received your application for Mechanical Engineer, Robotics Hardware.'};
 assert.ok(verifiedReceipt(evidence,role,{now}));
 for(const change of [{url:role.url.replace('/field-ai/','/another-employer/')},{url:role.url.replace('jobs.lever.co','example.com')},{title:'Electrical Engineer'},{company:'Another Employer'}])assert.equal(verifiedReceipt(evidence,{...role,...change},{now}),null);
});
test('receipt lookup checks delayed acknowledgement again without repeating submission',async()=>{
 let calls=0;const fresh={...receipt,receivedAt:new Date().toISOString()};
 const result=await fetchApplicationReceipt(job,{tries:2,waitMs:0,execImpl:async()=>({code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:++calls===1?'NONE':JSON.stringify(fresh)}})})});
 assert.equal(calls,2);assert.equal(result.messageId,receipt.messageId);
});
test('a same-title receipt naming another posting id does not verify a reposted requisition',()=>{
 const amazon={company:'Amazon',title:'Robotics Systems Engineer I, Tech Deployment',url:'https://account.amazon.jobs/en-US/applicant/jobs/10574564/apply'};
 const mail={messageId:'1a0ef291053dab01',receivedAt:'2026-09-29T21:54:00Z',sender:'noreply@mail.amazon.jobs',subject:'Thank you for Applying to Amazon!'};
 const at=Date.parse('2026-10-18T11:00:00Z');
 assert.equal(verifiedReceipt({...mail,body:"Thanks for applying to Amazon! We've received your application for the Robotics Systems Engineer I, Tech Deployment (ID: 10418150) position."},amazon,{now:at}),null);
 assert.equal(verifiedReceipt({...mail,body:"Thanks for applying to Amazon! We've received your application for the Robotics Systems Engineer I, Tech Deployment (ID: 10574564) position."},amazon,{now:at}).requisition,'10574564');
 assert.equal(verifiedReceipt({...mail,body:"Thanks for applying to Amazon! We've received your application for the Robotics Systems Engineer I, Tech Deployment position."},amazon,{now:at}).messageId,mail.messageId);
});
