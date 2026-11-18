import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {chooseWorkdaySourcePrompt} from '../src/workday-prompt.mjs';
import {pickOption} from '../src/workday.mjs';

test('Amentum Website category leads to the exact approved board, never another leaf', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    // Only local controls; no employer traffic or submission action.
    page.waitForTimeout = async () => {};
    const fixture = leaf => `<div data-automation-id="formField-source">
      <label for="source--source">How Did You Hear About Us?</label>
      <input id="source--source" aria-controls="source-menu">
      <button data-automation-id="promptIcon" onclick="openRoot()">Open</button>
      <div id="saved"></div></div><div role="listbox" id="source-menu" hidden></div>
      <script>
      const menu=document.getElementById('source-menu');window.clicks=[];
      function openRoot(){menu.hidden=false;menu.innerHTML='';
        for(const label of ['Advertising','Referral','Website']){
          const option=document.createElement('div');option.dataset.automationId='promptOption';option.textContent=label;
          option.onclick=()=>{clicks.push(label);if(label==='Website'){
            menu.innerHTML='<div data-automation-id="promptOption">${leaf}</div>';
            menu.firstChild.onclick=()=>{clicks.push(menu.firstChild.textContent);document.getElementById('saved').innerHTML='<span data-automation-id="selectedItem">${leaf}</span>';menu.hidden=true;};
          }};menu.append(option);
        }
      }
      </script>`;
    const pick = offered => pickOption(offered, ['Indeed.com (Organic)']);
    await page.setContent(fixture('Indeed.com (Organic)'));
    assert.equal(await chooseWorkdaySourcePrompt(page,page.locator('[id="source--source"]'),pick),'Indeed.com (Organic)');
    assert.deepEqual(await page.evaluate(()=>clicks),['Website','Indeed.com (Organic)']);
    await page.goto('about:blank');
    await page.setContent(fixture('PAE Website (www.PAE.com)'));
    let offered;
    assert.equal(await chooseWorkdaySourcePrompt(page,page.locator('[id="source--source"]'),pick,{onOptions:o=>{offered=o;}}),null);
    assert.deepEqual(offered,['PAE Website (www.PAE.com)']);
    assert.equal(await page.locator('[data-automation-id="selectedItem"]').count(),0);
  } finally {await browser.close();}
});
