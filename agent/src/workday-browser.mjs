import {mkdtemp,mkdir} from 'node:fs/promises';
import {join} from 'node:path';

// Old Chromium profiles can stall before the first page exists. Preserve the
// profile and retry once in a clean directory; never remove someone else's lock.
export async function openWorkdayBrowser(chromium,profilePath,{onEvent=()=>{},...options}={}) {
 onEvent('Opening the saved Workday browser profile');
 try{return await chromium.launchPersistentContext(profilePath,{...options,timeout:30000});}
 catch(error){
  if(/ProcessSingleton|profile.*in use|user data directory is already in use/i.test(error.message))throw error;
  if(!/timeout|timed out|failed to launch|target.*closed/i.test(error.message))throw error;
  onEvent('Saved Workday browser failed to start; retrying once with a clean profile');
  await mkdir(profilePath+'-recovery',{recursive:true,mode:0o700});
  const clean=await mkdtemp(join(profilePath+'-recovery','run-'));
  return chromium.launchPersistentContext(clean,{...options,timeout:30000});
 }
}
