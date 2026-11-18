// CAPTCHA COVERAGE TEST (2026-10-16) — every challenge family against a faithful local replica, in a HIDDEN browser.
//   node automation/tests/captcha_coverage_test.js            (SKIP_VLM=1 skips the one real-model OCR case)
// The replicas are served on fake https origins (incl. www.google.com / hcaptcha.com / challenges.cloudflare.com paths)
// through request interception; a mock solver API returns fixed tile answers, so what is tested is the solver's
// MECHANICS: finding the widget (nested iframes, closed shadow roots), numbering the real tiles, clicking/dragging the
// right pixels, recognising walls, and never touching the application form. No live site is contacted.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
// mechanics only: the local models (captcha_service.py) would answer the fake tiles/slider before the mock — their accuracy
// is measured on the vendors' real demo pages (tests/captcha_live_bench.js), not here
process.env.AURA_CAPTCHA_LOCAL = '0'; process.env.AURA_GEMINI = '0'; process.env.AURA_CAPTCHA_LOG = '0';

const calls = [];
// ByteDance "Select 2 objects that are the same shape": per layout, five shapes at fixed points (image pixels) and which two match
const BD_LAYOUTS = [
  { pts: [[50, 60], [140, 150], [230, 70], [300, 160], [170, 40]], kinds: ['cube', 'cone', 'ring', 'cube', 'star'], same: [0, 3] },
  { pts: [[60, 150], [120, 50], [210, 120], [290, 60], [310, 170]], kinds: ['ring', 'star', 'cone', 'star', 'cube'], same: [1, 3] },
];
let bdCalls = 0, declineVision = false;
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    const j = b ? JSON.parse(b) : {}; calls.push(j.type + ':' + String(j.prompt || '').slice(0, 300));
    let out = { ok: false };
    // vision (claudeVision's test hook): tile prompts get the same fixed answers as vlm_grid; ByteDance gets a wrong pick on
    // its first round and the right one on the next (the replica refreshes with a new layout); OCR goes to the real model
    if (j.type === 'vision') {
      if (declineVision) out = { declined: true };
      else if (/reCAPTCHA \(4×4\)/.test(j.prompt)) out = { answer: [2, 7, 16] };
      else if (/hCaptcha image challenge/.test(j.prompt)) out = { answer: [1, 5, 9] };
      else if (/ByteDance/.test(j.prompt)) { bdCalls++; out = { answer: bdCalls === 1 ? { clicks: [[20, 20], [40, 30]] } : { clicks: BD_LAYOUTS[1].same.map((i) => BD_LAYOUTS[1].pts[i]) } }; }
      else out = { passthrough: true };
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(out));
    }
    if (j.type === 'vlm_grid' && /reCAPTCHA \(4×4\)/.test(j.prompt)) out = { ok: true, tiles: [2, 7, 16] };
    else if (j.type === 'vlm_grid' && /hCaptcha/.test(j.prompt)) out = { ok: true, tiles: [1, 5, 9] };
    else if (j.type === 'slider') out = { ok: true, x_offset: 180, confidence: 0.9 };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
  });
});

const FAILS = [];
const check = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' — ' + JSON.stringify(info).slice(0, 300))); if (!cond) FAILS.push(name); };
const H = (body, head = '') => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body style="margin:0;font:14px Arial">${body}</body></html>`;

// ── replicas ────────────────────────────────────────────────────────────────
const tiles = (n, size, cls) => { let s = '<table style="border-spacing:2px">'; for (let r = 0; r < n; r++) { s += '<tr>'; for (let c = 0; c < n; c++) s += `<td class="${cls}" data-n="${r * n + c + 1}" style="width:${size}px;height:${size}px;background:hsl(${(r * n + c) * 23},50%,60%)"></td>`; s += '</tr>'; } return s + '</table>'; };
const PAGES = {
  // reCAPTCHA v2, 4×4, inside an ATS iframe (nested)
  'https://ats.test/recap': H('<h3>Apply</h3><iframe src="https://ats.test/recap-inner" width="760" height="760" style="border:0"></iframe>'),
  'https://ats.test/recap-inner': H('<iframe src="https://www.google.com/recaptcha/api2/anchor?k=x" width="304" height="78" style="border:0"></iframe><br><iframe src="https://www.google.com/recaptcha/api2/bframe?k=x" width="400" height="600" style="border:0"></iframe>'),
  'https://www.google.com/recaptcha/api2/anchor': H('<div id="recaptcha-anchor" role="checkbox" aria-checked="false" style="width:28px;height:28px;margin:25px 12px;border:2px solid #999"></div>' +
    '<script>new BroadcastChannel("rc").onmessage=(e)=>{if(e.data==="ok")document.getElementById("recaptcha-anchor").setAttribute("aria-checked","true")}</script>'),
  'https://www.google.com/recaptcha/api2/bframe': H('<div class="rc-imageselect-desc-wrapper" style="height:90px;background:#4a90e2;color:#fff;padding:8px">Select all squares with <b>traffic lights</b></div>' +
    `<div class="rc-imageselect-challenge" style="display:inline-block">${tiles(4, 92, 'rc-imageselect-tile')}</div><br><button id="recaptcha-verify-button">VERIFY</button>` +
    '<script>const sel=new Set();document.querySelectorAll("td").forEach(td=>td.onclick=()=>{const n=+td.dataset.n;sel.has(n)?sel.delete(n):sel.add(n);td.style.outline=sel.has(n)?"3px solid blue":""});' +
    'document.getElementById("recaptcha-verify-button").onclick=()=>{window.__picked=[...sel].sort((a,b)=>a-b);if(window.__picked.join()==="2,7,16"){new BroadcastChannel("rc").postMessage("ok");document.body.innerHTML="";}}</script>'),
  'https://www.google.com/recaptcha/api2/anchor-invisible': H('<div>invisible</div>'),
  'https://ats.test/recap-v3': H('<form><input name="email"></form><iframe src="https://www.google.com/recaptcha/api2/anchor-invisible?ar=1&k=x&size=invisible" width="256" height="60" style="border:0"></iframe>'),
  // hCaptcha inside an iCIMS-style content iframe (the iCIMS failure), challenge with a 110px header above the 3×3 grid
  'https://careers-acme.icims.com/jobs/1/apply': H('<h3>Acme careers</h3><iframe id="icims_content_iframe" src="https://careers-acme.icims.com/jobs/1/login?in_iframe=1" width="900" height="900" style="border:0"></iframe>'),
  'https://careers-acme.icims.com/jobs/1/login': H('<form><input name="email" value="a@b.c"><textarea name="h-captcha-response" style="display:none"></textarea>' +
    '<iframe src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&id=1" width="303" height="78" style="border:0"></iframe>' +
    '<iframe id="ch" src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge&id=1" width="520" height="620" style="border:0;display:none"></iframe></form>' +
    '<script>addEventListener("message",(e)=>{if(e.data==="open")document.getElementById("ch").style.display="block";if(e.data&&e.data.token){document.querySelector("textarea").value=e.data.token;document.getElementById("ch").style.display="none"}})</script>'),
  'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html': H('<div id="root"></div><script>' +
    'if(location.hash.includes("checkbox")){root.innerHTML=\'<div id="checkbox" aria-checked="false" style="width:28px;height:28px;margin:24px 14px;border:2px solid #999"></div>\';checkbox.onclick=()=>parent.postMessage("open","*")}' +
    `else{root.innerHTML='<div class="challenge-container"><div class="prompt-text" style="height:110px;background:#0074bf;color:#fff">Please click each image containing a bus</div><div class="task-grid">${tiles(3, 150, 'task-image').replace(/'/g, "\\'")}</div><button class="button-submit">Verify</button></div>';` +
    'const sel=new Set();document.querySelectorAll(".task-image").forEach(t=>t.onclick=()=>{const n=+t.dataset.n;sel.has(n)?sel.delete(n):sel.add(n)});' +
    'document.querySelector(".button-submit").onclick=()=>{window.__picked=[...sel].sort((a,b)=>a-b);' +
    // Lever variant: the first Verify is rejected and the challenge CLOSES (no new round); the second passes. Both go through
    // hCaptcha's /checkcaptcha, whose reply carries the verdict
    'if(location.hash.includes("lever")){window.__tries=(window.__tries||0)+1;const ok=window.__tries>=2&&window.__picked.join()==="1,5,9";' +
    'fetch("https://api.hcaptcha.com/checkcaptcha/sk/key?pass="+(ok?1:0),{method:"POST"}).finally(()=>{if(ok)parent.postMessage({token:"P1_"+"y".repeat(40)},"*");else{sel.clear();parent.postMessage("closed","*")}});return}' +
    'if(window.__picked.join()==="1,5,9")parent.postMessage({token:"P1_"+"x".repeat(40)},"*")}}</script>'),
  // LEVER (Veeva, 2026-10-17): invisible hCaptcha opened by the site's Submit; an empty OPTIONAL field; the token goes straight
  // into the site's callback, which submits and resets the widget — no token is left in the page
  'https://jobs.lever.test/acme/1/apply': H('<form><input name="name" value="Stanley"><input name="org" placeholder="Current company (optional)" value=""><textarea name="h-captcha-response" style="display:none"></textarea>' +
    '<div class="h-captcha" data-size="invisible" data-hcaptcha-widget-id="w4"></div><button id="sub" type="button">Submit application</button>' +
    '<iframe src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox-invisible&id=4" width="300" height="150" style="border:0;position:absolute;top:-9915px"></iframe>' +
    '<iframe id="ch" src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge&id=4&lever=1" width="520" height="620" style="border:0;display:none"></iframe></form>' +
    '<script>window.__executed=0;window.__submits=0;window.hcaptcha={execute(){window.__executed++;document.getElementById("ch").style.display="block"}};' +
    'document.getElementById("sub").onclick=()=>window.hcaptcha.execute();' +
    'addEventListener("message",(e)=>{if(e.data==="closed")document.getElementById("ch").style.display="none";' +
    'if(e.data&&e.data.token){document.getElementById("ch").style.display="none";window.__submits++;document.querySelector("textarea").value=""}})</script>'),
  // ByteDance / TikTok "Select 2 objects that are the same shape" inside an iframe: img#captcha-verify-image, title, Confirm;
  // the frame checks the clicks itself (a wrong pick → a NEW layout, like the real one)
  'https://careers.tiktok.test/job/1/apply': H('<h3>TikTok careers</h3><form><input name="email" value="a@b.c"></form><iframe src="https://verify.tiktok.test/captcha/select" width="420" height="380" style="border:0"></iframe>'),
  'https://verify.tiktok.test/captcha/select': H('<div class="captcha_verify_container" style="width:380px;padding:10px"><div class="captcha_verify_bar--title" style="height:30px">Select 2 objects that are the same shape:</div>' +
    '<div class="captcha_verify_img--wrapper" style="position:relative;width:340px;height:212px"><img id="captcha-verify-image" width="340" height="212" style="display:block"></div>' +
    '<div style="height:40px"><a class="secsdk_captcha_refresh" href="#">Refresh</a> <div class="verify-captcha-submit-button" style="display:inline-block;padding:8px 20px;background:#fe2c55;color:#fff;cursor:pointer">Confirm</div></div></div>' +
    `<script>const LAY=${JSON.stringify(BD_LAYOUTS)};let L=0,clicks=[];window.__bdFails=0;const img=document.getElementById("captcha-verify-image");` +
    'function draw(){const c=document.createElement("canvas");c.width=340;c.height=212;const g=c.getContext("2d");g.fillStyle="#cfd8dc";g.fillRect(0,0,340,212);' +
    'LAY[L].pts.forEach(([x,y],i)=>{g.fillStyle="hsl("+i*70+",60%,45%)";const k=LAY[L].kinds[i];g.beginPath();if(k==="cube")g.rect(x-18,y-18,36,36);else if(k==="ring")g.arc(x,y,18,0,7);else{g.moveTo(x,y-20);g.lineTo(x+18,y+16);g.lineTo(x-18,y+16)}g.fill()});img.src=c.toDataURL()}draw();' +
    'img.addEventListener("click",(e)=>{clicks.push([e.offsetX,e.offsetY])});' +
    'document.querySelector(".verify-captcha-submit-button").onclick=()=>{const s=LAY[L].same.map(i=>LAY[L].pts[i]);' +
    'const ok=clicks.length===2&&s.every(([x,y])=>clicks.some(([cx,cy])=>Math.hypot(cx-x,cy-y)<=22));' +
    'if(ok){document.querySelector(".captcha_verify_container").innerHTML="<p>Verification complete</p>";window.__bdPassed=true}else{window.__bdFails++;L=Math.min(L+1,LAY.length-1);clicks=[];draw()}}</script>'),
  // TikTok's newer layout: #captcha-verify-container-main-page, .cap-* classes, a small icon <img> BEFORE the challenge picture
  'https://careers.tiktok.test/job/2/apply': H('<h3>TikTok careers</h3><iframe src="https://verify.tiktok.test/captcha/select2" width="420" height="400" style="border:0"></iframe>'),
  'https://verify.tiktok.test/captcha/select2': null,
  // Turnstile rendered with execution:"execute" (Rippling-like): reset() does nothing; only turnstile.execute(widgetId) runs the check
  'https://shop.test/ts-exec': H('<form><div class="cf-turnstile" data-sitekey="x" style="display:none"><input type="hidden" id="cf-chl-widget-abc12_response" name="cf-turnstile-response" value=""></div></form>' +
    '<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/x" width="0" height="0" style="border:0;display:none"></iframe>' +
    '<script>window.turnstile={reset(){window.__resets=(window.__resets||0)+1},isExpired(){return false},execute(id){window.__execs=(window.__execs||[]).concat([String(id)]);' +
    'setTimeout(()=>{document.getElementById("cf-chl-widget-abc12_response").value="0."+"c".repeat(60)},1500)}}</script>'),
  // INVISIBLE hCaptcha (the real iCIMS sign-in, 2026-10-16): no checkbox on screen — the challenge opens only through
  // hcaptcha.execute(); the site's callback then continues the sign-in
  'https://careers-inv.icims.com/jobs/2/apply': H('<iframe id="icims_content_iframe" src="https://careers-inv.icims.com/jobs/2/login?in_iframe=1" width="900" height="900" style="border:0"></iframe>'),
  'https://careers-inv.icims.com/jobs/2/login': H('<form><input name="css_loginName" value="a@b.c"><textarea name="h-captcha-response" style="display:none"></textarea>' +
    '<div class="h-captcha" data-size="invisible" data-sitekey="x"></div><button type="button">Next</button>' +
    '<iframe src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&id=2" width="300" height="150" style="border:0;position:absolute;top:-9915px"></iframe>' +
    '<iframe id="ch" src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge&id=2" width="520" height="620" style="border:0;display:none"></iframe></form>' +
    '<script>window.hcaptcha={execute(){window.__executed=(window.__executed||0)+1;document.getElementById("ch").style.display="block"}};' +
    'addEventListener("message",(e)=>{if(e.data&&e.data.token){document.querySelector("textarea").value=e.data.token;document.getElementById("ch").style.display="none";window.__callback=true}})</script>'),
  'https://careers-inv.icims.com/jobs/3/apply': H('<iframe id="icims_content_iframe" src="https://careers-inv.icims.com/jobs/3/login?in_iframe=1" width="900" height="900" style="border:0"></iframe>'),
  'https://careers-inv.icims.com/jobs/3/login': H('<form><input name="css_loginName" value=""><textarea name="h-captcha-response" style="display:none"></textarea>' +
    '<div class="h-captcha" data-size="invisible" data-sitekey="x"></div><button type="button">Next</button>' +
    '<iframe src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&id=3" width="300" height="150" style="border:0;position:absolute;top:-9915px"></iframe></form>' +
    '<script>window.hcaptcha={execute(){window.__executed=(window.__executed||0)+1}}</script>'),
  // Ashby: invisible reCAPTCHA with its challenge frame preloaded HIDDEN — not a CAPTCHA until the site opens it
  'https://ats.test/ashby-like': H('<form><input name="name" value="Stanley"></form><iframe src="https://www.google.com/recaptcha/api2/anchor-invisible?ar=1&k=x&size=invisible" width="256" height="60" style="border:0"></iframe>' +
    '<div style="visibility:hidden;position:absolute;top:-10000px"><iframe src="https://www.google.com/recaptcha/api2/bframe?k=x&hidden=1" width="400" height="580" style="border:0"></iframe></div>'),
  // Dayforce (2026-10-22, Interactive Brokers): Google's challenge frame preloaded FULL-SIZE at 0,0 under a visibility:hidden
  // container — the size check alone called it an open challenge and the job was parked "CAPTCHA" with nothing on screen
  'https://ats.test/dayforce-like': H('<form><input name="name" value="Stanley"></form><iframe src="https://www.google.com/recaptcha/api2/anchor?ar=1&k=x&size=invisible" width="256" height="60" style="border:0"></iframe>' +
    '<div style="visibility:hidden;position:fixed;top:0;left:0"><iframe src="https://www.google.com/recaptcha/api2/bframe?k=x&hidden=2" width="1280" height="1000" style="border:0"></iframe></div>'),
  // Rippling: a Turnstile that already holds its token keeps its widget on screen
  'https://shop.test/ts-solved': H('<form><input type="hidden" name="cf-turnstile-response" value="0.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"><div class="cf-turnstile" style="width:300px;height:65px;margin:30px"></div></form>' +
    '<script>const sr=document.querySelector(".cf-turnstile").attachShadow({mode:"closed"});sr.innerHTML=\'<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/x" width="300" height="65" style="border:0"></iframe>\'</script>'),
  // Odoo: INTERACTION-ONLY Turnstile (display:none) whose token is gone (expired / cleared) — only turnstile.reset() renews it
  'https://shop.test/ts-hidden': H('<form><input type="hidden" name="turnstile_captcha" value=""><div class="s_turnstile cf-turnstile" data-appearance="interaction-only" style="display:none"></div></form>' +
    '<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/x" width="0" height="0" style="border:0;display:none"></iframe>' +
    '<script>window.turnstile={reset(){window.__resets=(window.__resets||0)+1;setTimeout(()=>{document.querySelector("[name=turnstile_captcha]").value="0."+"b".repeat(60)},2000)},isExpired(){return false},execute(){}}</script>'),
  // Turnstile mounted in a CLOSED shadow root (Odoo)
  'https://shop.test/ts': H('<form><input type="hidden" name="cf-turnstile-response" value=""><div class="cf-turnstile" style="width:300px;height:65px;margin:30px"></div></form>' +
    '<script>const sr=document.querySelector(".cf-turnstile").attachShadow({mode:"closed"});sr.innerHTML=\'<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/x" width="300" height="65" style="border:0"></iframe>\';' +
    'addEventListener("message",(e)=>{if(e.data&&e.data.ts)document.querySelector("[name=cf-turnstile-response]").value=e.data.ts})</script>'),
  'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/x': '<!doctype html><html style="height:100%"><body style="margin:0;height:100%"><div style="position:absolute;left:16px;top:20px;width:24px;height:24px;border:2px solid #666"></div>' +
    '<script>document.addEventListener("click",(e)=>{window.__clicks=(window.__clicks||0)+1;if(e.clientX<70)parent.postMessage({ts:"0."+"a".repeat(60)},"*")})</script></body></html>',
  // Cloudflare "Just a moment…" interstitial that clears by itself
  'https://shop.test/cf': H('<div id="challenge-running">Verify you are human by completing the action below.</div><script>setTimeout(()=>location.href="/job",3000)</script>', '<title>Just a moment...</title>'),
  'https://shop.test/job': H('<h1>Software Engineer, New Grad</h1><p>Apply now</p>'),
  // edge blocks: never solved
  'https://shop.test/akamai': H('<h1>Access Denied</h1>You don\'t have permission to access "http://shop.test/" on this server.<p>Reference #18.4f3a2e17.1697000000.1a2b3c4d</p>', '<title>Access Denied</title>'),
  // PerimeterX press & hold
  'https://shop.test/px': H('<p>Press &amp; Hold to confirm you are a human</p><div id="px-captcha" style="width:250px;height:60px;border:1px solid;margin:40px"></div>' +
    '<script>let t0=0;const el=document.getElementById("px-captcha");el.addEventListener("mousedown",()=>t0=Date.now());document.addEventListener("mouseup",()=>{if(t0&&Date.now()-t0>4000){el.remove();document.body.insertAdjacentHTML("beforeend","<p>verified</p>")}t0=0})</script>'),
  // Friendly Captcha (proof of work)
  'https://shop.test/frc': H('<form><input name="email"><div class="frc-captcha" style="width:300px;height:70px;border:1px solid"><button class="frc-button" type="button">Click to start verification</button><input type="hidden" name="frc-captcha-solution" value=".UNSTARTED"></div></form>' +
    '<script>document.querySelector(".frc-button").onclick=()=>setTimeout(()=>{document.querySelector("[name=frc-captcha-solution]").value="abc.def.ghi";document.querySelector(".frc-captcha").classList.add("frc-success")},2000)</script>'),
  // text-image CAPTCHA
  'https://shop.test/text': H('<form><label>Name <input name="name" value="Stanley"></label><br><img id="captcha_image" width="220" height="70" style="margin:12px"><br><input name="captcha_code" placeholder="Enter the characters shown"></form>' +
    '<script>const c=document.createElement("canvas");c.width=220;c.height=70;const g=c.getContext("2d");g.fillStyle="#f2f2f2";g.fillRect(0,0,220,70);g.font="bold 40px Courier New";g.fillStyle="#223";g.fillText("X7K2P",30,50);' +
    'g.strokeStyle="#aaa";[[5,10,210,60],[0,40,220,30]].forEach(([a,b,cc,d])=>{g.beginPath();g.moveTo(a,b);g.lineTo(cc,d);g.stroke()});document.getElementById("captcha_image").src=c.toDataURL()</script>'),
  // DataDome-style slider in its own iframe
  'https://shop.test/dd': H('<iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=x" width="400" height="320" style="border:0;margin:20px"></iframe>'),
  'https://geo.captcha-delivery.com/captcha/': H('<div style="position:relative;width:300px;height:150px;margin:10px"><canvas id="bg" width="300" height="150" style="position:absolute;left:0;top:0"></canvas><canvas id="pc" width="50" height="50" style="position:absolute;left:0;top:50px"></canvas></div>' +
    '<div class="sliderContainer" style="position:relative;width:300px;height:40px;margin:10px;background:#ddd"><div class="sliderIcon" style="position:absolute;left:0;top:0;width:40px;height:40px;background:#08f"></div></div>' +
    '<script>const g=bg.getContext("2d");for(let i=0;i<30;i++){g.fillStyle=`hsl(${i*12},60%,55%)`;g.fillRect(i*10,0,10,150)}g.fillStyle="rgba(0,0,0,.6)";g.fillRect(180,50,50,50);const p=pc.getContext("2d");p.fillStyle="#fff";p.fillRect(0,0,50,50);' +
    'let sx=null,last=0;const ic=document.querySelector(".sliderIcon");ic.addEventListener("mousedown",(e)=>{sx=e.clientX});document.addEventListener("mousemove",(e)=>{if(sx!==null){last=e.clientX-sx;ic.style.left=last+"px";pc.style.left=last+"px"}});' +
    'document.addEventListener("mouseup",()=>{if(sx===null)return;window.__moved=last;sx=null;if(Math.abs(last-180)<=8)document.body.innerHTML="<p>passed</p>"})</script>'),
  // arithmetic CAPTCHA: detected, never answered (policy)
  'https://shop.test/math': H('<form><label for="captcha">Security question: What is 3 + 4?</label><input name="captcha" id="captcha"></form>'),
  // an application form with a range slider and consent checkboxes — must never be touched
  'https://shop.test/form': H('<form><label>Years of experience <input type="range" id="yrs" min="0" max="10" value="2"></label><div class="slider" role="slider" aria-valuenow="2" style="width:200px;height:20px;background:#ccc"></div>' +
    '<label><input type="checkbox" id="checkbox"> I consent</label> <span class="check" style="display:inline-block;width:20px;height:20px;border:1px solid"></span></form>' +
    '<script>window.__clicks=0;document.addEventListener("click",()=>window.__clicks++,true)</script>'),
};

PAGES['https://verify.tiktok.test/captcha/select2'] = PAGES['https://verify.tiktok.test/captcha/select']
  .replace('<div class="captcha_verify_container" style="width:380px;padding:10px"><div class="captcha_verify_bar--title" style="height:30px">',
    '<div id="captcha-verify-container-main-page" class="cap-flex" style="width:380px;padding:10px"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="24" height="24"><div class="cap-text-left" style="height:30px">')
  .replace('class="captcha_verify_img--wrapper"', 'class="cap-img-wrap"').replace('id="captcha-verify-image"', 'draggable="false" class="cap-main"')
  .replace('getElementById("captcha-verify-image")', 'querySelector(".cap-main")')
  .replace('class="secsdk_captcha_refresh"', 'id="captcha_refresh_button"').replace('<div class="verify-captcha-submit-button"', '<button type="button" class="cap-btn"').replace('>Confirm</div>', '>Confirm</button>')
  .replace('querySelector(".verify-captcha-submit-button")', 'querySelector(".cap-btn")').replace('querySelector(".captcha_verify_container")', 'querySelector("#captcha-verify-container-main-page")');
(async () => {
  await new Promise((r) => mock.listen(0, r));
  process.env.RELAY_PANEL = 'http://127.0.0.1:' + mock.address().port;
  process.env.AURA_CAPTCHA_VISION_MOCK = 'http://127.0.0.1:' + mock.address().port + '/vision';
  const solver = require('../captcha_solver');
  const st = require('../stealth');
  const ext = path.join(__dirname, '..', 'solver_ext');
  const ctx = await st.chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-cov-')), {
    headless: true, viewport: { width: 1280, height: 1000 }, args: [...st.STEALTH_ARGS, `--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  await ctx.route('**/*', (r) => {
    const u = r.request().url().split('#')[0]; const key = Object.keys(PAGES).find((k) => u.split('?')[0] === k);
    if (key) return r.fulfill({ status: 200, contentType: 'text/html', body: PAGES[key] });
    if (/^https:\/\/api\.hcaptcha\.com\/checkcaptcha\//.test(u)) { const pass = /pass=1/.test(u);
      return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(pass ? { c: {}, pass: true, generated_pass_UUID: 'P1_' + 'z'.repeat(30), expiration: 120 } : { c: {}, pass: false }) }); }
    if (/^https:\/\/(www\.google\.com|newassets\.hcaptcha\.com|challenges\.cloudflare\.com|geo\.captcha-delivery\.com|[^/]*\.test|careers-acme\.icims\.com)\//.test(u)) return r.fulfill({ status: 404, body: '' });
    return r.abort();
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const go = async (u, wait = 1200) => { await page.goto(u, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(wait); };
  const frameBy = (re) => page.frames().find((f) => re.test(f.url()));
  const want = (k) => !process.env.ONLY || process.env.ONLY.split(',').includes(k);
  let r, ids;

  // 1. reCAPTCHA 4×4 in a nested iframe — the right tiles, then verified
  if (want('recaptcha')) {
  await go('https://ats.test/recap', 2000);
  r = await solver.solveIfPresent(page, 2);
  const rcPicked = await (frameBy(/bframe/) || { evaluate: async () => null }).evaluate(() => window.__picked).catch(() => null);
  check('reCAPTCHA 4×4 (nested iframe): clicked exactly tiles 2, 7, 16', rcPicked === null ? r.solved : JSON.stringify(rcPicked) === '[2,7,16]', { rcPicked, r });
  check('reCAPTCHA 4×4: solved (checkbox ticked)', r.solved, r);
  check('reCAPTCHA prompt named the real 4×4 grid', calls.some((c) => /reCAPTCHA \(4×4\)/.test(c)), calls.slice(-3));
  }

  // 2. hCaptcha inside the iCIMS content iframe, header above the grid
  if (want('hcaptcha')) {
  await go('https://careers-acme.icims.com/jobs/1/apply', 2000);
  const det = require('../captcha_detect');
  const live = await det.detect(page);
  check('captcha_detect sees the hCaptcha nested in the iCIMS iframe', live.live === true, live);
  r = await solver.solveIfPresent(page, 2);
  const hcTok = await (frameBy(/icims\.com\/jobs\/1\/login/)).evaluate(() => document.querySelector('textarea').value);
  check('hCaptcha (iCIMS-nested, 110px header): token issued for tiles 1, 5, 9', hcTok.startsWith('P1_'), { hcTok, r });
  }

  // 2b. INVISIBLE hCaptcha (iCIMS): opened through hcaptcha.execute(), solved, the site's callback fired
  if (want('hcaptcha-inv')) {
  await go('https://careers-inv.icims.com/jobs/2/apply', 2000);
  r = await solver.solveIfPresent(page, 2);
  const inv = await (frameBy(/careers-inv\.icims\.com\/jobs\/2\/login/)).evaluate(() => ({ tok: document.querySelector('textarea').value, executed: window.__executed || 0, cb: !!window.__callback }));
  check('invisible hCaptcha (iCIMS sign-in): opened via execute(), solved, site callback fired', inv.tok.startsWith('P1_') && inv.executed >= 1 && inv.cb && r.solved, { inv, r });
  ids = await solver.identify(page);
  await go('https://careers-inv.icims.com/jobs/3/apply', 2000);
  ids = await solver.identify(page);
  check('unopened invisible hCaptcha is reported as "invisible" (the engine never fires it on its own)', ids.some((v) => v.vendor === 'hcaptcha' && v.kind === 'invisible'), ids);
  r = await solver.solveIfPresent(page, 1);
  const ex = await (frameBy(/careers-inv\.icims\.com\/jobs\/3\/login/)).evaluate(() => window.__executed || 0);
  check('invisible hCaptcha is NOT opened while the form has an empty box (no premature submit)', ex === 0 && !r.solved, { ex, r: r.type });
  }

  // 2d. LEVER invisible hCaptcha (Veeva 2026-10-17): the site's Submit opens it; first answer rejected and the challenge closes;
  // the solver re-opens it (= Submit again) despite an empty OPTIONAL box; the pass is read from hCaptcha's /checkcaptcha reply
  // because the site's callback consumes the token; the application is submitted exactly once
  if (want('hcaptcha-lever')) {
  await go('https://jobs.lever.test/acme/1/apply', 1500);
  await page.click('#sub'); await page.waitForTimeout(800);
  r = await solver.solveIfPresent(page, 3);
  const lv = await page.evaluate(() => ({ executed: window.__executed, submits: window.__submits }));
  check('Lever invisible hCaptcha: rejected once, re-opened, passed (server verdict), form submitted exactly once', r.solved && lv.executed === 2 && lv.submits === 1 && /hCaptcha server: pass/.test(r.how || ''), { lv, r: { solved: r.solved, type: r.type, how: r.how } });
  ids = await solver.identify(page);
  check('Lever: after the pass, identify reports nothing left to solve (no second submit)', !ids.some((v) => v.vendor === 'hcaptcha' && v.solvable), ids);
  }

  // 2d'. the vision model DECLINES (Waabi/Lever 2026-10-19: "I can't help with this one…"): stop at once, report it, no retries,
  // no reworded prompt; nothing submitted
  if (want('declined')) {
  declineVision = true;
  await go('https://jobs.lever.test/acme/1/apply', 1500);
  await page.click('#sub'); await page.waitForTimeout(800);
  const td = Date.now();
  r = await solver.solveIfPresent(page, 3);
  const dv = await page.evaluate(() => ({ executed: window.__executed, submits: window.__submits }));
  declineVision = false;
  check('vision declined: reported as declined after one attempt, nothing submitted, no retries', r.declined === true && !r.solved && r.attempts === 1 && dv.submits === 0 && dv.executed === 1 && /declined/.test(r.how || '') && Date.now() - td < 30000, { dv, r: { declined: r.declined, attempts: r.attempts, how: r.how }, secs: (Date.now() - td) / 1000 });
  }

  // 2e. ByteDance "select 2 objects with the same shape" in an iframe: wrong first pick → new layout → right pick → passed
  if (want('bytedance')) {
  await go('https://careers.tiktok.test/job/1/apply', 1500);
  ids = await solver.identify(page);
  check('identify: ByteDance select-objects inside an iframe', ids.some((v) => v.vendor === 'bytedance' && v.kind === 'select-objects'), ids);
  r = await solver.solveIfPresent(page, 2);
  const bd = await (frameBy(/verify\.tiktok\.test/)).evaluate(() => ({ passed: !!window.__bdPassed, fails: window.__bdFails }));
  check('ByteDance select-objects: clicked the matching pair, Confirm, retried after a wrong round, passed', r.solved && bd.passed && bd.fails === 1, { bd, r: { solved: r.solved, type: r.type, how: r.how } });
  bdCalls = 0;
  await go('https://careers.tiktok.test/job/2/apply', 1500);
  r = await solver.solveIfPresent(page, 2);
  const bd2 = await (frameBy(/captcha\/select2/)).evaluate(() => ({ passed: !!window.__bdPassed, fails: window.__bdFails }));
  check('ByteDance (newer TikTok layout, icon before the picture): passed', r.solved && bd2.passed, { bd2, r: { solved: r.solved, type: r.type, how: r.how } });
  check('ByteDance prompt carried the challenge title', calls.some((c) => /vision:ByteDance[\s\S]*same shape/.test(c)), calls.filter((c) => /ByteDance/.test(c)).slice(-1));
  }

  // 2c. false positives from the real queue (2026-10-16)
  if (want('false-positives')) {
  await go('https://ats.test/ashby-like', 1500);
  ids = await solver.identify(page);
  const det2 = require('../captcha_detect');
  const lv = await det2.detect(page);
  check('Ashby: hidden preloaded reCAPTCHA challenge is NOT a live CAPTCHA', !ids.some((v) => v.solvable) && !lv.live, { ids, lv });
  await go('https://ats.test/dayforce-like', 1500);
  ids = await solver.identify(page);
  check('Dayforce: full-size hidden reCAPTCHA challenge frame is NOT a live CAPTCHA', !ids.some((v) => v.vendor === 'recaptcha' && v.kind === 'challenge'), ids);
  await go('https://shop.test/ts-solved', 1500);
  ids = await solver.identify(page);
  check('Rippling: a solved Turnstile still on screen reports "solved", nothing solvable', ids.some((v) => v.vendor === 'turnstile' && v.kind === 'solved') && !ids.some((v) => v.solvable), ids);
  }

  // 3. Turnstile in a closed shadow root
  if (want('turnstile')) {
  await go('https://shop.test/ts', 1500);
  r = await solver.solveIfPresent(page, 2);
  const tsv = await page.evaluate(() => document.querySelector('[name=cf-turnstile-response]').value);
  check('Turnstile in a closed shadow root: found and clicked on its checkbox', tsv.length > 10 && r.solved, { tsv: tsv.slice(0, 12), r });
  }

  // 3b. Odoo-style hidden interaction-only Turnstile with no token: renewed through turnstile.reset()
  if (want('ts-hidden')) {
  await go('https://shop.test/ts-hidden', 1000);
  r = await solver.solveIfPresent(page, 2);
  const th = await page.evaluate(() => ({ tok: document.querySelector('[name=turnstile_captcha]').value.length, resets: window.__resets || 0 }));
  check('hidden interaction-only Turnstile (Odoo): fresh token via turnstile.reset()', th.tok > 10 && th.resets >= 1 && r.solved, { th, r: r.type });
  }

  // 3c. execute-mode Turnstile (Rippling-like): reset() yields nothing; turnstile.execute(<widget id>) does
  if (want('ts-exec')) {
  await go('https://shop.test/ts-exec', 1000);
  r = await solver.solveIfPresent(page, 1);
  const te = await page.evaluate(() => ({ tok: document.querySelector('[name=cf-turnstile-response]').value.length, execs: window.__execs || [] }));
  check('execute-mode Turnstile: token via turnstile.execute(widget id) after reset() gave none', te.tok > 10 && te.execs.includes('cf-chl-widget-abc12') && r.solved, { te, r: r.type });
  }

  // 4. Cloudflare interstitial clears by itself — not a wall
  if (want('cf')) {
  await go('https://shop.test/cf', 300);
  ids = await solver.identify(page);
  check('identify: "Just a moment…" is a solvable interstitial, not a wall', ids.some((v) => v.vendor === 'cloudflare' && v.kind === 'interstitial') && !solver.isWall(ids), ids);
  const cc = await solver.clearChallenge(page, { maxMs: 20000 });
  check('clearChallenge: the interstitial clears and the job page loads', cc.cleared && /\/job$/.test(page.url()), cc);
  }

  // 5. Akamai edge block — a wall, never solved
  if (want('akamai')) {
  await go('https://shop.test/akamai', 300);
  r = await solver.solveIfPresent(page, 1);
  check('Akamai "Access Denied / Reference #" is a wall (no solve attempted)', r.wall === true && !r.solved && /akamai/.test(r.vendorText), r);
  const cw = await solver.clearChallenge(page, { maxMs: 5000 });
  check('clearChallenge reports the wall at once', cw.wall === true, cw);
  }

  // 6. PerimeterX press & hold
  if (want('px')) {
  await go('https://shop.test/px', 500);
  r = await solver.solveIfPresent(page, 1);
  check('PerimeterX press-and-hold: held long enough, verified', r.solved && await page.evaluate(() => /verified/.test(document.body.innerText)), r);
  }

  // 7. Friendly Captcha proof of work
  if (want('frc')) {
  await go('https://shop.test/frc', 500);
  r = await solver.solveIfPresent(page, 1);
  check('Friendly Captcha: started and waited for the solution', r.solved && await page.evaluate(() => document.querySelector('[name=frc-captcha-solution]').value === 'abc.def.ghi'), r);
  }

  // 8. DataDome-style slider in its own frame
  if (want('dd')) {
  await go('https://shop.test/dd', 1200);
  r = await solver.solveIfPresent(page, 1);
  const moved = await (frameBy(/captcha-delivery/)).evaluate(() => window.__moved ?? (/passed/.test(document.body.innerText) ? 180 : null)).catch(() => null);
  check('DataDome slider (own frame): dragged the piece 180px into the slot', r.solved && Math.abs((moved ?? 999) - 180) <= 8, { moved, r });
  }

  // 9. arithmetic: recognised, never answered
  if (want('math')) {
  await go('https://shop.test/math', 300);
  r = await solver.solveIfPresent(page, 1);
  check('math CAPTCHA: identified, left unanswered (policy)', r.type === 'math-policy' && !r.solved && (await page.inputValue('#captcha')) === '', r);
  }

  // 10. reCAPTCHA v3 / invisible: nothing to click, not "unsolved"
  if (want('v3')) {
  await go('https://ats.test/recap-v3', 800);
  ids = await solver.identify(page);
  check('invisible reCAPTCHA identified as score-only (not solvable, no widget to click)', ids.some((v) => v.vendor === 'recaptcha' && v.kind === 'invisible' && !v.solvable), ids);
  }

  // 11. the application form itself is never touched (range slider, #checkbox, .check) — solver AND background extension
  if (want('form')) {
  await go('https://shop.test/form', 7500);   // the extension polls every 3 s
  r = await solver.solveIfPresent(page, 1);
  const form = await page.evaluate(() => ({ yrs: document.getElementById('yrs').value, cb: document.getElementById('checkbox').checked, clicks: window.__clicks }));
  check('form untouched: no CAPTCHA identified on a plain form', r.type === 'none' && !r.vendors.length, r);
  check('form untouched: range slider, consent checkbox and .check never clicked', form.yrs === '2' && !form.cb && form.clicks === 0, form);
  }

  // 12. text-image CAPTCHA — real vision model (SKIP_VLM=1 to skip)
  if (!process.env.SKIP_VLM && want('text')) {
    await go('https://shop.test/text', 500);
    r = await solver.solveIfPresent(page, 1);
    const typed = await page.inputValue('[name=captcha_code]');
    check('text-image CAPTCHA: OCR typed "X7K2P" into the answer box (not the Name field)', typed.toUpperCase() === 'X7K2P' && (await page.inputValue('[name=name]')) === 'Stanley', { typed, r });
  }

  await ctx.close(); mock.close();
  console.log(`\n${FAILS.length ? FAILS.length + ' FAILED' : 'ALL PASS'}`);
  process.exit(FAILS.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e.stack); process.exit(1); });
