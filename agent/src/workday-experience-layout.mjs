// Absence of controls alone is not evidence that an employer omits history.
// Accept only a loaded My Experience form with a successfully uploaded resume.
import {siteThrottled} from './throttle.mjs';

export async function isResumeOnlyExperience(page) {
 const evidence=await page.evaluate(()=>{
  const visible=el=>Boolean(el?.getClientRects().length)&&getComputedStyle(el).visibility!=='hidden';
  const headings=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,[data-automation-id]')];
  const heading=text=>headings.some(el=>visible(el)&&el.textContent.trim()===text);
  const next=document.querySelector('button[data-automation-id="pageFooterNextButton"]');
  return {
   text:document.body.innerText,
   ready:heading('My Experience')&&(heading('Resume/CV')||heading('Resume/CV Only'))&&visible(next)&&!next.disabled&&next.getAttribute('aria-disabled')!=='true'
    &&[...document.querySelectorAll('[data-automation-id="file-upload-successful"]')].some(visible)
    &&![...document.querySelectorAll('[aria-busy="true"],[role="progressbar"],[data-automation-id="errorBanner"],[data-automation-id="errorMessage"]')].some(visible),
   history:heading('Work Experience')||heading('Education')
    ||Boolean(document.querySelector('[id^="workExperience-"],[id^="education-"],[data-fkit-id^="workExperience"],[data-fkit-id^="education"]')),
  };
 });
 return evidence.ready&&!evidence.history&&!siteThrottled(evidence.text);
}
