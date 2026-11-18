import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {waitForPageControls} from '../src/dashboard-worker.mjs';
test('waits for a hydrating page to render its Apply button',async()=>{
 const b=await chromium.launch();const p=await b.newPage();
 await p.setContent('<h1>Build your Career</h1><script>setTimeout(()=>{document.body.insertAdjacentHTML("beforeend","<button>Apply</button>")},1500)</script>');
 assert.equal(await waitForPageControls(p,{timeout:8000}),true);
 await p.setContent('<h1>Only a heading</h1>');
 assert.equal(await waitForPageControls(p,{timeout:1000}),false);
 await b.close();
});
