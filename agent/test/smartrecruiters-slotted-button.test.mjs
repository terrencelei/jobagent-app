import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshot} from '../src/dashboard-worker.mjs';

// Intuitive 12316 (lesson 425): SmartRecruiters' <spl-button> renders a shadow <button><slot></slot></button>, so the
// button's innerText is "" while it shows "Next". The worker saw only unlabelled buttons and stopped short of Next.
test('a shadow-DOM button with slotted text is labelled by the text it shows',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  const url='https://jobs.smartrecruiters.com/oneclick-ui/company/Example/publication/x';
  await page.route(url,r=>r.fulfill({contentType:'text/html',body:'<form><label>First name<input name=f></label><spl-button id=add>Add</spl-button><spl-button id=next><span>Next</span></spl-button></form>'}));
  await page.goto(url);
  await page.evaluate(()=>{for(const host of document.querySelectorAll('spl-button'))host.attachShadow({mode:'open'}).innerHTML='<button type=button><span class=inner><slot></slot></span></button>';});
  const snap=await snapshot(page);
  const labels=snap.frames.flatMap(f=>f.controls).filter(c=>c.type==='button').map(c=>c.label);
  assert.ok(labels.includes('Next'),JSON.stringify(labels));assert.ok(labels.includes('Add'),JSON.stringify(labels));
 }finally{await browser.close();}
});

// Intuitive 12316 page 2 (lesson 426): no <form> anywhere, and a required shadow checkbox whose own label is only
// "*" while the question text is slotted. It read as an unknown box outside any form, so the account-page guard failed the run.
test('a formless page counts as the application form, and a "*" checkbox takes the question text it shows',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  const url='https://jobs.smartrecruiters.com/oneclick-ui/company/Example/publication/y';
  await page.route(url,r=>r.fulfill({contentType:'text/html',body:'<main><input aria-label="Postal code" required><input aria-label="State"><input aria-label="Other state"><spl-checkbox>I certify that the information I provided is accurate.</spl-checkbox></main>'}));
  await page.goto(url);
  await page.evaluate(()=>{document.querySelector('spl-checkbox').attachShadow({mode:'open'}).innerHTML='<div class=row><input type=checkbox id=c required><label for=c>*</label><span><slot></slot></span></div>';});
  const controls=(await snapshot(page)).frames.flatMap(f=>f.controls);
  const box=controls.find(c=>c.type==='checkbox');
  assert.ok(box,JSON.stringify(controls));
  assert.match(box.label,/I certify that the information/);assert.equal(box.inForm,true);
 }finally{await browser.close();}
});

// Intuitive 12315 (lesson 434): "Are you a protected veteran? (definitions) *" Yes / No / Prefer not to answer. The
// radio group sits in a shadow root whose legend slots the question in, so the group read as the question "*" and was
// flagged for him although his profile says he is not a veteran.
test('a radio group whose legend slots its question is named by the question text',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  const url='https://jobs.smartrecruiters.com/oneclick-ui/company/Example/publication/z';
  await page.route(url,r=>r.fulfill({contentType:'text/html',body:'<main><input aria-label="Postal code" required><input aria-label="City"><input aria-label="State"><spl-radio-group><span slot="label">Are you a protected veteran? <a href="#">(definitions)</a></span></spl-radio-group></main>'}));
  await page.goto(url);
  await page.evaluate(()=>{document.querySelector('spl-radio-group').attachShadow({mode:'open'}).innerHTML='<fieldset><legend><slot name="label"></slot><span>*</span></legend>'+
   ['Yes','No','Prefer not to answer'].map((o,i)=>`<input type=radio name=v id=v${i} required><label for=v${i}>${o}</label>`).join('')+'</fieldset>';});
  const radios=(await snapshot(page)).frames.flatMap(f=>f.controls).filter(c=>c.type==='radio'||c.type==='choice');
  assert.ok(radios.length,JSON.stringify(radios));
  assert.ok(radios.every(c=>/^Are you a protected veteran\?/.test(c.label)),JSON.stringify(radios.map(c=>c.label)));
 }finally{await browser.close();}
});

// Intuitive 12315 (lesson 436): the Yes/No answers are <spl-radio> hosts whose native radio is display:none in the
// shadow root, with only the label shown. The snapshot skipped them as invisible, so after Submit's "This field is
// required." the worker had no control to answer four required questions with.
test('hidden native radios behind visible labels are listed and can be checked',async()=>{
 const {setCheckedControl}=await import('../src/dashboard-worker.mjs');
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  const url='https://jobs.smartrecruiters.com/oneclick-ui/company/Example/publication/r';
  await page.route(url,r=>r.fulfill({contentType:'text/html',body:'<main><input aria-label="Postal code" required><input aria-label="City"><input aria-label="State"><fieldset><legend>Have you previously worked for Example?</legend><spl-radio>Yes</spl-radio><spl-radio>No</spl-radio></fieldset></main>'}));
  await page.goto(url);
  await page.evaluate(()=>{let i=0;for(const h of document.querySelectorAll('spl-radio')){const id='o'+i++;h.attachShadow({mode:'open'}).innerHTML=`<input type=radio name=w id=${id} required style="display:none"><label for=${id}><slot></slot></label>`;}});
  const radios=(await snapshot(page)).frames.flatMap(f=>f.controls).filter(c=>c.type==='radio');
  assert.equal(radios.length,2,JSON.stringify(radios));
  const no=radios.find(c=>c.optionLabel==='No');assert.ok(no,JSON.stringify(radios.map(c=>[c.label,c.optionLabel])));
  assert.equal(no.label,'Have you previously worked for Example?');assert.deepEqual(no.choiceLabels,['Yes','No']);
  await setCheckedControl(page.mainFrame(),page.locator(`[data-ja-control="${no.id}"]`),true);
  assert.equal(await page.evaluate(()=>document.querySelectorAll('spl-radio')[1].shadowRoot.querySelector('input').checked),true);
 }finally{await browser.close();}
});

// Intuitive 12315/12316 (lesson 437), the markup the run folder recorded: <spl-radio label="No" role="radio"
// aria-checked="false"> hosts with no native input, slotted into a shadow <fieldset role="radiogroup"
// aria-labelledby> whose <label> slots the question text in from the radio group host.
test('ARIA-only SmartRecruiters radios are listed with their question and options, and can be checked',async()=>{
 const {setCheckedControl}=await import('../src/dashboard-worker.mjs');
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  const url='https://jobs.smartrecruiters.com/oneclick-ui/company/Example/publication/aria';
  await page.route(url,r=>r.fulfill({contentType:'text/html',body:'<main><input aria-label="Postal code" required><input aria-label="City"><input aria-label="State">'+
   '<spl-radio-group required><span slot="label-content">Are you a protected veteran? (definitions)</span>'+
   ['Yes','No','Prefer not to answer'].map((o,i)=>`<spl-radio label="${o}" role="radio" aria-checked="false" id="r${i}" tabindex="0"></spl-radio>`).join('')+'</spl-radio-group></main>'}));
  await page.goto(url);
  await page.evaluate(()=>{
   const g=document.querySelector('spl-radio-group').attachShadow({mode:'open'});
   g.innerHTML='<label id="gl"><slot name="label-content"></slot><span>*</span></label><fieldset role="radiogroup" aria-labelledby="gl" aria-required="true"><slot></slot></fieldset>';
   // Like the real component: the host spans the row, and only the ring/label (left) select it (lesson 439).
   for(const r of document.querySelectorAll('spl-radio')){r.style.display='block';r.style.width='900px';r.attachShadow({mode:'open'}).innerHTML=`<span class="hit" style="display:inline-block"><span class="ring" style="display:inline-block;width:16px;height:16px"></span><label>${r.getAttribute('label')}</label></span>`;
    r.shadowRoot.querySelector('.hit').addEventListener('click',()=>{for(const o of document.querySelectorAll('spl-radio'))o.setAttribute('aria-checked',String(o===r));});}
  });
  const radios=(await snapshot(page)).frames.flatMap(f=>f.controls).filter(c=>c.type==='radio');
  assert.equal(radios.length,3,JSON.stringify(radios.map(c=>[c.label,c.optionLabel])));
  const no=radios.find(c=>c.optionLabel==='No');assert.ok(no,JSON.stringify(radios.map(c=>[c.label,c.optionLabel])));
  assert.equal(no.label,'Are you a protected veteran? (definitions)');assert.deepEqual(no.choiceLabels,['Yes','No','Prefer not to answer']);assert.equal(no.value,'false');
  await setCheckedControl(page.mainFrame(),page.locator(`[data-ja-control="${no.id}"]`),true);
  assert.equal(await page.getAttribute('#r1','aria-checked'),'true');
 }finally{await browser.close();}
});
