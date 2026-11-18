import test from 'node:test';
import assert from 'node:assert/strict';
import {equivalentOption} from '../src/settled-facts.mjs';

// Anduril 4662: an unopened Greenhouse combobox gives the routine source policy no options, so it
// falls back to "Company Website"; the offered choice is "Anduril Website" and the run kept parking.
const options=['Google job search','News coverage of Anduril','Anduril social media','Anduril YouTube videos','LinkedIn','Indeed','Anduril Website','Other'];
const label='How did you hear about Anduril?*';

test('a generic company-site source picks the employer\'s own named website option',()=>{
 for(const value of ['Company Website','Careers site','company careers page'])
  assert.equal(equivalentOption(label,value,options,{},{company:'Anduril'}),'Anduril Website');
});

test('other employers\' named options and missing company stay unmatched',()=>{
 assert.equal(equivalentOption(label,'Company Website',['Anduril YouTube videos','Anduril social media'],{},{company:'Anduril'}),null);
 assert.equal(equivalentOption(label,'Company Website',options,{},{}),null);
 assert.equal(equivalentOption('Gender','Company Website',options,{},{company:'Anduril'}),null);
});
