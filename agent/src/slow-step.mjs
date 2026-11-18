// Timing for Workday control work (2026-11-13). A Workday run spent 10 min 40 s with one model call
// (jobagent-16671): the time went into the worker's own control handling, and the event log could not say
// which control. Anything slower than the limit is named in the run's events; fast work stays silent.
export async function timed(label,fn,{limitMs=3000,log=console.log,now=Date.now}={}){
 const start=now();
 try{return await fn();}
 finally{
  const ms=now()-start;
  if(ms>=limitMs)log(`  slow: ${typeof label==='function'?await Promise.resolve().then(label).catch(()=>'control'):label} took ${(ms/1000).toFixed(1)}s`);
 }
}
export const controlName=locator=>async()=>(await locator.getAttribute('id',{timeout:500}).catch(()=>null))||'control';
