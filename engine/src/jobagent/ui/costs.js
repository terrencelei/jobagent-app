(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeURL = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : null; } catch { return null; } };
  let rows = [];

  function dollars(value) {
    if (value === null || value === undefined) return 'Rate unavailable';
    if (value > 0 && value < 0.005) return '<$0.01';
    return new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2}).format(value);
  }
  function statusName(value) { return String(value || 'unknown').replaceAll('_', ' '); }
  function render() {
    const query = $('search').value.trim().toLowerCase();
    const wantedStatus = $('status').value;
    const visible = rows.filter(row => (!wantedStatus || row.status === wantedStatus) &&
      (!query || `${row.company} ${row.title}`.toLowerCase().includes(query)));
    $('visibleCount').textContent = `${visible.length} of ${rows.length} application runs`;
    $('costList').innerHTML = visible.length ? visible.map(row => {
      const href = safeURL(row.url);
      const title = href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(row.company)} · ${esc(row.title)}</a>` : `${esc(row.company)} · ${esc(row.title)}`;
      const models = row.models || [];
      const usageText = models.length ? `${row.attempt_count || 1} run${row.attempt_count === 1 ? '' : 's'} · ` + models.map(model => {
        const calls = Number.isFinite(model.calls) ? ` · ${model.calls} calls` : '';
        const tokenCount = (model.input_tokens || 0) + (model.output_tokens || 0);
        const tokens = tokenCount ? ` · ${tokenCount.toLocaleString()} tokens` : '';
        const estimateNote = model.legacy_upper_bound ? ' · older usage, upper-bound estimate' : '';
        return `${model.model}${calls}${tokens}${estimateNote}`;
      }).join(' / ') : 'No model usage recorded';
      const cost = row.estimated_cost_usd !== null && row.estimated_cost_usd !== undefined
        ? `<strong class="cost">${dollars(row.estimated_cost_usd)}</strong>`
        : row.legacy_upper_bound_usd !== null && row.legacy_upper_bound_usd !== undefined
          ? `<strong class="cost">≤${dollars(row.legacy_upper_bound_usd)}</strong>`
          : '<span class="cost unpriced">No estimate</span>';
      return `<article class="cost-row"><div><div class="app-name">${title}</div><div class="sub">${esc(usageText)}</div></div><div class="status ${esc(row.status)}">${esc(statusName(row.status))}</div>${cost}</article>`;
    }).join('') : '<p class="empty">No applications match this filter.</p>';
  }

  async function load() {
    try {
      const response = await fetch('/api/applications/costs', {headers: {'X-JobAgent-Application': '1'}, signal: AbortSignal.timeout(20000)});
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : `JobAgent returned ${response.status}.`);
      rows = result.rows || [];
      $('totalCost').textContent = result.priced_runs ? dollars(result.estimated_total_usd || 0) : 'No priced runs yet';
      $('legacyTotal').textContent = result.legacy_runs ? dollars(result.legacy_upper_bound_total_usd || 0) : '—';
      $('usageCount').textContent = `${rows.filter(row => row.has_usage).length} priced or recorded`;
      $('runCount').textContent = String(result.total_applications ?? rows.length);
      const statuses = [...new Set(rows.map(row => row.status).filter(Boolean))].sort();
      for (const value of statuses) $('status').insertAdjacentHTML('beforeend', `<option value="${esc(value)}">${esc(statusName(value))}</option>`);
      render();
    } catch (error) {
      $('totalCost').textContent = 'Unavailable';
      $('costList').innerHTML = '<p class="empty">Could not load application usage history.</p>';
      $('notice').textContent = error.message;
      $('notice').hidden = false;
    }
  }

  $('search').addEventListener('input', render);
  $('status').addEventListener('change', render);
  load();
})();
