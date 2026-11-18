import test from 'node:test';
import assert from 'node:assert/strict';
import {cliTimeoutProgress} from '../src/cli-timeout-progress.mjs';
import {execCLI} from '../src/dashboard-worker.mjs';

test('timeout progress preserves split JSON stages without exposing arbitrary content',()=>{
 const p=cliTimeoutProgress();
 p.stdout(Buffer.from('{"type":"turn.sta'));
 p.stdout(Buffer.from('rted"}\n{"type":"item.started","item":{"type":"command_execution","command":"secret-marker"}}\n'));
 p.stderr(Buffer.from('secret-marker'));
 p.stdout(Buffer.from('{"type":"secret-marker","item":{"type":"secret-marker"}}\n'));
 assert.equal(p.summary().events,2);
 assert.equal(p.summary().lastStage,'item.started:command_execution');
 assert.ok(p.summary().stdoutBytes>0);assert.equal(p.summary().stderrBytes,13);
 assert.doesNotMatch(JSON.stringify(p.summary())+p.describe(),/secret-marker/);
});

test('silent and oversized output remain bounded and do not invent a stage',()=>{
 const p=cliTimeoutProgress();assert.equal(p.summary().lastStage,'none');
 p.stdout(Buffer.from('x'.repeat(17000)));p.stdout(Buffer.from('\n'));
 assert.equal(p.summary().events,0);assert.equal(p.summary().stdoutBytes,17001);
});

test('actual timed out CLI reports safe activity instead of discarding all progress',async()=>{
 await assert.rejects(execCLI(process.execPath,['-e',`process.stdout.write(JSON.stringify({type:'turn.started'})+'\\n');process.stderr.write('secret-marker');setInterval(()=>{},1000)`],'',{timeout:700}),error=>{
  assert.match(error.message,/did not answer within 0.7s/);
  assert.match(error.message,/last stage turn.started/);
  assert.match(error.message,/13 stderr bytes/);
  assert.doesNotMatch(error.message,/secret-marker/);return true;
 });
});

test('only complete startup lifecycle output with no stderr can replay after timeout',()=>{
 const start='{"type":"thread.started","thread_id":"fixture"}\n{"type":"turn.started"}\n';
 const good=cliTimeoutProgress();good.stdout(Buffer.from(start));assert.equal(good.summary().replaySafe,true);
 for(const extra of ['{"type":"item.started","item":{"type":"command_execution"}}\n','{"type":"item.completed","item":{"type":"reasoning"}}\n','{"type":"future.event"}\n','not json\n','{"type":"turn.completed"}\n','{"type":"turn.started"}\n','{"type":"item.sta','x'.repeat(17000)]){
  const p=cliTimeoutProgress();p.stdout(Buffer.from(start+extra));assert.equal(p.summary().replaySafe,false);
 }
 const p=cliTimeoutProgress();p.stdout(Buffer.from(start));p.stderr(Buffer.from('quota'));assert.equal(p.summary().replaySafe,false);
});

test('timeout waits for exit and includes output emitted during termination',async()=>{
 const script=`process.stdout.write('{"type":"thread.started"}\\n{"type":"turn.started"}\\n');process.on('SIGTERM',()=>{process.stdout.write('{"type":"item.started","item":{"type":"command_execution"}}\\n');process.exit(0)});setInterval(()=>{},1000)`;
 await assert.rejects(execCLI(process.execPath,['-e',script],'',{timeout:600}),e=>{assert.equal(e.code,'CLI_TIMEOUT');assert.equal(e.processClosed,true);assert.equal(e.progress.replaySafe,false);assert.equal(e.progress.lastStage,'item.started:command_execution');return true;});
});

test('a timed out CLI hands back the output it had printed, outside the logged message',async()=>{
 await assert.rejects(execCLI(process.execPath,['-e',`process.stdout.write('{"status":"SUCCESS","response":"secret-marker"}\\n');setInterval(()=>{},1000)`],'',{timeout:2000}),error=>{
  assert.equal(error.code,'CLI_TIMEOUT');assert.doesNotMatch(error.message,/secret-marker/);
  assert.equal(JSON.parse(error.stdout).response,'secret-marker');return true;
 });
});
