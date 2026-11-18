import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {pickOption} from '../src/dashboard-worker.mjs';

// Intuitive 12316 (SmartRecruiters one-click, lesson 417): the City autocomplete keeps its listbox inside the input's
// shadow root and each option is a <spl-dropdown-item> host whose text is slotted light DOM (innerText reads empty);
// the Country code button's menu slots its options in from the host's light DOM and lists bare country names.
const page_html=`<spl-autocomplete id="city-host"></spl-autocomplete><spl-select id="cc-host">
  <spl-select-option><spl-dropdown-item>Afghanistan</spl-dropdown-item></spl-select-option>
  <spl-select-option><spl-dropdown-item>United Kingdom</spl-dropdown-item></spl-select-option>
  <spl-select-option><spl-dropdown-item>United States</spl-dropdown-item></spl-select-option>
</spl-select>`;
const setup=()=>{
 const item=host=>{const root=host.attachShadow({mode:'open'});root.innerHTML='<div role="option" aria-selected="false"><spl-typography-body><slot></slot></spl-typography-body></div>';
  root.querySelector('[role=option]').addEventListener('click',()=>host.dispatchEvent(new CustomEvent('pick',{bubbles:true,composed:true,detail:host.textContent.trim()})));};
 const city=document.getElementById('city-host').attachShadow({mode:'open'});
 city.innerHTML='<input id="city" role="combobox" aria-expanded="false" aria-controls="city-menu"><div id="city-menu" role="listbox" hidden></div>';
 const input=city.querySelector('#city'),menu=city.querySelector('#city-menu');
 input.addEventListener('input',()=>{menu.innerHTML='';const q=input.value.toLowerCase();for(const place of ['Springfield, CA, US','Springfield, OH, US','Springfield, FL, US'])if(place.toLowerCase().startsWith(q.split(',')[0])&&q.length>=3){const host=document.createElement('spl-dropdown-item');host.textContent=place;menu.appendChild(host);item(host);}menu.hidden=!menu.children.length;input.setAttribute('aria-expanded',String(!menu.hidden));});
 city.addEventListener('pick',e=>{input.value=e.detail;menu.hidden=true;});
 const cc=document.getElementById('cc-host').attachShadow({mode:'open'});
 cc.innerHTML='<button id="cc" role="combobox" aria-expanded="false" aria-controls="cc-menu"><span id="cc-flag"></span></button><div id="cc-menu" role="listbox" hidden><slot></slot></div>';
 const button=cc.querySelector('#cc'),ccMenu=cc.querySelector('#cc-menu');
 for(const host of document.querySelectorAll('#cc-host spl-dropdown-item'))item(host);
 button.addEventListener('click',()=>{ccMenu.hidden=!ccMenu.hidden;button.setAttribute('aria-expanded',String(!ccMenu.hidden));});
 document.getElementById('cc-host').addEventListener('pick',e=>{for(const host of document.querySelectorAll('#cc-host spl-dropdown-item'))host.shadowRoot.querySelector('[role=option]').setAttribute('aria-selected',String(host.textContent.trim()===e.detail));ccMenu.hidden=true;button.setAttribute('aria-expanded','false');});
};
test('a shadow-DOM autocomplete with slotted option text and a slotted country menu are picked',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.setContent(page_html);await page.evaluate(setup);
  const answers={city:'Springfield, California, United States',citySearch:'Springfield',addressState:'CA',phoneCountry:'United States +1'};
  const city=await pickOption(page.mainFrame(),page.locator('input#city'),'Springfield','City*',answers,{company:'Intuitive'});
  assert.equal(city.ok,true);assert.equal(city.value,'Springfield, CA, US');
  assert.equal(await page.locator('input#city').inputValue(),'Springfield, CA, US');
  const cc=await pickOption(page.mainFrame(),page.locator('button#cc'),'+1','Country code',answers,{company:'Intuitive'});
  assert.equal(cc.ok,true);assert.equal(cc.value,'United States');assert.deepEqual(cc.options,['Afghanistan','United Kingdom','United States']);
 }finally{await browser.close();}
});
