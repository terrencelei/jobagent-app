// Pages a posting link can lead to that are not a job application (idea from ApplyPilot's hard
// stops): contractor marketplaces, talent-network sign-ups, coding or video assessments, and
// selfie/ID verification. These used to end as Needs help or a repair; the run now stops before
// filling anything, JobAgent marks the posting ignored, and autoplay does not take it again.
const within=(host,domain)=>host===domain||host.endsWith('.'+domain);

// Contractor and gig marketplaces: their sign-up builds a freelancer profile, not an application.
export const MARKETPLACES=['mercor.com','toptal.com','turing.com','upwork.com','fiverr.com','usebraintrust.com','micro1.ai',
 'outlier.ai','dataannotation.tech','remotasks.com','alignerr.com','andela.com'];
// Assessment and one-way video interview sites; employers send these after an application.
export const ASSESSMENTS=['hackerrank.com','codility.com','codesignal.com','testgorilla.com','coderbyte.com','hirevue.com',
 'sparkhire.com','willo.video','harver.com'];

const TALENT_PATH=/\/(?:talent-?(?:network|community)|join-?(?:our-?)?talent|talentcommunity|talentnetwork)(?:[/?#.]|$)/i;
const TALENT_HEADING=/^(?:join (?:our |the )?)?talent (?:network|community)\.?$/i;
// Identity checks that need a camera or a photo of a government ID.
const IDENTITY=/\b(?:take|upload|capture) (?:a |your )?selfie\b|\bphoto of your (?:government[- ]issued |driver'?s )?(?:id|license|passport)\b|\bverify your identity with (?:a )?(?:photo|selfie|camera|video)\b|\b(?:allow|enable) (?:access to )?your (?:camera|webcam|microphone)\b|\brecord (?:a |your )?(?:video|one-way video) (?:response|interview|introduction)\b/i;

// {kind, reason} when the page in front of the worker is not an application, else null.
// heading: the page's first h1; text: its visible text (only checked for identity wording).
export function notApplication({url,heading='',text=''}={}){
 let parsed;try{parsed=new URL(url);}catch{return null;}
 const host=parsed.hostname.toLowerCase();
 const market=MARKETPLACES.find(d=>within(host,d));
 if(market)return {kind:'contractor_marketplace',reason:`${market} is a contractor marketplace; its sign-up builds a freelancer profile, not an application`};
 const assessment=ASSESSMENTS.find(d=>within(host,d));
 if(assessment)return {kind:'assessment',reason:`${assessment} is an assessment or video-interview site, which employers send after an application`};
 if(TALENT_PATH.test(parsed.pathname)||TALENT_HEADING.test(String(heading).trim()))
  return {kind:'talent_network',reason:'the link opens a talent-network sign-up, not an application for this role'};
 const identity=String(text).slice(0,20000).match(IDENTITY);
 if(identity)return {kind:'identity_verification',reason:`the page asks for camera or ID verification ("${identity[0]}")`};
 return null;
}
