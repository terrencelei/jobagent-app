import {open,readFile,unlink} from 'node:fs/promises';

// A worker killed before its cleanup left job and company locks behind, and every later run for
// that employer failed at once with EEXIST (Anduril 4662/11394, run 9ef407d0). Each lock now
// records its owner's pid; a lock whose recorded owner is no longer running is taken over once.
// A lock without a pid (older workers) or with a live owner is never taken.
export const processAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
export async function acquireLock(path,{pid=process.pid,alive=processAlive}={}){
 for(let attempt=0;;attempt++){
  try{
   const handle=await open(path,'wx',0o600);
   await handle.writeFile(String(pid));handle.pathName=path;return handle;
  }catch(error){
   if(error.code!=='EEXIST'||attempt)throw error;
   const owner=Number((await readFile(path,'utf8').catch(()=>'')).trim());
   if(!Number.isInteger(owner)||owner<=0||alive(owner))throw error;
   await unlink(path).catch(()=>{});
  }
 }
}
