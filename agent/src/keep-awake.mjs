import {spawn} from 'node:child_process';

// An unattended worker must not lose a model step to idle sleep: a sleeping Mac
// froze the CLI and every step timer expired together on wake (job 7922, 11:33:31Z).
// caffeinate -i -w ties the assertion to this process, so it ends when the worker exits.
// -i alone does not hold a dark-woken Mac: Anduril 4662 lost a step to a 473 s Maintenance
// Sleep with -i held (16:23Z). -s adds PreventSystemSleep, which macOS honours on AC power.
export function keepAwake({platform=process.platform,pid=process.pid,spawnImpl=spawn}={}){
 if(platform!=='darwin')return null;
 try{
  const child=spawnImpl('/usr/bin/caffeinate',['-i','-s','-w',String(pid)],{stdio:'ignore',detached:false});
  child.on?.('error',()=>{});child.unref?.();
  return child;
 }catch{return null;}
}
