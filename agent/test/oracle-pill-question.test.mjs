import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshot,fillAshbyChoice} from '../src/dashboard-worker.mjs';

// Shaped like Oracle Candidate Experience's cx-select-pills component (Vertiv 7922, Howmet 11608):
// a single-choice question is <ul role=radiogroup aria-label=question> of <button role=radio
// aria-checked> pills; a multi-choice one is a role=list of aria-pressed buttons.
const pills=(id,question,options,{multi=false,required=true}={})=>`<div class="question"><label class="input-label">${question}${required?' <span class="required">*</span>':''}</label>
<ul class="cx-select-pills-container" role="${multi?'list':'radiogroup'}" aria-label="${question}" id="${id}">${options.map((o,i)=>`<li role="${multi?'listitem':'presentation'}"><button type="button" class="cx-select-pill-section" ${multi?'aria-pressed="false"':`role="radio" aria-checked="false" tabindex="${i?-1:0}"`}><span class="cx-select-pill-name"> ${o}</span></button></li>`).join('')}</ul></div>`;
const page_=`<form>${pills('how','How did you come to know about this opportunity?',['Employee Referral','Career Site','LinkedIn/Job Portal','Recruitment Agency','Other'])}
${pills('age','Are you over the age of 18?',['Yes','No'])}
${pills('langs','Languages spoken',['English','Spanish'],{multi:true,required:false})}
<button type="button">Next</button></form>
<script>document.querySelectorAll('ul').forEach(ul=>ul.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;const multi=ul.getAttribute('role')==='list';
 setTimeout(()=>{if(multi){b.setAttribute('aria-pressed',b.getAttribute('aria-pressed')==='true'?'false':'true');}else{ul.querySelectorAll('button').forEach(x=>x.setAttribute('aria-checked','false'));b.setAttribute('aria-checked','true');}},50);}));</script>`;

test('Oracle pill groups snapshot as one labelled choice control and fill through aria-checked',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('http://localhost/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<html></html>'}));await page.goto('http://localhost/fixture');
  await page.setContent(page_);
  let controls=(await snapshot(page)).frames[0].controls;
  assert.deepEqual(controls.filter(c=>c.type==='button').map(c=>c.label),['Next'],'pill buttons must not surface as bare buttons');
  const choices=controls.filter(c=>c.type==='choice');
  assert.deepEqual(choices.map(c=>c.label),['How did you come to know about this opportunity?','Are you over the age of 18?','Languages spoken']);
  assert.deepEqual(choices[0].options.map(o=>o.label),['Employee Referral','Career Site','LinkedIn/Job Portal','Recruitment Agency','Other']);
  assert.deepEqual(choices.map(c=>c.required),[true,true,false]);
  assert.deepEqual(choices.map(c=>c.value),['','','']);
  await fillAshbyChoice(page.mainFrame(),page.locator(`[data-ja-control="${choices[0].id}"]`),'Other');
  await fillAshbyChoice(page.mainFrame(),page.locator(`[data-ja-control="${choices[1].id}"]`),'Yes');
  await fillAshbyChoice(page.mainFrame(),page.locator(`[data-ja-control="${choices[2].id}"]`),'Spanish');
  await assert.rejects(fillAshbyChoice(page.mainFrame(),page.locator(`[data-ja-control="${choices[1].id}"]`),'Maybe'),/unique offered choice/);
  controls=(await snapshot(page)).frames[0].controls;
  assert.deepEqual(controls.filter(c=>c.type==='choice').map(c=>c.value),['Other','Yes','Spanish']);
  assert.equal(await page.locator('#how button[aria-checked="true"]').innerText().then(t=>t.trim()),'Other');
 }finally{await browser.close();}
});
