// Vision for CAPTCHA puzzles that need judgement (hCaptcha tiles and point tasks, uncertain reCAPTCHA
// tiles, OCR tie-breaks): one turn of the signed-in Claude CLI with the image inline, no tools, no
// MCP servers, run from an empty directory so no CLAUDE.md loads. Same plan login as the workers; no
// API key. A reply that declines is recorded as a decline and the solve stops; the prompt is never
// reworded to get past it. CAPTCHA_VISION=0 turns this tier off.
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claudePath} from './workday-mail.mjs';
import {setting} from './settings.mjs';

export const visionModel=()=>process.env.CAPTCHA_VISION_MODEL||setting('captcha.vision_model','sonnet');
const NEXT_MODEL={opus:'sonnet',sonnet:'haiku'};
const DECLINE=/can.?t help|won.?t (help|pick|solve|do|assist)|cannot (help|assist)|not able to help|unable to (help|assist)|defeat (that|the) check|verify that a human|designed to (verify|confirm) (that )?(a )?human|bypass(ing)? (a |the )?captcha/i;

// The last JSON object or array in a model reply, or null.
export function lastJson(text){
 const s=String(text||'').replace(/```(?:json)?/g,'');
 const cands=s.match(/\{[\s\S]*\}|\[[\s\S]*\]/g)||[];
 for(const c of cands.reverse()){try{return JSON.parse(c);}catch{}}
 for(let i=s.lastIndexOf('{');i>=0;i=s.lastIndexOf('{',i-1)){
  let depth=0;
  for(let k=i;k<s.length;k++){if(s[k]==='{')depth++;else if(s[k]==='}'&&--depth===0){try{return JSON.parse(s.slice(i,k+1));}catch{}break;}}
  if(i===0)break;
 }
 return null;
}

// A refusal is a reply with no JSON that says it will not do this.
export const declined=(text,json)=>!json&&DECLINE.test(String(text||''));

// Stream-json result line of a CLI run: {result, is_error, subtype}.
export function resultLine(stdout){
 for(const line of String(stdout||'').split('\n').reverse()){
  if(!line.trim())continue;
  try{const d=JSON.parse(line);if(d.type==='result')return d;}catch{}
 }
 return null;
}

export function visionArgs(model){
 return ['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--model',model,'--max-turns','1',
  '--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','','--no-session-persistence'];
}

function runCli(bin,args,input,{timeoutMs,spawnImpl=spawn}){
 return new Promise(resolve=>{
  const cwd=mkdtempSync(join(tmpdir(),'captcha-vision-'));
  let p;
  try{p=spawnImpl(bin,args,{cwd,env:{...process.env,MAX_THINKING_TOKENS:'0'},stdio:['pipe','pipe','pipe']});}
  catch(e){rmSync(cwd,{recursive:true,force:true});return resolve({stdout:'',error:e.message});}
  let out='',err='';const t=setTimeout(()=>{try{p.kill('SIGKILL');}catch{}},timeoutMs);
  p.stdout.on('data',d=>{out+=d;});p.stderr?.on('data',d=>{err+=d;});
  p.on('error',e=>{err+=e.message;});
  p.on('close',()=>{clearTimeout(t);rmSync(cwd,{recursive:true,force:true});resolve({stdout:out,stderr:err});});
  p.stdin.end(input);
 });
}

// Ask the model about one PNG. Returns {json, declined, error, model}; json is the reply's last JSON.
export async function visionJson(imageBuf,prompt,{model=visionModel(),timeoutMs=90000,spawnImpl,bin=claudePath(),env=process.env,depth=0}={}){
 if(env.CAPTCHA_VISION==='0')return {json:null,declined:false,error:'vision disabled (CAPTCHA_VISION=0)',model};
 const msg={type:'user',message:{role:'user',content:[
  {type:'image',source:{type:'base64',media_type:'image/png',data:Buffer.from(imageBuf).toString('base64')}},
  {type:'text',text:prompt}]}};
 const {stdout,stderr,error}=await runCli(bin,visionArgs(model),JSON.stringify(msg)+'\n',{timeoutMs,spawnImpl});
 if(error)return {json:null,declined:false,error,model};
 const res=resultLine(stdout);
 if(!res)return {json:null,declined:false,error:'no result from the vision model: '+String(stderr||stdout).slice(-160).replace(/\s+/g,' '),model};
 const text=typeof res.result==='string'?res.result:JSON.stringify(res.result??'');
 if(res.is_error||res.subtype!=='success'){
  const next=/limit|overloaded|rate|usage/i.test(text)&&NEXT_MODEL[model];
  if(next&&depth<2)return visionJson(imageBuf,prompt,{model:next,timeoutMs,spawnImpl,bin,env,depth:depth+1});
  return {json:null,declined:false,error:`vision model error (${res.subtype}): ${text.slice(0,120)}`,model};
 }
 const json=lastJson(text);
 return {json,declined:declined(text,json),error:json?null:'vision reply held no JSON',model,text};
}

// Draw numbered markers (Set-of-Mark) and/or a labelled coordinate grid onto a PNG, inside the
// browser (no native image library). Coordinates are CSS pixels of the screenshot. Falls back to a
// blank scratch page when the employer page's CSP blocks data: images, and to the plain PNG on error.
export async function annotate(page,png,{numbers=[],radius=16,grid=0}={}){
 if(!numbers.length&&!grid)return png;
 const draw=async target=>target.evaluate(async({b64,numbers,radius,grid})=>{
  const img=new Image();img.src='data:image/png;base64,'+b64;await img.decode();
  const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;
  const x=c.getContext('2d');x.drawImage(img,0,0);
  if(grid){
   x.lineWidth=1;x.strokeStyle='rgba(255,0,0,0.45)';x.fillStyle='red';x.font='10px Arial';x.textAlign='left';
   for(let gx=grid;gx<c.width;gx+=grid){x.beginPath();x.moveTo(gx,0);x.lineTo(gx,c.height);x.stroke();x.fillText(String(gx),gx+2,11);}
   for(let gy=grid;gy<c.height;gy+=grid){x.beginPath();x.moveTo(0,gy);x.lineTo(c.width,gy);x.stroke();x.fillText(String(gy),2,gy-2);}
  }
  const r=Math.max(11,Math.min(26,Math.round(radius)));
  numbers.forEach((p,i)=>{
   x.beginPath();x.arc(p.x,p.y,r,0,Math.PI*2);x.fillStyle='rgba(255,0,0,0.72)';x.fill();x.lineWidth=2;x.strokeStyle='white';x.stroke();
   x.fillStyle='white';x.font=`bold ${r}px Arial`;x.textAlign='center';x.fillText(String(i+1),p.x,p.y+r*0.36);
  });
  return c.toDataURL('image/png').split(',')[1];
 },{b64:Buffer.from(png).toString('base64'),numbers,radius,grid});
 try{return Buffer.from(await draw(page),'base64');}catch{}
 let scratch=null;
 try{scratch=await page.context().newPage();await scratch.goto('about:blank');return Buffer.from(await draw(scratch),'base64');}
 catch{return png;}
 finally{await scratch?.close().catch(()=>{});}
}
