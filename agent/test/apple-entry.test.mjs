import test from 'node:test';import assert from 'node:assert/strict';
import {isApplicationEntry,isFinalControl} from '../src/dashboard-worker.mjs';
test('a posting page "Submit Resume" button opens the application and is never a final Submit (Apple 11807)',()=>{
 const entry={label:'Submit Resume',type:'button'};
 assert.equal(isApplicationEntry(entry,[],{}),true);assert.equal(isFinalControl(entry,[],{}),false);
 // Inside a filled application form, a real submit stays final.
 assert.equal(isFinalControl({label:'Submit',type:'submit',formFields:5},[{label:'x'}],{}),true);
});

test('Apple\'s real entry link label "Submit Resume: <title> <req>" outside a form is never final',()=>{
 const link={label:'Submit Resume: Accessory Product Design Engineer 200687730-0836',type:'link',inForm:false,formFields:0,href:'https://jobs.apple.com/app/en-us/apply/200687730-0836'};
 assert.equal(isFinalControl(link,[],{title:'Accessory Product Design Engineer'}),false);
 assert.equal(isFinalControl({...link,label:'Submit'},[{label:'x'}],{}),false,'any link outside a form');
});

test('a Submit button on an email-only gate is never the final Submit (Cisco 12281)',()=>{
 assert.equal(isFinalControl({label:'Submit',type:'submit',inForm:true,formFields:1},[{label:'Email address'}],{}),false);
 assert.equal(isFinalControl({label:'Submit application',type:'submit',inForm:true,formFields:12},[{label:'x'}],{}),true);
});

import {safeNavigation} from '../src/dashboard-worker.mjs';
test('an exact "Proceed" button is navigation (IBMid notice page), not a final Submit',()=>{
 assert.equal(safeNavigation('Proceed'),true);
 assert.equal(isFinalControl({label:'Proceed',type:'button',inForm:true,formFields:0},[],{}),false);
 assert.equal(safeNavigation('Proceed to submit'),false);
});
