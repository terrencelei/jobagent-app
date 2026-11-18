import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {isLeverLocation,pickLeverLocation} from '../src/lever-location.mjs';

// Mirrors jobs.lever.co/js/retrieveLocations.js: suggestions arrive after a delay, mousedown on
// one fills both inputs, and blur with the menu still open blanks the field (Humble Robotics 12510).
const LEVER=`<form><li class="application-question"><label><div class="application-label">Current location <span class="required">✱</span></div>
<input class="location-input" id="location-input" type="text" name="location" required><input id="selected-location" type="hidden" name="selectedLocation">
<div class="dropdown-container" style="display:none"><div class="dropdown-results"></div></div></label></li><input id="org" name="org"></form><script>
const places=['Goleta, CA, USA','Goleta, Lima, Peru'];
const input=document.querySelector('#location-input'),box=document.querySelector('.dropdown-container'),results=document.querySelector('.dropdown-results');
input.addEventListener('input',()=>{box.style.display='block';results.innerHTML='';setTimeout(()=>{results.innerHTML=places.filter(p=>p.toLowerCase().startsWith(input.value.toLowerCase())).map((p,i)=>'<div class="dropdown-location" id="location-'+i+'">'+p+'</div>').join('');},300);});
input.addEventListener('blur',()=>{if(box.style.display!=='none'){box.style.display='none';results.innerHTML='';input.value='';document.querySelector('#selected-location').value='';}});
document.addEventListener('mousedown',e=>{if(!e.target.matches('.dropdown-location'))return;e.preventDefault();box.style.display='none';input.value=e.target.textContent;document.querySelector('#selected-location').value=JSON.stringify({name:e.target.textContent});results.innerHTML='';});
</script>`;

test('Lever location typeahead keeps the picked suggestion after blur', async () => {
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();page.setDefaultTimeout(3000);await page.setContent(LEVER);
  const input=page.locator('#location-input');
  // A plain fill is what the worker did before: the next field's focus blanks it.
  await input.fill('Goleta, California, United States');await page.locator('#org').click();
  assert.equal(await input.inputValue(),'');
  assert.equal(await isLeverLocation(page.locator('#org')),false);
  const picked=await pickLeverLocation(input,'Goleta, California, United States',{timeoutMs:3000});
  assert.equal(picked.ok,true);
  await page.locator('#org').click();
  assert.equal(await input.inputValue(),'Goleta, CA, USA');
  assert.match(await page.locator('#selected-location').inputValue(),/Goleta, CA, USA/);
  const none=await pickLeverLocation(input,'Springfield, California, United States',{timeoutMs:1000});
  assert.equal(none.ok,false);
 }finally{await browser.close();}
});
