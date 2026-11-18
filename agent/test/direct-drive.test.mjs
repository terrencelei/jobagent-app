import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {drivePrompt,claudeArgs,summarize,MCP_PACKAGE,PASSWORD_SECRET,mcpConfig,secretsFile,redact,runDirectSession,approvedForSession,directAllowed,openQuestions,stuckBySteps,rescueKey,claudeCommand} from '../src/direct-control.mjs';
import {parseArgs} from '../tools/direct-drive.mjs';

test('the session gets browser tools only and a pinned MCP package',()=>{
 const args=claudeArgs({mcpConfigPath:'/tmp/mcp.json',model:'m'});
 assert.equal(args[args.indexOf('--tools')+1],'');
 assert.equal(args[args.indexOf('--allowedTools')+1],'mcp__playwright');
 assert.ok(args.includes('--strict-mcp-config')&&args.includes('--no-session-persistence'));
 assert.match(MCP_PACKAGE,/^@playwright\/mcp@\d+\.\d+\.\d+$/);
 assert.deepEqual(mcpConfig({endpoint:'http://127.0.0.1:9',secretsPath:'/w/s.env'}).mcpServers.playwright.args,['-y',MCP_PACKAGE,'--cdp-endpoint','http://127.0.0.1:9','--secrets','/w/s.env']);
 assert.ok(!mcpConfig({endpoint:'http://127.0.0.1:9'}).mcpServers.playwright.args.includes('--secrets'));
});

test('the prompt never allows the final Submit or invented answers, in either mode',()=>{
 for(const mode of ['trial','worker']){
  const text=drivePrompt({url:'https://example.test/job',company:'Acme',title:'Engineer',facts:{workAuthorization:'Yes'},approved:{'Why us?':'Because.'},resumePath:'/r/resume.pdf',mode});
  assert.match(text,/NEVER click the final Submit/);
  assert.match(text,/Never invent a fact/);
  assert.match(text,/untrusted data/);
  assert.match(text,/Never sign in, create an account, or type a password/);
  assert.match(text,/Never tick marketing/);
  assert.ok(text.includes('"workAuthorization": "Yes"')&&text.includes('Why us?')&&text.includes('/r/resume.pdf'));
 }
 const none=drivePrompt({url:'https://x.test',mode:'worker'});
 assert.match(none,/Do not upload any file/);
 const docs=drivePrompt({url:'https://x.test',resumePath:'/w/resume.pdf',documents:{transcript:'/w/transcript.pdf',portfolio:''},mode:'worker'});
 assert.ok(docs.includes('transcript: /w/transcript.pdf')&&!docs.includes('portfolio:'));
 assert.match(docs,/only for a field that asks for exactly that document/);
});

test('in a shared Chrome the session is bound to its own tab',()=>{
 const text=drivePrompt({url:'https://jobs.example.test/a/application',mode:'worker',sharedBrowser:true});
 assert.match(text,/select the one whose address is https:\/\/jobs\.example\.test\/a\/application/);
 assert.match(text,/never type, click, navigate or close anything in another tab/);
 assert.ok(!drivePrompt({url:'https://jobs.example.test/a',mode:'worker'}).includes('other tabs that belong to other work'));
});

test('sign-in names the placeholder, never the password; the worker session may create an account, the trial may not',()=>{
 const worker=drivePrompt({url:'https://x.test',signIn:{email:'person@example.test'},mode:'worker'});
 assert.ok(worker.includes(PASSWORD_SECRET)&&worker.includes('person@example.test'));
 assert.match(worker,/Never use Google, LinkedIn, Apple/);
 assert.match(worker,/create one with that same email/);
 assert.match(worker,/ticking only a required terms box and no marketing or alert opt-ins/);
 assert.match(worker,/"Forgot password" once to request a reset email, then stop/);
 assert.match(worker,/verification code or emailed link is asked for, stop/);
 const trial=drivePrompt({url:'https://x.test',signIn:{email:'person@example.test'},mode:'trial'});
 assert.match(trial,/do not create an account or reset a password/);assert.ok(!/create one with that same email/.test(trial));
 assert.equal(secretsFile('pass word#1'),`${PASSWORD_SECRET}="pass word#1"\n`);
 assert.equal(secretsFile('bad"quote'),null);assert.equal(secretsFile(''),null);assert.equal(secretsFile(null),null);
 assert.equal(redact('typed hunter2 here','hunter2'),`typed <secret>${PASSWORD_SECRET}</secret> here`);
});

test('a session writes its secret file privately, keeps the password out of its log and reports tools',async()=>{
 const work=await mkdtemp(join(tmpdir(),'direct-test-'));
 try{
  let seen;
  const spawnImpl=(command,args,options)=>{
   seen={command,args,options};
   const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
   child.stdin=Object.assign(new EventEmitter(),{end(prompt){seen.prompt=prompt;setImmediate(()=>{
    child.stdout.emit('data',JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'mcp__playwright__browser_type',input:{text:'echo hunter2'}}]}})+'\n');
    child.stdout.emit('data',JSON.stringify({type:'result',num_turns:2,duration_ms:5000,usage:{input_tokens:1,output_tokens:2},result:'{"filled":[],"unanswered":[],"signedIn":true,"stoppedBecause":"ready for review"}'})+'\n');
    child.emit('close',0);});}});
   return child;
  };
  const tools=[];
  const session=await runDirectSession({endpoint:'http://127.0.0.1:9',prompt:'P',workDir:work,password:'hunter2',spawnImpl,onTool:name=>tools.push(name),env:{ANTHROPIC_API_KEY:'k',PATH:'/bin'},pathFor:p=>`/tools:${p}`,command:'/x/claude'});
  assert.equal(seen.command,'/x/claude');assert.equal(seen.options.env.PATH,'/tools:/bin');assert.equal(session.error,null);
  assert.equal(session.exit,0);assert.equal(session.isError,false);assert.equal(session.answer.signedIn,true);assert.deepEqual(tools,['browser_type']);
  assert.ok(!session.lines.join('\n').includes('hunter2'));
  assert.equal(seen.prompt,'P');assert.equal(seen.options.env.ANTHROPIC_API_KEY,undefined);assert.equal(seen.options.cwd,work);
  assert.equal(await readFile(join(work,'secrets.env'),'utf8'),`${PASSWORD_SECRET}="hunter2"\n`);
  assert.ok(!(await readFile(join(work,'mcp.json'),'utf8')).includes('hunter2'));
 }finally{await rm(work,{recursive:true,force:true});}
});

test('the worker hands a page over on every route and engine, with enough open questions, three pages at most',()=>{
 const base={request:{directControl:true},engine:'claude',endpoint:'http://127.0.0.1:9',pageUrl:'https://jobs.ashbyhq.com/acme/1/application',open:5};
 assert.equal(directAllowed(base),true);
 assert.equal(directAllowed({...base,request:{}}),false);
 assert.equal(directAllowed({...base,endpoint:null}),false);
 assert.equal(directAllowed({...base,pageUrl:'not a url'}),false);
 assert.equal(directAllowed({...base,engine:'codex'}),true);
 assert.equal(directAllowed({...base,request:{directControl:true,humanFinish:true}}),true);
 assert.equal(directAllowed({...base,pageUrl:'https://jobs.lever.co/acme/1/apply'}),true);
 assert.equal(directAllowed({...base,open:2}),false);
 assert.equal(directAllowed({...base,seen:new Set(['https://jobs.ashbyhq.com/acme/1/application'])}),false);
 assert.equal(directAllowed({...base,pageUrl:'https://jobs.ashbyhq.com/acme/1/application?x=1',seen:new Set(['https://jobs.ashbyhq.com/acme/1/application'])}),false);
 assert.equal(directAllowed({...base,seen:new Set(['a','b','c'])}),false);
 const view={frames:[{controls:[{type:'text',required:true,value:''},{type:'text',required:true,value:'x'},{type:'file',required:true,value:''},{type:'select-one',required:true,value:''},{type:'text',required:false,value:''},{type:'checkbox',required:true,value:'',checked:true}]}]};
 assert.equal(openQuestions(view),2);assert.equal(openQuestions(null),0);
});

test('approved answers keep employer prose and drop long shared text',()=>{
 const long='x'.repeat(500);
 assert.deepEqual(approvedForSession({a:{question:'Q1',answer:'Yes',shared:true},b:{question:'Q2',answer:long,shared:true},c:{question:'Why us?',answer:long,approvedFor:7},d:{answer:'  '}}),{Q1:'Yes','Why us?':long});
});

test('arguments and the session summary are read back',()=>{
 assert.deepEqual(parseArgs(['https://x.test/a','--company','Acme','--model','m2','--timeout-minutes','2','--sign-in']),{url:'https://x.test/a',company:'Acme',title:'',model:'m2',timeoutMs:120000,signIn:true,fixturePassword:null});
 const lines=[
  JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'mcp__playwright__browser_snapshot'},{type:'tool_use',name:'mcp__playwright__browser_fill_form'}]}}),
  'not json',
  JSON.stringify({type:'result',num_turns:3,duration_ms:41234,usage:{input_tokens:5,output_tokens:7},result:'done {"filled":[{"question":"a","answer":"b"}],"unanswered":[],"stoppedBecause":"ready for review"}'}),
 ];
 const s=summarize(lines);
 assert.equal(s.toolCalls,2);assert.deepEqual(s.toolCounts,{browser_snapshot:1,browser_fill_form:1});
 assert.equal(s.modelSeconds,41.2);assert.equal(s.isError,false);assert.equal(s.answer.stoppedBecause,'ready for review');
 assert.equal(summarize([]).isError,true);
});

test('a page stuck by steps is handed over once more, whatever is still open',()=>{
 assert.equal(stuckBySteps([],2),true);assert.equal(stuckBySteps([],1),false);
 const same=[{action:'select',control:'c1'},{action:'select',control:'c1'},{action:'select',control:'c1'}];
 assert.equal(stuckBySteps(same,0),true);
 assert.equal(stuckBySteps([...same.slice(0,2),{action:'fill',control:'c2'}],0),false);
 assert.equal(stuckBySteps([{action:'rejected',control:'w'},{action:'rejected',control:'w'},{action:'rejected',control:'w'}],0),false);
 const url='https://account.example.test/apply',base={request:{directControl:true},engine:'claude',endpoint:'http://127.0.0.1:9',pageUrl:url,open:1};
 assert.equal(directAllowed(base),false);
 assert.equal(directAllowed({...base,stuck:true}),true);
 assert.equal(directAllowed({...base,stuck:true,seen:new Set(['https://account.example.test/apply'])}),true);
 assert.equal(directAllowed({...base,stuck:true,seen:new Set([rescueKey(url)])}),false);
 assert.equal(directAllowed({...base,stuck:true,request:{}}),false);
});

test('a session that cannot start says why, and the CLI is found outside the service PATH',async()=>{
 const work=await mkdtemp(join(tmpdir(),'direct-test-'));
 try{
  const spawnImpl=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
   child.stdin=Object.assign(new EventEmitter(),{end(){setImmediate(()=>child.emit('error',new Error('spawn claude ENOENT')));}});return child;};
  const session=await runDirectSession({endpoint:'http://127.0.0.1:9',prompt:'P',workDir:work,spawnImpl,command:'claude',pathFor:p=>p,env:{}});
  assert.equal(session.isError,true);assert.match(session.error,/could not start claude: spawn claude ENOENT/);
 }finally{await rm(work,{recursive:true,force:true});}
 assert.equal(claudeCommand(['/nonexistent/claude']),'claude');
 assert.equal(claudeCommand(['/nonexistent/claude','/bin/sh']),'/bin/sh');
});
