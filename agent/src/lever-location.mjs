// Lever's "Current location" (input.location-input + hidden #selected-location) is a typeahead
// whose retrieveLocations.js blanks the text on blur unless a .dropdown-location suggestion was
// picked. A plain fill looks kept until the next field takes focus (Humble Robotics 12510).
// Search by city, pick the one suggestion that reads as the saved location, and verify both inputs.
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const canonical=value=>String(value??'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
 .replace(/\bcalifornia\b/g,'ca').replace(/\bunited states(?: of america)?\b/g,'usa').replace(/\bus\b/g,'usa');

export async function isLeverLocation(locator){
 return locator.evaluate(el=>el.matches('input.location-input')&&!!el.closest('form,body')?.querySelector('input[type=hidden]#selected-location')).catch(()=>false);
}

export async function pickLeverLocation(locator,value,{timeoutMs=10000}={}){
 if(!await isLeverLocation(locator))return null;
 const page=locator.page(),want=canonical(value),city=String(value).split(',')[0].trim();
 const suggestions=page.locator('.dropdown-results .dropdown-location');
 await locator.click();await locator.fill('');await locator.pressSequentially(city,{delay:60});
 let options=[];
 for(const end=Date.now()+timeoutMs;Date.now()<end;){
  await sleep(250);
  options=(await suggestions.allTextContents()).map(s=>s.trim()).filter(Boolean);
  if(options.some(o=>canonical(o)===want))break;
 }
 const matches=options.map((o,i)=>[o,i]).filter(([o])=>canonical(o)===want);
 if(matches.length!==1){await locator.fill('');await locator.evaluate(el=>el.blur()).catch(()=>{});return{ok:false,options};}
 await suggestions.nth(matches[0][1]).click();await sleep(200);
 await locator.evaluate(el=>el.blur()).catch(()=>{});await sleep(200);
 const kept=await locator.inputValue(),selected=await page.locator('#selected-location').inputValue();
 return{ok:canonical(kept)===want&&!!selected,options,value:kept};
}
