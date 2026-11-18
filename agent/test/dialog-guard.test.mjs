import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {closeDialog,guardDialogs} from '../src/dialog-guard.mjs';

test('a dialog that is already gone does not reject (RV Tech 13331)',async()=>{
 const gone=()=>Promise.reject(new Error('Protocol error (Page.handleJavaScriptDialog): No dialog is showing'));
 await closeDialog({type:()=>'alert',dismiss:gone,accept:gone});
 await closeDialog({type:()=>'beforeunload',dismiss:gone,accept:gone});
});

test('beforeunload is accepted and other dialogs are dismissed',async()=>{
 const calls=[];const d=type=>({type:()=>type,accept:async()=>calls.push(type+':accept'),dismiss:async()=>calls.push(type+':dismiss')});
 await closeDialog(d('beforeunload'));await closeDialog(d('confirm'));
 assert.deepEqual(calls,['beforeunload:accept','confirm:dismiss']);
});

test('a guarded context closes page dialogs and the page keeps working',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const context=guardDialogs(await browser.newContext());const page=await context.newPage();
  await page.setContent('<p>form</p>');
  assert.equal(await page.evaluate(()=>{alert('hi');return confirm('sure?');}),false);
  assert.equal(await page.locator('p').textContent(),'form');
 }finally{await browser.close();}
});
