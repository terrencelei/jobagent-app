import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Retry only DNS lookup failures, before any navigation or form action.
export async function validatePublicURL(value,allowLocalFixture=false,{resolveHost=lookup,wait=sleep,onRetry=async()=>{},onRecovered=async()=>{}}={}){
 const url=new URL(value);if(allowLocalFixture&&url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))return;
 if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')throw new Error('Application navigation requires a public HTTPS URL');
 let addresses,retries=0;
 for(let attempt=0;attempt<3;attempt++){
  try{addresses=await resolveHost(url.hostname,{all:true});break;}
  catch(error){if(!['ENOTFOUND','EAI_AGAIN'].includes(error.code)||attempt===2)throw error;retries++;const delay=1000*(attempt+1);await onRetry({host:url.hostname,code:error.code,attempt:retries,delay});await wait(delay);}
 }
 const privateIP=ip=>{if(isIP(ip)===4){const [a,b]=ip.split('.').map(Number);return a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a>=224||a===100&&b>=64&&b<=127;}return ip==='::'||ip==='::1'||/^f[cd]|^fe[89ab]|^::ffff:/i.test(ip);};
 if(!addresses.length||addresses.some(a=>privateIP(a.address)))throw new Error('Private network application URLs are not allowed');
 if(retries)await onRecovered({host:url.hostname,retries});
}
