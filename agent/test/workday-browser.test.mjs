import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openWorkdayBrowser} from '../src/workday-browser.mjs';
test('a failed persistent profile gets one bounded recovery without altering the saved profile',async()=>{
 const root=await mkdtemp(join(tmpdir(),'workday-profile-')),profile=join(root,'profile');
 const calls=[];
 try{
  await writeFile(join(root,'sentinel'),'keep');
  const context={};
  const browser={launchPersistentContext:async(path,options)=>{calls.push({path,options});if(calls.length===1)throw Error('Timeout 30000ms exceeded');return context;}};
  assert.equal(await openWorkdayBrowser(browser,profile,{headless:true}),context);
  assert.equal(calls.length,2);assert.notEqual(calls[1].path,profile);assert.equal(calls[1].options.timeout,30000);assert.equal(await readFile(join(root,'sentinel'),'utf8'),'keep');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('profile already in use never launches a competing browser',async()=>{
 let calls=0;
 await assert.rejects(openWorkdayBrowser({launchPersistentContext:async()=>{calls++;throw Error('ProcessSingleton: user data directory is already in use');}},'/unused'),/already in use/);
 assert.equal(calls,1);
});
