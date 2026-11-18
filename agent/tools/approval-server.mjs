import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validToken,readJSON,publicRequest,validateApproval,persistApproval,initialStatus,atomicJSON} from '../src/approval-portal.mjs';
import {createWorker} from '../src/approval-worker.mjs';
export async function startPortal(config,{workerEnabled=true,port=config.port}={}){
 const dir=config.storageDir,worker=createWorker(config);let approving=Promise.resolve();
 if(workerEnabled)await worker.recover();
 const status=async()=>{
  let record;try{record=await readJSON(join(dir,'approval.json'));}catch(e){if(e.code==='ENOENT')return {applications:[]};throw e;}
  const result=await readJSON(join(dir,'status.json')).catch(e=>{if(e.code==='ENOENT')return initialStatus(record);throw e;});
  for(const row of result.applications){
   if(!['submitting','awaiting_verification_code','submitted_pending_receipt','needs_human_verification','submission_unknown'].includes(row.status))continue;
   const st=await readJSON(join(config.repoDir,'state',row.jobId+'.json')).catch(()=>({}));
   if(st.receiptSource==='mailbox'&&st.status==='submitted'){row.status='submitted';row.detail='The employer receipt has been verified in your mailbox.';}
   else if(st.status==='awaiting_verification_code'&&['submitting','awaiting_verification_code'].includes(row.status)){row.status='awaiting_verification_code';row.detail='Enter the latest code from this employer’s email while the application waits.';}
  }
  return result;
 };
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const send=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  try{
   const path=new URL(req.url,'http://localhost').pathname;
   if(path==='/health'&&req.method==='GET')return send(200,{ok:true});
   if(path.startsWith('/api/')){
    if(!validToken(req.headers.authorization?.replace(/^Bearer /,''),config.token))return send(401,{error:'Open the private link from your approval email.'});
    if(req.method==='GET'&&path==='/api/request')return send(200,publicRequest(config));
    if(req.method==='GET'&&path==='/api/status')return send(200,await status());
    if(req.method!=='POST')return send(405,{error:'Method not allowed'});
    if(!String(req.headers['content-type']||'').startsWith('application/json'))return send(415,{error:'JSON required'});
    // Cross-origin forms cannot supply the bearer header; also reject explicit cross-site requests.
    if(req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'Open the form directly to approve.'});
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>64000)return send(413,{error:'Response too large'});}
    const body=JSON.parse(raw);
    if(path==='/api/approve'){
      const record=validateApproval(config,body);
      approving=approving.catch(()=>{}).then(async()=>{const saved=await persistApproval(dir,record);if(saved.created)await atomicJSON(join(dir,'status.json'),initialStatus(saved.record));});
      await approving;send(200,await status());if(workerEnabled)void worker.tick().catch(e=>console.error('Worker:',e.message));return;
    }
    if(path==='/api/code'){
      const j=config.jobs.find(j=>j.job.id===body.jobId);if(!j)throw Error('Unknown job');
      const s=await status();if(!s.applications.some(a=>a.jobId===body.jobId&&a.status==='awaiting_verification_code'))throw Error('This application is not waiting for a code.');
      if(typeof body.code!=='string'||!new RegExp('^'+(j.plan.verification?.codePattern||'[A-Za-z0-9]{8}')+'$').test(body.code))throw Error('Check the code format.');
      await writeFile(join(config.repoDir,'state',body.jobId+'.code'),body.code,{mode:0o600,flag:'wx'});return send(200,{received:true});
    }
    return send(404,{error:'Not found'});
   }
   if(req.method!=='GET')return send(405,{error:'Method not allowed'});
   const files={'/':['approval.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
   if(!files[path])return send(404,{error:'Not found'});
   const [file,type]=files[path];res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});res.end(await readFile(join(config.repoDir,'web',file)));
  }catch(e){if(!res.headersSent)send(400,{error:e.message});else res.end();}
 });
 await new Promise((r,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',r);});
 const timer=workerEnabled?setInterval(()=>void worker.tick().catch(e=>console.error('Worker:',e.message)),2000):null;
 return {server,status,close:async()=>{clearInterval(timer);await new Promise(r=>server.close(r));}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const config=await readJSON(process.argv[2]||'private/approval-portal/config.json');
 await startPortal(config);console.log('Approval portal listening on loopback port '+config.port);
}
