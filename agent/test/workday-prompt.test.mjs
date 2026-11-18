import test from 'node:test';
import assert from 'node:assert/strict';
import { followPrompt } from '../src/workday-prompt.mjs';
import { pickOption, resolveQuestion } from '../src/workday.mjs';

const pickSource = options => pickOption(options, resolveQuestion('How Did You Hear About Us?').candidates);

function menu({children = ['Company Website', 'Job Board'], delay = 0, save = true, discard = false} = {}) {
  let options = ['Website', 'Referral'];
  let selected = [];
  let pending = null;
  const clicks = [];
  let closed = false;
  return {
    clicks,
    get closed() { return closed; },
    selected: async () => selected,
    options: async () => options,
    click: async value => {
      clicks.push(value);
      if (clicks.length === 1) pending = () => { options = children; };
      else if (save) pending = () => { selected = [value]; options = []; };
    },
    wait: async () => { if (pending && delay-- <= 0) { pending(); pending = null; } },
    close: async () => { closed = true; if (discard) selected = []; },
  };
}

test('source category is followed through delayed children and saved leaf is verified', async () => {
  const driver = menu({delay: 4});
  assert.equal(await followPrompt(driver, pickSource), 'Company Website');
  assert.deepEqual(driver.clicks, ['Website', 'Company Website']);
  assert.equal(driver.closed, true);
});

test('unmatched children are surfaced for approval, never reported as a saved category', async () => {
  const driver = menu({children: ['Job Board', 'Employee Referral']});
  let offered;
  assert.equal(await followPrompt(driver, pickSource, {onOptions: options => { offered = options; }}), null);
  assert.deepEqual(offered, ['Job Board', 'Employee Referral']);
  assert.deepEqual(driver.clicks, ['Website']);
});

test('a click that leaves the menu unchanged cannot be reported as success', async () => {
  const driver = menu({save: false});
  assert.equal(await followPrompt(driver, pickSource), null);
  assert.deepEqual(driver.clicks, ['Website', 'Company Website']);
});

test('a selection discarded when the prompt closes cannot be reported as success', async () => {
  assert.equal(await followPrompt(menu({discard: true}), pickSource), null);
});

test('a nested leaf with the same label as its parent still gets selected', async () => {
  const driver = menu({children: ['Website', 'Job Board']});
  assert.equal(await followPrompt(driver, pickSource), 'Website');
  assert.deepEqual(driver.clicks, ['Website', 'Website']);
});

test('direct leaf and search results need no category navigation', async () => {
  let selected = [];
  const driver = {
    options: async () => ['United States of America (+1)'],
    selected: async () => selected,
    click: async value => { selected = [value]; },
    wait: async () => {}, close: async () => {},
  };
  assert.equal(await followPrompt(driver, options => options[0]), 'United States of America (+1)');
});

test('browser prompt isolates its owned menu from stale phone options and follows category children', async () => {
  const {chromium}=await import('playwright');
  const {chooseWorkdayPrompt,workdayOptions}=await import('../src/workday-prompt.mjs');
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent(`<div data-automation-id="formField-source"><input id="source" aria-controls="source-menu"><button data-automation-id="promptIcon" onclick="document.getElementById('source-menu').hidden=false">Open</button><span data-automation-id="selectedItem"></span></div>
    <div role="listbox" id="source-menu" hidden><div data-automation-id="promptOption" onclick="this.innerText='Company Website';this.onclick=()=>{document.querySelector('[data-automation-id=selectedItem]').innerText=this.innerText;document.getElementById('source-menu').hidden=true}">Website</div></div>
    <div role="listbox" data-automation-id="selectedItemList" id="phone-menu"><div role="option" data-automation-id="selectedItem"><div data-automation-id="promptOption">United States of America (+1)</div></div></div>`);
    let offered=[];
    const got=await chooseWorkdayPrompt(page,page.locator('#source'),pickSource,{onOptions:o=>offered.push(o)});
    assert.equal(got,'Company Website');
    assert.deepEqual(offered,[['Website'],['Company Website']]);
    await page.setContent(`<div data-automation-id="formField-state"><button id="state" aria-controls="states">Select One</button></div><div role="listbox" id="states"><div role="option">California</div></div><div role="listbox" hidden><div role="option">Wrong mounted option</div></div>`);
    assert.deepEqual(await (await workdayOptions(page,page.locator('#state'),'[role="option"]:visible')).allInnerTexts(),['California']);
  }finally{await browser.close();}
});

test('virtualized menu search reaches a confirmed option beyond the first visible rows',async()=>{
 const {chromium}=await import('playwright');const {scanWorkdayOptions}=await import('../src/workday-prompt.mjs');const b=await chromium.launch({headless:true});
 try{const page=await b.newPage();await page.setContent(`<div id="menu" style="height:100px;overflow-y:auto"><div style="height:1000px"><div id="options"></div></div></div><script>const menu=document.getElementById('menu'),opts=document.getElementById('options');function render(){opts.innerHTML='<div data-option style="position:relative;top:'+menu.scrollTop+'px">'+(menu.scrollTop>300?'Company Website':'Job Board')+'</div>';}menu.onscroll=render;render();</script>`);
 const offered=await scanWorkdayOptions(page,async()=>page.locator('[data-option]'),pickSource);assert.ok(offered.includes('Company Website'));assert.ok(await page.locator('#menu').evaluate(e=>e.scrollTop)>300);
 }finally{await b.close();}
});


test('a menu that is still loading is waited on instead of read as empty',async()=>{
 const {chromium}=await import('playwright');const {scanWorkdayOptions}=await import('../src/workday-prompt.mjs');const b=await chromium.launch({headless:true});
 try{const page=await b.newPage();await page.setContent(`<div id="m"></div><script>setTimeout(()=>{m.innerHTML='<div data-option>Statistics</div>'},1500)</script>`);
 const offered=await scanWorkdayOptions(page,async()=>page.locator('[data-option]'),o=>o.find(x=>x==='Statistics'));assert.deepEqual(offered,['Statistics']);
 }finally{await b.close();}
});

test('Direct Source category must resolve to a verified website leaf',async()=>{
 let selected=[],options=['Direct Source','Job Board'];
 const driver={selected:async()=>selected,options:async()=>options,click:async value=>{if(value==='Direct Source'){selected=[value];options=['Company Website','Employee Referral'];}else{selected=[value];options=[];}},wait:async()=>{},close:async()=>{}};
 assert.equal(await followPrompt(driver,o=>pickSource(o)??o.find(x=>x==='Direct Source'),{intermediateOptions:['Direct Source']}),'Company Website');
 selected=[];options=['Direct Source'];driver.click=async value=>{selected=[value];options=[];};
 assert.equal(await followPrompt(driver,o=>o[0],{intermediateOptions:['Direct Source']}),null);
});

test('Field of Study list-view menu opens All and selects the confirmed field',async()=>{
 const {isWorkdayListViewMenu}=await import('../src/workday-prompt.mjs');
 assert.ok(isWorkdayListViewMenu(['Partial List (First 500 Entries)','All']));
 assert.ok(!isWorkdayListViewMenu(['All','Mechanical Engineering']));
 assert.ok(!isWorkdayListViewMenu(['Yes','No']));
 let selected=[],options=['Partial List (First 500 Entries)','All'];const clicks=[];
 const driver={selected:async()=>selected,options:async()=>options,click:async value=>{clicks.push(value);if(value==='All')options=['Aerospace Engineering','Mechanical Engineering','Statistics'];else{selected=[value];options=[];}},wait:async()=>{},close:async()=>{}};
 const pick=o=>pickOption(o,['Mechanical Engineering','Mechanical']);
 assert.equal(await followPrompt(driver,pick),'Mechanical Engineering');
 assert.deepEqual(clicks,['All','Mechanical Engineering']);
 // Opening All is never itself an answer: no matching field means no selection.
 selected=[];options=['Partial List (First 500 Entries)','All'];clicks.length=0;
 driver.click=async value=>{clicks.push(value);selected=[value];options=['Biology'];};
 assert.equal(await followPrompt(driver,pick),null);
 assert.deepEqual(clicks,['All']);
});
