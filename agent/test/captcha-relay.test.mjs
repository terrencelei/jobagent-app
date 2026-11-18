import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {originAllowed,solveCaptcha,runHiddenCaptcha,createRelay} from '../src/captcha-relay.mjs';
import {launchOptions,solverInitScript,SOLVER_EXTENSION} from '../src/captcha-vendor.mjs';

test('the Relay panel answers browsers only from CAPTCHA vendor frames and extensions', ()=>{
 assert.equal(originAllowed(undefined,{route:'/api/solve_captcha',type:'audio'}),true);          // the package in Node
 assert.equal(originAllowed('https://www.google.com',{route:'/api/solve_captcha',type:'audio'}),true);
 assert.equal(originAllowed('https://newassets.hcaptcha.com',{route:'/api/solve_captcha',type:'vlm_grid'}),true);
 assert.equal(originAllowed('https://evil.example',{route:'/api/solve_captcha',type:'vlm_grid'}),false);
 assert.equal(originAllowed('https://jobs.example',{route:'/api/solve_captcha',type:'slider'}),true);  // solver_ext's ByteDance branch
 assert.equal(originAllowed('https://www.google.com',{route:'/api/hidden_captcha'}),false);
 assert.equal(originAllowed('chrome-extension://abc',{route:'/api/hidden_captcha'}),true);
});

test('solve_captcha keeps the package contract for audio, slider and vlm_grid', async ()=>{
 assert.deepEqual(await solveCaptcha({type:'audio',audio_b64:'AA=='},{transcribeImpl:async()=>'5 829'}),{ok:true,text:'5 829',engine:'whisper.cpp'});
 assert.deepEqual(await solveCaptcha({type:'slider',bg:'a',piece:'b'},{service:async(route)=>{assert.equal(route,'/slide');return {ok:true,x:42,conf:0.9,method:'outline'};}}),
  {ok:true,x_offset:42,confidence:0.9,method:'outline'});
 assert.deepEqual(await solveCaptcha({type:'vlm_grid',image_b64:'AA==',prompt:'p'},{vision:async()=>({json:[2,5]})}),{ok:true,tiles:[2,5],by:'claude-cli'});
 const no=await solveCaptcha({type:'vlm_grid',image_b64:'AA==',prompt:'p'},{vision:async()=>({json:null,declined:true,text:"I can't help with that"})});
 assert.equal(no.ok,false);assert.equal(no.declined,true);assert.match(no.error,/can't help/);   // the package's decline regex sees it
 assert.equal((await solveCaptcha({type:'nope'})).ok,false);
});

test('a hidden_captcha.js decline is reported as a decline, not a miss', async ()=>{
 const fake=(stdout,stderr)=>()=>{const p=new EventEmitter();p.stdout=new EventEmitter();p.stderr=new EventEmitter();
  p.stdin={end:()=>setImmediate(()=>{p.stderr.emit('data',stderr);p.stdout.emit('data',stdout);p.emit('close');})};p.kill=()=>{};return p;};
 const d=await runHiddenCaptcha({},{spawnImpl:fake('{"ok":false,"error":"vision gave no tiles"}\n','[captcha] vision declined: I can\'t help\n')});
 assert.equal(d.declined,true);
 const ok=await runHiddenCaptcha({},{spawnImpl:fake('{"ok":true,"kind":"tiles","clicks":[[1,2]]}\n','')});
 assert.deepEqual(ok.clicks,[[1,2]]);
});

test('the panel refuses a foreign page and serves the private-network preflight for vendor frames', async ()=>{
 const server=createRelay({solve:async()=>({ok:true}),hidden:async()=>({ok:true})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const bad=await fetch(base+'/api/solve_captcha',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{"type":"audio"}'});
  assert.equal(bad.status,403);
  const pre=await fetch(base+'/api/solve_captcha',{method:'OPTIONS',headers:{Origin:'https://www.google.com'}});
  assert.equal(pre.status,204);assert.equal(pre.headers.get('access-control-allow-private-network'),'true');
  const good=await fetch(base+'/api/solve_captcha',{method:'POST',headers:{Origin:'https://www.google.com','Content-Type':'application/json'},body:'{"type":"audio"}'});
  assert.equal(good.headers.get('access-control-allow-origin'),'https://www.google.com');
 }finally{server.close();}
});

test('persistent launches load solver_ext; launch() contexts run its solver.js in every frame', ()=>{
 const o=launchOptions({headless:true,args:['--x']},{stealthArgs:['--s']});
 assert.ok(o.args.includes('--s')&&o.args.includes('--x')&&o.args.includes(`--load-extension=${SOLVER_EXTENSION}`));
 assert.deepEqual(o.ignoreDefaultArgs,['--disable-extensions']);
 const plain=launchOptions({headless:true},{stealthArgs:['--s'],extension:null});
 assert.deepEqual(plain.args,['--s']);assert.equal(plain.ignoreDefaultArgs,undefined);
 const script=solverInitScript('window.__ran=1;');
 assert.match(script,/DOMContentLoaded/);assert.match(script,/window\.__ran=1;/);
 assert.match(solverInitScript(),/127\.0\.0\.1:8787\/api\/solve_captcha/);
});
