import {readFile} from 'node:fs/promises';

// Sources and setup: docs/captcha-solver.md. Keys and tokens never enter model prompts.
const API='https://api.2captcha.com';
export async function loadCaptchaConfig(path,env=process.env){
 let config;try{config=JSON.parse(await readFile(path,'utf8'));}catch{return null;}
 if(config.enabled!==true||config.provider!=='2captcha'||!Array.isArray(config.allowedUrls))return null;
 return {...config,apiKey:config.apiKey||env.TWOCAPTCHA_API_KEY||env.TWO_CAPTCHA_API_KEY||''};
}
const canonical=url=>{try{const u=new URL(url);return u.protocol==='https:'?u.origin+u.pathname:null;}catch{return null;}};
export function captchaAuthorized(config,url,submissionAuthorized){
 const target=canonical(url);
 return submissionAuthorized===true&&config?.enabled===true&&config.provider==='2captcha'
  &&!!target&&config.allowedUrls?.some(value=>canonical(value)===target);
}

export async function solveRecaptchaV2({apiKey,websiteURL,websiteKey,isInvisible=false,apiDomain='google.com'},
 {fetchImpl=fetch,wait=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,timeoutMs=180000}={}){
 if(!apiKey||!canonical(websiteURL)||!websiteKey)throw Error('CAPTCHA solver configuration is incomplete');
 const deadline=now()+timeoutMs;
 const request=async(method,body)=>{
  const remaining=deadline-now();if(remaining<=0)throw Error('CAPTCHA solver timed out');
  let result;
  try{
   const response=await fetchImpl(`${API}/${method}`,{method:'POST',redirect:'error',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({clientKey:apiKey,...body}),
    signal:AbortSignal.timeout(Math.max(1,Math.min(remaining,20000)))});
   if(!response.ok)throw Error();result=await response.json();
  }catch{throw Error('CAPTCHA solver request failed');}
  if(result.errorId!==0)throw Error('CAPTCHA solver rejected the task');
  return result;
 };
 const created=await request('createTask',{task:{type:'RecaptchaV2TaskProxyless',websiteURL,websiteKey,isInvisible,apiDomain}});
 if(!Number.isSafeInteger(created.taskId)||created.taskId<=0)throw Error('CAPTCHA solver returned no task');
 while(now()<deadline){
  await wait(Math.min(5000,deadline-now()));
  const result=await request('getTaskResult',{taskId:created.taskId});
  if(result.status==='processing')continue;
  const token=result.solution?.gRecaptchaResponse;
  if(result.status!=='ready'||typeof token!=='string'||!token.trim())throw Error('CAPTCHA solver returned no token');
  return token;
 }
 throw Error('CAPTCHA solver timed out');
}

// Runs inside the employer page. Accept only one v2 widget and one success callback.
// Walk own data properties with limits; do not execute getters or expired/error callbacks.
export function recaptchaPageOperation({token=null,expectedKey=null}={}){
 const widgets=new Map();
 for(const iframe of document.querySelectorAll('iframe')){
  let url;try{url=new URL(iframe.src);}catch{continue;}
  if(!['www.google.com','www.recaptcha.net','recaptcha.google.com'].includes(url.hostname)
   ||!/^\/recaptcha\/api2\/(anchor|bframe)$/.test(url.pathname))continue;
  const key=url.searchParams.get('k');if(!key)continue;
  const previous=widgets.get(key);
  widgets.set(key,{key,isInvisible:previous?.isInvisible||url.searchParams.get('size')==='invisible',
   apiDomain:url.hostname.includes('recaptcha.net')?'recaptcha.net':'google.com'});
 }
 if(widgets.size!==1)return null;
 const widget=[...widgets.values()][0];if(expectedKey&&expectedKey!==widget.key)return null;
 const clients=window.___grecaptcha_cfg?.clients;if(!clients)return null;
 const candidates=[];
 for(const client of Object.values(clients)){
  const seen=new Set(),stack=[{value:client,depth:0}],callbacks=new Set();let matches=false;
  while(stack.length&&seen.size<2000){
   const {value,depth}=stack.pop();
   if(!value||typeof value!=='object'||seen.has(value)||depth>10)continue;
   seen.add(value);
   let descriptors;try{descriptors=Object.getOwnPropertyDescriptors(value);}catch{continue;}
   for(const [name,descriptor]of Object.entries(descriptors)){
    if(!('value'in descriptor))continue;const child=descriptor.value;
    if(name==='sitekey'&&child===widget.key)matches=true;
    if(name==='callback'&&typeof child==='function')callbacks.add(child);
    if(child&&typeof child==='object')stack.push({value:child,depth:depth+1});
   }
  }
  if(matches&&callbacks.size===1)candidates.push([...callbacks][0]);
 }
 if(candidates.length!==1)return null;
 if(!token)return widget;
 for(const field of document.querySelectorAll('textarea[name="g-recaptcha-response"]'))field.value=token;
 candidates[0](token); // Resume this pending submission once; never click Submit again.
 return {delivered:true};
}

export async function completeCaptcha(page,job,{config,submissionAuthorized=false,solve=solveRecaptchaV2,log=()=>{}}={}){
 if(!captchaAuthorized(config,job.url,submissionAuthorized)||canonical(page.url())!==canonical(job.url))
  return {completed:false,reason:'CAPTCHA solver is not enabled for this posting'};
 if(!config.apiKey)return {completed:false,reason:'CAPTCHA solver needs a saved 2Captcha API key'};
 try{
  const widget=await page.evaluate(recaptchaPageOperation,{});
  if(!widget)return {completed:false,reason:'CAPTCHA widget is unsupported or ambiguous'};
  await log('Solving the authorized CAPTCHA with 2Captcha; acceptance is still unverified');
  const token=await solve({apiKey:config.apiKey,websiteURL:job.url,websiteKey:widget.key,
   isInvisible:widget.isInvisible,apiDomain:widget.apiDomain});
  const delivered=await page.evaluate(recaptchaPageOperation,{token,expectedKey:widget.key});
  if(!delivered?.delivered)return {completed:false,reason:'CAPTCHA widget changed before token delivery'};
  return {completed:true}; // Token delivery is not proof of employer acceptance.
 }catch{return {completed:false,reason:'CAPTCHA solver failed; acceptance is still unverified'};}
}
