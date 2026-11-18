import {timed,controlName} from './slow-step.mjs';
// Long Workday lists (Field of Study at Leidos and Micron) open on a menu of list
// views, "Partial List (First 500 Entries)" and "All", rather than on answers.
// Such a menu is navigation: open "All" and choose among the real options.
export const isWorkdayListViewMenu = offered => offered.length > 0
  && offered.some(o => /^All$/i.test(o))
  && offered.every(o => /^(All|Partial List \(First \d+ Entries\))$/i.test(o));

// A prompt category click is not a selection. Wait for either a saved item or
// the next menu, and verify the item again after dismissing the menu.
export async function followPrompt(driver, pick, {onOptions = () => {},intermediateOptions=[]} = {}) {
  let chosen = null;
  let previous = null;
  const intermediate = new Set(intermediateOptions);
  const isFinal = value => value && !intermediate.has(value);
  try {
    for (let depth = 0; depth < 6; depth++) {
      let offered = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        if (isFinal(chosen) && (await driver.selected()).includes(chosen)) break;
        offered = (await driver.options()).filter(o=>! /^(No Items\.?|No results|Loading.*|Searching.*)$/i.test(o));
        if (offered.length && JSON.stringify(offered) !== previous) break;
        await driver.wait(400);
      }
      if (isFinal(chosen) && (await driver.selected()).includes(chosen)) break;
      // An unchanged menu means the click did not advance; do not click forever.
      if (!offered.length || JSON.stringify(offered) === previous) break;
      onOptions(offered);
      let want = pick(offered);
      if (!want && isWorkdayListViewMenu(offered)) {
        want = offered.find(o => /^All$/i.test(o));
        intermediate.add(want);
      }
      if (!want || !offered.includes(want)) break;
      previous = JSON.stringify(offered);
      await driver.click(want);
      chosen = want;
    }
  } finally {
    await driver.close();
  }
  return isFinal(chosen) && (await driver.selected()).includes(chosen) ? chosen : null;
}

// Ignore mounted menus belonging to other fields. A portal is usable only when its
// owning control names it, or when there is exactly one visible menu after Escape.
export async function workdayOptions(page, control, selector) {
  selector += ':not([data-automation-id="selectedItem"]):not([data-automation-id="selectedItemList"] *):not([data-automation-id="selectedItem"] *)';
  const field = control.locator('xpath=ancestor::*[starts-with(@data-automation-id,"formField-")][1]');
  const owned = await control.getAttribute('aria-controls') || await control.getAttribute('aria-owns');
  if (owned) {
    const ids = owned.split(/\s+/).map(id => `[id=${JSON.stringify(id)}]`).join(',');
    const options = page.locator(ids).locator(selector);
    if (await options.count()) return options;
  }
  const controlId=await control.getAttribute('id');
  if(controlId){
    const labelled=page.locator(`[role="listbox"][aria-labelledby~=${JSON.stringify(controlId)}]:visible`);
    if(await labelled.count()===1)return labelled.locator(selector);
  }
  const local = field.locator(selector);
  if (await local.count()) return local;
  const menus = page.locator('[role="listbox"]:visible:not([data-automation-id="selectedItemList"]), [data-automation-id="promptOptions"]:visible');
  // Nested listboxes count only their outermost menu.
  const roots = menus.filter({hasNot: page.locator('[role="listbox"]:visible:not([data-automation-id="selectedItemList"]), [data-automation-id="promptOptions"]:visible')});
  if (await roots.count() === 1) return roots.locator(selector);
  const options = page.locator(selector);
  const owners = await options.evaluateAll(items => new Set(items.map(el => el.closest('[role="listbox"], [data-automation-id="promptOptions"]') || el.parentElement)).size);
  if (owners > 1) throw new Error('Workday menu ownership is ambiguous; retrying the control instead of asking for an answer');
  return options;
}

// Virtualized menus expose only their first rows. Search the scrollable menu for
// a confirmed option before concluding that the employer does not offer it.
export async function scanWorkdayOptions(page, getItems, pick) {
 const collected=new Set();
 for(let scroll=0;scroll<40;scroll++){
  let items=await getItems();
  // A menu still showing its spinner has no rows yet; an empty read is not "no match" (Blue Origin
  // School/Field of Study, lesson 443). Give the first read up to ~8 s to populate.
  for(let wait=0;scroll===0&&wait<16&&!await items.count();wait++){await page.waitForTimeout(500);items=await getItems();}
  const current=(await items.allInnerTexts()).map(s=>s.trim()).filter(Boolean);
  current.forEach(value=>collected.add(value));
  if(pick(current))return current;
  if(!await items.count())return [...collected];
  const moved=await items.first().evaluate(el=>{
   for(let parent=el.parentElement;parent;parent=parent.parentElement){
    if(parent.scrollHeight>parent.clientHeight+4 && /auto|scroll/.test(getComputedStyle(parent).overflowY)){
     const before=parent.scrollTop;
     parent.scrollTop=Math.min(before+Math.max(40,parent.clientHeight*.8),parent.scrollHeight-parent.clientHeight);
     return parent.scrollTop>before;
    }
   }
   return false;
  });
  if(!moved)return [...collected];
  await page.waitForTimeout(200);
 }
 return [...collected];
}

// Source categories navigate to answers; they never authorize a different leaf.
// PAE/Amentum puts named job boards beneath Website, even for an exact approved
// board answer. Try each observed category and still require retained leaf text.
export async function chooseWorkdaySourcePrompt(page, input, pick, options = {}) {
  const field=input.locator('xpath=ancestor::*[starts-with(@data-automation-id,"formField-")][1]');
  const selected=async()=> (await field.locator('[data-automation-id="selectedItem"]').allInnerTexts()).map(s=>s.trim()).filter(Boolean);
  const exact=async want=>{
    let stable=0;
    for(let attempt=0;attempt<10;attempt++){
      const values=await selected();
      stable=values.length===1&&values[0]===want?stable+1:0;
      if(stable>=2)return true;
      await page.waitForTimeout(150);
    }
    return false;
  };
  const current=await selected(),already=pick(current);
  if(current.length===1&&already===current[0]&&await exact(already))return already;
  const offeredCategories=new Set();
  for (const intermediateOptions of [[], ['Direct Source'], ['Job Board'], ['Website'], ['Job Sites'], ['Job Boards'], ['Company Website'], ['Internet/Social']]) {
    if(intermediateOptions.length&&!intermediateOptions.some(value=>offeredCategories.has(value)))continue;
    let observed;
    const choose=()=>chooseWorkdayPrompt(page,input,pick,{...options,intermediateOptions,onOptions:offered=>{
      offered.forEach(value=>offeredCategories.add(value));
      options.onOptions?.(offered);
      const want=pick(offered);if(want&&offered.includes(want)&&!intermediateOptions.includes(want))observed=want;
    }});
    const result=await choose();
    if(result&&await exact(result))return result;
    // Prove the exact approved replacement is offered before deleting a saved
    // value. Workday single-select prompts otherwise reject a second pill.
    const want=result||observed;
    if(!want)continue;
    const pills=field.locator('[data-automation-id="selectedItem"]');
    for(let index=await pills.count()-1;index>=0;index--){
      const pill=pills.nth(index);
      if((await pill.innerText()).trim()===want)continue;
      const remove=pill.locator('[data-automation-id="DELETE_charm"]');
      if(await remove.count()!==1)throw new Error('Cannot replace the saved source selection safely');
      await remove.click({force:true});
    }
    if(await exact(want))return want;
    if((await selected()).length)throw new Error('Workday did not clear the previous source selection');
    const replaced=await choose();
    if(replaced&&await exact(replaced))return replaced;
  }
  return null;
}

export async function chooseWorkdayPrompt(page, input, pick, options = {}) {
  const name=controlName(input);
  return timed(async()=>`prompt ${await name()}`,()=>choosePrompt(page,input,pick,options));
}
async function choosePrompt(page, input, pick, {search, onOptions, onDiagnostics,intermediateOptions=[]} = {}) {
  const pause = ms => page.waitForTimeout(ms);
  const field = input.locator('xpath=ancestor::*[starts-with(@data-automation-id,"formField-")][1]');
  const selected = async () => (await field.locator('[data-automation-id="selectedItem"]').allInnerTexts())
    .map(s => s.trim()).filter(Boolean);
  await page.keyboard.press('Escape');
  await input.scrollIntoViewIfNeeded().catch(() => {});
  const icon = field.locator('[data-automation-id="promptIcon"]:visible, [data-automation-id="selectInput"]:visible, button[aria-label*="prompt" i]:visible').first();
  if (await icon.count()) await icon.click({force:true});
  else await input.click({force: true});
  await pause(1200);
  if (search) {
    await input.fill('');
    await input.type(search, {delay: 30});
    await page.keyboard.press('Enter');
    await pause(500);
  }
  let items;
  const getItems = async () => {
    items = await workdayOptions(page, input, '[data-automation-id="promptOption"]:visible');
    return items;
  };
  if (!await (await getItems()).count()) {
    await input.focus(); await input.press('ArrowDown'); await pause(500);
  }
  if(onDiagnostics) await onDiagnostics(await page.evaluate(()=>[...document.querySelectorAll('[data-automation-id], [role=listbox]')].filter(e=>e.getClientRects().length && /prompt|option|popup|listbox/i.test((e.getAttribute('data-automation-id')||'')+' '+(e.getAttribute('role')||''))).map(e=>({aid:e.getAttribute('data-automation-id'),role:e.getAttribute('role'),id:e.id,text:e.innerText?.slice(0,250),html:e.getAttribute('data-automation-id')==='promptOption'?e.outerHTML.slice(0,6000):undefined}))));
  return followPrompt({
    selected,
    options: async () => scanWorkdayOptions(page,getItems,pick),
    click: async text => {
      const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await (await getItems()).filter({hasText: new RegExp(`^\\s*${escaped}\\s*$`)}).last().click({force: true});
      await pause(200);
    },
    wait: pause,
    close: async () => { await page.keyboard.press('Escape'); await pause(200); },
  }, offered=>pick(offered)??offered.find(option=>intermediateOptions.includes(option)), {onOptions,intermediateOptions});
}
