import test from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {transcribe} from '../src/captcha-audio.mjs';

test('audio helpers restore the normal executable PATH in a stripped background service',()=>{
 const code=`import {runAudioCommand} from './src/captcha-audio.mjs';const output=await runAudioCommand(process.execPath,['--input-type=module','-e',"import{dirname,delimiter}from'node:path';const p=process.env.PATH.split(delimiter);console.log(JSON.stringify({brew:p.includes('/opt/homebrew/bin'),runtime:p.includes(dirname(process.execPath)),inherited:p.includes('/usr/bin')}));"]);process.stdout.write(output);`;
 const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,PATH:'/usr/bin:/bin'},encoding:'utf8'}));
 assert.deepEqual(result,{brew:true,runtime:true,inherited:true});
});

test('transcription retains local tool arguments and cleans temporary audio after execution',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'captcha-model-fixture-')),model=join(dir,'model.bin'),calls=[];
 try{
  await writeFile(model,'fixture');
  const text=await transcribe(Buffer.from('fixture'),{model,exec:async(command,args)=>{calls.push({command,args});if(command==='ffmpeg')await access(args[args.indexOf('-i')+1]);return command==='whisper-cli'?'Seven Green Apples. [BLANK_AUDIO]':'';}});
  assert.equal(text,'seven green apples');assert.deepEqual(calls.map(c=>c.command),['ffmpeg','whisper-cli']);
  assert.ok(calls[0].args.includes('16000'));assert.ok(calls[1].args.includes(model));assert.ok(calls[1].args.includes('-np'));
  await assert.rejects(access(calls[0].args[calls[0].args.indexOf('-i')+1]),{code:'ENOENT'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
