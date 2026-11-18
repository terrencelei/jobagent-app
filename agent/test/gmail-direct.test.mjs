import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {newestMessage,resetGmailDirectCache} from '../src/gmail-direct.mjs';
import {fetchApplicationCode} from '../src/application-verification.mjs';

const b64=s=>Buffer.from(s).toString('base64url');
function fakeGmail(messages,seen=[]){
  return async(url,init={})=>{
    seen.push(String(url));
    if(String(url).startsWith('https://oauth2.googleapis.com/token'))return {ok:true,json:async()=>({access_token:'t',expires_in:3600})};
    assert.equal(init.headers?.authorization,'Bearer t');
    const u=new URL(url);
    if(u.pathname.endsWith('/messages'))return {ok:true,json:async()=>({messages:messages.map(m=>({id:m.id}))})};
    const m=messages.find(m=>u.pathname.endsWith(`/messages/${m.id}`));
    return {ok:true,json:async()=>m};
  };
}
const message=(id,date,{from='Greenhouse <no-reply@us.greenhouse-mail.io>',to='Applicant <applicant@example.edu>',subject='Security code for your application to Zipline',text='Copy and paste this code into the security code field on your application:\n# ABCD1234\n\nAfter you enter the code, resubmit your application.'}={})=>
  ({id,internalDate:String(Date.parse(date)),payload:{headers:[{name:'From',value:from},{name:'To',value:to},{name:'Subject',value:subject}],mimeType:'multipart/alternative',
    parts:[{mimeType:'text/plain',body:{data:b64(text)}},{mimeType:'text/html',body:{data:b64(`<p>${text}</p>`)}}]}});

async function withToken(fn){
  const dir=await mkdtemp(join(tmpdir(),'gmail-direct-'));const path=join(dir,'token.json');
  await writeFile(path,JSON.stringify({client_id:'c',client_secret:'s',refresh_token:'r'}));
  const saved=process.env.GMAIL_TOKEN_PATH;process.env.GMAIL_TOKEN_PATH=path;resetGmailDirectCache();
  try{return await fn(path);}finally{if(saved===undefined)delete process.env.GMAIL_TOKEN_PATH;else process.env.GMAIL_TOKEN_PATH=saved;resetGmailDirectCache();await rm(dir,{recursive:true,force:true});}
}

test('without a token the direct reader stays out of the way',async()=>{
  resetGmailDirectCache();
  assert.equal(await newestMessage('anything',{path:'',fetchImpl:async()=>{throw new Error('must not call');}}),null);
});

test('the newest match comes back in the verifier evidence shape, plain text or HTML',async()=>{
  await withToken(async()=>{
    const seen=[],fetchImpl=fakeGmail([message('aaaa1111bbbb2222','2026-11-01T06:00:00Z'),message('cccc3333dddd4444','2026-11-01T06:10:00Z',{text:'Your code is WXYZ9876'})],seen);
    const found=await newestMessage('from:greenhouse-mail.io',{fetchImpl});
    assert.deepEqual({...found,body:undefined},{messageId:'cccc3333dddd4444',receivedAt:'2026-11-01T06:10:00.000Z',sender:'no-reply@us.greenhouse-mail.io',recipients:['applicant@example.edu'],subject:'Security code for your application to Zipline',body:undefined});
    assert.equal(found.body,'Your code is WXYZ9876');
    assert.ok(new URL(seen[1]).searchParams.get('q')==='from:greenhouse-mail.io');
    assert.equal((await newestMessage('x',{fetchImpl,html:true})).body,'<p>Your code is WXYZ9876</p>');
  });
});

test('a Greenhouse code gate reads the code directly, without the mailbox bridge',async()=>{
  await withToken(async()=>{
    const savedFetch=globalThis.fetch;
    globalThis.fetch=fakeGmail([message('eeee5555ffff6666',new Date().toISOString())]);
    try{
      const receipt=await fetchApplicationCode({company:'Zipline',url:'https://job-boards.greenhouse.io/zipline/jobs/1'},{email:'applicant@example.edu',after:new Date(Date.now()-60000).toISOString(),execImpl:async()=>{throw new Error('bridge must not run');},tries:1});
      assert.equal(receipt?.code,'ABCD1234');
    }finally{globalThis.fetch=savedFetch;}
  });
});

test('an HTML-only code email is read as text, so the code sentence stays whole (Zipline, 2026-11-02)',async()=>{
  await withToken(async()=>{
    const html='<!DOCTYPE html><html><head><style>p{color:red}</style></head><body><div><p>Copy and paste this code into the security code field on your application:</p><h1>61927738</h1><p>After you enter the code, resubmit.</p></div></body></html>';
    const only={id:'abab1212cdcd3434',internalDate:String(Date.now()),payload:{mimeType:'text/html',headers:[{name:'From',value:'no-reply@us.greenhouse-mail.io'},{name:'To',value:'applicant@example.edu'},{name:'Subject',value:'Security code for your application to Zipline'}],body:{data:Buffer.from(html).toString('base64url')}}};
    const found=await newestMessage('q',{fetchImpl:fakeGmail([only])});
    assert.match(found.body.replace(/\s+/g,' '),/security code field on your application: 61927738 After/);
    assert.doesNotMatch(found.body,/color:red|<p>/);
  });
});
