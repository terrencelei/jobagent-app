import test from 'node:test';
import assert from 'node:assert/strict';
import {amazonPostingClosedPublicly} from '../src/posting-availability.mjs';

const job={title:'Aerospace Manufacturing Engineer - 2nd Shift, Amazon Leo',company:'Amazon',url:'https://account.amazon.jobs/jobs/10430622/apply'};
// www.amazon.jobs/en/jobs/10430622 as served on 2026-10-24: HTTP 404, HTML-escaped apostrophes.
const closedPage='<html><body><header><input name="city" class="invisible"></header><main><h1>Sorry, the job you&#39;re looking for isn&#39;t available.</h1></main></body></html>';
const response=(status,body)=>({status:()=>status,text:async()=>body});

test('a public 404 with the notice marks the Amazon posting closed before sign-in',async()=>{
 const asked=[];
 const fetch=async url=>{asked.push(url);return response(404,closedPage);};
 assert.equal(await amazonPostingClosedPublicly(job,{fetch}),`Amazon's public posting page answers 404 with "Sorry, the job you're looking for isn't available" for this exact job.`);
 assert.deepEqual(asked,['https://www.amazon.jobs/en/jobs/10430622']);
 assert.equal(await amazonPostingClosedPublicly({...job,url:'https://www.amazon.jobs/en/jobs/10430622'},{fetch}),`Amazon's public posting page answers 404 with "Sorry, the job you're looking for isn't available" for this exact job.`,'public posting URL');
});

test('an open job (302), a 404 without the notice, another host or a failed request is not a closure',async()=>{
 assert.equal(await amazonPostingClosedPublicly(job,{fetch:async()=>response(302,'')}),null,'open job redirects');
 assert.equal(await amazonPostingClosedPublicly(job,{fetch:async()=>response(200,closedPage)}),null,'notice on a 200 page');
 assert.equal(await amazonPostingClosedPublicly(job,{fetch:async()=>response(404,'<main>Not found</main>')}),null,'404 without the notice');
 assert.equal(await amazonPostingClosedPublicly({...job,url:'https://jobs.example.com/jobs/10430622/apply'},{fetch:async()=>response(404,closedPage)}),null,'other host');
 assert.equal(await amazonPostingClosedPublicly({...job,url:'https://account.amazon.jobs/jobs/10430622/apply:8443'},{fetch:async()=>response(404,closedPage)}),null,'odd path');
 assert.equal(await amazonPostingClosedPublicly(job,{fetch:async()=>{throw new Error('offline');}}),null,'request failed');
 assert.equal(await amazonPostingClosedPublicly(job,{}),null,'no fetch');
});
