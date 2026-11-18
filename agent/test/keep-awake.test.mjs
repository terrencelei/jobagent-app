import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {keepAwake} from '../src/keep-awake.mjs';

test('a macOS worker holds idle- and system-sleep assertions tied to its own pid (7922, 4662)',()=>{
 const calls=[];
 const child=keepAwake({platform:'darwin',pid:4242,spawnImpl:(cmd,args)=>{calls.push([cmd,args]);return {on(){},unref(){}};}});
 assert.ok(child);
 assert.deepEqual(calls,[['/usr/bin/caffeinate',['-i','-s','-w','4242']]]);
});

test('other platforms and a failed spawn never stop the worker',()=>{
 assert.equal(keepAwake({platform:'linux',spawnImpl:()=>assert.fail('spawned')}),null);
 assert.equal(keepAwake({platform:'darwin',spawnImpl:()=>{throw new Error('ENOENT');}}),null);
});

test('the dashboard worker entry point keeps the Mac awake before running',async()=>{
 const source=await readFile(new URL('../src/dashboard-worker.mjs',import.meta.url),'utf8');
 assert.match(source,/keepAwake\(\);await runWorker\(process\.argv\[2\]\)/);
});

test('real caffeinate exits with the process it watches',{skip:process.platform!=='darwin'},async()=>{
 const {spawn}=await import('node:child_process');
 const sleeper=spawn('/bin/sleep',['1']);
 const child=keepAwake({pid:sleeper.pid});
 const code=await new Promise(r=>child.once('exit',r));
 assert.equal(code,0);
});
