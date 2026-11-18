// Required consents to processing his personal data for the application (his standing rule of 2026-11-01:
// "Yes, always"). A REQUIRED in-form checkbox whose text consents to processing personal data for recruiting,
// or acknowledges the employer's privacy notice/policy for the application, is ticked without asking.
// Anything that also opts him into marketing, newsletters, a talent community, job alerts, calls or SMS is
// never ticked here, and optional boxes are never ticked: those keep the ordinary answer path.
const OPT_IN=/\b(marketing|newsletters?|promotion(?:al|s)?|talent (?:community|network|pool|hub)|job alerts?|career alerts?|sms|text messages?|texts?\b|calls?|voice messages?|company updates|news\b|(?:un)?subscribe|opt[- ]?in|mailing list|events? invitations?|career opportunities)\b/i;
const CONSENT=/\b(consent|agree|acknowledge|accept|understand|authori[sz]e|confirm (?:that )?i have read)\b/i;
const PERSONAL_DATA=/\b(personal (?:data|information)|my (?:personal )?(?:data|information)|candidate data|applicant data|data (?:processing|protection)|processing of|processed in accordance|privacy (?:notice|policy|statement|terms))\b/i;
const RECRUITING=/\b(applications?|apply|applying|recruit(?:ing|ment)?|hiring|candidacy|candidates?|applicants?|employment|job|role|selection)\b/i;
// applicationContext: the caller already knows the box sits in an application (not an account page), so the text
// need not repeat it. Intuitive's "You declare that you have read and agree to the privacy notice of Intuitive."
// (lesson 427) names no application but is the form's required privacy consent.
// A box that signs him up for marketing, alerts, calls or SMS: never ticked, even when marked required.
// A Yes / No / Prefer-not-to-answer question (Arista's disability or veteran group on SmartRecruiters, lesson 457) can be
// read as ONE required checkbox whose label lists the choices. It is an answer, not an attestation: never auto-ticked.
export const answerChoiceText=text=>/\byes\b\s+(?:or\s+)?\bno\b/i.test(String(text??'').replace(/\s+/g,' '));
export const optInText=text=>OPT_IN.test(String(text??''));
export function recruitingDataConsentText(text,{applicationContext=false}={}){
 const t=String(text??'').replace(/\s+/g,' ').trim();
 if(!t||t.length>2000||OPT_IN.test(t))return false;
 return CONSENT.test(t)&&PERSONAL_DATA.test(t)&&(applicationContext||RECRUITING.test(t));
}
// The control's own caption (optionLabel, for a box inside a group) and its group question are both read: the
// group heading may say "Marketing preferences" while the box itself mentions personal data.
export function requiredRecruitingConsent(control,{applicationContext=false}={}){
 if(!control||control.type!=='checkbox'||control.inForm===false)return false;
 const text=[control.label,control.optionLabel].filter(Boolean).join(' ');
 // Kratos / submit4jobs (14919) marks the box required only in red text ("you must agree to the privacy statement"),
 // with no required attribute: the caption itself saying so counts.
 if(control.required!==true&&!/\b(?:you\s+)?must\s+(?:agree|accept|consent)\b[^.]*\bprivacy\b/i.test(text))return false;
 return recruitingDataConsentText(text,{applicationContext});
}
// The control sits inside the application/account form itself, so the box need not name the job (Kratos 14919 on
// submit4jobs/pereless: "I agree to the privacy statement (... you must agree to the privacy statement.)" names only
// the account). Used where the worker answers an in-form checkbox; opt-ins and optional boxes still fall through.
export function inFormConsentToTick(control){
 return requiredRecruitingConsent(control,{applicationContext:control?.inForm===true});
}
