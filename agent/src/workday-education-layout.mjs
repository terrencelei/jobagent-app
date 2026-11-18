import {siteThrottled} from './throttle.mjs';

// Some tenants request work history but omit education entirely. Require positive
// evidence of a loaded, usable experience form before treating absence as intent.
export async function isWorkdayEducationOmitted(page) {
 const evidence=await page.evaluate(()=>{
  const visible=el=>Boolean(el?.getClientRects().length)&&getComputedStyle(el).visibility!=='hidden';
  const headings=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,[data-automation-id]')];
  const heading=text=>headings.some(el=>visible(el)&&el.textContent.trim()===text);
  const next=document.querySelector('button[data-automation-id="pageFooterNextButton"]');
  return {
   text:document.body.innerText,
   ready:heading('My Experience')&&heading('Work Experience')
    &&[...document.querySelectorAll('input[id^="workExperience-"]')].some(visible)
    &&visible(next)&&!next.disabled&&next.getAttribute('aria-disabled')!=='true'
    &&[...document.querySelectorAll('[data-automation-id="file-upload-successful"]')].some(visible)
    &&![...document.querySelectorAll('[aria-busy="true"],[role="progressbar"],[data-automation-id="errorBanner"],[data-automation-id="errorMessage"]')].some(visible),
   education:headings.some(el=>el.textContent.trim()==='Education')
    ||Boolean(document.querySelector('[id^="education-"],[data-fkit-id^="education"]')),
  };
 });
 return evidence.ready&&!evidence.education&&!siteThrottled(evidence.text);
}
