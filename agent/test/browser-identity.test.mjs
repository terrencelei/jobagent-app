import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {runWorker,atomic} from '../src/dashboard-worker.mjs';
import {applicationUserAgent,siteNavigationFailure} from '../src/browser-identity.mjs';

test('the headless user agent is presented as the Chrome the visible browser already reports', () => {
  const headless='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36';
  assert.equal(applicationUserAgent(headless),headless.replace('HeadlessChrome/','Chrome/'));
  const visible=headless.replace('HeadlessChrome/','Chrome/');
  assert.equal(applicationUserAgent(visible),visible);
  assert.equal(applicationUserAgent(undefined),undefined);
});

test('connection-level navigation errors are site outages; form and model errors are not', () => {
  const honeywell=new Error('page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://careers.honeywell.com/en/sites/Honeywell/job/157637\nCall log:\n  - navigating to "https://careers.honeywell.com/en/sites/Honeywell/job/157637", waiting until "domcontentloaded"\n');
  assert.match(siteNavigationFailure(honeywell),/reset the HTTP\/2 connection while opening the posting \(net::ERR_HTTP2_PROTOCOL_ERROR\)/);
  assert.match(siteNavigationFailure(new Error('page.goto: net::ERR_CONNECTION_RESET at https://x.example/')),/reset the connection/);
  assert.equal(siteNavigationFailure(new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.example/')),null);
  assert.equal(siteNavigationFailure(new Error('The page changed or a control could not be identified')),null);
  assert.equal(siteNavigationFailure(new Error('locator.click: net::ERR_CONNECTION_RESET')),null);
});

async function fixture(handler){
  const dir=await mkdtemp(join(tmpdir(),'browser-identity-'));
  const run=join(dir,'run'),stateRoot=join(dir,'state');await mkdir(run);await mkdir(stateRoot);
  const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}/job/1`;
  const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');
  await writeFile(profilePath,JSON.stringify({answers:{}}));await writeFile(resumePath,'fixture');
  await atomic(join(run,'request.json'),{job:{id:11244,company:'Fixture',title:'Engineer',url},profilePath,resumePath,engine:'claude',parkQuestions:true,autoSubmit:false,headlessOnly:true});
  const execImpl=async(_command,_args,prompt)=>{const control=JSON.parse(prompt).page.frames.flatMap(f=>f.controls).find(c=>c.type==='submit');return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:'review',control:control.id,fact:'',message:''},usage:{}})};};
  return {dir,run,stateRoot,server,execImpl,close:async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}};
}

test('an edge that drops every HeadlessChrome request still serves the headless worker', async () => {
  const agents=[];
  const f=await fixture((req,res)=>{
    agents.push(req.headers['user-agent']);
    if(/HeadlessChrome/.test(req.headers['user-agent']??''))return req.socket.destroy();
    res.setHeader('Content-Type','text/html');res.end('<form method="post"><label>Name<input value="Fixture Applicant" required></label><button type="submit">Submit application</button></form>');
  });
  try{
    await runWorker(f.run,{execImpl:f.execImpl,stateRoot:f.stateRoot,allowLocalFixture:true});
    const state=JSON.parse(await readFile(join(f.run,'state.json'),'utf8'));
    assert.equal(state.status,'ready_to_submit',state.message);
    assert.ok(agents.length>0&&agents.every(ua=>/Chrome\//.test(ua)&&!/HeadlessChrome/.test(ua)),agents.join('\n'));
  }finally{await f.close();}
});

test('a posting whose site drops the connection is parked as unavailable for a cooldown, not failed', async () => {
  const f=await fixture(req=>req.socket.destroy());
  try{
    await runWorker(f.run,{execImpl:f.execImpl,stateRoot:f.stateRoot,allowLocalFixture:true});
    const state=JSON.parse(await readFile(join(f.run,'state.json'),'utf8'));
    assert.equal(state.status,'blocked',state.message);
    assert.match(state.message,/^Site unavailable: the site (closed the connection|answered with an empty response|reset the connection) while opening the posting \(net::ERR_/);
    assert.equal(state.submitted,undefined);
  }finally{await f.close();}
});
