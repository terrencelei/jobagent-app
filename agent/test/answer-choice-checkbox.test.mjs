import test from 'node:test';import assert from 'node:assert/strict';
import {answerChoiceText} from '../src/data-consent.mjs';
// Arista 11815 (SmartRecruiters): the disability question was read as one required checkbox and auto-ticked.
test('a Yes/No choice group is not an attestation checkbox',()=>{
 assert.equal(answerChoiceText('(definitions) Yes No Prefer not to answer Do you have (or have a history/record of having) a disability? (definitions)'),true);
 assert.equal(answerChoiceText('I certify that I have not knowingly withheld any information.'),false);
 assert.equal(answerChoiceText('You declare that you have read and agree to the privacy notice of Arista Networks.*'),false);
});
