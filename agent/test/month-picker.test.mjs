import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {monthYearPair,fillMonthYear} from '../src/text-date-input.mjs';

test('month/year pairs are recognised only in month-year form',()=>{
 assert.deepEqual(monthYearPair('6/2026'),{month:6,year:'2026'});
 assert.deepEqual(monthYearPair(['9','2026']),{month:9,year:'2026'});
 for(const v of ['2026-06','06/15/2026','13/2026','Engineer',['x','2026']])assert.equal(monthYearPair(v),null);
});

// Shaped like Cisco's Phenom picker: typing is ignored; a popup holds a year select and month cells.
const picker=`<label for="from">From *</label><input id="from" type="text" readonly>
<div id="pop" hidden><select id="yr"><option>2025</option><option selected>2026</option></select>
<table><tr>${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m,i)=>`<td data-m="${i+1}">${m}</td>`).join('')}</tr></table></div>
<script>const f=document.getElementById('from'),pop=document.getElementById('pop');f.addEventListener('click',()=>pop.hidden=false);
pop.addEventListener('click',e=>{const m=e.target.dataset.m;if(m){f.value=m.padStart(2,'0')+'/'+document.getElementById('yr').value;pop.hidden=true;}});</script>`;

test('a Phenom month picker is filled through its year select and month cell (Cisco 12281)',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.setContent(picker);
  assert.equal(await fillMonthYear(page.locator('#from'),{month:6,year:'2025'}),'06/2025');
  await page.setContent('<input id="plain" type="text">');
  assert.equal(await fillMonthYear(page.locator('#plain'),{month:9,year:'2026'},'9/2026'),'9/2026');
 }finally{await browser.close();}
});
