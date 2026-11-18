// Direct, read-only Gmail API access to his mailbox (his choice, 2026-11-01). The claude.ai Gmail connector the
// mailbox bridge uses silently omits recent security-code mail ("Your Amazon A to Z verification code" sat in his
// school inbox while a search for that exact subject returned nothing) and redacts codes in others, so every Amazon,
// Oracle and recent Greenhouse code gate failed. Code lookups try this reader first and fall back to the bridge.
// The token is his own: tools/gmail-auth.mjs stores client_id, client_secret and a refresh token for the
// gmail.readonly scope in private/gmail-token.json. Mail content stays data; nothing here sends, labels or deletes.
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
export const TOKEN_PATH=join(ROOT,'private/gmail-token.json');
// Read at call time. Under node --test the real token is never used unless a test names one, so no test reads his mail.
const tokenPath=()=>process.env.GMAIL_TOKEN_PATH||(process.env.NODE_TEST_CONTEXT?'':TOKEN_PATH);
const API='https://gmail.googleapis.com/gmail/v1/users/me';
let cached=null;

async function accessToken({fetchImpl=globalThis.fetch,path=tokenPath()}={}){
 if(cached&&cached.path===path&&cached.expires>Date.now()+60000)return cached.token;
 if(!path)return null;
 let saved;try{saved=JSON.parse(await readFile(path,'utf8'));}catch{return null;}
 if(!saved?.refresh_token||!saved.client_id)return null;
 const response=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({client_id:saved.client_id,client_secret:saved.client_secret??'',refresh_token:saved.refresh_token,grant_type:'refresh_token'})});
 if(!response.ok)return null;
 const grant=await response.json();
 cached={path,token:grant.access_token,expires:Date.now()+(grant.expires_in??3600)*1000};
 return cached.token;
}

export function resetGmailDirectCache(){cached=null;}

const address=value=>String(value??'').match(/[^\s<>",]+@[^\s<>",]+/)?.[0]?.toLowerCase()??'';
const decode=data=>Buffer.from(String(data??'').replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8');
// Plain text unless html is asked for (Oracle checks the tenant's image links, which only the HTML part carries);
// the other type when the message has only that one.
function partOf(part,mime){
 if(!part)return '';
 if(part.mimeType===mime&&part.body?.data)return decode(part.body.data);
 return (part.parts??[]).map(p=>partOf(p,mime)).find(Boolean)??'';
}
// HTML-only mail (Greenhouse's Zipline code, 2026-11-02) read as text: tags would split the sentence the code sits in.
export function htmlText(html){
 return String(html).replace(/<(head|style|script)\b[\s\S]*?<\/\1>/gi,' ').replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h\d)>/gi,'\n').replace(/<[^>]+>/g,' ')
  .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))
  .replace(/[ \t]+/g,' ').replace(/\s*\n\s*/g,'\n').trim();
}
const bodyOf=(payload,html=false)=>html?partOf(payload,'text/html')||partOf(payload,'text/plain'):partOf(payload,'text/plain')||htmlText(partOf(payload,'text/html'));

// The newest message matching a Gmail search, in the evidence shape the code verifiers check
// ({messageId, receivedAt, sender, recipients, subject, body}); null when there is no token or no match.
export async function newestMessage(query,{fetchImpl=globalThis.fetch,path=tokenPath(),html=false}={}){
 const token=await accessToken({fetchImpl,path}).catch(()=>null);
 if(!token)return null;
 const headers={authorization:`Bearer ${token}`};
 const list=await fetchImpl(`${API}/messages?${new URLSearchParams({q:query,maxResults:'5'})}`,{headers});
 if(!list.ok)return null;
 const ids=((await list.json()).messages??[]).map(m=>m.id);
 let newest=null;
 for(const id of ids){
  const response=await fetchImpl(`${API}/messages/${encodeURIComponent(id)}?format=full`,{headers});
  if(!response.ok)continue;
  const message=await response.json();
  if(!newest||Number(message.internalDate)>Number(newest.internalDate))newest=message;
 }
 if(!newest)return null;
 const header=name=>newest.payload?.headers?.find(h=>h.name.toLowerCase()===name)?.value??'';
 return {messageId:newest.id,receivedAt:new Date(Number(newest.internalDate)).toISOString(),sender:address(header('from')),
  recipients:[header('to'),header('cc')].join(',').split(',').map(address).filter(Boolean),subject:header('subject'),body:bodyOf(newest.payload,html)};
}

export const gmailQueryDate=after=>Math.floor((typeof after==='number'?after*1000:Date.parse(after))/1000)-60;
