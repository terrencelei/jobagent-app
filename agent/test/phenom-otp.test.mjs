import test from 'node:test';
import assert from 'node:assert/strict';
import {phenomOtpPage, verifiedPhenomCode} from '../src/phenom-otp.mjs';

const job = {title: 'Machine Learning Engineer (AI Enablement)', url: 'https://careers.gene.com/us/en/job/202610-127752/Machine-Learning-Engineer-AI-Enablement'};
const after = '2026-11-01T05:11:30.400Z', now = Date.parse('2026-11-01T05:12:00Z');
const mail = (over = {}) => ({messageId: '1a1958525580c067', receivedAt: '2026-11-01T05:11:30Z', sender: 'recruiting@jobalerts.gene.com',
  recipients: ['applicant@example.edu'], subject: 'Your OTP for job at Roche',
  body: 'Hi,Enter your one-time password (OTP) to continue with your application.Your otp is: 287972 for job: Machine Learning Engineer (AI Enablement)PLEASE NOTE: This OTP is valid only for next 10 mins.', ...over});
const check = value => verifiedPhenomCode(value, {email: 'applicant@example.edu', after, jobURL: job.url, title: job.title, now});

test('the Genentech OTP step is recognised only on the posting site apply path', () => {
  assert.equal(phenomOtpPage('https://careers.gene.com/us/en/apply?jobSeqNo=GENEUS202610127752EXTERNALENUS&step=1', job.url), true);
  assert.equal(phenomOtpPage('https://careers.gene.com/us/en/job/202610-127752/x', job.url), false);
  assert.equal(phenomOtpPage('https://evil.example/us/en/apply', job.url), false);
  assert.equal(phenomOtpPage('https://careers.other.com/us/en/apply', 'https://careers.other.com/us/en/job/1'), false, 'unknown tenant');
});

test('only a fresh OTP mail in the tenant template, to him, for this job yields the code', () => {
  assert.equal(check(mail()), '287972');
  assert.equal(check(mail({sender: 'recruiting@jobalerts.gene.com.evil.io'})), null);
  assert.equal(check(mail({subject: 'Your OTP for job at Roche!'})), null);
  assert.equal(check(mail({recipients: ['someone@else.com']})), null);
  assert.equal(check(mail({receivedAt: '2026-11-01T05:00:00Z'})), null, 'before GET OTP');
  assert.equal(check(mail({body: mail().body.replace('Machine Learning Engineer (AI Enablement)', 'Data Scientist')})), null, 'another job');
  assert.equal(verifiedPhenomCode(mail(), {email: 'applicant@example.edu', after, jobURL: job.url, title: job.title, now: Date.parse('2026-11-01T05:22:00Z')}), null, 'expired');
});
