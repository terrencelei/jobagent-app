import test from 'node:test';
import assert from 'node:assert/strict';
import {approvedValue,choiceNeedsAction} from '../src/dashboard-worker.mjs';

// Karman 16537 (Greenhouse): the DoD clearance question is a required checkbox fieldset whose never-held option is
// "I have never held a DoD security clearance". Lesson 468 added a RegExp candidate for that wording, but the
// checkbox-group branch compared candidates as strings, so no box matched and the run failed at Submit.
const label='Which option best describes the highest level and current status of any DoD security clearance eligibility you hold or previously held? *';
const choiceLabels=['Active Confidential','Inactive Confidential','Active Secret','Inactive Secret','Active Top Secret','Inactive Top Secret','I have never held a DoD security clearance','I’m not sure'];
const profile={answers:{heldSecurityClearance:'No',currentSecurityClearance:'No'}};
test('a never-held clearance answer ticks only the never-held box in a checkbox group',()=>{
 const ticked=choiceLabels.filter(optionLabel=>approvedValue({},{label,type:'checkbox',optionLabel,choiceLabels,required:true,value:'false'},profile,{},new Map(),'Karman Space & Defense')===true);
 assert.deepEqual(ticked,['I have never held a DoD security clearance']);
});
// choiceNeedsAction hides a box whose approved state equals its current one, so with no RegExp match the whole
// required group was hidden from the step model and never ticked (no "Answered" event, then the Submit check failed).
test('only the never-held box of the clearance group is shown to the step agent',()=>{
 const shown=choiceLabels.filter(optionLabel=>choiceNeedsAction({label,type:'checkbox',optionLabel,choiceLabels,required:true,value:'false'},profile,{},new Map(),'Karman Space & Defense'));
 assert.deepEqual(shown,['I have never held a DoD security clearance']);
});

// Karman 16669 offers the same question with different wording: "Never held a DoD security clearance".
test('the never-held box is ticked when the option has no "I have" prefix',()=>{
 const labels=['Active Secret clearance','Active Top Secret clearance','Inactive Secret clearance','Inactive Top Secret clearance','Never held a DoD security clearance','Unsure of clearance status'];
 const ticked=labels.filter(optionLabel=>approvedValue({},{label,type:'checkbox',optionLabel,choiceLabels:labels,required:true,value:'false'},profile,{},new Map(),'Karman Space & Defense')===true);
 assert.deepEqual(ticked,['Never held a DoD security clearance']);
});
