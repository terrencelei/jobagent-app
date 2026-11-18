import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readFile as read} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireLock,processAlive} from '../src/worker-lock.mjs';

const dir=()=>mkdtemp(join(tmpdir(),'worker-lock-'));

test('a lock records its owner pid',async()=>{
 const path=join(await dir(),'job.lock');
 const lock=await acquireLock(path,{pid:4242});
 assert.equal(await readFile(path,'utf8'),'4242');assert.equal(lock.pathName,path);await lock.close();
});

test('a lock left by an exited worker is taken over (Anduril 4662/11394)',async()=>{
 const path=join(await dir(),'dashboard-company-anduril.lock');
 const dead=spawnSync('/bin/sh',['-c','echo $$']).stdout.toString().trim();
 assert.equal(processAlive(Number(dead)),false);
 await writeFile(path,dead);
 const lock=await acquireLock(path);
 assert.equal(await read(path,'utf8'),String(process.pid));await lock.close();
});

test('a live owner or a lock without a pid is never taken',async()=>{
 const d=await dir();
 const live=join(d,'live.lock');await writeFile(live,String(process.pid));
 await assert.rejects(acquireLock(live,{pid:1}),{code:'EEXIST'});
 assert.equal(await read(live,'utf8'),String(process.pid));
 const legacy=join(d,'legacy.lock');await writeFile(legacy,'');
 await assert.rejects(acquireLock(legacy,{alive:()=>false}),{code:'EEXIST'});
});

test('the dashboard worker takes job and company locks through acquireLock',async()=>{
 const source=await readFile(new URL('../src/dashboard-worker.mjs',import.meta.url),'utf8');
 assert.match(source,/jobLock=await acquireLock\(/);
 assert.match(source,/companyLock=await acquireLock\(/);
 assert.doesNotMatch(source,/Lock=await open\(/);
});
