import test from 'node:test';import assert from 'node:assert/strict';
import {genericResumeDrop} from '../src/generic-resume-drop.mjs';
const sr='https://jobs.smartrecruiters.com/oneclick-ui/company/X/publication/1';
const drop={id:'a',label:'Choose a file or drop it here',type:'file'};
test('SmartRecruiters résumé drop zone is the résumé, once',()=>{
 assert.equal(genericResumeDrop(drop,sr,[drop],false),true);
 assert.equal(genericResumeDrop(drop,sr,[drop],true),false);
 assert.equal(genericResumeDrop(drop,sr,[{...drop,id:'b'},drop],false),false);
 assert.equal(genericResumeDrop(drop,'https://example.com/apply',[drop],false),false);
 assert.equal(genericResumeDrop({...drop,label:'Cover letter'},sr,[drop],false),false);
});
// Intuitive 12316 (lesson 414): two identical zones; the résumé field is the second, under a "Resume" heading.
test('a SmartRecruiters drop zone is placed by its section heading before its position',()=>{
 const parser={id:'f0c0',label:'Choose a file or drop it here',type:'file'},resume={id:'f0c15',label:'Choose a file or drop it here',type:'file'};
 assert.equal(genericResumeDrop(resume,sr,[parser,resume],false,'Resume'),true);
 assert.equal(genericResumeDrop(parser,sr,[parser,resume],false,'Choose an option to autocomplete your application.'),true);
 assert.equal(genericResumeDrop(resume,sr,[parser,resume],false,'Cover letter'),false);
 assert.equal(genericResumeDrop(resume,sr,[parser,resume],false,'Additional attachments'),false);
 assert.equal(genericResumeDrop(resume,sr,[parser,resume],true,'Resume'),false);
 assert.equal(genericResumeDrop(resume,sr,[parser,resume],false,''),false);
 assert.equal(genericResumeDrop(resume,sr,[parser,resume],false,'Your Profiles'),false);
});
