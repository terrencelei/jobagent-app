#!/usr/bin/env node
// Direct-control trial (2026-11-13, his request: "try using Claude Desktop or a similar implementation").
// The dashboard worker starts one model process per control (8-15 s each, 10-50 per application). Here ONE
// Claude session drives the worker's own headless browser through Playwright's MCP server, the way Claude
// Desktop drives a screen: it reads the page, picks options and types without a new process per step.
//
// This is a measurement tool, not the production path. It fills a posting and STOPS before Submit, so the
// worker's validation, approval and submission rules are not replaced by it. It never signs in, never
// creates an account and never types a password.
//
//   node tools/direct-drive.mjs <posting url> [--company "Name"] [--title "Role"] [--model claude-sonnet-5-5]
//
// Output: artifacts/direct-drive-<stamp>/{result.json,final.png,fields.json,session.jsonl}
import {mkdir,readFile,writeFile,mkdtemp,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {applicationChromium} from '../src/captcha-vendor.mjs';
import {freePort} from '../src/human-chrome.mjs';
import {availableFacts} from '../src/dashboard-worker.mjs';
import {loadAnswers} from '../src/companies.mjs';
import {accountFor} from '../src/accounts.mjs';
import {drivePrompt,runDirectSession,approvedForSession} from '../src/direct-control.mjs';
export {drivePrompt,claudeArgs,summarize,MCP_PACKAGE} from '../src/direct-control.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function parseArgs(argv){
 const out={url:null,company:'',title:'',model:'claude-sonnet-5-5',timeoutMs:15*60000,signIn:false,fixturePassword:null};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];
  if(a==='--company')out.company=argv[++i]??'';
  else if(a==='--title')out.title=argv[++i]??'';
  else if(a==='--model')out.model=argv[++i]??out.model;
  else if(a==='--timeout-minutes')out.timeoutMs=Number(argv[++i])*60000;
  else if(a==='--sign-in')out.signIn=true;
  else if(a==='--fixture-password')out.fixturePassword=argv[++i]??null;
  else if(!out.url)out.url=a;
 }
 return out;
}

async function main(){
 const opts=parseArgs(process.argv.slice(2));
 if(!opts.url){console.error('usage: node tools/direct-drive.mjs <posting url> [--company ..] [--title ..] [--model ..]');process.exit(2);}
 const profile=JSON.parse(await readFile(join(ROOT,'private/profile.json'),'utf8'));
 const {answers:bank}=await loadAnswers(join(ROOT,'private/companies'),opts.company||'_none');
 const approved=approvedForSession(bank);
 const stamp=new Date().toISOString().replace(/[:.]/g,'-');
 const dir=join(ROOT,'artifacts',`direct-drive-${stamp}`);await mkdir(dir,{recursive:true});
 const work=await mkdtemp(join(tmpdir(),'direct-drive-'));
 const port=await freePort();
 const chromium=await applicationChromium();
 const started=Date.now();
 const context=await chromium.launchPersistentContext(join(work,'profile'),{headless:true,viewport:{width:1280,height:1000},args:[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1']});
 let code=1;
 try{
  const page=context.pages()[0]??await context.newPage();
  await page.goto(opts.url,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(2500);
  const opened=Date.now();
  // The browser tools read files only inside the session's own folder, so the resume is copied there under its real name.
  const resumeSource=resolve(ROOT,opts.resumePath??profile.resumePath),resumePath=join(work,basename(resumeSource));
  await copyFile(resumeSource,resumePath);
  // --sign-in: his saved email and password for this site (accounts.mjs), the password as an MCP secret only.
  const account=opts.fixturePassword?{email:profile.answers?.email,password:opts.fixturePassword}:opts.signIn?await accountFor(opts.url,{email:profile.answers?.email}):null;
  const prompt=drivePrompt({url:opts.url,company:opts.company,title:opts.title,facts:availableFacts(profile,opts.company),approved,resumePath,signIn:account?{email:account.email}:null,mode:'trial'});
  const session=await runDirectSession({endpoint:`http://127.0.0.1:${port}`,prompt,model:opts.model,workDir:work,password:account?.password??null,timeoutMs:opts.timeoutMs,
   onTool:(name,at)=>console.log(`${at.toFixed(1)}s ${name}`)});
  const {exit,lines}=session;
  const finished=Date.now();
  // Session log may quote page text and his answers: private, like every artifact.
  await writeFile(join(dir,'session.jsonl'),lines.join('\n'),{mode:0o600});
  const live=context.pages().find(p=>!p.isClosed())??page;
  await live.screenshot({path:join(dir,'final.png'),fullPage:true}).catch(()=>{});
  const fields=await live.evaluate(()=>[...document.querySelectorAll('input,select,textarea')].filter(e=>e.type!=='hidden'&&e.type!=='password').map(e=>({label:(e.labels?.[0]?.innerText||e.getAttribute('aria-label')||e.name||e.id||'').trim().slice(0,120),type:e.type||e.tagName.toLowerCase(),value:e.type==='checkbox'||e.type==='radio'?e.checked:e.type==='file'?[...e.files].map(f=>f.name).join(', '):e.tagName==='SELECT'?e.selectedOptions[0]?.label??'':e.value}))).catch(()=>[]);
  await writeFile(join(dir,'fields.json'),JSON.stringify(fields,null,1),{mode:0o600});
  const result={url:opts.url,model:opts.model,exit,openSeconds:(opened-started)/1000,driveSeconds:(finished-opened)/1000,finalUrl:live.url(),...session,lines:undefined};
  await writeFile(join(dir,'result.json'),JSON.stringify(result,null,1),{mode:0o600});
  console.log(JSON.stringify({...result,answer:result.answer?{filled:result.answer.filled?.length,unanswered:result.answer.unanswered,stoppedBecause:result.answer.stoppedBecause}:null,artifacts:dir},null,1));
  code=exit===0&&!result.isError?0:1;
 }finally{
  await context.close().catch(()=>{});
  await rm(work,{recursive:true,force:true}).catch(()=>{});
 }
 process.exit(code);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
