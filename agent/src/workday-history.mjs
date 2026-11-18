// Reconcile editable Workday drafts against confirmed profile history. Never rely
// on row indexes: Workday allocates new IDs and can rerender after every deletion.
import {createHash} from 'node:crypto';
import {isResumeOnlyExperience} from './workday-experience-layout.mjs';
import {isWorkdayEducationOmitted} from './workday-education-layout.mjs';

const norm = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const dateEquals = (month, year, date) => Boolean(date && Number(month) === Number(date[0]) && String(year) === String(date[1]));
const validDate = date => Array.isArray(date) && date.length === 2 && Number(date[0]) >= 1 && Number(date[0]) <= 12 && /^\d{4}$/.test(String(date[1]));

export function validateHistory(history) {
 if (!Array.isArray(history) || !history.length) throw new Error('Confirmed work history is missing from the profile');
 const identities=new Set();
 for (const entry of history) {
  if (!entry.company || !entry.title || !validDate(entry.from) || !(entry.to === null || validDate(entry.to)))
   throw new Error('Confirmed work history has an incomplete employer, title, or date');
  if (entry.to && Number(entry.to[1])*12+Number(entry.to[0]) < Number(entry.from[1])*12+Number(entry.from[0]))
   throw new Error('Confirmed work-history end date precedes its start date');
  const identity=JSON.stringify([norm(entry.company),norm(entry.title),Number(entry.from[0]),String(entry.from[1])]);
  if(identities.has(identity))throw new Error('Confirmed work history has an ambiguous duplicate employer, title, and start date');
  identities.add(identity);
 }
}
export const historyFingerprint = history => createHash('sha256').update(JSON.stringify(history)).digest('hex');

export function planHistory(rows, history) {
 validateHistory(history);
 const candidates = rows.map(row => {
  const dates = history.map((entry, index) => ({entry,index})).filter(({entry}) => dateEquals(row.fromMonth,row.fromYear,entry.from));
  const exact = dates.filter(({entry}) => norm(row.company) === norm(entry.company));
  const named = history.map((entry,index)=>({entry,index})).filter(({entry})=>norm(row.company)===norm(entry.company)&&norm(row.title)===norm(entry.title));
  const match = exact.length === 1 ? exact[0] : dates.length === 1 ? dates[0] : named.length === 1 ? named[0] : null;
  const score = match ? Number(dateEquals(row.fromMonth,row.fromYear,match.entry.from))*4 + Number(norm(row.company) === norm(match.entry.company))*2 + Number(norm(row.title) === norm(match.entry.title)) : 0;
  return {row,index:match?.index,score};
 }).sort((a,b)=>b.score-a.score);
 const used = new Set(), keep = [], remove = [];
 for (const candidate of candidates) {
  if (candidate.index === undefined || used.has(candidate.index)) remove.push(candidate.row.id);
  else { used.add(candidate.index); keep.push({id:candidate.row.id,index:candidate.index}); }
 }
 const missing=history.map((_,index)=>index).filter(index=>!used.has(index));
 // Some employers require a starter row and provide no Delete button for it.
 // Reuse truly empty rows for missing entries instead of trying to delete them.
 for(const id of [...remove]){
  const row=rows.find(row=>row.id===id);
  const blank=!row.current&&['title','company','location','description','fromMonth','fromYear','toMonth','toYear'].every(key=>!String(row[key]??'').trim());
  if(blank&&missing.length){keep.push({id,index:missing.shift()});remove.splice(remove.indexOf(id),1);}
 }
 return {keep,remove,missing};
}

export function historyProblems(rows, history) {
 const plan = planHistory(rows,history), problems = [];
 if (plan.remove.length) problems.push(`${plan.remove.length} extra or duplicate rows`);
 if (plan.missing.length) problems.push(`${plan.missing.length} missing rows`);
 for (const {id,index} of plan.keep) {
  const row=rows.find(row=>row.id===id), expected=history[index];
  for(const field of ['title','company','fromMonth','fromYear','current']) if(!row.present.includes(field))problems.push(`row ${id}: ${field} control is missing`);
  for (const [field,value] of [['title',expected.title],['company',expected.company],['location',expected.location ?? ''],['description',expected.description ?? '']]) {
   // Abbott canonicalizes saved employer names to uppercase. This preserves
   // employer identity and must not trigger a second save/repair of valid rows.
   const same=field==='company'?norm(row[field])===norm(value):String(row[field]??'').trim()===String(value).trim();
   if (row.present.includes(field) && !same) problems.push(`row ${id}: ${field} differs`);
  }
  if (row.current !== (expected.to === null)) problems.push(`row ${id}: current-employment status differs`);
  if (!dateEquals(row.fromMonth,row.fromYear,expected.from)) problems.push(`row ${id}: start date differs`);
  if (expected.to && !dateEquals(row.toMonth,row.toYear,expected.to)) problems.push(`row ${id}: end date differs`);
 }
 return problems;
}

// A section offered before saving must still pass strict row verification.
export async function savedWorkdayHistoryProblems(page,rows,history,{required=true}={}) {
 if(!required&&await isResumeOnlyExperience(page))return [];
 return historyProblems(rows,history);
}

export async function readWorkdayHistory(page) {
 return page.evaluate(() => {
  const ids=[...new Set([...document.querySelectorAll('input[id^="workExperience-"]')].map(el=>el.id.match(/^workExperience-(\d+)--/)?.[1]).filter(Boolean))];
  return ids.map(id=>{
   const field=suffix=>document.getElementById(`workExperience-${id}--${suffix}`);
   const names={title:'jobTitle',company:'companyName',location:'location',description:'roleDescription',fromMonth:'startDate-dateSectionMonth-input',fromYear:'startDate-dateSectionYear-input',toMonth:'endDate-dateSectionMonth-input',toYear:'endDate-dateSectionYear-input'};
   return {id,...Object.fromEntries(Object.entries(names).map(([name,suffix])=>[name,field(suffix)?.value ?? ''])),current:field('currentlyWorkHere')?.checked ?? false,present:[...Object.keys(names).filter(name=>field(names[name])),...(field('currentlyWorkHere')?['current']:[])]};
  });
 });
}

// Apply Manually also leaves education empty. Create its confirmed number of
// rows before the existing school/degree/discipline driver fills their controls.
export async function ensureWorkdayEducationRows(page,education,{wait=ms=>page.waitForTimeout(ms)}={}) {
 if(await isResumeOnlyExperience(page)||await isWorkdayEducationOmitted(page))return [];
 if(!Array.isArray(education)||!education.length||education.some(e=>!e.school||!e.degree||!e.field||!validDate(e.from)||!validDate(e.to)))throw new Error('Confirmed education is incomplete');
 const read=()=>page.locator('input[id^="education-"]').evaluateAll(inputs=>[...new Set(inputs.map(e=>e.id.match(/^education-(\d+)--/)?.[1]).filter(Boolean))]);
 let ids=await read();
 if(ids.length>education.length)throw new Error('Education draft has extra unconfirmed rows');
 while(ids.length<education.length) {
  const tagged=await page.evaluate(()=>{
   document.querySelector('[data-ja-education-section]')?.removeAttribute('data-ja-education-section');
   const heading=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,[data-automation-id]')].find(e=>e.textContent.trim()==='Education');
   const start=document.querySelector('input[id^="education-"]')??heading;
   for(let el=start?.parentElement;el;el=el.parentElement){
    if(el.querySelector('input[id^="workExperience-"],input[id^="website-"]'))break;
    if(el.querySelectorAll('button[data-automation-id="add-button"]').length===1){el.setAttribute('data-ja-education-section','education');return true;}
   }
   return false;
  });
  if(!tagged)throw new Error('Cannot identify the Education Add control');
  await page.locator('[data-ja-education-section] button[data-automation-id="add-button"]').click();
  let after=ids;
  for(let attempt=0;attempt<30;attempt++){after=await read();if(after.length===ids.length+1)break;await wait(200);}
  if(after.length!==ids.length+1)throw new Error('Education Add did not create exactly one row');
  ids=after;
 }
 return ids;
}

// A degree chosen for an education row must still be the one shown before the step is saved.
// Leidos once parked with row 1 reading "General Education Development Diploma (GED)" after
// a later question pass overwrote the Bachelor's chosen from profile.education. Returns the rows
// (0-based) whose control no longer shows the value chosen for it; rows left unchosen are skipped.
export function educationDegreeMismatches(observed, chosen) {
 return (chosen ?? []).flatMap((want, i) => want && norm(observed?.[i]) !== norm(want) ? [i] : []);
}

// Find the smallest ancestor owning one row or the work-history add button.
// Education, websites and attachments have their own Delete/Add controls.
async function tagHistoryControls(page, rowId) {
 return page.evaluate(rowId=>{
  for(const el of document.querySelectorAll('[data-ja-history-row],[data-ja-history-section]')) {el.removeAttribute('data-ja-history-row');el.removeAttribute('data-ja-history-section');}
  const rowIds = el => [...new Set([...el.querySelectorAll('input[id^="workExperience-"]')].map(input=>input.id.match(/^workExperience-(\d+)--/)?.[1]).filter(Boolean))];
  const start=rowId?document.getElementById(`workExperience-${rowId}--jobTitle`):document.querySelector('input[id^="workExperience-"]');
  if(rowId) {
   for(let el=start?.parentElement;el;el=el.parentElement) {
    const deletes=[...el.querySelectorAll('button')].filter(b=>b.textContent.trim()==='Delete');
    if(rowIds(el).length!==1) break;
    if(deletes.length===1){el.setAttribute('data-ja-history-row',rowId);return true;}
   }
   return false;
  }
  const heading=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,[data-automation-id]')].find(el=>el.textContent.trim()==='Work Experience');
  for(let el=(start??heading)?.parentElement;el;el=el.parentElement) {
   if(el.querySelector('input[id^="education-"],input[id^="website-"]')) break;
   const add=el.querySelectorAll('button[data-automation-id="add-button"]');
   if(add.length===1){el.setAttribute('data-ja-history-section','work');return true;}
  }
  return false;
 },rowId ?? null);
}

async function waitRows(page, before, {added=false,wait}={}) {
 for(let attempt=0;attempt<30;attempt++) {
  const rows=await readWorkdayHistory(page);
  const changed=added?rows.length===before.length+1:rows.length===before.length-1;
  if(changed) return rows;
  await wait(200);
 }
 throw new Error(`Work-history ${added?'Add':'Delete'} did not change exactly one row`);
}

export async function reconcileWorkdayHistory(page, history, {
 wait=ms=>page.waitForTimeout(ms), onEvent=()=>{}, onAudit=()=>{},
}={}) {
 if(await isResumeOnlyExperience(page)){
  await onAudit('not-offered',[]);
  onEvent('My Experience offers resume upload only; work and education rows are not requested');
  return [];
 }
 validateHistory(history);
 let rows=await readWorkdayHistory(page);
 await onAudit('before',rows);
 // Delete one at a time and reread IDs; tenant renderers can renumber surviving rows.
 for(let attempt=0;attempt<100;attempt++) {
  const plan=planHistory(rows,history);
  if(!plan.remove.length) break;
  const id=plan.remove.at(-1);
  if(!await tagHistoryControls(page,id)) throw new Error('Cannot identify the work-history row Delete control');
  await page.locator(`[data-ja-history-row="${id}"]`).getByRole('button',{name:'Delete',exact:true}).click();
  rows=await waitRows(page,rows,{wait});
  onEvent('Removed an extra or duplicate work-history row');
 }
 if(planHistory(rows,history).remove.length) throw new Error('Too many extra work-history rows to reconcile');
 for(const index of planHistory(rows,history).missing) {
  if(!await tagHistoryControls(page)) throw new Error('Cannot identify the Work Experience Add control');
  await page.locator('[data-ja-history-section="work"] button[data-automation-id="add-button"]').click();
  const after=await waitRows(page,rows,{added:true,wait});
  const added=after.filter(row=>!rows.some(old=>old.id===row.id));
  if(added.length!==1) throw new Error('Work-history Add did not produce one identifiable new row');
  await fillHistoryRow(page,added[0].id,history[index],{wait});
  rows=await readWorkdayHistory(page);
  onEvent('Added a missing confirmed work-history entry');
 }
 const plan=planHistory(rows,history);
 await onAudit('reconstructed',rows);
 if(plan.remove.length||plan.missing.length) throw new Error('Work-history reconstruction did not produce exactly the confirmed entries');
 for(const {id,index} of plan.keep) await fillHistoryRow(page,id,history[index],{wait});
 rows=await readWorkdayHistory(page);
 const problems=historyProblems(rows,history);
 if(problems.length) throw new Error(`Work-history verification failed: ${problems.join('; ')}`);
 await onAudit('verified',rows);
 onEvent(`Verified ${rows.length} confirmed work-history entries`);
 return rows;
}

async function fillHistoryRow(page,id,entry,{wait}) {
 const locator=suffix=>page.locator(`[id="workExperience-${id}--${suffix}"]`);
 const set=async(suffix,value,{required=false,date=false}={})=>{
  const input=locator(suffix);
  if(!await input.count()) {if(required)throw new Error(`Work-history row ${id} is missing ${suffix}`);return;}
  const target=String(value ?? '');
  const equal=got=>date?Number(got)===Number(target):got===target;
  if(equal(await input.inputValue()))return;
  await input.scrollIntoViewIfNeeded();
  await input.focus();
  if(date) {
   // Workday's composite date widget redirects programmatic Year focus to
   // Month. ArrowRight selects the actual Year segment; locator typing would
   // refocus the widget and overwrite the month with the year's first digit.
   const targetId=await input.getAttribute('id');
   for(let attempt=0;attempt<3&&await page.evaluate(()=>document.activeElement.id)!==targetId;attempt++)await page.keyboard.press('ArrowRight');
   if(await page.evaluate(()=>document.activeElement.id)!==targetId)throw new Error(`Work-history date segment ${suffix} could not be focused`);
   await page.keyboard.press(process.platform==='darwin'?'Meta+A':'Control+A');
   await page.keyboard.type(target,{delay:20});
   await page.keyboard.press('Tab');
  }else {
   await input.press(process.platform==='darwin'?'Meta+A':'Control+A');
   // Long role descriptions take longer to type than the page's default
   // action timeout (872 chars at 20 ms/key passed 20 s at Generac).
   await input.pressSequentially(target,{delay:20,timeout:30000+target.length*100});
   if(!target)await input.press('Backspace');
   await input.press('Tab');
  }
  await wait(100);
  if(!equal(await input.inputValue())) throw new Error(`Work-history row ${id} did not retain ${suffix}`);
 };
 await set('jobTitle',entry.title,{required:true});
 await set('companyName',entry.company,{required:true});
 await set('location',entry.location);
 const current=locator('currentlyWorkHere');
 if(!await current.count())throw new Error(`Work-history row ${id} has no current-employment control`);
 await current.setChecked(entry.to===null,{force:true});
 await set('startDate-dateSectionYear-input',entry.from[1],{required:true,date:true});
 await set('startDate-dateSectionMonth-input',String(entry.from[0]).padStart(2,'0'),{required:true,date:true});
 if(entry.to) {
  await locator('endDate-dateSectionMonth-input').waitFor({state:'visible'});
  await set('endDate-dateSectionYear-input',entry.to[1],{required:true,date:true});
  await set('endDate-dateSectionMonth-input',String(entry.to[0]).padStart(2,'0'),{required:true,date:true});
 }
 await set('roleDescription',entry.description);
}
