import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {pickOption,keptValue} from '../src/dashboard-worker.mjs';

// Shaped like Oracle Candidate Experience's cx-select: a role=combobox input whose
// aria-controls grid lists choices as gridcells (Howmet 11608, Vertiv 7922).
const cxSelect=`<label for="g">Gender</label><input id="g" class="cx-select-input" type="text" role="combobox" aria-autocomplete="list" aria-haspopup="grid" aria-controls="g-listbox" aria-expanded="false">
<div id="g-listbox" role="grid" hidden>${['Female','Male','Nonbinary'].map((v,i)=>`<div role="row"><div role="gridcell" id="g-listitem-${i}" class="cx-select__list-item"><span>${v}</span></div></div>`).join('')}</div>
<script>const g=document.getElementById('g'),box=document.getElementById('g-listbox');
const open=()=>{box.hidden=false;g.setAttribute('aria-expanded','true');};g.addEventListener('click',open);g.addEventListener('keydown',e=>{if(e.key==='ArrowDown')open();});
box.addEventListener('click',e=>{const cell=e.target.closest('[role=gridcell]');if(cell){g.value=cell.innerText.trim();box.hidden=true;g.setAttribute('aria-expanded','false');}});</script>`;

test('an Oracle cx-select gridcell choice is picked and kept',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.setContent(cxSelect);
  const result=await pickOption(page.mainFrame(),page.locator('#g'),'Male','Gender',{});
  assert.ok(result.options.includes('Male'),JSON.stringify(result.options));
  assert.equal(await page.locator('#g').inputValue(),'Male');assert.equal(result.ok,true);
 }finally{await browser.close();}
});

test('a phone field that reformats the typed number still counts as kept',()=>{
 assert.equal(keptValue('tel','(555) 010-0000','555-010-0000'),true);
 assert.equal(keptValue('tel','(555) 010-0009','555-010-0000'),false);
 // A full phone number typed into a plain text input is compared by digits too (ADP 13344, lesson 363).
 assert.equal(keptValue('text','(555) 010-0000','555-010-0000'),true);
 assert.equal(keptValue('text','(555) 010-0009','555-010-0000'),false);
});

test('Oracle option wording for city, ZIP, currency and veteran status maps to his saved answers',async()=>{
 const browser=await chromium.launch({headless:true});
 const select=(id,options)=>`<input id="${id}" type="text" role="combobox" aria-controls="${id}-list" aria-expanded="false"><div id="${id}-list" role="grid" hidden>${options.map(v=>`<div role="gridcell" class="cx-select__list-item">${v}</div>`).join('')}</div>`;
 try{
  for(const [value,options,want] of [['Goleta',['Goleta, CA','Goleta, TX'].slice(0,1).concat(['Gold Beach, OR']),'Goleta, CA'],['93117',['93117, Goleta, CA','93118, Goleta, CA'],'93117, Goleta, CA'],['USD',['Euro','US Dollar'],'US Dollar'],['I am not a protected veteran',['Declines to Self-Identify','Not a Protected Veteran'],'Not a Protected Veteran']]){
   const page=await browser.newPage();await page.setContent(select('x',options)+`<script>const x=document.getElementById('x'),l=document.getElementById('x-list');x.addEventListener('click',()=>{l.hidden=false;x.setAttribute('aria-expanded','true')});l.addEventListener('click',e=>{const c=e.target.closest('[role=gridcell]');if(c){x.value=c.innerText.trim();l.hidden=true;}});</script>`);
   const result=await pickOption(page.mainFrame(),page.locator('#x'),value,'Field',{});
   assert.equal(await page.locator('#x').inputValue(),want,value);assert.equal(result.ok,true,value);
  }
 }finally{await browser.close();}
});

test('Oracle grid dropdowns are searched with real keystrokes; map suggestions match an abbreviated street',async()=>{
 const browser=await chromium.launch({headless:true});
 // The list filters only on keyup, as Oracle CX does; filled text alone leaves the alphabetical list.
 const page=(all)=>`<input id="x" class="cx-select-input" type="text" role="combobox" aria-haspopup="grid" aria-controls="x-list" aria-expanded="false"><div id="x-list" role="grid" hidden></div>
 <script>const all=${JSON.stringify(all)},x=document.getElementById('x'),l=document.getElementById('x-list');
 const show=q=>{l.innerHTML=all.filter(v=>!q||v.toLowerCase().includes(q.toLowerCase())).slice(0,3).map(v=>'<div role="gridcell" class="cx-select__list-item">'+v+'</div>').join('');l.hidden=false;x.setAttribute('aria-expanded','true');};
 x.addEventListener('click',()=>show(''));x.addEventListener('keyup',()=>show(x.value));
 l.addEventListener('click',e=>{const c=e.target.closest('[role=gridcell]');if(c){x.value=c.innerText.trim();l.hidden=true;}});</script>`;
 try{
  for(const [value,all,want] of [['Goleta',['Aaronsburg, PA','Abbeville, AL','Abbeville, GA','Goleta, CA'],'Goleta, CA'],['6671 Berkshire Terrace',['6671 Berkshire Ter, Goleta, CA 93117','6671 Berkshire Dr, Austin, TX'],'6671 Berkshire Ter, Goleta, CA 93117']]){
   const p=await browser.newPage();await p.setContent(page(all));
   const result=await pickOption(p.mainFrame(),p.locator('#x'),value,'Field',{});
   assert.equal(await p.locator('#x').inputValue(),want,JSON.stringify(result.options));
  }
 }finally{await browser.close();}
});

test('an Oracle map-search address keeps typed text when no suggestion matches (Howmet 11608)',async()=>{
 const {mapSearchFreeText}=await import('../src/dashboard-worker.mjs');
 const browser=await chromium.launch({headless:true});
 try{
  const p=await browser.newPage();
  await p.setContent('<input id="a" role="combobox" aria-describedby="oracle-maps-search-hint a-error" aria-controls="a-list"><div id="a-list" role="grid"></div><input id="b" role="combobox">');
  assert.equal(await mapSearchFreeText(p.locator('#a'),'6671 Berkshire Terrace'),true);
  assert.equal(await p.locator('#a').inputValue(),'6671 Berkshire Terrace');
  assert.equal(await mapSearchFreeText(p.locator('#b'),'6671 Berkshire Terrace'),false,'other comboboxes still need a real choice');
 }finally{await browser.close();}
});

test('a city name shared by several states picks the one in his saved state (Honeywell 11244)',async()=>{
 const browser=await chromium.launch({headless:true});
 const select=(id,options)=>`<input id="${id}" type="text" role="combobox" aria-controls="${id}-list" aria-expanded="false"><div id="${id}-list" role="grid" hidden>${options.map(v=>`<div role="gridcell" class="cx-select__list-item">${v}</div>`).join('')}</div><script>const x=document.getElementById('${id}'),l=document.getElementById('${id}-list');x.addEventListener('click',()=>{l.hidden=false;x.setAttribute('aria-expanded','true')});l.addEventListener('click',e=>{const c=e.target.closest('[role=gridcell]');if(c){x.value=c.innerText.trim();l.hidden=true;x.setAttribute('aria-expanded','false');}});</script>`;
 const options=['Springfield, CA','Springfield, MN','Springfield, NY','Springfield Hill, IL'];
 try{
  for(const [answers,want,ok] of [[{addressState:'CA'},'Springfield, CA',true],[{addressState:'California'},'Springfield, CA',true],[{},'',false]]){
   const page=await browser.newPage();await page.setContent(select('x',options));
   const result=await pickOption(page.mainFrame(),page.locator('#x'),'Springfield','City *',answers);
   assert.equal(result.ok,ok,JSON.stringify(answers));assert.equal(await page.locator('#x').inputValue(),want,JSON.stringify(answers));
   await page.close();
  }
 }finally{await browser.close();}
});
