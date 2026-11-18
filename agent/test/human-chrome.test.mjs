import test from 'node:test';import assert from 'node:assert/strict';
import {chromeArgs,launchHumanChrome,loadExtensions,HUMAN_EXTENSIONS} from '../src/human-chrome.mjs';
import {mkdtemp} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';

test('his Chrome starts as a plain program: own profile, local DevTools port, no automation flags',async()=>{
 const args=chromeArgs('/p',9333);
 assert.ok(args.includes('--user-data-dir=/p')&&args.includes('--remote-debugging-port=9333')&&args.includes('--remote-debugging-address=127.0.0.1'));
 assert.ok(!args.some(a=>/enable-automation|headless|AutomationControlled/.test(a)));
 const spawned=[];let calls=0;
 const endpoint=await launchHumanChrome(join(await mkdtemp(join(tmpdir(),'hc-')),'profile'),{port:9333,extensions:[],
  spawnImpl:(cmd,a,o)=>{spawned.push({cmd,a,o});return {unref(){}};},fetchImpl:async(url,init)=>{calls++;if(init?.method==='PUT')spawned.push({tab:url});return {ok:calls>1};}});
 assert.equal(endpoint,'http://127.0.0.1:9333');assert.equal(spawned[0].o.detached,true);assert.match(spawned.at(-1).tab,/json\/new\?about:blank%23jobagent$/);
});

test('a freshly started hand-off Chrome loads the package extension and the hCaptcha worker over DevTools',async()=>{
 assert.ok(chromeArgs('/p',1).includes('--enable-unsafe-extension-debugging'));
 assert.equal(HUMAN_EXTENSIONS.length,2);assert.ok(HUMAN_EXTENSIONS.some(p=>/vendor\/captcha-solver\/solver_ext$/.test(p))&&HUMAN_EXTENSIONS.some(p=>/extensions\/relay-hidden$/.test(p)));
 const sent=[];
 class FakeWS{constructor(url){this.url=url;setTimeout(()=>this.onopen(),0);}send(raw){const m=JSON.parse(raw);sent.push(m);setTimeout(()=>this.onmessage({data:JSON.stringify({id:m.id,result:{id:'ext'+m.id}})}),0);}close(){}}
 const r=await loadExtensions('http://127.0.0.1:1',['/a','/b'],{fetchImpl:async()=>({json:async()=>({webSocketDebuggerUrl:'ws://x'})}),WebSocketImpl:FakeWS});
 assert.deepEqual(sent.map(m=>[m.method,m.params.path]),[['Extensions.loadUnpacked','/a'],['Extensions.loadUnpacked','/b']]);
 assert.deepEqual(r.map(x=>x.id),['ext1','ext2']);
 const started=[];let calls=0;
 await launchHumanChrome(join(await mkdtemp(join(tmpdir(),'hc-')),'profile'),{port:9334,extensions:['/a'],relay:async()=>started.push('relay'),
  spawnImpl:()=>({unref(){}}),fetchImpl:async(url,init)=>{calls++;if(/json\/version/.test(url)&&calls>2)return {ok:true,json:async()=>{throw new Error('no ws in test');}};return {ok:calls>1};}});
 assert.deepEqual(started,['relay']);
});

test('the relay Chrome starts hidden and off-screen, opens its tab in the background and is hidden again',async()=>{
 const {hiddenLaunch,hideChrome,launchRelayChrome}=await import('../src/human-chrome.mjs');
 const [cmd,args]=hiddenLaunch('/prof',9444);
 assert.equal(cmd,'open');assert.deepEqual(args.slice(0,4),['-n','-g','-j','-a']);
 assert.ok(args.includes('--user-data-dir=/prof')&&args.includes('--window-position=-12000,-12000')&&args.includes('--disable-backgrounding-occluded-windows'));
 const calls=[];
 const exec=async(c,a)=>{calls.push([c,a]);return c==='ps'?'  77 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/prof --remote-debugging-port=1\n  78 /x/Google Chrome Helper --type=renderer --user-data-dir=/prof\n':'';};
 assert.equal(await hideChrome('/prof',{exec}),true);
 assert.match(calls.at(-1)[1][1],/unix id is 77\) to false/);
 const spawned=[],hidden=[];let n=0;
 await launchRelayChrome(join(await mkdtemp(join(tmpdir(),'hc-')),'p'),{port:9445,extensions:[],hide:async d=>hidden.push(d),
  spawnImpl:(c,a)=>{spawned.push(c);return {unref(){}};},fetchImpl:async(url,init)=>{n++;if(/json\/version/.test(url)&&n>1&&!init)return {ok:true,json:async()=>{throw new Error('no ws');}};return {ok:n>1};}});
 assert.equal(spawned[0],'open');assert.equal(hidden.length,1);
});

test('two workers starting the relay Chrome together launch it once', async()=>{
 const {withLaunchLock}=await import('../src/human-chrome.mjs');
 const dir=await mkdtemp(join(tmpdir(),'hc-lock-'));let inside=0,max=0;
 const job=()=>withLaunchLock(dir,async()=>{inside++;max=Math.max(max,inside);await new Promise(r=>setTimeout(r,50));inside--;});
 await Promise.all([job(),job(),job()]);
 assert.equal(max,1);
});
