import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshot} from '../src/dashboard-worker.mjs';
import {searchFilterControl} from '../src/posting-navigation.mjs';

// LLNL 12783: the posting page's "Refine Search" sidebar offered "None, U.S. Citizenship (4)"; answering it as a
// citizenship question turned the posting into a filtered search that no longer listed the role.
const POSTING=`<div class="refine"><h3>Refine Search</h3><a href="#">Clear All</a><ul>
 <li class="facet-item"><input type="checkbox" class="facets-checkbox" id="b1"><label for="b1"><span class="facet-item__value">None, U.S. Citizenship (4)</span></label></li>
 <li class="facet-item"><input type="checkbox" class="facets-checkbox" id="b2"><label for="b2"><span class="facet-item__value">Q (1,204)</span></label></li></ul></div>
 <main><h1>Mechanical Engineer – Generalist</h1><p>Requires U.S. citizenship.</p>
 <form><label><input type="checkbox" id="citizen" required> Are you a U.S. citizen?</label>
 <label><input type="checkbox" id="ack"> I have read the posting (required reading)</label></form>
 <a href="https://jobs.smartrecruiters.com/LLNL/1-x?oga=true">Apply Now</a></main>`;

test('job-board filter checkboxes with result counts are not application questions',async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();
  await page.route('https://www.llnl.gov/join-our-team/careers/find-your-job/x',r=>r.fulfill({contentType:'text/html',body:POSTING}));
  await page.goto('https://www.llnl.gov/join-our-team/careers/find-your-job/x');
  const controls=(await snapshot(page)).frames.flatMap(f=>f.controls);
  const filter=controls.find(c=>/None, U\.S\. Citizenship/.test(c.label));
  assert.ok(filter,'the filter is in the snapshot');
  assert.ok(searchFilterControl(filter));
  assert.ok(searchFilterControl(controls.find(c=>/^Q \(1,204\)/.test(c.label))));
  assert.ok(!searchFilterControl(controls.find(c=>c.domId==='citizen')),'a real citizenship question is still answered');
  assert.ok(!searchFilterControl(controls.find(c=>c.domId==='ack')),'a parenthetical that is not a count is still a question');
  assert.ok(!searchFilterControl({type:'text',label:'Years of experience (3)'}));
 }finally{await browser.close();}
});
