import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmationPageText} from '../src/application-acceptance.mjs';

test('iCIMS success banner in his own Chrome reads as a confirmation (Rivian 12055)',()=>{
 assert.ok(confirmationPageText('Early Career - Occupant Safety Engineer Your application was submitted successfully. Thank you for applying. You are currently submitted to this job. About Us'));
 assert.ok(confirmationPageText('You are currently submitted to this job.'));
});
test('a sign-in or verification page is not a confirmation',()=>{
 assert.equal(confirmationPageText('Log in Email Password Forgot password? Apply for this job online'),null);
 assert.equal(confirmationPageText('Thank you for applying. Enter the verification code we sent to your email.'),null);
});
test("Tesla's received page reads as a confirmation (Tesla 2976)",()=>{
 assert.ok(confirmationPageText('Careers Your Application Has Been Received Applied Reinforcement Learning Engineer, Whole Body Controls, Optimus What\'s Next Check your email to create your Tesla Connect account.'));
});
