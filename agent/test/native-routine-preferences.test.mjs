import test from 'node:test';
import assert from 'node:assert/strict';
import {approvedValue,resolveKnownQuestion} from '../src/dashboard-worker.mjs';
import {questionId} from '../src/companies.mjs';
import {routineQuestionNeedsReview} from '../src/routine-application-policy.mjs';

test('native source select resolves an offered LinkedIn choice instead of an unavailable default website',()=>{
 const profile={answers:{routineSourceChoiceAllowed:true,hearAbout:'Careers site'}};
 const label='How did you hear about us?';
 const control={label,type:'select',options:[{label:'Select one',value:''},{label:'Employee Referral',value:'referral'},{label:'LinkedIn',value:'linkedin'}]};
 const answer=approvedValue({fact:'routineSourceChoiceAllowed'},control,profile,{},new Map(),'Fixture',{company:'Fixture'});
 assert.equal(answer,'LinkedIn');
 assert.ok(control.options.some(option=>option.label===answer));
 // Missing options can only propose the policy's generic source; actual options
 // must be passed before choosing an employer's real native-select value.
 assert.equal(approvedValue({fact:'routineSourceChoiceAllowed'},{label,type:'text'},profile,{},new Map(),'Fixture',{company:'Fixture'}),'Company Website');
});

test('native employment select preserves actual resume employer history over default No',()=>{
 const label='Have you previously worked for us?';
 const profile={answers:{employerEmploymentDefault:'No'},workHistory:[{company:'Fixture Company',title:'Engineer',from:['1','2025'],to:['6','2025']}]};
 const control={label,type:'select',options:[{label:'Yes',value:'yes'},{label:'No',value:'no'}]};
 assert.equal(approvedValue({fact:'employerEmploymentDefault'},control,profile,{},new Map(),'Fixture Company',{company:'Fixture Company'}),'Yes');
 assert.equal(approvedValue({fact:'employerEmploymentDefault'},control,profile,{},new Map(),'Another Company',{company:'Another Company'}),'No');
});

test('native family-employment default overrides a stale bank Yes without inventing a resume family connection',()=>{
 const label='Do any members of your family work for us?';
 const profile={answers:{employerEmploymentDefault:'No'},workHistory:[{company:'Fixture Company',title:'Engineer'}]};
 const control={label,type:'select',options:[{label:'Yes',value:'yes'},{label:'No',value:'no'}]};
 const bank={saved:{question:label,answer:'Yes'}};
 assert.equal(approvedValue({fact:'employerEmploymentDefault'},control,profile,bank,new Map(),'Fixture Company',{company:'Fixture Company'}),'No');
 profile.answers.employerEmploymentExceptions=[{company:'Fixture Company',family:true}];
 assert.equal(approvedValue({fact:'employerEmploymentDefault'},control,profile,bank,new Map(),'Fixture Company',{company:'Fixture Company'}),'Yes');
});

test('compound source writing uses only approval of the full question, never a fuzzy source answer',()=>{
 const label='How did you hear about us and why do you want to work here?';
 const question={label,type:'textarea'},profile={answers:{routineSourceChoiceAllowed:true}};
 const bank={'intent:how-heard':{question:'How did you hear about us?',answer:'LinkedIn'}};
 assert.throws(()=>approvedValue({},question,profile,bank,new Map(),'Fixture'),/own approved/);
 assert.equal(resolveKnownQuestion({question,profile,bank}).resolved,false);
 const answer='I found the role on LinkedIn. Your engineering focus matches my experience.';
 assert.equal(approvedValue({},question,profile,bank,new Map([[questionId(label),answer]]),'Fixture'),answer);
 const exact={...bank,[questionId(label)]:{question:label,answer}};
 assert.equal(resolveKnownQuestion({question,profile,bank:exact}).value,answer);
});

test('the history guard does not turn confirmed legal work authorization into a prose approval',()=>{
 const label='Are you legally able to work for our company in the United States?';
 assert.equal(routineQuestionNeedsReview(label),false);
 const profile={answers:{workAuthorizationCountries:['United States']}};
 assert.equal(resolveKnownQuestion({question:{label},profile,job:{location:'California, United States'}}).value,'Yes');
});

test('an approved generic source for this run beats the routine default on typeahead and native selects (Formlabs 7693)',()=>{
 const profile={answers:{routineSourceChoiceAllowed:true,hearAbout:'Careers site'}};
 const label='How did you hear about us?*';
 const inline=new Map([[questionId(label),'Other']]);
 assert.equal(approvedValue({},{label,type:'text',combobox:true},profile,{},inline,'Fixture',{company:'Fixture'}),'Other');
 const control={label,type:'select-one',options:['Google','LinkedIn','Other'].map(label=>({label,value:label}))};
 assert.equal(approvedValue({},control,profile,{},inline,'Fixture',{company:'Fixture'}),'Other');
});
