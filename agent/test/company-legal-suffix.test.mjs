import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadAnswers} from '../src/companies.mjs';

test('approved answers filed under the legal name apply to the same employer without it (Hyundai 12447)',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bank-'));
 try{
  await writeFile(join(dir,'hyundai-america-technical-center-inc.json'),JSON.stringify({company:'Hyundai America Technical Center, Inc.',answers:{'how did you hear about this position?':{question:'How did you hear about this position?',answer:'Job Board'}}}));
  await writeFile(join(dir,'_shared.json'),JSON.stringify({answers:{}}));
  assert.equal((await loadAnswers(dir,'Hyundai America Technical Center')).answers['how did you hear about this position?']?.answer,'Job Board');
  assert.equal((await loadAnswers(dir,'Hyundai America Technical Center, Inc.')).answers['how did you hear about this position?']?.answer,'Job Board');
  assert.equal((await loadAnswers(dir,'Other Company')).answers['how did you hear about this position?'],undefined);
 }finally{await rm(dir,{recursive:true,force:true});}
});
