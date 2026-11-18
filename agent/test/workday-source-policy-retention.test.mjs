import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {resolveQuestion,pickOption} from '../src/workday.mjs';
import {questionId} from '../src/companies.mjs';
import {chooseWorkdaySourcePrompt} from '../src/workday-prompt.mjs';
const label='How Did You Hear About Us?';
const answers={routineSourceChoiceAllowed:true,heardJobBoard:true,hearAbout:'Careers site'};
const approval={question:label,answer:'Other Job Board'};
const bank={[questionId(label)]:approval};
test('routine default preserves approved source before a nested menu has offered options',()=>{
 for(const ctx of [{approvedAnswers:[approval]},{}]) {
  const resolved=resolveQuestion(label,bank,{answers,...ctx});
  assert.deepEqual(resolved.candidates,['Other Job Board']);
 }
});
test('source reaches approved leaf beneath Internet/Social without choosing website children',async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();page.waitForTimeout=async()=>{};
  await page.setContent(`<div data-automation-id="formField-source"><input id="source" aria-controls="menu"><button data-automation-id="promptIcon" onclick="root()">Open</button><div id="saved"></div></div><div role="listbox" id="menu" hidden></div><script>
  const menu=document.getElementById('menu'),saved=document.getElementById('saved');window.actions=[];
  function row(text,action){const el=document.createElement('div');el.dataset.automationId='promptOption';el.textContent=text;el.onclick=()=>{actions.push(text);action()};menu.append(el)}
  function leaf(text){menu.hidden=false;menu.innerHTML='';row(text,()=>{saved.innerHTML='';const pill=document.createElement('span');pill.dataset.automationId='selectedItem';pill.textContent=text;saved.append(pill);menu.hidden=true})}
  function root(){menu.hidden=false;menu.innerHTML='';row('Aerospace Website',()=>leaf('aerospace.org'));row('Internet/Social',()=>leaf('Other Job Board'))}
  document.addEventListener('keydown',e=>{if(e.key==='Escape')menu.hidden=true});</script>`);
  const result=await chooseWorkdaySourcePrompt(page,page.locator('#source'),o=>pickOption(o,['Other Job Board']));
  assert.equal(result,'Other Job Board');
  assert.deepEqual(await page.locator('#saved').allTextContents(),['Other Job Board']);
  assert.deepEqual(await page.evaluate(()=>actions),['Internet/Social','Other Job Board']);
 }finally{await browser.close()}
});
