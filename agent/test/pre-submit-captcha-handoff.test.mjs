import test from 'node:test';
import assert from 'node:assert/strict';
import {preSubmitCaptchaHandoff} from '../src/dashboard-worker.mjs';

// Rivian iCIMS (lesson 451): the login hCaptcha opens before any Submit and the vision model declines it.
test('an unsolved challenge before Submit is handed to him in a visible Chrome', () => {
 const free={completed:false,declined:true,reason:'the vision model declined to solve it'};
 assert.equal(preSubmitCaptchaHandoff({request:{},submitted:false,free}),true);
});
test('no hand-off from his own finish-yourself run, after a submit, on a solve, or at an edge wall', () => {
 const free={completed:false,reason:'x'};
 assert.equal(preSubmitCaptchaHandoff({request:{humanFinish:true},submitted:false,free}),false);
 assert.equal(preSubmitCaptchaHandoff({request:{},submitted:true,free}),false);
 assert.equal(preSubmitCaptchaHandoff({request:{},submitted:false,free:{completed:true}}),false);
 assert.equal(preSubmitCaptchaHandoff({request:{},submitted:false,free:{completed:false,wall:true}}),false);
});

// Tesla (lesson 452): Akamai refuses headless browsers; JobAgent marks such sites realChrome.
import {realChromeRun} from '../src/dashboard-worker.mjs';
test('a realChrome request runs in the hidden real Chrome unless he is finishing it himself', () => {
 assert.equal(realChromeRun({realChrome:true}),true);
 assert.equal(realChromeRun({realChrome:true,humanFinish:true}),false);
 assert.equal(realChromeRun({}),false);
});
