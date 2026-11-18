import {siteThrottled} from './throttle.mjs';
import {stepOf} from './workday.mjs';
export const sameStep = (before, after) => Boolean(after && before.n===after.n && before.name===after.name);
export async function workdayFormReady(page) {
 const next=page.locator('button[data-automation-id="pageFooterNextButton"]');
 return await next.isVisible().catch(()=>false) && await next.isEnabled().catch(()=>false);
}
// Workday can renumber steps after resume parsing, and save transitions can take
// longer than a fixed seven-second sleep. Wait for the actual step or a validation error.
export async function waitForStep(page, before, {attempts=20,leaveName=false,wait=ms=>page.waitForTimeout(ms)}={}) {
 let text='',candidate=null,errorCandidate=null;
 for(let i=0;i<attempts;i++){
  text=await page.locator('body').innerText();
  const step=stepOf(text);
  const errors=await page.locator('[data-automation-id="errorMessage"]:visible, [data-automation-id="errorBanner"]:visible, [data-automation-id="errorMessageText"]:visible, [role="alert"]:visible').allInnerTexts();
  const ready=await workdayFormReady(page);
  if(siteThrottled(text))return text;
  // A previous validation banner stays mounted while Workday saves a corrected
  // answer. Disabled footers and one transient alert are not a settled rejection.
  const error=errors.filter(e=>e&&!/successfully|uploaded|saved/i.test(e)).join('\n');
  if(ready&&error){
   const key=JSON.stringify([step?.n,step?.name,error]);
   if(errorCandidate===key)return text;
   errorCandidate=key;
  }else errorCandidate=null;
  if(step&&!sameStep(before,step)&&(!leaveName||step.name!==before.name)&&ready){
   if(sameStep(candidate??{},step))return text;
   candidate=step;
  }else candidate=null;
  await wait(1000);
 }
 return text;
}

// Some tenants ignore a forced Back click during the footer rerender. Wait for
// the settled form, click normally, then try its DOM click once if it stayed put.
export async function goBackWorkday(page,before,{wait=ms=>page.waitForTimeout(ms)}={}) {
 const back=page.locator('button[data-automation-id="pageFooterBackButton"]');
 for(let attempt=0;attempt<2;attempt++) {
  if(!await back.isVisible().catch(()=>false)||!await back.isEnabled().catch(()=>false))throw new Error('Workday Back control is not ready');
  await back.scrollIntoViewIfNeeded();
  if(!attempt)await back.click();else await back.evaluate(el=>el.click());
  const text=await waitForStep(page,before,{wait});
  if(siteThrottled(text)||!sameStep(before,stepOf(text)))return text;
 }
 throw new Error('Workday Back did not reach the previous step after two attempts');
}
