(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeURL = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : null; } catch { return null; } };
  const button = (jobId, text, disabled = false) => `<button class="app-button small" type="button" data-select-job="${esc(jobId)}"${disabled ? ' disabled' : ''}>${esc(text)}</button>`;
  const removeButton = (jobId, text, disabled = false) => `<button class="app-button small remove-action" type="button" data-remove-job="${esc(jobId)}"${disabled ? ' disabled' : ''}>${esc(text)}</button>`;
  let companies = [], busy = false, refreshTimer = null;
  const adding = new Set();  // job ids whose add is in flight; adds don't block each other
  const failed = new Map();  // job id -> why its add was refused, shown on the posting itself (the top notice is often scrolled away)

  async function request(path, body) {
    const response = await fetch('/api/applications' + path, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(20000),
      headers: {'Content-Type': 'application/json', 'X-JobAgent-Application': '1'},
      body: body ? JSON.stringify(body) : undefined
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : `JobAgent returned ${response.status}.`);
    return result;
  }

  function notice(message, error = false) {
    $('notice').textContent = message;
    $('notice').classList.toggle('error', error);
    $('notice').hidden = !message;
  }

  // Rebuilding the list must not collapse the companies he has open, clear their posting filters or move the page
  // (2026-11-01: each add used to reload everything, so adding several roles meant reopening and scrolling each time).
  function keepView() {
    const open = new Set(), filters = new Map();
    document.querySelectorAll('[data-company]').forEach(el => {
      if (el.open) open.add(el.dataset.name);
      const value = el.querySelector('[data-posting-filter]')?.value;
      if (value) filters.set(el.dataset.name, value);
    });
    return {open, filters, x: window.scrollX, y: window.scrollY};
  }

  function restoreView(view) {
    document.querySelectorAll('[data-company]').forEach(el => {
      if (view.open.has(el.dataset.name)) el.open = true;
      const value = view.filters.get(el.dataset.name), input = el.querySelector('[data-posting-filter]');
      if (value && input) { input.value = value; filterPostings(input); }
    });
    window.scrollTo(view.x, view.y);
  }

  function filterPostings(input) {
    const query = input.value.trim().toLowerCase();
    input.closest('[data-company]').querySelectorAll('[data-posting]').forEach(row => {
      row.hidden = Boolean(query && !row.dataset.search.includes(query));
    });
  }

  function render() {
    const view = keepView();
    const query = $('companyFilter').value.trim().toLowerCase();
    const visible = companies.filter(c => !query || c.company.toLowerCase().includes(query));
    $('companyCount').textContent = `${visible.length} of ${companies.length} companies`;
    $('companies').innerHTML = visible.length ? visible.map(c => {
      const reasons = c.reasons.join(' · ');
      const days = Number(c.cap?.window_days ?? c.cap?.days);
      const windowLabel = !days || days >= 36500 ? 'all time' : `last ${days} days`;
      const applied = Number(c.cap?.applied || 0), queued = Number(c.cap?.queued || 0);
      const used = Number(c.cap?.used ?? applied + queued);
      const usageSummary = c.cap ? ` · ${c.cap.max == null ? `${used} used` : `${used}/${c.cap.max} used`}` : '';
      const cap = c.cap ? `${applied} applied in ${windowLabel} + ${queued} queued = ${used} counted${c.cap.max == null ? '' : ` toward ${c.cap.max} per ${windowLabel}`} · ${c.cap.status}.` : '';
      const limitWait = c.cap?.status === 'pending' ? ' Choosing a posting adds it to the list, then it waits for the cap decision in Approvals.' : '';
      const renderPosting = (p, inList) => {
        const href = safeURL(p.url);
        const title = href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(p.title)}</a>` : esc(p.title);
        const details = [p.location || 'Location not listed', p.role_type || 'Role type unknown',
          String(p.eligibility || 'unknown').replaceAll('_', ' ').toLowerCase(),
          inList ? (p.list_message || `On list · ${String(p.list_status || 'queued').replaceAll('_', ' ')}`) : adding.has(p.job_id) ? 'Adding…' : 'Available to add'].join(' · ');
        const label = inList ? 'In application list' : c.can_select ? 'Add to application list' : 'Company declined';
        const actions = inList
          ? p.applied ? '<span class="applied-badge">Applied</span>'
            : p.remove_pending ? removeButton(p.job_id, 'Stopping…', true)
              : p.removable ? removeButton(p.job_id, 'Remove from list')
                : '<span class="app-muted">Submission may be underway</span>'
          : button(p.job_id, adding.has(p.job_id) ? 'Adding…' : label, !c.can_select || adding.has(p.job_id));
        const why = !inList && failed.has(p.job_id) ? `<span class="posting-error" role="alert">Not added: ${esc(failed.get(p.job_id))}</span>` : '';
        return `<li class="app-track" data-posting data-search="${esc(`${p.title} ${p.location || ''}`.toLowerCase())}">
          <div class="app-track-main"><strong>${title}</strong><span>${esc(details)}</span>${why}</div>
          <div class="app-track-actions">${actions}</div></li>`;
      };
      const listed = c.application_list || [];
      const available = c.postings || [];
      const applicationList = listed.map(p => renderPosting(p, true)).join('');
      const postings = available.map(p => renderPosting(p, false)).join('');
      return `<details class="company" data-company data-name="${esc(c.company)}" data-search="${esc(c.company.toLowerCase())}">
        <summary><strong>${esc(c.company)}</strong> · ${c.open_roles} open roles${esc(usageSummary)} · ${esc(reasons)}</summary>
        <div class="company-info">${esc(cap)}${esc(limitWait)}</div>
        <label class="company-search">Filter postings<input type="search" data-posting-filter placeholder="Title or location"></label>
        <section class="posting-group"><h3>Application list <span>${listed.length}</span></h3>${listed.length ? `<ul class="posting-list">${applicationList}</ul>` : '<p class="empty group-empty">Nothing on the application list yet.</p>'}</section>
        <section class="posting-group"><h3>Roles you can add <span>${available.length}</span></h3>${available.length ? `<ul class="posting-list">${postings}</ul>` : '<p class="empty group-empty">No more open roles to add.</p>'}</section>
      </details>`;
    }).join('') : '<p class="empty">No companies match this search.</p>';
    restoreView(view);
  }

  // quiet: refresh in place after a change, without the loading placeholder or clearing the notice.
  async function load({quiet = false} = {}) {
    if (!quiet) $('companies').innerHTML = '<p class="empty">Loading postings…</p>';
    try {
      ({companies = []} = await request('/manual-selection'));
      if (!quiet) notice('');
      render();
    } catch (error) {
      if (!quiet) $('companies').innerHTML = '<p class="empty">Could not load the manual selection list.</p>';
      notice(error.message, true);
    }
  }

  // One quiet refresh after a burst of adds, once none is still in flight.
  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (adding.size) refreshSoon(); else load({quiet: true}); }, 1200);
  }

  // The posting moves to the company's Application list at once; the server's state replaces it on refresh.
  function moveToList(jobId) {
    for (const c of companies) {
      const i = (c.postings || []).findIndex(p => p.job_id === jobId);
      if (i < 0) continue;
      const [p] = c.postings.splice(i, 1);
      (c.application_list ||= []).push({...p, list_status: 'queued', removable: false, list_message: 'On list · queued'});
      return;
    }
  }

  $('companyFilter').addEventListener('input', render);
  $('companies').addEventListener('input', event => {
    const input = event.target.closest('[data-posting-filter]');
    if (input) filterPostings(input);
  });
  $('companies').addEventListener('click', async event => {
    const remove = event.target.closest('[data-remove-job]');
    if (remove && !busy) {
      busy = true;
      remove.disabled = true;
      remove.textContent = 'Removing…';
      try {
        const result = await request(`/jobs/${Number(remove.dataset.removeJob)}/remove`, {});
        notice(result.state === 'stopping' ? 'Stopping the application; the posting will return to Roles you can add when the worker stops.' : 'Returned to Roles you can add. The posting remains in JobAgent.');
        await load({quiet: true});
        if (result.state === 'stopping') setTimeout(() => load({quiet: true}), 1500);
      } catch (error) {
        notice(error.message, true);
        remove.disabled = false;
        remove.textContent = 'Remove from list';
      } finally { busy = false; }
      return;
    }
    const button = event.target.closest('[data-select-job]');
    const jobId = Number(button?.dataset.selectJob);
    if (!button || adding.has(jobId)) return;
    adding.add(jobId);
    failed.delete(jobId);
    button.disabled = true;
    button.textContent = 'Adding…';
    try {
      await request('/queue', {job_ids: [jobId], position: 'end', allow_other_roles: true, mark_fit: true});
      adding.delete(jobId);
      moveToList(jobId);
      render();
      notice('Added to your application list. Any employer application cap still applies.');
    } catch (error) {
      adding.delete(jobId);
      failed.set(jobId, error.message);
      notice(error.message, true);
      render();
    } finally { refreshSoon(); }
  });

  load();
})();
