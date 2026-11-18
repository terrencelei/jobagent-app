import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshot,pickOption,approvedValue} from '../src/dashboard-worker.mjs';
const html=`<!doctype html><meta charset="utf-8"><form class="new_applicant">
<div class="form-group"><label class="required" for="first_name">First name</label><input id="applicant_first_name" name="applicant[first_name]"></div>
<div class="form-group applicant-skills"><ul>${['SOLIDWORKS','Revit or BIM environments'].map((skill,i)=>`<li><div><label class="skill-name">Do you have experience with ${skill}?</label><div class="thire-radio-group">${['No Experience','Some Experience','Expert'].map((o,j)=>`<label>${o}<input type="radio" id="skill_score_${j}" name="skill_score[${i}]" value="${j}"></label>`).join('')}</div></div></li>`).join('')}</ul></div>
<div class="form-group canned-questions"><label class="required" for="relocate">Are you willing to relocate?</label><select class="chosen-select" name="applicant[relocate]" style="display:none"><option value=""></option><option value="true">Yes</option><option value="false">No</option></select><div class="chosen-container"><a class="chosen-single"><span>Are you willing to relocate?</span></a><div class="chosen-drop" hidden><input class="chosen-search-input"><ul class="chosen-results"></ul></div></div></div></form>
<script>const c=document.querySelector('.chosen-container'),s=c.previousElementSibling;c.querySelector('a').onclick=()=>{c.querySelector('.chosen-drop').hidden=false;c.querySelector('ul').innerHTML='<li class="active-result">Yes</li><li class="active-result">No</li>';for(const li of c.querySelectorAll('li'))li.onclick=()=>{s.value=li.textContent==='Yes'?'true':'false';c.querySelector('span').textContent=li.textContent;c.querySelector('.chosen-drop').hidden=true;};};</script>`;
test('TriNet skills keep independent question/rating context and Chosen uses visible menu',async()=>{
 const b=await chromium.launch();try{const page=await b.newPage();await page.route('http://localhost/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:html}));await page.goto('http://localhost/fixture');
 const controls=(await snapshot(page)).frames[0].controls;
 const first=controls.find(c=>c.name==='applicant[first_name]');assert.equal(first.label,'First name');assert.equal(first.required,true);
 const skills=controls.filter(c=>c.skillRating);assert.equal(skills.length,6);
 assert.equal(skills[0].label,'Do you have experience with SOLIDWORKS?');assert.equal(skills[3].label,'Do you have experience with Revit or BIM environments?');assert.deepEqual(skills[0].choiceLabels,['No Experience','Some Experience','Expert']);assert.equal(skills[3].optionLabel,'No Experience');assert.ok(skills.every(c=>c.required));
 assert.throws(()=>approvedValue({action:'fill',fact:'mechanicalCadExperience'},skills[0],{answers:{mechanicalCadExperience:'Yes'}},{},new Map()),/approved offered rating/);
 assert.equal(approvedValue({action:'fill'},skills[1],{answers:{}},{},new Map([['do you have experience with solidworks?','Some Experience']])),true);
 const chosen=controls.find(c=>c.name==='applicant[relocate]');assert.equal(chosen.combobox,true);assert.equal(chosen.required,true);assert.equal(controls.filter(c=>c.label==='Are you willing to relocate?').length,1);assert.ok(!controls.some(c=>c.type==='a'||c.label==='Unlabelled field'));
 const picked=await pickOption(page.mainFrame(),page.locator(`[data-ja-control="${chosen.id}"]`),'Yes',chosen.label,{relocate:'Yes'});assert.equal(picked.ok,true);assert.equal(await page.locator('select').inputValue(),'true');assert.equal(await page.locator('.chosen-single span').innerText(),'Yes');
 }finally{await b.close();}
});
