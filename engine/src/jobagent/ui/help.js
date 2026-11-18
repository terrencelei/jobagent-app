/* Needs help: one chat agent per posting the application agent could not finish. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const rich = text => esc(text).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  const time = value => { const d = new Date(value || ''); return Number.isNaN(d.valueOf()) ? '' : d.toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}); };
  const safeURL = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : null; } catch { return null; } };
  const STATUS = {blocked: 'Stopped', needs_human: 'Needs a sign-in or verification', failed: 'Failed', interrupted: 'Interrupted', submission_unknown: 'Submission uncertain'};
  const SUGGESTIONS = ['Diagnose why this stopped and tell me what you would do', 'Fix it and put it back in the queue', 'Open it in a visible browser so I can watch'];
  let items = [], selected = Number(new URLSearchParams(location.search).get('job')) || null, chat = null, listTimer, chatTimer, sending = false, autoRepairEnabled = true, repairBusy = false;

  async function request(path, body) {
    const track = window.UIFeedback?.track || (operation => operation());
    return track(async () => {
      const response = await fetch('/api/applications' + path, {method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(20000),
        headers: {'Content-Type': 'application/json', 'X-JobAgent-Application': '1'}, body: body ? JSON.stringify(body) : undefined});
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : `The dashboard returned ${response.status}.`);
      return result;
    }, {mutation: Boolean(body)});
  }
  function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); $('notice').hidden = !message; }

  // Tick boxes and the bar above the list (his request 2026-11-14): Retry or Delete the ticked postings.
  const picked = new Set(); let bulkBusy = false;
  function renderBulk() {
    const present = new Set(items.map(i => i.id));
    for (const id of [...picked]) if (!present.has(id)) picked.delete(id);
    $('bulkBar').hidden = !items.length;
    const n = picked.size, all = $('bulkAll');
    all.checked = n > 0 && n === items.length; all.indeterminate = n > 0 && n < items.length;
    $('bulkCount').textContent = n ? `${n} selected` : 'Select all';
    $('bulkRetry').disabled = $('bulkDelete').disabled = !n || bulkBusy;
  }
  function renderList() {
    renderBulk();
    if (!items.length) { $('list').innerHTML = '<p class="empty">Nothing needs help. The agent is handling everything on its own.</p>'; return; }
    $('list').innerHTML = items.map(w => { const triage = w.background_triage || {}; const repairState = triage.state ? ` · ${triage.state.replaceAll('_', ' ')}` : '';
      return `<div class="pick-row"><input type="checkbox" class="pick" data-pick="${esc(w.id)}" aria-label="Select ${esc(w.title || 'Application')} at ${esc(w.company || '')}"${picked.has(w.id) ? ' checked' : ''}><button class="problem" data-job="${esc(w.job_id)}" aria-current="${w.job_id === selected}">
      <strong>${esc(w.title || 'Application')}</strong><span>${esc(w.company || '')}</span><span>${esc((w.message || '').slice(0, 110))}</span>
      <span class="tag${w.chat?.busy ? ' busy' : ''}">${w.chat?.busy ? 'Agent working…' : esc(STATUS[w.status] || w.status)}${esc(repairState)}${w.chat?.messages ? ' · chat' : ''}</span></button></div>`;
    }).join('');
  }


  function renderDetail() {
    const w = items.find(i => i.job_id === selected);
    if (!w) { $('detail').innerHTML = `<p class="empty">${items.length ? 'Choose a posting on the left.' : 'Nothing to resolve right now.'}</p>`; return; }
    const posting = safeURL(w.url);
    const flagged = w.status === 'submission_unknown' || w.submission_attempted || w.submitted;
    const triage = w.background_triage || {};
    const typing = document.activeElement?.id === 'compose' ? $('compose').value : null;
    $('detail').innerHTML = `<h2>${esc(w.title || 'Application')}</h2>
      <div class="meta">${esc(w.company || '')}${w.engine === 'workday' ? ' · Workday' : ''} · ${esc(STATUS[w.status] || w.status)} · ${esc(time(w.updated_at))}${posting ? ` · <a href="${esc(posting)}" target="_blank" rel="noopener noreferrer">Posting ↗</a>` : ''}</div>
      ${w.resume ? `<div class="row"><a class="app-button" href="${esc(w.resume.url)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none" title="${esc(w.resume.label)}">${w.resume.tailored ? 'Open tailored resume' : 'Open resume (standing)'}</a><span class="meta">${esc(w.resume.label)}</span></div>` : ''}
      <div class="reason">${esc(w.message || 'No reason was recorded.')}</div>
      <section class="diagnosis" aria-label="Automatic diagnosis"><strong>Diagnosis and repair</strong><p>${esc(triage.reason || (autoRepairEnabled ? 'Waiting for the background diagnosis.' : 'Automatic diagnosis is off. Start a repair here or turn it back on.'))}</p>${triage.checked_at ? `<p>Last checked ${esc(time(triage.checked_at))}</p>` : ''}${!flagged ? `<button class="app-button primary" data-act="repair-now"${repairBusy || w.chat?.busy ? ' disabled' : ''}>Diagnose and fix this posting</button>` : '<p>Submission evidence is present. Automatic retry is paused until the submission is reconciled.</p>'}</section>
      <div class="row">${flagged ? '<span class="meta">Flagged: excluded from bulk Delete. Clear this posting removes it without erasing submission evidence.</span>' : '<button class="app-button primary" data-act="retry">Retry now</button>'}<button class="app-button" data-act="mark-submitted">Mark submitted</button><button class="app-button" data-act="finish-myself" title="Fills the form in a plain Chrome window (no automation attached) and leaves the CAPTCHA and Submit to you">Finish in my Chrome</button><button class="app-button" data-act="dismiss">${flagged ? 'Clear this posting' : 'Dismiss'}</button><span class="meta">${w.retries ? `Already retried ${w.retries}× automatically.` : ''}</span></div>
      ${w.screenshot_url ? `<details><summary>Last screen</summary><img class="shot" alt="Last screen of this application" src="${esc(w.screenshot_url)}?v=${encodeURIComponent(w.updated_at || '')}"></details>` : ''}
      <div class="chat"><div class="log" id="log"></div><div id="thinking" class="thinking" hidden>The agent is working…</div>
        <div class="suggest" id="suggest">${SUGGESTIONS.map(s => `<button class="app-button small" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
        <form class="compose" id="composeForm"><label for="compose" class="meta" style="position:absolute;left:-9999px">Message the agent</label><textarea id="compose" placeholder="Ask this posting's agent anything, or tell it what to do (Enter sends, Shift+Enter for a new line)"></textarea>
          <button class="app-button primary" type="submit" id="send">Send</button><button class="app-button" type="button" data-act="stop" id="stopAgent" hidden>Stop</button></form></div>`;
    if (typing !== null) { $('compose').value = typing; $('compose').focus(); }
    renderChat();
  }

  function renderChat() {
    if (!$('log')) return;
    const messages = chat?.job_id === selected ? chat.messages : [];
    const stick = $('log').scrollHeight - $('log').scrollTop - $('log').clientHeight < 60;
    $('log').innerHTML = messages.length ? messages.map(m => `<div class="msg ${esc(m.role)}" title="${esc(time(m.time))}">${rich(m.text)}</div>`).join('')
      : '<p class="empty">No conversation yet. Start with a suggestion below, or write your own message.</p>';
    if (stick) $('log').scrollTop = $('log').scrollHeight;
    const busy = Boolean(chat?.busy);
    $('thinking').hidden = !busy; $('stopAgent').hidden = !busy; $('send').disabled = busy || sending;
    $('suggest').hidden = messages.length > 0;
  }

  async function loadList() {
    clearTimeout(listTimer);
    try {
      const data = await request('/help');
      items = data.items || [];
      autoRepairEnabled = data.auto_repair_enabled !== false;
      if (document.activeElement !== $('autoRepairToggle')) $('autoRepairToggle').checked = autoRepairEnabled;
      $('autoRepairState').textContent = autoRepairEnabled
        ? 'Technical failures are diagnosed and repaired in the background, even while application workers are stopped.'
        : 'Background diagnosis and repair is paused. You can still start a repair for an individual posting.';
      if (!items.some(i => i.job_id === selected)) selected = items[0]?.job_id ?? null;
      const before = $('detail').dataset.job;
      renderList();
      if (String(selected) !== before) { $('detail').dataset.job = String(selected); chat = null; renderDetail(); await loadChat(); }
      document.title = items.length ? `(${items.length}) Needs help · JobAgent` : 'Needs help · JobAgent';
    } catch (error) { notice(`${error.message} Open this page from the local dashboard (http://127.0.0.1:8000/help).`, true); }
    finally { listTimer = setTimeout(loadList, 5000); }
  }

  async function loadChat() {
    clearTimeout(chatTimer);
    if (!selected) return;
    try { chat = await request(`/help/${selected}/chat`); renderChat(); } catch (error) { notice(error.message, true); }
    finally { chatTimer = setTimeout(loadChat, chat?.busy ? 1200 : 4000); }
  }

  async function send(text) {
    if (!text.trim() || sending || !selected) return;
    sending = true; $('send').disabled = true;
    try { chat = await request(`/help/${selected}/chat`, {text}); $('compose').value = ''; notice(''); renderChat(); loadChat(); }
    catch (error) { notice(error.message, true); }
    finally { sending = false; if ($('send')) $('send').disabled = Boolean(chat?.busy); }
  }

  document.addEventListener('click', async event => {
    const problem = event.target.closest('.problem');
    if (problem) { selected = Number(problem.dataset.job); history.replaceState(null, '', `?job=${selected}`); renderList(); $('detail').dataset.job = String(selected); chat = null; renderDetail(); loadChat(); return; }
    const suggestion = event.target.closest('[data-suggest]');
    if (suggestion) { send(suggestion.dataset.suggest); return; }
    const act = event.target.closest('[data-act]')?.dataset.act;
    if (!act || !selected) return;
    try {
      if (act === 'stop') { await request(`/help/${selected}/chat/stop`, {}); loadChat(); }
      else if (act === 'retry') { await request(`/jobs/${selected}/retry-parked`, {}); notice('Queued. The application agent will try it again next.'); loadList(); }
      else if (act === 'finish-myself') { await request(`/jobs/${selected}/finish-myself`, {}); notice('Opening Chrome and filling the form. When it says ready, solve any CAPTCHA and press Submit in that window; it leaves Needs help once the employer confirms.'); loadList(); }
      else if (act === 'mark-submitted') { await request(`/jobs/${selected}/mark-submitted`, {}); notice('Marked submitted and moved to Applied. Removed from Needs help.'); loadList(); }
      else if (act === 'repair-now') { repairBusy = true; try { await request(`/help/${selected}/repair`, {}); notice('Diagnosis started. The repair agent will verify any fix before requeuing this posting.'); loadList(); loadChat(); } finally { repairBusy = false; } }
      else if (act === 'dismiss') { await request(`/jobs/${selected}/dismiss`, {}); notice('Cleared this posting. It was not requeued; history and any submission warning are preserved.'); loadList(); }
    } catch (error) { notice(error.message, true); }
  });
  $('autoRepairToggle').addEventListener('change', async event => {
    const enabled = event.target.checked;
    event.target.disabled = true;
    try {
      const result = await request('/help/auto-repair', {enabled});
      autoRepairEnabled = result.enabled;
      $('autoRepairState').textContent = autoRepairEnabled
        ? 'Technical failures are diagnosed and repaired in the background, even while application workers are stopped.'
        : 'Background diagnosis and repair is paused. You can still start a repair for an individual posting.';
      notice(autoRepairEnabled ? 'Automatic diagnosis and repair is on.' : 'Automatic diagnosis and repair is off.');
      loadList();
    } catch (error) { event.target.checked = autoRepairEnabled; notice(error.message, true); }
    finally { event.target.disabled = false; }
  });
  document.addEventListener('submit', event => { if (event.target.id === 'composeForm') { event.preventDefault(); send($('compose').value); } });
  // Enter sends; Shift+Enter inserts a newline (his request, 2026-10-19). Composition (IME) Enter is left alone.
  document.addEventListener('keydown', event => { if (event.target.id === 'compose' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send($('compose').value); } });
  $('list').addEventListener('change', event => {
    const box = event.target.closest('[data-pick]'); if (!box) return;
    box.checked ? picked.add(box.dataset.pick) : picked.delete(box.dataset.pick); renderBulk();
  });
  $('bulkAll').addEventListener('change', () => {
    const on = $('bulkAll').checked; picked.clear(); if (on) for (const item of items) picked.add(item.id);
    renderList();
  });
  async function bulk(work) {
    if (bulkBusy || !picked.size) return;
    bulkBusy = true; renderBulk();
    try { notice(await work(items.filter(item => picked.has(item.id)))); picked.clear(); }
    catch (error) { notice(error.message, true); }
    finally { bulkBusy = false; await loadList(); }
  }
  $('bulkDelete').addEventListener('click', () => bulk(async chosen => {
    const result = await request('/help/clear', {ids: chosen.map(item => item.id)});
    if (chosen.some(item => item.job_id === selected)) { selected = null; chat = null; clearTimeout(chatTimer); history.replaceState(null, '', location.pathname); }
    return `Deleted ${result.cleared} of ${chosen.length}. They were removed, not requeued; history is saved.${result.blocked_remaining ? ` ${result.blocked_remaining} with submission evidence remain; clear those one at a time.` : ''}${result.active_remaining ? ` ${result.active_remaining} still running were left alone.` : ''}`;
  }));
  $('bulkRetry').addEventListener('click', () => bulk(async chosen => {
    let queued = 0; const refused = [];
    for (const item of chosen) {
      // A posting whose submission is uncertain is never rerun from here: that could apply twice.
      if (item.status === 'submission_unknown' || item.submission_attempted || item.submitted) { refused.push(`${item.company || item.title}: submission must be checked first`); continue; }
      try { await request(`/jobs/${item.job_id}/retry-parked`, {}); queued++; }
      catch (error) { refused.push(`${item.company || item.title}: ${error.message}`); }
    }
    return `Queued ${queued} of ${chosen.length} to try again.${refused.length ? ` Not retried: ${refused.slice(0, 3).join('; ')}${refused.length > 3 ? '; …' : ''}` : ''}`;
  }));
  loadList();
})();
