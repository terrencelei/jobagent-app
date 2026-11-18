// Preparation recognizes Workday's English wizard labels. Locale-less links
// otherwise inherit a persistent profile's last selected language (RTX: fr-CA).
// Restrict normalization to the initial public job/apply route; verification
// links and other sites must retain their original URLs.
export function englishWorkdayApplicationUrl(url) {
 const u=new URL(url);
 if(!/^[^.]+\.wd\d+\.myworkdayjobs\.com$/i.test(u.hostname))return url;
 if(!/^\/(?:[a-z]{2}-[A-Z]{2}\/)?[^/]+\/job\/.+\/apply\/?$/.test(u.pathname))return url;
 u.pathname='/en-US/'+u.pathname.replace(/^\/(?:[a-z]{2}-[A-Z]{2}\/)?/,'');
 return u.toString();
}

// Only the initial application GET is safe to repeat. Never wrap verification
// links, account actions, saved-step navigation or submission in this retry.
export async function openWorkdayApplicationPage(page,url,{onEvent=()=>{},wait=ms=>page.waitForTimeout(ms)}={}) {
 url=englishWorkdayApplicationUrl(url);
 const delays=[1000,3000];
 for(let attempt=0;;attempt++) {
  try{
   const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
   if(attempt>0&&response?.ok())onEvent('Workday initial page loaded after the browser disconnect; resuming preparation');
   return response;
  }
  catch(error) {
   // A delivered employer error page/HTTP 429 returns normally; leave it to
   // the existing throttle detector. Other navigation failures stay blocked.
   // Switching networks can interrupt recovery with ERR_NETWORK_CHANGED even
   // after the offline condition clears. It shares the same retry budget.
   if(!/\bnet::(?:ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED)\b/.test(error.message)||attempt===delays.length)throw error;
   onEvent(`Internet connection interrupted before Workday opened; waiting before retry ${attempt+1} of ${delays.length}`);
   await wait(delays[attempt]);
  }
 }
}
