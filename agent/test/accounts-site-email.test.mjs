import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {accountFor} from '../src/accounts.mjs';
test('a site entry can name its own sign-in email while using his one saved password (Apple ID)',async()=>{
 const root=await mkdtemp(join(tmpdir(),'acct-'));
 try{
  await mkdir(join(root,'private'));
  await writeFile(join(root,'private/credentials.json'),JSON.stringify({apple:{host:'idmsa.apple.com',email:'site@example.test',sharedPassword:true}}));
  await writeFile(join(root,'private/workday.env'),'WORKDAY_PASSWORD=fixture-shared\n');
  const env={};
  const apple=await accountFor('https://idmsa.apple.com/appleauth/auth/signin',{email:'profile@example.test',root,env});
  assert.deepEqual([apple.email,apple.password,apple.source],['site@example.test','fixture-shared','site-shared']);
  const other=await accountFor('https://jobs.example.com/login',{email:'profile@example.test',root,env});
  assert.deepEqual([other.email,other.source],['profile@example.test','shared']);
 }finally{await rm(root,{recursive:true,force:true});}
});
