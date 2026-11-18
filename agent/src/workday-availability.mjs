import {openSignInForm} from './workday.mjs';

// Workday returns HTTP 200 even for a removed posting. Check the rendered
// employer message before authentication, including after an async form switch.
export async function assertWorkdayPostingAvailable(page) {
 // Responsive headings can split the employer's missing-page sentence across
 // DOM lines. Match the rendered words independently of layout whitespace.
 const text=(await page.locator('body').innerText()).replace(/\s+/g,' ').trim();
 if (/\bWorkday is currently unavailable\b/i.test(text)) {
  throw new Error('Site unavailable: Workday reports a temporary service interruption. Cooling down before another try.');
 }
 if (/page you are looking for doesn.t exist|job (?:is )?no longer available/i.test(text)) {
  throw new Error('Posting unavailable: employer reports that this job page no longer exists');
 }
}

export async function openAvailableWorkdaySignInForm(page,options) {
 await assertWorkdayPostingAvailable(page);
 const ready=await openSignInForm(page,options);
 await assertWorkdayPostingAvailable(page);
 return ready;
}
