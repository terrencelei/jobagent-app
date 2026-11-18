import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captchaAuthorized,loadCaptchaConfig,solveRecaptchaV2,recaptchaPageOperation,completeCaptcha} from '../src/captcha-solver.mjs';

const url='https://jobs.ashbyhq.com/example/role/application';
const config={enabled:true,provider:'2captcha',allowedUrls:[url],apiKey:'fixture-service-key'};
test('solver is opt-in, scoped to exact posting and requires submission authorization',()=>{
 assert.equal(captchaAuthorized(config,url,true),true);
 for(const [cfg,target,authorized]of [[config,url,false],[{...config,enabled:false},url,true],
  [config,url+'/other',true],[config,'http://jobs.ashbyhq.com/example/role/application',true],
  [config,'https://other.example/example/role/application',true]])
  assert.equal(captchaAuthorized(cfg,target,authorized),false);
});
test('saved solver key or worker environment is read without requiring a model',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'captcha-config-'));const file=join(dir,'captcha.json');
 try{
  assert.equal(await loadCaptchaConfig(file,{}),null);
  await writeFile(file,JSON.stringify({...config,apiKey:''}));
  assert.equal((await loadCaptchaConfig(file,{TWOCAPTCHA_API_KEY:'fixture-env-key'})).apiKey,'fixture-env-key');
  await writeFile(file,JSON.stringify(config));
  assert.equal((await loadCaptchaConfig(file,{})).apiKey,config.apiKey);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('one v2 task is polled and sends only public widget metadata',async()=>{
 const calls=[];let clock=0;
 const replies=[{errorId:0,taskId:42},{errorId:0,status:'processing'},
  {errorId:0,status:'ready',solution:{gRecaptchaResponse:'fixture-token'}}];
 const token=await solveRecaptchaV2({apiKey:config.apiKey,websiteURL:url,websiteKey:'fixture-site-key',isInvisible:true},
  {fetchImpl:async(endpoint,options)=>{calls.push({endpoint,body:JSON.parse(options.body),redirect:options.redirect});
    return {ok:true,json:async()=>replies.shift()};},now:()=>clock,wait:async ms=>{clock+=ms;}});
 assert.equal(token,'fixture-token');
 assert.deepEqual(calls.map(c=>c.endpoint),['https://api.2captcha.com/createTask',
  'https://api.2captcha.com/getTaskResult','https://api.2captcha.com/getTaskResult']);
 assert.deepEqual(calls[0].body,{clientKey:config.apiKey,task:{type:'RecaptchaV2TaskProxyless',
  websiteURL:url,websiteKey:'fixture-site-key',isInvisible:true,apiDomain:'google.com'}});
 assert.equal(calls[0].redirect,'error');
});
test('provider failures redact response data and never recreate a charged task',async()=>{
 let calls=0;
 await assert.rejects(solveRecaptchaV2({apiKey:config.apiKey,websiteURL:url,websiteKey:'key'},
  {fetchImpl:async()=>{calls++;throw Error(config.apiKey);}}),/^Error: CAPTCHA solver request failed$/);
 assert.equal(calls,1);
 await assert.rejects(solveRecaptchaV2({apiKey:config.apiKey,websiteURL:url,websiteKey:'key'},
  {fetchImpl:async()=>({ok:true,json:async()=>({errorId:1,errorDescription:config.apiKey})})}),
  /^Error: CAPTCHA solver rejected the task$/);
});
test('processing task has a deadline and is not retried on timeout',async()=>{
 let clock=0,created=0;
 await assert.rejects(solveRecaptchaV2({apiKey:config.apiKey,websiteURL:url,websiteKey:'key'},
  {timeoutMs:12000,now:()=>clock,wait:async ms=>{clock+=ms;},fetchImpl:async endpoint=>{
   if(endpoint.endsWith('/createTask'))created++;
   return {ok:true,json:async()=>endpoint.endsWith('/createTask')?{errorId:0,taskId:1}:{errorId:0,status:'processing'}};
  }}),/timed out/);
 assert.equal(clock,12000);assert.equal(created,1);
});

function widgetPage({keys=['widget-key'],extraCallback=false,enterprise=false}={}){
 const received=[],field={value:''};
 const client={options:{sitekey:'widget-key',callback:token=>received.push(token)}};
 client.loop=client;Object.defineProperty(client,'getter',{get(){throw Error('Getter must not execute');}});
 if(extraCallback)client.other={callback:()=>received.push('wrong')};
 const context={URL,window:{___grecaptcha_cfg:{clients:{0:client}}},document:{querySelectorAll:selector=>
  selector==='iframe'?keys.map(key=>({src:`https://www.google.com/recaptcha/${enterprise?'enterprise':'api2'}/anchor?k=${key}&size=invisible`})):[field]}};
 return {evaluate:async(fn,args)=>vm.runInNewContext(`(${fn.toString()})(args)`,{...context,args}),
  url:()=>url,received,field,context};
}
test('v2 callback resumes once without clicking Submit, handles cycles and avoids getters',async()=>{
 const page=widgetPage();
 const widget=await page.evaluate(recaptchaPageOperation,{});
 assert.equal(widget.isInvisible,true);assert.equal(page.received.length,0);
 const result=await completeCaptcha(page,{url},{config,submissionAuthorized:true,solve:async()=>'fixture-token'});
 assert.equal(result.completed,true);assert.deepEqual(page.received,['fixture-token']);
 assert.equal(page.field.value,'fixture-token');
});
test('unsupported or ambiguous widgets are not sent to paid solver',async()=>{
 for(const options of [{keys:['a','b']},{extraCallback:true},{enterprise:true}]){
  const page=widgetPage(options);let calls=0;
  const result=await completeCaptcha(page,{url},{config,submissionAuthorized:true,solve:async()=>{calls++;}});
  assert.equal(result.completed,false);assert.equal(calls,0);assert.equal(page.received.length,0);
 }
});
test('missing key, changed posting or no submission approval never starts solving',async()=>{
 for(const [cfg,authorized,pageUrl]of [[{...config,apiKey:''},true,url],[config,false,url],[config,true,url+'/other']]){
  const page=widgetPage();page.url=()=>pageUrl;let calls=0;
  const result=await completeCaptcha(page,{url},{config:cfg,submissionAuthorized:authorized,solve:async()=>{calls++;}});
  assert.equal(result.completed,false);assert.equal(calls,0);
 }
});
test('widget changed while solving cannot receive a stale token',async()=>{
 const page=widgetPage();
 const result=await completeCaptcha(page,{url},{config,submissionAuthorized:true,solve:async()=>{
  page.context.window.___grecaptcha_cfg.clients={};return 'fixture-token';
 }});
 assert.equal(result.completed,false);assert.equal(page.received.length,0);
});
test('solver service keys are not inherited by subscription model CLIs',async()=>{
 const {execCLI}=await import('../src/dashboard-worker.mjs');
 const names=['TWOCAPTCHA_API_KEY','TWO_CAPTCHA_API_KEY'];const previous=names.map(name=>process.env[name]);
 try{
  for(const name of names)process.env[name]='fixture-secret';
  const {stdout}=await execCLI(process.execPath,['-e','console.log(Boolean(process.env.TWOCAPTCHA_API_KEY||process.env.TWO_CAPTCHA_API_KEY))'],'');
  assert.equal(stdout.trim(),'false');
 }finally{names.forEach((name,i)=>{if(previous[i]===undefined)delete process.env[name];else process.env[name]=previous[i];});}
});
