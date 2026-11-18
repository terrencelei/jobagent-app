import test from 'node:test';
import assert from 'node:assert/strict';
import {activationLink, claudePath, fetchVerifyLink, mailPrompt,mailboxInvocation,mailboxOutput} from '../src/workday-mail.mjs';

const JOB = 'https://acme.wd1.myworkdayjobs.com/External/job/US-CA/Engineer_R1';
test('Codex workers use their own mailbox connection and parse CLI event output',async()=>{
 const link='https://acme.wd1.myworkdayjobs.com/External/activate/token';
 const result=await fetchVerifyLink(JOB,{engine:'codex',command:'/fixture/codex',model:'fixture',tries:1,execImpl:async(command,args,prompt)=>{
  assert.equal(command,'/fixture/codex');assert.ok(args.includes('read-only'));assert.ok(!args.includes('--ignore-user-config'));assert.match(prompt,/only connected Gmail search and read/);
  return {code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:new Date().toISOString()+' '+link}})};
 }});
 assert.equal(result,link);assert.throws(()=>mailboxInvocation('invalid'),/Unsupported/);
});

test('activationLink keeps only an /activate/ link on the posting host', () => {
  const D = '2026-09-28T20:00:00Z ';
  assert.equal(activationLink(D + 'https://acme.wd1.myworkdayjobs.com/External/activate/abc123.', JOB),
    'https://acme.wd1.myworkdayjobs.com/External/activate/abc123');
  assert.equal(activationLink(D + 'https://evil.example.com/External/activate/abc', JOB), null);
  assert.equal(activationLink(D + 'https://other.wd1.myworkdayjobs.com/External/activate/abc', JOB), null);
  assert.equal(activationLink(D + 'https://acme.wd1.myworkdayjobs.com/External/login', JOB), null);
  assert.equal(activationLink(D + 'http://acme.wd1.myworkdayjobs.com/External/activate/abc', JOB), null);
});

test('activationLink ignores an undated or expired email', () => {
  const link = 'https://acme.wd1.myworkdayjobs.com/External/activate/abc';
  assert.equal(activationLink(link, JOB), null);
  assert.equal(activationLink('2026-09-26T03:17:02Z ' + link, JOB, Date.parse('2026-09-28T00:00:00Z') / 1000), null);
  assert.equal(activationLink('2026-09-28T03:17:02Z ' + link, JOB, Date.parse('2026-09-28T00:00:00Z') / 1000), link);
  assert.equal(activationLink('NONE', JOB), null);
});

test('mailPrompt searches the tenant sender', () => {
  assert.match(mailPrompt(JOB), /from:acme@otp\.workday\.com/);
});

test('fetchVerifyLink retries until the mail arrives and restricts the CLI to Gmail reads', async () => {
  const calls = [];
  const execImpl = async (command, args) => {
    calls.push(args);
    return {code: 0, stdout: calls.length < 2 ? 'NONE' : new Date().toISOString() + ' https://acme.wd1.myworkdayjobs.com/External/activate/tok\n'};
  };
  assert.equal(await fetchVerifyLink(JOB, {execImpl, waitMs: 0, log: () => {}}), 'https://acme.wd1.myworkdayjobs.com/External/activate/tok');
  assert.equal(calls.length, 2);
  const allowed = calls[0].slice(calls[0].indexOf('--allowedTools') + 1).filter(a => a.startsWith('mcp__'));
  assert.ok(allowed.length && allowed.every(a => a.startsWith('mcp__claude_ai_Gmail__get') || a === 'mcp__claude_ai_Gmail__search_threads'));
  assert.equal(calls[0][calls[0].indexOf('--tools') + 1], 'ToolSearch');
  assert.ok(calls[0].includes('--output-format'));
});

test('fetchVerifyLink gives up with null', async () => {
  assert.equal(await fetchVerifyLink(JOB, {execImpl: async () => ({code: 0, stdout: 'NONE'}), tries: 2, waitMs: 0, log: () => {}}), null);
});

test('claudePath finds the CLI outside PATH and reports a failed start', async () => {
  assert.equal(claudePath(['/nonexistent/claude', process.execPath]), process.execPath);
  assert.equal(claudePath(['/nonexistent/claude']), 'claude');
  const lines = [];
  assert.equal(await fetchVerifyLink(JOB, {execImpl: async () => { throw new Error('Could not start claude: ENOENT'); }, tries: 1, log: l => lines.push(l)}), null);
  assert.match(lines[0], /ENOENT/);
});

test('Codex mailbox output uses the final response and excludes progress commentary',()=>{
 const output=[{type:'item.completed',item:{type:'agent_message',text:'I will search your inbox.'}},{type:'item.completed',item:{type:'agent_message',text:'{"messageId":"1a11c471f72d4c31"}'}}].map(e=>JSON.stringify(e)).join('\n');
 assert.equal(mailboxOutput(output,'codex'),'{"messageId":"1a11c471f72d4c31"}');
});


test('Claude mailbox output unwraps result objects and tool-event arrays',()=>{
 const payload='{"messageId":"abcdef1234567890","code":"aB12cD34"}';
 assert.equal(mailboxOutput(JSON.stringify({type:'result',result:payload}),'claude'),payload);
 assert.equal(mailboxOutput(JSON.stringify([{type:'assistant',message:{content:[]}},{type:'result',result:payload}]),'claude'),payload);
 assert.equal(mailboxOutput(payload,'claude'),payload);
 const args=mailboxInvocation('claude');assert.equal(args[args.indexOf('--tools')+1],'ToolSearch');
 assert.ok(args.includes('mcp__claude_ai_Gmail__get_message'));assert.ok(!args.includes('--ignore-user-config'));
});
