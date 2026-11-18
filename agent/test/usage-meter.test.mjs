import test from 'node:test';
import assert from 'node:assert/strict';
import {cliUsage,addUsage,meterExec} from '../src/usage-meter.mjs';

// Lesson 430: Workday runs consulted a model up to 18 times but recorded no usage, so the cost page read $0.00.
test('usage is read from Claude JSON, Codex event lines and OpenCode step events',()=>{
 assert.deepEqual(cliUsage(JSON.stringify({type:'result',structured_output:{},usage:{input_tokens:10,cache_read_input_tokens:200,cache_creation_input_tokens:30,output_tokens:40}})),
  {input_tokens:10,cache_read_input_tokens:200,cache_creation_input_tokens:30,output_tokens:40});
 const codex=[{type:'thread.started'},{type:'item.completed',item:{type:'agent_message',text:'{}'}},{type:'turn.completed',usage:{input_tokens:1000,cached_input_tokens:800,output_tokens:50,reasoning_output_tokens:20}}].map(JSON.stringify).join('\n');
 assert.deepEqual(cliUsage(codex),{input_tokens:200,cache_read_input_tokens:800,cache_creation_input_tokens:0,output_tokens:70});
 const open=[{type:'text',part:{text:'{}'}},{type:'step_finish',tokens:{input:5,output:6,reasoning:1,cache:{read:7,write:8}}}].map(JSON.stringify).join('\n');
 assert.deepEqual(cliUsage(open),{input_tokens:5,cache_read_input_tokens:7,cache_creation_input_tokens:8,output_tokens:7});
 assert.equal(cliUsage('not json'),null);assert.equal(cliUsage(''),null);
});

test('meterExec reports each reply under engine:model and passes the reply through',async()=>{
 const totals={};const exec=async()=>({code:0,stdout:JSON.stringify({type:'result',usage:{input_tokens:3,output_tokens:4}}),stderr:''});
 const metered=meterExec(exec,(via,u)=>addUsage(totals,via,u),{engine:'claude'});
 const r1=await metered('/usr/local/bin/claude',['-p','--model','claude-sonnet-5-5'],'prompt');
 await metered('/usr/local/bin/claude',['-p','--model','claude-sonnet-5-5'],'prompt');
 assert.equal(r1.code,0);
 assert.deepEqual(totals.model_usage,{'claude:claude-sonnet-5-5':{calls:2,input_tokens:6,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:8}});
 assert.deepEqual(totals.usage,{input_tokens:6,output_tokens:8});
 const none=meterExec(async()=>({code:1,stdout:'',stderr:'boom'}),()=>assert.fail('no usage to report'));
 assert.equal((await none('codex',[],'p')).stderr,'boom');
});
