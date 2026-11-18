// Re-read after answering: a parent answer may mount a required follow-up.
// The callback retains the runner's existing fact and prose approval rules.
export async function settleWorkdayQuestions(page, readFields, answer, {passes=8,wait=ms=>page.waitForTimeout(ms)}={}) {
 let stable=0;
 for(let i=0;i<passes;i++){
  const passStart=Date.now();
  const before=JSON.stringify(await readFields());
  const pending=await answer();
  if(Date.now()-passStart>=10000)console.log(`  slow: answering pass ${i+1} took ${((Date.now()-passStart)/1000).toFixed(1)}s`);
  if(pending.length)return pending;
  await wait(300);
  if(before===JSON.stringify(await readFields())){
   if(++stable===2)return [];
  }else stable=0;
 }
 throw new Error('Workday questions did not settle; preparation stopped before Continue');
}

// Escape alone does not dismiss every tenant's portal. Blur outside the form,
// then use an ordinary enabled-button click so a menu cannot swallow Continue.
// This helper deliberately cannot click the Review page's Submit button.
export async function continueWorkdayPreparation(page) {
 await page.keyboard.press('Escape');
 await page.mouse.click(1,1);
 // Some degree dropdowns ignore Escape and outside clicks. Close only the
 // unique expanded button linked to a visible menu; never select an option.
 const menuIds=await page.locator('[role="listbox"]:not([data-automation-id="selectedItemList"]):visible').evaluateAll(menus=>menus.map(menu=>menu.id).filter(Boolean));
 for(const id of menuIds.slice(0,5)){
  const menu=page.locator(`[role="listbox"][id=${JSON.stringify(id)}]:visible`);
  if(!await menu.count())continue;
  const owner=page.locator(`button[aria-haspopup="listbox"][aria-expanded="true"][aria-controls~=${JSON.stringify(id)}]:visible`);
  if(await owner.count()===1)await owner.evaluate(button=>button.click());
 }
 // Saved prompt chips are a permanent listbox, not an open options menu.
 // first() avoids strict-mode errors while waiting for all visible menus to go.
 const menus=page.locator('[role="listbox"]:not([data-automation-id="selectedItemList"]):visible').first();
 await menus.waitFor({state:'hidden',timeout:3000});
 const next=page.locator('button[data-automation-id="pageFooterNextButton"]').first();
 if(!/^\s*(Save and Continue|Continue|Next)\s*$/i.test(await next.innerText()))
  throw new Error('Workday preparation cannot click this footer action');
 await next.click();
}
