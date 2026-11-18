/* Application control stays local. Nothing is queued or started on page load. */
(() => {
  'use strict';
  let panel, timer, state = null, busy = false, loading = false, previousFocus;
  const drafts = new Map();
  const queueRequests = new Set();
  const queueFeedback = new Map();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const local = () => ['localhost','127.0.0.1','::1','[::1]'].includes(location.hostname) && /^https?:$/.test(location.protocol);
  const date = value => { if (!value) return ''; const d = new Date(/Z$|[+-]\d\d:\d\d$/.test(value) ? value : value+'Z'); return Number.isNaN(d.valueOf()) ? '' : d.toLocaleTimeString(); };
  const retryTime = value => new Date(value).toLocaleString(undefined,{weekday:'short',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
  const label = value => String(value || 'idle').replaceAll('_',' ');
  const url = value => { if(!value) return null; try {const u = new URL(value,location.origin);return ['https:','http:'].includes(u.protocol) ? u.href : null;} catch {return null;} };
  const el = id => panel.querySelector('#'+id);
  const DISCIPLINES = {'PRODUCT / MECHANICAL DESIGN':'Mechanical design','HARDWARE / SYSTEMS':'Hardware & systems','MANUFACTURING / EQUIPMENT / AUTOMATION':'Manufacturing & automation','AEROSPACE / VEHICLE':'Aerospace & vehicle','ROBOTICS / MECHATRONICS':'Robotics','DATA / ENGINEERING ANALYTICS':'Data & analytics','TECHNICAL PROGRAM MANAGEMENT':'Program management','DATA SCIENCE / MACHINE LEARNING':'Data science & ML','ANALYTICS / BUSINESS INTELLIGENCE':'Analytics & BI','STATISTICS / QUANTITATIVE RESEARCH':'Statistics & quant','DATA ENGINEERING / ANALYTICS ENGINEERING':'Data & analytics engineering'};
  const chipsFor=list=>list.map(value=>`<button type="button" class="app-chip" data-discipline="${esc(value)}" aria-pressed="true">${esc(DISCIPLINES[value]||value)}</button>`).join('');
  // The title opens the employer's own posting in a new tab; the surrounding card keeps its controls.
  const postingLink=j=>/^https?:\/\//i.test(j.url||'')?`<a class="app-posting" href="${esc(j.url)}" target="_blank" rel="noopener noreferrer" title="Open the official application in a new tab">${esc(j.title||'Application')}</a>`:esc(j.title||'Application');
  const row = (n,j,meta,actions,cls='') => `<li class="app-track ${cls}"><span class="app-track-n">${n}</span><div class="app-track-main"><strong>${postingLink(j)}</strong><span>${esc(j.company||'')}${meta?` · ${esc(meta)}`:''}</span></div><div class="app-track-actions">${actions}</div></li>`;
  const button = (action,job,text,extra='') => `<button class="app-button small" data-action="${action}" data-job="${esc(job)}"${extra}>${text}</button>`;
  async function request(path, body, timeoutMs = 15000) {
    const track = window.UIFeedback?.track || (operation => operation());
    return track(async () => {
      if (!local()) throw new Error('Open the local dashboard to manage applications.');
      const headers = {'Content-Type':'application/json','X-JobAgent-Application':'1'};
      if (state?.csrf_token) headers['X-CSRF-Token'] = state.csrf_token;
      const response = await fetch('/api/applications'+path, {method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeoutMs)});
      const result = await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : `Application service returned ${response.status}.`);
      return result;
    }, {mutation: Boolean(body)});
  }
  function notice(message, error = false) {el('appNotice').textContent=message;el('appNotice').classList.toggle('error',error);el('appNotice').hidden=!message;}
  function init() {
    if (panel) return;
    panel = document.getElementById('applicationPanel') || document.createElement('section');
    panel.id='applicationPanel';panel.classList.remove('hidden');panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','appHeading');
    panel.innerHTML=`<div class="app-shell"><div class="app-heading"><div><h2 id="appHeading">Application Agent</h2><p class="app-muted">Agents resolve unfamiliar questions on every platform using your saved facts and approved answers. Follow each browser live. New questions go to <a href="/approvals" style="color:var(--accent)">Approvals</a> while workers move on to the next role.</p></div><button class="app-button" data-action="close" aria-label="Close Application Agent">Close</button></div>
      <div id="appNotice" class="app-notice" role="status" hidden></div><div id="appOffline" class="app-notice" hidden>Application controls require the local dashboard. <a href="http://127.0.0.1:8000/#applications" style="color:var(--accent)">Open local dashboard</a>. If it is unavailable, start JobAgent and retry.</div>
      <div id="appEngineStatus" class="app-notice" role="status" hidden></div><div class="app-toolbar"><div><div class="app-state" id="appState">Connecting…</div><p class="app-summary" id="appSummary">Checking application workers</p></div><div class="app-counts" id="appCounts"></div><button class="app-button" id="appCheckEngine" data-action="check-engine">Check sign-in</button></div>
      <div class="app-heading"><h3>Live progress</h3><button class="app-button" data-action="refresh">Refresh</button></div><p class="app-summary">One card per worker. New questions and sign-in checks go to Approvals while workers move on. Completed applications are submitted automatically.</p><div id="appWorkdayNotice" class="app-notice" hidden></div><div class="app-grid" id="appWorkers"></div><div id="appRecent"></div><section id="appBackgroundAgents" aria-label="Background Codex CLI agents"></section><h3>Up next</h3><p class="app-summary">Roles you queue go first, in your order. Autoplay skips companies with application limits or 5 or more open roles; choose specific postings on the Manual selection page. Use Play next or Add to queue on a listing.</p>
      <div class="app-autoplay"><label class="app-switch"><input type="checkbox" id="appAutoplay"><span>Autoplay from priority list</span></label><label class="app-switch"><input type="checkbox" id="appIncludeEligible"><span>Include “Meets requirements” roles</span></label><div class="app-chips" id="appDisciplines" role="group" aria-label="Disciplines autoplay may pick"></div></div>
      <form id="appImportForm" class="app-import" aria-label="Add a posting by link"><label class="app-import-url">Add a posting by link<input id="appImportUrl" type="url" required maxlength="2048" placeholder="https://… the employer's job posting" autocomplete="off"></label><label>Then<select id="appImportPosition" aria-label="What to do with it"><option value="end">Add to queue</option><option value="next">Play next</option><option value="only">Save only</option></select></label><button class="app-button primary" id="appImportSubmit" type="submit">Add</button><details class="app-import-more" id="appImportMore"><summary>Page didn't read right? Set the details yourself</summary><div class="app-import-fields"><label>Company<input id="appImportCompany" maxlength="255" autocomplete="off"></label><label>Title<input id="appImportTitle" maxlength="512" autocomplete="off"></label><label>Location (U.S.)<input id="appImportLocation" maxlength="512" placeholder="Santa Clara, CA" autocomplete="off"></label></div></details><p class="app-summary">JobAgent reads the page in a headless browser, stores the posting with the rules' verdict, marks it Good fit, and queues it in this order. Only confirmed U.S. locations are accepted. For Indeed or LinkedIn links, also enter the company and title so it can find the employer's own posting.</p></form>
      <div id="appQueue"></div></div>`;
    if (!panel.parentNode) document.body.append(panel);
    panel.addEventListener('click', onClick);
    panel.addEventListener('submit', onSubmit);
    panel.addEventListener('input', event => {const form=event.target.closest('[data-answer-job]');if(form) drafts.set(form.dataset.answerJob,readAnswers(form));});
    el('appDisciplines').innerHTML=Object.entries(DISCIPLINES).map(([value,name])=>`<button type="button" class="app-chip" data-discipline="${esc(value)}" aria-pressed="true">${esc(name)}</button>`).join('');
    el('appAutoplay').addEventListener('change',()=>mutate('/autoplay',{enabled:el('appAutoplay').checked},el('appAutoplay').checked?'Autoplay on. Workers continue down your priority list after your queue.':'Autoplay off. Workers only take roles you queue.'));
    el('appIncludeEligible').addEventListener('change',()=>mutate('/autoplay',{include_eligible:el('appIncludeEligible').checked},el('appIncludeEligible').checked?'Autoplay now also picks “Meets requirements” roles.':'Autoplay picks only strong matches.'));
    panel.addEventListener('keydown',event=>{if(event.key==='Escape') close();if(event.key==='Tab'){const nodes=[...panel.querySelectorAll('button:not(:disabled),a[href],input,select,textarea')].filter(n=>n.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}});
  }
  // Live previews: one event stream with every running worker's newest frame, open only while
  // the panel is. Each frame replaces that worker's preview image in place.
  let stream;
  function startLive(){
    if(stream||!local()||typeof EventSource==='undefined')return;
    stream=new EventSource('/api/applications/live');
    stream.addEventListener('frame',event=>{
      let frame;try{frame=JSON.parse(event.data);}catch{return;}
      const card=[...el('appWorkers').children].find(n=>n.dataset.worker===String(frame.id));if(!card)return;
      const image=card.querySelector('.app-preview img');if(!image)return;
      image.onload=null;image.onerror=null;image.src=`data:image/jpeg;base64,${frame.jpeg}`;image.hidden=false;
      card.querySelector('.app-preview-placeholder').hidden=true;card.dataset.liveAt=String(Date.now());
      card.querySelector('.app-preview-time').textContent='● Live · click the view to enlarge';
    });
  }
  function stopLive(){stream?.close();stream=null;}
  function close() {panel.hidden=true;clearTimeout(timer);stopLive();previousFocus?.focus();}
  async function open() {init();previousFocus=document.activeElement;panel.hidden=false;startLive();panel.querySelector('[data-action="close"]').focus();await refresh();}
  async function refresh() {
    if(loading || panel.hidden) return;
    clearTimeout(timer);loading=true;
    try {const [workers,background]=await Promise.all([request(''),request('/background-agents').catch(()=>null)]);state=workers;state.background_agents=background;el('appOffline').hidden=true;render();}
    catch(error){el('appOffline').hidden=false;notice(error.message,true);el('appState').textContent='Disconnected';el('appSummary').textContent='Worker status is unavailable';panel.querySelectorAll('.app-worker button').forEach(b=>b.disabled=true);}
    finally {loading=false;if(!panel.hidden) timer=setTimeout(refresh,2000);}
  }
  async function mutate(path,body,success) {
    if(busy) { window.UIFeedback?.notify('Another change is still being saved.'); return; }busy=true;
    try {await request(path,body);notice(success??(body.action==='approve'?'Submission requested. Waiting for employer confirmation.':'Changes saved.'));await refresh();}
    catch(error){notice(error.message,true);}finally{busy=false;}
  }
  function render() {
    el('appState').innerHTML=`<span class="app-dot ${state.running?'on':''}"></span>${state.stopping_after_current?'Finishing current postings':`Workers ${state.running?'ON':'OFF'}`}`;
    const engineName=[...new Set((state.slots||[]).map(sl=>sl.engine))].map(e=>state.engines?.[e]||e).join(' and ')||state.engines?.[state.engine]||'the agent';
    el('appSummary').textContent=state.configured===false?`Install and sign in to ${engineName} before workers can start.`:state.running?`Workers process your queued applications with ${engineName}. Model and worker controls are on the main dashboard.`:state.stopping_after_current?'Current postings will finish. No new applications will start.':'Manage worker start, stop, and auto-stop limits on the main dashboard.';
    const engineStatus=state.engine_status;const engineBlocked=Boolean(engineStatus?.status)&&engineStatus.status!=='ready';
    el('appEngineStatus').hidden=!engineStatus?.message;el('appEngineStatus').textContent=engineStatus?.message?`${engineStatus.message}${engineStatus.checked_at?` Checked ${date(engineStatus.checked_at)}.`:''}`:'';el('appEngineStatus').classList.toggle('error',engineBlocked);
    el('appCounts').innerHTML=['queued','active','approvals','awaiting_receipt','completed','failed'].map(k=>`<div><strong>${Number(state.counts?.[k]||0)}</strong><span>${esc(k==='completed'?'confirmed':label(k))}</span></div>`).join('');
    // One card per worker slot, in slot order, showing the live role or idle state.
    const workers=state.workers||[];
    const slots=state.slots||[];
    const cardFor=slot=>{const w=workers.find(x=>x.slot===slot.index);return w?String(w.id):`idle-${slot.index}`;};
    const order=[...slots.map(cardFor),...workers.filter(w=>!slots.some(sl=>sl.index===w.slot)).map(w=>String(w.id))];
    el('appWorkers').querySelector('.app-empty')?.remove();
    for(const child of [...el('appWorkers').children]) if(!order.includes(child.dataset.worker)) child.remove();
    for(const worker of workers) renderWorker(worker);
    for(const slot of slots){const id=cardFor(slot);if(id.startsWith('idle-')&&![...el('appWorkers').children].some(n=>n.dataset.worker===id)){const card=document.createElement('article');card.className='app-worker';card.dataset.worker=id;card.innerHTML=`<div class="app-worker-head"><strong class="worker-name"></strong><span class="app-status">idle</span></div><div class="app-preview"><div class="app-preview-placeholder"></div></div>`;el('appWorkers').append(card);}}
    for(const id of order){const card=[...el('appWorkers').children].find(n=>n.dataset.worker===id);if(card)el('appWorkers').append(card);}
    for(const slot of slots){
      const card=[...el('appWorkers').children].find(n=>n.dataset.worker===cardFor(slot));if(!card)continue;
      card.dataset.slot=String(slot.index);
      const w=workers.find(x=>x.slot===slot.index);
      card.querySelector('.worker-name').textContent=`Worker ${slot.index+1}`;
      // Which agy model is answering this worker's steps: in place of Claude/Codex at their limit, or as its chosen engine.
      if(!w)card.querySelector('.app-preview-placeholder').textContent=state.running?'Waiting for the next role in Up next':'Idle · start workers to begin';
    }
    if(!slots.length&&!workers.length) el('appWorkers').innerHTML='<p class="app-empty">No workers are running. Start workers to work through Up next.</p>';
    el('appWorkdayNotice').hidden=state.workday_password_set!==false;
    el('appWorkdayNotice').textContent='Workday roles are skipped until your Workday password is saved. Open ~/application-agent/private/workday.env, put your password after WORKDAY_PASSWORD=, and save. Roles that stopped for it go back in the queue on their own.';
    const background=state.background_agents;
    el('appBackgroundAgents').innerHTML=background?`<h3>Background agents · ${Number(background.active)||0} working</h3><p class="app-summary">Agent sessions investigate Help and prepare Approvals. Up to ${Number(background.limit)||0} run together. New writing and unknown personal facts stay for your review.</p>${background.agents?.length?`<ul class="app-upnext">${background.agents.map(agent=>`<li class="app-track"><div class="app-track-main"><strong>${esc(agent.company)} · ${postingLink(agent)}</strong><span>${esc(agent.engine)} · ${agent.category==='approval'?'Approval preparation':'Help repair'} · working</span></div><a class="app-button small" href="${agent.category==='approval'?'/approvals':`/help?job=${encodeURIComponent(agent.job_id)}`}">View</a></li>`).join('')}</ul>`:'<p class="app-summary">No background agent is running. New actionable items are assigned automatically.</p>'}`:'';
    if(background?.waiting?.length) el('appBackgroundAgents').innerHTML+=`<details><summary class="app-summary">Approval reviews · ${background.waiting.length} waiting</summary><ul class="app-upnext">${background.waiting.map(item=>`<li class="app-track"><div class="app-track-main"><strong>${esc(item.company)}${item.title?` · ${postingLink(item)}`:''}</strong><span>${esc(({needs_user:'Needs your answer',review_ready:'Draft ready for your review',queued:'Queued for an agent',technical:'Queued for form diagnosis',draft_needed:'Queued for a writing draft',running:'Agent reviewing'})[item.state]||item.state)}</span></div></li>`).join('')}</ul></details>`;
    const recent=state.recent||[];
    const parkedStatus=new Set(['needs_approval','ready_to_submit','needs_verification']);const helpStatus=new Set(['needs_human','blocked','failed','interrupted','submission_unknown']);
    el('appRecent').innerHTML=recent.length?`<div class="app-heading" style="margin-top:18px"><h3>Recent</h3><button class="app-button small" data-action="recent-clear">Clear all</button></div><ol class="app-upnext">${recent.map(r=>`<li class="app-track"><div class="app-track-main"><strong>${postingLink(r)}</strong><span>${esc(r.company||'')} · ${esc(label(r.status))}${r.message?` · ${esc(String(r.message).slice(0,140))}`:''}</span></div><div class="app-track-actions">${parkedStatus.has(r.status)?'<a class="app-button small" href="/approvals" style="text-decoration:none">Approvals →</a>':helpStatus.has(r.status)?`<a class="app-button small" href="/help?job=${esc(r.job_id)}" style="text-decoration:none">Get help →</a>`:r.status==='stopped'?button('retry',r.job_id,'Retry'):''}<button class="app-button small" data-action="recent-dismiss" data-job="${esc(r.job_id)}" aria-label="Dismiss from Recent">Dismiss</button></div></li>`).join('')}</ol>`:'';
    const queue=state.queue||[];
    if(state.running) el('appSummary').textContent=`${state.counts?.active||0} workers active · current capacity ${state.adaptive?.effective??state.parallelism} of ${state.parallelism} · ${state.counts?.ready||0} queued roles ready${state.adaptive?.reason?' · '+state.adaptive.reason:''}.`;
    const autoplay=state.autoplay||{enabled:false,disciplines:[]};const upNext=state.up_next||[];
    if(document.activeElement!==el('appAutoplay')) el('appAutoplay').checked=Boolean(autoplay.enabled);
    if(document.activeElement!==el('appIncludeEligible')) el('appIncludeEligible').checked=Boolean(autoplay.include_eligible);
    // The chips follow the active search track's disciplines.
    const offered=state.disciplines||Object.keys(DISCIPLINES);
    if(el('appDisciplines').dataset.offered!==offered.join('|')){el('appDisciplines').innerHTML=chipsFor(offered);el('appDisciplines').dataset.offered=offered.join('|');}
    panel.querySelectorAll('[data-discipline]').forEach(chip=>chip.setAttribute('aria-pressed',String((autoplay.disciplines||[]).includes(chip.dataset.discipline))));
    panel.querySelectorAll('.app-autoplay input:not(#appAutoplay),[data-discipline]').forEach(c=>c.disabled=!autoplay.enabled);
    const mine=queue.map((j,i)=>row(i+1,j,Date.parse(j.not_before)>Date.now()?`Waiting to retry until ${retryTime(j.not_before)} · ${j.message||'Employer site temporarily unavailable'}`:`Ready to start${j.message&&j.message!=='Waiting to start'?' · '+j.message:''}`,`${button('move',j.job_id,'Top',` data-index="0" data-top="1" aria-label="Move to the top of the queue" title="Start this one first"`)}${button('move',j.job_id,'↑',` data-index="${i-1}" aria-label="Move up"`)}${button('move',j.job_id,'↓',` data-index="${i+1}" aria-label="Move down"`)}${button('job-stop',j.job_id,'Remove')}`)).join('');
    const auto=autoplay.enabled?upNext.map((j,i)=>row(queue.length+i+1,j,[`Priority ${j.priority}`,DISCIPLINES[j.discipline]||j.discipline,j.eligibility==='ELIGIBLE'?'Meets requirements':'Strong match',...(j.platform?[`${j.platform}${j.platform_rate!=null?` ${Math.round(j.platform_rate*100)}% submitted`:''}`]:[])].join(' · '),`${button('play-next',j.job_id,'Play next')}${button('skip',j.job_id,'Skip')}`,'auto')).join(''):'';
    const autoHeading=autoplay.enabled?(upNext.length?`<li class="app-track-heading">${queue.length?'Then from your priority list':'From your priority list'}</li>`:`<li class="app-track-heading">${(autoplay.disciplines||[]).length?`No ready autoplay roles under the current filters. ${autoplay.include_eligible?'Strong match and Meets requirements roles are enabled.':'Only Strong match roles are enabled; turn on Meets requirements to widen the pool.'} Previously attempted roles, employer limits, retry delays and unresolved sign-ins are excluded. New candidates must pass the fit review.`:'Choose at least one discipline for autoplay.'}</li>`):'';
    // Platform submit rates set autoplay's order; low-yield platforms are left to him (roles he queues still run).
    const py=state.platform_yield;const heldNames=py?py.platforms.filter(p=>p.held).map(p=>esc(p.label)):[];
    const yieldLine=py&&autoplay.enabled?`<p class="app-summary">Platform submit rates, last ${esc(py.window_days)} days (${esc(py.min_jobs)}+ postings to count): ${py.platforms.filter(p=>p.jobs).map(p=>`${esc(p.label)} ${p.rate==null?'–':Math.round(p.rate*100)+'%'} of ${esc(p.jobs)}${p.held?' (held)':p.neutral?' (too few)':''}`).join(' · ')}.${heldNames.length?` Autoplay leaves ${heldNames.join(', ')} to you; queue a role there yourself to apply.`:''}</p>`:'';
    const yours=state.apply_yourself||[];
    const applyYourself=yours.length?`<h3 style="margin-top:18px">Apply yourself</h3><p class="app-summary">These sites refuse the worker's browser, so the postings are yours to submit. Each keeps the resume tailored for it.</p><ol class="app-upnext">${yours.map(e=>`<li class="app-track"><div class="app-track-main"><strong>${postingLink(e)}</strong><span>${esc(e.company||'')} · ${esc(e.reason||'')}</span></div><div class="app-track-actions"><button type="button" class="app-button small primary" data-action="fill-yourself" data-job="${esc(e.job_id)}" title="Opens a visible Chrome, fills everything the agent can, and leaves the rest and Submit to you">Fill in my Chrome</button><a class="app-button small" href="/api/applications/apply-yourself/${encodeURIComponent(e.job_id)}/resume.pdf" target="_blank" rel="noopener noreferrer" style="text-decoration:none">Resume</a></div></li>`).join('')}</ol>`:'';
    el('appQueue').innerHTML=(queue.length||autoplay.enabled?`<ol class="app-upnext">${queue.length?'<li class="app-track-heading">Next in your queue</li>':''}${mine}${autoHeading}${auto}</ol>`:'<p class="app-empty">Nothing queued and autoplay is off. Use Play next or Add to queue on a listing, or turn on autoplay.</p>')+yieldLine+applyYourself;
    panel.querySelectorAll('.app-upnext [data-action="move"]').forEach(b=>{const i=Number(b.dataset.index);b.disabled=i<0||i>=queue.length||(b.dataset.top&&queue[0]?.job_id===Number(b.dataset.job));});
  }
  function renderWorker(w) {
    let card=[...el('appWorkers').children].find(n=>n.dataset.worker===String(w.id));
    if(!card){card=document.createElement('article');card.className='app-worker';card.dataset.worker=String(w.id);card.innerHTML='<div class="app-worker-head"><strong class="worker-name"></strong><span class="app-status"></span></div><div class="app-preview"><img hidden alt="Live application browser preview"><div class="app-preview-placeholder"></div></div><p class="app-preview-time"></p><div class="app-worker-body"><div class="app-role"></div><div class="app-company"></div><p class="app-muted worker-message"></p><div class="app-actions worker-actions"></div><div class="worker-questions"></div><div class="worker-review"></div><ul class="app-events"></ul></div>';el('appWorkers').append(card);}
    const q=s=>card.querySelector(s);q('.worker-name').textContent=`Worker ${(w.slot??0)+1}`;q('.app-status').textContent=`${label(w.phase||w.status)}${w.engine?` · ${state.engines?.[w.engine]||w.engine}${w.adapter==='workday'?' · Workday':''}`:''}`;if(/^https?:\/\//i.test(w.url||'')&&w.title)q('.app-role').innerHTML=`<a class="app-posting" href="${esc(w.url)}" target="_blank" rel="noopener noreferrer" title="Open the official application in a new tab">${esc(w.title)}</a>`;else q('.app-role').textContent=w.title||'Waiting for a role';q('.app-company').textContent=w.company||'';q('.worker-message').textContent=w.message||'';
    const terminal=['failed','interrupted','stopped','submitted_pending_receipt','submission_unknown','completed','submitted'].includes(w.status);const idle=!w.job_id||['idle','stopped'].includes(w.status);const image=q('img');const previewURL=url(w.screenshot_url);
    const imageAllowed=previewURL&&new URL(previewURL).origin===location.origin&&!idle;
    q('.app-preview-placeholder').textContent=idle?'Idle · waiting for a job':'Waiting for a browser preview';
    const streaming=Date.now()-Number(card.dataset.liveAt||0)<5000;
    if(streaming){/* the live stream owns this preview */}
    else if(imageAllowed){const next=new URL(previewURL);next.searchParams.set('_preview',String(terminal?w.updated_at||Date.now():Date.now()));image.onerror=()=>{image.hidden=true;q('.app-preview-placeholder').hidden=false;};image.onload=()=>{image.hidden=false;q('.app-preview-placeholder').hidden=true;};if(image.src!==next.href)image.src=next.href;}
    else {image.onload=null;image.onerror=null;image.hidden=true;image.removeAttribute('src');q('.app-preview-placeholder').hidden=false;}
    q('.app-preview-time').textContent=streaming?'● Live · click the view to enlarge':idle?'No active browser':w.updated_at?`${terminal?'Last browser preview · worker ended':'Last worker update'} ${date(w.updated_at)}`:'Preview timestamp unavailable';
    const employerURL=url(w.url);
    const retryable=w.job_id&&['failed','stopped'].includes(w.status)&&!w.submitted&&!w.submission_attempted;
    const parked=['needs_approval','ready_to_submit','needs_verification'].includes(w.status);const stuck=['blocked','needs_human'].includes(w.status);
    q('.worker-actions').innerHTML=parked?`<a href="/approvals">Open in Approvals →</a>`:stuck?`<a href="/help?job=${esc(w.job_id)}">Get help →</a>`:retryable?`<button class="app-button" data-action="retry" data-job="${esc(w.job_id)}">Retry preparation</button>`:w.job_id&&!terminal?`${employerURL?`<a href="${esc(employerURL)}" target="_blank" rel="noopener noreferrer">Employer page ↗</a>`:''}${w.status==='needs_human'?`<button class="app-button primary" data-action="resume" data-job="${esc(w.job_id)}">I’m done — continue</button>`:''}${w.status==='needs_human'?`<button class="app-button" data-action="open_browser" data-job="${esc(w.job_id)}">Open browser</button>`:''}<button class="app-button" data-action="job-stop" data-job="${esc(w.job_id)}">Stop this role</button>`:'';
    const questions=w.questions||[],signature=JSON.stringify([w.job_id,questions]);
    const questionHost=q('.worker-questions');
    if(questionHost.dataset.signature!==signature&&!questionHost.contains(document.activeElement)){questionHost.dataset.signature=signature;questionHost.innerHTML=questions.length?questionForm(w.job_id,questions):'';}
    const review=w.review;const reviewHost=q('.worker-review');const reviewSignature=JSON.stringify([w.job_id,review]);
    if(reviewHost.dataset.signature!==reviewSignature){reviewHost.dataset.signature=reviewSignature;reviewHost.innerHTML=review?`<div class="app-review"><strong>Submitting automatically</strong><p class="app-summary">Validated answers below are submitted without another approval.</p><dl>${(review.answers||[]).map(a=>`<dt>${esc(a.label)}</dt><dd>${esc(a.value)}</dd>`).join('')}</dl></div>`:'';}
    q('.app-events').innerHTML=(w.events||[]).slice(-8).reverse().map(e=>`<li><time>${esc(date(e.time||e.created_at))}</time>${esc(e.message)}</li>`).join('');
  }
  function questionForm(job,questions) {
    const saved=drafts.get(String(job))||{};
    return `<form class="app-form" data-answer-job="${esc(job)}"><h4>Your answer is needed</h4><p class="app-muted">The worker will continue after you save these answers.</p>${questions.map((q,i)=>{const id=`app-answer-${job}-${i}`,name=esc(q.id),value=saved[q.id]??q.value??'',required=q.required?' required':'';const options=(q.options||[]).map(o=>typeof o==='object'?{value:o.value??o.label,label:o.label??o.value}:{value:o,label:o});let field;if(options.length)field=`<select id="${id}" name="${name}"${required}><option value="">Choose an answer</option>${options.map(o=>`<option value="${esc(o.value)}"${String(o.value)===String(value)?' selected':''}>${esc(o.label)}</option>`).join('')}</select>`;else if(q.type==='checkbox')field=`<input id="${id}" name="${name}" type="checkbox"${value===true?' checked':''}${required}>`;else if(q.type==='textarea')field=`<textarea id="${id}" name="${name}"${required}>${esc(value)}</textarea>`;else field=`<input id="${id}" name="${name}" type="${['email','number','date','tel','url'].includes(q.type)?q.type:'text'}" value="${esc(value)}"${required}>`;return `<label for="${id}">${esc(q.label)}${q.required?' *':''}</label>${field}`;}).join('')}<button class="app-button primary" type="submit">Save answers &amp; continue</button></form>`;
  }
  function readAnswers(form){const answers={};for(const field of form.querySelectorAll('[name]'))answers[field.name]=field.type==='checkbox'?field.checked:field.value;return answers;}
  async function checkEngine(){if(busy){window.UIFeedback?.notify('Another change is still being saved.');return;}busy=true;el('appCheckEngine').disabled=true;el('appCheckEngine').textContent='Checking…';let label='Check sign-in';try{const result=await request('/check-engine',{});label=result.status==='ready'?'✓ Signed in':'✗ Not ready';notice(result.status==='ready'?'':result.message,true);await refresh();}catch(error){notice(error.message,true);}finally{busy=false;el('appCheckEngine').disabled=false;el('appCheckEngine').textContent=label;setTimeout(()=>{if(el('appCheckEngine').textContent===label)el('appCheckEngine').textContent='Check sign-in';},4000);}}
  async function onSubmit(event){if(event.target.id==='appImportForm'){event.preventDefault();await importLink();return;}const form=event.target.closest('[data-answer-job]');if(!form)return;event.preventDefault();mutate(`/jobs/${encodeURIComponent(form.dataset.answerJob)}/command`,{action:'answer',answers:readAnswers(form)});}
  function onClick(event){const preview=event.target.closest('.app-worker .app-preview');if(preview&&!event.target.closest('button,a')){preview.closest('.app-worker').classList.toggle('expanded');return;}const button=event.target.closest('[data-action],[data-discipline],[data-view-import-job]');if(!button)return;if(button.dataset.viewImportJob){const jobId=Number(button.dataset.viewImportJob);close();window.openDetail?.(jobId);return;}const action=button.dataset.action;if(!action&&!button.dataset.discipline)return;if(action==='close')close();else if(action==='refresh')refresh();else if(action==='check-engine')checkEngine();else if(action==='retry-limits')mutate('/retry-engine-limits',{},'Limit pause cleared. Start workers to retry; another limit response will pause them again.');else if(action==='move')mutate(`/jobs/${encodeURIComponent(button.dataset.job)}/move`,{index:Number(button.dataset.index)},'Queue reordered.');else if(action==='play-next')mutate('/queue',{job_ids:[Number(button.dataset.job)],position:'next'},'Moved to the front of your queue.');else if(action==='fill-yourself')mutate(`/apply-yourself/${encodeURIComponent(button.dataset.job)}/fill`,{},'Opening Chrome: the agent fills what it can, then you finish and press Submit.');else if(action==='recent-dismiss')mutate(`/recent/${encodeURIComponent(button.dataset.job)}/dismiss`,{},'Removed from Recent.');else if(action==='recent-clear')mutate('/recent/clear',{},'Recent cleared.');else if(action==='skip')mutate(`/jobs/${encodeURIComponent(button.dataset.job)}/skip`,{},'Skipped. Autoplay will not take that role.');else if(button.dataset.discipline){const on=[...panel.querySelectorAll('[data-discipline]')].filter(c=>c===button?c.getAttribute('aria-pressed')!=='true':c.getAttribute('aria-pressed')==='true').map(c=>c.dataset.discipline);button.setAttribute('aria-pressed',String(on.includes(button.dataset.discipline)));mutate('/autoplay',{disciplines:on},`Autoplay picks from ${on.length} discipline${on.length===1?'':'s'}.`);}else if(['start','stop'].includes(action)){const queued=Number(state?.counts?.queued||0);mutate('/control',{action,parallelism:Number(state?.parallelism||1)},action==='stop'?'Stopping after current postings finish. No new applications will start.':queued?`Workers started. ${queued} queued role${queued===1?'':'s'} will open shortly${state?.autoplay?.enabled?', then autoplay continues down your priority list':''}.`:state?.autoplay?.enabled&&state?.up_next?.length?`Workers started on your priority list, beginning with ${state.up_next[0].title} at ${state.up_next[0].company}.`:'Workers are on, but nothing is queued and autoplay has nothing to pick. Queue a role or widen the autoplay disciplines.');}else mutate(`/jobs/${encodeURIComponent(button.dataset.job)}/command`,{action:action==='job-stop'?'stop':action,...(action==='approve'?{review_id:button.dataset.review}:{})});}
  // A pasted posting link: the server reads the page, stores the posting and queues it, which takes a while.
  async function importLink(){
    if(busy){window.UIFeedback?.notify('Another change is still being saved.');return;}
    const mode=el('appImportPosition').value, submit=el('appImportSubmit');
    const body={url:el('appImportUrl').value.trim(),company:el('appImportCompany').value.trim()||null,title:el('appImportTitle').value.trim()||null,location:el('appImportLocation').value.trim()||null,queue:mode!=='only',position:mode==='next'?'next':'end'};
    busy=true;submit.disabled=true;submit.textContent='Reading page…';submit.setAttribute('aria-busy','true');
    try{
      const r=await request('/import',body,180000);
      const where=r.queued?(body.position==='next'?' and queued to play next':' and added to your queue'):r.already_queued?' (already in your queue)':r.queue_error?`, but not queued: ${r.queue_error}`:r.warning?`. ${r.warning}`:'';
      notice(`${r.new?'Added':'Updated'} ${r.title} at ${r.company} (${r.location||'location unknown'})${where}.`,Boolean(r.queue_error||r.warning));
      if(!r.queued&&!r.already_queued&&r.job_id){const view=document.createElement('button');view.type='button';view.className='app-button small';view.dataset.viewImportJob=String(r.job_id);view.textContent='View saved posting';el('appNotice').append(document.createTextNode(' '),view);}
      el('appImportUrl').value='';for(const id of ['appImportCompany','appImportTitle','appImportLocation'])el(id).value='';el('appImportMore').open=false;
      window.loadJobs?.();await refresh();
    }catch(error){notice(error.message,true);if(/company|title|location/i.test(error.message))el('appImportMore').open=true;}
    finally{busy=false;submit.disabled=false;submit.textContent='Add';submit.removeAttribute('aria-busy');}
  }
  window.initApplications=init;window.openApplications=open;
  // Queueing from a listing never opens the panel, like adding a track to Up Next.
  function renderQueueButton(button, jobId, position) {
    button.dataset.queueJob=String(jobId);button.dataset.queuePosition=position;
    button.dataset.queueLabel ||= button.textContent;
    const feedback=queueFeedback.get(Number(jobId));
    const pending=feedback?.status==='pending';
    button.disabled=pending||Boolean(button.dataset.queueUnavailable);
    if(pending){button.textContent='Queueing…';button.setAttribute('aria-busy','true');}
    else{
      button.removeAttribute('aria-busy');
      button.textContent=feedback?.status==='queued'?(position==='next'?(feedback.position==='next'?'Plays next ✓':button.dataset.queueLabel):'Queued ✓'):button.dataset.queueLabel;
    }
  }
  function setQueueFeedback(jobId, feedback) {
    queueFeedback.set(Number(jobId),feedback);
    for(const button of document.querySelectorAll(`[data-queue-job="${Number(jobId)}"]`))renderQueueButton(button,jobId,button.dataset.queuePosition);
    for(const status of document.querySelectorAll(`[data-queue-status="${Number(jobId)}"]`)){
      status.textContent=feedback.message;status.dataset.unavailable='false';status.dataset.error=String(feedback.status==='error');
    }
  }
  window.renderQueueButton=renderQueueButton;
  window.getQueueFeedback=jobId=>queueFeedback.get(Number(jobId));
  // markFit: the rules rated this posting below eligible, so queueing it also records his Good fit label.
  window.queueApplication=async(jobId,position='end',button,markFit=false)=>{
    const id=Number(jobId);
    // Older open detail pages called this function without passing their button.
    if(!button){const detail=document.getElementById('btnQueueApplication');if(detail?.dataset.queueJob===String(id))button=detail;}
    if(queueRequests.has(id)){window.showToast('This application is already being queued.');return;}
    queueRequests.add(id);
    if(button)renderQueueButton(button,id,position);
    setQueueFeedback(id,{status:'pending',position,message:'Adding to your application queue…'});
    try{
      const result=await request('/queue',{job_ids:[id],position,...(markFit?{mark_fit:true}:{})});
      const labeled=Boolean(result.labeled?.includes(id));
      const message=result.apply_yourself?.includes(id)?result.message:result.added?`${labeled?'Marked Good fit and ':'Application '}${position==='next'?'queued to play next.':'added to your queue.'}`:'Application is already queued or in progress.';
      setQueueFeedback(id,{status:'queued',position,message});
      window.showToast(message);
      if(panel&&!panel.hidden)await refresh();
      return result;
    }catch(error){
      const message=`Could not confirm queueing: ${error.message}`;
      setQueueFeedback(id,{status:'error',position,message});
      window.showToast(message,'error');
      return null;
    }finally{queueRequests.delete(id);}
  };
  // The header badge counts what is waiting on Approvals, whether or not this panel is open.
  async function pollApprovals(){
    if(!local())return;
    try{const [{approvals},{items}]=await Promise.all([request('/approvals'),request('/help')]);
      for(const [id,countId,n,name] of [['approvalsBtn','approvalsCount',approvals.length,'Approvals'],['helpBtn','helpCount',items.length,'Needs help']]){const button=document.getElementById(id);if(!button)continue;button.classList.remove('hidden');document.getElementById(countId).textContent=n?String(n):'';document.getElementById(countId).hidden=!n;button.setAttribute('aria-label',n?`${name}, ${n} waiting`:name);}}
    catch{}finally{setTimeout(pollApprovals,8000);}
  }
  function ready(){init();pollApprovals();if(location.hash==='#applications')open();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready);else ready();
})();
