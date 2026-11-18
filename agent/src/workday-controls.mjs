import {timed,controlName} from './slow-step.mjs';
import {workdayOptions,scanWorkdayOptions,chooseWorkdayPrompt} from './workday-prompt.mjs';
import {pickOption} from './workday.mjs';

// Skills are exact terms extracted from the selected original resume. Search
// the employer's taxonomy and retain only offered, verified selections.
// The profile's resumeSkills are trusted only while the resume file hash matches. When the file
// changed (Daimler Truck 15803: required Skills left to the approval card), fall back to the
// Technical line of the resume actually sent for this application.
export function sentResumeSkills(resume){
 const lines=(resume?.sections??[]).filter(s=>s?.kind==='skills').flatMap(s=>s.lines??[]);
 const technical=lines.find(l=>/^technical$/i.test(l?.label??''));
 return [...new Set(String(technical?.text??'').split(',').map(t=>t.trim()).filter(t=>t&&!/[()]/.test(t)))];
}

export async function fillWorkdaySkills(page,skills=[]) {
 const input=page.locator('[data-automation-id="formField-skills"] input[data-uxi-widget-type="selectinput"]:visible');
 if(await input.count()!==1||!skills.length)return [];
 const field=page.locator('[data-automation-id="formField-skills"]');
 if(await field.locator('[data-automation-id="selectedItem"]').count())return [];
 const saved=[];
 for(const skill of skills.slice(0,8)){
  const selected=await chooseWorkdayPrompt(page,input,offered=>pickOption(offered,[skill]),{search:skill});
  if(selected)saved.push(selected);
  if(saved.length>=3)break;
 }
 return saved;
}

// Only the signature date is derived from today's date. Birth and employment
// dates remain profile facts and are handled by their own controls.
export async function fillWorkdaySignedDate(page,{now=new Date(),type=async(input,value)=>{
 await input.focus();
 await page.keyboard.press(process.platform==='darwin'?'Meta+A':'Control+A');
 await page.keyboard.type(value,{delay:40});
 await page.keyboard.press('Tab');
}}={}) {
 const field=page.locator('[data-automation-id="formField-dateSignedOn"]:visible');
 if(!await field.count())return false;
 const values={Month:now.getMonth()+1,Day:now.getDate(),Year:now.getFullYear()};
 for(const [part,value]of Object.entries(values)){
  const input=field.locator(`input[data-automation-id="dateSection${part}-input"]`);
  if(Number(await input.inputValue())!==value){
   // Focusing the tiny input alone does not update Workday's active segment.
   // Activate its visible display first or later digits go to the wrong part.
   const display=field.locator(`[data-automation-id="dateSection${part}-display"]`);
   if(await display.count())await display.click();
   await type(input,String(value).padStart(part==='Year'?4:2,'0'));
  }
 }
 for(const [part,value]of Object.entries(values))if(Number(await field.locator(`input[data-automation-id="dateSection${part}-input"]`).inputValue())!==value)throw new Error('Workday did not retain the signature date');
 return true;
}

// A questionnaire date ("5a. Expected degree completion date." at Leidos, shown after "currently
// working towards a degree" is Yes) is his confirmed graduation date. Other dates are not guessed.
export function workdayDateAnswer(label, answers = {}, approvedAnswers = []) {
 const q = String(label).replace(/\*\s*$/, '').trim();
 // A date he already approved for this exact question on the card is typed before any rule
 // (Blue Origin 12799: "What is your graduation date?" was approved as 06/15/2027 yet re-flagged).
 const approved = approvedAnswers.find(a => typeof a?.question === 'string' && a.question.replace(/\*\s*$/, '').trim().toLowerCase() === q.toLowerCase());
 const text = String(approved?.answer ?? '').trim();
 const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/), iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
 if (us) return {key:'approved', Month:Number(us[1]), Day:Number(us[2]), Year:Number(us[3])};
 if (iso) return {key:'approved', Month:Number(iso[2]), Day:Number(iso[3]), Year:Number(iso[1])};
 const completionDate=/^(?:\d+[a-z]?\.\s*)?(?:What is your )?(?:(?:expected|anticipated|projected) (?:degree |date of )?(?:completion|graduation)|graduation)(?: date)?\s*[.?:]?$/i.test(q);
 const degreeProgram=/^(?:\d+[a-z]?\.\s*)?When do you expect to complete your (?:current )?degree program\s*[? .]?$/i.test(q);
 // His confirmed earliest start date (YYYY-MM-DD), e.g. Cisco 12281's "What is the earliest date you could start?".
 const startDate=/^(?:\d+[a-z]?\.\s*)?(?:what is (?:the|your) )?(?:earliest (?:possible )?(?:date you (?:could|can) start|start date|available start date|date (?:of )?availability)|when (?:could|can|are) you (?:available to )?start)\s*[.?:]?$/i.test(q);
 if (startDate) {
  const s = String(answers.earliestStartDate ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return s ? {key:'earliestStartDate', Month:Number(s[2]), Day:Number(s[3]), Year:Number(s[1])} : null;
 }
 if (!completionDate && !degreeProgram) return null;
 const m = String(answers.graduationDate ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
 return m ? {key:'graduationDate', Month:Number(m[1]), Day:Number(m[2]), Year:Number(m[3])} : null;
}

// Fill a Workday MM/DD/YYYY (or MM/YYYY) segmented date and confirm every segment stuck.
export async function fillWorkdayDate(page, field, values, {type=async(input,value)=>{
 await input.focus();
 await page.keyboard.press(process.platform==='darwin'?'Meta+A':'Control+A');
 await page.keyboard.type(value,{delay:40});
 await page.keyboard.press('Tab');
}}={}) {
 const parts = ['Month','Day','Year'];
 for (const part of parts) {
  const input = field.locator(`input[data-automation-id="dateSection${part}-input"]`);
  if (!await input.count() || values[part] == null) continue;
  if (Number(await input.inputValue()) === values[part]) continue;
  const display = field.locator(`[data-automation-id="dateSection${part}-display"]`);
  if (await display.count()) await display.click();
  await type(input, String(values[part]).padStart(part === 'Year' ? 4 : 2, '0'));
 }
 for (const part of parts) {
  const input = field.locator(`input[data-automation-id="dateSection${part}-input"]`);
  if (await input.count() && values[part] != null && Number(await input.inputValue()) !== values[part]) return false;
 }
 return true;
}

export async function readWorkdayFields(page) {
 return page.evaluate(()=>[...document.querySelectorAll('[data-automation-id^="formField-"]')].filter(c=>c.getClientRects().length).map((c,index)=>{
  const visible=e=>e&&e.getClientRects().length&&!e.disabled&&e.getAttribute('aria-hidden')!=='true';
  const find=selector=>[...c.querySelectorAll(selector)].find(visible);
  const label=(c.querySelector('label,legend')?.textContent||c.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim();
  const required=/\*\s*$/.test(label)||!!c.querySelector('[aria-required="true"],[required]');
  const button=find('button[aria-haspopup="listbox"],button[role="combobox"],button[data-automation-id="selectInput"]');
  const ta=find('textarea'),radios=[...c.querySelectorAll('input[type="radio"]')],cb=c.querySelector('input[type="checkbox"]');
  const disabilityChoices=c.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
  const choicesGroup=disabilityChoices??c.querySelector('[data-automation-id="ethnicityMulti-CheckboxGroup"]')??(c.querySelectorAll('input[type="checkbox"]').length>1?c:null);
  const prompt=find('[data-automation-id="multiselectInputContainer"] input,input[data-uxi-widget-type="selectinput"],input[role="combobox"]');
  const text=find('input[type="text"],input[type="url"]');
  const id=e=>e.id||(e.id=`jobagent-workday-control-${index}`);
  if(button)return {kind:'listbox',id:id(button),label,required,value:/^Select One\b/i.test(button.innerText.trim())?'':button.innerText.trim()};
  if(ta)return {kind:'textarea',id:id(ta),label,required,value:ta.value,...(ta.getAttribute('aria-invalid')==='true'?{invalid:true}:{})};
  if(choicesGroup){
   const choices=[...choicesGroup.querySelectorAll('input[type="checkbox"]')];
   return {kind:'choice-checkbox',id:id(choicesGroup),label:disabilityChoices?`Disability status: ${label}`:label,required,options:choices.map(e=>e.labels?.[0]?.textContent.trim()||''),optionIds:choices.map(id),value:choices.filter(e=>e.checked).map(e=>e.labels?.[0]?.textContent.trim()||'').join('; ')};
  }
  if(radios.length)return {kind:'radio',id:radios[0].name,label,required,options:radios.map(r=>r.labels?.[0]?.innerText.trim()||r.value),value:radios.find(r=>r.checked)?.labels?.[0]?.innerText.trim()||''};
  if(prompt)return {kind:'prompt',id:id(prompt),label,required,value:[...c.querySelectorAll('[data-automation-id="selectedItem"]')].map(e=>e.innerText.trim()).join('; ')};
  if(cb)return {kind:'checkbox',id:id(cb),label:label||cb.labels?.[0]?.innerText.trim()||'',required,value:cb.checked?'checked':''};
  if(text)return {kind:'text',id:id(text),label,required,value:text.value,...(text.getAttribute('aria-invalid')==='true'?{invalid:true}:{})};
  const date=c.querySelector('[data-automation-id="dateInputWrapper"]');
  if(date){
   const part=name=>c.querySelector(`input[data-automation-id="dateSection${name}-input"]`)?.value||'';
   const value=['Month','Day','Year'].filter(n=>c.querySelector(`input[data-automation-id="dateSection${n}-input"]`)).map(part);
   return {kind:'date',id:id(date),label,required,value:value.every(Boolean)?value.join('/'):''};
  }
  return null;
 }).filter(Boolean));
}

// Workday can reconcile its controlled checkboxes after the click returns.
// Require a stable, exact group value rather than trusting the click or failing
// on a transient render. A discarded choice must still stop the application.
export async function verifyWorkdayCheckboxChoice(page,fieldId,want,{timeout=2500,interval=150}={}) {
 const deadline=Date.now()+timeout;
 let matches=0;
 do {
  const saved=(await readWorkdayFields(page)).find(field=>field.id===fieldId);
  matches=saved?.kind==='choice-checkbox'&&saved.value===want?matches+1:0;
  if(matches>=2)return;
  await page.waitForTimeout(interval);
 } while(Date.now()<deadline);
 throw new Error('Workday did not retain the checkbox choice selection');
}

export async function selectWorkdayListbox(page,button,candidates,options={}) {
 const name=controlName(button);
 return timed(async()=>`listbox ${await name()}`,()=>selectListbox(page,button,candidates,options));
}
async function selectListbox(page,button,candidates,{wait=ms=>page.waitForTimeout(ms)}={}) {
 await page.keyboard.press('Escape');
 // Older tenants omit ownership attributes. Their selected option id still
 // equals the owning button's value, so close that toggle explicitly.
 const activeIds=await page.locator('[role="listbox"]:visible').evaluateAll(menus=>menus.map(m=>m.getAttribute('aria-activedescendant')).filter(Boolean));
 for(const active of activeIds){
  const owner=page.locator(`button[aria-haspopup="listbox"][value=${JSON.stringify(active)}]:visible`);
  if(await owner.count()===1)await owner.evaluate(el=>el.click());
 }
 // Some tenants leave the old dropdown open after Escape. Close its actual
 // toggle before opening another field; mounted menus must not leak choices.
 const open=page.locator('button[aria-expanded="true"][aria-haspopup="listbox"]:visible,button[aria-expanded="true"][role="combobox"]:visible');
 for(let i=0;i<5&&await open.count();i++)await open.first().click({force:true});
 // NXP's buttons omit aria-expanded, and Escape closes their portal
 // asynchronously. Dismiss outside the form and let the old menu unmount.
 await page.mouse.click(1,1);
 await wait(200);
 await button.scrollIntoViewIfNeeded();
 await button.evaluate(el=>el.click());
 await wait(200);
 const getItems=()=>workdayOptions(page,button,'[role="option"]:visible');
 let offered=[];
 try{
  for(let i=0;i<15;i++){
   try{offered=await scanWorkdayOptions(page,getItems,opts=>pickOption(opts,candidates));}
   catch(error){
    if(!/menu ownership is ambiguous/.test(error.message)||i===14)throw error;
    await wait(200);continue;
   }
   if(offered.length)break;
   if(i===4||i===9){await button.evaluate(el=>el.click());}
   await wait(200);
  }
  if(!offered.length)return {ok:false,offered,technical:true,note:'Workday dropdown did not open after three attempts'};
  const want=pickOption(offered,candidates);
  if(!want)return {ok:false,offered};
  // hasText tests a regex against raw textContent, where ASML's long export-control option
  // keeps a double space and a line break that innerText had collapsed; match whitespace runs
  // loosely and fall back to the scanned position so a found option is never left unclicked.
  const exact=new RegExp(`^\\s*${want.trim().split(/\\s+/).map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s+')}\\s*$`);
  const items=await getItems();
  const byText=items.filter({hasText:exact});
  const target=await byText.count()?byText.first():items.nth(offered.indexOf(want));
  await target.click({timeout:5000});
  await page.keyboard.press('Escape');
  for(let i=0;i<10;i++){
   const value=(await button.innerText()).trim();
   if(value.toLowerCase()===want.toLowerCase())return {ok:true,value:want};
   await wait(150);
  }
  return {ok:false,offered,technical:true,note:'Workday did not retain the selected option'};
 }finally{await page.keyboard.press('Escape');}
}

// Read a closed listbox's choices without choosing one: open, scan, close. An empty list means
// the menu never opened; ambiguous ownership is reported as empty too, never thrown here.
export async function readWorkdayListboxOptions(page,button,options={}) {
 if(!await button.count().catch(()=>0))return [];
 try{return (await selectWorkdayListbox(page,button,[],options)).offered??[];}
 catch{return [];}
}
