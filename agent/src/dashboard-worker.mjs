import {alreadyAppliedNotice} from './already-applied.mjs';
import {acquireLock} from './worker-lock.mjs';
import {monitorGreenhouseUploads} from './greenhouse-upload.mjs';
import {requiredContacts,declineOptionalCookies} from './required-contacts.mjs';
import {FORM_AGENT_INSTRUCTIONS as INSTRUCTIONS,applicationDecisionContext} from './application-decision-context.mjs';
import {leanStep,LEAN_CLAUDE_ARGS,LEAN_CODEX_ARGS} from './step-mode.mjs';
import {routineQuestionNeedsReview} from './routine-application-policy.mjs';
import {workableApplicationURL,signInLandingPage,searchFilterControl} from './posting-navigation.mjs';
import {cliTimeoutProgress} from './cli-timeout-progress.mjs';
import {execCodexWithServiceRetry,execWithStallRetry} from './cli-service-retry.mjs';
import {keepAwake} from './keep-awake.mjs';
import {gustoControlLabels} from './gusto-control-labels.mjs';
import {waitForEmbeddedApplication} from './embedded-application-readiness.mjs';
import {CODEX_CAPABILITIES,CLAUDE_CAPABILITIES,CAPABILITY_CONTEXT,agentPath} from './agent-capabilities.mjs';
import {regionalLocationCorrection} from './regional-controls.mjs';
import {isLeverLocation,pickLeverLocation} from './lever-location.mjs';
import {safeSectionExpand} from './section-controls.mjs';
import {annotateHistoryControls,confirmedHistoryLocation,safeHistoryAdd} from './history-controls.mjs';
import {annotateCurrentPositions,confirmedCurrentPosition,historyCurrentFacts} from './history-current-position.mjs';
import {currentEmployerAnswer,currentEmployerCorrection,currentEmployerFacts,sponsorAsEmployerProblems} from './current-employer.mjs';
import {regionalProfile,regionalAnswer} from './location-policy.mjs';
import {paycorPostingUnavailable} from './paycor-availability.mjs';
import {trinetPostingUnavailable} from './trinet-availability.mjs';
import {amazonPostingClosedPublicly,amazonPostingUnavailable,applePostingUnavailable,llnlPostingUnavailable,metaPostingUnavailable,oraclePostingUnavailable,successFactorsPostingUnavailable,smartRecruitersPostingUnavailable,greenhousePostingUnavailable,ibmPostingUnavailable,zipRecruiterPostingUnavailable,zipRecruiterSearchRedirect} from './posting-availability.mjs';
import {monitorLeverSubmission,leverSubmissionOutcome,waitForManualLeverRetry,leverChallengePending} from './lever-submission.mjs';
import {visibleApplicationChallenge} from './application-challenge.mjs';
import {loadCaptchaConfig,completeCaptcha} from './captcha-solver.mjs';
import {scriptedFormAction} from './form-automation.mjs';
import {resolveChallengeFree,captchaPending,captchaCheckboxVisible,captchaLikely,captchaSeen,captchaManualFirst,recordCaptcha,notifyMac,waitForPageAdvance} from './captcha-handoff.mjs';
import {ashbyApplicationPage,waitForAshbyForm,ashbyJobNotFound} from './ashby-readiness.mjs';
import { normalizeApplicationLink } from './application-links.mjs';
import {nativeInputValue} from './native-input-value.mjs';
import {textDateInputValue,monthYearPair,fillMonthYear} from './text-date-input.mjs';
import {decisionAnswerBank} from './decision-answer-bank.mjs';
import {rebindControl,hasNewFormControls,hasVerificationControls} from './control-identity.mjs';
import {readFile,writeFile,rename,mkdir,readdir,open,unlink,mkdtemp,rm,copyFile} from 'node:fs/promises';
import {dirname,resolve,join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {validatePublicURL} from './public-url.mjs';
import {applicationChromium} from './captcha-vendor.mjs';
import {guardDialogs} from './dialog-guard.mjs';
import {requiredRecruitingConsent,inFormConsentToTick,optInText,answerChoiceText} from './data-consent.mjs';
import {detachedControlError} from './detached-control.mjs';
import {notApplication} from './not-application.mjs';
import {hintsFor,platformKey,scoreHints,outcomeDelta,HINTS_PATH} from './site-hints.mjs';
const chromium=await applicationChromium();  // the supplied package's stealth launch
import {US_STATE_NAMES} from './profile-facts.mjs';
import {applicationUserAgent,siteNavigationFailure,closedTabFailure} from './browser-identity.mjs';
// Every context, headless or visible, presents the Chrome user agent (browser-identity.mjs).
async function applicationContext(browser,extra={}){const probe=await browser.newContext();let ua;try{ua=await (await probe.newPage()).evaluate(()=>navigator.userAgent);}finally{await probe.close();}const userAgent=applicationUserAgent(ua);return browser.newContext({viewport:{width:1280,height:900},...(userAgent&&userAgent!==ua?{userAgent}:{}),...extra});}
import {loadAnswers,questionId,saveBank,loadBank,recordApprovals,SHARED,sharedEligible,learnApprovals,placeholderAnswer,lookup as lookupAnswer} from './companies.mjs';
import {capExceeded} from './core.mjs';
import {capAllowed,detectCap} from './application-caps.mjs';
import {PREFERENCE_FACTS,preferenceAnswer,salaryExpectation,confirmedFactIsNewer,internshipCompensationQuestion} from './applicant-preferences.mjs';
import {equivalentOption,settledAnswer} from './settled-facts.mjs';
import {startLiveView} from './live-view.mjs';
import {launchHumanChrome,launchRelayChrome,keepHidden,freePort} from './human-chrome.mjs';
import {drivePrompt,runDirectSession,approvedForSession,directAllowed,directPageKey,openQuestions,stuckBySteps,rescueKey} from './direct-control.mjs';
import {humanClick,humanBrowse,installHumanTyping,installTrustedInput} from './human-input.mjs';
import {placeOption} from './place-match.mjs';
import {leverRetryOnce,watchLeverHandoff,lastResponseRefused} from './lever-retry.mjs';
import {withAgyFallback,decideAgy,helperAgent} from './model-fallback.mjs';
import {siteThrottled,siteAccessFailure,throttledReason,throttlePauseMs} from './throttle.mjs';
import {setting} from './settings.mjs';
import {accountFor,passwordAllowedOn,termsCheckbox,authButton,authEntry,ssoButton,liveEmailInput,HIRING_PLATFORMS} from './accounts.mjs';
import {fetchApplicationReceipt} from './application-receipt.mjs';
import {waitForWebpageAcceptance,collectWebpageRejection,confirmationPageText} from './application-acceptance.mjs';
import {shouldApproveOptionalWriting} from './application-writing-policy.mjs';
import {completeApplicationVerification} from './application-verification.mjs';
import {mapConfirmedOption} from './option-mapping.mjs';
import {inactiveLocationExplanation} from './conditional-fields.mjs';
import {completeSigninVerification} from './signin-verification.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// A cookie bar over the page (IBM's TrustArc #consent_blackbar, Siemens' Usercentrics #usercentrics-root modal)
// can intercept a click without being part of the form. Click the control itself then, without accepting
// any cookies (IBM 11946, Siemens 6654). Any other overlay stays an error.
const CONSENT_OVERLAY=/consent|cookie|truste|onetrust|usercentrics|cookiebot|didomi|gdpr/i;
export const consentOverlayBlocked=error=>/intercepts pointer events/i.test(error?.message??'')&&CONSENT_OVERLAY.test(error.message);
export async function clickPastCookieBanner(locator,{timeout=10000,...options}={}){
 try{await locator.click({timeout,...options});}
 catch(error){
  if(!consentOverlayBlocked(error))throw error;
  await locator.evaluate(el=>el.click());
 }
}
// A sign-in POST can take longer than the 10 s action timeout to answer (SuccessFactors, Hyundai 11914):
// the click lands, then Playwright's wait for the navigation it scheduled throws. Don't wait inside the click.
// Siemens' Log in button (Avature, 6654) sat under a Usercentrics cookie modal: the same DOM-click fallback applies.
export async function clickAuthControl(page,locator,{loadTimeout=30000}={}){
 const press=async click=>{
  const navigation=page.waitForRequest(r=>r.isNavigationRequest()&&r.frame()===page.mainFrame(),{timeout:2000}).catch(()=>null);
  await click();
  if(await navigation)await page.waitForEvent('domcontentloaded',{timeout:loadTimeout}).catch(()=>{});
 };
 try{await press(()=>locator.click({noWaitAfter:true}));}
 catch(error){
  if(!consentOverlayBlocked(error))throw error;
  await press(()=>locator.evaluate(el=>el.click()));
 }
}
// Phone inputs reformat as typed ("555-010-0147" shows "(555) 010-0147" on Oracle); the digits are what was kept.
// A fill that would only rewrite a value the control already holds (X-Bow 12727: the model refilled the ZIP seven
// times, then spent its 180 s step investigating) is sent back so the step moves on.
// Controls of the submit control's own <form> (plus every control outside any form, and all other frames' forms
// when the submit control is not in a form). Other forms on the page are not part of this submission.
export function submitFormOnly(snap,submit,submitFrameIndex){
 if(!submit?.inForm||!Number.isInteger(submit.formIndex))return snap;
 return {...snap,frames:(snap.frames??[]).map(f=>({...f,controls:(f.controls??[]).filter(c=>!c.inForm||!Number.isInteger(c.formIndex)||f.frameIndex===submitFrameIndex&&c.formIndex===submit.formIndex)}))};
}
// Hyundai 15303 (SuccessFactors, lesson 485): the model chose the filled Zip/Postal Code four times; each refill was
// sent back as "already holds that answer" and the rejections ended the run. A control sent back that way is left out
// of later snapshots while it still shows the same value; if the page clears or changes it, it is offered again.
export const withoutSettled=(snap,settled)=>!settled?.size?snap:{...snap,frames:(snap.frames??[]).map(f=>({...f,controls:(f.controls??[]).filter(c=>!(settled.has(c.label)&&String(c.value??'')!==''&&settled.get(c.label)===String(c.value??'')))}))};
export const alreadyHolds=(control,value,answered=[])=>['text','email','tel','number','url','search','textarea'].includes(control.type)&&!control.combobox&&String(control.value??'')!==''&&keptValue(control.type,String(control.value),String(value))&&answered.some(a=>a.label===control.label&&a.value===String(value));
// ADP Workforce Now (R-V Industries 13344) shows a typed "555-010-0000" in a type=text Mobile Number as "+1 555 010 0000",
// so a typed phone number (any input type) also counts as kept when only the U.S. +1 prefix was added.
const phoneDigits=s=>/^\+?[\d\s().-]+$/.test(s)?s.replace(/\D/g,''):null;
export const keptValue=(type,kept,typed)=>{
 if(kept===typed)return true;
 const t=phoneDigits(typed),k=phoneDigits(kept);
 if(!t||!k||t.length<7||(type!=='tel'&&t.length<10))return false;
 return k===t||t.length===10&&k==='1'+t;
};
// Oracle's Address Line 1 is a map search (aria-describedby "oracle-maps-search-hint") that also
// keeps typed text once its suggestions are closed; use that when no suggestion matches (Howmet 11608).
export const streetLineLabel=label=>/^(street number and name( or p\.?o\.? box)?|street address|address line 1|address 1)\s*\*?$/i.test(String(label??'').trim());
// Ford 12857 (lesson 463): the same Oracle map search drops text set in one go, and offers suggestions only for
// keystrokes. Type the street key by key, take the one suggestion that names his city or ZIP, else keep the typed line.
export async function mapSearchFreeText(locator,value,{label='',answers={},note=async()=>{}}={}){
 const described=await locator.getAttribute('aria-describedby').catch(()=>null)??'';
 if(!value||!(/oracle-maps-search-hint/.test(described)||streetLineLabel(label)))return false;
 await locator.fill(value);await locator.press('Escape').catch(()=>{});await locator.evaluate(el=>el.blur()).catch(()=>{});
 await sleep(400);
 if((await locator.inputValue().catch(()=>''))===value)return true;
 await locator.click().catch(()=>{});await locator.fill('').catch(()=>{});await locator.pressSequentially(value,{delay:45});
 const page=locator.page();let texts=[];
 for(let i=0;i<12&&!texts.length;i++){await sleep(500);texts=await page.locator('[role=listbox]:visible [role=option]:visible, [role=grid]:visible [role=row]:visible, .pac-container .pac-item').allInnerTexts().catch(()=>[]);}
 const flat=t=>String(t??'').toLowerCase().replace(/\s+/g,' ');const place=[answers.addressCity,answers.city,answers.postalCode,answers.zip].filter(Boolean).map(flat);
 const street=flat(value).split(' ').slice(0,2).join(' ');
 const hits=texts.map((t,i)=>[flat(t),i]).filter(([t])=>t.includes(street)&&place.some(p=>t.includes(p.split(',')[0])));
 if(hits.length>=1){await page.locator('[role=listbox]:visible [role=option]:visible, [role=grid]:visible [role=row]:visible, .pac-container .pac-item').nth(hits[0][1]).click({timeout:5000}).catch(()=>{});await sleep(800);
  if(flat(await locator.inputValue().catch(()=>'')).includes(street))return true;}
 else{await locator.press('Escape').catch(()=>{});await locator.press('Tab').catch(()=>{});await sleep(500);if((await locator.inputValue().catch(()=>''))===value)return true;}
 await note(`Street search kept nothing (${texts.length} suggestions, ${hits.length} for his city; describedby "${described.slice(0,60)}")`);
 return false;
}
// Rippling greys out Apply until every required answer is given (AtmosZero 12640's blank text-message
// consent). Clicking it only timed out, yet the run had already recorded a submission (lesson 311).
export async function submitControlDisabled(locator){
  if(await locator.isDisabled({timeout:2000}).catch(()=>false))return true;
  return /^true$/i.test(String(await locator.getAttribute('aria-disabled',{timeout:2000}).catch(()=>null)??''));
}
export const finalButton=label=>/\b(submit|send application|complete application|finish application)\b/i.test(label);
const navigationLabel=label=>String(label).trim().replace(/[»›→]+$/u,'').trim().replace(/\s+/g,' ').toLowerCase();
// Phenom career sites name the button after the jobSeqNo, <letters><requisition digits>EXTERNAL<lang><region>:
// "Apply for GENEUS202610127752EXTERNALENUS" (Genentech 14640, /job/202610-127752/) and "Apply Now for
// VGNVGEUS2328EXTERNALENGLOBAL" (Virgin Galactic 13400, /job/2328/). Accept it only when that number EQUALS the
// posting URL's own /job/<n> requisition (dashes removed); a substring or any other digit run is not enough.
const phenomRequisition=job=>String(job.url??'').match(/\/job\/(\d(?:[\d-]*\d)?)(?:[/?#]|$)/)?.[1]?.replace(/-/g,'');
const roleApplyLabel=(label,job={})=>{
 const text=navigationLabel(label);
 // Amazon (15083) labels its posting-page button "Apply now for <title>"; Honda's Phenom site (15037) "Apply Now <title>".
 if(job.title?.trim()&&[`apply for `,`apply now for `,`apply now `].some(p=>text===p+navigationLabel(job.title)))return true;
 // iCIMS (Garmin 14163) labels the link "Apply : <title>".
 if(job.title?.trim()&&text===`apply : ${navigationLabel(job.title)}`||job.title?.trim()&&text===`apply: ${navigationLabel(job.title)}`)return true;
 // Rivian 9516: the iCIMS link reads "Apply : Early Career - Validation Engineer, Vehicle Hardware" while the job title is
 // "Early Career Validation Engineer - Vehicle Hardware"; compare letters and digits only.
 if(job.title?.trim()){const squash=t=>t.replace(/[^a-z0-9]/g,'');const m=text.match(/^apply ?: ?(.+)$/u);if(m&&squash(m[1])&&squash(m[1])===squash(navigationLabel(job.title)))return true;}
 // Phenom's label can carry invisible characters (14640 was rejected live); compare letters and digits only.
 const id=text.match(/^apply (?:now )?for (\S{8,80})$/u)?.[1]?.replace(/[^a-z0-9]/g,'');
 const number=id?.match(/^[a-z]+?(\d+)external[a-z]+$/)?.[1];
 const requisition=phenomRequisition(job);
 return !!number&&!!requisition&&number===requisition;
};
// "Proceed" moves past IBMid's post-sign-in notice page (IBM 11946).
// iRecruit moves between form sections with "Save/Next"; its last section leads to a
// separate signature page, so it never submits (Piper 13354).
// iCIMS posting pages open the form with "Apply for this job online" (Great Dane 13347).
// Breezy HR posting pages open the form with "Apply To Position" (Hankook 12701).
// Paylocity's step 1 of 6 moves on with a submit-typed "Next Step" (Keel 12694).
// A review page's "Edit <section>" link only reopens that form section to correct an answer; it never submits.
// Amazon jumped straight to Review with a stale saved "No" and the guard refused "Edit Job-specific questions",
// so the wrong answer could not be fixed (16220, lesson 476). Only section-named edits; "Edit profile" etc. stay refused.
export const reviewSectionEdit=label=>/^edit (?:the )?(?:[a-z][a-z0-9 &/,'-]{0,50}[ -])?(?:questions|information|info|details|eligibility|experience|education|resume|résumé|documents|attachments|disclosures?|section)$/u.test(navigationLabel(label));
export const safeNavigation=(label,job={})=>reviewSectionEdit(label)||/^(next|next step|continue|proceed|save and continue|save & continue|save ?\/ ?next|save and next|save & next|apply|apply now|apply for this job|apply for this job online|apply online|apply to position|start application|autofill with resume|review application|back)$/i.test(navigationLabel(label))||profileStep(label)||roleApplyLabel(label,job);
// iCIMS (Rivian) saves the candidate profile page with 'Update Profile' and then shows the application's own
// pages; it is a continue step even when the step model calls it the final control (his instruction, lesson 455).
export const profileStep=label=>navigationLabel(label)==='update profile';
// Only an http(s) link to another origin leaves the site. Amazon's review-page "Edit Job-specific questions" is an
// <a href="javascript:void(0)"> handled by script: its URL origin is the string "null", which the old origin comparison
// read as a different site, so the run threw "An external application link needs a separate verified application URL"
// right after lesson 476 let the label through (16220, lesson 477). javascript:, mailto:, about: and unparsable hrefs stay in place.
export const offSiteLink=(href,pageUrl)=>{
 if(!href)return false;
 try{const u=new URL(href);if(!/^https?:$/.test(u.protocol))return false;return u.origin!==new URL(pageUrl).origin;}catch{return false;}
};
const applyLabel=(label,job)=>/^(apply|apply now|apply for this job|apply for this job online|apply online|apply to position)$/i.test(navigationLabel(label))||roleApplyLabel(label,job);
// Apple's posting page starts its application with "Submit Resume" (11807/11809 were recorded as submitted).
export function isApplicationEntry(control,answered=[],job={}){return (applyLabel(control.label,job)||/^(?:start application|submit (?:your |a )?(?:resume|cv))\b/.test(navigationLabel(control.label)))&&!control.formFields&&answered.length===0;}
export {formValidationGaps,missingRequiredUploads} from './form-validation.mjs';
import {genericResumeDrop,dropZoneLabel,uploadZoneHeading} from './generic-resume-drop.mjs';
import {formValidationGaps,missingRequiredUploads,requiredUploadGap} from './form-validation.mjs';
import {signInPagePostingUrl,icimsPostingUrl} from './posting-availability.mjs';
import {siteMaintenanceOutage} from './posting-availability.mjs';
// After a Submit rejected for field errors: one more try with Opus 5.5, then one with Fable 5.1.
export const SUBMIT_FIX_MODELS=['claude-opus-5-5','claude-fable-5-1'];
// A link outside any form only navigates; Apple's "Submit Resume: <title> <req>" link opens sign-in.
// A Submit in a form with at most one field is an entry gate (Cisco's email-only first page, 12281).
// A single checkbox the worker ticks on its own (his rule of 2026-11-02): marked required, or a must-agree privacy
// consent inside the form whose only 'required' marker is its caption (Kratos 14919 on submit4jobs/pereless, lesson 478).
export const mustTickBox=c=>!!c&&c.type==='checkbox'&&(c.required===true||inFormConsentToTick(c))&&c.value!=='true'&&!c.disabled;
export function isFinalControl(control,answered=[],job={}){return !isApplicationEntry(control,answered,job)&&!(['a','link'].includes(control.type)&&control.inForm===false)&&!(Number.isFinite(control.formFields)&&control.formFields<=1&&answered.length>0&&answered.every(a=>/\be-?mail\b/i.test(a.label??'')))&&(finalButton(control.label)||applyLabel(control.label,job)||control.type==='submit'&&!safeNavigation(control.label,job));}
// Campbell Scientific (12670) lists its roles in an embedded Paycor frame whose list sits inside a form; the
// exact-title link opens recruitingbypaycor.com/...?id=<the gni value in the posting URL>. A hiring-platform
// link carrying an id from the posting URL's query is that posting's own page, in a form or not.
export function safeRoleLink(control,job,{platforms=HIRING_PLATFORMS}={}) {
 if(control.type!=='a'||!control.href||String(control.label).trim()!==String(job.title).trim())return false;
 let href,posting;
 try{href=new URL(control.href);posting=new URL(job.url);}catch{return false;}
 if(!control.inForm&&href.hostname===posting.hostname)return true;
 if(href.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(href.hostname))return false;
 if(!platforms.some(d=>href.hostname===d||href.hostname.endsWith('.'+d)))return false;
 const ids=[...posting.searchParams.values()].filter(v=>/^[A-Za-z0-9_-]{12,}$/.test(v)&&/\d/.test(v));
 const tokens=[...href.searchParams.values(),...href.pathname.split('/')];
 return ids.some(id=>tokens.includes(id));
}
// LLNL keeps its posting on llnl.gov (12783) and its "Apply Now" opens the same requisition on
// SmartRecruiters in a new tab. An Apply link to a known hiring platform whose path carries this
// posting's own identifier is that posting's verified application URL and is followed in this tab;
// any other off-site link still stops the run (it could lead anywhere, including a credential trap).
// Firefly 13348's JobAgent URL is firefly.hrmdirect.com/...?req=3848064, which redirects to
// apply.clearcompany.com/firefly?jobId=<uuid>; only that redirected page carries the id its APPLY
// link uses. The page the posting URL led to (pageUrl, when it sits on a hiring platform or the
// posting's own site) therefore supplies ids as well.
export function platformApplyLink(control,job={},{platforms=HIRING_PLATFORMS,pageUrl}={}){
 if(!control?.href||!applyLabel(control.label,job))return false;
 let href,posting,current;
 try{href=new URL(control.href);posting=new URL(job.url);}catch{return false;}
 if(href.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(href.hostname))return false;
 if(!platforms.some(d=>href.hostname===d||href.hostname.endsWith('.'+d)))return false;
 try{current=pageUrl?new URL(pageUrl):null;}catch{current=null;}
 const site=h=>h.split('.').slice(-2).join('.');
 if(current&&current.origin!==posting.origin&&site(current.hostname)!==site(posting.hostname)&&!platforms.some(d=>current.hostname===d||current.hostname.endsWith('.'+d)))current=null;
 // Firefly's ClearCompany posting (13348) carries its id as ?jobId=<uuid>; its Apply opens
 // firefly.clearcompany.com/careers/jobs/<uuid>/apply, so a long query id counts as well.
 const ids=[posting,...(current?[current]:[])].flatMap(u=>[u.pathname.split('/').filter(Boolean).pop()??'',...u.pathname.split('/').filter(seg=>/^\d{5,}$/.test(seg)),...[...u.searchParams.values()].filter(v=>v.length>=12)])
  .filter(id=>/^[A-Za-z0-9][A-Za-z0-9_-]{4,}$/.test(id)&&/\d/.test(id));
 if(ids.some(id=>new RegExp(`(^|[/_-])${id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?=[/_.-]|$)`,'i').test(href.pathname)))return true;
 // L3Harris (16675): the posting URL carries only Phenom-style internal ids, but its page text states "Job ID:  37026"
 // and Apply opens SuccessFactors ...?career_job_req_id=37026. A requisition query value equal to the posting's own stated Job ID counts.
 const stated=String(job.description??'').match(/\bJob ID:\s*([A-Za-z0-9_-]{4,})\b/i)?.[1];
 return !!stated&&/\d/.test(stated)&&['career_job_req_id','jobId','job_id','req_id','requisitionId','reqId'].some(k=>href.searchParams.get(k)===stated);
}
export {validatePublicURL};
export async function atomic(path,value){await writeFile(path+'.tmp',typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value,null,2),{mode:0o600});await rename(path+'.tmp',path);}
const readJSON=async(path,fallback)=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT'&&fallback!==undefined)return fallback;throw e;}};
// Unrecognized answer names stay unavailable rather than inheriting another employer's context.
const GENERIC_FACTS=new Set(`firstName lastName fullName preferredName email phone phoneCountry country city citySearch addressLine1 addressLine2 addressCity addressState addressZip linkedin github portfolio website school schoolSearch degree discipline major degreeBachelors gpaExact gpaBracket gpaNumber gpaGraduate gpaDoctorate graduationDate gradMonth gradYear earliestStartDate eduStartMonth eduStartYear workAuthorized requiresSponsorship sponsorship citizenshipStatus securityClearance gender genderIdentity race hispanicEthnicity ethnicitySelfId veteranStatus disabilityStatus ageBracket ageRange dateOfBirth pronounsPlain satScore actScore greScore workAuthYesNo sponsorshipYesNo exportControlStatus usPersonEligible clearanceEligibility pastClearance exportControlPerson eeoGender eeoRace eeoVeteran eeoDisability selfIdDisability selfIdVeteran rocketClub solidworksExperience revitBimExperience minimumAnnualSalary recruitmentSmsConsent`.split(/\s+/));
const EMPLOYER_FACTS=[
 [/^spacex$/,/^(spacex|workAuthSpaceX$|satSpaceX$)/i],
 [/^anduril(?: industries)?$/,/^(anduril|employedByAnduril$)/i],
 [/^lucid(?: motors)?$/,/^lucid/i],
 [/^rocket lab(?: usa)?$/,/^rl[A-Z]/],
 [/^shield ai$/,/^sa[A-Z]/],
 [/^relativity(?: space)?$/,/^rel[A-Z]/],
 [/^vast(?: space)?$/,/^vast[A-Z]/],
 [/^hermeus$/,/^hermeus/i],
 [/^jumio$/,/^(jumio|selfIdGenderJumio$|selfIdEthnicityJumio$)/i],
 [/^graphcore$/,/^(graphcore|veteranStatusGraphcore$)/i],
 [/^field ai$/,/^fieldai/i],
 [/^1x(?: technologies)?$/,/^oneX/],
];
export function availableFacts(profile,company=''){
 const companyName=company.trim().toLowerCase(),facts={};
 for(const [key,value] of Object.entries(profile.answers??{})){
  if(PREFERENCE_FACTS.includes(key)||GENERIC_FACTS.has(key)||EMPLOYER_FACTS.some(([employer,prefix])=>employer.test(companyName)&&prefix.test(key)))facts[key]=value;
 }
 // Month-precision dates (["6","2026"]) also appear whole as "6/2026" for date and month inputs.
 const monthYear=v=>Array.isArray(v)&&v.length===2&&/^\d{1,2}$/.test(v[0])&&/^\d{4}$/.test(v[1]);
 const flatten=(value,path)=>{if(value===null||value===undefined)return;if(monthYear(value))facts[path]=`${value[0]}/${value[1]}`;if(typeof value==='object'){for(const [key,child]of Object.entries(value))flatten(child,`${path}.${key}`);}else facts[path]=value;};
 for(const key of ['workHistory','education'])if(profile[key])flatten(profile[key],key);
 return Object.assign(facts,historyCurrentFacts(profile),currentEmployerFacts(profile));
}
// 'What job(s) are you applying for?' names this posting; a company bank answer belongs to another role (Shield AI 12207 got 10277's title).
export const appliedRoleQuestion=label=>/\b(?:what|which)\b[^?]{0,40}\b(?:jobs?|positions?|roles?|job\(s\)|position\(s\)|role\(s\))\s+(?:are|is)\s+you\s+applying\s+(?:for|to)\b/i.test(String(label??''));
// A typeahead's choices only exist once it opens, so a preference chosen beforehand can name a default the menu
// never offers (the routine source default "Company Website" at Hyundai 11914, whose list has "Job Board").
// Once the menu has been read, choose again from what it actually offers.
export function offeredPreference(label,value,offered,profile,job={},bank={}){
  if(!offered?.length)return null;
  const preference=preferenceAnswer(label,profile.answers??{},{...job,company:job.company,bank,options:offered,history:profile.workHistory??[]});
  const chosen=preference?.value&&offered.find(o=>sameText(String(o),String(preference.value)));
  return chosen&&!sameText(String(chosen),String(value))?chosen:null;
}
export function approvedValue(action,control,profile,bank,inline,company='',job={}){
  if(routineQuestionNeedsReview(control.label)){
   const value=inline.get(questionId(control.label))??bank[questionId(control.label)]?.answer;
   if(typeof value==='string'&&value.trim()){
    // A reviewed choice is the group's answer, not a boolean for every input.
    if(['radio','checkbox'].includes(control.type)&&control.optionLabel){
     const matches=option=>sameText(value.toLowerCase(),String(option).toLowerCase());
     if(control.choiceLabels?.filter(matches).length!==1)throw new Error('This choice needs an approved offered answer');
     return matches(control.optionLabel);
    }
    return value;
   }
   throw new Error('This question needs its own approved wording or answer');
  }
  if(appliedRoleQuestion(control.label)){if(!job.title?.trim())throw new Error('The applied-for role needs the job title');return job.title.trim();}
  if(internshipCompensationQuestion(control.label,job)){
   const approved=inline.get(questionId(control.label));
   if(approved!=null&&String(approved).trim())return approved;
   throw new Error('Internship compensation needs its own approved answer');
  }
  const currentPosition=confirmedCurrentPosition(control,profile);if(currentPosition!==undefined)return currentPosition;
  // Standalone current-employer/title fields come from the open work-history row, never from a résumé parse.
  if(!control.historySection){const employer=currentEmployerAnswer(control.label,profile);if(employer!==undefined){if(employer?.blankWhenOptional)return control.required?employer.value:'';if(!employer?.value)throw new Error('Current employer needs one open work-history row');return employer.value;}}
  const historyLocation=confirmedHistoryLocation(action,control,profile);if(historyLocation!==undefined)return historyLocation;
  const regional=regionalAnswer(control.label,profile,job);if(regional){if(!regional.value)throw new Error('This regional address needs a confirmed answer');
   // A State select may list only the full name ('California' for CA; Cisco 12281).
   const offered=(control.options?.map(o=>o.label)??control.choiceLabels)?.find(o=>regional.candidates?.some(c=>sameText(String(c).toLowerCase(),String(o).trim().toLowerCase())));
   return offered??regional.value;}
  if(control.skillRating){
   const rating=inline.get(questionId(control.label))??lookupAnswer(bank,control.label)?.answer;
   if(!control.choiceLabels?.includes(rating))throw new Error('A skill self-assessment needs an approved offered rating');
   return sameText(rating,control.optionLabel);
  }
  // This run's approved answers count like bank entries (Formlabs 7693 re-flagged an approved 'Other' source).
  const preferenceContext={...job,company:job.company??company,bank,approvedAnswers:[...(inline??new Map())].map(([question,answer])=>({question,answer})),options:control.choiceLabels??control.options,history:profile.workHistory??[]};
  const authoritative=preferenceAnswer(control.label,profile.answers,preferenceContext);
  if(authoritative?.authoritative){
   if(['checkbox','radio'].includes(control.type)&&control.optionLabel)return (authoritative.candidates??[authoritative.value]).some(c=>c instanceof RegExp?c.test(control.optionLabel):sameText(String(c).toLowerCase(),String(control.optionLabel).toLowerCase()));
   return authoritative.value;
  }
  if(['checkbox','radio'].includes(control.type)){
   const option=control.optionLabel??control.label;
   const choiceEquals=(a,b)=>sameText(String(a).toLowerCase(),String(b).toLowerCase());
   const a=profile.answers??{};
   const choices=[a.gender,a.genderIdentity,a.race,a.eeoRace,a.veteranStatus,a.disabilityStatus].filter(Boolean);
   if(choices.some(c=>choiceEquals(c,option)))return true;
   if(/^Never held a clearance\s*\*?$/i.test(option)&&a.heldSecurityClearance==='No')return true;
   if(control.optionLabel){
    const preference=preferenceAnswer(control.label,a,preferenceContext);
    let value=inline.get(questionId(control.label))??lookupAnswer(bank,control.label)?.answer??preference?.value;
    if(control.choiceLabels?.length&&preference&&!control.choiceLabels.some(c=>choiceEquals(value,c)))value=preference.value;
    if(preference&&['currentSecurityClearance','heldSecurityClearance'].includes(preference.key)&&['No','None'].includes(preference.value))return (preference.candidates??[preference.value]).some(c=>c instanceof RegExp?c.test(String(option).trim()):choiceEquals(c,option));
    if(value!=null&&(control.choiceLabels?.some(c=>choiceEquals(value,c))||!control.choiceLabels?.length&&(['Yes','No'].includes(String(value))||choices.includes(value))))return choiceEquals(value,option);
    const fact=availableFacts(profile,company)[action.fact];
    if(['Yes','No'].includes(option)&&['Yes','No',true,false].includes(fact))return choiceEquals(fact===true?'Yes':fact===false?'No':fact,option);
    if(fact!=null&&choices.includes(fact))return choiceEquals(fact,option);
    if(control.choiceLabels?.length)throw new Error('Choice group needs a confirmed offered answer');
   }
  }
  if(inline.has(questionId(control.label)))return inline.get(questionId(control.label));
  const preference=preferenceAnswer(control.label,profile.answers,preferenceContext);
  if(preference?.key==='minimumAnnualSalary'||preference?.key==='fullName'&&/current date/i.test(control.label))return preference.value;
  const saved=lookupAnswer(bank,control.label);
  if(preference&&confirmedFactIsNewer(preference.key,profile,saved))return preference.value;
  if(saved)return saved.answer;
  if(preference)return preference.value;
  // The same question worded differently elsewhere may reuse his approved answer by its bank key.
  if(action.fact?.startsWith('bank:')&&bank[action.fact.slice(5)])return bank[action.fact.slice(5)].answer;
  if(control.type==='textarea')throw new Error('Free-text wording needs an inline answer');
  const facts=availableFacts(profile,company);
  if(!action.fact||!Object.hasOwn(facts,action.fact))throw new Error('This question needs a confirmed answer');
  // A native date/month input holds the whole date; a month or year component alone is malformed (Siemens 6654).
  const whole=/^(.*\.(?:from|to))\.[01]$/.exec(action.fact)?.[1];
  if(['date','month'].includes(control.type)&&whole&&Object.hasOwn(facts,whole))return facts[whole];
  return facts[action.fact];
}
// A native group exposes unchecked alternatives even after its answer is complete.
// Hide only controls already at their validated target state from the step agent;
// retain the full snapshot for rebinding, final validation and review.
export function choiceNeedsAction(control,profile,bank,inline,company='',job={}){
 if(!['checkbox','radio'].includes(control.type)||!control.optionLabel)return true;
 try{const value=approvedValue({},control,profile,bank,inline,company,job);return typeof value!=='boolean'||String(value)!==control.value;}catch{return true;}
}
export async function snapshot(page){
 const frames=[];
 for(const [frameIndex,frame] of page.frames().entries()){
  try{frames.push(await frame.evaluate(frameIndex=>{
   const controls=[];let n=0;
   // ADP myjobs (Toyota Automated Logistics 12808) renders its sign-in email <input> inside the <sdf-input> open
   // shadow root, which document.querySelectorAll never reaches. Walk open shadow roots in document order;
   // Playwright's CSS locators pierce them, so the data-ja-control tag still binds the control.
   const deep=(root,selector,out=[])=>{for(const el of root.querySelectorAll('*')){if(el.matches(selector))out.push(el);if(el.shadowRoot)deep(el.shadowRoot,selector,out);}return out;};
   for(const el of deep(document,'[data-ja-control]'))el.removeAttribute('data-ja-control');
   const identity=window.__jobAgentControlIdentity??= {keys:new WeakMap(),next:0,documentKey:crypto.randomUUID()};
   // SmartRecruiters' one-click form (Intuitive 12316, lesson 426) has no <form> at all, even in its shadow roots:
   // on such a page every field belongs to the application, so none of them reads as "outside the form".
   // Only an application: no <form>, yet several fillable fields and at least one marked required (a job board's
   // filter checkboxes or a posting page's links do not qualify).
   const fillable=deep(document,'input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,select');
   const formless=!deep(document,'form').length&&fillable.length>=3&&fillable.some(f=>f.required||f.getAttribute('aria-required')==='true');
   for(const el of deep(document,'input,textarea,select,button,a,[role="combobox"],[role="button"],[role="radio"],[role="checkbox"],.ashby-application-form-field-entry,[data-field-entry-id],form.new_applicant .chosen-container')){
    // An ARIA-only radio/checkbox with no native input (SmartRecruiters <spl-radio label="No" role="radio"
    // aria-checked>, Intuitive 12315/12316, lesson 437) reads like a native one: type from its role, checked from
    // aria-checked. One wrapping a native input (Rippling, Workable) is skipped; the input itself is the control.
    if(el.matches('[role="radio"],[role="checkbox"]')&&!el.matches('input,button')){
     if(deep(el,'input[type=radio],input[type=checkbox]').length||el.querySelector('input[type=radio],input[type=checkbox]'))continue;
     Object.defineProperty(el,'type',{value:el.getAttribute('role'),configurable:true});
     Object.defineProperty(el,'checked',{get:()=>el.getAttribute('aria-checked')==='true',configurable:true});
    }
    const triNetForm=el.closest('form.new_applicant');
    const chosen=triNetForm&&el.closest('.chosen-container');
    const chosenSelect=chosen?.previousElementSibling?.matches('select.chosen-select')?chosen.previousElementSibling:null;
    if(chosenSelect&&el!==chosen)continue;
    const ashbyEntry=el.closest('[data-field-entry-id],.ashby-application-form-field-entry');
    const ashbyChoice=ashbyEntry&&(ashbyEntry.querySelector('.ashby-application-form-input-yesno')||ashbyEntry.querySelector('input[type="radio"]')||ashbyEntry.querySelectorAll('input[type="checkbox"]').length>1);
    if(el.matches('[data-field-entry-id],.ashby-application-form-field-entry')&&!ashbyChoice)continue;
    // Crusoe 9619 keeps the phone input and its SMS-consent radios in one entry; the typed input stays its own control.
    const ashbyTyped=el.matches('input,textarea')&&!['radio','checkbox','button','submit','reset','hidden','file'].includes(el.type);
    if(ashbyChoice&&el!==ashbyEntry&&!ashbyTyped)continue; // expose one question, not disconnected Yes/No submit buttons
    // Rippling (Astra 13030) keeps its radio/checkbox inputs display:none inside a visible [role=radio|checkbox]
    // option, so the text-message consent and "How did you hear" boxes never reached the worker and Apply stayed disabled.
    // SmartRecruiters (Intuitive 12315, lesson 436) hides the native radio inside its <spl-radio> shadow root and shows
    // only the label / the host: such a radio is still the question's answer control.
    const shownToggle=['radio','checkbox'].includes(el.type)&&(el.closest('[role="radio"],[role="checkbox"]')?.getClientRects().length||
     [...(el.labels??[])].some(l=>l.getClientRects().length)||el.getRootNode().host?.getClientRects().length);
    if((!el.getClientRects().length&&el.type!=='file'&&!shownToggle)||el.disabled||el.type==='hidden')continue;
    // Amazon's apply form keeps a visibility:hidden twin (class="invisible") of its city input: it has layout boxes but
    // Playwright can never fill it (15083). A typed control that is not rendered is not a question.
    if(el.type!=='file'&&!shownToggle&&!['radio','checkbox'].includes(el.type)&&['hidden','collapse'].includes(getComputedStyle(el).visibility))continue;
    // A file input itself may be hidden behind a visible upload button. Hidden
    // ancestor panels, however, belong to inactive steps and must not trigger
    // the automatic resume upload while preparing a different step.
    if(el.type==='file'){
     let inactive=false;
     for(let parent=el.parentElement;parent;parent=parent.parentElement){
      const style=getComputedStyle(parent);
      if(parent.hidden||parent.inert||parent.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'){inactive=true;break;}
     }
     if(inactive)continue;
    }
    // Dropdown libraries keep an unfocusable aria-hidden "required" twin beside the real control.
    // Workable's YES/NO toggles keep the real required radio aria-hidden inside a visible [role=radio] (RAVE 10572).
    const ariaRadio=['radio','checkbox'].includes(el.type)&&el.closest('[role="radio"],[role="checkbox"]');
    if(el.getAttribute('aria-hidden')==='true'&&el.tabIndex<0&&el.type!=='file'&&!ariaRadio)continue;
    const id=`f${frameIndex}c${n++}`;el.setAttribute('data-ja-control',id);
    if(!identity.keys.has(el))identity.keys.set(el,`${identity.documentKey}:node${identity.next++}`);
    const nodeKey=identity.keys.get(el);
    const labelled=ids=>(ids||'').split(/\s+/).map(i=>(el.getRootNode().getElementById?.(i)||document.getElementById(i))?.innerText).filter(Boolean).join(' ');
    // Rendered text through slots and shadow roots: SmartRecruiters' <spl-button> buttons read innerText "" while
    // showing "Next" (Intuitive 12316, lesson 425).
    const flatText=n=>n.nodeType===3?n.textContent:n.tagName==='SLOT'?n.assignedNodes({flatten:true}).map(flatText).join(''):
     [...(n.shadowRoot?.childNodes||[]),...(n.shadowRoot?[]:n.childNodes||[])].map(flatText).join('');
    const rendered=el.matches('button,[role=button],a')?flatText(el).replace(/\s+/g,' ').trim():'';
    // A label with no words ("*" beside a slotted question): its rendered text, else the nearest enclosing
    // element (across shadow roots) whose rendered text has words (lesson 426).
    const wordy=t=>/[a-z]{3}/i.test(t||'');
    // A slotted label can carry a whole notice before its question (Intuitive 12315's export-control assessment,
    // lesson 430): when the text is longer than a label, keep the sentences from the last question mark onwards.
    const trailingQuestion=t=>{const qi=t.lastIndexOf('?');if(qi<0)return '';const head=t.slice(0,qi);let start=0;const boundary=/(?<![A-Z])[.!?]\s+(?=[A-Z(])/g;for(let m;(m=boundary.exec(head));)start=m.index+m[0].length;const tail=t.slice(start).trim();return tail.length<600?tail:'';};
    const nearestText=()=>{let n=el.labels?.[0]||el;for(let i=0;n&&i<8;i++){const t=flatText(n).replace(/\s+/g,' ').trim();if(wordy(t)){if(t.length<600)return t;const q=trailingQuestion(t);if(q)return q;}n=n.parentElement||n.getRootNode().host;}return '';};
    let label=((el.labels?.[0]&&(el.labels[0].innerText||flatText(el.labels[0]).replace(/\s+/g,' ').trim()))||(ariaRadio&&labelled(ariaRadio.getAttribute('aria-labelledby')?.split(/\s+/).slice(1).join(' ')))||labelled(el.getAttribute('aria-labelledby'))||el.getAttribute('aria-label')||(el.matches('[role=radio],[role=checkbox]')&&el.getAttribute('label'))||el.getAttribute('placeholder')||el.innerText||rendered||(el.tagName==='INPUT'&&['submit','button','reset'].includes(el.type)?el.value:'')||el.name||el.id||'Unlabelled field').trim();
    // Intuitive 12315's screening select (lesson 428): the <spl-autocomplete> input's shadow <label> holds only the "*"
    // mark while the question is slotted in, so the rule applies to every form control, not just boxes.
    if(!/[a-z0-9]/i.test(label)&&el.matches('input,textarea,select,[role=combobox],[role=checkbox],[role=radio]'))label=nearestText()||label;
    // Ashby date widgets have no input id; the entry owns the question heading.
    let ashbyHeadingRequired=false;
    if(ashbyEntry&&!ashbyChoice&&el.matches('input,textarea,select,[role="combobox"]')){
     const heading=ashbyEntry.querySelector('.ashby-application-form-question-title');
     if(heading?.closest('[data-field-entry-id],.ashby-application-form-field-entry')===ashbyEntry&&heading.innerText.trim()){
      label=heading.innerText.trim();
      // Ashby's required star is CSS on the heading's _required_ class, so a lone attestation checkbox (RV Tech 13331:
      // "I certify ...", "I understand my application will be processed ...") carried no required attribute at all.
      ashbyHeadingRequired=heading.className.includes('_required_')||heading.getAttribute('aria-required')==='true';
     }
    }
    // Rippling custom questions put the title in the sibling before the field wrapper, unlinked, so the
    // textarea fell back to its generated id "field-85" (Astra 13030).
    const ripplingQuestion=!['radio','checkbox'].includes(el.type)&&el.closest('[data-testid^="customQuestions."]')?.closest('[data-testid="field"]')?.previousElementSibling?.innerText?.trim();
    if(ripplingQuestion&&[el.id,el.name,el.getAttribute('placeholder'),'Select'].includes(label))label=ripplingQuestion;
    let optionLabel,choiceLabels,documentRequired=ashbyHeadingRequired;
    const triNetHeading=triNetForm&&el.closest('.form-group')?.querySelector(':scope > label:not(.control)');
    if(triNetHeading&&!['radio','checkbox'].includes(el.type)){label=triNetHeading.innerText.trim()||label;documentRequired=triNetHeading.classList.contains('required');}
    if(chosenSelect){
     controls.push({id,nodeKey,name:chosenSelect.name,label,type:'combobox',combobox:true,inForm:true,required:documentRequired||chosenSelect.required,value:chosenSelect.value?(chosenSelect.selectedOptions[0]?.text||''):''});
     continue;
    }
    const leverQuestion=el.closest('.application-question');
    const leverHeading=leverQuestion?.querySelector('.application-label');
    if(leverHeading){
     documentRequired=!!leverHeading.querySelector('.required');
     if(!['radio','checkbox'].includes(el.type))label=leverHeading.innerText.replace(/\s*[✱*]\s*$/,'').trim()||label;
    }
    if(['radio','checkbox'].includes(el.type)){
     // Lever groups options in li.application-question with the question in .application-label, no fieldset.
     const triNetSkill=triNetForm&&el.closest('.applicant-skills li');
     // The group may sit outside the radio's own shadow root (SmartRecruiters <spl-radio> per option, lesson 436).
     const composedClosest=sel=>{let n=el;while(n){const hit=n.closest?.(sel)||n.assignedSlot?.closest(sel);if(hit)return hit;n=n.assignedSlot||n.parentElement||n.getRootNode().host;}return null;};
     const group=el.closest('fieldset,[role="radiogroup"],[role="group"]')||el.closest('.application-question')||triNetSkill||composedClosest('fieldset,[role="radiogroup"],[role="group"]');
     let question=group&&(group.querySelector('label.skill-name')?.innerText||group.querySelector('legend')?.innerText||labelled(group.getAttribute('aria-labelledby'))||group.querySelector('.application-label')?.innerText?.replace(/\s*[✱*]\s*$/,''));
     // Rippling titles a choice group with the sibling before its unlabelled [data-testid=field] wrapper (Astra 13030).
     const field=group?.closest('[data-testid="field"]');
     const ripplingTitle=!question&&field&&!field.querySelector('[id$="-label"]')&&field.previousElementSibling?.innerText?.trim();
     if(ripplingTitle)question=ripplingTitle;
     // Phenom (Genentech 14640) titles its consent fieldset with the schema key "disclaimerUSA", so all three boxes
     // (privacy consent, marketing, SMS) read as one unlabelled "disclaimerUSA"; a bare identifier is no question.
     if(/^[A-Za-z][A-Za-z0-9_.-]*$/.test(question?.trim()??'')&&/[a-z][A-Z]|[_.]/.test(question.trim()))question='';
     // The group's label lives in the group's own shadow root (SmartRecruiters radiogroup, lesson 437).
     if(group&&!question?.trim()&&group.getAttribute('aria-labelledby')){
      const t=group.getAttribute('aria-labelledby').split(/\s+/).map(i=>group.getRootNode().getElementById?.(i)).filter(Boolean).map(x=>flatText(x)).join(' ').replace(/\s+/g,' ').replace(/\s*[✱*]\s*$/,'').trim();
      if(/[a-z]{3}/i.test(t)&&!(/^[A-Za-z][A-Za-z0-9_.-]*$/.test(t)&&/[a-z][A-Z]|[_.]/.test(t)))question=t;
     }
     // A question that reads only "*" (SmartRecruiters slots the text: Intuitive's "Are you a protected veteran?",
     // lesson 434): the legend's / labelling element's rendered text, else the group's rendered text without its options.
     if(group&&typeof question==='string'&&question.trim()&&!/[a-z0-9]/i.test(question)){
      const title=group.querySelector('legend')||(group.getAttribute('aria-labelledby')||'').split(/\s+/).map(i=>i&&(el.getRootNode().getElementById?.(i)||document.getElementById(i))).find(Boolean);
      let t=title?flatText(title):'';
      if(!/[a-z]{3}/i.test(t)){t=flatText(group);for(const c of group.querySelectorAll('input[type=radio],input[type=checkbox]')){const o=c.labels?.[0]?flatText(c.labels[0]).trim():'';if(o)t=t.replace(o,' ');}}
      t=t.replace(/\s+/g,' ').replace(/\s*[✱*]\s*$/,'').trim();
      if(/[a-z]{3}/i.test(t)&&t.length<400)question=t;
     }
     if(question?.trim()&&question.trim()!==label){optionLabel=label;label=question.trim();choiceLabels=[...deep(group,'input[type=checkbox],input[type=radio]'),...deep(group,'slot').flatMap(sl=>sl.assignedElements({flatten:true})).filter(x=>x.matches('[role=radio],[role=checkbox]'))].filter(c=>!triNetSkill||c.name===el.name).map(c=>(c.labels?.[0]?.innerText||(c.labels?.[0]?flatText(c.labels[0]).replace(/\s+/g,' '):'')||c.getAttribute('aria-label')||c.getAttribute('label')||labelled(c.getAttribute('aria-labelledby'))||'').trim()).filter(Boolean);}
    }
    // ApplicantPro (X-Bow 12727) captions its privacy-policy checkbox with a sibling <span>, no <label> or aria text, so the
    // snapshot named it "info_use_consent" and the account-page terms guard refused it. The single-control wrapper's text is
    // its caption, and the caption's trailing * ("* Fields Are Required"; the page's script blocks submit without it) makes it required.
    if(el.type==='checkbox'&&!optionLabel&&!el.labels?.length&&!el.getAttribute('aria-labelledby')&&!el.getAttribute('aria-label')){
     const box=el.parentElement;
     const caption=box&&box.querySelectorAll('input,select,textarea,button,[role="combobox"]').length===1?(box.innerText||'').trim():'';
     if(caption&&caption.length<600){label=caption;if(/[✱*]\s*$/.test(caption))documentRequired=true;}
    }
    // Cisco 12281: a bare Yes/No radio pair with no fieldset is labelled only "Yes"/"No"; a "No" fact then
    // unchecked the No radio. The smallest container holding the whole same-name group carries the question.
    if(el.type==='radio'&&!optionLabel&&el.name){
     const peers=[...document.querySelectorAll('input[type=radio]')].filter(r=>r.name===el.name);
     let box=el.parentElement;while(box&&!peers.every(r=>box.contains(r)))box=box.parentElement;
     const names=peers.map(r=>(r.labels?.[0]?.innerText||'').trim()).filter(Boolean);
     const lines=t=>(t||'').split('\n').map(l=>l.replace(/\s*\*\s*$/,'').trim()).filter(l=>l&&!names.includes(l));
     const question=box&&peers.length>1&&(lines(box.innerText)[0]||lines(box.previousElementSibling?.innerText).at(-1));
     if(question&&question!==label&&question.length<500){optionLabel=label;label=question;choiceLabels=names;}
    }
    if(triNetForm&&el.closest('.applicant-skills li')&&el.type==='radio')documentRequired=true;
    // Avature (ArcBest 12717) links a lone attestation radio to its question label ("Please Confirm: *") and
    // puts the option text beside it, so two radios shared one optional-looking label, were skipped as optional
    // and then hidden from the Submit-fix step. A single-radio group is named by question and option, and the
    // question's trailing * makes it required, so each attestation is its own question for his approval.
    if(el.type==='radio'&&!optionLabel&&el.name&&[...document.querySelectorAll('input[type=radio]')].filter(r=>r.name===el.name).length===1){
     if(/[✱*]\s*$/.test(label))documentRequired=true;
     const single=b=>b.querySelectorAll('input,select,textarea,button,[role="combobox"]').length===1;
     let box=el.parentElement;while(box?.parentElement&&single(box.parentElement)&&(box.parentElement.innerText||'').trim().length<400)box=box.parentElement;
     const extra=box&&single(box)?(box.innerText||'').split('\n').map(l=>l.trim()).filter(l=>l&&l!==label&&!label.includes(l)):[];
     if(extra.length&&extra.join(' ').length<400)label=[label,...extra].join(' ');
    }
    // Upload inputs are often all labelled "Attach"; the group heading says which is the resume.
    if(el.type==='file'){
     const group=el.closest('[role=group],fieldset');const heading=group&&(labelled(group.getAttribute('aria-labelledby'))||group.querySelector('legend')?.innerText);
     if(heading){label=`${heading.trim()} (${label})`;if(/\*\s*$/.test(heading.trim()))documentRequired=true;}
     // Stop before sibling uploads so a cover letter cannot inherit the resume heading.
     if(!/r[eé]sum[eé]|\bcv\b|cover letter|transcript/i.test(label)){
      for(let parent=el.parentElement,depth=0;parent&&depth<7;parent=parent.parentElement,depth++){
       if(parent.querySelectorAll('input[type=file]').length!==1)break;
       const headings=(parent.innerText??'').split('\n').map(t=>t.trim()).filter(t=>/^(?:r[eé]sum[eé](?:\s*\/\s*CV)?|CV|curriculum vitae|cover letter|(?:academic )?transcript)\s*\*?$/i.test(t));
       if(headings.length===1){documentRequired=/\*/.test(headings[0]);label=`${headings[0]} (${label})`;break;}
       // Phenom (Genentech 14640): an unlabelled display:none input beside its own "Upload Resume" button.
       const buttons=[...parent.querySelectorAll('button,[role=button]')].map(b=>(b.innerText||b.getAttribute('aria-label')||'').trim()).filter(t=>/^(?:upload|attach|select|choose|add)\s+(?:your\s+|a\s+)?(?:r[eé]sum[eé]|cv)$/i.test(t));
       if(buttons.length===1){label=`${buttons[0]} (${label})`;break;}
      }
     }
    }
    if(ashbyChoice&&el===ashbyEntry){
     const heading=el.querySelector('.ashby-application-form-question-title');
     const buttons=[...el.querySelectorAll('.ashby-application-form-input-yesno button')];
     const radios=[...el.querySelectorAll('input[type="radio"],input[type="checkbox"]')];
     const options=buttons.length?buttons.map(b=>({label:b.innerText.trim(),value:b.innerText.trim()})):radios.map(r=>({label:r.labels?.[0]?.innerText.trim()||r.value,value:r.labels?.[0]?.innerText.trim()||r.value}));
     const selected=buttons.find(b=>b.getAttribute('aria-pressed')==='true');
     const checked=radios.find(r=>r.checked);
     controls.push({id,nodeKey,name:el.getAttribute('data-field-path')||undefined,label:heading?.innerText.trim()||label,type:'choice',inForm:true,required:heading?.className.includes('_required_')||heading?.getAttribute('aria-required')==='true',value:selected?.innerText.trim()||checked?.labels?.[0]?.innerText.trim()||'',options});
     continue;
    }
    // Oracle Candidate Experience (Vertiv 7922, Howmet 11608) renders a single-choice question as
    // <ul role=radiogroup aria-label=question> of <button role=radio aria-checked> pills and a
    // multi-choice one as a role=list of aria-pressed buttons. Seen one button at a time they were
    // bare "Yes"/"No"/"Other" buttons that neither fill nor click would touch; expose each group
    // once as a labelled choice control instead.
    const pillGroup=el.tagName==='BUTTON'&&!el.hasAttribute('aria-haspopup')&&(el.getAttribute('role')==='radio'||el.hasAttribute('aria-pressed'))?el.closest('[role="radiogroup"],[role="group"],[role="list"],fieldset'):null;
    if(pillGroup){
     el.removeAttribute('data-ja-control');
     if(pillGroup.hasAttribute('data-ja-control')){n--;continue;}
     pillGroup.setAttribute('data-ja-control',id);
     if(!identity.keys.has(pillGroup))identity.keys.set(pillGroup,`${identity.documentKey}:node${identity.next++}`);
     const pills=[...pillGroup.querySelectorAll('button')].filter(b=>b.getAttribute('role')==='radio'||b.hasAttribute('aria-pressed'));
     const name=b=>(b.innerText||b.getAttribute('aria-label')||'').trim();
     const selected=pills.filter(b=>b.getAttribute('aria-checked')==='true'||b.getAttribute('aria-pressed')==='true').map(name).filter(Boolean);
     const strip=t=>t.replace(/\s*[✱*]\s*$/,'').trim();
     const question=strip(labelled(pillGroup.getAttribute('aria-labelledby'))||pillGroup.getAttribute('aria-label')||pillGroup.querySelector('legend')?.innerText||'');
     // The visible heading above the group carries the required asterisk, not the aria-label.
     let heading;for(let box=pillGroup.parentElement,depth=0;box&&depth<3&&!heading;box=box.parentElement,depth++)heading=(box.innerText||'').split('\n').map(l=>l.trim()).find(l=>question&&strip(l)===question);
     const required=pillGroup.getAttribute('aria-required')==='true'||/[✱*]\s*$/.test(heading||'');
     controls.push({id,nodeKey:identity.keys.get(pillGroup),label:(question||label).slice(0,600),type:'choice',inForm:!!el.closest('form'),required,value:selected.join('; '),options:pills.filter(b=>!b.disabled).map(b=>({label:name(b),value:name(b)}))});
     continue;
    }
    label=label.slice(0,600);
    const popup=document.getElementById(el.getAttribute('aria-controls')||'');
    const pickerButton=el.matches('button,[role=button]')&&(el.getAttribute('aria-haspopup')==='listbox'||el.getAttribute('aria-haspopup')==='true'&&popup?.getAttribute('role')==='listbox');
    const combobox=pickerButton||el.getAttribute('role')==='combobox'||el.tagName==='INPUT'&&(el.getAttribute('aria-haspopup')==='listbox'||el.getAttribute('aria-autocomplete')==='list'||el.classList.contains('select__input')&&!!el.closest('.select__control'));
    // A <button> with no type attribute defaults to "submit", but outside any <form> it submits nothing.
    // Paylocity's page has no <form>, so share, upload, Add History and cookie buttons all read as submit (Keel 12694).
    const untypedButtonOutsideForm=el.tagName==='BUTTON'&&!el.form&&!el.hasAttribute('type');
    const type=combobox&&el.matches('button,[role=button]')?'combobox':untypedButtonOutsideForm?'button':(el.tagName==='A'?'':el.type)||el.getAttribute('role')||el.tagName.toLowerCase();
    // ApplicantPro (X-Bow 12727) gives its native <select>s role="combobox"; their value is the chosen option, never the whole option list.
    const shown=combobox&&el.tagName!=='INPUT'&&el.tagName!=='SELECT'&&!el.isContentEditable?(el.innerText.trim()==='Select'?'':el.innerText.trim()):combobox?((el.closest('[class*="control"]')?.querySelector('[class*="single-value"]')?.innerText)??Array.from(el.closest('[class*="control"]')?.querySelectorAll('[class*="multi-value__label"],[class*="multiValueLabel"]')??[]).map(e=>e.innerText).join('; ')):'';
    const form=el.form||el.closest('form');const inAppForm=!!form||formless;const formFields=form?Array.from(form.querySelectorAll('input,textarea,select')).filter(field=>!['hidden','submit','button','search'].includes(field.type)).length:0;
    // Which <form> on the page holds the control: a job-alert signup form beside the application form (Waymo 13548)
    // has its own required name/email inputs that Submit neither validates nor sends.
    const formIndex=form?Array.from(document.forms).indexOf(form):-1;
    controls.push({ariaExpanded:el.getAttribute('aria-expanded')||undefined,controlsSection:el.hasAttribute('aria-controls')&&el.getAttribute('aria-controls').trim().split(/\s+/).every(id=>!!document.getElementById(id))||undefined,id,nodeKey,domId:el.id||undefined,name:el.name||undefined,label,optionLabel,choiceLabels,skillRating:triNetForm&&el.type==='radio'&&!!el.closest('.applicant-skills li')||undefined,type,combobox:combobox||undefined,inForm:inAppForm,formFields,formIndex:formIndex>=0?formIndex:undefined,required:documentRequired||el.required||el.getAttribute('aria-required')==='true'||/[✱*]\s*$/.test(label||''),attached:el.type==='file'?(el.files?.length>0||!!el.closest('.file-upload,[role=group],fieldset')?.querySelector('.file-upload__filename')?.textContent?.trim()):undefined,value:type==='password'?'':el.type==='checkbox'||el.type==='radio'?String(el.checked):(shown||el.value||''),options:el.tagName==='SELECT'?Array.from(el.options).map(o=>({label:o.text,value:o.value})):undefined,href:el.tagName==='A'?el.href:undefined,hrefAttr:el.tagName==='A'?el.getAttribute('href'):undefined,target:el.tagName==='A'?el.getAttribute('target')||undefined:undefined,download:el.tagName==='A'&&el.hasAttribute('download')||undefined});
   }
   return{frameIndex,url:location.href,text:document.body.innerText.slice(0,18000),controls};
  },frameIndex));}catch{}
 }
 // A frame can detach between its read and these follow-up reads (Waymo 13548 right after the resume upload);
 // the annotations are optional, so a vanished frame keeps its plain controls and the loop rereads.
 for(const frame of frames)for(const annotate of [gustoControlLabels,annotateHistoryControls,annotateCurrentPositions])await annotate(page.frames()[frame.frameIndex],frame.controls).catch(()=>{});
 return{url:page.url(),frames};
}

// A click can make the page replace the input node itself: Paylocity re-renders "How did you hear
// about us?" to reveal "Please Specify" once "Other" is chosen (Keel 12694). The new node carries no
// data-ja-control tag, so the readback waited 10 s on a detached element. Follow the same input by
// id, else by name and value, instead of the stale tag.
async function sameInput(frame,locator,identity){
 if(await locator.count())return locator;
 if(!identity)return null;
 const q=JSON.stringify;
 const replacement=identity.id?frame.locator(`[id=${q(identity.id)}]`):identity.name?frame.locator(`input[type=${q(identity.type)}][name=${q(identity.name)}][value=${q(identity.value)}]`):null;
 return replacement&&await replacement.count()===1?replacement:null;
}
// SmartRecruiters reads an uploaded resume in the background and fills Experience and Education from it; pressing
// Next first (5 s after the upload, Intuitive 12316) left both empty. Wait for that parse to settle (lesson 439).
export async function settleResumeParse(page,{maxMs}={}){
 // Every site that parses the resume does it in the background; wait for it before filling anything, so its values
 // are read back instead of typed (lesson 440). SmartRecruiters' parse is the slowest seen.
 let host='';try{host=new URL(page.url()).hostname;}catch{}
 const smart=/(^|\.)smartrecruiters\.com$/.test(host);const limit=maxMs??(smart?15000:10000),settle=smart?3000:1500;
 const start=Date.now();
 await page.waitForLoadState('networkidle',{timeout:limit}).catch(()=>{});
 await page.waitForTimeout(Math.max(0,Math.min(settle,limit-(Date.now()-start))));
}
// A resume-autofill upload box (Ashby's "Autofill from resume", lesson 441): a file input inside a container that
// says Autofill. Returns a locator for the first one not yet used, or null. Buttons without a file input
// (Greenhouse's MyGreenhouse sign-in autofill) are never matched.
export async function findAutofillUpload(page){
 for(const frame of page.frames()){
  const mark=await frame.evaluate(()=>{
   const deep=(root,out=[])=>{for(const el of root.querySelectorAll('*')){if(el.matches('input[type=file]'))out.push(el);if(el.shadowRoot)deep(el.shadowRoot,out);}return out;};
   for(const input of deep(document)){
    if(input.hasAttribute('data-ja-autofill')||input.files?.length)continue;
    // Climb only through the input's own small container: stop at a form, the page body, or anything holding another
    // file input (the Resume field below Ashby's box shares <body> with the autofill text).
    let n=input,text='';for(let i=0;i<6&&n;i++){n=n.parentElement||n.getRootNode().host;if(!n||n.matches('form,body,html')||deep(n).length>1){text='';break;}text=(n.innerText||'').slice(0,400);if(/autofill/i.test(text))break;}
    if(/autofill/i.test(text)&&/resume|cv|résumé/i.test(text)){const id='af'+Date.now();input.setAttribute('data-ja-autofill',id);return id;}
   }
   return null;
  }).catch(()=>null);
  if(mark)return frame.locator(`[data-ja-autofill="${mark}"]`);
 }
 return null;
}
export async function setCheckedControl(frame,locator,checked) {
 if(await locator.isChecked()===checked)return;
 const identity=await locator.evaluate(el=>({id:el.id,name:el.name,value:el.value,type:el.type})).catch(()=>null);
 let input=locator;
 const settled=async()=>{input=await sameInput(frame,input,identity);if(!input)throw new Error('Checkbox or radio disappeared after the click');const first=await input.isChecked();
  // Amazon's first page drops the selection a moment later, when the follow-up question renders (16226): only a
  // selection that is still there after a short pause counts, otherwise the next strategy clicks it again.
  if(first!==checked)return first;
  await frame.waitForTimeout(450);
  input=await sameInput(frame,input,identity);if(!input)throw new Error('Checkbox or radio disappeared after the click');
  return input.isChecked();};
 // An ARIA-only radio/checkbox (SmartRecruiters <spl-radio>, lesson 439) spans its whole row; a click at its centre
 // lands on empty space. Click where the ring and label sit (the left edge), then try the keyboard (focus + Space).
 const ariaOnly=await input.evaluate(el=>!el.matches('input')&&['radio','checkbox'].includes(el.getAttribute('role'))).catch(()=>false);
 if(ariaOnly&&await input.isVisible()){
  const box=await input.boundingBox().catch(()=>null);
  await input.click({position:{x:Math.min(12,(box?.width??24)/2),y:(box?.height??20)/2},timeout:3000}).catch(()=>{});
  if(await settled()===checked)return;
  await input.focus().catch(()=>{});await input.press('Space').catch(()=>{});
  if(await settled()===checked)return;
 }
 if(await input.isVisible()){
  await input.setChecked(checked,{timeout:1500}).catch(()=>{});
  if(await settled()===checked)return;
 }
 // Workable: the aria-hidden native radio sits inside the visible [role=radio] toggle that owns the click.
 const toggle=input.locator('xpath=ancestor::*[@role="radio" or @role="checkbox"][1]');
 if(await toggle.count()===1&&await toggle.isVisible()){await toggle.click({timeout:3000}).catch(()=>toggle.evaluate(el=>el.click()));if(await settled()===checked)return;}
 const id=await input.getAttribute('id');
 const label=id?frame.locator(`label[for=${JSON.stringify(id)}]`):input.locator('xpath=ancestor::label[1]');
 const visual=label.locator('.apply-flow-input-checkbox__button');
 // Waymo 13548: a static Cookie consent modal intercepted the declaration label's click; click the label itself.
 if(await visual.count()===1&&await visual.isVisible())await clickPastCookieBanner(visual);
 else if(await label.count()===1&&await label.isVisible())await clickPastCookieBanner(label,{position:{x:8,y:8}});
 else await input.evaluate(el=>el.click());
 if(await settled()!==checked)throw new Error('Checkbox or radio did not retain the confirmed selection');
}
export async function fillAshbyChoice(frame,locator,value) {
 let buttons=locator.locator('.ashby-application-form-input-yesno button');
 if(!await buttons.count())buttons=locator.locator('button[role="radio"],button[aria-pressed]');  // Oracle cx-select-pills
 if(await buttons.count()){
  const labels=(await buttons.allTextContents()).map(t=>t.trim());
  const matches=labels.map((label,index)=>({label,index})).filter(o=>o.label===String(value));
  if(matches.length!==1)throw new Error('Choice answer does not match a unique offered choice');
  const button=buttons.nth(matches[0].index);await button.click();
  const pressed=async()=>(await button.getAttribute('aria-pressed'))==='true'||(await button.getAttribute('aria-checked'))==='true';
  for(let i=0;i<10&&!await pressed();i++)await sleep(150);
  if(!await pressed())throw new Error('Choice selection did not persist');
 }else{
  const radios=locator.locator('input[type="radio"],input[type="checkbox"]');
  const labels=await radios.evaluateAll(es=>es.map(e=>e.labels?.[0]?.innerText.trim()||e.value));
  const matches=labels.map((label,index)=>({label,index})).filter(o=>o.label===String(value));
  if(matches.length!==1)throw new Error('Ashby answer does not match a unique offered choice');
  await setCheckedControl(frame,radios.nth(matches[0].index),true);
 }
}
// An answer he approves is reused at every employer unless it is his own wording or names the
// employer it was written for; those stay with that employer (lesson 23).
export const shareable=(label,value,type,company='')=>sharedEligible(label,value,company,type);
const sameText=(a,b)=>String(a).replace(/\s+/g,' ').trim()===String(b).replace(/\s+/g,' ').trim();
// Typeahead dropdowns take no typed text: search, then click the one option that reads exactly
// as the approved answer. Otherwise report what was offered so he can pick one.
async function chosenOptions(locator){
 return locator.evaluate(el=>{const select=el.matches('.chosen-container')?el.previousElementSibling:null;return select?.matches('select.chosen-select')?[...select.options].filter(o=>o.value&&!o.disabled).map(o=>o.text):null;});
}
export async function pickChosenOption(locator,value){
 const options=await chosenOptions(locator);
 if(!options)return null;
 const matches=options.filter(o=>sameText(o,value));
 if(matches.length!==1)return{ok:false,options};
 await locator.locator('.chosen-single').click();
 const choices=locator.locator('.chosen-results li.active-result');
 const labels=(await choices.allTextContents()).map(s=>s.trim());
 const indexes=labels.map((s,i)=>sameText(s,matches[0])?i:-1).filter(i=>i>=0);
 if(indexes.length!==1)return{ok:false,options};
 await choices.nth(indexes[0]).click();
 const retained=await locator.evaluate(el=>({native:el.previousElementSibling.selectedOptions[0]?.text,shown:el.querySelector('.chosen-single span')?.innerText}));
 return{ok:sameText(retained.native,value)&&sameText(retained.shown,value),options,value:matches[0]};
}
async function comboOptions(frame,locator,query){
 const chosen=await chosenOptions(locator);if(chosen)return chosen;
 await locator.click();
 // ARIA comboboxes may be non-editable divs or buttons. Only search editable controls.
 const editable=await locator.evaluate(el=>el.matches('input,textarea')||el.isContentEditable);
 // Oracle CX grid dropdowns filter only on real keystrokes; a filled value leaves the whole
 // alphabetical list ("Aaronsburg, PA" first) for Howmet 11608's City and Postal Code.
 const keyed=editable&&await locator.evaluate(el=>el.classList.contains('cx-select-input')||el.getAttribute('aria-haspopup')==='grid');
 if(keyed){await locator.fill('');if(query)await locator.pressSequentially(String(query),{delay:40});}
 else if(editable)await locator.fill(query);
 let options=[];
 if(await locator.getAttribute('aria-expanded')==='false')await locator.press('ArrowDown');
 await sleep(400); // Let debounced searches replace the previous query's options.
 for(let i=0;i<80;i++){
  await sleep(250);
  options=await locator.evaluate(el=>{if(el.closest('.select')?.querySelector('[class*="loading-indicator"]'))return [];
   // SmartRecruiters one-click (Intuitive 12316, lesson 417): the City autocomplete's listbox sits in the input's shadow
   // root and each option is a <spl-dropdown-item> host whose text is slotted light DOM, so a document lookup found no
   // listbox and the options read as blank. Look through open shadow roots and read slotted text from the host.
   const visible=x=>x.getClientRects().length;
   // Its Country code menu slots the options in from the host's light DOM, so a <slot>'s assigned elements are searched too.
   const deep=(root,selector,out=new Set())=>{for(const node of root.querySelectorAll(selector))out.add(node);
    if(root.shadowRoot)deep(root.shadowRoot,selector,out);
    for(const node of root.querySelectorAll('*')){if(node.shadowRoot)deep(node.shadowRoot,selector,out);if(node.tagName==='SLOT')for(const assigned of node.assignedElements({flatten:true})){if(assigned.matches(selector))out.add(assigned);deep(assigned,selector,out);}}
    return [...out];};
   const id=el.getAttribute('aria-controls')||'';const root=el.getRootNode();
   const box=id?document.getElementById(id)||(root instanceof ShadowRoot?root.getElementById(id):null)||deep(document,'#'+CSS.escape(id))[0]:null;
   const scopes=box?[box]:deep(document,'[role=listbox]').filter(visible);
   const text=o=>(o.innerText||'').trim()||(o.getRootNode() instanceof ShadowRoot?(o.getRootNode().host.textContent||'').replace(/\s+/g,' ').trim():'');
   // A closed menu keeps its markers (the City list stays in the DOM hidden), so the Country code click would land on
   // a hidden City option first; clear every old marker before numbering this menu.
   for(const stale of deep(document,'[data-ja-option]'))stale.removeAttribute('data-ja-option');
   let n=0;return scopes.flatMap(s=>deep(s,'[role=option],[role=gridcell].cx-select__list-item')).filter(visible).map(o=>{o.setAttribute('data-ja-option',String(n++));return text(o);});});
  // Ford's Oracle City/ZIP grids (12857) filter on the server: for a few seconds after the keystrokes the menu still
  // shows the unfiltered alphabetical list, which was read as "no match" and sent to Approvals as 500 options. Wait
  // (up to 6 s) for a keyed search to show an option that contains what was typed (lesson 459).
  if(keyed&&query&&i<24&&options.length&&!options.some(o=>String(o).toLowerCase().includes(String(query).toLowerCase())))continue;
  if(options.length&&!options.every(o=>/^(loading|searching)/i.test(o)))break;
 }
 return options.filter(o=>o&&!/^(loading|searching|no options)/i.test(o));
}
 // Oracle Candidate Experience words choices its own way (Howmet 11608): "Goleta, CA" for a city,
// "93117, Goleta, CA" for a ZIP, "US Dollar" for USD, "Not a Protected Veteran" for his wording.
export function oracleWording(options,value,answers={}){
  const want=String(value).trim(),currency={USD:'US Dollar'}[want.toUpperCase()];
  // Map-search suggestions abbreviate the street type ("6671 Berkshire Ter, Goleta, CA").
  const street=v=>String(v).toLowerCase().replace(/\b(terrace|street|avenue|drive|court|road|lane|boulevard|place|circle)\b/g,w=>({terrace:'ter',street:'st',avenue:'ave',drive:'dr',court:'ct',road:'rd',lane:'ln',boulevard:'blvd',place:'pl',circle:'cir'})[w]).replace(/[.\s]+/g,' ').trim();
  const same=o=>sameText(String(o).split(',')[0].trim(),want)||/^\d+\s/.test(want)&&street(String(o).split(',')[0])===street(want)||currency&&sameText(o,currency)||sameText(String(o).toLowerCase(),want.replace(/^I am\s+/i,'').toLowerCase());
  const found=options.filter(same);if(found.length===1)return found[0];
  // Several places share his city's name ("Springfield, CA", "Springfield, MN", "Springfield, NY"; Honeywell
  // 11244's Oracle City list). The one in his saved state, by abbreviation or full name, is his.
  const state=String(answers?.addressState??'').trim();
  if(found.length>1&&state){
    const abbrev=US_STATE_NAMES[state.toUpperCase()]?state.toUpperCase():Object.keys(US_STATE_NAMES).find(k=>sameText(US_STATE_NAMES[k],state));const names=[state,abbrev,US_STATE_NAMES[abbrev]].filter(Boolean).map(n=>n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
    const inState=found.filter(o=>new RegExp(`(?:^|[\\s,])(?:${names.join('|')})(?:$|[\\s,])`,'i').test(String(o).split(',').slice(1).join(',')));
    if(inState.length===1)return inState[0];
    // One ZIP can list several place names ("00603, Aguadilla" and "00603, Ramey"): his saved city decides.
    const city=String(answers?.addressCity??'').trim();
    const inCity=city?(inState.length?inState:found).filter(o=>String(o).split(',').some(part=>sameText(part.trim(),city))):[];
    if(inCity.length===1)return inCity[0];
  }
  return null;
}
export async function pickOption(frame,locator,value,label='',answers={},job={}){
 const context=options=>({...job,confirmedAnswer:preferenceAnswer(label,answers,{...job,options})});
 const chosen=await chosenOptions(locator);if(chosen){const equivalent=equivalentOption(label,value,chosen,answers,context(chosen));return pickChosenOption(locator,equivalent??value);}
 const searches=/^(school|school or university)\s*\*?$/i.test(label)?[answers.schoolSearch]:/^discipline\s*\*?$/i.test(label)?[answers.major]:/^country\s*\*?$/i.test(label)?[answers.phoneCountry]:/^(location \(city\)|city)\s*\*?$/i.test(label)?[answers.citySearch||answers.city]:/race/i.test(label)&&answers.eeoRace==='Asian (Not Hispanic or Latino)'?['Asian']:[];
 let options=await comboOptions(frame,locator,searches.filter(Boolean)[0]??String(value));let equivalent=equivalentOption(label,value,options,answers,context(options));
 for(const query of searches.filter(Boolean).length&&searches[0]!==String(value)?[String(value)]:[])if(equivalent===null){options=await comboOptions(frame,locator,query);equivalent=equivalentOption(label,value,options,answers,context(options));}
 if(equivalent===null)equivalent=oracleWording(options,value,answers);
 // A search for "Yes" can hide "U.S. Citizen". Inspect the full menu for known facts.
 if(equivalent===null){options=await comboOptions(frame,locator,'');equivalent=equivalentOption(label,value,options,answers,context(options));}
 if(!options.some(o=>sameText(o,equivalent??value)))equivalent=oracleWording(options,value,answers)??equivalent;
 // The same place in the menu's own wording ("Springfield, CA, USA" for "Springfield, California, United States", lesson 438).
 if(!options.some(o=>sameText(o,equivalent??value)))equivalent=placeOption(options,equivalent??value)??placeOption(options,value)??equivalent;
 const match=options.map((o,i)=>[o,i]).filter(([o])=>sameText(o,equivalent??value));
 if(match.length!==1){if(await locator.evaluate(el=>el.matches('input,textarea')||el.isContentEditable))await locator.fill('').catch(()=>{});await locator.press('Escape').catch(()=>{});return{ok:false,options};}
 {const option=frame.locator(`[data-ja-option="${match[0][1]}"]`).first();
  // SmartRecruiters' animated menu can leave Playwright waiting for a "stable" option (Intuitive 12315/12316, lesson 432):
  // a forced click on the same option, then a direct element click; the selection is still verified afterwards.
  await option.click({timeout:5000}).catch(()=>option.click({force:true,timeout:3000})).catch(()=>option.evaluate(el=>el.click()));}await sleep(300);
 const retained=await locator.evaluate(el=>{const control=el.closest('[class*="control"]');const multi=Array.from(control?.querySelectorAll('[class*="multi-value__label"],[class*="multiValueLabel"]')??[]).map(e=>e.innerText);if(multi.length)return multi;
  const shown=control?.querySelector('[class*="single-value"]')?.innerText??(el.value||el.innerText);if(String(shown??'').trim())return [shown];
  // SmartRecruiters' Country code button (Intuitive 12316, lesson 417) shows its choice only inside shadow DOM: read the
  // option the closed menu now marks selected instead, by the same shadow/slot walk comboOptions uses.
  const deep=(root,selector,out=new Set())=>{for(const node of root.querySelectorAll(selector))out.add(node);if(root.shadowRoot)deep(root.shadowRoot,selector,out);
   for(const node of root.querySelectorAll('*')){if(node.shadowRoot)deep(node.shadowRoot,selector,out);if(node.tagName==='SLOT')for(const assigned of node.assignedElements({flatten:true})){if(assigned.matches(selector))out.add(assigned);deep(assigned,selector,out);}}
   return [...out];};
  const id=el.getAttribute('aria-controls')||'';const box=id?document.getElementById(id)||deep(document,'#'+CSS.escape(id))[0]:null;
  const selected=box?deep(box,'[role=option][aria-selected="true"]'):[];
  return selected.length?selected.map(o=>(o.innerText||'').trim()||(o.getRootNode() instanceof ShadowRoot?(o.getRootNode().host.textContent||'').replace(/\s+/g,' ').trim():'')):[shown];});
 // Some menus display a shortened choice after picking, as Greenhouse shows "+1" for "United States +1".
 const ok=retained.some(shown=>{const text=String(shown??'').trim();return Boolean(text)&&(sameText(text,equivalent??value)||String(equivalent??value).includes(text));});return{ok,options,value:equivalent??value};
}
// Greenhouse replaces its file input with the attached file's name once a file is chosen, so a
// vanished input is verified by that name on the page instead (lesson 63).
export async function resumeAttached(frame,locator,name,{wait=sleep,tries=15}={}){
 for(let attempt=0;attempt<tries;attempt++){
  const upload=await locator.evaluate(el=>{
   const group=el.closest('.file-upload[aria-labelledby^="upload-label-"]');
   if(!group)return null;
   return {error:group.querySelector('.helper-text--error')?.textContent?.trim(),
    accepted:group.querySelector('.file-upload__filename')?.textContent??'',busy:!!group.querySelector('[role="progressbar"]')};
  },null,{timeout:500}).catch(()=>null);
  if(upload?.error)return false;
  if(upload){if(!upload.busy&&upload.accepted.includes(name))return true;}
  else{
   const held=await locator.evaluate(el=>el.files?.length===1,null,{timeout:500}).catch(()=>null);
   if(held===true)return true;
   const accepted=await frame.locator('.file-upload__filename').allTextContents().catch(()=>[]);
   if(accepted.some(text=>text.includes(name)))return true;
   const body=await frame.locator('body').innerText().catch(()=>'');
   if(!await frame.locator('.file-upload[aria-labelledby^="upload-label-"]').count()&&body.includes(name))return true;
   // SmartRecruiters one-click (Intuitive 12315/12316): the drop zone is in a shadow root and shows the file name only
   // there; body.innerText skips shadow DOM, so also look with Playwright's shadow-piercing text match.
   if(!await frame.locator('.file-upload[aria-labelledby^="upload-label-"]').count()&&await frame.getByText(name,{exact:false}).count().catch(()=>0))return true;
   // Oracle Candidate Experience (NOV 13365): the "Import your profile" resume upload clears its input and
   // shows only "Profile successfully imported." without the file name.
   if(/\bprofile successfully imported\b/i.test(body))return true;
  }
  if(attempt+1<tries)await wait(500);
 }
 return false;
}
// An upload button that opens a source menu instead of a chooser: click its local-file item, never a cloud/social/paste one.
export async function openUploadMenuItem(page){
 const name=/^\s*(?:file|upload(?: a)? file|(?:upload )?from (?:my )?(?:device|computer)|my (?:device|computer)|local file|browse(?: files)?|attach(?: a)? file)\s*$/i;
 for(const frame of page.frames()){
  const items=frame.locator('[role=button],[role=menuitem],button,label,a').filter({hasText:name});
  for(let i=0;i<await items.count().catch(()=>0);i++){
   const item=items.nth(i);
   if(!await item.isVisible().catch(()=>false)||!name.test(await item.innerText().catch(()=>'')))continue;
   const chooser=page.waitForEvent('filechooser',{timeout:5000}).catch(()=>null);
   await item.click().catch(()=>{});
   const opened=await chooser;if(opened)return opened;
  }
 }
 return null;
}
// A hidden file input whose own label names the document (JazzHR: 'Resume*', 'If you have a portfolio, please upload it here...').
export async function setHiddenUpload(frame,kind,path){
 const pattern={resume:'r[eé]sum[eé]|\\bcv\\b',portfolio:'portfolio',transcript:'transcript','cover letter':'cover\\s*letter'}[kind];
 if(!pattern)return false;
 const ids=await frame.$$eval('input[type=file]',(els,source)=>els.filter(e=>{const text=(e.id&&document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.innerText)||e.getAttribute('aria-label')||e.name||'';
  return new RegExp(source,'i').test(text)&&!(source!=='r[eé]sum[eé]|\\bcv\\b'&&/r[eé]sum[eé]/i.test(text));}).map(e=>e.id).filter(Boolean),pattern).catch(()=>[]);
 if(ids.length!==1)return false;
 await frame.locator(`[id="${ids[0]}"]`).setInputFiles(path);
 return true;
}
// Empty file inputs that are not rendered at all (JazzHR's resume behind 'Attach resume') whose own label names a
// document we hold. Rendered inputs, Greenhouse's visually-hidden ones included, stay with the normal upload step.
export async function fillHiddenDocuments(frames,resumePath,documents={}){
 const filled=[];
 for(const frame of frames){
  const empties=await frame.$$eval('input[type=file]',els=>els.filter(e=>!e.files?.length&&e.id&&!e.offsetParent).map(e=>({id:e.id,label:(document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.innerText||e.getAttribute('aria-label')||'').trim()}))).catch(()=>[]);
  for(const {id,label} of empties){
   const doc=label&&uploadDocument(label,resumePath,documents);
   if(!doc?.path)continue;
   await frame.locator(`[id="${id}"]`).setInputFiles(resolve(ROOT,doc.path));
   filled.push({kind:doc.kind,label});
  }
 }
 return filled;
}
export function uploadDocument(label, resumePath, documents={}) {
 if(/r[eé]sum[eé]|curriculum|\bcv\b/i.test(label))return resumePath?{kind:'resume',path:resumePath}:null;
 if(/\btranscript\b/i.test(label)&&documents.transcript)return {kind:'transcript',path:documents.transcript};
 // A cover letter he approved for this posting, rendered by jobagent under his resume letterhead (request.documents).
 if(/cover\s*letter/i.test(label)&&documents.coverLetter)return {kind:'cover letter',path:documents.coverLetter};
 // A portfolio / work-samples upload takes the PDF print of his portfolio site (documents.portfolio).
 if(/portfolio|work samples?|design samples?/i.test(label)&&!/r[eé]sum[eé]/i.test(label)&&documents.portfolio)return {kind:'portfolio',path:documents.portfolio};
 return null;
}
export function reviewDigest(snap,resumeHash,answers){answers=[...answers].sort((a,b)=>String(a.label).localeCompare(String(b.label))||String(a.value).localeCompare(String(b.value)));return createHash('sha256').update(JSON.stringify({url:snap.url,controls:snap.frames.flatMap(f=>f.controls.filter(c=>!['button','submit','a'].includes(c.type)).map(c=>({label:c.label,type:c.type,value:c.value}))),resumeHash,answers})).digest('hex');}

const ACTION_SCHEMA={type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['fill','upload','click','ask','review','human']},control:{type:'string'},fact:{type:'string'},message:{type:'string'}},required:['action','control','fact','message']};
export const ENGINES=['claude','codex','agy','opencode'];
// Claude and Codex run through their CLIs on the applicant's subscription login. API keys are
// stripped from their environment so a stray key can never turn a step into a billed API call.
export function execCLI(command,args,input,{timeout=setting('worker.step_timeout_seconds',180)*1000,cwd,env:overrides={}}={}){
 return new Promise((resolveRun,reject)=>{
  const env={...process.env,...overrides,PATH:agentPath(process.env.PATH)};delete env.ANTHROPIC_API_KEY;delete env.OPENAI_API_KEY;delete env.CODEX_API_KEY;delete env.ANTHROPIC_AUTH_TOKEN;delete env.CLAUDE_CODE_USE_BEDROCK;delete env.CLAUDE_CODE_USE_VERTEX;
  delete env.TWOCAPTCHA_API_KEY;delete env.TWO_CAPTCHA_API_KEY;
  const child=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  const progress=cliTimeoutProgress();
  let timedOut=false,killTimer;
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),1000);},timeout);
  child.stdout.on('data',d=>{stdout+=d;progress.stdout(d);});child.stderr.on('data',d=>{stderr+=d;progress.stderr(d);});
  child.on('error',e=>{clearTimeout(timer);clearTimeout(killTimer);reject(new Error(`Could not start ${basename(command)}: ${e.message}`));});
  // The output received before the kill rides along (not in the message, which is logged): a CLI that printed
  // its whole final answer and then hung still answered (agy, Howmet 13039, lesson 367).
  child.on('close',code=>{clearTimeout(timer);clearTimeout(killTimer);if(timedOut){reject(Object.assign(new Error(`${basename(command)} did not answer within ${timeout/1000}s. ${progress.describe()}`),{code:'CLI_TIMEOUT',processClosed:true,progress:progress.summary(),stdout,stderr}));return;}resolveRun({code,stdout,stderr});});
  // A CLI that exits before draining its prompt makes the stdin write fail with EPIPE; unhandled,
  // that crashed the whole worker before its lock cleanup (Anduril 11394 run 9ef407d0).
  child.stdin.on('error',()=>{});
  child.stdin.end(input);
 });
}
const limitMessage=text=>/(?:usage|session|weekly|daily|rate) limit|limit reached|quota|too many requests/i.test(text);
async function decideClaude({command,model,prompt,execImpl,lean=false}){
 // Lean: the form instructions alone, no tools, MCP servers or settings files (step-mode.mjs).
 const args=lean?['-p','--output-format','stream-json','--verbose','--json-schema',JSON.stringify(ACTION_SCHEMA),'--system-prompt',INSTRUCTIONS,...LEAN_CLAUDE_ARGS]
  :['-p','--output-format','stream-json','--verbose','--json-schema',JSON.stringify(ACTION_SCHEMA),'--append-system-prompt',`${INSTRUCTIONS}\n${CAPABILITY_CONTEXT}`,...CLAUDE_CAPABILITIES,'--no-session-persistence'];
 if(model)args.push('--model',model);
 // Streamed events show whether a stalled step got past startup, so a startup-only stall can be replayed once.
 const {code,stdout,stderr}=await execWithStallRetry(execImpl,command||'claude',args,prompt,{cwd:lean?tmpdir():ROOT});
 let result;try{const output=stdout.trim().startsWith('[')?JSON.parse(stdout):stdout.split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));result=Array.isArray(output)?output.findLast(e=>e.type==='result'||e.structured_output)??(output.length===1?output[0]:undefined):output;}catch{result=null;}
 if(code!==0||!result||result.is_error){const text=`${result?.result??''} ${stderr}`;if(limitMessage(text))throw new Error(`Claude usage limit reached. ${text.trim().slice(0,300)} Wait for it to reset or switch the engine to Codex.`);throw new Error(`Claude CLI failed${result?.result?`: ${String(result.result).slice(0,200)}`:` (exit ${code})`}`);}
 const action=result.structured_output??JSON.parse(result.result);
 return{action,usage:{input_tokens:result.usage?.input_tokens??0,cache_read_input_tokens:result.usage?.cache_read_input_tokens??0,cache_creation_input_tokens:result.usage?.cache_creation_input_tokens??0,output_tokens:result.usage?.output_tokens??0}};
}
async function decideCodex({command,model,prompt,execImpl,lean=false}){
 const dir=await mkdtemp(join(tmpdir(),'jobagent-codex-'));
 try{
  await writeFile(join(dir,'schema.json'),JSON.stringify(ACTION_SCHEMA));
  // Keep the user's normal CLI configuration, skills and connected tools.
  const args=lean?['exec','--skip-git-repo-check','--ephemeral',...LEAN_CODEX_ARGS,'--output-schema',join(dir,'schema.json'),'--json','-C',dir]
   :['exec','--skip-git-repo-check','--ephemeral',...CODEX_CAPABILITIES,'--output-schema',join(dir,'schema.json'),'--json','-C',ROOT];
  if(model)args.push('-m',model);args.push('-');
  const {code,stdout,stderr}=await execCodexWithServiceRetry(execImpl,command||'codex',args,lean?`${INSTRUCTIONS}\n\n${prompt}`:`${INSTRUCTIONS}\n${CAPABILITY_CONTEXT}\n\n${prompt}`,{cwd:lean?dir:ROOT});
  const events=stdout.split('\n').flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
  const message=events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').at(-1)?.item?.text;
  const failure=events.find(e=>e.type==='turn.failed'||e.type==='error');
  if(code!==0||!message){const text=`${failure?.error?.message??failure?.message??''} ${stderr}`;if(limitMessage(text))throw new Error('Codex usage limit reached. Wait for it to reset or switch the engine to Claude.');throw new Error(`Codex CLI failed${text.trim()?`: ${text.trim().slice(0,200)}`:` (exit ${code})`}`);}
  // Codex's input_tokens already includes its cached_input_tokens; split them so cache reads are counted once.
  const usage=events.find(e=>e.type==='turn.completed')?.usage??{};
  return{action:JSON.parse(message),usage:{input_tokens:Math.max(0,(usage.input_tokens??0)-(usage.cached_input_tokens??0)),cache_read_input_tokens:usage.cached_input_tokens??0,output_tokens:(usage.output_tokens??0)+(usage.reasoning_output_tokens??0)}};
 }finally{await rm(dir,{recursive:true,force:true});}
}
async function decideOpenCode({command,model,prompt,execImpl}){
 if(!model||!String(model).includes('/'))throw new Error('OpenCode needs a provider/model selection');
 const config=JSON.stringify({agent:{jobagent:{mode:'primary',tools:{'*':false},permission:{'*':'deny'}}}});
 const {code,stdout,stderr}=await execImpl(command||'opencode',['run','--standalone','--agent','jobagent','--model',model,'--format','json'],`${INSTRUCTIONS}\n${CAPABILITY_CONTEXT}\nReturn only the requested JSON action.\n\n${prompt}`,{cwd:ROOT,env:{OPENCODE_CONFIG_CONTENT:config}});
 const events=stdout.split('\n').flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
 const text=events.flatMap(e=>[e.part?.text,e.text,Array.isArray(e.message?.content)?e.message.content.map(p=>p.text||'').join(''):null].filter(Boolean)).filter(Boolean).at(-1)||'';
 const json=text.match(/\{[\s\S]*\}/)?.[0];
 if(code!==0||!json){const failure=events.find(e=>e.type==='error')?.error;const why=`${stderr.trim()} ${failure?.message??''} ${text}`.trim();throw Object.assign(new Error(`OpenCode failed${why?`: ${why.slice(0,220)}`:''}`),{limit:limitMessage(why)||/free-limit|free usage limit/i.test(`${failure?.type??''} ${why}`)});}
 const action=JSON.parse(json);
 if(!ACTION_SCHEMA.properties.action.enum.includes(action.action)||typeof action.control!=='string')throw new Error('OpenCode returned an invalid application action');
 const finish=[...events].reverse().find(e=>e.type==='step_finish'||e.type==='turn.completed')||{};
 const tokens=finish.tokens||finish.usage||{};
 return {action,usage:{input_tokens:tokens.input??tokens.input_tokens??0,cache_read_input_tokens:tokens.cache?.read??tokens.cached_input_tokens??0,cache_creation_input_tokens:tokens.cache?.write??0,output_tokens:tokens.output??tokens.output_tokens??0},via:`opencode:${model}`};
}
export async function decide({engine='codex',command,model,snap,profile,bank,job,history,context={},execImpl=execCLI}){
 const decisionBank=decisionAnswerBank(bank,snap,job,context.approvedAnswers);
 const input=JSON.stringify({job:{id:job.id,url:job.url,company:job.company,title:job.title,location:job.location,salaryMin:job.salaryMin,salaryMax:job.salaryMax,salary:job.salary},confirmedAnswers:{...availableFacts(profile,job.company),...(salaryExpectation(profile.answers,job)!==null?{minimumAnnualSalary:salaryExpectation(profile.answers,job)}:{})},approvedQuestionAnswers:decisionBank.answers,supersededAnswerAliases:decisionBank.supersededAnswerAliases,confirmedDocuments:Object.keys(profile.documents??{}),page:snap,recentActions:history.slice(-8),...(context.siteHints?.length?{siteHints:context.siteHints.map(h=>h.text)}:{}),...applicationDecisionContext({job,history,artifactRoot:join(ROOT,'artifacts'),...context})});
 // At the engine's plan limit the step goes to agy's models in turn until the engine resets (model-fallback.mjs).
 if(engine==='opencode'){
  const result=await decideOpenCode({command,model,prompt:input,execImpl});
  return {...result,usage:{...result.usage,via:result.via}};
 }
 if(engine==='claude'||engine==='codex'||engine==='agy'){
  const lean=leanStep(history);
  const result=await withAgyFallback(engine,
  ()=>engine==='claude'?decideClaude({command,model,prompt:input,execImpl,lean}):decideCodex({command,model,prompt:input,execImpl,lean}),
  agyModel=>decideAgy({model:agyModel,prompt:input,system:INSTRUCTIONS,schema:ACTION_SCHEMA,execImpl}),{log:context.log,onModel:context.onModel,
   openCodeModels:async()=>{try{const result=await execImpl('opencode',['models'],'',{cwd:ROOT,timeout:15000});return result.code===0?result.stdout.split('\n').map(line=>line.trim()).filter(line=>line.includes('/')):[];}catch{return[];}},
   viaOpenCode:openCodeModel=>decideOpenCode({command:'opencode',model:openCodeModel,prompt:input,execImpl})});
  return {...result,usage:{...result.usage,via:result.via??`${engine}:${model||'default'}${lean?':lean':''}`}};
 }
 throw new Error(`Unsupported engine ${engine}; choose a configured Claude, Codex, agy, or OpenCode model. Direct API calls are disabled.`);
}
// The same CLI and fact validator serve unknown questions on every platform.
export function resolveKnownQuestion({question,profile,bank={},job={}}){
 if(routineQuestionNeedsReview(question.label??question.question)){
  const key=questionId(question.label??question.question),value=bank[key]?.answer;
  return typeof value==='string'&&value.trim()?{resolved:true,value,fact:`bank:${key}`,usage:{}}:{resolved:false,usage:{}};
 }
 if(appliedRoleQuestion(question.label??question.question))return job.title?.trim()?{resolved:true,value:job.title.trim(),fact:'job.title',usage:{}}:{resolved:false,usage:{}};
 if(internshipCompensationQuestion(question.label??question.question,job))return {resolved:false,usage:{}};
 const regional=regionalAnswer(question.label??question.question,profile,job);if(regional)return regional.value?{resolved:true,value:regional.value,fact:regional.key,usage:{}}:{resolved:false,usage:{}};
 job={...job,history:profile.workHistory??[],options:question.options};
 const control={id:'question',label:question.label??question.question,type:question.type??'text',required:Boolean(question.required),value:''};
 if(question.options?.length)control.options=question.options.map(o=>typeof o==='string'?{label:o,value:o}:o);
 const known=preferenceAnswer(control.label,profile.answers,{...job,bank});
 let saved=known?.key==='fullName'&&/current date/i.test(control.label)?undefined:lookupAnswer(bank,control.label);
 if(known&&(known.authoritative||confirmedFactIsNewer(known.key,profile,saved)))saved=undefined;
 if(saved){
  const value=control.options?equivalentOption(control.label,saved.answer,control.options.map(o=>o.label),profile.answers,job):saved.answer;
  if(value!==null&&value!==undefined&&String(value).trim())return {resolved:true,value:String(value),fact:`bank:${questionId(control.label)}`,usage:{}};
 }
 if(known){
  const options=control.options?.map(o=>o.label);
  const value=options?options.find(o=>(known.candidates??[known.value]).some(c=>c instanceof RegExp?c.test(String(o)):String(c).toLowerCase()===String(o).toLowerCase()))??equivalentOption(control.label,known.value,options,profile.answers,{...job,confirmedAnswer:known}):known.value;
  return value===null?{resolved:false,confirmedAnswerNotOffered:true,confirmed:{key:known.key,value:known.value},usage:{}}:{resolved:true,value:String(value),fact:known.key,usage:{}};
 }
 return {resolved:false,usage:{}};
}
export async function resolveUnknownQuestion({question,profile,bank,job,engine,command,model,execImpl=execCLI}){
 const known=resolveKnownQuestion({question,profile,bank,job});
 if(known.resolved)return known;
 // A confirmed answer the employer words differently is mapped onto its options, not re-asked.
 const mapOption=confirmed=>mapConfirmedOption({label:question.label??question.question,options:question.options,confirmed,
  facts:{...availableFacts(profile,job.company),...Object.fromEntries(Object.entries(bank??{}).map(([k,v])=>[`bank:${k}`,v?.answer]))},job,...helperAgent({engine,command,model}),execImpl,cwd:ROOT});
 if(known.confirmedAnswerNotOffered){const mapped=await mapOption(known.confirmed);return mapped.resolved?{...mapped,usage:{}}:known;}
 job={...job,history:profile.workHistory??[],options:question.options};
 const control={id:'question',label:question.label??question.question,type:question.type??'text',required:Boolean(question.required),value:''};
 if(question.options?.length)control.options=question.options.map(o=>typeof o==='string'?{label:o,value:o}:o);
 const {action,usage}=await decide({engine,command,model,profile,bank,job,execImpl,
  snap:{url:job.url,frames:[{frameIndex:0,text:'Resolve this unfamiliar question using confirmed facts or approved wording. Ask if no supported answer exists.',controls:[control]}]},history:[]});
 if(action.action!=='fill'||action.control!==control.id)return {resolved:false,usage};
 let value;try{value=approvedValue(action,control,profile,bank,new Map(),job.company,job);}catch{return {resolved:false,usage};}
 if(value===undefined||value===null||String(value).trim()==='')return {resolved:false,usage};
 if(control.options){
  const option=control.options.find(o=>String(o.label).toLowerCase()===String(value).toLowerCase()||String(o.value).toLowerCase()===String(value).toLowerCase());
  let equivalent=option?.label??equivalentOption(control.label,value,control.options.map(o=>o.label),profile.answers,job);
  if(equivalent===null){const mapped=await mapOption({key:action.fact,value});if(!mapped.resolved)return {resolved:false,usage};equivalent=mapped.value;}
  value=equivalent;
 }
 return {resolved:true,value:String(value),fact:action.fact,usage};
}
// A run he asked to finish himself stays open after his own Submit: a Lever verification
// rejection must be retryable in the same window. Only a worker click closes it (Shield AI 10277).
export const keepHandoffOpen=({request,submitted,manualSubmissionAt})=>request?.handoffOnFailure===true&&(!submitted||Boolean(manualSubmissionAt));
// A challenge the solver could not pass BEFORE any Submit (iCIMS's email-first login hCaptcha, Rivian, lesson 451) is
// handed to him in a visible Chrome, as one at Submit is: nothing has been sent, and the step model can never pass it.
// Not in his own finish-yourself run (that run already waits for him) and never once anything was submitted.
// Wait until the page shows a link, button or field (a hydrating single-page app shows only a heading and spinner at first).
export async function waitForPageControls(page,{timeout=30000}={}){
 await page.waitForLoadState('networkidle',{timeout:Math.min(timeout,10000)}).catch(()=>{});
 return page.waitForFunction(()=>Boolean(document.querySelector('input:not([type=hidden]),button,select,textarea,a[href*=apply i],a[href*=application i]')),{},{timeout}).then(()=>true,()=>false);
}
export const realChromeRun=request=>request?.realChrome===true&&request?.humanFinish!==true;
export const preSubmitCaptchaHandoff=({request,submitted,free})=>request?.humanFinish!==true&&!submitted&&!free?.completed&&!free?.wall;
// Applicant-viewed runs may use installed Chrome (APPLICATION_AGENT_CHANNEL=chrome); unattended runs never do.
export const handoffChannel=(headless,env=process.env)=>headless?undefined:env.APPLICATION_AGENT_CHANNEL||undefined;
// After a run: score the hints its steps saw (fast, here), then learn new ones in a detached helper so
// this worker exits at once and JobAgent frees its slot (tools/learn-site-hints.mjs, site-hints.mjs).
export async function finishSiteHints(runDir,hintRun,state,{path=HINTS_PATH,spawnImpl=spawn}={}){
 if(!path)return;
 await scoreHints(hintRun.used,outcomeDelta(state),{path});
 if(!setting('worker.site_hints',true)||hintRun.history.length<4||['stopped','skipped','running'].includes(state.status))return;
 await atomic(join(runDir,'site-hints-run.json'),{engine:hintRun.engine,command:hintRun.command,model:hintRun.model,steps:hintRun.steps,
  history:hintRun.history.slice(-30).map(h=>({action:h.action,control:h.control}))});
 const child=spawnImpl(process.execPath,[join(ROOT,'tools/learn-site-hints.mjs'),runDir],{cwd:ROOT,detached:true,stdio:'ignore'});
 child.unref?.();
}
export async function runWorker(runDir,{accountRoot,execImpl=execCLI,headless=true,stateRoot=join(ROOT,'state'),allowLocalFixture=false}={}){
 runDir=resolve(runDir);await mkdir(runDir,{recursive:true,mode:0o700});
 let hintRun=null;
 let visibleAuto=false;
 let directEndpoint=null,directShared=false;
 let state={status:'running',phase:'starting',message:'Opening application',questions:[],events:[],usage:{input_tokens:0,output_tokens:0},model_usage:{}},live,browser,context,page,timer,shotBusy=false,stopping=false,submitted=false,jobLock,companyLock,jobStatePath,leverMonitor,manualSubmissionAt,prepareGreenhouseUpload,relayChrome=false,unhide,leverPosted=false;
 const save=async(extra={})=>{state={...state,...extra,updated_at:new Date().toISOString(),url:page?.url()??state.url};await atomic(join(runDir,'state.json'),state);};
 const event=async(message,extra={})=>{state.events=[...state.events.slice(-79),{time:new Date().toISOString(),message}];await save({message,...extra});};
 const seen=new Set();
 const command=async()=>{const cmd=await readJSON(join(runDir,'commands.json'),null);if(!cmd?.id||seen.has(cmd.id))return null;seen.add(cmd.id);await unlink(join(runDir,'commands.json')).catch(()=>{});if(cmd.action==='stop'){stopping=true;throw new Error('Stopped by applicant');}return cmd;};
 const wait=async(predicate)=>{while(!stopping){const cmd=await command();if(cmd&&await predicate(cmd))return cmd;await sleep(350);}throw new Error('Stopped by applicant');};
 let tabClosed=false;
 const stop=()=>{stopping=true;browser?.close().catch(()=>{});};process.on('SIGTERM',stop);process.on('SIGINT',stop);
 try{
  const request=await readJSON(join(runDir,'request.json'));const {job}=request;
  if(request.headlessOnly===true)headless=true;
  if(/\bgoogle\b/i.test(job.company)||/(^|\.)google\.com$/i.test(new URL(job.url).hostname))throw new Error('Google applications are paused');
  // A stored link that is itself a sign-in page (Freeform 13281: my.greenhouse.io/users/sign_in) never opens an application; stop before any browser or field.
  job.url=icimsPostingUrl(job.url)??job.url;
  const signInPage=signInPagePostingUrl(job.url);
  if(signInPage){await event(`Job ${job.id} (${job.company}, ${job.title}) has a bad URL: ${signInPage}. Replace the stored link with the employer's own posting URL (for Greenhouse, its job-boards.greenhouse.io address) and queue it again. Nothing was opened or filled.`,{status:'needs_human',phase:'needs_human',questions:[],review:null});return;}
  await validatePublicURL(job.url,allowLocalFixture,{
   onRetry:({host,code,attempt,delay})=>event(`Application host lookup failed (${code}) for ${host}; DNS retry ${attempt}/2 in ${delay/1000}s.`,{phase:'starting'}),
   onRecovered:({host})=>event(`Application host lookup recovered for ${host}; opening application.`,{phase:'starting'}),
  });
  const profile=regionalProfile(await readJSON(resolve(request.profilePath)),job);profile.documents={...profile.documents,...request.documents};const resumePath=resolve(ROOT,request.resumePath??profile.resumePath);const resumeHash=createHash('sha256').update(await readFile(resumePath)).digest('hex');
  // Lever, in his Chrome (lessons 418-419): Lever refuses the first Submit of a page with "There was an error verifying
  // your application" and clears the resume field; re-attaching and submitting again in the same page is accepted (Zoox
  // 10953 and 6542). Who uploads the resume made no difference, so the worker still attaches it; Finder shows him the
  // tailored copy for the retry. leaveResume (no upload at all) stays available for a future test.
  const leverHandoff=request.humanFinish===true&&new URL(job.url).hostname==='jobs.lever.co';
  const leaveResume=leverHandoff&&request.leaveResume===true,uploadResume=leaveResume?null:resumePath;
  // What the Lever hand-off watcher saw, recorded the way a submission is (accepted) or left for him (anything else).
  const leverHandoffOutcome=async watched=>{
   if(watched.status==='accepted'){
    const at=new Date().toISOString();
    await atomic(jobStatePath,{...(await readJSON(jobStatePath,{})),status:'submitted_pending_receipt',submittedAt:at,leverAcceptedBy:watched.by,confirmationUrl:watched.url??null,updatedAt:at});
    await event(`Lever accepted the application${watched.by==='his_submit'?'':' on the retry'}${watched.url?` (${watched.url})`:''}. The receipt email confirms it.`,{status:'submitted_pending_receipt',phase:'submitted',submitted:true,submission_attempted:true,questions:[],review:null,webpageEvidence:watched.url?{url:watched.url,at}:undefined});
    return;
   }
   const reasons={refused:'Lever refused the retry as well; nothing was received. Use Finish in my Chrome again later.',challenge:'The retry showed a CAPTCHA that was not finished.',closed:'The window was closed before Lever answered.',timeout:'No Submit was seen in 45 minutes.',no_response:watched.reason||'Lever gave no answer to the retry.',not_retried:watched.reason||'The retry could not be made.'};
   const uncertain=watched.status==='no_response';
   await event(`${reasons[watched.status]||watched.status}${uncertain?' Check for a Lever receipt before trying again.':''}`,{status:'needs_human',phase:uncertain?'verification':'human_submit',submission_attempted:uncertain,submitted:false,questions:[],review:null});
  };
  const bankDir=join(dirname(resolve(request.profilePath)),'companies');const {answers:bank}=await loadAnswers(bankDir,job.company);
  // Some earlier sessions used shared.json rather than the canonical shared slug.
  const legacy=await readJSON(join(bankDir,'shared.json'),{answers:{}});for(const [k,v]of Object.entries(legacy.answers??{}))if(!bank[k])bank[k]=v;
  const stateDir=stateRoot;await mkdir(stateDir,{recursive:true,mode:0o700});
  const id=`jobagent-${String(job.id).replace(/[^a-zA-Z0-9_-]/g,'_')}`;jobStatePath=join(stateDir,id+'.json');
  const old=await readJSON(jobStatePath,{});if(['submitted','submitted_pending_receipt','submitting','submission_unknown','needs_human_verification','awaiting_verification_code','awaiting_human_submit'].includes(old.status)&&!(request.humanFinish===true&&['awaiting_human_submit','needs_human_verification'].includes(old.status)))throw new Error(`Existing ${old.status} application: reconcile before retrying`);
  jobLock=await acquireLock(join(stateDir,id+'.lock'));
  const companySlug=job.company.toLowerCase().replace(/[^a-z0-9]+/g,'-');companyLock=await acquireLock(join(stateDir,`dashboard-company-${companySlug}.lock`));
  const submissions=[];for(const file of await readdir(stateDir)){if(!file.endsWith('.json'))continue;const s=await readJSON(join(stateDir,file),{});if(s.submittedAt)submissions.push(s);if(s.canonicalUrl===job.url&&['submitting','submitted','submitted_pending_receipt','submission_unknown'].includes(s.status))throw new Error('This posting already has an application attempt');}
  // Limits he allowed on the JobAgent Approvals page are enforced like the ones in his profile.
  profile.policy={...profile.policy,applicationCaps:{...(profile.policy?.applicationCaps??{}),...(request.applicationCaps??{})}};
  const checkCap=()=>{const cap=capExceeded(job.company,profile.policy,submissions);if(cap)throw new Error(`Employer application cap reached until ${cap.nextEligible}`);};checkCap();
  const engine=request.engine??'codex';if(!ENGINES.includes(engine))throw new Error(`Unknown engine ${engine}`);
  const helper=helperAgent({engine,command:request.command,model:request.model});  // mailbox and verification: never agy

  // A posting that showed a CAPTCHA before, or whose board challenges at Submit, runs in the hidden relay
  // Chrome (the supplied CAPTCHA package's design; his 2026-10-24 change to the headless rule): a plain
  // Chrome, hidden and off-screen, whose extensions answer the challenge. It stays hidden, so no hand-off.
  visibleAuto=false;
  if(request.humanFinish!==true&&!realChromeRun(request)&&!allowLocalFixture&&process.env.CAPTCHA_RELAY_CHROME!=='0'&&(captchaLikely(job.url)||await captchaSeen(stateDir,job.url))){relayChrome=true;headless=true;await event('This posting showed a CAPTCHA before, or its board challenges at Submit; filling it in the hidden relay Chrome, where the CAPTCHA package\'s extensions solve it.');}
  // His choice (2026-11-10, lesson 452): sites whose edge refuses every automated headless browser but lets a real Chrome
  // through (Tesla's Akamai) run in the hidden relay Chrome (JobAgent setting workers.real_chrome_hosts).
  // Changed the same day (lesson 460): Tesla's edge then refused the hidden relay Chrome too (403) but not his visible
  // application Chrome, and he wants these filled and submitted by the agent: the run uses that visible Chrome and,
  // unlike a finish-yourself run, submits by itself.
  else if(realChromeRun(request)&&!allowLocalFixture){visibleAuto=true;headless=false;await event('This site refuses hidden browsers; filling and submitting it in your visible Chrome.');}
  if(request.humanFinish===true||visibleAuto){
   // He finishes this one himself: a plain Chrome he will submit from, filled over its DevTools port (human-chrome.mjs).
   // No CAPTCHA extensions in his window: he solves it himself, and their frame scripts and the relay worker's
   // debugger on hCaptcha's frame are tells (Zoox 10953 was refused after his own solve, 2026-11-01).
   headless=false;const humanEndpoint=await launchHumanChrome(join(ROOT,'private/human-chrome'),{marker:basename(runDir),extensions:[]});browser=await chromium.connectOverCDP(humanEndpoint);if(request.directControl===true){directEndpoint=humanEndpoint;directShared=true;}context=browser.contexts()[0]??await browser.newContext();
  }else if(relayChrome){
   const relayProfile=join(ROOT,'private/relay-chrome');unhide=keepHidden(relayProfile);
   const relayEndpoint=await launchRelayChrome(relayProfile,{marker:basename(runDir)});browser=await chromium.connectOverCDP(relayEndpoint);if(request.directControl===true){directEndpoint=relayEndpoint;directShared=true;}context=browser.contexts()[0]??await browser.newContext();
  }else{
   // Direct control (lesson 482): the run's own headless browser also listens on a local DevTools port so one
   // Claude session can drive it. Loopback only, a fresh port per run, closed with the browser.
   const directPort=request.directControl===true&&headless?await freePort().catch(()=>null):null;
   browser=await chromium.launch({headless,channel:handoffChannel(headless),...(directPort?{args:[`--remote-debugging-port=${directPort}`,'--remote-debugging-address=127.0.0.1']}:{})});context=await applicationContext(browser);
   if(directPort)directEndpoint=`http://127.0.0.1:${directPort}`;
  }
  // a page dialog that closes itself must not crash the worker (dialog-guard.mjs). Phenom (Genentech 14640) reports
  // a missing resume only in a browser alert on Next; dismissed unseen, Next "did nothing", so the text is logged.
  guardDialogs(context,message=>{if(!message)return;const text=message.replace(/\s+/g,' ').slice(0,200);event(`The page showed an alert (dismissed): ${text}`).catch(()=>{});try{history.push({action:'page alert dismissed',control:text});}catch{}});
  // Reuse only the tenant session explicitly saved by the existing sign-in tool.
  const host=new URL(job.url).hostname;const tenant=host.split('.')[0];if(host.endsWith('.myworkdayjobs.com')){const session=await readJSON(join(ROOT,'private/workday-sessions',tenant+'.json'),null);if(session){const cookies=Array.isArray(session)?session:session.cookies;if(cookies)await context.addCookies(cookies);}}
  await context.route('**/*',async route=>{if(route.request().isNavigationRequest()){try{await validatePublicURL(route.request().url(),allowLocalFixture);}catch{return route.abort();}}return route.continue();});
  // In his Chrome the worker fills the tab Chrome opened itself: disconnecting later leaves that tab, and what was typed, in place.
  page=(request.humanFinish===true||relayChrome||visibleAuto)?context.pages().find(p=>p.url().endsWith('#'+basename(runDir))):await context.newPage();if(!page)throw new Error('Chrome did not open a tab for this application');
  // In a real Chrome text is typed key by key after a humanlike click (human-input.mjs installHumanTyping).
  // ...and files and dropdowns arrive with trusted events, as his do (installTrustedInput, lesson 423).
  if(request.humanFinish===true||relayChrome||visibleAuto){installHumanTyping(page.locator('body').constructor);installTrustedInput(page.locator('body').constructor);}
  // A tab in a real Chrome can be closed outside the worker (lesson 462); remember it so the failure says so.
  if(request.humanFinish===true||relayChrome||visibleAuto){const tab=page;tab.on('close',()=>{if(page===tab)tabClosed=true;});}
  page.setDefaultTimeout(10000);prepareGreenhouseUpload=monitorGreenhouseUploads(page);
  // Observe before any applicant interaction, including a normal manual click
  // made while preparation is still in progress.
  if(new URL(job.url).hostname==='jobs.lever.co')leverMonitor=monitorLeverSubmission(page,job,{onRequest:evidence=>{leverPosted=true;if(!submitted){submitted=true;manualSubmissionAt=evidence.startedAt;}return atomic(join(runDir,'lever-submission-request.json'),evidence);},onEvidence:evidence=>atomic(join(runDir,'lever-submission-response.json'),evidence)});
  // The dashboard preview is live: a screencast writes each repaint. A still screenshot fills in
  // at the start, after key clicks, and whenever the screencast has gone quiet.
  live=await startLiveView(context,page,join(runDir,'screenshot.jpg'));
  const screenshot=async()=>{if(shotBusy||!page||page.isClosed())return;shotBusy=true;try{const shot=await page.screenshot({type:'jpeg',quality:65,timeout:5000,mask:page.frames().map(f=>f.locator('input[type=password]'))});if(live?.put)await live.put(shot);else await atomic(join(runDir,'screenshot.jpg'),shot);}catch{}finally{shotBusy=false;}};
  let documentStatus,documentLoads=0; page.on('response', response => {if(response.request().isNavigationRequest() && response.frame()===page.mainFrame()) {documentStatus=response.status();documentLoads++;}});
  timer=setInterval(()=>{if(Date.now()-(live?.lastFrameAt??0)>4000)screenshot();},2000);const openingResponse=await page.goto(workableApplicationURL(job.url),{waitUntil:'domcontentloaded',timeout:45000});
  // Where the posting itself redirected on opening is the posting's site too (ArcBest 12717: Avature to careers.arcb.com).
  const postingURLs=[job.url,page.url()];
  // One Claude session fills the page it is given (sign-in included) and stops before Submit; the loop below then
  // attaches the resume, flags what nobody has decided, validates and submits as before (direct-control.mjs).
  const directPages=new Set();
  const directPass=async()=>{
   const work=await mkdtemp(join(tmpdir(),'direct-control-'));
   try{
    const account=passwordAllowedOn(page.url(),postingURLs)?await accountFor(page.url(),{email:profile.answers?.email,...(accountRoot?{root:accountRoot}:{})}):null;
    const model=request.directModel||(/^claude-/.test(request.model??'')?request.model:'claude-sonnet-5-5');
    await event('Direct control: one Claude session is filling this page');
    // The browser tools read files only inside the session's own folder: the run's resume (the tailored copy when
    // there is one) and his registered documents are copied there under their real names.
    const sessionResume=join(work,basename(resumePath));await copyFile(resumePath,sessionResume);
    const sessionDocuments={};
    for(const [kind,path] of Object.entries(profile.documents??{})){
     if(typeof path!=='string'||!path)continue;
     const target=join(work,basename(path));
     if(await copyFile(resolve(ROOT,path),target).then(()=>true,()=>false))sessionDocuments[kind]=target;
    }
    const session=await runDirectSession({endpoint:directEndpoint,workDir:work,model,password:account?.password??null,timeoutMs:setting('worker.direct_control_timeout_seconds',300)*1000,
     prompt:drivePrompt({url:page.url(),company:job.company,title:job.title,facts:availableFacts(profile,job.company),approved:approvedForSession(bank),signIn:account?{email:account.email}:null,mode:'worker',sharedBrowser:directShared,resumePath:sessionResume,documents:sessionDocuments})});
    await writeFile(join(runDir,`direct-session-${directPages.size}.jsonl`),session.lines.join('\n'),{mode:0o600}).catch(()=>{});
    if(session.usage){
     const via=`claude:${model}:direct`,u=session.usage,m=state.model_usage[via]??{calls:0,input_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:0};
     m.calls++;for(const k of ['input_tokens','cache_read_input_tokens','cache_creation_input_tokens','output_tokens'])m[k]+=u[k]??0;state.model_usage[via]=m;
     state.usage.input_tokens+=(u.input_tokens??0)+(u.cache_read_input_tokens??0)+(u.cache_creation_input_tokens??0);state.usage.output_tokens+=u.output_tokens??0;
    }
    if(session.isError){await event(`Direct control did not finish (${session.error??'no result'}); continuing step by step`);return false;}
    const open=(session.answer?.unanswered??[]).map(q=>String(q?.question??'').slice(0,80)).filter(Boolean);
    await event(`Direct control: ${session.answer?.filled?.length??0} answers in ${Math.round(session.seconds)}s (${session.toolCalls} browser actions)${session.answer?.createdAccount?', created the account':session.answer?.signedIn?', signed in':''}${open.length?`; left for review: ${open.slice(0,4).join(' | ')}`:''}${session.answer?.stoppedBecause&&!/ready for review/i.test(session.answer.stoppedBecause)?`; stopped: ${String(session.answer.stoppedBecause).slice(0,120)}`:''}`);
    return true;
   }catch(error){await event(`Direct control failed (${String(error.message).split('\n')[0].slice(0,120)}); continuing step by step`);return false;}
   finally{await rm(work,{recursive:true,force:true}).catch(()=>{});}
  };
  if(await greenhousePostingUnavailable(job.url,openingResponse)){
   await screenshot();
   await event('Posting unavailable: Greenhouse redirected this exact job to its missing-job error page.',{status:'skipped',phase:'skipped',posting_unavailable:true,questions:[],review:null});return;
  }
  // Amazon's public posting page says 404 for a removed requisition before any A to Z sign-in (11845).
  const amazonGone=await amazonPostingClosedPublicly(job,{fetch:url=>page.request.get(url,{maxRedirects:0,timeout:15000})});
  if(amazonGone){await screenshot();await event(`Posting unavailable: ${amazonGone}`,{status:'skipped',phase:'skipped',posting_unavailable:true,questions:[],review:null});return;}
  // A posting answering 404 while the employer's own careers root serves a maintenance page is a site-wide outage, not a removed
  // posting (Hyundai HATCI 15771, lesson 475): the queue cools the role down instead of asking him for a working URL.
  const outage=await siteMaintenanceOutage(job,{status:openingResponse?.status(),fetch:url=>page.request.get(url,{maxRedirects:3,timeout:15000})});
  if(outage){await screenshot();await event(`Site unavailable: ${outage} The queue will retry after a cooldown.`,{status:'blocked',phase:'blocked',questions:[],review:null});return;}
  if(request.readySelector)await page.locator(request.readySelector).first().waitFor({state:'visible',timeout:45000});
  await screenshot();
  const inline=new Map(),history=[],answered=[],scriptAttempts=new Set(),regionalAttempts=new Set(),employerAttempts=new Set();let stepModel=request.model,submitFixes=0;let resumeUploaded=false,authAttempts=0;
  // Site hints the step model sees, and which site took the steps, for learnFromRun after the run (site-hints.mjs).
  hintRun={engine,command:request.command,model:request.model,history,used:{},steps:{}};
  // With parkQuestions, a question nobody has answered is flagged rather than waited on: the run
  // collects what it can, ends before leaving the page, and frees its slot for the next role.
  // Answers he approves come back in approvedAnswers on the next run and go into the bank.
  const park=request.parkQuestions===true,deferred=[],ignoredOptional=new Set();
  const approvedNow=(request.approvedAnswers??[]).filter(a=>a?.question&&String(a.answer??'').trim()&&!placeholderAnswer(a.answer));
  if(approvedNow.length){await learnApprovals(bankDir,job.company,approvedNow.map(a=>({...a,answer:String(a.answer)})),String(job.id));for(const a of approvedNow){inline.set(questionId(a.question),String(a.answer));bank[questionId(a.question)]={...a,answer:String(a.answer)};}}
  // A flagged question's twin control (SuccessFactors renders the "How did you hear" dropdown as a button beside the
  // starred label, Hyundai 11914) carries the same question id; acting on either one means the page needs him now.
  const flagged=label=>deferred.some(d=>d.label===label||d.id===questionId(label));
  const isDeferred=label=>ignoredOptional.has(label)||flagged(label);
  const defer=async q=>{if(!isDeferred(q.label))deferred.push({...q,id:questionId(q.label)});await event(`Flagged for your approval: ${q.label}`);};
  // Varda 8097: the step agent asked about, or tried to upload to, a required Cover Letter with no approved
  // document; each try was rejected until the rejection cap failed the run. Flag it for approval once instead.
  const deferUpload=c=>defer({label:c.label,type:'textarea',required:true,employerRequired:true,approvalReason:'Required upload with no approved document: give the text to enter or register a document in the profile'});
  let rejected=0;const settledControls=new Map();
  const reject=async why=>{history.push({action:'rejected',control:why});if(++rejected>setting('worker.max_rejected_steps',5))throw new Error('The page changed or a control could not be identified');await event(`Retrying: ${why}`);};
  // His approved answers are learned for later applications, at every employer when shareable.
  const learn=async(control,value)=>{
   const key=questionId(control.label),approved=inline.get(key)??bank[key]?.answer;
   if(approved!==String(value)||!shareable(control.label,value,control.type,job.company))return;
   const shared=await loadBank(bankDir,SHARED);if(shared.answers[key]?.answer===String(value))return;
   await learnApprovals(bankDir,job.company,[{question:control.label,answer:String(value),type:control.type,approvedAt:bank[key]?.approvedAt}],String(job.id));
  };
  const parkNow=async()=>{await event(`${deferred.length} new question${deferred.length===1?'':'s'} flagged for your approval. Moving on to the next role.`,{status:'needs_approval',phase:'needs_approval',questions:deferred,review:null});};
  let refreshedOnce=false,captchaDeferrals=0,autofillUsed=false;const tickedRequired=new Set();const lateControlRefreshes=new Map();
  const signinStartedAt=new Date().toISOString();let signinCodeAttempted=false;let signInClicked=false,reopenedAfterSignIn=false;const signInTriedOn=new Set();
  for(let step=0;step<Math.min(request.maxSteps??100,200);step++){
   await command();if(stopping)throw new Error('Stopped by applicant');
   if(request.settleMs&&(!history.length||['click','review','upload'].includes(history.at(-1)?.action)))await sleep(Math.min(Number(request.settleMs)||0,10000));
   // A throttling page (Workday's "Something went wrong", a 429) gets one refresh after a pause;
   // if it stays, the run stops and the JobAgent queue cools the role down.
   const pageText=await page.locator('body').innerText().catch(()=>'');
   const throttled=siteThrottled(pageText);
   // An employer limit on applications stops the run until he decides on the Approvals page.
   const cap=detectCap(pageText);
   if(cap&&!capAllowed(job.company,profile.policy.applicationCaps)){await event(`${job.company} limits applications: "${cap.quote}" Waiting for your approval before applying there.`,{status:'needs_cap_approval',phase:'needs_cap_approval',cap,questions:deferred});return;}
   const priorApplication=!submitted&&alreadyAppliedNotice(pageText);
   if(priorApplication){await event(`${job.company} says: "${priorApplication}" Nothing was submitted in this run and the role is not marked applied; confirm the earlier application on the employer's site.`,{status:'needs_human',phase:'already_applied',questions:deferred,review:null});return;}
   if(throttled){if(!refreshedOnce){refreshedOnce=true;await event(`The site showed a ${throttled}; refreshing once after a pause.`);await sleep(throttlePauseMs());await page.reload({waitUntil:'domcontentloaded'}).catch(()=>{});continue;}await event(throttledReason(throttled),{status:'blocked',phase:'blocked',questions:deferred});return;}
   const access=siteAccessFailure(pageText,documentStatus);
   if(access){
    if(headless && !relayChrome && request.headlessOnly!==true && !allowLocalFixture){
     await event(`The site refused the headless browser (${access}); retrying once in a visible browser.`);
     await live?.stop().catch(()=>{}); await browser.close();
     browser=await chromium.launch({headless:false});headless=false;
     context=await applicationContext(browser);
     await context.route('**/*',async route=>{if(route.request().isNavigationRequest()){try{await validatePublicURL(route.request().url(),allowLocalFixture);}catch{return route.abort();}}return route.continue();});
     page=await context.newPage();page.setDefaultTimeout(10000);prepareGreenhouseUpload=monitorGreenhouseUploads(page);documentStatus=undefined;
     page.on('response',response=>{if(response.request().isNavigationRequest()&&response.frame()===page.mainFrame())documentStatus=response.status();});
     live=await startLiveView(context,page,join(runDir,'screenshot.jpg'));
     await page.goto(workableApplicationURL(job.url),{waitUntil:'domcontentloaded',timeout:45000});history.length=0;continue;
    }
    await event(`Site unavailable: ${access}. The queue will retry after a cooldown.`,{status:'blocked',phase:'blocked',questions:deferred});return;
   }
   if(!submitted&&zipRecruiterSearchRedirect(job.url,page.url())){
    await event('Posting link redirected to general ZipRecruiter search results. Verify an exact job-specific application link before continuing.',{status:'needs_human',phase:'human',posting_link_unverified:true,questions:[],review:null});return;
   }
   // A sign-in that lands on the candidate's own profile/home page (Avature /Profile, ArcBest 12717)
   // left the application; the signed-in session reopens the posting once and clicks Apply again.
   if(!submitted&&signInClicked&&!reopenedAfterSignIn&&signInLandingPage(page.url(),postingURLs)){
    reopenedAfterSignIn=true;await event('Signed in, but the site opened your candidate profile instead of the application; reopening the posting to apply.');
    await page.goto(workableApplicationURL(job.url),{waitUntil:'domcontentloaded',timeout:45000});history.length=0;continue;
   }
   if(!submitted&&!signinCodeAttempted){
    const verification=await completeSigninVerification(page,job,{email:profile.answers?.email,after:signinStartedAt,...helper,execImpl});
    if(verification.needed){
     signinCodeAttempted=true;
     if(verification.completed){await event('Completed email verification for sign-in');continue;}
     await event(`Sign-in needs a fresh email verification code; automatic verification could not be validated${verification.reason?` (${verification.reason})`:''}.`,{status:'needs_human',phase:'human',questions:[],review:null});return;
    }
   }
   if(ashbyApplicationPage(page.url())){
    const ready=await waitForAshbyForm(page,{timeout:45000});
    if(!ready&&await ashbyJobNotFound(page)){await screenshot();await event('Posting unavailable: Ashby says "Job not found" for this exact job.',{status:'skipped',phase:'skipped',posting_unavailable:true,questions:[],review:null});return;}
    if(!ready){
     if(!refreshedOnce){refreshedOnce=true;await event('Ashby is still fetching the application form; reloading once before retrying.');await page.reload({waitUntil:'domcontentloaded'}).catch(()=>{});continue;}
     await event('Site unavailable: Ashby application form did not load after waiting and reloading. The queue will retry after a cooldown.',{status:'blocked',phase:'blocked',questions:deferred});return;
    }
   }
   if(!await waitForEmbeddedApplication(page)){
    await event('Site unavailable: embedded application form did not load after waiting. The queue will retry after a cooldown.',{status:'blocked',phase:'blocked',questions:deferred});return;
   }
   if(await declineOptionalCookies(page))await event('Declined optional cookies');
   const snap=await snapshot(page);
   const expiredPosting=await zipRecruiterPostingUnavailable(page,job)||await ibmPostingUnavailable(page,job)||await amazonPostingUnavailable(page,job)||await applePostingUnavailable(page,job)||await oraclePostingUnavailable(page,job)||await successFactorsPostingUnavailable(page,job)||await smartRecruitersPostingUnavailable(page,job)||await llnlPostingUnavailable(page,job)||await paycorPostingUnavailable(page,job)||await trinetPostingUnavailable(page,job)||await metaPostingUnavailable(page,job,{fetch:url=>fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000)})});
   if(expiredPosting){await event(`Posting unavailable: ${expiredPosting}`,{status:'skipped',phase:'skipped',posting_unavailable:true,questions:[],review:null});return;}
   // A link to a contractor marketplace, talent-network sign-up, assessment or ID check is not an
   // application: stop before typing anything; JobAgent ignores the posting (not-application.mjs).
   const notApp=!submitted&&notApplication({url:page.url(),heading:await page.locator('h1').first().innerText({timeout:1000}).catch(()=>''),text:pageText});
   if(notApp){await screenshot();await event(`Not an application: ${notApp.reason}. Skipped; nothing was entered.`,{status:'skipped',phase:'skipped',not_application:notApp.kind,questions:[],review:null});return;}
   if(!pageText.trim() && !snap.frames.some(f=>f.controls.length)){
    const ready=await page.waitForFunction(()=>Boolean(document.body?.innerText.trim()||document.querySelector('input:not([type=hidden]),button')),{},{timeout:10000}).then(()=>true,()=>false);if(ready)continue;
    if(!refreshedOnce){refreshedOnce=true;await event('The application page is blank; waiting and reloading once before escalation.');await sleep(2000);await page.reload({waitUntil:'domcontentloaded'}).catch(()=>{});continue;}
    await event('Site unavailable: application page stayed blank after a reload. The queue will retry after a cooldown.',{status:'blocked',phase:'blocked',questions:deferred});return;
   }
   // A page with a heading but no controls yet is still hydrating (Tesla's 'Build your Career' spinner, 11929): wait for the Apply button or form before asking the model.
   if(!snap.frames.some(f=>f.controls.length)&&!lateControlRefreshes.get('hydrate')){lateControlRefreshes.set('hydrate',1);await event('The page has no controls yet; waiting for it to finish loading.');if(await waitForPageControls(page))continue;}
   await save({status:'running',phase:'reading',questions:[],review:null});
   let filledConditional=false;
   for(const frame of snap.frames){
    const office=frame.controls.find(c=>/^Please select the office location\(s\) you are applying to work from\s*\*?$/i.test(c.label));
    const approved=office&&(inline.get(questionId(office.label))??lookupAnswer(bank,office.label)?.answer);
    const inactive=inactiveLocationExplanation(frame.controls,approved);
    if(!inactive)continue;
    const input=page.frames()[frame.frameIndex].locator(`[data-ja-control="${inactive.control.id}"]`);
    await input.fill(inactive.value);
    if(await input.inputValue()!==inactive.value)throw new Error('The conditional location explanation was not retained');
    answered.push({label:inactive.control.label,value:inactive.value});
    await event('Answered inapplicable location explanation from approved office selection');
    filledConditional=true;break;
   }
   if(filledConditional)continue;
   // Inspect these ourselves: the step agent can otherwise jump directly to
   // Review and never ask about an optional application-strengthening response.
   let filledWriting=false;
   if(park)for(const frame of snap.frames)for(const c of frame.controls){
    if(!shouldApproveOptionalWriting(c)||isDeferred(c.label))continue;
    const approved=inline.get(questionId(c.label))??lookupAnswer(bank,c.label)?.answer;
    if(typeof approved==='string'&&approved.trim()&&!placeholderAnswer(approved)){
     if(c.value!==approved){await page.frames()[frame.frameIndex].locator(`[data-ja-control="${c.id}"]`).fill(approved);answered.push({label:c.label,value:approved});filledWriting=true;break;}
    }else await defer({label:c.label,type:c.type,required:true,employerRequired:false,
     approvalReason:'Optional application-strengthening answer requested for review',
     maxWords:Number(c.label.match(/\b(\d+)\s*words?\b/i)?.[1])||undefined});
   }
   if(filledWriting)continue;
   // His rule (2026-11-02): every REQUIRED single checkbox is ticked without asking (attestations, consents, terms);
   // only written answers go to him. Marketing / alert / call / SMS opt-ins stay unticked (his 2026-11-01 rule). A box among several options of one question (optionLabel) is an answer choice,
   // not this rule; each box gets one try, so one that will not stay ticked falls back to the ordinary path (lesson 431).
   // His request (lesson 441): a resume-autofill box is used first, so the site fills the form from the resume. It does
   // not count as the Resume field's upload; that field still gets the file if it stays empty.
   if(!autofillUsed&&uploadResume){
    const autofill=await findAutofillUpload(page);
    if(autofill){autofillUsed=true;
     try{await autofill.setInputFiles(uploadResume);await event('Uploaded the resume to the page\'s autofill; waiting for it to fill the form');await settleResumeParse(page);continue;}
     catch(error){await event(`The resume autofill upload did not work: ${String(error.message??error).slice(0,120)}`);}
    }
   }
   const requiredBox=snap.frames.flatMap(f=>f.controls.filter(c=>mustTickBox(c)&&!c.optionLabel&&!(c.choiceLabels?.length>1)&&!optInText(c.label)&&!answerChoiceText(c.label)&&!tickedRequired.has(c.nodeKey??c.id)).map(c=>({c,f})))[0];
   if(requiredBox){
    const {c,f}=requiredBox;tickedRequired.add(c.nodeKey??c.id);
    const target=page.frames()[f.frameIndex],box=target.locator(`[data-ja-control="${c.id}"]`);
    try{await setCheckedControl(target,box,true);answered.push({label:c.label,value:'Yes'});history.push({action:'check',control:c.label.slice(0,80)});await event(`Ticked required checkbox: ${c.label.slice(0,140)}`);continue;}
    catch(error){await event(`Could not tick required checkbox "${c.label.slice(0,80)}": ${String(error.message??error).slice(0,120)}`);}
   }
   const view=withoutSettled({...snap,frames:snap.frames.map(f=>({...f,controls:f.controls.filter(c=>!isDeferred(c.label)&&choiceNeedsAction(c,profile,bank,inline,job.company,job))}))},settledControls);
   // The original resume is already authorized. Do not let a step agent skip
   // its sole unambiguous upload control and fail only at final review.
   // The resume goes in first: most hiring sites read it and fill name, contact, experience and education themselves
   // (his request, 2026-11-02, lesson 440). That includes SmartRecruiters' parser drop zone ("Choose a file or drop it
   // here"), which lesson 414's rule already identifies; on Intuitive it was found only after every field was typed.
   const fileLike=view.frames.flatMap(f=>f.controls.filter(c=>c.type==='file'||/choose a file/i.test(c.label)));
   const resumeControls=resumeUploaded||!uploadResume?[]:view.frames.flatMap(f=>f.controls.filter(c=>c.type==='file'&&uploadDocument(c.label,uploadResume,profile.documents)?.kind==='resume'||genericResumeDrop(c,page.url(),fileLike,false,'')));
   // The attempt is recorded only when the correction is the chosen step, not when the resume upload runs first.
   const regionalControl=resumeControls.length===1?null:regionalLocationCorrection(view,profile,job,regionalAttempts);
   const employerCorrection=resumeControls.length===1||regionalControl?null:currentEmployerCorrection(view,profile,employerAttempts);
   // Fields his confirmed facts settle are filled without a model step (request.scriptedActions).
   const scripted=!resumeControls.length&&!regionalControl&&!employerCorrection&&request.scriptedActions===true?scriptedFormAction({snap:view,profile,bank,inline,job,history,attempts:scriptAttempts},{resolveKnownQuestion,approvedValue}):null;
   const hintSite=platformKey(page.url());if(hintSite)hintRun.steps[hintSite]=(hintRun.steps[hintSite]??0)+1;
   const askingModel=!(resumeControls.length===1||regionalControl||employerCorrection||scripted);
   const directStuck=stuckBySteps(history,rejected);
   if(askingModel&&directAllowed({request,engine,endpoint:directEndpoint,pageUrl:page.url(),seen:directPages,open:openQuestions(view),minOpen:setting('worker.direct_control_min_open',3),stuck:directStuck})){
    directPages.add(directStuck?rescueKey(page.url()):directPageKey(page.url()));
    if(directStuck)await event('The step loop is stuck on this page; handing it to a direct-control session');
    if(await directPass()){if(directStuck){rejected=0;history.push({action:'direct',control:'page'});}continue;}
   }
   const siteHints=askingModel&&setting('worker.site_hints',true)?await hintsFor(page.url()).catch(()=>[]):[];
   if(siteHints.length)hintRun.used[hintSite]=[...new Set([...(hintRun.used[hintSite]??[]),...siteHints.map(h=>h.id)])];
   const {action,usage}=resumeControls.length===1?{action:{action:'upload',control:resumeControls[0].id},usage:{}}:regionalControl?{action:{action:'fill',control:regionalControl.id,fact:'applicationLocationRule'},usage:{}}:employerCorrection?{action:{action:'fill',control:employerCorrection.control.id,fact:employerCorrection.fact},usage:{}}:scripted?{action:scripted,usage:{}}:await decide({engine,command:request.command,model:stepModel,snap:view,profile,bank,job,history,context:{runDir,jobStatePath,savedSignIn:askingModel&&passwordAllowedOn(page.url(),postingURLs)&&Boolean(await accountFor(page.url(),{email:profile.answers?.email,...(accountRoot?{root:accountRoot}:{})})),pendingQuestions:deferred,approvedAnswers:approvedNow,siteHints,log:message=>event(message),onModel:async m=>{if(state.ai_model!==m)await save({ai_model:m});}},execImpl});
   if(manualSubmissionAt)throw new Error('An applicant-initiated employer request was observed during preparation; preserve its outcome before another submission');
   state.usage.input_tokens+=(usage.input_tokens??0)+(usage.cache_read_input_tokens??0)+(usage.cache_creation_input_tokens??0);state.usage.output_tokens+=usage.output_tokens??0;
   if(usage.via){
    const modelUsage=state.model_usage[usage.via]??{calls:0,input_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:0};
    modelUsage.calls++;
    for(const key of ['input_tokens','cache_read_input_tokens','cache_creation_input_tokens','output_tokens'])modelUsage[key]+=usage[key]??0;
    state.model_usage[usage.via]=modelUsage;
   }
   // A human decision may describe an old snapshot while a SPA finishes rendering.
   // Read again without reloading, clicking or reusing an old control ID. Genuine
   // verification/credential boundaries on the current page and unchanged pages
   // retain their normal stop, independently of the model's wording.
   if(!submitted&&action.action==='human'){
    // The page can turn into the employer's block page inside a step (Safran 13178: the cookie-banner
    // click reloaded into Cloudflare's "Sorry, you have been blocked") and the step model then asks for
    // a human. A throttling or access-refusal page is the queue's cooldown, never Needs help, however
    // the decision is worded: the loop start refreshes once and then stops with the cooldown marker.
    {const text=await page.locator('body').innerText().catch(()=>'');const wall=siteThrottled(text)||siteAccessFailure(text,documentStatus);
     if(wall){await event(`The page turned into a ${wall} during this step; taking the cooldown path.`);continue;}}
    // Authentication may render during the model decision, after the loop-start
    // bridge check. Recheck once before parking, independently of field refreshes.
    if(!signinCodeAttempted){
     const verification=await completeSigninVerification(page,job,{email:profile.answers?.email,after:signinStartedAt,...helper,execImpl});
     if(verification.needed){
      signinCodeAttempted=true;
      if(verification.completed){await event('Completed email verification for sign-in');continue;}
      await event(`Sign-in needs a fresh email verification code; automatic verification could not be validated${verification.reason?` (${verification.reason})`:''}.`,{status:'needs_human',phase:'human',questions:[],review:null});return;
     }
    }
    const current=await snapshot(page);
    const reviewControl=(c,frame)=>/^(?:review application(?: and forms)?|review your application)\s*$/im.test(frame.text??'')&&['button','submit'].includes(c.type)&&isFinalControl(c,answered,job);
    // A same-URL wizard can spend its two field refreshes before Review renders.
    // Reserve one independent reread for a newly rendered final review control.
    const lateReview=current.frames.some(f=>f.controls.some(c=>reviewControl(c,f)));
    const lateControlPage=page.url()+(lateReview?'#final-review-controls':'');
    if((lateControlRefreshes.get(lateControlPage)??0)<(lateReview?1:2)&&hasNewFormControls(snap,current,(c,f)=>safeNavigation(c.label,job)&&!isFinalControl(c,answered,job)||reviewControl(c,f))&&!hasVerificationControls(current,{passwordSigninAllowed:frame=>passwordAllowedOn(frame.url,postingURLs)})&&!await visibleApplicationChallenge(page)){
     lateControlRefreshes.set(lateControlPage,(lateControlRefreshes.get(lateControlPage)??0)+1);
     await event('New form controls appeared while deciding; refreshing the snapshot before asking for help.');
     continue;
    }
   }
   let frame=snap.frames.find(f=>f.controls.some(c=>c.id===action.control));let control=frame?.controls.find(c=>c.id===action.control);
   if(control){
    // React can replace the input while the model is deciding. Read the live
    // DOM again and bind the action to the same unique semantic control.
    const current=await snapshot(page);
    const freshFrame=current.frames.find(f=>f.frameIndex===frame.frameIndex&&f.url===frame.url);
    control=rebindControl(control,freshFrame?.controls??[]);
    if(control)frame=freshFrame;
   }
   const locator=control?page.frames()[frame.frameIndex].locator(`[data-ja-control="${control.id}"]`):null;
   // The form may be re-rendered after the snapshot (iRecruit's Save/Next swaps the section by
   // AJAX seconds after the click); a control that left the page is read again, not a failed run.
   const rerendered=async()=>{await page.waitForLoadState('networkidle',{timeout:10000}).catch(()=>{});await reject(`${control.label} left the page while it was re-rendering; reading the page again`);};
   if(control&&await locator.count().catch(()=>0)===0){await rerendered();continue;}
   try{
   history.push({action:action.action,control:control?.label});
   // He may have pressed the employer's Submit himself (or solved its CAPTCHA and the form went through); the success page is recorded, not waited on (lesson 454, Tesla 2976).
   const recordHisSubmit=async()=>{
    const confirmed=confirmationPageText(await page.locator('body').innerText({timeout:5000}).catch(()=>''));
    if(!confirmed)return false;
    await screenshot();const webpageEvidence={source:'webpage',url:page.url(),matched:confirmed,observedAt:new Date().toISOString(),by:'his_submit'};
    const prior=await readJSON(jobStatePath,{});
    await atomic(jobStatePath,{...prior,status:'submitted',receiptSource:'webpage',receiptEvidence:webpageEvidence,webpageEvidence,updatedAt:new Date().toISOString()});
    if(visibleAuto)await page?.close().catch(()=>{});/* JobAgent ends the worker at 'completed', before the finally below runs (Tesla 2977) */
    await event(`The employer's page says "${confirmed}"; recorded as submitted from your Chrome window.`,{status:'completed',phase:'completed',submitted:true,submission_attempted:true,receipt:webpageEvidence,receiptSource:'webpage',webpageEvidence,review:null});return true;
   };
   if((visibleAuto||request.humanFinish===true)&&await recordHisSubmit())return;
   // He authorized signing in and creating accounts with his email and saved password on the
   // posting's own site or a hiring platform. The model only names the field; the worker types it.
   const hasPassword=snap.frames.some(f=>f.controls.some(c=>c.type==='password'));
   const account=await accountFor(page.url(),{email:profile.answers?.email,...(accountRoot?{root:accountRoot}:{})});
   const canAuth=Boolean(account)&&passwordAllowedOn(page.url(),postingURLs)&&authAttempts<setting('worker.max_sign_in_attempts',5);
   if(park&&action.action==='human'&&deferred.length&&!/captcha|verification code|sign.in|log.in/i.test(action.message??'')){
    await parkNow();return;
   }
   if(action.action==='human' && /no (?:application|available|sign.in).*controls|no (?:email|sign.in|job listing).{0,140}(?:fields|controls|button)|blank|missing application form|no application fields/i.test(action.message??'')){
    if(!refreshedOnce){refreshedOnce=true;await event('The application controls are missing; waiting and reloading once.');await sleep(2000);await page.reload({waitUntil:'domcontentloaded'}).catch(()=>{});continue;}
    await event('Site unavailable: application controls stayed unavailable after a reload. The queue will retry after a cooldown.',{status:'blocked',phase:'blocked',questions:deferred});return;
   }
   if(action.action==='human'&&await captchaPending(page,{challengeVisible:visibleApplicationChallenge})){
    // An invisible widget (Lever's hCaptcha) only challenges at Submit; keep filling until then.
    if(!(await visibleApplicationChallenge(page))&&!(await captchaCheckboxVisible(page))){if(++captchaDeferrals>12)throw new Error('The step agent kept stopping for a CAPTCHA that is not open');const why='No CAPTCHA challenge is open yet. Keep filling the form and choose review at the final Submit control; the CAPTCHA is solved after Submit.';history.push({action:'rejected',control:why});await event(`Retrying: ${why}`);continue;} // Not counted against max_rejected_steps.
    // In his own finish-yourself Chrome the solver is skipped: it only declines again; he solves it (lesson 451).
    const free=await resolveChallengeFree(page,{challengeVisible:p=>captchaPending(p,{challengeVisible:visibleApplicationChallenge}),headless,relay:relayChrome,manualFirst:request.humanFinish===true||visibleAuto||await captchaManualFirst(stateDir,job.url),company:job.company,log:message=>event(message)});
    if(free.completed){await event(`CAPTCHA cleared (${free.by}); continuing the application.`);continue;}
    await recordCaptcha(stateDir,job.url,'pre-submit');
    if(preSubmitCaptchaHandoff({request,submitted,free})){
     await screenshot();await page.close().catch(()=>{});page=null;
     await event(`${free.reason}. Nothing was sent to the employer. Opening a visible Chrome with this application, for you to solve the CAPTCHA; the form is then filled for you to review and submit.`,{status:'needs_human',phase:'captcha_handoff',submission_attempted:false,submitted:false,questions:[],review:null});return;
    }
   }
   // Before parking for him (lesson 483): one direct-control session tries the page the step agent gave up on, unless
   // it stopped for a CAPTCHA or an emailed code, which a session cannot pass either.
   if(action.action==='human'&&!submitted&&!/captcha|verification code|emailed code|security code/i.test(action.message??'')&&directAllowed({request,engine,endpoint:directEndpoint,pageUrl:page.url(),seen:directPages,stuck:true})){
    directPages.add(rescueKey(page.url()));
    await event('The step agent asked for help on this page; trying a direct-control session first');
    if(await directPass()){rejected=0;history.push({action:'direct',control:'page'});continue;}
   }
   if(action.action==='human'||(hasPassword&&!canAuth)){
    const why=action.action==='human'?(action.message||'This page needs a verification only you can do (a CAPTCHA, an emailed code or link).'):!account?'This site asks you to sign in and no saved password was found.':authAttempts>=setting('worker.max_sign_in_attempts',5)?'Signing in with your saved email and password did not work here. The account may use a different password.':'This sign-in page is not on the employer\'s site or a known hiring platform, so your password was not entered.';
    if(park){await event(`${why} Flagged for you; moving on to the next role.`,{status:'needs_human',phase:'needs_human',questions:deferred});return;}
    if(request.humanFinish===true){
     // He may have pressed the employer's Submit himself; its success page is recorded, not waited on (lesson 454).
     if(await recordHisSubmit())return;
     // Status stays running: JobAgent stops reading a needs_human run's state, so what follows would never show (lesson 456).
     await event('Waiting in your Chrome window: sign in or finish the verification there. Filling continues by itself once you are past this page.',{status:'running',phase:'human'});
     if(await waitForPageAdvance({url:()=>page.url(),closed:()=>page.isClosed(),command,sleep,timeoutMs:15*60000})!=='timeout'){await event('You are past the sign-in page; continuing the application.',{status:'running',phase:'reading'});continue;}
    }
    await event('This page needs your help. Open the browser to sign in or complete verification, then resume.',{status:'needs_human',phase:'human'});
    await wait(async cmd=>{if(cmd.action==='open_browser'&&request.headlessOnly===true){await event('This application is headless-only; the browser remains headless.');return false;}if(cmd.action==='open_browser'){if(headless){const storage=await context.storageState();const url=page.url();await browser.close();browser=await chromium.launch({headless:false});context=await applicationContext(browser,{storageState:storage});page=await context.newPage();page.setDefaultTimeout(10000);prepareGreenhouseUpload=monitorGreenhouseUploads(page);await context.route('**/*',async route=>{if(route.request().isNavigationRequest()){try{await validatePublicURL(route.request().url(),allowLocalFixture);}catch{return route.abort();}}return route.continue();});await page.goto(url,{waitUntil:'domcontentloaded'});headless=false;}await page.bringToFront();await save();return false;}return cmd.action==='resume';});continue;
   }
   // A step that names no real control, or one it may not use, is sent back rather than ending
   // the run; the next step reads the page afresh.
   if(!control){if(deferred.some(q=>action.control===q.label||action.control===q.id)){await parkNow();return;}await reject(`control ${action.control||'(none)'} is not on the page`);continue;}
   if(control.type==='password'){
    if(action.action!=='fill'||action.fact!=='accountPassword'||!canAuth){await reject('A password field can only take fact accountPassword on an authorized sign-in page');continue;}
    await locator.fill(account.password);if((await locator.inputValue()).length!==account.password.length)throw new Error('The password field did not keep the saved password');
    await event(`Entered your saved password (${control.label})`);continue;
   }
   // "Accepting" a Proceed/Continue button is just moving on (IBMid notice page, IBM 11946).
   if(action.fact==='acceptTerms'&&['button','submit'].includes(control.type)&&safeNavigation(control.label,job)&&!isFinalControl(control,answered,job)){action.action='click';delete action.fact;}
   // Terms on the final submit button (Waymo 13548: "Submit your application") used to throw and end the run;
   // the step is refused instead so the model finishes with review, the only way a submit is clicked.
   if(action.fact==='acceptTerms'&&['button','submit'].includes(control.type)&&isFinalControl(control,answered,job)){await reject(`${control.label.slice(0,60)} is the final submit control: choose review on it; terms are accepted with their checkbox, never the submit button`);continue;}
   // A step model may try to "accept" a cookie banner (Howmet 13039: ACCEPT ALL COOKIES); send it back instead of failing the run.
   if(action.fact==='acceptTerms'&&!['checkbox','radio'].includes(control.type)&&/\bcookies?\b/i.test(control.label)){await reject(`${control.label.slice(0,60)} is a cookie banner choice, not terms; leave cookies alone and continue with the application`);continue;}
   if(action.fact==='acceptTerms'){
    // Oracle CX paints its email input ~75 ms after the required terms checkbox and Next (Howmet 11608); a snapshot
    // taken in between has the checkbox alone, so the live frames are read as well before refusing the checkbox.
    const emailOnlyAuth=!hasPassword&&(snap.frames.some(f=>f.controls.some(c=>c.type==='email'))||await liveEmailInput(page))&&passwordAllowedOn(page.url(),postingURLs);
    // IBMid shows its account notices on a page of their own right after sign-in (IBM 11946).
    const accountNotice=!hasPassword&&passwordAllowedOn(page.frames()[frame.frameIndex].url(),postingURLs)&&/\/(?:authsvc|account|login|signin|sign-in|register)\b|notice/i.test(new URL(page.frames()[frame.frameIndex].url()).pathname);  // myibm.ibm.com/elanotice/...
    // An attestation checkbox inside the application form itself (RV Tech 13331 on Ashby: "I understand my application
    // will be processed in accordance with ... Privacy Policy") is a question for him, not account terms: it takes the
    // ordinary answer path (approved bank answer, else flagged for approval when required, else left blank).
    // Not an account page at all (no password, no email-only sign-in, no account notice): any checkbox is an application
    // question, inside a <form> or not. SmartRecruiters' one-click page has no <form> (Intuitive 12315, lesson 427).
    if(!hasPassword&&!emailOnlyAuth&&!accountNotice&&['checkbox','radio'].includes(control.type)){
     // His standing rule of 2026-11-01 ("Yes, always"): a REQUIRED consent to processing his personal data for the
     // application is ticked without asking; attestations, opt-ins and optional boxes keep the answer path.
     if(requiredRecruitingConsent({...control,inForm:true},{applicationContext:true})){await setCheckedControl(page.frames()[frame.frameIndex],locator,true);answered.push({label:control.label,value:'Yes'});await event(`Ticked required data-processing consent: ${(control.optionLabel||control.label).slice(0,120)}`);continue;}
     action.action='ask';action.fact='';history.push({action:'rerouted',control:`${control.label.slice(0,60)} is an application question, not account terms`});
    }else if(['checkbox','radio'].includes(control.type)&&control.inForm&&!((control.required||accountNotice)&&(hasPassword&&canAuth||emailOnlyAuth||accountNotice)&&termsCheckbox(control.label))){
     // An application form with its own email box looks like an email-only sign-in page; a form checkbox that is not
     // account terms there (Waymo 13548: "By submitting my application, I certify ...") is answered like any question, not a crash.
     action.action='ask';action.fact='';history.push({action:'rerouted',control:`${control.label.slice(0,60)} is an application question, not account terms`});
    }else if(!['checkbox','radio','button','submit'].includes(control.type)&&control.inForm&&!accountNotice){
     // A select/text question inside the application form that mentions a privacy policy (Ludo Robotics 16831:
     // "[Privacy Policy]*" is a Greenhouse dropdown) is an ordinary question, not account terms: answer path, not a crash.
     action.action='ask';action.fact='';history.push({action:'rerouted',control:`${control.label.slice(0,60)} is an application question, not account terms`});
    }else{
    // SuccessFactors' Create-an-account Terms of Use / data-privacy acceptance is a button, not a checkbox (Mitsubishi Power 16096):
    // on an authorized account page it is clicked like any button (it toggles or opens the statement); the next snapshot shows the result.
    if(control.type==='button'&&hasPassword&&canAuth&&termsCheckbox(control.label)&&!isFinalControl(control,answered,job)&&!/\b(?:submit|apply|cookies?)\b/i.test(control.label)){
     await locator.click();await event(`Clicked account terms control: ${control.label.slice(0,120)}`);continue;
    }
    if(!(control.required||accountNotice)||!(hasPassword&&canAuth||emailOnlyAuth||accountNotice)||!['checkbox','radio'].includes(control.type)||!termsCheckbox(control.label))throw new Error(`Only a required terms checkbox on an account page may be accepted (label "${String(control.label).slice(0,80)}", type ${control.type}, required ${Boolean(control.required)}, page ${new URL(page.frames()[frame.frameIndex].url()).host}${new URL(page.frames()[frame.frameIndex].url()).pathname.slice(0,40)})`);
    await setCheckedControl(page.frames()[frame.frameIndex],locator,true);await event(`Accepted required terms: ${control.label.slice(0,120)}`);continue;
    }
   }
   if(hasPassword&&canAuth&&action.action==='fill'&&action.fact==='email'&&['email','text'].includes(control.type)){
    await locator.fill(account.email);await event('Entered your email to sign in');continue;
   }
   // A login page also links its registration page ("Need an account? Click here!", ApplicantPro 12727).
   const signIn=hasPassword&&authButton(control.label);
   const authClick=['click','review'].includes(action.action)&&!ssoButton(control.label)&&(signIn||authEntry(control.label));
   // Avature's application-methods page (ArcBest 12717) shows a Log in form beside an "Upload résumé, Continue" path
   // that creates a profile behind a reCAPTCHA. His account already existed there, so the registration CAPTCHA was the
   // only obstacle. Where a login form is on the page, sign in with the saved credentials first; a profile is created
   // only after that sign-in has been tried on this page (his rule of 2026-10-18: sign in, create where he has none).
   const loginButton=/^(sign in|sign-in|log in|login|log on|sign in to apply|log in to apply)$/i;
   const loginForm=hasPassword&&snap.frames.some(f=>f.controls.filter(c=>c.type==='password').length===1&&f.controls.some(c=>['email','text'].includes(c.type)&&/\b(e-?mail|user ?name)\b/i.test(c.label))&&f.controls.some(c=>['button','submit','a'].includes(c.type)&&loginButton.test(c.label.trim())));
   if(authClick&&account&&loginForm&&!loginButton.test(control.label.trim())&&!signInTriedOn.has(page.url())){
    signInTriedOn.add(page.url());await reject(`${control.label} would create a profile; sign in first with the saved email and password (the account may already exist)`);continue;
   }
   if(authClick&&account&&passwordAllowedOn(page.url(),postingURLs)&&(!control.href||passwordAllowedOn(control.href,postingURLs))){
    if(signIn&&loginButton.test(control.label.trim()))signInTriedOn.add(page.url());
    if(signIn){authAttempts++;signInClicked=true;}
    await clickAuthControl(page,locator);await event(`${signIn?'Signing in':'Opened'}: ${control.label}`);await sleep(signIn?2500:600);continue;
   }
   if(action.action==='upload'){
    // SmartRecruiters one-click (Intuitive 12316, lesson 414): identical "Choose a file" zones differ only by their section heading.
    const zoneHeading=dropZoneLabel(control.label)?await uploadZoneHeading(locator):'';
    const doc=uploadDocument(control.label,uploadResume,profile.documents)||(uploadResume&&genericResumeDrop(control,page.url(),snap.frames.flatMap(f=>f.controls.filter(c=>c.type==='file'||/choose a file/i.test(c.label))),resumeUploaded,zoneHeading)?{kind:'resume',path:uploadResume}:null);
    if((control.type==='button'||control.type==='a'&&/^#/.test(control.hrefAttr??''))&&doc){
     // Meta Careers: "Upload resume" is a button that opens a native file chooser.
     // JazzHR (theresumator): "Attach resume" is an in-page '#' link over a hidden file input.
     const path=resolve(ROOT,doc.path);await readFile(path);const chooser=page.waitForEvent('filechooser',{timeout:8000}).catch(()=>null);await locator.click();
     // Jobvite (AGS 13110): 'Select' only opens an attachment menu (Dropbox / File / Paste); the chooser is behind 'File'.
     const opened=await chooser||await openUploadMenuItem(page);
     // Aerotech 9149 (JazzHR): the '#' Attach link sometimes opens no chooser; set its hidden input, matched by the input's own label.
     if(opened)await opened.setFiles(path);else if(!await setHiddenUpload(page.frames()[frame.frameIndex],doc.kind,path))throw new Error(`The ${doc.kind} upload control did not open a file chooser`);
     await sleep(1500);
     if(doc.kind==='resume')resumeUploaded=true;
     answered.push({label:control.label,value:`Original ${doc.kind} uploaded`});await event(`Uploaded original ${doc.kind}`);if(doc.kind==='resume')await settleResumeParse(page);continue;
    }
    if(!doc&&park&&requiredUploadGap(control)){if(isDeferred(control.label))await reject(`${control.label} is already flagged for approval; continue with the rest of the form`);else await deferUpload(control);continue;}
    if(control.type!=='file'||!doc){
     if(dropZoneLabel(control.label)&&!doc){await reject(`No authorized document for ${control.label}${zoneHeading?` under "${zoneHeading.slice(0,60)}"`:''}: ${resumeUploaded?'the résumé is already uploaded; leave this zone empty and continue':'the résumé goes in the drop zone under the Resume heading; skip other drop zones'}`);continue;}
     await reject(`No authorized document for ${control.label}`);continue;
    }
    const path=resolve(ROOT,doc.path);await readFile(path);await prepareGreenhouseUpload(page.frames()[frame.frameIndex],locator);await locator.setInputFiles(path);
    if(!await resumeAttached(page.frames()[frame.frameIndex],locator,basename(path)))throw new Error(`${doc.kind} upload could not be verified`);
    if(doc.kind==='resume')resumeUploaded=true;
    answered.push({label:control.label,value:`Original ${doc.kind} uploaded`});await event(`Uploaded original ${doc.kind}`);if(doc.kind==='resume')await settleResumeParse(page);continue;
   }
   if(action.action==='ask'||action.action==='fill'){
    if(park&&requiredUploadGap(control)&&!uploadDocument(control.label,uploadResume,profile.documents)){if(isDeferred(control.label))await reject(`${control.label} is already flagged for approval; continue with the rest of the form`);else await deferUpload(control);continue;}
    if(flagged(control.label)){await parkNow();return;}
    if(['password','file','submit','button','a'].includes(control.type)){await reject(`${control.label} is a ${control.type}, not a question`);continue;}
    if(searchFilterControl(control)){await reject(`${control.label} is a job-search filter, not an application question; open this posting's own Apply link`);continue;}
    const controlFrame=page.frames()[frame.frameIndex];
    if(inFormConsentToTick(control)&&control.value!=='true'&&!(action.action==='fill'&&/^(no|false)$/i.test(String(action.fact??'')))){await setCheckedControl(controlFrame,locator,true);answered.push({label:control.label,value:'Yes'});await event(`Ticked required data-processing consent: ${(control.optionLabel||control.label).slice(0,120)}`);continue;}
    let value;try{value=approvedValue(action,control,profile,bank,inline,job.company,job);}catch{
     // His instruction for Tesla's visible runs (2026-11-10, lesson 463): fill what is required and click Next; optional questions stay blank.
     if(!control.required&&(visibleAuto||request.realChrome===true||park&&!shouldApproveOptionalWriting(control))){ignoredOptional.add(control.label);await event(`Left optional unanswered question blank: ${control.label}`);continue;}
     // A typeahead's choices only exist once opened, so read them for him to pick from.
     const offered=control.combobox?await comboOptions(controlFrame,locator,'').finally(()=>locator.press('Escape').catch(()=>{})):undefined;
     const q={id:control.id,label:control.label,type:control.options||offered?.length?'select':control.type==='checkbox'||control.type==='radio'?'select':control.type==='textarea'?'textarea':'text',required:control.required,options:control.options?.map(o=>o.label)??(offered?.length?offered:undefined)??control.choiceLabels??(['checkbox','radio'].includes(control.type)?['Yes','No']:undefined)};
     if(park){await defer(q);continue;}
     await event('Please answer the question on this page.',{status:'waiting_answers',phase:'answers',questions:[q]});const cmd=await wait(c=>c.action==='answer'&&Object.hasOwn(c.answers??{},q.id));value=String(cmd.answers[q.id]);inline.set(questionId(control.label),value);if(value.trim()){const own=await loadBank(bankDir,job.company);await saveBank(bankDir,job.company,recordApprovals(own,[{question:control.label,answer:value}],String(job.id)));bank[questionId(control.label)]={answer:value};}
    }
    if(alreadyHolds(control,value,answered)){settledControls.set(control.label,String(control.value??''));await reject(`${control.label} already holds that answer; it does not need filling again`);continue;}
    if(control.type==='select-one'||control.type==='select-multiple'||control.options){const equivalent=equivalentOption(control.label,value,control.options.map(o=>o.label),profile.answers,{...job,confirmedAnswer:preferenceAnswer(control.label,profile.answers,job)});if(equivalent!==null)value=equivalent;const matches=control.options.filter(o=>o.label===String(value)||o.value===String(value));if(matches.length!==1&&park){await defer({label:control.label,type:'select',options:control.options.map(o=>o.label),required:control.required});continue;}if(matches.length!==1){await event('Saved answer does not match the available options.',{status:'waiting_answers',phase:'answers',questions:[{id:control.id,label:control.label,type:'select',options:control.options.map(o=>o.label),required:control.required}]});const cmd=await wait(c=>c.action==='answer'&&control.options.some(o=>o.label===c.answers?.[control.id]));value=cmd.answers[control.id];inline.set(questionId(control.label),value);const own=await loadBank(bankDir,job.company);await saveBank(bankDir,job.company,recordApprovals(own,[{question:control.label,answer:value}],String(job.id)));bank[questionId(control.label)]={answer:value};if(control.type==='choice')await fillAshbyChoice(controlFrame,locator,value);else await locator.selectOption({label:value});}else if(control.type==='choice')await fillAshbyChoice(controlFrame,locator,matches[0].label);else await locator.selectOption(matches[0].value);}
    else if(control.combobox){let picked=await pickOption(controlFrame,locator,value,control.label,profile.answers,job);if(!picked.ok&&await mapSearchFreeText(locator,String(value),{label:control.label,answers:profile.answers,note:event})){picked={ok:true,value:await locator.inputValue().catch(()=>String(value))||String(value)};}if(!picked.ok&&!inline.has(questionId(control.label))){const rechosen=offeredPreference(control.label,value,picked.options,profile,job,bank);if(rechosen){value=rechosen;picked=await pickOption(controlFrame,locator,value,control.label,profile.answers,job);}}if(!picked.ok){if(/^(school|school or university)\s*\*?$/i.test(control.label)&&sameText(value,profile.answers.school))throw new Error('School dropdown did not resolve the confirmed university; retrying the search');if(park){await defer({label:control.label,type:picked.options.length?'select':'text',options:picked.options.length?picked.options:undefined,required:control.required});continue;}throw new Error(`No equivalent option for "${value}" for ${control.label}`);}value=picked.value;}
    else if(['checkbox','radio'].includes(control.type)){if(![true,false,'Yes','No','true','false'].includes(value)){if(park){await defer({label:control.label,type:'select',options:control.choiceLabels??['Yes','No'],required:control.required});continue;}throw new Error('Checkbox answer needs an explicit Yes or No');}await setCheckedControl(controlFrame,locator,value===true||value==='Yes'||value==='true');}
    else if(control.type==='text'&&monthYearPair(value)){const pair=monthYearPair(value);const kept=await fillMonthYear(locator,pair,typeof value==='string'?value:undefined);if(!kept.includes(pair.year)){if(park){await defer({label:control.label,type:'text',required:control.required});continue;}throw new Error('The month picker did not keep the saved month');}value=kept;}
    else if(await isLeverLocation(locator)){const picked=await pickLeverLocation(locator,String(value));if(!picked.ok){if(park){await defer({label:control.label,type:picked.options.length?'select':'text',options:picked.options.length?picked.options:undefined,required:control.required});continue;}throw new Error(`No Lever location suggestion matches "${value}"`);}value=picked.value;}
    else {value=await textDateInputValue(locator,control.type,nativeInputValue(control.type,normalizeApplicationLink(value)));await locator.fill(String(value));if(!keptValue(control.type,await locator.inputValue(),String(value))&&!(streetLineLabel(control.label)&&await mapSearchFreeText(locator,String(value),{label:control.label,answers:profile.answers,note:event}))){if(park){await defer({label:control.label,type:control.type==='textarea'?'textarea':'text',required:control.required});continue;}throw new Error('The page did not retain the supplied answer');}}
    await learn(control,value);
    answered.push({label:control.label,value:String(value)});await event(`Answered: ${control.label}`);continue;
   }
   if(!profileStep(control.label)&&(action.action==='review'||isFinalControl(control,answered,job))&&!isApplicationEntry(control,answered,job)&&!safeHistoryAdd(control,page.url())){
    if(deferred.length){await parkNow();return;}
    if(!isFinalControl(control,answered,job))throw new Error('A final submission control could not be verified');
    // Phenom wizards name the current step in the URL; nothing before its Review step is the final Submit (Cisco 12281).
    const wizardStep=(()=>{try{return new URL(page.url()).searchParams.get('stepname');}catch{return null;}})();
    if(wizardStep&&!/review|summary|submit|confirm/i.test(wizardStep)){await reject(`${control.label} is not the final submit: this is the "${wizardStep}" step of a multi-step application; finish it and use Next`);continue;}
    const fresh=await snapshot(page);
    if(regionalLocationCorrection(fresh,profile,job,new Set(regionalAttempts))){await event('Rechecking the saved regional location after resume parsing');continue;}
    // A resume parser can fill Current company late (Lever put the capstone sponsor there while the agent was deciding,
    // Humble Robotics 12510): clear it, or set N/A when required, before the sponsor check would hand the form over.
    if(currentEmployerCorrection(fresh,profile,new Set(employerAttempts))){await event('Rechecking the current company after resume parsing');continue;}
    const sponsorRows=sponsorAsEmployerProblems(fresh.frames.flatMap(f=>f.controls),profile);
    if(sponsorRows.length)throw new Error('A project sponsor is entered as an employer: '+sponsorRows.join('; '));
    // Submit validates and sends only its own <form>. Required inputs of another form on the page (Waymo 13548's
    // job-alert signup above the application) are neither gaps nor contacts to fill.
    const scoped=submitFormOnly(fresh,control,frame.frameIndex);
    const fields=scoped.frames.flatMap(f=>f.controls);
    const empty=fields.filter(c=>c.required&&!['button','submit','a','checkbox','radio','file'].includes(c.type)&&!c.value);
    const contacts=requiredContacts(scoped,profile);
    if(contacts.length){
     for(const {frameIndex,control:contact,value} of contacts){
      const input=page.frames()[frameIndex].locator(`[data-ja-control="${contact.id}"]`);
      await input.fill(value);
      if(await input.inputValue()!==value)throw new Error('The page did not retain the saved contact answer');
      answered.push({label:contact.label,value});
     }
     await event('Filled saved required contact details before review');continue;
    }
    if(empty.length)throw new Error('Required fields still need answers: '+empty.map(c=>c.label).join(', '));
    // The browser's own validation blocks the POST for required radios/checkboxes the list above
    // skips (RAVE's Workable YES/NO toggles); Submit would only show "Please select one of these options".
    const invalid=await formValidationGaps(locator);
    if(invalid.length)throw new Error('Required fields still need answers: '+invalid.join(', '));
    // Varda 9948: a required Cover Letter upload stayed empty and Greenhouse rejected the Submit.
    // Aerotech 9149 (JazzHR): the resume sits in a hidden input behind an 'Attach resume' link, so no snapshot
    // control showed it empty and Submit went out without it. Fill every empty hidden document input first.
    for(const filled of await fillHiddenDocuments(page.frames(),uploadResume,profile.documents)){
     if(filled.kind==='resume')resumeUploaded=true;
     answered.push({label:filled.label,value:`Original ${filled.kind} uploaded`});await event(`Uploaded original ${filled.kind} (hidden upload field)`);
    }
    const uploads=missingRequiredUploads(fields);
    // Nothing registered can fill it, so ask him on the Approvals page (text to enter or a document to
    // register) instead of failing the run and having the queue retry the same gap (lesson 237).
    if(uploads.length&&park){for(const label of uploads)await deferUpload({label});await parkNow();return;}
    if(uploads.length)throw new Error('Required uploads have no approved document: '+uploads.join(', '));
    if(!leaveResume&&fields.some(c=>c.type==='file'&&/resume|cv|curriculum/i.test(c.label))&&!resumeUploaded)throw new Error('Upload and verify the resume before submitting');
    const digest=reviewDigest(fresh,resumeHash,answered);const review_id=randomUUID();
    const review={review_id,id:review_id,answers:[...answered,...fresh.frames.flatMap(f=>f.controls.filter(c=>c.value&&!['button','submit','a','password','file'].includes(c.type)&&!answered.some(a=>a.label===c.label)).map(c=>({label:c.label,value:c.value})))],url:page.url(),company:job.company,title:job.title,submit_label:control.label,digest};
    if(request.humanFinish===true){
     // Filled and checked; he solves any CAPTCHA and presses Submit in the window, with nothing attached to it.
     await atomic(jobStatePath,{...(await readJSON(jobStatePath,{})),status:'awaiting_human_submit',company:job.company,canonicalUrl:job.url,handedOverAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
     if(leverHandoff){
      // Finder opens with the tailored resume selected, for the re-attach after Lever's first refusal.
      execFile('open',['-R',resumePath],()=>{});
      await event(`Filled and checked in your Chrome window${leaveResume?', except the resume (drag it in from Finder)':''}. Press Submit and solve the CAPTCHA. Lever usually answers the first try with "There was an error verifying your application" and empties the resume field: drag ${basename(resumePath)} in again from the Finder window and press Submit once more in the same page yourself; your own retry has asked for no CAPTCHA. Nothing was received the first time, so this is not a duplicate.`,{status:'needs_human',phase:'human_submit',review,questions:[],resume_for_retry:resumePath});
      await notifyMac('JobAgent: ready for you to submit',`${job.company}: if Lever refuses the first Submit, drag the resume in again from Finder and submit once more.`).catch(()=>{});
      // The worker's own retry, made while connected, was challenged and refused (Zoox 11055, lesson 421); his own
      // retry in the detached window passed without a challenge twice. So the watcher is opt-in (request.leverAutoRetry).
      if(request.leverAutoRetry===true){
       await page.bringToFront().catch(()=>{});await context.unroute('**/*').catch(()=>{});
       const watched=await watchLeverHandoff(page,job,{monitor:leverMonitor,resumePath,log:message=>event(message)});
       await leverHandoffOutcome(watched);return;
      }
     }else{
     await event('Filled and checked in your Chrome window. Solve any CAPTCHA and press Submit yourself; it leaves Needs help once the employer confirms.',{status:'needs_human',phase:'human_submit',review,questions:[]});
     await notifyMac('JobAgent: ready for you to submit',`${job.company}: press Submit in the Chrome window.`).catch(()=>{});
     }
     await page.bringToFront().catch(()=>{});await context.unroute('**/*').catch(()=>{});return;
    }
    if(request.autoSubmit===true){
     await event(`Completed application passed validation; submitting under your standing authorization (${String(control.label).slice(0,60)}).`,{review});
    }else if(park){
     // Parked review: he approves this exact form on the Approvals page, and a later run submits
     // only if it fills the form to the same digest. Anything different comes back for review.
     if(request.approvedDigest!==digest){await event(request.approvedDigest?'The form came out different from the one you approved. Review it again.':'Ready for your final approval. Moving on to the next role.',{status:'ready_to_submit',phase:'ready_to_submit',review});return;}
    }else{
     await event('Review the completed application and approve this submission.',{status:'waiting_review',phase:'review',review});
     await wait(c=>c.action==='approve'&&c.review_id===review_id);
     const current=await snapshot(page);if(reviewDigest(current,resumeHash,answered)!==digest){await event('The form changed. A fresh review is required.');continue;}
    }
    if(await submitControlDisabled(locator))throw new Error(`The employer's ${String(control.label).slice(0,60)} button is disabled, so a required answer is still missing; nothing was submitted`);
    checkCap();await atomic(jobStatePath,{status:'submitting',company:job.company,canonicalUrl:job.url,submittedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),review_id,digest});submitted=true;
    // Receipts are searched from the Submit click, not from after a CAPTCHA wait.
    const submitClickedAt=new Date().toISOString(),submittedFromUrl=page.url(),loadsAtSubmit=documentLoads;
    await save({status:'running',phase:'submitting',message:'Submitting the approved application once'});
    // In the relay Chrome the pointer travels to Submit like a person's (hCaptcha scores the motion, human-input.mjs).
    if(relayChrome){await humanBrowse(page,{moves:2}).catch(()=>{});await humanClick(page,locator);}else await locator.click();await sleep(2000);await screenshot();
    const leverEarlyRejection=leverMonitor?await leverSubmissionOutcome(page,job,{monitor:leverMonitor,timeoutMs:0}):null;
    // Lever's invisible widget may still be loading when the first screenshot is
    // taken. Wait for its normal callback rather than treating a late challenge
    // as a submitted application; an explicit employer rejection takes priority.
    if(!leverEarlyRejection&&(await visibleApplicationChallenge(page)||(leverMonitor&&await captchaPending(page,{challengeVisible:visibleApplicationChallenge})))){
     // Free tiers first (local audio for reCAPTCHA, then his hands in the visible window); 2Captcha only if keyed.
     const pending=p=>leverMonitor?leverChallengePending(p,job,{monitor:leverMonitor,challengeVisible:visibleApplicationChallenge}):captchaPending(p,{challengeVisible:visibleApplicationChallenge});
     const free=await resolveChallengeFree(page,{challengeVisible:pending,headless,relay:relayChrome,company:job.company,manualFirst:visibleAuto||await captchaManualFirst(stateDir,job.url),log:message=>event(message)});
     let captcha=free;
     if(!free.completed){const paid=await completeCaptcha(page,job,{config:await loadCaptchaConfig(join(ROOT,'private/captcha.json')),
      submissionAuthorized:true,log:message=>event(message)});captcha=paid.completed?paid:{...paid,reason:`${free.reason}; ${paid.reason}`};}
     if(!captcha.completed)await recordCaptcha(stateDir,job.url,'post-submit');
     // First, the retry that passed invisibly for him (lesson 420): close the challenge and press Submit once more.
     if(relayChrome&&!captcha.completed&&leverMonitor&&!leverPosted){
      await event('The solver could not answer the challenge; closing it and pressing Submit once more, which Lever has let through without a challenge.');
      await page.keyboard.press('Escape').catch(()=>{});await humanBrowse(page,{moves:2}).catch(()=>{});await sleep(1500);
      await humanClick(page,locator).catch(()=>{});await sleep(6000);await leverMonitor.flush();
      if(leverPosted){
       const retry=lastResponseRefused(leverMonitor)?await leverRetryOnce(page,job,{monitor:leverMonitor,resumePath,log:message=>event(message)}):{status:'accepted'};
       if(retry.status==='accepted'){captcha={completed:true,how:'resubmitted without a challenge'};await event('Lever took the resubmission without a challenge.');}
      }
     }
     if(captcha.completed){await sleep(3000);await screenshot();}
     if(!captcha.completed||await visibleApplicationChallenge(page)){
     const prior=await readJSON(jobStatePath,{});
     await atomic(jobStatePath,{...prior,status:'awaiting_human_submit',challenge:'captcha',updatedAt:new Date().toISOString()});
     // His 2026-11-01 request: when the package solver cannot pass it in the hidden relay Chrome, he finishes the
     // CAPTCHA in a visible Chrome. The hidden tab is closed first so its pending challenge can never submit later;
     // JobAgent then opens his finish-yourself Chrome (humanFinish) with the form refilled. Not when Lever already
     // saw an application POST: that one may have been received and is reconciled first.
     if(relayChrome&&!captcha.completed&&(!leverPosted||lastResponseRefused(leverMonitor))){
      await screenshot();await page.close().catch(()=>{});page=null;
      await event(`${captcha.reason}. Nothing was sent to the employer. Opening a visible Chrome with this application filled in, for you to solve the CAPTCHA and press Submit.`,{status:'needs_human',phase:'captcha_handoff',submission_attempted:false,submitted:false,questions:[],review:null});return;
     }
     await event(`${captcha.completed?'The CAPTCHA remains visible.':captcha.reason+'.'} Submission is waiting on a CAPTCHA; employer acceptance has not been verified. Complete the challenge manually before treating this application as submitted.`,{status:'needs_human',phase:'verification',submission_attempted:true,submitted:false,questions:[],review:null});return;
     }
    }
    const leverRejection=leverEarlyRejection??(leverMonitor?await leverSubmissionOutcome(page,job,{monitor:leverMonitor,timeoutMs:5000}):null);
    if(leverRejection){
     const rejectedResponseCount=leverMonitor.responses().length;
     await atomic(join(runDir,'lever-verification-rejection.json'),leverRejection);
     await screenshot();
     await event('Lever rejected the CAPTCHA verification. The same browser stays open for ten minutes: use its normal Submit button and solve the challenge again. No automatic resubmission will occur.',{status:'running',phase:'verification',submission_attempted:true,submitted:false,questions:[],review:null});
     await notifyMac('JobAgent verification rejected',`${job.company}: use the normal Submit button and solve the CAPTCHA in the open browser. The same page stays open for ten minutes.`);
     // One CAPTCHA-free retry first (lesson 420); the hidden relay Chrome hands a second refusal to his visible Chrome.
     const retried=await leverRetryOnce(page,job,{monitor:leverMonitor,resumePath,log:message=>event(message)});
     if(retried.status!=='accepted'&&relayChrome&&lastResponseRefused(leverMonitor)){
      await atomic(jobStatePath,{...(await readJSON(jobStatePath,{})),status:'awaiting_human_submit',challenge:'captcha',verificationRejection:leverRejection,updatedAt:new Date().toISOString()});
      await page.close().catch(()=>{});page=null;
      await event('Lever refused verification twice; nothing was received. Opening a visible Chrome with this application filled in, for you to solve the CAPTCHA and press Submit.',{status:'needs_human',phase:'captcha_handoff',submission_attempted:false,submitted:false,questions:[],review:null});return;
     }
     const manual=retried.status==='accepted'?{completed:true,by:'lever_retry'}:await waitForManualLeverRetry(page,job,{monitor:leverMonitor,afterResponseCount:leverMonitor.responses().length});
     await screenshot();
     if(!manual.completed){
      const prior=await readJSON(jobStatePath,{});
      await atomic(jobStatePath,{...prior,status:'awaiting_human_submit',challenge:'captcha',verificationRejection:leverRejection,updatedAt:new Date().toISOString()});
      await event(`${manual.reason}. Employer verification was explicitly rejected; application acceptance remains unconfirmed.`,{status:'needs_human',phase:'verification',submission_attempted:true,submitted:false,questions:[],review:null});return;
     }
    }
    const requestCode=async()=>{
     await event('Enter the newest security code from this employer’s email. The verification page stays open for five minutes.',{status:'waiting_answers',phase:'verification',questions:[{id:'security_code',label:`Newest security code for ${job.company}`,type:'text',required:true}],review:null,submission_attempted:true,submitted:false});
     const deadline=Date.now()+300000;
     while(!stopping&&Date.now()<deadline){
      const cmd=await command();
      if(cmd?.action==='answer'&&Object.hasOwn(cmd.answers??{},'security_code')){
       const code=String(cmd.answers.security_code).trim();
       if(/^[A-Za-z0-9]{8}$/.test(code)){await event('Security code received; completing employer verification',{status:'running',phase:'verification',questions:[]});return code;}
       await event('Enter exactly eight letters and digits from the newest employer email.');
      }
      await sleep(350);
     }
     return null;
    };
    const verification=await completeApplicationVerification(page,job,{email:profile.answers?.email,after:submitClickedAt,...helper,execImpl,log:event});
    if(verification.needed&&!verification.completed){
     const prior=await readJSON(jobStatePath,{});
     await atomic(jobStatePath,{...prior,status:verification.retrySafe?'verification_not_accepted':'awaiting_verification_code',updatedAt:new Date().toISOString()});
     await event('The employer has not accepted the application yet; its emailed security code could not be verified.',{status:'needs_human',phase:'verification',questions:[],submission_attempted:true,submitted:false,review:null});return;
    }
    if(verification.completed){await event('Completed the employer email verification step');await screenshot();}
    const webpageEvidence=await waitForWebpageAcceptance(page,job,{submittedAt:submitClickedAt,submittedFromUrl,screenshotPath:join(runDir,'submission-confirmation.png')});
    if(webpageEvidence){
     const prior=await readJSON(jobStatePath,{});
     await atomic(jobStatePath,{...prior,status:'submitted',receiptSource:'webpage',receiptEvidence:webpageEvidence,webpageEvidence,updatedAt:new Date().toISOString()});
     if(visibleAuto)await page?.close().catch(()=>{});/* JobAgent ends the worker at 'completed', before the finally below runs (Tesla 2977) */
     await event('Employer webpage confirmed receipt; application completed',{status:'completed',phase:'completed',submitted:true,receipt:webpageEvidence,receiptSource:'webpage',webpageEvidence,review:null});return;
    }
    // Still on the same form with field errors: the employer did not accept it. Record that
    // plainly instead of waiting for an email that will never come; nothing is resubmitted here.
    const rejection=await collectWebpageRejection(page,{submittedFromUrl,screenshotPath:join(runDir,'submission-rejected.png'),sameDocument:documentLoads===loadsAtSubmit});
    // What the page looks like around each error, shadow roots flattened in, so a control the snapshot misses can be
    // diagnosed from the run folder (lesson 437). Values are not included; only tags, attributes and text.
    if(rejection)await page.evaluate(()=>{
     const html=(n,d=0)=>{if(d>14)return '';if(n.nodeType===3)return n.textContent.replace(/\s+/g,' ');if(n.nodeType!==1)return '';
      const attrs=[...n.attributes].filter(a=>!/^(value|style|data-ja-[a-z-]+)$/i.test(a.name)).map(a=>` ${a.name}="${String(a.value).slice(0,60)}"`).join('');
      const kids=n.tagName==='SLOT'?n.assignedNodes({flatten:true}):[...(n.shadowRoot?[{nodeType:1,tagName:'#shadow',attributes:[],childNodes:n.shadowRoot.childNodes}]:[]),...n.childNodes];
      return `<${n.tagName.toLowerCase()}${attrs}>${kids.map(k=>k.tagName==='#shadow'?`<#shadow>${[...k.childNodes].map(c=>html(c,d+1)).join('')}</#shadow>`:html(k,d+1)).join('')}</${n.tagName.toLowerCase()}>`;};
     const errs=[];const walk=r=>{for(const e of r.querySelectorAll('*')){if(/this field is required|is required/i.test(e.textContent||'')&&e.children.length<3&&e.getClientRects().length)errs.push(e);if(e.shadowRoot)walk(e.shadowRoot);}};walk(document);
     return errs.slice(0,6).map(e=>{let n=e;for(let i=0;i<5&&n;i++)n=n.parentElement||n.getRootNode().host;return html(n||e).slice(0,6000);});
    }).then(dump=>atomic(join(runDir,'submission-errors-dom.json'),dump)).catch(()=>{});
    // Field errors after Submit: nothing was accepted, so fix and submit again, once more with the
    // default model and then once with Fable 5.1 (his rule, 2026-10-18), before asking for help.
    // Spam flags and emailed codes are not fixable by another attempt.
    if(rejection?.outcome==='rejected'&&submitFixes<SUBMIT_FIX_MODELS.length){
     const next=engine==='claude'?SUBMIT_FIX_MODELS[submitFixes]:stepModel;submitFixes++;
     await atomic(jobStatePath,{status:'verification_not_accepted',company:job.company,canonicalUrl:job.url,submittedAt:submitClickedAt,rejection,updatedAt:new Date().toISOString(),review_id,digest});
     submitted=false;stepModel=next;rejected=0;
     history.push({action:'rejected',control:`Submit was not accepted; the form shows: ${[...rejection.messages,...rejection.invalidFields].slice(0,6).join('; ')}. Fix these fields, then review again.`});
     await event(`Submit showed errors (${[...rejection.messages,...rejection.invalidFields].slice(0,3).join('; ')}); fixing them${next?` with ${next}`:''} (attempt ${submitFixes} of ${SUBMIT_FIX_MODELS.length}).`,{status:'running',phase:'fixing_submission',submitted:false});
     continue;
    }
    if(rejection){
     await atomic(jobStatePath,{status:'verification_not_accepted',company:job.company,canonicalUrl:job.url,submittedAt:submitClickedAt,rejection,updatedAt:new Date().toISOString(),review_id,digest});
     const why=rejection.outcome==='flagged_spam'?`the employer's site flagged the submission as possible spam ("${rejection.messages[0]}"); apply by hand on the posting`:rejection.outcome==='verification_code'?`the employer emailed a security code that was not entered ("${rejection.messages[0]}")`:`the form stayed open with errors (${[...rejection.messages,...rejection.invalidFields].slice(0,4).join('; ')||'invalid fields'}); fix them and retry`;
     await event(`Not submitted: ${why}.`,{status:'needs_human',phase:'submission_rejected',review:null,submitted:false,submission_attempted:false,rejection});return;
    }
    // His rule (2026-11-02, lesson 435): a submitted application turns the page into a confirmation. No confirmation
    // and no error we can name is not a success: it goes to Needs help (never resubmitted blind, which could
    // duplicate an application that did go through), and the receipt check below still completes it if mail arrives.
    const stillOnForm=await (async()=>{try{return new URL(page.url()).pathname===new URL(submittedFromUrl).pathname&&await locator.isVisible();}catch{return false;}})();
    const shown=(await page.locator('body').innerText().catch(()=>'')).replace(/\s+/g,' ').trim().slice(0,160);
    await atomic(jobStatePath,{status:'submission_unknown',company:job.company,canonicalUrl:job.url,submittedAt:submitClickedAt,updatedAt:new Date().toISOString(),review_id,digest});
    await screenshot();
    await event(stillOnForm?'Submit did not lead to a confirmation page and no error could be identified: the form is still open. Check the posting or the receipt email before trying again; receipt monitoring continues.'
     :`The page changed after Submit but shows no confirmation ("${shown}"). Check the receipt email or the employer's site; receipt monitoring continues.`,
     {status:'submission_unknown',phase:'submission_unconfirmed',review:null,submitted:false,submission_attempted:true});
    if(!allowLocalFixture){
     const receipt=await fetchApplicationReceipt(job,{email:profile.answers?.email,after:submitClickedAt,...helper,execImpl});
     if(receipt){
      const prior=await readJSON(jobStatePath,{});
      await atomic(jobStatePath,{...prior,status:'submitted',receiptSource:'mailbox',receiptEvidence:receipt,updatedAt:new Date().toISOString()});
      await event('Employer receipt verified; application completed',{status:'completed',phase:'completed',submitted:true,receipt,receiptSource:'mailbox'});
     }
    }
    return;
   }
   if(action.action==='click'||profileStep(control.label)||isApplicationEntry(control,answered,job)){
    if(deferred.length&&safeNavigation(control.label,job)){await parkNow();return;}  // Never leave a page with its questions unanswered.
    if(flagged(control.label)){await parkNow();return;}
    const historyAdd=safeHistoryAdd(control,page.url());
    const sectionExpand=safeSectionExpand(control,frame.url);
    const linkPlatforms=allowLocalFixture?[...HIRING_PLATFORMS,'127.0.0.1','localhost']:HIRING_PLATFORMS;
    if(!safeNavigation(control.label,job)&&!safeRoleLink(control,job,{platforms:linkPlatforms})&&!isApplicationEntry(control,answered,job)&&!historyAdd&&!sectionExpand){await reject(`${control.label} is not a Next, Continue, Apply, history-add or section-expansion button`);continue;}
    const offSite=!historyAdd&&!sectionExpand&&offSiteLink(control.href,page.url());
    if(offSite&&!platformApplyLink(control,job,{platforms:linkPlatforms,pageUrl:page.url()})&&!safeRoleLink(control,job,{platforms:linkPlatforms}))throw new Error('An external application link needs a separate verified application URL');
    // The platform link may target a new tab (LLNL's target="_blank"); open it in this tab instead.
    if(offSite){await page.goto(control.href,{waitUntil:'domcontentloaded',timeout:45000});await event(`Opened: ${control.label} on ${new URL(control.href).hostname}`);await sleep(600);continue;}
    // Tesla's Apply is <a target="_blank">: the click opened the form in a new tab and the run stayed on the posting
    // (11928, lesson 460). An Apply link that targets a new tab is opened in this tab instead.
    if(control.href&&applyLabel(control.label,job)&&await locator.evaluate(el=>(el.closest('a')??el).getAttribute('target')==='_blank').catch(()=>false)){await page.goto(new URL(control.href,page.url()).href,{waitUntil:'domcontentloaded',timeout:45000});await event(`Opened: ${control.label}`);await sleep(600);await page.waitForLoadState('networkidle',{timeout:8000}).catch(()=>{});continue;}
    await clickPastCookieBanner(locator);await event(`Opened: ${control.label}`);await sleep(600);await page.waitForLoadState('networkidle',{timeout:8000}).catch(()=>{});continue;
   }
   throw new Error('Unsupported browser action');
   }catch(e){
    if(control&&detachedControlError(e)&&await locator.count().catch(()=>0)===0){await rerendered();continue;}
    throw e;
   }
  }
  if(deferred.length){await parkNow();return;}
  throw new Error('Preparation reached its step limit. Review the saved view before continuing.');
 }catch(e){
  // A run he asked to finish himself (handoffOnFailure) leaves the visible window open on the
  // field it could not fill, or after his own Submit, instead of closing it; nothing is submitted for him.
  if(!stopping&&page&&!page.isClosed()&&!submitted&&(await readJSON(join(runDir,'request.json'),{}).catch(()=>({}))).humanFinish===true){
   await event(`Handed to you in your Chrome window: ${e.message}. Finish the remaining fields and press Submit yourself.`,{status:'needs_human',phase:'human_submit',questions:[],review:null});
   await notifyMac('JobAgent needs you',`Finish the application in the Chrome window and press Submit.`).catch(()=>{});
   await page.bringToFront().catch(()=>{});await context?.unroute('**/*').catch(()=>{});return;
  }
  const handoff=!stopping&&!headless&&page&&!page.isClosed()&&keepHandoffOpen({request:await readJSON(join(runDir,'request.json'),{}).catch(()=>({})),submitted,manualSubmissionAt});
  if(handoff){
   await event(`Handed to you in the open browser window: ${e.message}. Finish the remaining fields and press Submit yourself; the window stays open for 30 minutes.`,{status:'needs_human',phase:'human',questions:[],review:null});
   await notifyMac('JobAgent needs you',`Finish the application in the open browser window and press Submit.`).catch(()=>{});
   await page.bringToFront().catch(()=>{});
   // His own Submit stays recorded as unverified until a receipt reconciles it.
   if(manualSubmissionAt&&jobStatePath){const prior=await readJSON(jobStatePath,{});await atomic(jobStatePath,{...prior,status:'submission_unknown',submittedAt:manualSubmissionAt,updatedAt:new Date().toISOString()});}
   await page.waitForEvent('close',{timeout:1800000}).catch(()=>{});
   if(manualSubmissionAt)await event('Your Submit in the open window was recorded; acceptance is unverified until an employer receipt arrives.',{status:'submission_unknown',phase:'submission_unknown',submission_attempted:true,submitted:false,questions:[],review:null});
   return;
  }
  const closedTab=!stopping&&closedTabFailure(e,{tabClosed,submitted});if(closedTab){await event(closedTab,{status:'failed',phase:'failed',questions:[],review:null});return;}
  const unreachable=!submitted&&!stopping&&siteNavigationFailure(e);if(unreachable){await event(`Site unavailable: ${unreachable}. The queue will retry after a cooldown.`,{status:'blocked',phase:'blocked',questions:[],review:null});return;}
  const status=submitted?'submission_unknown':stopping?'stopped':'failed';if(submitted&&jobStatePath){const prior=await readJSON(jobStatePath,{});await atomic(jobStatePath,{...prior,status,...(manualSubmissionAt?{submittedAt:manualSubmissionAt}:{}),updatedAt:new Date().toISOString()});}await event(submitted?'Submission outcome is uncertain. Check for an employer receipt before retrying.':e.message,{status,phase:status,questions:[],review:null});}
 finally{await leverMonitor?.flush();leverMonitor?.stop();clearInterval(timer);await live?.stop().catch(()=>{});if(relayChrome||visibleAuto)await page?.close().catch(()=>{});/* a visible automatic run leaves no tab behind */unhide?.();await browser?.close().catch(()=>{});/* over CDP this only disconnects; his window stays open */for(const lock of [jobLock,companyLock])if(lock){await lock.close();await unlink(lock.pathName).catch(()=>{});}process.off('SIGTERM',stop);process.off('SIGINT',stop);
  if(hintRun)await finishSiteHints(runDir,hintRun,state).catch(()=>{});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){if(!process.argv[2])throw new Error('Usage: node src/dashboard-worker.mjs RUN_DIR');keepAwake();await runWorker(process.argv[2]);}
