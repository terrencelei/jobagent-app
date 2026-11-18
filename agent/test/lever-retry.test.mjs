import test from 'node:test';
import assert from 'node:assert/strict';
import {leverRetryOnce,watchLeverHandoff,lastResponseRefused} from '../src/lever-retry.mjs';

const URL_='https://jobs.lever.co/acme/123/apply';
const refusal={status:400,verificationError:'There was an error verifying your application'};
// A fake Lever page: Submit clicks call onSubmit, which decides the next response.
function fakeLever({onSubmit}){
 const responses=[],monitor={responses:()=>responses};
 const state={url:URL_,files:0,attached:[],clicks:0};
 const locator=sel=>({first:()=>locator(sel),count:async()=>1,
  evaluate:async()=>state.files,setInputFiles:async p=>{state.files=1;state.attached.push(p);},
  inputValue:async()=>sel.includes('resumeStorageId')?'stored':'',
  evaluateAll:async()=>false,innerText:async()=>'',
  scrollIntoViewIfNeeded:async()=>{},boundingBox:async()=>({x:10,y:10,width:100,height:30}),click:async()=>{}});
 const page={url:()=>state.url,isClosed:()=>false,waitForTimeout:async()=>{},viewportSize:()=>({width:800,height:600}),locator,
  mouse:{move:async()=>{},down:async()=>{},up:async()=>{state.clicks++;onSubmit(state,responses);}}};
 return {page,monitor,state,responses};
}
const job={id:1,url:URL_};

test('no retry unless Lever explicitly refused an application POST',async()=>{
 const {page,monitor,state}=fakeLever({onSubmit:()=>{}});
 assert.equal(lastResponseRefused(monitor),false);
 assert.equal((await leverRetryOnce(page,job,{monitor,resumePath:'/r.pdf'})).status,'not_retried');
 assert.equal(state.clicks,0);
});

test('after a refusal the emptied resume is re-attached and Submit pressed once; leaving the page is acceptance',async()=>{
 const {page,monitor,state,responses}=fakeLever({onSubmit:s=>{s.url='https://acme.com/confirmation?LeverAppId=x';}});
 responses.push(refusal);
 const r=await leverRetryOnce(page,job,{monitor,resumePath:'/r.pdf',settleMs:0});
 assert.equal(r.status,'accepted');assert.deepEqual(state.attached,['/r.pdf']);assert.equal(state.clicks,1);
});

test('the hand-off watcher retries once for him and stops at a second refusal',async()=>{
 const {page,monitor,state,responses}=fakeLever({onSubmit:(s,rs)=>rs.push(refusal)});
 let tick=0;page.waitForTimeout=async()=>{if(++tick===2)responses.push(refusal);};  // his own Submit is refused
 const r=await watchLeverHandoff(page,job,{monitor,resumePath:'/r.pdf',timeoutMs:60000});
 assert.equal(r.status,'refused');assert.equal(state.clicks,1);
});
