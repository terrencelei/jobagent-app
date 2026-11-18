// Greenhouse renders file inputs before its presigned-upload configuration arrives.
// Observe from navigation onward; a selected local file is not server acceptance.
export function monitorGreenhouseUploads(page) {
 const configurations=new Map();
 page.on('response',response=>{
  if(!/\/uncacheable_attributes\/presigned_fields(?:\?|$)/.test(response.url()))return;
  const frame=response.frame();
  configurations.set(frame,{origin:frame.evaluate(()=>performance.timeOrigin).catch(()=>null),data:response.json().then(data=>response.ok()&&data&&typeof data==='object'?data:null).catch(()=>null)});
 });
 // Greenhouse sometimes asks for this configuration 8+ s after the page loads (Astranis 4630, Varda 8191, Anduril 11019
 // failed at 15 s on 2026-11-02; a replay saw it at 14.5 s); nothing is attached before it arrives, so wait up to 40 s.
 return async (frame,locator,{timeout=40000}={})=>{
  const field=await locator.evaluate(el=>el.closest('.file-upload[aria-labelledby^="upload-label-"]')?el.id:null);
  if(!field)return;
  const end=Date.now()+timeout;
  // A same-document navigation (Apply anchor, pushState) keeps the document and its upload
  // manager, so the configuration stays valid; only a new document (timeOrigin) invalidates it.
  const current=async()=>{const entry=configurations.get(frame);if(!entry)return null;const now=await frame.evaluate(()=>performance.timeOrigin).catch(()=>null);return now!==null&&now===await entry.origin?entry:null;};
  let entry;
  while(!(entry=await current())&&Date.now()<end)await new Promise(r=>setTimeout(r,50));
  const data=await Promise.race([entry?.data??Promise.resolve(null),new Promise(r=>{const timer=setTimeout(()=>r(null),Math.max(1,end-Date.now()));timer.unref?.();})]);
  if(!data?.[field]?.fields||!data[field].key||!data.url)throw new Error('Greenhouse upload configuration did not load; no file was uploaded');
  // Let the employer fetch consumer finish creating its upload manager.
  await frame.evaluate(()=>new Promise(r=>setTimeout(r,0)));
 };
}
