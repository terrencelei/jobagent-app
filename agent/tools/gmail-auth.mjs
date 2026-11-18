#!/usr/bin/env node
// One-time sign-in for the direct Gmail reader (src/gmail-direct.mjs). He runs it himself:
//   node tools/gmail-auth.mjs [path/to/client_secret.json]
// It needs a Google OAuth client of type "Desktop app" (default path private/google-oauth-client.json),
// asks only for gmail.readonly, and stores client id/secret + refresh token in private/gmail-token.json (mode 600).
import {createServer} from 'node:http';
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TOKEN_PATH,newestMessage,resetGmailDirectCache} from '../src/gmail-direct.mjs';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const clientPath=process.argv[2]||join(ROOT,'private/google-oauth-client.json');
const SCOPE='https://www.googleapis.com/auth/gmail.readonly';

const raw=JSON.parse(await readFile(clientPath,'utf8'));
const client=raw.installed??raw.web??raw;
if(!client.client_id)throw new Error(`${clientPath} is not a Google OAuth client file (download it from Google Cloud > Credentials)`);

const state=randomBytes(16).toString('hex'),verifier=randomBytes(32).toString('base64url');
const challenge=createHash('sha256').update(verifier).digest('base64url');
const server=createServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const redirect=`http://127.0.0.1:${server.address().port}`;
const url=`https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:SCOPE,
 access_type:'offline',prompt:'consent',state,code_challenge:challenge,code_challenge_method:'S256',login_hint:'alex.rivera@example.edu'})}`;
console.log(`Sign in with your school Google account and allow read-only Gmail access:\n${url}\n`);
execFile('open',[url],()=>{});

const code=await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(new Error('No sign-in within 10 minutes')),600000);
 server.on('request',(req,res)=>{
  const params=new URL(req.url,redirect).searchParams;
  if(!params.get('code')&&!params.get('error')){res.writeHead(404).end();return;}
  const ok=params.get('state')===state&&params.get('code');
  res.writeHead(200,{'content-type':'text/plain'}).end(ok?'Signed in. You can close this tab.':`Sign-in failed: ${params.get('error')??'state mismatch'}`);
  clearTimeout(timer);ok?resolve(params.get('code')):reject(new Error(params.get('error')??'state mismatch'));
 });
});
server.close();

const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
 body:new URLSearchParams({code,client_id:client.client_id,client_secret:client.client_secret??'',redirect_uri:redirect,grant_type:'authorization_code',code_verifier:verifier})});
const grant=await response.json();
if(!response.ok||!grant.refresh_token)throw new Error(`Token exchange failed: ${grant.error_description??grant.error??response.status}`);
if(!String(grant.scope??'').split(' ').includes(SCOPE))throw new Error(`Google granted a different scope: ${grant.scope}`);
await writeFile(TOKEN_PATH,JSON.stringify({client_id:client.client_id,client_secret:client.client_secret??'',refresh_token:grant.refresh_token,scope:SCOPE,created_at:new Date().toISOString()},null,1));
await chmod(TOKEN_PATH,0o600);
resetGmailDirectCache();
const check=await newestMessage('newer_than:1d');
console.log(`Saved ${TOKEN_PATH}. Reading works: ${check?`newest message today is "${check.subject}"`:'no message from today found (token saved)'}.`);
