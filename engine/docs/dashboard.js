/* Shared by the live dashboard and the exported snapshot. */
let currentTab = 'top_priority', allJobs = [], activeJob = null;
const selectedJobs = new Set(); // postings ticked in the list
let searchDebounceTimeout, requestVersion = 0, detailVersion = 0, totalJobs = 0;
let connected = false, scanning = false, scanTimer = null, statsSignature = '';
let autoPerformanceAttempts = [], performancePeriod = 'all';
let selectedCompanyFilter = [], companyChoices = [];
// History tabs ignore the apply-company selection (matches HISTORY_TABS in dashboard.py).
const historyTabs = new Set(['applied','interview','offer','rejected','withdrawn','closed','ignored']);
const snapshot = window.JOBAGENT_STATIC_DATA;
const backend = snapshot ? 'http://127.0.0.1:8000' : '';
const applicationExport = document.getElementById('exportApplicationsBtn');
if (applicationExport) {
  applicationExport.href = snapshot ? backend + '/?export=applications' : '/api/applications/export.csv';
  if (snapshot) { applicationExport.removeAttribute('download'); applicationExport.target='_blank'; applicationExport.rel='noopener'; }
  const exportURL = new URL(location.href);
  if (!snapshot && exportURL.searchParams.get('export') === 'applications') {
    exportURL.searchParams.delete('export'); history.replaceState(null,'',exportURL);
    setTimeout(()=>applicationExport.click(),0);
  }
}
const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeURL = value => { try { const u = new URL(value); return ['http:','https:'].includes(u.protocol) ? u.href : '#'; } catch { return '#'; } };
const pipeline = new Set(['APPLIED','INTERVIEW','OFFER','REJECTED','WITHDRAWN']);

function localMonthKey(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`; }
function renderAutoPerformance(records) {
  autoPerformanceAttempts = Array.isArray(records) ? records : [];
  const month = $('performanceMonth');
  const months = [...new Set(autoPerformanceAttempts.map(row => {
    const d = new Date(row.started_at || ''); return Number.isNaN(d.valueOf()) ? null : localMonthKey(d);
  }).filter(Boolean))].sort().reverse();
  const oldMonth = month.value;
  month.replaceChildren(...months.map(key => { const option=document.createElement('option');option.value=key;option.textContent=new Date(`${key}-01T12:00:00`).toLocaleDateString([], {month:'long',year:'numeric'});return option; }));
  if (months.includes(oldMonth)) month.value=oldMonth;
  else if (months.length) month.value=months[0];
  const now = new Date(), today = new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const week = new Date(today); week.setDate(today.getDate() - ((today.getDay()+6)%7));
  const thisMonth = new Date(now.getFullYear(),now.getMonth(),1);
  const periodRows = autoPerformanceAttempts.filter(row => {
    if(row.counts_as_attempt===false)return false;
    const date=new Date(row.started_at || '');if(Number.isNaN(date.valueOf()))return false;
    if(performancePeriod==='today')return date>=today;
    if(performancePeriod==='week')return date>=week;
    if(performancePeriod==='month')return date>=thisMonth;
    if(performancePeriod==='by-month')return localMonthKey(date)===month.value;
    return true;
  });
  const attempts=periodRows.length, submitted=periodRows.filter(row=>row.fully_automatic_submission===true).length;
  const unverified=periodRows.filter(row=>row.tracked_from_launch!==true&&row.fully_automatic_submission!==true).length;
  const rate=attempts?Math.round(100*submitted/attempts):null;
  $('performancePeriodLabel').textContent=`(${performancePeriod==='all'?'all time':performancePeriod==='month'?'this month':performancePeriod==='week'?'this week':performancePeriod==='today'?'today':month.options[month.selectedIndex]?.textContent||'by month'})`;
  $('performanceMonth').hidden=performancePeriod!=='by-month';
  document.querySelectorAll('#performancePeriods [data-period]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.period===performancePeriod)));
  $('performanceRate').textContent=rate===null?'—':`${rate}%`;
  $('performanceSubmitted').textContent=String(submitted);
  $('performanceAttempts').textContent=String(attempts);
  $('performanceMeterFill').style.width=`${rate??0}%`;
  $('performanceRateCaption').textContent=attempts?`No-help automatic submissions ÷ all attempts${unverified?` · ${unverified} older attempts unverified`:''}`:'No application attempts in this period';
}

document.getElementById('performancePeriods')?.addEventListener('click',event=>{
  const button=event.target.closest('[data-period]');if(!button)return;
  performancePeriod=button.dataset.period;renderAutoPerformance(autoPerformanceAttempts);
});
document.getElementById('performanceMonth')?.addEventListener('change',()=>renderAutoPerformance(autoPerformanceAttempts));

const agentControls=$('agentControls');
if(agentControls){
  if(snapshot) agentControls.hidden=true;
  else {
    let workerBusy=false, workerDirty=false;
    const agentRequest=async(path,body)=>{
      const response=await fetch('/api/applications'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-JobAgent-Application':'1'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
      const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:`Dashboard returned ${response.status}`);return data;
    };
    const setAgentStatus=(message,error=false)=>{const node=$('agentControlStatus');node.textContent=message;node.style.color=error?'#fca5a5':'';};
    const setWorkerStatus=(message,error=false)=>{const node=$('workerControlStatus');node.textContent=message;node.style.color=error?'#fca5a5':'';};
    const renderWorkerState=data=>{
      const active=Number(data.counts?.active||0),queued=Number(data.counts?.queued||0),approvals=Number(data.counts?.approvals||0),help=Number(data.counts?.help||0);
      $('workerState').textContent=data.stopping_after_current?'Finishing current postings':`Workers ${data.running?'ON':'OFF'} · ${active} active`;
      $('workerSummary').textContent=`${queued} queued · ${approvals} approvals · ${help} need help · capacity ${data.adaptive?.effective??data.parallelism} of ${data.parallelism}${data.adaptive?.reason?` · ${data.adaptive.reason}`:''}`;
      const engineBlocked=Boolean(data.engine_status?.status)&&data.engine_status.status!=='ready';
      const startBlocked=data.running||data.configured===false||engineBlocked||Boolean(data.auto_stop_blocked);
      $('workerStart').disabled=Boolean(startBlocked)||workerBusy;
      $('workerStop').disabled=!data.running||workerBusy;
      $('workerStop').textContent=data.stopping_after_current?'Stopping after current postings':'Stop workers';
      $('workerStop').title='Finish current postings. No new applications will start.';
      $('workerRetryLimits').hidden=data.engine_status?.status!=='usage_limited';
      $('workerRetryLimits').disabled=workerBusy;
      if(!workerDirty){
        $('workerApprovalLimit').value=String(data.auto_stop?.approvals||10);
        $('workerHelpLimit').value=String(data.auto_stop?.help||10);
        $('workerApprovalEnabled').checked=Boolean(data.auto_stop?.approvals);
        $('workerHelpEnabled').checked=Boolean(data.auto_stop?.help);
        $('workerApprovalLimit').disabled=!$('workerApprovalEnabled').checked;
        $('workerHelpLimit').disabled=!$('workerHelpEnabled').checked;
      }
      const message=data.auto_stop_reason||(data.auto_stop_blocked?`${data.auto_stop_blocked}. Clear the backlog or raise the auto-stop limits before starting.`:data.configured===false?data.engine_status?.message||'Set up and sign in to an application engine before starting workers.':engineBlocked?data.engine_status?.message||'The application engine is not ready.':'');
      setWorkerStatus(message||'Auto-stop limits apply to the combined Approvals and Needs help backlogs.');
      // Sites held after repeated identical failures (failure_signatures.py), each with its own Resume.
      const breakers=data.breakers||[];$('workerBreakers').hidden=!breakers.length;
      $('workerBreakers').innerHTML=breakers.map(b=>`<div class="breaker"><span><strong>Held: ${escapeHTML(b.scope==='*'?'every site':b.scope)}</strong> · ${escapeHTML(b.message)}${b.repair_job_id?` Repair running on posting ${escapeHTML(b.repair_job_id)}.`:''}</span><button type="button" data-breaker="${escapeHTML(b.signature)}">Resume</button></div>`).join('');
    };
    const refreshWorkerState=async()=>{
      try{renderWorkerState(await agentRequest(''));}
      catch(error){$('workerState').textContent='Worker status unavailable';$('workerSummary').textContent=error.message;$('workerStart').disabled=true;$('workerStop').disabled=true;setWorkerStatus(error.message,true);}
    };
    agentRequest('/models').then(data=>{
      const select=$('agentModel'),groups=new Map();
      for(const row of data.models||[]){const label=row.engine==='claude'?'Claude':row.engine==='codex'?'Codex':'OpenCode';if(!groups.has(label))groups.set(label,[]);groups.get(label).push(row);}
      select.replaceChildren();
      for(const [label,rows] of groups){const group=document.createElement('optgroup');group.label=label;for(const row of rows){const option=document.createElement('option');option.value=`${row.engine}|${row.model}`;option.textContent=row.model;group.append(option);}select.append(group);}
      const chosen=`${data.engine}|${data.model||''}`;if([...select.options].some(option=>option.value===chosen))select.value=chosen;else if([...select.options].some(option=>option.value==='claude|claude-sonnet-5-5'))select.value='claude|claude-sonnet-5';
      $('agentParallelism').max=String(data.max_parallelism||1);$('agentParallelism').value=String(data.parallelism||1);$('agentUsageLimit').value=String(data.usage_pause_percent||0);
      setAgentStatus(`Known fields are filled deterministically first. Current Claude usage: ${data.claude_usage?.five_hour!=null?`${Math.round(data.claude_usage.five_hour*100)}% (5-hour), ${Math.round((data.claude_usage.seven_day||0)*100)}% (weekly)`:'checking'}.`);
    }).catch(error=>setAgentStatus(error.message,true));
    $('agentSettingsForm').addEventListener('submit',async event=>{
      event.preventDefault();const [engine,model]=String($('agentModel').value).split('|');
      const button=event.currentTarget.querySelector('button[type="submit"]');button.disabled=true;
      try{await agentRequest('/agent-settings',{engine,model,parallelism:Number($('agentParallelism').value),usage:Number($('agentUsageLimit').value)});setAgentStatus(`Saved. New applications use ${model}; usage fallback starts at ${$('agentUsageLimit').value}%.`);await refreshWorkerState();}
      catch(error){setAgentStatus(error.message,true);}finally{button.disabled=false;}
    });
    $('workerAutoStop').addEventListener('input',()=>{workerDirty=true;$('workerApprovalLimit').disabled=!$('workerApprovalEnabled').checked;$('workerHelpLimit').disabled=!$('workerHelpEnabled').checked;});
    $('workerAutoStop').addEventListener('change',()=>{workerDirty=true;$('workerApprovalLimit').disabled=!$('workerApprovalEnabled').checked;$('workerHelpLimit').disabled=!$('workerHelpEnabled').checked;});
    $('workerAutoStop').addEventListener('submit',async event=>{
      event.preventDefault();if(workerBusy)return;workerBusy=true;
      const button=event.currentTarget.querySelector('button[type="submit"]');button.disabled=true;
      let failure=null;
      try{const data=await agentRequest('/auto-stop',{approvals:$('workerApprovalEnabled').checked?Number($('workerApprovalLimit').value):0,help:$('workerHelpEnabled').checked?Number($('workerHelpLimit').value):0,usage:null});workerDirty=false;renderWorkerState(data);setWorkerStatus('Auto-stop limits saved.');}
      catch(error){failure=error.message;}
      finally{workerBusy=false;button.disabled=false;await refreshWorkerState();if(failure)setWorkerStatus(failure,true);}
    });
    $('workerControlActions').addEventListener('click',async event=>{
      const button=event.target.closest('[data-worker-action]');if(!button||workerBusy)return;
      const action=button.dataset.workerAction;workerBusy=true;document.querySelectorAll('#workerControlActions button').forEach(item=>item.disabled=true);
      setWorkerStatus(action==='start'?'Starting workers…':action==='stop'?'Stopping after current postings…':'Checking engine limits…');
      let failure=null;
      try{
        const data=await agentRequest(action==='retry-limits'?'/retry-engine-limits':'/control',action==='retry-limits'?{}:{action,parallelism:Number($('agentParallelism').value)});
        setWorkerStatus(action==='start'?'Workers started.':action==='stop'?'Stopping after current postings. No new applications will start.':'Limit pause cleared.');
        renderWorkerState(data);
      }catch(error){failure=error.message;}
      finally{workerBusy=false;await refreshWorkerState();if(failure)setWorkerStatus(failure,true);}
    });
    $('workerBreakers').addEventListener('click',async event=>{
      const button=event.target.closest('[data-breaker]');if(!button||workerBusy)return;workerBusy=true;button.disabled=true;
      let failure=null;
      try{const data=await agentRequest('/breakers/clear',{signature:button.dataset.breaker});setWorkerStatus(`Resumed. ${data.retried?.length?`Retrying ${data.retried.length} posting(s) it stopped.`:''}`);}
      catch(error){failure=error.message;}
      finally{workerBusy=false;await refreshWorkerState();if(failure)setWorkerStatus(failure,true);}
    });
    refreshWorkerState();setInterval(refreshWorkerState,3000);
  }
}

async function network(path, options = {}) {
  const track = window.UIFeedback?.track || (operation => operation());
  return track(async () => {
    const response = await fetch(backend + path, {...options, signal: AbortSignal.timeout(15000)});
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${response.status})`);
    }
    return response.json();
  }, {mutation: options.method && options.method !== 'GET'});
}

function snapshotRequest(path) {
  const url = new URL(path, 'http://localhost');
  const id = url.pathname.match(/^\/api\/jobs\/(\d+)$/)?.[1];
  if (id) {
    const job = snapshot.jobs.find(j => j.id === Number(id));
    if (!job) throw new Error('Job not found in snapshot');
    return job;
  }
  const p = url.searchParams, tab = p.get('tab') || 'top_priority', search = (p.get('query') || '').toLowerCase();
  let jobs = snapshot.jobs.filter(j => j.tabs.includes(tab));
  if (p.get('cluster') && tab !== 'interview') jobs = jobs.filter(j => j.best_career_cluster === p.get('cluster'));
  if (selectedCompanyFilter.length && !historyTabs.has(tab)) {
    const companies = new Set(selectedCompanyFilter.map(name => name.toLowerCase()));
    jobs = jobs.filter(j => companies.has((j.company_name || '').toLowerCase()));
  }
  if (search) jobs = jobs.filter(j => [j.title,j.company_name].some(v => (v || '').toLowerCase().includes(search)));
  const days = Number(p.get('applied_days') || 0);
  if (tab === 'applied' && days) jobs = jobs.filter(j => Date.parse(j.applied_date) >= Date.now() - days * 86400000);
  jobs.sort((a,b) => {
    if (tab === 'applied') {
      const submitted = j => Number.isFinite(Date.parse(j.applied_date)) ? Date.parse(j.applied_date) : 0;
      return submitted(b) - submitted(a) || b.id - a.id;
    }
    const first = j => tab === 'urgent' ? j.urgency_score : tab === 'new_today' ? Date.parse(j.posting_date || j.discovery_date) : j.priority_score;
    return first(b) - first(a) || b.priority_score - a.priority_score || b.id - a.id;
  });
  const offset = Number(p.get('offset') || 0), limit = Number(p.get('limit') || 100), total = jobs.length;
  jobs = jobs.slice(offset,offset+limit);
  return {jobs,total,count:jobs.length,offset};
}

async function api(path, options = {}) {
  if (connected || !snapshot) return network(path,options);
  if (options.method && options.method !== 'GET') throw new Error('Start the local JobAgent server to save changes.');
  return snapshotRequest(path);
}

function renderCompanyFilter() {
  const options = $('companyFilterOptions');
  if (!options) return;
  const search = ($('companyFilterSearch').value || '').trim().toLowerCase();
  const selected = new Set(selectedCompanyFilter.map(name => name.toLowerCase()));
  options.replaceChildren();
  const visible = companyChoices.filter(name => !search || name.toLowerCase().includes(search));
  for (const name of visible) {
    const label = document.createElement('label');
    label.className = 'flex items-center gap-2 rounded px-1.5 py-1 hover:bg-slate-800 text-slate-200';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.value = name; checkbox.checked = selected.has(name.toLowerCase());
    checkbox.dataset.companyChoice = '1';
    const text = document.createElement('span'); text.textContent = name;
    label.append(checkbox, text); options.append(label);
  }
  if (!visible.length) options.textContent = 'No matching companies.';
  $('companyFilterSummary').textContent = selectedCompanyFilter.length
    ? `${selectedCompanyFilter.length} ${selectedCompanyFilter.length === 1 ? 'company' : 'companies'} selected ▾`
    : 'All companies ▾';
  $('companyFilterStatus').textContent = selectedCompanyFilter.length
    ? 'New applications and the role lists are limited to these companies. Applied, Interview and history tabs still show every company.'
    : 'No company limit is active.';
}

async function initCompanyFilter() {
  const dropdown = $('companyFilterDropdown');
  if (!dropdown) return;
  if (snapshot) { dropdown.hidden = true; return; }
  try {
    const [state, choices] = await Promise.all([network('/api/applications/company-filter'), network('/api/companies')]);
    selectedCompanyFilter = state.companies || [];
    companyChoices = choices.companies || [];
    renderCompanyFilter();
  } catch (error) {
    $('companyFilterStatus').textContent = `Company filter unavailable: ${error.message}`;
  }
}

$('companyFilterSearch')?.addEventListener('input', renderCompanyFilter);
$('companyFilterOptions')?.addEventListener('change', event => {
  if (event.target.matches('[data-company-choice]')) {
    const draft = new Set([...document.querySelectorAll('[data-company-choice]:checked')].map(box => box.value.toLowerCase()));
    $('applyCompanyFilter').textContent = draft.size ? `Apply ${draft.size} ${draft.size === 1 ? 'company' : 'companies'}` : 'Apply selection';
  }
});
$('applyCompanyFilter')?.addEventListener('click', async () => {
  const companies = [...document.querySelectorAll('[data-company-choice]:checked')].map(box => box.value);
  const button = $('applyCompanyFilter'); button.disabled = true;
  try {
    const state = await network('/api/applications/company-filter', {method:'POST', headers:{'Content-Type':'application/json','X-JobAgent-Application':'1'}, body:JSON.stringify({companies})});
    selectedCompanyFilter = state.companies || [];
    renderCompanyFilter();
    $('companyFilterStatus').textContent = selectedCompanyFilter.length
      ? `Saved. New applications are limited to ${selectedCompanyFilter.length} selected ${selectedCompanyFilter.length === 1 ? 'company' : 'companies'}. Active applications will finish.`
      : 'Saved. Applications can come from any company.';
    $('companyFilterDropdown').open = false;
    await loadJobs();
  } catch (error) {
    $('companyFilterStatus').textContent = error.message;
  } finally { button.disabled = false; }
});
$('clearCompanyFilter')?.addEventListener('click', async () => {
  const button = $('clearCompanyFilter'); button.disabled = true;
  try {
    const state = await network('/api/applications/company-filter', {method:'POST', headers:{'Content-Type':'application/json','X-JobAgent-Application':'1'}, body:JSON.stringify({companies:[]})});
    selectedCompanyFilter = state.companies || [];
    renderCompanyFilter();
    $('companyFilterDropdown').open = false;
    await loadJobs();
  } catch (error) {
    $('companyFilterStatus').textContent = error.message;
  } finally { button.disabled = false; }
});

function setControls() {
  $('sourcesBtn').disabled = false;
  $('sourcesBtn').title = 'Manage company sources and email watches';
  $('searchBtn').disabled = !connected || scanning;
  $('searchBtn').textContent = scanning ? 'Scanning…' : 'Scan Sources';
  $('searchBtn').title = connected ? '' : 'Start the local JobAgent server to scan sources.';
  if (activeJob) {
    renderModalQueue();
    for (const id of ['btnSave','btnIgnore','btnInterview','btnApplied','btnStatus','btnNotes']) $(id).disabled = !connected;
    $('btnSave').disabled ||= pipeline.has(activeJob.status) || activeJob.status === 'SAVED';
    $('btnIgnore').disabled ||= pipeline.has(activeJob.status) || activeJob.status === 'IGNORED';
    $('btnInterview').disabled ||= ['INTERVIEW','OFFER','REJECTED','WITHDRAWN'].includes(activeJob.status);
    $('btnApplied').disabled ||= pipeline.has(activeJob.status);
  }
}

async function loadStats() {
  let data;
  try { data = await network('/api/status'); connected = true; }
  catch (error) {
    connected = false;
    if (!snapshot) { $('syncStatusText').textContent = 'Server unavailable'; setControls(); throw error; }
    data = {counts:snapshot.stats.counts,source_counts:snapshot.stats.source_counts,timestamp:snapshot.stats.last_updated,is_scanning:false};
  }
  scanning = Boolean(data.is_scanning);
  renderAutoPerformance(data.auto_application_performance?.attempts || []);
  const labels = {statActive:'ACTIVE',statApplied:'APPLIED'};
  for (const [id,key] of Object.entries(labels)) $(id).textContent = data.counts[key] || 0;
  for (const button of document.querySelectorAll('[data-count-key]')) {
    button.querySelector('.tab-count').textContent = data.counts[button.dataset.countKey] || 0;
  }
  const nextScan = data.next_scan_at ? new Date(data.next_scan_at) : null;
  const nextText = nextScan && !Number.isNaN(nextScan.valueOf()) ? ` · next scan ${nextScan.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}` : '';
  $('syncStatusText').textContent = connected ? (scanning ? 'Scanning sources' : `Searching continuously${nextText}`) : 'Static snapshot · read only';
  const updated = connected ? data.latest_run?.completed_at : data.timestamp;
  $('lastUpdated').textContent = updated ? `Last discovery scan: ${new Date(/Z$|[+-]\d\d:\d\d$/.test(updated) ? updated : updated+'Z').toLocaleString()}` : 'No completed scan yet';
  if (data.scan_error) $('lastUpdated').textContent += ` · Scan failed: ${data.scan_error}`;
  $('sourceCoverage').textContent = (data.source_counts || []).map(s => `${s.source}: ${s.stored} stored · ${s.applicable} applicable`).join('\n');
  $('sourceErrors').textContent = (data.latest_run?.source_results || []).filter(s=>s.error || s.truncated).map(s=>`${s.company} (${s.ats}): ${s.error || 'Partial scan; additional listings/details remain.'}`).join('\n');
  $('sourceWarnings').textContent = (data.latest_run?.source_results || []).filter(s=>s.warnings?.length).map(s=>`${s.company}: ${s.warnings.join('\n  ')}`).join('\n\n');
  $('listingIssues').hidden = !$('sourceWarnings').textContent;
  if (data.latest_run?.errors_count) $('lastUpdated').textContent += ` · ${data.latest_run.errors_count} scan errors (see source coverage)`;
  if (scanning && !scanTimer) scanTimer = setInterval(() => sync().catch(e => showToast(e.message,'error')),3000);
  if (!scanning && scanTimer) { clearInterval(scanTimer); scanTimer=null; }
  setControls();
  const signature = JSON.stringify([connected,data.counts,data.latest_run?.completed_at,scanning]);
  const changed = signature !== statsSignature; statsSignature = signature;
  return changed;
}

// Location filter: the states open postings are in; his choice is remembered in this browser.
const selectedStates=new Set((()=>{try{return JSON.parse(localStorage.getItem('jobagent.states')||'[]');}catch{return [];}})());
function showStateSummary(names){const n=selectedStates.size;$('stateFilterSummary').textContent=(n===0?'All locations':n<=2?[...selectedStates].map(c=>names?.[c]||c).join(', '):`${n} states`)+' ▾';}
async function loadStates(){
  if(snapshot||!$('stateFilterOptions'))return;
  let data;try{data=await api('/api/locations');}catch{return;}
  const names=Object.fromEntries(data.states.map(s=>[s.code,s.name]));
  const box=$('stateFilterOptions');box.replaceChildren();
  for(const state of data.states){
    const input=document.createElement('input');input.type='checkbox';input.value=state.code;input.checked=selectedStates.has(state.code);
    input.onchange=()=>{input.checked?selectedStates.add(state.code):selectedStates.delete(state.code);try{localStorage.setItem('jobagent.states',JSON.stringify([...selectedStates]));}catch{}showStateSummary(names);loadJobs();};
    const count=document.createElement('span');count.textContent=state.count;
    const label=document.createElement('label');label.append(input,state.name,count);box.append(label);
  }
  $('clearStateFilter').onclick=()=>{selectedStates.clear();try{localStorage.removeItem('jobagent.states');}catch{}box.querySelectorAll('input').forEach(i=>{i.checked=false;});showStateSummary(names);loadJobs();};
  showStateSummary(names);
}
document.addEventListener('click',event=>{const menu=$('stateFilterDropdown');if(menu?.open&&!menu.contains(event.target))menu.open=false;});

async function loadJobs(append = false) {
  const version = ++requestVersion;
  $('clearFilters').classList.toggle('hidden',!$('clusterFilter').value && !$('searchInput').value && !selectedStates.size && !$('sortSelect')?.value);
  $('loading').classList.remove('hidden'); $('emptyState').classList.add('hidden');
  $('errorState').classList.add('hidden'); $('loadMore').disabled = true;
  if (!append) { allJobs = []; $('jobGrid').replaceChildren(); selectedJobs.clear(); }
  const params = new URLSearchParams({tab:currentTab,cluster:$('clusterFilter').value,query:$('searchInput').value,limit:'100',offset:String(append?allJobs.length:0)});
  if (currentTab === 'applied' && $('appliedRange').value) params.set('applied_days',$('appliedRange').value);
  if (selectedStates.size) params.set('states',[...selectedStates].join(','));
  if ($('sortSelect')?.value) params.set('sort',$('sortSelect').value);
  try {
    const data = await api('/api/jobs?'+params);
    if (version !== requestVersion) return;
    allJobs = append ? allJobs.concat(data.jobs) : data.jobs;
    totalJobs = data.total;
    for (const job of data.jobs) $('jobGrid').append(createJobCard(job));
    $('jobGrid').classList.toggle('hidden',!allJobs.length);
    $('emptyState').classList.toggle('hidden',Boolean(allJobs.length));
    $('resultCount').textContent = `Showing ${allJobs.length} of ${totalJobs} matching roles`;
    renderBulkBar();
    $('loadMore').classList.toggle('hidden',allJobs.length>=totalJobs);
  } catch (error) {
    if (version !== requestVersion) return;
    $('errorState').textContent = `Could not load jobs: ${error.message}`;
    $('errorState').classList.remove('hidden');
    $('loadMore').classList.add('hidden');
  } finally {
    if (version === requestVersion) { $('loading').classList.add('hidden'); $('loadMore').disabled = false; }
  }
}

// The queue takes open full-time roles and internships; eligibility decides only whether queueing also needs his label.
function queueableRole(job) {
  return ['NEW','ACTIVE','SAVED'].includes(job.status) && ['FULL_TIME','INTERNSHIP'].includes(job.role_type) && !/\bgoogle\b/i.test(job.company_name);
}
function canQueueApplication(job) {
  return queueableRole(job) && (['STRONG_MATCH','ELIGIBLE'].includes(job.eligibility) || job.user_fit_label?.fit === true);
}
// Queueing a role the rules rated Likely eligible or Uncertain records his Good fit label first (one click, not two).
// Rules-ineligible roles and ones he marked Not a fit keep their card buttons hidden; the details dialog still offers it.
function queueMarksFit(job) {
  return queueableRole(job) && !canQueueApplication(job) && !['INELIGIBLE','LIKELY_INELIGIBLE'].includes(job.eligibility) && job.user_fit_label?.fit !== false;
}

function queueUnavailableReason(job) {
  if(!connected)return 'JobAgent is disconnected. Reconnect to queue an application.';
  if(pipeline.has(job.status))return 'This application is already in your application history.';
  if(!['NEW','ACTIVE','SAVED'].includes(job.status))return 'This posting is closed or ignored. Change its status before queueing.';
  if(/\bgoogle\b/i.test(job.company_name))return 'Google applications are paused.';
  if(!['FULL_TIME','INTERNSHIP'].includes(job.role_type))return 'The application queue supports full-time roles and internships.';
  if(!canQueueApplication(job)&&job.user_fit_label?.fit===false)return 'You marked this not a fit. Change your call above to queue it.';
  return '';
}
function renderModalQueue() {
  if(!activeJob)return;
  const button=$('btnQueueApplication'),status=$('modalQueueFeedback');
  const reason=queueUnavailableReason(activeJob);
  const marksFit=!reason&&!canQueueApplication(activeJob);
  button.classList.remove('hidden');button.dataset.queueLabel=marksFit?'Mark Good fit & queue':'Queue application';
  button.dataset.queueUnavailable=reason;
  window.renderQueueButton?.(button,activeJob.id,'end');
  button.disabled=Boolean(reason)||window.getQueueFeedback?.(activeJob.id)?.status==='pending';
  button.title=reason || (marksFit?'Records your Good fit label (the rules rated this below eligible), then adds it to your application queue':'Add this role to your application queue');
  if(status){
    status.dataset.queueStatus=String(activeJob.id);
    const feedback=window.getQueueFeedback?.(activeJob.id);
    status.textContent=feedback?.message || reason;
    status.dataset.error=String(feedback?.status==='error');
    status.dataset.unavailable=String(!feedback&&Boolean(reason));
  }
}
$('btnQueueApplication').removeAttribute('onclick');
$('btnQueueApplication').addEventListener('click',()=>{
  if(!activeJob)return;
  if(typeof window.queueApplication!=='function'){showToast('Application controls are still loading. Please refresh the dashboard.','error');return;}
  const id=activeJob.id;
  window.queueApplication(id,'end',$('btnQueueApplication'),!canQueueApplication(activeJob)).then(result=>{
    if(result?.labeled?.includes(id)&&activeJob?.id===id)openDetail(id);  // show the label the queue request recorded
  });
});

// Years of experience the posting asks for; they also feed the fit score (see Settings).
function experienceText(job) {
  const years = n => `${Number(n)}+ yr${Number(n) === 1 ? '' : 's'}`;
  const req = job.experience_required_years, pref = job.experience_preferred_years;
  if (req == null && pref == null) return 'Experience: not stated';
  return 'Experience: ' + [req == null ? 'none stated as required' : req === 0 ? 'none required' : `${years(req)} required`,
                           pref == null ? '' : `${years(pref)} preferred`].filter(Boolean).join(' · ');
}

function submittedLabel(job) {
  const date = new Date(job.applied_date || '');
  return Number.isFinite(date.valueOf()) ? `Submitted ${date.toLocaleString()}` : 'Submission date unavailable';
}

// Fit score colour: is this a good fit or not (his request 2026-11-13).
const fitLevel = score => { const n = Number(score) || 0; return n >= 75 ? 'fit-high' : n >= 60 ? 'fit-mid' : 'fit-low'; };

function createJobCard(job) {
  const card = document.createElement('div');
  card.className = 'job-card bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-cyan-500/50 cursor-pointer';
  card.tabIndex=0; card.dataset.jobId=job.id;
  const elClass = job.eligibility === 'STRONG_MATCH' ? 'badge-strong' : ['INELIGIBLE','LIKELY_INELIGIBLE'].includes(job.eligibility) ? 'badge-conflict badge-no' : ['UNCERTAIN','POSSIBLE_CONFLICT'].includes(job.eligibility) ? 'badge-conflict' : job.eligibility === 'LIKELY_ELIGIBLE' ? 'badge-eligible badge-likely' : 'badge-eligible';
  card.innerHTML = `<div class="flex justify-between"><span class="text-xs font-bold text-cyan-400">${escapeHTML(job.company_name)}</span><span class="company-logo" aria-hidden="true">${escapeHTML((job.company_name || '?').trim().charAt(0).toUpperCase())}${snapshot ? '' : `<img src="/api/company-logo?name=${encodeURIComponent(job.company_name || '')}&job=${Number(job.id)}" alt="" loading="lazy" onerror="this.remove()">`}</span><span class="text-xs text-slate-400" title="Role fit out of 100, based on duties and qualifications. Green 75 and up, amber 60 to 75, red below 60">Fit <strong class="text-slate-200 ${fitLevel(job.relevance_score)}">${Number(job.relevance_score || 0).toFixed(1)}</strong></span></div>
    <h3 class="text-base font-semibold mt-1">${escapeHTML(job.title)}</h3>
    <div class="flex flex-wrap gap-2 my-3 text-xs"><span class="${elClass} rounded px-2">${escapeHTML(({STRONG_MATCH:'Strong match',ELIGIBLE:'Meets requirements',LIKELY_ELIGIBLE:'Likely eligible',UNCERTAIN:'Check requirements',POSSIBLE_CONFLICT:'Check requirements',INELIGIBLE:'Not eligible',LIKELY_INELIGIBLE:'Likely not eligible'})[job.eligibility] || job.eligibility)}</span></div>
    <p class="text-xs text-slate-400">${escapeHTML(job.location || 'Location not specified')}</p>
    <p class="text-xs text-slate-300 my-2${job.salary_raw ? '' : ' fact-missing'}">${escapeHTML(job.salary_raw || 'Salary not listed')}</p>
    <p class="text-xs text-slate-300${experienceText(job) === 'Experience: not stated' ? ' fact-missing' : ''}">${escapeHTML(experienceText(job))}</p>
    <div class="flex gap-3 text-xs mt-4"><span>${escapeHTML(currentTab === 'applied' ? submittedLabel(job) : job.posting_age)}</span>${['NEW','ACTIVE'].includes(job.status) ? '' : `<span>${escapeHTML(job.status.charAt(0)+job.status.slice(1).toLowerCase())}</span>`}</div>
    <div class="flex gap-3 mt-3 text-xs"><a class="text-cyan-400" href="${escapeHTML(safeURL(job.application_url || job.canonical_url))}" target="_blank" rel="noopener noreferrer">View posting ↗</a>${job.resume_sent ? (job.resume_file ? `<a class="text-cyan-400" href="/api/applications/jobs/${Number(job.id)}/sent-resume.pdf" target="_blank" rel="noopener" title="The exact resume this application uploaded">Resume sent: ${escapeHTML(job.resume_sent)} ↗</a>` : `<span class="text-slate-400" title="That file version was not kept">Resume sent: ${escapeHTML(job.resume_sent)}</span>`) : ''}</div>`;
  card.onclick=()=>openDetail(job.id);
  card.onkeydown=e=>{if(e.target===card && ['Enter',' '].includes(e.key)){e.preventDefault();openDetail(job.id);}};
  card.querySelectorAll('a').forEach(a => { a.onclick = e => e.stopPropagation(); });
  if (!pipeline.has(job.status) && !['CLOSED','IGNORED'].includes(job.status)) {
    const button=document.createElement('button'); button.textContent='Mark applied'; button.className='text-emerald-400';
    button.disabled=!connected;
    button.onclick=async e=>{e.stopPropagation();button.disabled=true;await quickMarkApplied(job.id);button.disabled=!connected;};
    card.lastElementChild.append(button);
  }
  if (canQueueApplication(job) || queueMarksFit(job)) {
    const marksFit=!canQueueApplication(job);
    for (const [position, text] of [['next', 'Play next'], ['end', '+ Add to queue']]) {
      const queue = document.createElement('button');
      queue.textContent = text;
      queue.dataset.queueJob=String(job.id);queue.dataset.queuePosition=position;queue.dataset.queueLabel=text;
      window.renderQueueButton?.(queue,job.id,position);
      queue.className = 'text-cyan-300'; queue.title = (position === 'next' ? 'Apply to this role before the rest of the queue' : 'Apply after the roles already queued') + (marksFit ? '. Also records your Good fit label: the rules rated this below eligible' : '');
      queue.onclick = e => {
        e.stopPropagation();
        window.queueApplication(job.id, position, queue, marksFit).then(result=>{ if(result?.labeled?.includes(job.id)) job.user_fit_label={fit:true,note:'Queued from the dashboard'}; });
      };
      card.lastElementChild.append(queue);
    }
    const queueStatus=document.createElement('p');
    queueStatus.className='queue-feedback';queueStatus.dataset.queueStatus=String(job.id);queueStatus.setAttribute('role','status');
    const feedback=window.getQueueFeedback?.(job.id);
    queueStatus.textContent=feedback?.message || '';queueStatus.dataset.error=String(feedback?.status==='error');
    card.append(queueStatus);
  }
  if (!snapshot) {
    // Tick box on the left of every posting, like a mail list (his request 2026-11-14). Appended last: the list layout places children by position.
    const pick=document.createElement('label');pick.className='card-select';pick.title='Select this posting';
    const box=document.createElement('input');box.type='checkbox';box.checked=selectedJobs.has(job.id);box.setAttribute('aria-label',`Select ${job.title} at ${job.company_name}`);
    pick.append(box);pick.onclick=e=>e.stopPropagation();
    box.onchange=()=>{box.checked?selectedJobs.add(job.id):selectedJobs.delete(job.id);card.classList.toggle('selected',box.checked);renderBulkBar();};
    card.classList.toggle('selected',box.checked);card.append(pick);
  }
  return card;
}

// Actions on the ticked postings.
function renderBulkBar() {
  const bar=$('bulkBar'); if(!bar||snapshot) return;
  bar.hidden=!allJobs.length;
  const n=selectedJobs.size, all=$('bulkAll');
  all.checked=n>0&&n===allJobs.length; all.indeterminate=n>0&&n<allJobs.length;
  $('bulkCount').textContent=n?`${n} selected`:'Select all';
  for(const id of ['bulkQueue','bulkApplied','bulkDelete']) $(id).disabled=!n||!connected||bulkBusy;
}
let bulkBusy=false;
async function bulkRun(label, work) {
  if(bulkBusy||!selectedJobs.size) return;
  bulkBusy=true; renderBulkBar(); $('bulkStatus').textContent=`${label}…`;
  let message='';
  try { message=await work([...selectedJobs]); }
  catch(error) { message=''; showToast(error.message,'error'); }
  bulkBusy=false; $('bulkStatus').textContent='';
  if(message){ showToast(message); await loadStats(); await loadJobs(); } else renderBulkBar();
}
const bulkStatus=(status,done)=>async ids=>{
  const r=await api('/api/jobs/bulk-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({job_ids:ids,status,notes:`${done} from the dashboard list`})});
  const kept=r.skipped.length?` ${r.skipped.length} already in your application history left as they are.`:'';
  return `${done} ${r.changed.length} posting${r.changed.length===1?'':'s'}.${kept}`;
};
if(!snapshot&&$('bulkBar')){
  $('bulkAll').onchange=()=>{
    const on=$('bulkAll').checked; selectedJobs.clear(); if(on) for(const job of allJobs) selectedJobs.add(job.id);
    document.querySelectorAll('#jobGrid .job-card').forEach(card=>{const box=card.querySelector('.card-select input');if(box){box.checked=on;card.classList.toggle('selected',on);}});
    renderBulkBar();
  };
  $('bulkApplied').onclick=()=>bulkRun('Marking applied',bulkStatus('APPLIED','Marked applied'));
  $('bulkDelete').onclick=()=>bulkRun('Deleting',bulkStatus('IGNORED','Deleted'));
  // One request per posting: the queue refuses a whole request when one role in it cannot be queued.
  $('bulkQueue').onclick=()=>bulkRun('Adding to your queue',async ids=>{
    let added=0,already=0;const refused=[];
    for(const id of ids){
      try{
        const r=await api('/api/applications/queue',{method:'POST',headers:{'Content-Type':'application/json','X-JobAgent-Application':'1'},body:JSON.stringify({job_ids:[id],position:'end',mark_fit:true})});
        r.added?added++:already++;
      }catch(error){const job=allJobs.find(j=>j.id===id);refused.push(`${job?.company_name||'#'+id}: ${error.message}`);}
    }
    const parts=[`Added ${added} to your queue.`];
    if(already)parts.push(`${already} already queued or in progress.`);
    if(refused.length)parts.push(`${refused.length} not queued: ${refused.slice(0,3).join('; ')}${refused.length>3?'; …':''}`);
    return parts.join(' ');
  });
}

function renderLines(id, values, fallback) {
  $(id).replaceChildren();
  for (const text of Array.isArray(values) && values.length ? values : [fallback]) { const line=document.createElement('div');line.textContent=text;$(id).append(line); }
}

async function openDetail(id) {
  const version=++detailVersion;
  try {
    const job=await api(`/api/jobs/${id}`);
    if(version!==detailVersion)return;
    activeJob=job;
    const queueButton=$('btnQueueApplication');
    queueButton.textContent='Queue application';queueButton.dataset.queueLabel='Queue application';
    window.renderQueueButton?.(queueButton,job.id,'end');
    for(const [element,value] of Object.entries({modalCompany:job.company_name,modalAts:job.source_ats,modalTitle:job.title,modalLocation:job.location,modalSalary:job.salary_raw || 'Salary not listed',modalExperience:experienceText(job),modalPostingAge:job.posting_age,modalPriority:Number(job.priority_score||0).toFixed(1),modalRelevance:Number(job.relevance_score||0).toFixed(1),modalUrgency:Number(job.urgency_score||0).toFixed(1),modalEligibilityBadge:job.eligibility.replaceAll('_',' '),modalDesc:job.description})) $(element).textContent=value || '';
    $('modalEligibilityBadge').dataset.level=['STRONG_MATCH','ELIGIBLE'].includes(job.eligibility)?'good':['INELIGIBLE','LIKELY_INELIGIBLE'].includes(job.eligibility)?'bad':'unsure';
    $('modalClusterBars').replaceChildren();
    for (const [name,score] of Object.entries(job.cluster_scores || {})) {
      const line=document.createElement('div');line.textContent=`${name}: ${score}`;
      const progress=document.createElement('progress');progress.max=100;progress.value=Number(score)||0;progress.className='w-full';line.append(progress);$('modalClusterBars').append(line);
    }
    renderLines('modalEligibilityReasons',job.eligibility_reasons,'Eligibility not evaluated.');
    renderFitCall(job);
    $('modalFitExplanation').textContent = job.breakdown?.explanation || 'Fit assessment not available.';
    renderLines('modalExpMatch',job.breakdown?.matching_experience,'No specific experience matches.');
    renderLines('modalSkillsMatch',job.breakdown?.matching_skills,'No direct skill matches.');
    $('modalCoverLetter').value=job.cover_letter_draft || '';
    $('modalNotes').value=job.notes || '';
    $('modalApplyLink').href=safeURL(job.application_url || job.canonical_url);
    $('statusSelect').value=job.status;
    $('detailModal').classList.remove('hidden');setControls();
  } catch(error){showToast(error.message,'error');}
}
// His call on a posting overrides the rules and the reviewer, and the reviewer learns from it.
function renderFitCall(job) {
  const review=job.fit_review, label=job.user_fit_label, stats=job.label_agreement||{};
  $('modalReview').textContent = review ? `${review.fit?'Fit':'Not a fit'}: ${review.reason}${review.work?`\nWork: ${review.work}`:''}${review.missing_requirements?.length?`\nMissing: ${review.missing_requirements.join('; ')}`:''}` : 'Not reviewed yet. The reviewer reads a posting when autoplay is about to take it.';
  $('fitLabelNote').value = label?.note || '';
  $('btnFitYes').setAttribute('aria-pressed', String(label?.fit === true));
  $('btnFitNo').setAttribute('aria-pressed', String(label?.fit === false));
  $('btnFitClear').classList.toggle('hidden', !label);
  $('fitLabelState').textContent = label ? `You marked this ${label.fit?'a good fit':'not a fit'}. Autoplay follows your call.` : 'Unlabelled. The rules and the reviewer decide.';
  $('labelAgreement').textContent = stats.labels ? `Your ${stats.labels} label(s): the rules agree on ${stats.rules_agree}, the reviewer on ${stats.reviewer_agree} of ${stats.reviewed} it read.` : '';
  const tuning=job.rule_tuning;
  $('ruleTuning').textContent = tuning && tuning.evidence ? `Fixed rules match the truth (your labels, else the reviewer) on ${Math.round(tuning.agreement*100)}% of ${tuning.evidence} judged postings. They revise themselves once they disagree on 20%+ with 20+ judged${tuning.last_tuned_at?`; last revised ${new Date(tuning.last_tuned_at).toLocaleString()}`:''}.` : '';
  for (const id of ['btnFitYes','btnFitNo','btnFitClear','fitLabelNote']) $(id).disabled = !connected;
}
async function saveFitLabel(fit) {
  if (!activeJob) return;
  try {
    const result = await api(`/api/jobs/${activeJob.id}/fit-label`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({fit, note:$('fitLabelNote').value})});
    activeJob.user_fit_label = result.label;
    showToast(fit===null ? 'Label cleared.' : 'Saved. The reviewer will learn from it.', 'success');
    await openDetail(activeJob.id);
  } catch(error){showToast(error.message,'error');}
}
function closeModal(){++detailVersion;$('detailModal').classList.add('hidden');activeJob=null;}
function switchTab(tab){
  // The interview badge counts every interview; show the full list when opened.
  if (tab === 'interview') resetFilters();
  currentTab=tab;
  $('clusterFilter').disabled = tab === 'interview';
  $('appliedRange').classList.toggle('hidden', tab !== 'applied');
  document.querySelectorAll('.tab-btn').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tab===tab)));
  const primary = ['top_priority','saved','applied','interview'].includes(tab);
  $('moreViews').value = primary ? '' : tab;
  const descriptions = {
    top_priority:'Full-time roles that meet your current filters, ranked by fit.',
    saved:'Your shortlist of roles to come back to.', applied:'Applications confirmed by an employer or marked submitted.',
    interview:'Applications that have reached the interview stage.',
    internships:'Internship and co-op opportunities.',
    new_today:'Matching roles posted or first discovered in the last 24 hours.', new_grad:'Matching roles explicitly aimed at early-career applicants.',
    high_match:'Matching roles with a priority score of 85 or higher.', offer:'Applications with an offer.',
    rejected:'Applications marked as rejected.', withdrawn:'Applications you withdrew.', closed:'Postings marked as closed.', ignored:'Roles you have hidden.'
  };
  $('viewDescription').textContent=descriptions[tab] || '';
  loadJobs();
}
function resetFilters(){
  clearTimeout(searchDebounceTimeout);
  $('clusterFilter').value='';
  $('searchInput').value='';
  if($('sortSelect'))$('sortSelect').value='';
  if(selectedStates.size)$('clearStateFilter')?.onclick?.();
}
function clearFilters(){resetFilters();loadJobs();}
// The JobAgent name is the way home (his request 11-14): close whatever is open, clear the filters, show the default list.
function goHome(){
  closeModal();$('pagePanelClose')?.click();{const agent=$('applicationPanel');if(agent)agent.hidden=true;}
  document.body.style.overflow='';resetFilters();switchTab('top_priority');window.scrollTo({top:0});
}
$('homeLink')?.addEventListener('click',event=>{if(event.metaKey||event.ctrlKey||event.shiftKey||event.button)return;event.preventDefault();goHome();});
function debounceSearch(){clearTimeout(searchDebounceTimeout);searchDebounceTimeout=setTimeout(()=>loadJobs(),250);}
async function sync(){if(await loadStats())await loadJobs();}
async function triggerSearch(){
  $('searchBtn').disabled=true;
  try{await api('/api/search',{method:'POST'});await loadStats();showToast('Scan started. Results will update when it finishes.');}
  catch(error){showToast(error.message,'error');setControls();}
}
async function saveStatus(id,status,notes){
  const data=await api(`/api/jobs/${id}/status`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status,notes})});
  showToast(data.warning || `Job #${id} marked ${status}.`,data.warning?'error':'success');
  await loadStats();await loadJobs();
}
async function quickMarkApplied(id){try{await saveStatus(id,'APPLIED','Marked applied by user in dashboard');}catch(error){showToast(error.message,'error');}}
async function updateCurrentJobStatus(status){
  if(!activeJob)return;
  const id=activeJob.id,notes=$('modalNotes').value;
  document.querySelectorAll('#detailModal button').forEach(b=>b.disabled=true);
  try{await saveStatus(id,status,notes);closeModal();}catch(error){showToast(error.message,'error');}
  finally{document.querySelectorAll('#detailModal button').forEach(b=>b.disabled=false);setControls();}
}
function applyWithNotes(){return updateCurrentJobStatus('APPLIED');}
async function copyCoverLetter(){
  try{await navigator.clipboard.writeText($('modalCoverLetter').value);showToast('Draft copied.');}
  catch{ $('modalCoverLetter').focus();$('modalCoverLetter').select();showToast('Copy unavailable. The draft is selected; press Ctrl/Cmd+C.','error'); }
}
let toastTimer;
function showToast(message,type='success'){
  if(window.UIFeedback){window.UIFeedback.notify(message,type==='error');return;}
  clearTimeout(toastTimer);$('toast').textContent=message;
  $('toast').setAttribute('role',type==='error'?'alert':'status');
  $('toast').className=`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg text-sm ${type==='error'?'bg-rose-700':'bg-emerald-700'}`;
  toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),5000);
}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();});
$('detailModal').addEventListener('click',e=>{if(e.target===$('detailModal'))closeModal();});
window.addEventListener('focus',()=>sync().catch(()=>{}));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync().catch(()=>{});});
// Reflect confirmed applications promptly, even while the application panel is closed.
// Schedule after completion so slow/offline requests never pile up.
async function refreshDashboard(){
  try{if(!document.hidden)await sync();}catch{}
  finally{setTimeout(refreshDashboard,2000);}
}
setTimeout(refreshDashboard,2000);
(async()=>{try{await loadStats();await initCompanyFilter();await loadJobs();}catch(e){$('loading').classList.add('hidden');showToast(e.message,'error');}})();

let sourceData = null, sourceTaskTimer = null;
function closeSources() { $('sourcesModal').classList.add('hidden'); $('sourcesBtn').focus(); }
async function openSources() {
  $('sourcesModal').classList.remove('hidden'); $('closeSources').focus();
  await connectSources();
}
function setSourceControls(enabled) {
  for (const selector of ['#sourceForm input', '#sourceForm button', '#auditSourcesBtn', '#sourceFilter', '#sourceScope', '#sourceList input', '#sourceList button']) {
    document.querySelectorAll(selector).forEach(control => { control.disabled = !enabled; });
  }
}
async function connectSources() {
  $('sourcesConnection').classList.add('hidden');
  $('notificationInfo').textContent = 'Connecting to JobAgent…';
  setSourceControls(false);
  try {
    await refreshSources();
  } catch(e) {
    $('notificationInfo').textContent = 'This page cannot connect to the local JobAgent service.';
    $('sourcesConnection').classList.remove('hidden');
    $('sourceTaskStatus').textContent = '';
    setSourceControls(false);
  }
}
async function refreshSources() {
  sourceData=await network('/api/sources');
  $('sourcesConnection').classList.add('hidden');
  const n=sourceData.notifications;
  $('notificationInfo').textContent=`Alerts to ${n.recipient} · ${n.available ? 'Apple Mail connected' : 'Apple Mail unavailable; pending alerts will wait'} · ${n.pending} pending · ${n.sent} handed to Mail${n.uncertain ? ` · ${n.uncertain} uncertain sends: check Mail` : ''}`;
  renderSources();
  setSourceControls(true);
  const running=sourceData.tasks.find(t=>['queued','running'].includes(t.status));
  if(running && !sourceTaskTimer) pollSourceTask(running.id);
  else if(!$('sourceTaskStatus').textContent && sourceData.tasks[0]?.status==='failed') $('sourceTaskStatus').textContent=sourceData.tasks[0].error;
}
function renderSources() {
  if (!sourceData) return;
  const query=$('sourceFilter').value.toLowerCase(), scope=$('sourceScope').value;
  const sources=sourceData.sources.filter(s=>(scope==='all'||s.enabled===(scope==='active')) && s.company.toLowerCase().includes(query));
  const active=sourceData.sources.filter(s=>s.enabled).length;
  $('sourceSummary').textContent=`${active} active · ${sourceData.sources.length-active} removed · showing ${sources.length}`;
  const watchable=[...new Set(sourceData.sources.filter(s=>s.enabled&&!['github','indeed','linkedin','handshake'].includes(s.ats)).map(s=>s.company.toLowerCase()))];
  const watched=watchable.filter(c=>sourceData.watches[c]?.enabled).length;
  $('watchAll').checked=watchable.length>0&&watched===watchable.length;$('watchAll').indeterminate=watched>0&&watched<watchable.length;
  $('watchAllCount').textContent=`(${watched} of ${watchable.length} watched)`;
  $('sourceList').innerHTML=sources.map(s=>{
    const w=sourceData.watches[s.company.toLowerCase()] || {};
    return `<div class="rounded-lg border border-slate-700 p-3 flex flex-wrap justify-between gap-3">
      <div class="min-w-0 flex-1"><a href="${escapeHTML(safeURL(s.url))}" target="_blank" rel="noopener noreferrer" class="font-medium text-cyan-300 break-words">${escapeHTML(s.company)}</a>
      <span class="text-xs text-slate-400"> · ${escapeHTML(s.ats)} · ${escapeHTML(s.health)}</span>
      <p class="text-xs text-slate-400 mt-1 break-words">${escapeHTML(s.detail || 'Not yet verified')}${s.checked_at ? ` · ${escapeHTML(new Date(s.checked_at).toLocaleString())}` : ''}</p>
      ${w.enabled ? `<p class="text-xs text-emerald-300 mt-1">${escapeHTML(w.error || (w.baseline_ready ? 'Watching for new eligible roles' : 'Watch on · baseline pending next scan'))}</p>` : ''}</div>
      <div class="flex items-center gap-3 text-xs">
      ${!['github','indeed','linkedin','handshake'].includes(s.ats) && (s.enabled || w.enabled) ? `<label class="flex gap-2 items-center"><input type="checkbox" role="switch" aria-label="Watch ${escapeHTML(s.company)}" data-watch="${s.id}" ${w.enabled?'checked':''}>Watch</label>` : ''}
      <button data-source-action="recheck" data-id="${s.id}" class="text-cyan-300">${s.enabled?'Recheck':'Check & restore'}</button>
      ${s.enabled ? `<button data-source-action="remove" data-id="${s.id}" class="text-rose-300">Remove</button>` : ''}</div></div>`;
  }).join('') || '<p class="text-slate-400 p-4">No matching sources.</p>';
}
async function sourceAction(path, payload) {
  try {
    const result=await network(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload || {})});
    if(result.task_id) pollSourceTask(result.task_id);
    else await refreshSources();
  } catch(e) { $('sourceTaskStatus').textContent=e.message; await refreshSources().catch(()=>{}); }
}
function pollSourceTask(id) {
  clearTimeout(sourceTaskTimer);
  $('sourceTaskStatus').textContent='Source agent is working. You can close this panel while it runs.';
  const check=async()=>{
    try {
      const task=await network(`/api/source-tasks/${id}`);
      if(['queued','running'].includes(task.status)) { sourceTaskTimer=setTimeout(check,2000); return; }
      sourceTaskTimer=null;
      $('sourceTaskStatus').textContent=task.error || task.result?.message || `Verification complete: ${task.result?.checked} checked, ${task.result?.removed} removed.`;
      await refreshSources();
    } catch(e) { sourceTaskTimer=null; $('sourceTaskStatus').textContent=e.message+' Reopen this panel to check the task.'; }
  }; check();
}
$('sourceForm').addEventListener('submit',async e=>{
  e.preventDefault(); $('addSourceBtn').disabled=true;
  await sourceAction('/api/sources',{name:$('sourceName').value.trim(),url:$('sourceURL').value.trim(),watch:$('sourceWatch').checked});
  if(!$('sourceURL').value.trim()) $('sourceName').value='';
  $('addSourceBtn').disabled=false;
});
$('sourceFilter').addEventListener('input',renderSources);
$('sourceScope').addEventListener('change',renderSources);
$('auditSourcesBtn').addEventListener('click',()=>sourceAction('/api/sources/audit'));
$('sourceList').addEventListener('click',e=>{
  const button=e.target.closest('[data-source-action]');
  if(button) sourceAction(`/api/sources/${button.dataset.id}/${button.dataset.sourceAction}`);
});
$('watchAll').addEventListener('change',async e=>{
  const enabled=e.target.checked;e.target.disabled=true;
  try{const r=await network('/api/watches/all',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});
    $('sourceTaskStatus').textContent=enabled?`Watching every active source (${r.changed} newly added). Each company's first scan sets a baseline, so only roles posted after that are emailed.`:`Stopped watching ${r.changed} companies.`;}
  catch(err){$('sourceTaskStatus').textContent=err.message;}
  finally{e.target.disabled=false;await refreshSources().catch(()=>{});}
});
$('sourceList').addEventListener('change',e=>{
  const id=e.target.dataset.watch; if(!id)return;
  const source=sourceData.sources.find(s=>s.id===Number(id));
  e.target.disabled=true;
  sourceAction('/api/watches',{company:source.company,enabled:e.target.checked});
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('sourcesModal').classList.contains('hidden'))closeSources();});

if (location.hash === '#sources') openSources();
$('btnFitYes').addEventListener('click',()=>saveFitLabel(true));
$('btnFitNo').addEventListener('click',()=>saveFitLabel(false));
$('btnFitClear').addEventListener('click',()=>saveFitLabel(null));

// Search track: which background (mechanical or statistics/data science) the dashboard and
// autoplay judge postings for. Each track keeps its own verdicts, reviews and labels.
async function loadTrack() {
  try {
    const choice = await api('/api/track');
    $('trackSelect').replaceChildren(...choice.tracks.map(t => new Option(t.label, t.key)));
    $('trackSelect').value = choice.track;
  } catch { $('trackSelect').disabled = true; }
}
$('trackSelect').addEventListener('change', async e => {
  const select = e.target; select.disabled = true;
  try {
    await api('/api/track', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({track:select.value})});
    showToast(`Showing the ${select.selectedOptions[0].text} search. Autoplay follows it.`, 'success');
    await Promise.all([loadStats(), loadJobs()]);
  } catch(error) { showToast(error.message, 'error'); await loadTrack(); }
  select.disabled = false;
});
loadTrack();

// Settings: every tunable parameter (jobagent/settings.py), grouped, with defaults and when a
// change takes effect. Scoring changes need "Rescore postings now".
let settingsData = [], rescoreTimer = null;
function closeSettings(){ $('settingsModal').classList.add('hidden'); $('settingsBtn').focus(); }
async function openSettings(){
  $('settingsModal').classList.remove('hidden'); $('closeSettings').focus();
  $('settingsStatus').textContent = 'Loading…';
  try { const data = await api('/api/settings'); settingsData = data.settings; renderSettings(); showRescore(data.rescore); $('settingsStatus').textContent=''; }
  catch(error){ $('settingsStatus').textContent = error.message; }
}
// ── Settings, arranged by what he is trying to change rather than by which part of the system reads it ──
const SETTING_SECTIONS=[
  ['apply','What gets applied to','Which roles the agent may apply to without asking you.'],
  ['rank','How roles are ranked','Fit and priority scoring. Changes here take effect after "Rescore postings now".'],
  ['work','How applications run','Workers, resumes, written answers and the browsers they use.'],
  ['find','Where roles are found','Scans, job-alert emails, Indeed, LinkedIn and Handshake.'],
  ['models','Which models are used','Every model choice in one place. All run on your Claude plan unless they say otherwise.'],
  ['advanced','Advanced','Timeouts, retry limits and self-tuning. These rarely need changing.'],
];
const APPLY_KEYS=new Set(['workers.auto_submit','workers.apply_internships','workers.manual_companies','review.required','workers.high_volume_weekly','profile.salary_threshold_annual','profile.max_required_experience_years','pruning.enabled','pruning.include_likely_ineligible','workers.autoplay_min_platform_success']);
// Shown straight away in each section; everything else sits under "More options".
const COMMON_KEYS=new Set([...APPLY_KEYS,'ranking.relevance_weight','ranking.urgency_weight','ranking.focus_title_boost','ranking.senior_title_penalty','ranking.salary_below_threshold_penalty','ranking.outside_us_penalty',
  'workers.max_parallelism','workers.usage_pause_percent','workers.resume_tailoring','workers.resume_tailoring_approval','workers.learned_drafts','workers.captcha_visible_handoff','workers.visible_hosts','workers.real_chrome_hosts','workers.blocked_hosts','workers.attention_soft_limit',
  'search.discovery_interval_minutes','email.enabled','indeed.enabled','linkedin.enabled','handshake.enabled','email.senders']);
function settingSection(s){
  const k=s.key;
  if(/(^|[._])model$|reword_engine$/.test(k))return 'models';
  if(APPLY_KEYS.has(k))return 'apply';
  if(/^(ranking|experience|scoring)\./.test(k)||/platform_(yield|weight)/.test(k))return 'rank';
  if(/^(search|scraping|sources|email|indeed|linkedin|handshake)\./.test(k))return 'find';
  if(/^(tuner|workday|throttle|worker|maintenance|review)\./.test(k)||/timeout|max_steps|stall|breaker|max_rejected|attempts|tries|denials|without_progress|cooldowns|max_repair/.test(k))return 'advanced';
  return 'work';
}
// Plainer wording for the settings whose registry text assumes you know the internals.
const SETTING_WORDS={
  'workers.auto_submit':['Submit finished applications without asking','A complete, validated application is submitted once. Anything that needs a personal fact or a written answer still stops for you.'],
  'workers.apply_internships':['Apply to internships','Off: only full-time roles are queued or applied to. A posting titled Intern, Internship or Co-op counts as an internship.'],
  'review.required':['Only apply to roles a model has read and judged a fit','Off: autoplay takes any role the rules match, without a model reading the posting first.'],
  'workers.manual_companies':['Companies you apply to yourself','The agent never applies to these. Separate names with commas.'],
  'workers.high_volume_weekly':['Automatic picks per week at companies with many open roles','At a company with 5 or more open roles, autoplay takes at most this many a week; you can still queue specific ones.'],
  'workers.autoplay_min_platform_success':['Skip hiring platforms that rarely submit (0 to 1)','Autoplay leaves a platform to you when its automatic submit rate is below this. 0.25 means 25%. Roles you queue yourself still run.'],
  'pruning.enabled':['Delete postings that no search track accepts','Off: they are kept and shown.'],
  'pruning.include_likely_ineligible':['Also delete "likely ineligible" postings','Senior titles and roles asking for too many years. Off: only clearly ineligible postings are deleted.'],
  'ranking.relevance_weight':['How much fit counts toward priority (0 to 1)','Priority = this × fit + the urgency weight × urgency.'],
  'ranking.urgency_weight':['How much urgency counts toward priority (0 to 1)','Urgency comes from how new the posting is and any deadline.'],
  'scoring.discipline_min_score':['Lowest score to file a role under a discipline','Below this a role is filed under "Other", which autoplay skips.'],
  'workers.autoplay_platform_weight':['Priority points for a reliable hiring platform','Roles on platforms where applications usually go through are moved up by up to this many points.'],
  'workers.scripted_actions':['Fill known answers without asking a model','Routine fields and sign-in use your saved facts directly; a model is only asked about unfamiliar questions.'],
  'workers.usage_pause_percent':['Switch to fallback models at this much Claude usage (%)','Checked every 10 minutes against your plan\'s 5-hour and weekly limits.'],
  'workers.max_parallelism':['Most applications running at once','The upper limit; fewer run when employers or your plan limit it.'],
  'workers.attention_soft_limit':['Slow down when this many items are waiting on you','New applications slow as Approvals plus Needs help approach this number.'],
  'workers.resume_tailoring':['Tailor the resume to each posting','A model picks or drafts the resume copy that best matches the posting, in your layout.'],
  'workers.resume_tailoring_approval':['Ask before using a tailored resume','Off: a tailored copy that fits one page is used without review, and the exact file sent is kept.'],
  'workers.learned_drafts':['Draft written answers for your review','Each written question is drafted from the posting, your experience and your past edits. You approve every one.'],
  'workers.captcha_visible_handoff':['Open your Chrome when a CAPTCHA cannot be solved','The form is refilled in a visible window for you to solve the CAPTCHA and submit.'],
  'workers.visible_hosts':['Sites opened in your Chrome for you to submit','The agent fills the form in a visible window; you solve the CAPTCHA and press Submit. Separate sites with commas.'],
  'workers.real_chrome_hosts':['Sites filled and submitted in your visible Chrome','For sites that block hidden browsers (tesla.com). The agent fills and submits; you solve the CAPTCHA. Cannot be empty.'],
  'workers.blocked_hosts':['Sites the agent never applies on','Postings on these sites are left for you. Separate sites with commas.'],
  'worker.lean_steps':['Use cheaper model calls for each page step','Each step is a call with no tools attached, about a tenth of the usage.'],
  'worker.site_hints':['Remember tips about each application site','After a run the agent notes non-personal things about the site, such as where a control is hidden.'],
  'tuner.enabled':['Let the matching rules correct themselves','When the title rules disagree with the reviewer and your labels often enough, revised rules are proposed and applied.'],
  'search.discovery_interval_minutes':['Minutes between scans for new roles','How often every source is checked.'],
  'email.senders':['Whose emails count as job alerts','Addresses or domains, joined with OR, as in a Gmail search.'],
  'workers.rate_limit_cooldowns':['Waits after an employer rate-limits us (minutes)','Each wait is tried in turn; after the last, the role goes to Needs help.'],
  'workers.breaker_failures':['Same failure on this many roles holds a site','New applications on that site wait while one repair is attempted.'],
};
const cleanHelp=text=>String(text||'').replace(/^(Off \()?(His|his) (choice|request)[^:)]*[):]+\s*/,'').replace(/\s+/g,' ').trim();
const settingId=s=>'set-'+s.key.replace(/[^a-z0-9]/gi,'-');
function settingInput(s){
  const id=settingId(s);
  if (s.type === 'bool') return `<label class="setting-switch"><input id="${id}" data-key="${esc(s.key)}" type="checkbox" ${s.value?'checked':''}><span>${s.value?'On':'Off'}</span></label>`;
  if (s.type === 'text') return `<textarea id="${id}" data-key="${esc(s.key)}" rows="2">${esc(s.value)}</textarea>`;
  if (s.type === 'choice') return `<select id="${id}" data-key="${esc(s.key)}">${s.choices.map(c=>`<option ${c===s.value?'selected':''}>${esc(c)}</option>`).join('')}</select>`;
  const value = s.type === 'minutes_list' ? (s.value||[]).join(', ') : s.value;
  const range = s.type === 'minutes_list' ? '' : ` inputmode="decimal" ${s.min!=null?`min="${s.min}"`:''} ${s.max!=null?`max="${s.max}"`:''} step="${s.type==='int'?1:'any'}"`;
  return `<input id="${id}" data-key="${esc(s.key)}" type="${s.type==='minutes_list'?'text':'number'}" value="${esc(String(value ?? ''))}"${range}>`;
}
const esc = escapeHTML;
let settingsSection='apply';
function settingRow(s){
  const words=SETTING_WORDS[s.key],label=words?.[0]||s.label,help=words?.[1]||cleanHelp(s.help);
  const def=s.type==='minutes_list'?(s.default||[]).join(', '):s.type==='bool'?(s.default?'on':'off'):s.default;
  const notes=[`Default: ${def===''||def==null?'empty':def}`];
  if(s.applies&&s.applies!=='next use')notes.push(`Takes effect ${s.applies}`);
  return `<div class="setting-row${s.changed?' changed':''}" data-search="${esc((label+' '+help+' '+s.label+' '+s.key).toLowerCase())}">
    <label for="${settingId(s)}"><strong>${esc(label)}</strong>${help?`<span>${esc(help)}</span>`:''}<small>${esc(notes.join(' · '))}${s.changed?' · <em>changed</em>':''}</small></label>
    <div class="setting-control">${settingInput(s)}${s.changed?`<button type="button" data-reset="${esc(s.key)}">Reset to default</button>`:''}</div></div>`;
}
function renderSettings(){
  const bySection=Object.fromEntries(SETTING_SECTIONS.map(([id])=>[id,[]]));
  for(const s of settingsData)bySection[settingSection(s)].push(s);
  const changed=settingsData.filter(s=>s.changed).length;
  $('settingsNav').innerHTML=SETTING_SECTIONS.map(([id,title])=>{const n=bySection[id].filter(s=>s.changed).length;return `<button type="button" data-section="${id}" aria-pressed="${id===settingsSection}">${esc(title)}${n?`<span>${n} changed</span>`:''}</button>`;}).join('');
  $('settingsSummary').textContent=changed?`${changed} of ${settingsData.length} settings differ from their defaults.`:`All ${settingsData.length} settings are at their defaults.`;
  $('settingsGroups').innerHTML=SETTING_SECTIONS.map(([id,title,about])=>{
    const rows=bySection[id],common=rows.filter(s=>COMMON_KEYS.has(s.key)||id==='models'),more=rows.filter(s=>!common.includes(s));
    // The less-used settings keep their original grouping as sub-headings so related ones stay together.
    const groups=[...new Set(more.map(s=>s.group))];
    const moreHTML=more.length?(common.length?`<details class="setting-more"${more.some(s=>s.changed)?' open':''}><summary>More options (${more.length})</summary>`:'')
      +groups.map(g=>`${groups.length>1?`<h4>${esc(g)}</h4>`:''}${more.filter(s=>s.group===g).map(settingRow).join('')}`).join('')+(common.length?'</details>':''):'';
    return `<section data-section="${id}"${id===settingsSection?'':' hidden'}><h3>${esc(title)}</h3><p class="setting-about">${esc(about)}</p>${common.map(settingRow).join('')}${moreHTML}</section>`;
  }).join('');
  filterSettings();
}
function filterSettings(){
  const query=($('settingsSearch')?.value||'').trim().toLowerCase(),onlyChanged=$('settingsOnlyChanged')?.checked;
  const filtering=Boolean(query)||onlyChanged;
  let shown=0;
  for(const section of document.querySelectorAll('#settingsGroups>section')){
    let any=false;
    for(const row of section.querySelectorAll('.setting-row')){
      const match=(!query||row.dataset.search.includes(query))&&(!onlyChanged||row.classList.contains('changed'));
      row.hidden=filtering&&!match;any=any||match;if(filtering&&match)shown++;
    }
    for(const more of section.querySelectorAll('.setting-more'))if(filtering)more.open=true;
    section.hidden=filtering?!any:section.dataset.section!==settingsSection;
  }
  $('settingsNav').classList.toggle('filtering',filtering);
  $('settingsEmpty').hidden=!(filtering&&!shown);
}
document.addEventListener('click',event=>{const tab=event.target.closest?.('#settingsNav button');if(!tab)return;settingsSection=tab.dataset.section;if($('settingsSearch'))$('settingsSearch').value='';if($('settingsOnlyChanged'))$('settingsOnlyChanged').checked=false;renderSettings();});
document.addEventListener('input',event=>{if(event.target.id==='settingsSearch')filterSettings();});
document.addEventListener('change',event=>{
  if(event.target.id==='settingsOnlyChanged')filterSettings();
  const toggle=event.target.closest?.('.setting-switch input');if(toggle)toggle.nextElementSibling.textContent=toggle.checked?'On':'Off';
});
function collectSettings(){
  const values = {};
  for (const s of settingsData) {
    const input = document.querySelector(`#settingsGroups [data-key="${CSS.escape(s.key)}"]`);
    if (!input) continue;
    const value = s.type==='bool' ? input.checked : input.value;
    const before = s.type==='minutes_list' ? (s.value||[]).join(', ') : s.type==='bool' ? s.value : String(s.value ?? '');
    if (String(value) !== String(before)) values[s.key] = value;
  }
  return values;
}
async function postSettings(body){
  try {
    const result = await api('/api/settings', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    settingsData = result.settings; renderSettings();
    const needs = result.needs.length ? ` Takes effect ${result.needs.join(' and ')}.` : '';
    $('settingsStatus').textContent = result.changed.length ? `Saved ${result.changed.length} change(s).${needs}` : 'Nothing changed.';
  } catch(error){ $('settingsStatus').textContent = error.message; }
}
function showRescore(state){
  if (!state) return;
  $('rescoreStatus').textContent = state.running ? 'Rescoring every posting… this takes a few minutes.' : state.error ? `Rescore failed: ${state.error}` : state.result ? `Last rescore: ${state.result.changed} changed, ${state.result.removed} removed.` : '';
  clearTimeout(rescoreTimer);
  if (state.running) rescoreTimer = setTimeout(async()=>{ try { showRescore((await api('/api/settings')).rescore); } catch{} }, 5000);
}
$('settingsSave').addEventListener('click', ()=>postSettings({values: collectSettings()}));
$('settingsGroups').addEventListener('click', e => { const key = e.target.dataset?.reset; if (key) postSettings({reset:[key]}); });
$('settingsRescore').addEventListener('click', async ()=>{ try { showRescore(await api('/api/rescore', {method:'POST'})); } catch(error){ $('rescoreStatus').textContent = error.message; } });
document.addEventListener('keydown', e => { if (e.key==='Escape' && !$('settingsModal').classList.contains('hidden')) closeSettings(); });

// Email job alerts (discovery/email_alerts.py): last check, what it found, and a manual check.
let emailTimer = null;
function describeEmail(st){
  const r = st.last_report || {};
  const when = st.last_scan_at ? new Date(st.last_scan_at).toLocaleString() : 'never';
  let text = st.running ? 'Checking your email… reading alerts and finding postings takes a few minutes.' :
    `Last check ${when}: ${r.emails ?? 0} alert email(s), ${r.postings ?? 0} posting(s) listed, ${r.skipped ?? 0} skipped (known or outside your searches), ` +
    `${r.by_link ?? 0} read from the email link, ${r.by_agent ?? 0} found by the agent on the employer's site, ${r.by_board ?? 0} read from the job board itself, ${r.not_found ?? 0} not found` +
    (r.waiting ? `; ${r.waiting} waiting to be added when the running source scan finishes.` : r.added != null ? `; ${r.added} added, ${r.not_stored ?? 0} rejected by both tracks.` : '.');
  if (st.error) text += `\nError: ${st.error}`;
  if (!st.running && st.unresolved?.length) text += `\nNot found yet: ${st.unresolved.slice(0,5).map(u=>`${u.title} at ${u.company}`).join('; ')}`;
  return text;
}
async function refreshEmailAlerts(){
  try {
    const st = await api('/api/email-alerts');
    $('emailAlertStatus').textContent = describeEmail(st);
    clearTimeout(emailTimer);
    if (st.running) emailTimer = setTimeout(refreshEmailAlerts, 5000);
  } catch(error){ $('emailAlertStatus').textContent = error.message; }
}
$('emailScanBtn').addEventListener('click', async ()=>{
  try { const st = await api('/api/email-alerts/scan', {method:'POST'}); $('emailAlertStatus').textContent = describeEmail({...st, running:true}); setTimeout(refreshEmailAlerts, 3000); }
  catch(error){ $('emailAlertStatus').textContent = error.message; }
});
$('sourcesBtn').addEventListener('click', refreshEmailAlerts);


// In the sidebar the More items are always listed; on a narrow screen they fold into a menu that closes on an outside click or Escape.
const narrowNav=window.matchMedia('(max-width: 900px)');
const syncMoreMenu=()=>{const menu=$('moreMenu');if(menu)menu.open=!narrowNav.matches;};
syncMoreMenu();narrowNav.addEventListener('change',syncMoreMenu);
document.addEventListener('click',event=>{const menu=$('moreMenu');if(narrowNav.matches&&menu?.open&&!menu.contains(event.target))menu.open=false;});
document.addEventListener('keydown',event=>{if(narrowNav.matches&&event.key==='Escape'&&$('moreMenu')?.open)$('moreMenu').open=false;});

// Approvals and Needs help open in a panel over the dashboard, like the Application Agent, instead of leaving the page.
(function(){
  const panel=$('pagePanel'),frame=$('pagePanelFrame');
  if(!panel||!frame||snapshot) return;
  const names={'/approvals':'Approvals','/help':'Needs help','/results':'Results','/profile':'Profile','/manual-selection':'Manual selection','/costs':'Application costs','/setup':'Setup'};
  const close=()=>{if(panel.hidden)return;panel.hidden=true;frame.src='about:blank';document.body.style.overflow='';};
  const open=path=>{frame.title=names[path];frame.src=path;panel.hidden=false;document.body.style.overflow='hidden';$('pagePanelClose').focus();};
  document.addEventListener('click',event=>{
    const link=event.target.closest?.('a[href]');
    if(!link||event.metaKey||event.ctrlKey||event.shiftKey||event.button)return;
    const path=new URL(link.href,location.href);
    if(path.origin!==location.origin||!names[path.pathname])return;
    event.preventDefault();{const agent=$('applicationPanel');if(agent)agent.hidden=true;}open(path.pathname+path.search);
  });
  $('pagePanelClose').addEventListener('click',close);
  panel.addEventListener('click',event=>{if(event.target===panel)close();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')close();});
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin)return;
    if(event.data?.jobagent==='close-panel')close();
    if(event.data?.jobagent==='setup-saved'){close();location.reload();}
    if(event.data?.jobagent==='open-applications'){close();window.openApplications?.();}
  });
})();
loadStates();

// A greeting for the time of day, with a little variety from one visit to the next. Each says whether his name
// reads naturally after it: "Good evening, Alex" does, "Hello night owl" already addresses him.
function greetingFor(now,pick=Math.random){
  const hour=now.getHours(),day=now.getDay(),named=text=>[text,true],alone=text=>[text,false];
  const choices=hour>=5&&hour<12?[named('Good morning'),named('Good morning'),alone('Rise and shine')]
    :hour>=12&&hour<17?[named('Good afternoon'),named('Good afternoon'),named('Welcome back')]
    :hour>=17&&hour<22?[named('Good evening'),named('Good evening'),named('Welcome back')]
    :[named('Good evening'),named('Hello'),alone('Up late'),alone('Hello night owl')];
  if(day===5&&hour>=5&&hour<22)choices.push(named('Happy Friday'));
  if(day===1&&hour>=5&&hour<12)choices.push(named('Happy Monday'));
  const [text,withName]=choices[Math.floor(pick()*choices.length)];
  return {text,withName};
}

// Set the greeting in the site's heading face, with the dark green glass finish: a soft glow underneath, a slanted
// band of lighter green repeated along the words like a reflection, and light falling to shade down each line.
function drawGreeting(svg,lines,{lineHeight=78,size=58}={}){
  const NS='http://www.w3.org/2000/svg';svg.replaceChildren();
  const make=(name,attrs,parent)=>{const node=document.createElementNS(NS,name);for(const [k,v] of Object.entries(attrs))node.setAttribute(k,v);parent.append(node);return node;};
  lines=[].concat(lines).filter(Boolean);
  const width=640,height=lineHeight*lines.length+44;
  svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
  const defs=make('defs',{},svg);
  const hue=make('linearGradient',{id:'helloHue',gradientUnits:'userSpaceOnUse',x1:0,y1:0,x2:170,y2:80,spreadMethod:'reflect'},defs);
  for(const [offset,colour] of [[0,'#123a2b'],[.35,'#1a4d3a'],[.62,'#27694f'],[.8,'#44957a'],[.9,'#27694f'],[1,'#1a4d3a']])make('stop',{offset,'stop-color':colour},hue);
  const depth=make('linearGradient',{id:'helloDepth',gradientUnits:'userSpaceOnUse',x1:0,y1:18,x2:0,y2:18+lineHeight,spreadMethod:'repeat'},defs);
  for(const [offset,opacity] of [[0,.34],[.5,0],[1,.32]])make('stop',{offset,'stop-color':offset===1?'#06170f':'#bfe8d2','stop-opacity':opacity},depth);
  make('feGaussianBlur',{stdDeviation:6},make('filter',{id:'helloGlow',filterUnits:'userSpaceOnUse',x:-30,y:-30,width:width+60,height:height+60},defs));
  lines.forEach((text,row)=>{
    for(const layer of ['glow','body','depth']){
      const node=make('text',{x:width/2,y:22+size*0.82+row*lineHeight,'text-anchor':'middle',class:`hello-text hello-${layer}`,textLength:''},svg);
      node.removeAttribute('textLength');node.textContent=text;
      // A long name or greeting is narrowed to fit instead of running off the card.
      if(node.getComputedTextLength()>width-40){node.setAttribute('textLength',width-40);node.setAttribute('lengthAdjust','spacingAndGlyphs');}
    }
  });
  return 1.4;   // seconds the fade-in takes
}

// Greeting, today's report and the assistant conversation (the card beside the filters).
(function(){
  const card=$('assistant');
  if(!card)return;
  if(snapshot){card.hidden=true;return;}
  const hello=$('assistantHello'),body=$('assistantBody'),chat=$('assistantChat'),input=$('assistantInput'),send=$('assistantSend');
  let reportTimer=null,log=null,pollTimer=null,drawn='',wasBusy=false;
  // The revolving report gives way to the conversation as soon as he asks something.
  const endReport=()=>{if(reportTimer){clearInterval(reportTimer);reportTimer=null;}$('assistantTicker').hidden=true;};
  const calm=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const show=()=>{hello.classList.add('leaving');setTimeout(()=>{hello.hidden=true;body.hidden=false;card.dataset.phase='today';},calm?0:450);};
  const say=(text,kind)=>{const bubble=document.createElement('div');bubble.className=`assistant-message ${kind}`;bubble.textContent=text;chat.append(bubble);chat.scrollTop=chat.scrollHeight;return bubble;};
  // Buttons the agent may offer for things only this page can do; everything else it does itself.
  const run={
    start_workers:()=>$('workerStart')?.click(),stop_workers:()=>$('workerStop')?.click(),
    open_approvals:()=>$('approvalsBtn')?.click(),open_help:()=>$('helpBtn')?.click(),open_results:()=>$('resultsBtn')?.click(),open_profile:()=>$('profileBtn')?.click(),
    open_agent:()=>window.openApplications?.(),scan_sources:()=>triggerSearch(),
    queue_role:action=>api('/api/applications/queue',{method:'POST',headers:{'Content-Type':'application/json','X-JobAgent-Application':'1'},body:JSON.stringify({job_ids:[action.job_id],position:action.position||'end'})}),
    search_roles:action=>{$('searchInput').value=action.query||'';loadJobs();},
    filter_states:action=>{selectedStates.clear();for(const code of action.states||[])selectedStates.add(String(code).toUpperCase());try{localStorage.setItem('jobagent.states',JSON.stringify([...selectedStates]));}catch{}loadStates();loadJobs();},
    sort_roles:action=>{$('sortSelect').value=['fit','newest','salary','company'].includes(action.sort)?action.sort:'';loadJobs();},
  };
  function offer(actions){
    if(!actions?.length)return;
    const row=document.createElement('div');row.className='assistant-actions';
    for(const action of actions){
      const button=document.createElement('button');button.type='button';button.textContent=action.label;
      button.onclick=async()=>{button.disabled=true;try{await run[action.type]?.(action);button.textContent=`Done: ${action.label}`;}catch(error){button.disabled=false;say(`That did not work: ${error.message}`,'error');}};
      row.append(button);
    }
    chat.append(row);chat.scrollTop=chat.scrollHeight;
  }
  const post=(path,body)=>api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
  // The conversation is kept by the server, so it survives a reload and shows the agent's steps as it works.
  function draw(){
    const messages=(log?.messages||[]).slice(-60),busy=Boolean(log?.busy);
    const key=`${log?.messages?.length||0}:${messages.at(-1)?.time||''}:${busy}`;
    send.textContent=busy?'Stop':'Send';input.disabled=busy;$('assistantNew').hidden=busy||!messages.length;
    if(key===drawn)return;
    drawn=key;chat.replaceChildren();
    let steps=0;
    messages.forEach((message,i)=>{
      if(message.role==='activity'){
        // A run of tool steps shows as one line: the latest step and how many came before it.
        steps++;
        if(messages[i+1]?.role!=='activity'){say(steps>1?`${message.text}  (${steps} steps)`:message.text,'activity');steps=0;}
        return;
      }
      if(message.text)say(message.text,message.role==='user'?'user':message.role==='error'?'error':'agent');
      offer(message.actions);
    });
    if(busy)say('Working…','activity');
  }
  async function poll(){
    clearTimeout(pollTimer);
    try{log=await api('/api/assistant/chat');draw();}catch{}
    if(log?.busy){wasBusy=true;pollTimer=setTimeout(poll,1200);}
    else if(wasBusy){wasBusy=false;input.focus();sync().catch(()=>{});}  // Show whatever the agent changed.
  }
  const open=()=>{endReport();card.dataset.phase='chat';};
  $('assistantForm').addEventListener('submit',async event=>{
    event.preventDefault();
    if(send.disabled)return;
    send.disabled=true;
    try{
      if(log?.busy)log=await post('/api/assistant/chat/stop');
      else{
        const text=input.value.trim();if(!text)return;
        open();log=await post('/api/assistant/chat',{text});input.value='';
      }
      draw();poll();
    }catch(error){open();say(`The assistant could not start: ${error.message}`,'error');drawn='';}
    finally{send.disabled=false;}
  });
  $('assistantNew').addEventListener('click',async()=>{
    try{log=await post('/api/assistant/chat/new');draw();input.focus();}catch(error){say(error.message,'error');drawn='';}
  });
  (async()=>{
    let data=null;
    try{data=await api('/api/assistant/report');}catch{}
    const greeting=greetingFor(new Date());
    const words=[greeting.text,greeting.withName?data?.name||'':''];
    const writeTime=drawGreeting($('helloSvg'),words);

    card.dataset.phase='hello';
    const lines=data?.lines?.length?data.lines:['Today\'s report could not be loaded. Check that JobAgent is running.'];
    const prism=$('assistantPrism'),front=$('assistantReport'),below=$('assistantReportNext'),count=$('assistantReportCount');
    let index=0;
    count.replaceChildren(...lines.map(()=>document.createElement('i')));
    const mark=()=>[...count.children].forEach((dot,i)=>dot.classList.toggle('on',i===index));
    front.textContent=lines[0];mark();
    // The box is a block seen from the front. To change line it rolls upward a quarter turn, bringing the face
    // underneath (already carrying the next line) to the front, then resets with that line on its front face.
    const turn=()=>{
      const next=(index+1)%lines.length;
      if(calm){index=next;front.textContent=lines[index];mark();return;}
      below.textContent=lines[next];prism.classList.add('rolling');
      setTimeout(()=>{index=next;front.textContent=lines[index];prism.classList.remove('rolling');mark();},700);
    };
    if(lines.length>1)reportTimer=setInterval(turn,3600);
    // Hold the greeting while it is being written, then hand over to the report.
    setTimeout(show,calm?900:Math.round(writeTime*1000+900));
    // Work still running, or a conversation from the last hour, comes back after a reload.
    try{
      log=await api('/api/assistant/chat');
      const last=Date.parse(log?.messages?.at(-1)?.time||'');
      if(log?.busy||Date.now()-last<3600e3){open();draw();poll();}
    }catch{}
  })();
})();
