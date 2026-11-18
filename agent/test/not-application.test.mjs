import test from 'node:test';
import assert from 'node:assert/strict';
import {notApplication} from '../src/not-application.mjs';

test('contractor marketplaces, assessments, talent networks and ID checks are not applications', ()=>{
 assert.equal(notApplication({url:'https://work.mercor.com/jobs/list_AAABk'}).kind,'contractor_marketplace');
 assert.equal(notApplication({url:'https://www.toptal.com/talent/apply'}).kind,'contractor_marketplace');
 assert.equal(notApplication({url:'https://app.codesignal.com/test/abc'}).kind,'assessment');
 assert.equal(notApplication({url:'https://careers.acme.com/talent-community?src=x'}).kind,'talent_network');
 assert.equal(notApplication({url:'https://careers.acme.com/join',heading:'Join our Talent Community'}).kind,'talent_network');
 assert.equal(notApplication({url:'https://apply.acme.com/x',text:'Next, take a selfie to verify your identity.'}).kind,'identity_verification');
});

test('ordinary applications, and pages that only mention a talent community, are left alone', ()=>{
 for(const page of [
  {url:'https://job-boards.greenhouse.io/acme/jobs/123',heading:'Mechanical Engineer',text:'Join our talent community to hear about future roles. Apply for this job'},
  {url:'https://acme.wd1.myworkdayjobs.com/External/job/Goleta/ME_R123',heading:'Mechanical Engineer'},
  {url:'https://jobs.lever.co/turingvideo/abc',heading:'Hardware Engineer'},  // not turing.com
  {url:'https://careers.acme.com/jobs/talented-engineer-123'},
  {url:'not a url'},
 ])assert.equal(notApplication(page),null,page.url);
});
