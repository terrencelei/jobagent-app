import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { fillAndVerify } from '../src/browser.mjs';

test('browser verifies exact answers and uploads only the resume', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'application-agent-test-'));
  const resume = join(dir, 'fixture.pdf');
  await writeFile(resume, '%PDF-1.4\nTest fixture, not a real resume.');
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(2000);
    await page.setContent(`<form>
      <input id="email" type="email" required>
      <input id="gender" role="combobox"><span id="selected"></span>
      <button type="button" role="option">Female</button>
      <button type="button" role="option">Male</button>
      <select id="gpa"><option>3.55</option><option>3.50</option></select>
      <input id="rocket" type="checkbox">
      <input id="cover" type="file"><input id="resume" type="file" required>
      <span id="uploaded"></span>
    </form>
    <script>
      document.querySelectorAll('[role=option]').forEach(el => el.onclick = () => {
        document.querySelector('#selected').textContent = el.textContent;
        document.querySelector('#gender').value = '';
      });
      document.querySelector('#resume').onchange = e => {
        document.querySelector('#uploaded').textContent = e.target.files[0].name;
      };
    </script>`);
    const plan = {fields:[
      {type:'text',selector:'#email',key:'email'},
      {type:'combobox',selector:'#gender',selectedSelector:'#selected',key:'gender'},
      {type:'select',selector:'#gpa',key:'gpa'},
      {type:'checkbox',selector:'#rocket',key:'rocket'}
    ],resume:{selector:'#resume',uploadedSelector:'#uploaded'}};
    const answers = {email:'candidate@example.com',gender:'Male',gpa:'3.50',rocket:true};
    await fillAndVerify(page,plan,answers,resume);
    assert.equal(await page.locator('#selected').innerText(),'Male');
    assert.equal(await page.locator('#gender').inputValue(),'');
    assert.equal(await page.locator('#gpa').inputValue(),'3.50');
    assert.equal(await page.locator('#cover').evaluate(el=>el.files.length),0);
    assert.equal(await page.locator('#resume').evaluate(el=>el.files[0].name),'fixture.pdf');

    await page.locator('#resume').setInputFiles([]);
    await page.evaluate(() => {
      document.querySelector('#resume').addEventListener('change', () => {
        document.querySelector('#email').value = 'wrong@example.com';
      });
    });
    await assert.rejects(fillAndVerify(page,plan,answers,resume),/Final verification failed: email/);
    await page.evaluate(() => {
      document.querySelector('#resume').replaceWith(document.querySelector('#resume').cloneNode());
      document.querySelector('form').insertAdjacentHTML('beforeend','<input required id="unmapped">');
    });
    await assert.rejects(fillAndVerify(page,plan,answers,resume),/required or invalid control\(s\) remain/);
  } finally {
    await browser.close();
    await rm(dir,{recursive:true,force:true});
  }
});

test('remote location choices use an exact custom option and persist canonical displayed value', async () => {
 const dir=await mkdtemp(join(tmpdir(),'application-location-'));const resume=join(dir,'fixture.pdf');await writeFile(resume,'%PDF-1.4 fixture');const browser=await chromium.launch();
 try {const page=await browser.newPage();page.setDefaultTimeout(3000);
 await page.setContent(`<input id="location"><input id="selected" type="hidden"><div class="suggestion">Springfield, CA, USA (County)</div><div class="suggestion">Springfield, CA, USA</div><input id="resume" type="file"><span id="filename"></span><script>
 document.querySelectorAll('.suggestion').forEach(e=>e.onclick=()=>{document.querySelector('#location').value=e.textContent;document.querySelector('#selected').value=e.textContent;});
 document.querySelector('#location').onblur=()=>{if(!document.querySelector('#selected').value)document.querySelector('#location').value='';};
 document.querySelector('#resume').onchange=e=>document.querySelector('#filename').textContent=e.target.files[0].name;
 </script>`);
 const plan={fields:[{key:'location',type:'combobox',selector:'#location',selectedSelector:'#location',selectedIsValue:true,optionSelector:'.suggestion',optionLabel:'Springfield, CA, USA',expectDisplay:'Springfield, CA, USA'}],resume:{selector:'#resume',uploadedSelector:'#filename'}};
 await fillAndVerify(page,plan,{location:'Springfield, CA'},resume);
 assert.equal(await page.locator('#selected').inputValue(),'Springfield, CA, USA');
 assert.equal(await page.locator('#location').inputValue(),'Springfield, CA, USA');
 }finally{await browser.close();await rm(dir,{recursive:true,force:true});}
});
