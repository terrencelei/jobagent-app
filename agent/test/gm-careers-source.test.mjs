import test from 'node:test';
import assert from 'node:assert/strict';
import {pickOption,resolveQuestion} from '../src/workday.mjs';
import {routineApplicationAnswer} from '../src/routine-application-policy.mjs';

// GM's Workday source menu (job 12142) names its own site by initials.
const options=['Career Fair / Professional Organization Event','Contacted by Company Recruiter','Email / Newsletter','GM.com Website','GM Careers Website','Internet Job Board /  Job Search','Referred by GM Employee','University / College Recruiting / Campus Event','Veteran Partner','Workforce Development Partner'];
const answers={routineSourceChoiceAllowed:true,hearAbout:'Careers site'};

test('the routine source rule maps General Motors to its GM Careers Website option', () => {
  assert.equal(routineApplicationAnswer('How Did You Hear About Us?',answers,{company:'General Motors',options})?.value,'GM Careers Website');
});

test('before the prompt opens, the Workday source candidates still reach GM Careers Website', () => {
  const heard=resolveQuestion('How Did You Hear About Us?',{},{company:'General Motors',answers});
  assert.equal(heard.candidates[0],'Company Website');
  assert.equal(pickOption(options,heard.candidates),'GM Careers Website');
});

test('initials do not match a different employer or a non-site option', () => {
  assert.equal(routineApplicationAnswer('How Did You Hear About Us?',answers,{company:'Lockheed Martin',options:['GM Careers Website','Referred by GM Employee']}),null);
});
