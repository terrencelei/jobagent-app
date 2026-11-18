import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {chooseWorkdaySourcePrompt} from '../src/workday-prompt.mjs';

// Reproduce Workday's occupied single-select prompt: selecting a new option
// cannot replace its existing pill until that pill's remove control is clicked.
function fixture({old='Glassdoor',wanted='LinkedIn',category,offered=wanted,discard=false}={}) {
  return `<div data-automation-id="formField-phone"><span data-automation-id="selectedItem">Phone country<button data-automation-id="DELETE_charm">Remove</button></span></div>
  <div data-automation-id="formField-source"><input id="source" aria-controls="menu"><button data-automation-id="promptIcon" onclick="root()">Open</button><div id="saved"></div></div>
  <div role="listbox" id="menu" hidden></div><script>
  const cfg=${JSON.stringify({old,wanted,category,offered,discard})};
  const menu=document.getElementById('menu'),saved=document.getElementById('saved'); window.actions=[];
  function save(value){const pill=document.createElement('span');pill.dataset.automationId='selectedItem';
    const label=document.createElement('span');label.textContent=value;const remove=document.createElement('button');remove.dataset.automationId='DELETE_charm';remove.setAttribute('aria-label','Remove '+value);
    remove.onclick=()=>{actions.push('remove:'+value);pill.remove();};pill.append(label,remove);saved.append(pill);}
  if(cfg.old)save(cfg.old);
  function row(label,click){const el=document.createElement('div');el.dataset.automationId='promptOption';el.textContent=label;el.onclick=()=>{actions.push(label);click();};menu.append(el);}
  function leaf(){menu.hidden=false;menu.innerHTML='';row(cfg.offered,()=>{if(!saved.children.length)save(cfg.offered);menu.hidden=true;});}
  function root(){menu.hidden=false;menu.innerHTML='';if(cfg.category)row(cfg.category,leaf);else leaf();}
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.hidden=true;if(cfg.discard&&saved.textContent===cfg.wanted)saved.innerHTML='';}});
  </script>`;
}

for(const scenario of [
  {old:'Conagra Careers Website',wanted:'Careers Website'},
  {old:'ClearedConnections.com',wanted:'Internet/Social'},
  {old:'Glassdoor',wanted:'LinkedIn',category:'Job Sites'},
  {old:'Glassdoor',wanted:'LinkedIn',category:'Job Boards'},
  {old:'Indeed',wanted:'Caterpillar Careers',category:'Company Website'},
]) test(`occupied source retains exact approved ${scenario.wanted}${scenario.category?' beneath '+scenario.category:''}`,async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();page.waitForTimeout=async()=>{};
    await page.setContent(fixture(scenario));
    const pick=offered=>offered.find(value=>value===scenario.wanted);
    assert.equal(await chooseWorkdaySourcePrompt(page,page.locator('#source'),pick),scenario.wanted);
    assert.deepEqual(await page.locator('[data-automation-id="formField-source"] [data-automation-id="selectedItem"]').allTextContents(),[scenario.wanted]);
    assert.deepEqual(await page.locator('[data-automation-id="formField-phone"] [data-automation-id="selectedItem"]').allTextContents(),['Phone countryRemove']);
    assert.equal((await page.evaluate(()=>actions)).filter(value=>value.startsWith('remove:')).length,1);
  } finally {await browser.close();}
});

test('matching saved source is reused without opening or deleting it',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();page.waitForTimeout=async()=>{};
    await page.setContent(fixture({old:'LinkedIn'}));
    assert.equal(await chooseWorkdaySourcePrompt(page,page.locator('#source'),o=>o.find(v=>v==='LinkedIn')),'LinkedIn');
    assert.deepEqual(await page.evaluate(()=>actions),[]);
  } finally {await browser.close();}
});

test('unoffered approval preserves existing source and never accepts a category or different leaf',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();page.waitForTimeout=async()=>{};
    await page.setContent(fixture({category:'Job Sites',offered:'Indeed'}));
    assert.equal(await chooseWorkdaySourcePrompt(page,page.locator('#source'),o=>o.find(v=>v==='LinkedIn')),null);
    assert.deepEqual(await page.locator('#saved [data-automation-id="selectedItem"]').allTextContents(),['Glassdoor']);
    assert.ok(!(await page.evaluate(()=>actions)).some(v=>v.startsWith('remove:')));
  } finally {await browser.close();}
});

test('source discarded on close cannot be reported as retained',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();page.waitForTimeout=async()=>{};
    await page.setContent(fixture({old:'',discard:true}));
    assert.equal(await chooseWorkdaySourcePrompt(page,page.locator('#source'),o=>o.find(v=>v==='LinkedIn')),null);
    assert.equal(await page.locator('#saved [data-automation-id="selectedItem"]').count(),0);
  } finally {await browser.close();}
});
