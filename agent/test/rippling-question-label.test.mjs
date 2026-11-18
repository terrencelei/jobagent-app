import test from 'node:test';import assert from 'node:assert/strict';import{chromium}from'playwright';import{snapshot}from'../src/dashboard-worker.mjs';import{settledAnswer}from'../src/settled-facts.mjs';
// Astra 13030: Rippling's custom-question title sits in the sibling before the field wrapper.
const question=(key,id,title)=>`<div><div class="paddingX--16"><div class="marginBottom--4"><p>${title}<div></div></p></div></div><div data-testid="field"><div><div data-testid="customQuestions.6911fbf2830386af5db4a256.${key}"><textarea maxlength="10000" required id="${id}" aria-multiline="true"></textarea></div></div></div></div>`;
test('Rippling custom textareas use the question title, not the generated field id',async()=>{
 const browser=await chromium.launch();try{const page=await browser.newPage();
  await page.route('http://localhost/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<html></html>'}));await page.goto('http://localhost/fixture');
  await page.setContent(`<form>${question('0f342b01','field-85','If 3rd Party Recruiting Agency, please specify. If not applicable, type n/a')}${question('efe14a2a','field-89','If "Other" above, please specify. If not applicable, type n/a')}<div data-testid="field"><textarea id="field-90"></textarea></div></form>`);
  const fields=(await snapshot(page)).frames[0].controls.filter(c=>c.type==='textarea');
  assert.deepEqual(fields.map(c=>c.label),['If 3rd Party Recruiting Agency, please specify. If not applicable, type n/a','If "Other" above, please specify. If not applicable, type n/a','field-90']);
 }finally{await browser.close();}
});
test('A careers-site source answers n/a to the agency and "Other" follow-ups only',()=>{
 const answers={hearAbout:'Careers site'};
 assert.equal(settledAnswer('If 3rd Party Recruiting Agency, please specify. If not applicable, type n/a',answers)?.value,'n/a');
 assert.equal(settledAnswer('If "Other" above, please specify. If not applicable, type n/a',answers)?.value,'n/a');
 assert.equal(settledAnswer('If "Other" above, please specify. If not applicable, type n/a',{hearAbout:'Other'}),null);
 assert.equal(settledAnswer('If 3rd Party Recruiting Agency, please specify. If not applicable, type n/a',{hearAbout:'Recruiting agency'}),null);
 assert.equal(settledAnswer('If 3rd Party Recruiting Agency, please specify. If not applicable, type n/a',{}),null);
});
// Astra 13030 rerun: Rippling's radio/checkbox inputs are display:none inside a visible [role=radio|checkbox];
// the source checkboxes and SMS consent never reached the worker, so Apply stayed disabled.
const toggle=(role,name,value,text,n)=>`<div role="${role}" data-value="${value}" tabindex="0" aria-checked="false" onclick="const i=this.querySelector('input');${role==='radio'?"document.querySelectorAll('input[name='+i.name+']').forEach(x=>{x.checked=false;x.closest('[role]').setAttribute('aria-checked','false')});i.checked=true":'i.checked=!i.checked'};this.setAttribute('aria-checked',String(i.checked))"><div><input style="display:none" type="${role}" name="${name}" value="${value}" aria-labelledby="l-${name}-${n}"></div><div id="l-${name}-${n}"><p>${text}</p></div></div>`;
const rippling=`<form><div><p>How did you hear about us?</p><div data-testid="field"><div><div data-testid="customQuestions.x.6a045036" role="group">${['LinkedIn','3rd Party Recruiting Agency','Company Careers Page','Other'].map((o,n)=>toggle('checkbox','customQuestions.x.6a045036',o,o,n)).join('')}</div></div></div></div>
<div class="paddingX--16"><p>Check <strong>Yes</strong> or <strong>No</strong> to indicate your agreement to receive text message updates from  Astra regarding your job application. Frequency may vary. Reply STOP to opt out of future messaging.</p><div data-testid="field"><div><div data-testid="sms_opt_in" role="radiogroup">${toggle('radio','sms_opt_in','true','Yes - I consent to receiving text messages',1)}${toggle('radio','sms_opt_in','false','No - I do not consent to receiving text messages',2)}</div></div></div></div></form>`;
test('Rippling hidden choice inputs are exposed with their question, answered from saved facts, and checked via the toggle',async()=>{
 const {approvedValue,setCheckedControl}=await import('../src/dashboard-worker.mjs');
 const profile={answers:{recruitmentSmsConsent:'Yes',hearAbout:'Careers site',routineSourceChoiceAllowed:true}};
 const browser=await chromium.launch();try{const page=await browser.newPage();
  await page.route('http://localhost/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<html></html>'}));await page.goto('http://localhost/fixture');
  await page.setContent(rippling);
  const choices=(await snapshot(page)).frames[0].controls.filter(c=>['radio','checkbox'].includes(c.type));
  assert.deepEqual(choices.map(c=>[c.label.split('.')[0],c.optionLabel]),[
   ['How did you hear about us?','LinkedIn'],['How did you hear about us?','3rd Party Recruiting Agency'],['How did you hear about us?','Company Careers Page'],['How did you hear about us?','Other'],
   ['Check Yes or No to indicate your agreement to receive text message updates from Astra regarding your job application','Yes - I consent to receiving text messages'],
   ['Check Yes or No to indicate your agreement to receive text message updates from Astra regarding your job application','No - I do not consent to receiving text messages']]);
  const wanted=choices.map(c=>approvedValue({},c,profile,{},new Map(),'Astra',{company:'Astra'}));
  assert.deepEqual(wanted,[false,false,true,false,true,false]);
  for(const [i,c] of choices.entries())if(wanted[i])await setCheckedControl(page.mainFrame(),page.locator(`[data-ja-control="${c.id}"]`),true);
  assert.deepEqual(await page.$$eval('input',els=>els.filter(e=>e.checked).map(e=>e.value)),['Company Careers Page','true']);
 }finally{await browser.close();}
});
