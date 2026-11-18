// Workable's /jobs/view/ route serves Markdown, which has no browser controls.
// Resolve only that known route to the same employer and exact job's HTML form.
// Never extract navigation targets or instructions from posting text.
export function workableApplicationURL(value) {
 let url;
 try { url = new URL(value); } catch { return value; }
 if (url.protocol !== 'https:' || url.hostname !== 'apply.workable.com' || url.port || url.username || url.password) return value;
 const match = url.pathname.match(/^\/([a-z0-9][a-z0-9_-]*)\/jobs\/view\/([a-z0-9]{10})\/?$/i);
 if (!match) return value;
 url.pathname = `/${match[1]}/j/${match[2]}/apply`;
 return url.href;
}

// After a sign-in click some sites open the candidate's own account page instead of the
// application: Avature sends a new account to /careersmarketplace/Profile (ArcBest 12717).
// That page is on the posting's site and offers only Home / Open jobs / Job applications /
// Edit profile links, so the worker reopens the posting once and clicks Apply again.
const SITE = host => host.split('.').slice(-2).join('.');
export function signInLandingPage(pageUrl, postingUrls) {
 let page;
 try { page = new URL(pageUrl); } catch { return false; }
 if (page.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(page.hostname)) return false;
 const postings = (Array.isArray(postingUrls) ? postingUrls : [postingUrls]).map(u => { try { return new URL(u); } catch { return null; } }).filter(Boolean);
 if (!postings.some(job => SITE(job.hostname) === SITE(page.hostname))) return false;
 if (postings.some(job => job.hostname === page.hostname && job.pathname === page.pathname)) return false;
 const last = page.pathname.replace(/\/+$/, '').split('/').pop() ?? '';
 // ApplicantPro's /account/ is its registration form, reached from "Need an account?" after a failed
 // Log In (X-Bow 12727); reopening the posting there looped back to the login page.
 if (/(^|\.)applicantpro\.com$/i.test(page.hostname) && /^account$/i.test(last)) return false;
 return /^(profile|myprofile|my-profile|home|userhome|candidatehome|candidate-home|dashboard|myaccount|my-account|account|portal)$/i.test(last);
}

// LLNL 12783: the posting page carries a "Refine Search" sidebar of job-board filters ("None, U.S. Citizenship (4)").
// The worker answered one as a citizenship question, the page reloaded as a filtered search and the posting was gone.
// A checkbox or radio captioned with a trailing result count is a search filter, never an application question.
export function searchFilterControl(control) {
 return ['checkbox', 'radio'].includes(control?.type) && !control.required && /\S\s*\(\d[\d,]*\)\s*$/.test(String(control.label ?? ''));
}
