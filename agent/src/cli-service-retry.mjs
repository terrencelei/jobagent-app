const lifecycle = new Set(['thread.started','turn.started','error','turn.failed']);

// CLI tools can have side effects. Only a transport failure before any item is
// safe to replay; unknown or malformed output is deliberately not retryable.
export function retryableCodexServiceFailure({code,stdout='',stderr=''}) {
 if(!Number.isInteger(code)||code<=0)return false;
 const events=[];
 for(const line of stdout.split('\n').filter(s=>s.trim())){
  try{const event=JSON.parse(line);if(!lifecycle.has(event?.type))return false;events.push(event);}catch{return false;}
 }
 const text=stderr+' '+events.map(e=>e.error?.message??e.message??'').join(' ');
 if(/(?:usage|session|weekly|daily|rate) limit|quota|too many requests|\b(?:401|403|429)\b|unauthorized|authentication|did not answer within/i.test(text))return false;
 return /(?:unexpected status\s+503\b|503\s+Service Unavailable)/i.test(text);
}

export async function execCodexWithServiceRetry(execImpl,command,args,input,options,{wait=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
 let retriedStall=false;
 for(let attempt=0;;attempt++){
  let result;
  try{result=await execImpl(command,args,input,options);}catch(error){
   // Only replay a fully stopped CLI that emitted exactly startup lifecycle
   // events. Never infer safety from an error message or byte counts.
   if(attempt>=2||retriedStall||error?.code!=='CLI_TIMEOUT'||error.processClosed!==true||error.progress?.replaySafe!==true)throw error;
   retriedStall=true;await wait(1000);continue;
  }
  if(attempt>=2||!retryableCodexServiceFailure(result))return result;
  await wait([1000,3000][attempt]);
 }
}

// Claude has no transport-retry signal; only the startup-only stall above is replayed (lesson 239).
export async function execWithStallRetry(execImpl,command,args,input,options,{wait=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
 try{return await execImpl(command,args,input,options);}catch(error){
  // Claude can print its complete final result event and then never exit (Rocket Lab 15245: "did not answer
  // within 180s" with the last stage 'result'). The answer was given; the kill must not discard it.
  if(error?.code==='CLI_TIMEOUT'&&hasClaudeResult(error.stdout))return {code:0,stdout:error.stdout,stderr:error.stderr??''};
  if(error?.code!=='CLI_TIMEOUT'||error.processClosed!==true||error.progress?.replaySafe!==true)throw error;
  await wait(1000);return execImpl(command,args,input,options);
 }
}

export function hasClaudeResult(stdout){
 for(const line of String(stdout??'').split('\n')){
  try{const e=JSON.parse(line);if(e?.type==='result'&&!e.is_error&&(e.structured_output!=null||e.result))return true;}catch{}
 }
 return false;
}
