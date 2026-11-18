import test from 'node:test';
import assert from 'node:assert/strict';
import {routineApplicationAnswer} from '../src/routine-application-policy.mjs';

// Freeform 13281 (Greenhouse): the source list brands its LinkedIn choice "LinkedIn (Freeform Job Post)". His answer
// approved for Freeform 10199 was "LinkedIn post", yet the fallback chose Handshake because the branded option was
// not recognised as the generic LinkedIn post and the saved answer matched nothing.
const options=['Word of mouth','University/college connections','Handshake','Media/publication','Podcast','YouTube',
 'Internet forum (Reddit/Hacker News/etc.)','Researching 3D printing industry','Researching AI/ML industry','Conference/speaking event',
 'LinkedIn (Freeform Job Post)','LinkedIn (Freeform Video)','LinkedIn (Freeform Non-Video Content)','Social media (Instagram)',
 'Social media (Facebook)','Social media (X)','Recruiter outreach (Freeform recruiter)','Recruiter outreach (Agency)','Outdoor advertising (billboard or flyer)'];
const answers={routineSourceChoiceAllowed:true,hearAbout:'Careers site',heardJobBoard:true};
const bank={'how did you hear about us?':{question:'How did you hear about us?*',answer:'LinkedIn post',approvedFor:'10199'}};

test('a saved "LinkedIn post" answer selects the employer-branded LinkedIn job post option',()=>{
 const got=routineApplicationAnswer('How did you hear about us?*',answers,{options,company:'Freeform',bank});
 assert.equal(got?.value,'LinkedIn (Freeform Job Post)');
 assert.equal(got.authoritative,true);
});

test('the branded LinkedIn job post is generic, so it is preferred over a named job site when nothing is saved',()=>{
 const got=routineApplicationAnswer('How did you hear about us?*',answers,{options,company:'Freeform',bank:{}});
 assert.equal(got?.value,'LinkedIn (Freeform Job Post)');
 // Video and non-video content stay distinct from a job post, and a referral is never chosen.
 const narrowed=options.filter(o=>o!=='LinkedIn (Freeform Job Post)');
 const fallback=routineApplicationAnswer('How did you hear about us?*',answers,{options:narrowed,company:'Freeform',bank});
 assert.equal(fallback?.value,'Handshake');
});

test('a plain "LinkedIn post" option and a saved branded answer still match each other',()=>{
 const got=routineApplicationAnswer('How did you hear about us?',answers,{options:['Indeed','LinkedIn post','Referral'],company:'Freeform',
  bank:{'how did you hear about us?':{question:'How did you hear about us?*',answer:'LinkedIn (Freeform Job Post)'}}});
 assert.equal(got?.value,'LinkedIn post');
});
