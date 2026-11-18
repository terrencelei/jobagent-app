import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,delimiter} from 'node:path';
import {agentPath} from '../src/agent-capabilities.mjs';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {approvedValue,reviewDigest,validatePublicURL,runWorker,atomic,decide,execCLI,isApplicationEntry,isFinalControl,availableFacts,safeNavigation,uploadDocument,safeRoleLink,setCheckedControl,resumeAttached,snapshot,pickOption} from '../src/dashboard-worker.mjs';

test('headless-only requests override headed options and wait for asynchronous entry controls',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'headless-ready-')),run=join(dir,'run');await mkdir(run);
 const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<p id="loading">Loading</p><script>setTimeout(()=>{document.body.innerHTML='<p>'+navigator.userAgent+'</p><button id="ready">Apply Now</button>';},300);</script>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers:{}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:981,company:'Fixture',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,headlessOnly:true,readySelector:'#ready',settleMs:10});
 // Record what the worker saw and how it launched the browser; assertions inside execImpl would be swallowed by
 // runWorker's error handling. The page now reports a plain Chrome user agent, so headless is checked at launch.
 const seen=[],launches=[],launch=chromium.launch;
 chromium.launch=async(options={})=>{launches.push(options);return launch.call(chromium,options);};
 const execImpl=async(_command,_args,prompt)=>{const page=JSON.parse(prompt).page;seen.push({text:page.frames[0].text,controls:page.frames[0].controls.map(c=>c.label)});
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:'human',control:'',fact:'',message:'Fixture inspection finished'},usage:{}})};
 };
 try{
  await runWorker(run,{headless:false,execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  assert.equal(launches.length,1);assert.equal(launches[0].headless,true,'headlessOnly overrides headless:false');
  assert.equal(seen.length,1);assert.doesNotMatch(seen[0].text,/^Loading$/);assert.ok(seen[0].controls.includes('Apply Now'),'waited for the asynchronous entry control');
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));assert.notEqual(state.status,'failed',state.message);
 }finally{chromium.launch=launch;await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

for(const required of [true,false])test(`email-only account terms require an explicit required checkbox: required=${required}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'email-only-terms-')),run=join(dir,'run');await mkdir(run);
 const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<form><label>Email<input type="email" value="fixture@example.com"></label><label for="terms">I agree with the terms and conditions<input id="terms" type="checkbox" ${required?'required':''} style="visibility:hidden"><span class="apply-flow-input-checkbox__button" style="display:inline-block;width:20px;height:20px" onclick="event.preventDefault();document.getElementById('terms').checked=true">□</span></label><label>Marketing updates<input id="marketing" type="checkbox"></label></form>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers:{email:'fixture@example.com'}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:982,company:'Fixture',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true});
 let reads=0;
 const execImpl=async(_command,_args,prompt)=>{const controls=JSON.parse(prompt).page.frames[0].controls;const terms=controls.find(c=>c.label.startsWith('I agree'));
  const action=reads++===0?{action:'fill',control:terms.id,fact:'acceptTerms',message:''}:{action:'human',control:'',fact:'',message:'Fixture finished'};
  if(reads>1){assert.notEqual(terms?.value,required?undefined:'true');if(required)assert.equal(terms.value,'true');assert.notEqual(controls.find(c=>c.label==='Marketing updates')?.value,'true');}
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:action,usage:{}})};
 };
 try{await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  // An optional box is never ticked as terms; since lesson 409 it takes the answer path instead of ending the run.
  assert.equal(state.status,'needs_human',state.message);assert.equal(reads,2);assert.doesNotMatch(state.message,/Only a required terms checkbox/);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

for(const autoSubmit of [false,true]) test(`known facts resolve equivalent options with auto-submit=${autoSubmit}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'settled-application-'));
 let submits=0;
 const questions=[
  ['Are you a U.S. citizen?',['US Citizen or National','Other']],
  ['Do you have the right to work in this country?',['Yes','No']],
  ['Will you require visa sponsorship?',['Yes','No']],
  ['Do you possess an active security clearance?',['None','Secret']],
 ];
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.url.startsWith('/submit'))submits++;
  res.end(`<form action="/submit">${questions.map(([q,opts],i)=>`<label for="q${i}">${q}</label><select required id="q${i}"><option value="">Select</option>${opts.map(o=>`<option>${o}</option>`).join('')}</select>`).join('')}<button type="submit">Submit application</button></form>`);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf'),run=join(dir,'run');await mkdir(run);
 await writeFile(profile,JSON.stringify({answers:{citizenshipCountries:['United States'],workAuthorizationCountries:['United States'],requiresSponsorship:false,currentSecurityClearance:'No',heldSecurityClearance:'No'}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:998,company:'Fixture',location:'United States',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,parkQuestions:true,autoSubmit,engine:'claude'});
 const execImpl=async(_c,_a,prompt)=>{const cs=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);const c=cs.find(c=>c.type==='select-one'&&!c.value)||cs.find(c=>c.type==='submit');
  return{code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:c.type==='submit'?'review':'ask',control:c.id,fact:'',message:''},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,stateRoot:join(dir,'state'),allowLocalFixture:true});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,autoSubmit?'submission_unknown':'ready_to_submit',state.message);  // the fixture answers Submit with a blank form: no confirmation (lesson 435)assert.deepEqual(state.questions,[]);
  if(!autoSubmit)assert.deepEqual(state.review.answers.map(a=>a.value),['US Citizen or National','Yes','No','None']);assert.equal(submits,autoSubmit?1:0);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('Apply now is navigation on a posting and submission on an application form',()=>{
 assert.equal(safeNavigation('Apply now »'),true);assert.equal(safeNavigation('Apply now to subscribe'),false);
 const entry={label:'Apply now',type:'button',formFields:0};assert.equal(isApplicationEntry(entry),true);assert.equal(isFinalControl(entry),false);
 const form={...entry,formFields:3};assert.equal(isApplicationEntry(form),false);assert.equal(isFinalControl(form),true);
});
test('employer facts are scoped while contacts and structured history remain reusable',()=>{
 const profile={answers:{firstName:'Fixture',spacexHistory:'No',employedByAnduril:'No',saOfficeDallas:'Yes',hearAbout:'Company website',unknownEmployerOption:'Yes'},workHistory:[{company:'Example Works',title:'Engineer',from:{year:2024}}],education:[{school:'Example University',degree:'Bachelors'}]};
 const facts=availableFacts(profile,'Unrelated Employer');assert.equal(facts.firstName,'Fixture');assert.equal(facts['workHistory.0.company'],'Example Works');assert.equal(facts['workHistory.0.from.year'],2024);assert.equal(facts['education.0.degree'],'Bachelors');
 for(const key of ['spacexHistory','employedByAnduril','saOfficeDallas','hearAbout','unknownEmployerOption'])assert.equal(facts[key],undefined);
 assert.equal(availableFacts(profile,'SpaceX').spacexHistory,'No');assert.equal(availableFacts(profile,'Anduril Industries').employedByAnduril,'No');
 const control={id:'x',label:'Prior employment',type:'text'};
 assert.throws(()=>approvedValue({fact:'spacexHistory'},control,profile,{},new Map(),'Another Employer'),/confirmed answer/);
 assert.equal(approvedValue({fact:'workHistory.0.company'},control,profile,{},new Map(),'Another Employer'),'Example Works');
});
test('unknown prose cannot be invented or borrowed from profile',()=>{
 const control={id:'x',label:'Why our company?',type:'textarea'};
 assert.throws(()=>approvedValue({fact:'fullName'},control,{answers:{fullName:'Example Applicant'}},{},new Map()),/inline/);
 assert.equal(approvedValue({},control,{}, {'why our company?':{answer:'Approved wording'}},new Map()),'Approved wording');
});
test('private navigation and credential URLs rejected',async()=>{
 for(const url of ['http://example.org','https://127.0.0.1','https://user:secret@example.org','https://[::1]'])await assert.rejects(validatePublicURL(url));
 await validatePublicURL('http://127.0.0.1:8080',true);
});
test('review digest changes when DOM answers or resume change',()=>{
 const snap={url:'https://example.org',frames:[{controls:[{type:'text',label:'Name',value:'A'}]}]};
 const old=reviewDigest(snap,'resume',[]);snap.frames[0].controls[0].value='B';assert.notEqual(reviewDigest(snap,'resume',[]),old);
 assert.notEqual(reviewDigest(snap,'resume2',[]),reviewDigest(snap,'resume',[]));
});
test('API engines are rejected without a network request',async()=>{
 await assert.rejects(decide({engine:'openai',snap:{},profile:{},bank:{},job:{},history:[],execImpl:async()=>{throw new Error('must not run');}}),/Direct API calls are disabled/);
});
test('local browser asks inline, ignores stale approval, submits exactly once and records receipt pending',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dashboard-worker-'));let submits=0;
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.url.startsWith('/submit')){submits++;res.end('Application received');}else if(req.url==='/'){res.end(`<button type="button" onclick="location.href='/form'">Apply now</button>`);}else{res.end('<form action="/submit"><label>Name<input name="name"></label><label>Why this role?<textarea name="why" required></textarea></label><button type="submit">Submit application</button></form>');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf'),run=join(dir,'run');await mkdir(run);await writeFile(profile,JSON.stringify({answers:{fullName:'Fixture Applicant'}}));await writeFile(resume,'fixture resume');
 await atomic(join(run,'request.json'),{engine:'claude',job:{id:987654,company:'Fixture Employer',title:'Mechanical Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume});
 const execImpl=async(_command,_args,prompt)=>{const input=JSON.parse(prompt);const controls=input.page.frames.flatMap(f=>f.controls);const target=controls.find(c=>c.type==='text'&&!c.value)||controls.find(c=>c.type==='textarea'&&!c.value)||controls.find(c=>c.type==='submit')||controls.find(c=>c.label==='Apply now');return{code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:target.type==='text'?'fill':target.type==='textarea'?'ask':'review',control:target.id,fact:'fullName',message:''},usage:{input_tokens:1,output_tokens:1}})};};
 const running=runWorker(run,{execImpl,stateRoot:join(dir,'state'),allowLocalFixture:true});
 const waitStatus=async status=>{for(let i=0;i<150;i++){try{const s=JSON.parse(await readFile(join(run,'state.json'),'utf8'));if(s.status===status)return s;if(s.status==='failed')throw new Error(s.message);}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out '+status);};
 try{
 const question=await waitStatus('waiting_answers');assert.equal(submits,0);await atomic(join(run,'commands.json'),{id:'answer1',action:'answer',answers:{[question.questions[0].id]:'My approved fixture answer'}});
 const review=await waitStatus('waiting_review');assert.equal(submits,0);assert.equal(review.review.answers.length,2);assert.ok((await stat(join(run,'screenshot.jpg'))).size>100);
 await atomic(join(run,'commands.json'),{id:'bad-approval',action:'approve',review_id:'stale'});await new Promise(r=>setTimeout(r,600));assert.equal(submits,0);
 await atomic(join(run,'commands.json'),{id:'good-approval',action:'approve',review_id:review.review.id});await running;
 const done=await waitStatus('completed');assert.equal(done.submitted,true);assert.equal(submits,1);  // the page turned into "Application received" (lesson 435)
 const persistent=JSON.parse(await readFile(join(dir,'state/jobagent-987654.json'),'utf8'));assert.equal(persistent.status,'submitted');
 await runWorker(run,{execImpl,stateRoot:join(dir,'state'),allowLocalFixture:true});await waitStatus('failed');assert.equal(submits,1);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('a page step runs lean: no tools, MCP servers or settings files, instructions as the system prompt',async()=>{
 let call;const execImpl=async(command,args,input,options)=>{call={command,args,input,options};return{code:0,stderr:'',stdout:JSON.stringify({is_error:false,structured_output:{action:'fill',control:'f0c1',fact:'fullName',message:''},usage:{input_tokens:5,output_tokens:3}})};};
 const {action,usage}=await decide({engine:'claude',command:'/bin/claude',model:'sonnet',snap:{frames:[]},profile:{},bank:{},job:{company:'X',title:'Y'},history:[{action:'rejected',control:'once'}],execImpl});
 assert.equal(action.control,'f0c1');assert.equal(usage.via,'claude:sonnet:lean');
 assert.equal(call.args[call.args.indexOf('--tools')+1],'');assert.ok(call.args.includes('--strict-mcp-config'));assert.equal(call.args[call.args.indexOf('--setting-sources')+1],'');
 assert.ok(call.args.includes('--system-prompt')&&!call.args.includes('--append-system-prompt')&&!call.args.includes('bypassPermissions'));
 assert.doesNotMatch(call.args.join(' '),/agent-coordination/);assert.notEqual(resolve(call.options.cwd),resolve(dirname(new URL(import.meta.url).pathname),'..'));
});
test('a stuck run gets the full agent back (two refusals, or one action three times)',async()=>{
 let call;const execImpl=async(command,args,input)=>{call={command,args,input};return{code:0,stderr:'',stdout:JSON.stringify({is_error:false,structured_output:{action:'fill',control:'f0c1',fact:'fullName',message:''},usage:{input_tokens:5,cache_read_input_tokens:7,output_tokens:3}})};};
 const stuck=[{action:'rejected',control:'a'},{action:'click',control:'Next'},{action:'rejected',control:'b'}];
 const {usage}=await decide({engine:'claude',command:'/bin/claude',model:'sonnet',snap:{frames:[]},profile:{},bank:{},job:{company:'X',title:'Y'},history:stuck,execImpl});
 assert.deepEqual(usage,{input_tokens:5,cache_read_input_tokens:7,cache_creation_input_tokens:0,output_tokens:3,via:'claude:sonnet'});
 assert.equal(call.command,'/bin/claude');assert.equal(call.args[call.args.indexOf('--tools')+1],'default');assert.equal(call.args[call.args.indexOf('--permission-mode')+1],'bypassPermissions');assert.ok(!call.args.includes('--strict-mcp-config'));assert.ok(!call.args.includes('--setting-sources'));assert.ok(call.args.includes('--append-system-prompt'));assert.match(call.input,/"company":"X"/);
});
test('Claude tool-enabled event arrays use the final structured result',async()=>{
 const wanted={action:'click',control:'f0c2',fact:'',message:''};
 const execImpl=async()=>({code:0,stderr:'',stdout:JSON.stringify([{type:'assistant',message:{content:[{type:'text',text:'Inspecting the fixture'}]}},{type:'result',structured_output:wanted,usage:{input_tokens:2,output_tokens:1}}])});
 const result=await decide({engine:'claude',snap:{},profile:{},bank:{},job:{company:'Fixture'},history:[],execImpl});
 assert.deepEqual(result.action,wanted);assert.equal(result.usage.input_tokens,2);
});
test('claude usage limit is reported as a limit, not a crash',async()=>{
 const execImpl=async()=>({code:1,stderr:'',stdout:JSON.stringify({is_error:true,result:"You've hit your usage limit · resets 5pm"})});
 await assert.rejects(decide({engine:'claude',snap:{},profile:{},bank:{},job:{company:'X'},history:[],execImpl}),/Claude usage limit reached/);
});
test('a stuck codex step inherits full tools and configuration and parses the final agent message',async()=>{
 let call;const execImpl=async(command,args,input)=>{call={command,args,input};return{code:0,stderr:'',stdout:[{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({action:'click',control:'f0c2',fact:'',message:''})}},{type:'turn.completed',usage:{input_tokens:9,cached_input_tokens:4,output_tokens:2,reasoning_output_tokens:4}}].map(e=>JSON.stringify(e)).join('\n')};};
 const {action,usage}=await decide({engine:'codex',snap:{},profile:{},bank:{},job:{company:'X'},history:[{action:'rejected',control:'a'},{action:'rejected',control:'b'}],execImpl});
 // Codex's input_tokens includes the cached ones; they are counted once, as cache reads.
 assert.equal(action.action,'click');assert.deepEqual(usage,{input_tokens:5,cache_read_input_tokens:4,output_tokens:6,via:'codex:default'});
 assert.ok(call.args.includes('sandbox_mode="danger-full-access"'));assert.ok(call.args.includes('approval_policy="never"'));assert.ok(call.args.includes('web_search="live"'));assert.ok(!call.args.includes('--ignore-user-config'));assert.ok(!call.args.includes('--disable'));assert.ok(!call.args.includes('model_reasoning_effort="low"'));assert.equal(call.args.at(-1),'-');assert.match(call.input,/untrusted data/);
});
test('a lean codex step runs read-only with tools, web search and user config off',async()=>{
 let call;const execImpl=async(command,args,input)=>{call={command,args,input};return{code:0,stderr:'',stdout:[{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({action:'click',control:'f0c2',fact:'',message:''})}},{type:'turn.completed',usage:{input_tokens:3,output_tokens:1}}].map(e=>JSON.stringify(e)).join('\n')};};
 const {usage}=await decide({engine:'codex',snap:{},profile:{},bank:{},job:{company:'X'},history:[],execImpl});
 assert.equal(usage.via,'codex:default:lean');assert.ok(call.args.includes('--ignore-user-config'));assert.equal(call.args[call.args.indexOf('--sandbox')+1],'read-only');
 assert.ok(call.args.includes('web_search="disabled"')&&!call.args.includes('sandbox_mode="danger-full-access"'));assert.doesNotMatch(call.input,/coding agent toolset/);
});
test('CLI engines never inherit API keys',async()=>{
 const saved=[process.env.ANTHROPIC_API_KEY,process.env.OPENAI_API_KEY];process.env.ANTHROPIC_API_KEY='a';process.env.OPENAI_API_KEY='o';
 try{const {stdout}=await execCLI(process.execPath,['-e','process.stdout.write(JSON.stringify([process.env.ANTHROPIC_API_KEY??null,process.env.OPENAI_API_KEY??null]))'],'');assert.equal(stdout,'[null,null]');}
 finally{for(const [k,v] of [['ANTHROPIC_API_KEY',saved[0]],['OPENAI_API_KEY',saved[1]]])if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test('Codex API override and Anthropic auth token cannot leak into CLI execution',async()=>{
 const names=['CODEX_API_KEY','ANTHROPIC_AUTH_TOKEN'];const prior=names.map(k=>process.env[k]);
 try{for(const k of names)process.env[k]='fixture-secret';const {stdout}=await execCLI(process.execPath,['-e','console.log(Boolean(process.env.CODEX_API_KEY||process.env.ANTHROPIC_AUTH_TOKEN))'],'');assert.equal(stdout.trim(),'false');}
 finally{names.forEach((k,i)=>{if(prior[i]===undefined)delete process.env[k];else process.env[k]=prior[i];});}
});
test('parked questions and final review end the run; only the exact approved form is submitted, once',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dashboard-park-'));let submits=0;
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.url.startsWith('/submit')){submits++;res.end('ok');}else res.end('<form action="/submit"><label>Name<input name="name"></label><label>Why this role?<textarea name="why" required></textarea></label><button type="submit">Submit application</button></form>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf'),run=join(dir,'run');await mkdir(run);await writeFile(profile,JSON.stringify({answers:{fullName:'Fixture Applicant'}}));await writeFile(resume,'fixture resume');
 const request={job:{id:555,company:'Park Employer',title:'Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,parkQuestions:true,engine:'claude',command:'claude'};
 const execImpl=async(_command,_args,prompt)=>{const input=JSON.parse(prompt);const controls=input.page.frames.flatMap(f=>f.controls);const target=controls.find(c=>c.type==='text'&&!c.value)||controls.find(c=>c.type==='textarea'&&!c.value)||controls.find(c=>c.type==='submit');return{code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:target.type==='text'?'fill':target.type==='textarea'?'ask':'review',control:target.id,fact:'fullName',message:''},usage:{}})};};
 try{
  await atomic(join(run,'request.json'),request);
  await runWorker(run,{execImpl,stateRoot:join(dir,'state'),allowLocalFixture:true});
  const parked=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(parked.status,'needs_approval');assert.deepEqual(parked.questions.map(q=>q.label),['Why this role?']);assert.equal(submits,0);
  await atomic(join(run,'request.json'),{...request,approvedAnswers:[{question:'Why this role?',answer:'Approved answer'}]});
  await runWorker(run,{execImpl,stateRoot:join(dir,'state'),allowLocalFixture:true});
  const ready=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(ready.status,'ready_to_submit');assert.ok(ready.review.answers.some(a=>a.value=='Approved answer'));assert.equal(submits,0);
  // A stale approval never submits; the exact approved form submits once.
  await atomic(join(run,'request.json'),{...request,approvedAnswers:[{question:'Why this role?',answer:'Approved answer'}],approvedDigest:'stale'});
  await runWorker(run,{execImpl,stateRoot:join(dir,'state'),allowLocalFixture:true});
  assert.equal(JSON.parse(await readFile(join(run,'state.json'),'utf8')).status,'ready_to_submit');assert.equal(submits,0);
  await atomic(join(run,'request.json'),{...request,approvedAnswers:[{question:'Why this role?',answer:'Approved answer'}],approvedDigest:ready.review.digest});
  await runWorker(run,{execImpl,stateRoot:join(dir,'state'),allowLocalFixture:true});
  assert.equal(JSON.parse(await readFile(join(run,'state.json'),'utf8')).status,'submission_unknown');assert.equal(submits,1);  // a bare "ok" page is no confirmation (lesson 435)
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('workday env password parses quoted values and ignores comments',async()=>{
 const {parseEnv}=await import('../src/workday-env.mjs');
 assert.deepEqual(parseEnv('# note\nWORKDAY_PASSWORD="a b#c"\nexport OTHER=x\n'),{WORKDAY_PASSWORD:'a b#c',OTHER:'x'});
});
test('workday wrapper maps workday-run stops onto dashboard statuses',async()=>{
 const {outcome}=await import('../src/dashboard-workday.mjs');
 const parked=outcome({status:'needs_approval'},{step:'Application Questions',questions:[{question:'Why us?',kind:'textarea',required:true,draft:'Because'},{question:'Relocate?',kind:'listbox',options:['Yes','No']},{question:'I agree',kind:'checkbox'}]});
 assert.equal(parked.status,'needs_approval');assert.deepEqual(parked.questions.map(q=>q.type),['textarea','select','select']);assert.equal(parked.questions[0].draft,'Because');assert.deepEqual(parked.questions[2].options,['Yes','No']);
 assert.equal(outcome({status:'at_review'}).status,'ready_to_submit');
 assert.equal(outcome({status:'submitted'}).status,'submitted_pending_receipt');
 assert.match(outcome({status:'needs_account',reason:'bad password'}).message,/bad password/);
});
test('signs in with his email and saved password without the model ever seeing the password',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dashboard-auth-'));let login=null,submits=0;
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');
  if(req.url.startsWith('/login')){const q=new URL(req.url,'http://x').searchParams;login={email:q.get('email'),password:q.get('password'),terms:q.get('terms')};res.writeHead(302,{Location:'/form','Set-Cookie':'s=1'});return res.end();}
  if(req.url.startsWith('/submit')){submits++;return res.end('ok');}
  if(req.url.startsWith('/form'))return res.end('<form action="/submit"><label>Name<input name="name"></label><button type="submit">Submit application</button></form>');
  res.end('<form action="/login"><label>Email<input type="email" name="email"></label><label>Password<input type="password" name="password"></label><label><input type="checkbox" name="terms" value="yes" required>I agree to the Terms of Use</label><label><input type="checkbox" name="news" value="yes">Send me marketing updates</label><button type="submit">Sign in</button></form>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const root=join(dir,'agent');await mkdir(join(root,'private'),{recursive:true});await writeFile(join(root,'private/workday.env'),'WORKDAY_PASSWORD="fixture pass#1"\n');
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf'),run=join(dir,'run');await mkdir(run);await writeFile(profile,JSON.stringify({answers:{fullName:'Fixture Applicant',email:'fixture@example.test'}}));await writeFile(resume,'x');
 await atomic(join(run,'request.json'),{job:{id:777,company:'Auth Employer',title:'Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,parkQuestions:true,engine:'claude',command:'claude'});
 const prompts=[];let rejectedPasswordFact=false,passwordRequested=false;
 const execImpl=async(_c,_a,prompt)=>{prompts.push(prompt);const input=JSON.parse(prompt);const cs=input.page.frames.flatMap(f=>f.controls);
  if(cs.some(c=>c.type==='password')&&!rejectedPasswordFact){rejectedPasswordFact=true;return{code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:'fill',control:cs.find(c=>c.type==='password').id,fact:'email',message:''},usage:{}})};}
  const pick=cs.find(c=>c.type==='email'&&!c.value)?{c:cs.find(c=>c.type==='email'),action:'fill',fact:'email'}
   :cs.find(c=>c.type==='password')&&!passwordRequested?{c:cs.find(c=>c.type==='password'),action:'fill',fact:'accountPassword'}
   :cs.find(c=>/Terms/.test(c.label)&&c.value==='false')?{c:cs.find(c=>/Terms/.test(c.label)),action:'fill',fact:'acceptTerms'}
   :cs.find(c=>c.label==='Sign in')?{c:cs.find(c=>c.label==='Sign in'),action:'click',fact:''}
   :cs.find(c=>c.type==='text'&&!c.value)?{c:cs.find(c=>c.type==='text'),action:'fill',fact:'fullName'}
   :{c:cs.find(c=>c.type==='submit'),action:'review',fact:''};
  if(pick.fact==='accountPassword')passwordRequested=true;
  return{code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:pick.action,control:pick.c.id,fact:pick.fact,message:''},usage:{}})};};
 try{
  await runWorker(run,{execImpl,accountRoot:root,stateRoot:join(dir,'state'),allowLocalFixture:true});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.deepEqual(login,{email:'fixture@example.test',password:'fixture pass#1',terms:'yes'});
  assert.equal(state.status,'ready_to_submit');assert.equal(submits,0);
  assert.ok(prompts.every(p=>!p.includes('fixture pass#1')),'the password never reaches the model');
  assert.ok(!JSON.stringify(state).includes('fixture pass#1'),'the password never reaches the dashboard');
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('Rippling typeahead inputs select an approved location without exposing options as questions',async()=>{
 const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<label for="location">Location</label><input id="location" aria-autocomplete="list" aria-haspopup="listbox" aria-controls="choices"><ul id="choices" role="listbox"><li role="option" onclick="document.querySelector('input').value=this.textContent">Springfield, California, United States</li></ul>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true});const page=await browser.newPage();
 try{
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const controls=(await snapshot(page)).frames[0].controls;
  assert.equal(controls.find(c=>c.domId==='location').combobox,true);
  assert.equal(controls.some(c=>c.type==='option'),false);
  const picked=await pickOption(page.mainFrame(),page.locator('#location'),'Springfield, California, United States','Location');
  assert.equal(picked.ok,true);assert.equal(await page.locator('#location').inputValue(),'Springfield, California, United States');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
test('password is only typed on the posting site or a hiring platform',async()=>{
 const {passwordAllowedOn,termsCheckbox,authButton}=await import('../src/accounts.mjs');
 assert.ok(passwordAllowedOn('https://careers.acme.com/login','https://jobs.acme.com/x'));
 assert.ok(passwordAllowedOn('https://acme.wd1.myworkdayjobs.com/login','https://acme.com/careers'));
 assert.ok(!passwordAllowedOn('https://acme-login.example.net/','https://jobs.acme.com/x'));
 assert.ok(!passwordAllowedOn('http://jobs.acme.com/login','https://jobs.acme.com/x'));
 assert.ok(termsCheckbox('I agree to the Terms of Use')&&!termsCheckbox('I agree to receive marketing updates'));
 assert.ok(authButton('Sign in')&&!authButton('Submit')&&!authButton('Submit application'));
});
test('an unknown field is flagged instead of failing, and his answer is learned for other employers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dashboard-learn-'));let submits=0;
 const page=`<form action="/submit"><label>Name<input name="name"></label>
  <label id="country-label" for="country">Country*</label>
  <div class="x-control"><div class="x-single-value" id="shown"></div><input id="country" role="combobox" aria-controls="lb" aria-required="true" type="text"></div>
  <input required tabindex="-1" aria-hidden="true" value="">
  <div role="listbox" id="lb"></div>
  <label for="shirt">Shirt size</label><select id="shirt" name="shirt" required><option value="">Select</option><option>S</option><option>M</option></select>
  <button type="submit">Submit application</button></form>
  <script>const c=document.getElementById('country'),lb=document.getElementById('lb');
  c.addEventListener('input',()=>{lb.innerHTML='';for(const o of ['United States +1','United Kingdom +44'].filter(o=>o.toLowerCase().includes(c.value.toLowerCase()))){const d=document.createElement('div');d.setAttribute('role','option');d.textContent=o;d.onclick=()=>{document.getElementById('shown').textContent=o;c.value='';lb.innerHTML='';};lb.appendChild(d);}});
  c.addEventListener('focus',()=>c.dispatchEvent(new Event('input')));</script>`;
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.url.startsWith('/submit')){submits++;res.end('ok');}else res.end(page);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers:{fullName:'Fixture Applicant',country:'United States'}}));await writeFile(resume,'fixture resume');
 let prompts=[];
 const execImpl=async(_command,_args,prompt)=>{const input=JSON.parse(prompt);prompts.push(input);const controls=input.page.frames.flatMap(f=>f.controls);
  let out;if(prompts.length===1)out={action:'fill',control:'invented-id',fact:'fullName'};
  else{const t=controls.find(c=>c.label==='Name'&&!c.value)||controls.find(c=>c.combobox&&!c.value)||controls.find(c=>c.type==='select-one'&&!c.value)||controls.find(c=>c.type==='submit');
   out={action:t.label==='Name'?'fill':t.combobox?'fill':t.type==='select-one'?'ask':'review',control:t.id,fact:t.label==='Name'?'fullName':'country'};}
  return{code:0,stderr:'',stdout:JSON.stringify({structured_output:{...out,message:''},usage:{}})};};
 const run=async(name,job,extra={})=>{const r=join(dir,name);await mkdir(r,{recursive:true});await atomic(join(r,'request.json'),{job:{...job,title:'Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,parkQuestions:true,engine:'claude',...extra});await runWorker(r,{execImpl,stateRoot:join(dir,'state'),allowLocalFixture:true});return JSON.parse(await readFile(join(r,'state.json'),'utf8'));};
 try{
  const parked=await run('a',{id:1,company:'First Employer'});
  assert.equal(parked.status,'needs_approval',parked.message);
  assert.ok(parked.events.some(e=>/Retrying: control invented-id/.test(e.message)));
  assert.ok(!prompts.some(p=>p.page.frames.some(f=>f.controls.some(c=>c.label==='Unlabelled field'))));
  assert.ok(!parked.questions.some(q=>q.label==='Country*'));assert.ok(parked.events.some(e=>e.message==='Answered: Country*'));
  assert.deepEqual(parked.questions.find(q=>q.label==='Shirt size').options,['Select','S','M']);
  const approved=await run('a',{id:1,company:'First Employer'},{approvedAnswers:[{question:'Shirt size',answer:'M'}]});
  assert.equal(approved.status,'ready_to_submit',approved.message);assert.ok(approved.review.answers.some(a=>a.label==='Country*'&&a.value==='United States +1'));
  const shared=JSON.parse(await readFile(join(dir,'companies/shared.json'),'utf8'));assert.equal(shared.answers.country,undefined);assert.equal(shared.answers['shirt size'].answer,'M');
  // A different employer asking the same questions goes straight to final review.
  const second=await run('b',{id:2,company:'Second Employer'});
  assert.equal(second.status,'ready_to_submit',second.message);assert.equal(second.questions.length,0);assert.equal(submits,0);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('a resume input that the page swaps for the file name still counts as uploaded',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dashboard-upload-'));
 // Like Greenhouse: choosing a file removes the input and shows the file's name in its place.
 const page=`<form action="/submit"><label>Name<input name="name"></label>
  <div id="slot"><label for="resume">Resume/CV</label><input id="resume" type="file"></div>
  <button type="submit">Submit application</button></form>
  <script>document.getElementById('resume').addEventListener('change',e=>{document.getElementById('slot').textContent=e.target.files[0].name;});</script>`;
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(page);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'Fixture_Resume.pdf'),run=join(dir,'run');await mkdir(run);await writeFile(profile,JSON.stringify({answers:{fullName:'Fixture Applicant'}}));await writeFile(resume,'fixture resume');
 await atomic(join(run,'request.json'),{job:{id:888,company:'Upload Employer',title:'Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,parkQuestions:true,engine:'claude',command:'claude'});
 const execImpl=async(_c,_a,prompt)=>{const input=JSON.parse(prompt);const cs=input.page.frames.flatMap(f=>f.controls);
  const t=cs.find(c=>c.type==='file')||cs.find(c=>c.label==='Name'&&!c.value)||cs.find(c=>c.type==='submit');
  return{code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:t.type==='file'?'upload':t.type==='submit'?'review':'fill',control:t.id,fact:'fullName',message:''},usage:{}})};};
 try{
  await runWorker(run,{execImpl,stateRoot:join(dir,'state'),allowLocalFixture:true});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,'ready_to_submit',state.message);assert.ok(state.events.some(e=>e.message==='Uploaded original resume'));
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('only answers that are not his own wording or employer-specific are shared across employers',async()=>{
 const {shareable}=await import('../src/dashboard-worker.mjs');
 assert.equal(shareable('Are you authorized to work in the US?','Yes','select-one','Anduril Industries'),true);
 assert.equal(shareable('Why Anduril?','Mission','text','Anduril Industries'),false);
 assert.equal(shareable('Have you worked here?','Yes, at Anduril','text','Anduril Industries'),false);
 assert.equal(shareable('Tell us about a project','Anything','textarea','Employer'),false);
 assert.equal(approvedValue({fact:'bank:work authorization'},{label:'Authorized to work?',type:'select-one'},{},{'work authorization':{answer:'Yes'}},new Map()),'Yes');
});

test('Claude session-limit wording is detected and reset time preserved',async()=>{
 const execImpl=async()=>({code:1,stderr:'',stdout:JSON.stringify({is_error:true,result:"You've hit your session limit · resets 10:10pm"})});
 await assert.rejects(decide({engine:'claude',snap:{},profile:{},bank:{},job:{company:'Fixture'},history:[],execImpl}),/Claude usage limit reached.*10:10pm/);
});

test('Amazon password handoff is restricted to its observed auth host and Amazon job postings',async()=>{
 const {passwordAllowedOn}=await import('../src/accounts.mjs');
 assert.equal(passwordAllowedOn('https://atozpublic.idprism-auth.amazon.com/login','https://account.amazon.jobs/jobs/1/apply'),true);
 assert.equal(passwordAllowedOn('https://atozpublic.idprism-auth.amazon.com/login','https://example.com/job'),false);
 assert.equal(passwordAllowedOn('https://atozpublic.idprism-auth.amazon.com.evil.example/login','https://account.amazon.jobs/jobs/1/apply'),false);
});

for(const required of [false,true]) for(const deferredAction of ['fill','human']) test(`standing submission authorization preserves required unknowns and skips optional unknowns: required=${required}, deferredAction=${deferredAction}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'autonomous-application-'));let submits=0;
 const server=createServer((req,res)=>{if(req.url.startsWith('/submit'))submits++;res.setHeader('Content-Type','text/html');res.end(req.url.startsWith('/submit')?'Thank you':`<form action="/submit"><label for="unknown">Extra personal information</label><input id="unknown" ${required?'required':''}><button type="submit">Submit application</button></form>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf'),run=join(dir,'run');await mkdir(run);
 await writeFile(profile,JSON.stringify({answers:{}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:9001,company:'Fixture',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,parkQuestions:true,autoSubmit:true,engine:'claude'});
 const execImpl=async(_c,_a,prompt)=>{const cs=JSON.parse(prompt).page.frames.flatMap(f=>f.controls), c=cs.find(c=>c.id&&c.label==='Extra personal information')||cs.find(c=>c.type==='submit');return{code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:required&&c.type==='submit'?deferredAction:c.type==='submit'?'review':'ask',control:required&&c.type==='submit'?'Extra personal information':c.id,fact:'',message:required&&c.type==='submit'?'Required questions have no control IDs in the supplied page; applicant input is needed':''}})};};
 try{await runWorker(run,{execImpl,stateRoot:join(dir,'state'),allowLocalFixture:true});const s=JSON.parse(await readFile(join(run,'state.json'),'utf8'));assert.equal(s.status,required?'needs_approval':'completed',s.message);assert.equal(submits,required?0:1);}finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('only the supplied original resume and transcript can be uploaded',()=>{
 assert.deepEqual(uploadDocument('Academic Transcript*','resume.pdf',{transcript:'transcript.pdf'}),{kind:'transcript',path:'transcript.pdf'});
 assert.equal(uploadDocument('Academic Transcript*','resume.pdf'),null);
 assert.deepEqual(uploadDocument('Portfolio (PDF)','resume.pdf',{portfolio:'portfolio.pdf'}),{kind:'portfolio',path:'portfolio.pdf'});
 assert.deepEqual(uploadDocument('Work samples','resume.pdf',{portfolio:'portfolio.pdf'}),{kind:'portfolio',path:'portfolio.pdf'});
 assert.equal(uploadDocument('Portfolio (PDF)','resume.pdf'),null);
 assert.deepEqual(uploadDocument('Resume / Portfolio','resume.pdf',{portfolio:'portfolio.pdf'}),{kind:'resume',path:'resume.pdf'});
 assert.equal(uploadDocument('Cover letter','resume.pdf',{transcript:'transcript.pdf'}),null);
});

test('a nonempty loading page gets one recovery attempt instead of asking the applicant to restore it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'loading-application-'));let reads=0,calls=0;
 const server=createServer((req,res)=>{reads++;res.setHeader('Content-Type','text/html');res.end('Loading your application');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const run=join(dir,'run');await mkdir(run);const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers:{}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:9900,company:'Fixture',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,parkQuestions:true,engine:'claude'});
 const execImpl=async()=>{calls++;return{code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:'human',control:'',fact:'',message:'No available application controls'}})};};
 try{await runWorker(run,{execImpl,stateRoot:join(dir,'state'),allowLocalFixture:true});const s=JSON.parse(await readFile(join(run,'state.json'),'utf8'));assert.equal(s.status,'blocked');assert.match(s.message,/^Site unavailable:/);assert.equal(calls,2);assert.ok(reads>=2);}finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('a link for the requested role on the posting site is authorized, unrelated links are rejected',()=>{
 const j={title:'Mechanical Engineer I',url:'https://careers.example.com/list'};const c={type:'a',href:'https://careers.example.com/job/1',label:j.title};
 assert.equal(safeRoleLink(c,j),true);assert.equal(safeRoleLink({...c,href:'https://other.example/job/1'},j),false);assert.equal(safeRoleLink({...c,label:'Another role'},j),false);
});


test('transient DNS failures retry but still reject private destinations',async()=>{
 let calls=0;
 const resolveHost=async()=>{if(++calls<3)throw Object.assign(Error('temporary DNS'),{code:'EAI_AGAIN'});return[{address:'93.184.216.34'}];};
 await validatePublicURL('https://example.org',false,{resolveHost,wait:async()=>{}});
 assert.equal(calls,3);
 await assert.rejects(validatePublicURL('https://example.org',false,{resolveHost:async()=>[{address:'127.0.0.1'}]}),/Private network/);
 calls=0;
 await assert.rejects(validatePublicURL('https://example.org',false,{resolveHost:async()=>{calls++;throw Object.assign(Error('no host'),{code:'ENOTFOUND'});},wait:async()=>{}}),/no host/);
 assert.equal(calls,3);
});


test('an uploader that clears its retained input is verified by the accepted filename',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<input id="resume" type="file"><span id="accepted"></span>');
  await page.evaluate(()=>setTimeout(()=>document.querySelector('#accepted').textContent='Fixture_Resume.pdf',100));
  assert.equal(await resumeAttached(page.mainFrame(),page.locator('#resume'),'Fixture_Resume.pdf'),true);
  assert.equal(await resumeAttached(page.mainFrame(),page.locator('#resume'),'Different.pdf',{tries:1}),false);
 }finally{await browser.close();}
});

test('a form control replaced during the model turn is rebound to its unique live identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rerender-control-')),run=join(dir,'run');await mkdir(run);
 const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<form><label>Name<input id="name"></label><button type="submit">Submit application</button></form><script>const timer=setInterval(()=>{const old=document.querySelector('#name');if(old.hasAttribute('data-ja-control')){const fresh=old.cloneNode();fresh.removeAttribute('data-ja-control');old.replaceWith(fresh);clearInterval(timer)}},20);</script>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers:{fullName:'Fixture Applicant'}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:9992,company:'Fixture',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,parkQuestions:true,engine:'claude'});
 let first=true;
 const execImpl=async(_c,_a,prompt)=>{const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls),input=controls.find(c=>c.label==='Name');
  // The fixture remounts once after each snapshot tag appears, before model output.
  if(first){first=false;await new Promise(r=>setTimeout(r,250));}
  return{code:0,stdout:JSON.stringify({structured_output:{action:input&&!input.value?'fill':'review',control:input&&!input.value?input.id:controls.find(c=>c.type==='submit').id,fact:'fullName',message:''}})};
 };

 try{await runWorker(run,{execImpl,stateRoot:join(dir,'state'),allowLocalFixture:true});const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));assert.equal(state.status,'ready_to_submit',state.message);assert.ok(state.review.answers.some(a=>a.label==='Name'&&a.value==='Fixture Applicant'));}
 finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});


test('background-service PATH still permits installed browser and peer CLI tools',async()=>{
 const saved=process.env.PATH;process.env.PATH='/usr/bin:/bin';
 try{
  assert.ok(agentPath(process.env.PATH).split(delimiter).includes(dirname(process.execPath)), 'Keep the active Node installation available outside standard system paths');
  const result=await execCLI(process.execPath,['-e',"const {spawnSync}=require('node:child_process');process.stdout.write(String(spawnSync('node',['--version']).status))"],'');
  assert.equal(result.stdout,'0');
 }finally{if(saved===undefined)delete process.env.PATH;else process.env.PATH=saved;}
});

test('agent shell PATH excludes JobAgent runtime venv',()=>{
 const runtime=resolve('..','jobagent','.venv','bin');
 assert.ok(!agentPath(runtime+':/usr/bin:/bin').split(':').includes(runtime));
});

test('execCLI survives a CLI that exits before reading its prompt (EPIPE, Anduril 11394 run 9ef407d0)',async()=>{
 const crashes=[];const onError=e=>crashes.push(e);process.on('uncaughtException',onError);
 try{
  const {code}=await execCLI(process.execPath,['-e','process.exit(3)'],'x'.repeat(4*1024*1024));
  assert.equal(code,3);await new Promise(r=>setTimeout(r,50));assert.deepEqual(crashes,[]);
 }finally{process.off('uncaughtException',onError);}
});
