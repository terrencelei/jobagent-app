/* Approvals page: answer flagged questions, approve finished applications, unblock sign-ins. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const time = value => { const d = new Date(value || ''); return Number.isNaN(d.valueOf()) ? '' : d.toLocaleString([], {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'}); };
  const safeURL = value => { try { const u = new URL(value); return ['https:','http:'].includes(u.protocol) ? u.href : null; } catch { return null; } };
  const drafts = new Map();  // card id -> {field: value}, so a refresh never wipes what he is typing
  const heights = new Map();  // textarea id -> height he dragged it to, kept across refreshes
  const resolvedCards = new Map();
  const approvalSignature = w => JSON.stringify([w.status, w.questions, w.review, w.message]);
  let revision = 0;
  let busy = false, timer, currentApprovals = [];

  async function request(path, body) {
    const track = window.UIFeedback?.track || (operation => operation());
    return track(async () => {
      const response = await fetch('/api/applications' + path, {method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(15000),
        headers: {'Content-Type': 'application/json', 'X-JobAgent-Application': '1'}, body: body ? JSON.stringify(body) : undefined});
      const result = await response.json().catch(() => ({}));
      // FastAPI validation errors arrive as a list; show what was wrong rather than a bare status code.
      const detail = typeof result.detail === 'string' ? result.detail : Array.isArray(result.detail) ? result.detail.map(d => `${(d.loc || []).slice(-1)[0] || 'request'}: ${d.msg}`).join('; ') : '';
      if (!response.ok) throw new Error(detail || `Approvals service returned ${response.status}.`);
      return result;
    }, {mutation: Boolean(body)});
  }
  function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); $('notice').hidden = !message; }

  const GROUPS = [
    ['Questions to answer', w => w.status === 'needs_approval' || w.status === 'waiting_answers'],
    ['Ready to submit', w => ['ready_to_submit', 'waiting_review', 'awaiting_review'].includes(w.status)],
    ['Verify your account', w => w.status === 'needs_verification'],
    ['Resume to tailor', w => w.status === 'needs_resume'],
    ['Waiting on an application limit', w => w.status === 'needs_cap_approval'],
  ];

  // Employer limits on applications: nothing is sent to a company with an undecided or declined
  // limit; an allowed limit is enforced by the workers.
  const windowText = days => !days ? 'no time window stated' : days % 365 === 0 ? `${days / 365} year${days === 365 ? '' : 's'}` : days % 30 === 0 ? `${days / 30} month${days === 30 ? '' : 's'}` : `${days} days`;
  function capCard(c) {
    const k = esc(c.company), used = c.used == null ? '' : ` You have ${c.used} recorded application${c.used === 1 ? '' : 's'} there${c.days ? ` in the last ${windowText(c.days)}` : ''}.`;
    const where = c.url && safeURL(c.url) ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.source || 'source')}</a>` : esc(c.source || '');
    const limit = !c.max ? 'a limit' : `${c.max} application${c.max === 1 ? '' : 's'}${c.days ? ` per ${windowText(c.days)}` : ' in total (no time window stated)'}`;
    if (c.status !== 'pending') {
      return `<li><strong>${k}</strong>: ${esc(limit)} · ${c.status === 'approved' ? 'allowed, limit enforced' : 'declined, not applying'}
        <button class="app-button small" data-cap="${k}" data-allow="${c.status === 'approved' ? 'false' : 'true'}">${c.status === 'approved' ? 'Stop applying' : 'Allow'}</button></li>`;
    }
    return `<article class="card"><div class="card-head"><div><strong>${k}</strong><div class="meta">States ${esc(limit)} · found on ${where}</div></div></div>
      <blockquote class="reason">“${esc(c.quote || '')}”</blockquote><p class="hint">Nothing is sent to ${k} until you decide.${used}</p>
      <form class="app-form" data-cap-form="${k}"><div class="row"><label>Most applications <input name="max" type="number" min="1" value="${esc(c.max ?? '')}" style="width:6em"></label>
        <label>per days (blank = no window) <input name="days" type="number" min="1" value="${esc(c.days ?? '')}" style="width:6em"></label></div>
        <div class="row"><button class="app-button primary" type="submit">Allow within this limit</button><button class="app-button" type="button" data-cap="${k}" data-allow="false">Don't apply to ${k}</button></div></form></article>`;
  }
  function renderCaps(caps) {
    const pending = caps.filter(c => c.status === 'pending'), decided = caps.filter(c => c.status !== 'pending');
    $('caps').innerHTML = (pending.length ? `<h2 id="capsTitle">Application limits <span class="badge warn">${pending.length}</span></h2>${pending.map(capCard).join('')}` : '')
      + `<details class="card"><summary>Employer limits you have decided (${decided.length}) · add one</summary><ul>${decided.map(capCard).join('')}</ul>
        <form class="app-form" data-cap-new><div class="row"><input name="company" placeholder="Company" required><input name="max" type="number" min="1" placeholder="Most applications" required style="width:10em"><input name="days" type="number" min="1" placeholder="per days" style="width:7em">
        <button class="app-button" type="submit">Add limit</button></div></form></details>`;
  }
  async function refreshCaps(force = false) {
    if (!force && document.activeElement?.closest('#caps form')) return;  // never redraw under his typing
    const version = revision;
    try {
      const {caps} = await request('/caps');
      // Focus may have entered a limit form while its response was in flight.
      if (version === revision && (force || !document.activeElement?.closest('#caps form'))) renderCaps(caps || []);
    } catch {}
  }

  function field(card, q, i) {
    const id = `${card}-q${i}`, name = q.name ?? q.label, saved = drafts.get(card)?.[name];
    const placeholder = value => /^(?:select(?: one)?|please select(?: one)?|choose an? (?:answer|option))[.\s…]*$/i.test(String(value ?? ''));
    const value = placeholder(saved) ? q.draft ?? '' : saved ?? q.draft ?? '';
    const required = q.required ? ' required' : '';
    let input;
    if (q.options?.length) input = `<select id="${id}" name="${esc(name)}"${required}><option value="">Choose an answer</option>${q.options.filter(o => !placeholder(o)).map(o => `<option${String(o) === String(value) ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    else if (q.type === 'textarea' || q.draft || q.maxWords) input = `<textarea id="${id}" class="grow" name="${esc(name)}" rows="4"${heights.has(id) ? ` style="height:${heights.get(id)}px"` : ''}${required}>${esc(value)}</textarea>`
      + `<div class="grow-handle" data-grow="${id}" role="separator" aria-orientation="horizontal" aria-label="Resize this answer box (drag, or arrow keys)" tabindex="0"></div>`;
    else input = `<input id="${id}" name="${esc(name)}" value="${esc(value)}"${required}>`;
    const hints = [q.draft && saved === undefined ? 'Suggested draft. Edit it or replace it; what you approve is submitted word for word.' : '', q.maxWords ? `Limit: ${q.maxWords} words.` : '', q.note || ''].filter(Boolean);
    if (q.cover_letter) hints.push('Uploaded as a one-page PDF under your resume letterhead (name and contact line) with today\'s date. Write the full letter, greeting and sign-off included.');
    const preview = q.cover_letter ? `<button class="app-button small" type="button" data-letter-preview="${id}">Preview as PDF</button>` : '';
    return `<label for="${id}">${esc(q.label)}${q.required ? ' *' : ''}</label>${input}${hints.map(h => `<p class="hint">${esc(h)}</p>`).join('')}${preview}`;
  }

  // Tailored resume drafts: preview in his exact layout, edit here or in Word, then approve before it is submitted.
  const draftURL = (job, kind) => `/api/applications/jobs/${job}/resume/draft.${kind}`;
  function fitText(d) {
    if (!d) return '';
    const c = d.coverage || {}, page = d.fit?.fits ? 'Fits on one page.' : `Runs ${d.fit?.lines_over} line${d.fit?.lines_over === 1 ? '' : 's'} past one page; shorten it before approving.`;
    return `${page} Posting keywords in this draft: ${(c.found || []).length} of ${c.total || 0}.${(c.missing || []).length ? ` Missing: ${c.missing.join(', ')}.` : ''}`;
  }
  function editor(resume) {
    return (resume?.sections || []).map((s, si) => `<fieldset class="resume-section" data-si="${si}"><legend>${esc(s.title)}</legend>${s.kind === 'skills'
      ? (s.lines || []).map((l, li) => `<div class="resume-row" data-li="${li}"><input data-f="label" value="${esc(l.label)}" aria-label="Skill group"><input data-f="text" value="${esc(l.text)}" aria-label="Skills"></div>`).join('')
      : (s.entries || []).map((e, ei) => `<div class="resume-entry" data-ei="${ei}"><div class="resume-row">${['org', 'dates', 'role', 'location'].map(f => `<input data-f="${f}" value="${esc(e[f])}" placeholder="${f === 'org' ? 'Organization' : f[0].toUpperCase() + f.slice(1)}" aria-label="${f}">`).join('')}</div>
          ${(e.bullets || []).map(b => `<textarea data-b rows="2" aria-label="Bullet">${esc(b)}</textarea>`).join('')}<button class="app-button small" type="button" data-add-bullet>+ Bullet</button></div>`).join('')}</fieldset>`).join('');
  }
  function collect(root, resume) {
    const out = JSON.parse(JSON.stringify(resume));
    root.querySelectorAll('.resume-section').forEach(fs => {
      const s = out.sections[Number(fs.dataset.si)];
      if (s.kind === 'skills') fs.querySelectorAll('[data-li]').forEach(row => { s.lines[Number(row.dataset.li)] = {label: row.querySelector('[data-f="label"]').value, text: row.querySelector('[data-f="text"]').value}; });
      else fs.querySelectorAll('[data-ei]').forEach(div => {
        const e = s.entries[Number(div.dataset.ei)];
        div.querySelectorAll('.resume-row [data-f]').forEach(input => { e[input.dataset.f] = input.value; });
        e.bullets = [...div.querySelectorAll('[data-b]')].map(t => t.value.trim()).filter(Boolean);  // an emptied bullet is removed
      });
    });
    return out;
  }
  function resumeCard(w, head, key, job) {
    const r = w.resume_review || {}, d = w.resume_draft, variants = w.resume_variants || [], base = r.base_coverage;
    const verify = (r.verify || []).length ? `<div class="resume-verify"><strong>Check these before approving</strong> (not stated outright in your resumes or profile):<ul>${r.verify.map(v => `<li>${esc(v)}</li>`).join('')}</ul></div>` : '';
    const pick = variants.length ? `<div class="row"><select name="variant_id" aria-label="Saved resume">${variants.map(v => `<option value="${esc(v.id)}">${esc(v.label)}</option>`).join('')}</select><button class="app-button" type="button" data-resume="variant">Use this saved resume instead</button></div>` : '';
    return `${head}<p class="reason">${esc(w.message)}</p>${r.summary ? `<p class="reason">${esc(r.summary)}</p>` : ''}
      ${base ? `<p class="meta">Your standing resume has ${(base.found || []).length} of ${base.total} of this posting's keywords.</p>` : ''}${verify}
      <div class="resume-tools app-form" data-resume-job="${job}" data-card="${esc(key)}">
        <p class="hint" data-fit>${esc(fitText(d))}</p>
        <a href="${draftURL(job, 'pdf')}" target="_blank" rel="noopener" title="Open the PDF that will be submitted"><img class="resume-preview" alt="Tailored resume preview" src="${draftURL(job, 'png')}?v=${encodeURIComponent(w.updated_at || '')}"></a>
        <p class="hint"><a href="${draftURL(job, 'pdf')}" target="_blank" rel="noopener">Open the PDF ↗</a></p>
        <details class="resume-editor"><summary>Edit the text here</summary><div data-editor>${editor(d?.resume)}</div>
          <div class="row"><button class="app-button" type="button" data-resume-save>Save &amp; preview</button></div></details>
        <div class="row"><a class="app-button" href="${draftURL(job, 'docx')}" download>Download Word copy</a>
          <label class="app-button">Upload edited Word copy<input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" data-resume-docx hidden></label></div>
        <p class="hint">Edit text in Word, keep its paragraph styles, and upload it back; an upload replaces the whole draft, so download again after saving edits here. The PDF is always regenerated in your resume's exact layout (margins, fonts, sizes), whatever Word shows. Employers see it as your resume file name.</p>
        <label for="${esc(key)}-label">Name it for reuse</label><input id="${esc(key)}-label" name="label" value="${esc(r.focus || '')}">
        <div class="row"><button class="app-button primary" type="button" data-resume="approve">Approve resume &amp; apply</button><button class="app-button" type="button" data-resume="current" title="You won't get drafts for ${esc(r.focus || 'this area')} again.">Apply with my standing resume</button><button class="app-button" type="button" data-act="dismiss" data-job="${job}">Skip this role</button></div>
        ${pick}
        <div class="row"><label class="app-button small">Upload my own PDF instead<input type="file" accept="application/pdf" data-resume-pdf hidden></label></div>
      </div>`;
  }
  async function saveDraft(tools, w) {
    const job = tools.dataset.resumeJob, root = tools.querySelector('[data-editor]');
    const d = await request(`/jobs/${job}/resume/draft`, {resume: collect(root, w.resume_draft.resume)});
    afterDraft(tools, w, d);
    return d;
  }
  function afterDraft(tools, w, d) {
    w.resume_draft = d;
    tools.dataset.dirty = '';
    tools.querySelector('[data-fit]').textContent = fitText(d);
    tools.querySelector('.resume-preview').src = `${draftURL(tools.dataset.resumeJob, 'png')}?v=${Date.now()}`;
    const editorRoot = tools.querySelector('[data-editor]');
    if (!editorRoot.contains(document.activeElement)) editorRoot.innerHTML = editor(d.resume);
  }
  // Answer boxes grow only in height, from a grip centred under the box (his request, 2026-10-22).
  const setHeight = (box, h) => { const px = Math.max(60, Math.round(h)); box.style.height = `${px}px`; heights.set(box.id, px); };
  document.addEventListener('pointerdown', event => {
    const handle = event.target.closest('.grow-handle');
    if (!handle) return;
    const box = document.getElementById(handle.dataset.grow);
    if (!box) return;
    event.preventDefault();
    const start = event.clientY, from = box.getBoundingClientRect().height;
    handle.setPointerCapture(event.pointerId);
    const move = e => setHeight(box, from + e.clientY - start);
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  });
  document.addEventListener('keydown', event => {
    const handle = event.target.closest?.('.grow-handle');
    if (!handle || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const box = document.getElementById(handle.dataset.grow);
    if (!box) return;
    event.preventDefault();
    setHeight(box, box.getBoundingClientRect().height + (event.key === 'ArrowDown' ? 24 : -24));
  });
  const readFile = file => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
  document.addEventListener('change', async event => {
    const tools = event.target.closest('.resume-tools');
    if (!tools || !event.target.files?.length) return;
    const file = event.target.files[0], job = tools.dataset.resumeJob, w = currentApprovals.find(a => String(a.job_id) === job);
    event.target.value = '';
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('That file is over 10 MB.');
      if (event.target.matches('[data-resume-docx]')) {
        afterDraft(tools, w, await request(`/jobs/${job}/resume/docx`, {data: await readFile(file)}));
        notice('Word edits loaded into the draft. Check the preview, then approve.');
      } else if (event.target.matches('[data-resume-pdf]')) {
        act(`/jobs/${job}/resume`, {choice: 'upload', label: tools.querySelector('[name="label"]').value, data: await readFile(file)}, 'Your PDF is saved to your resume library. That role applies with it next.', tools.dataset.card);
      }
    } catch (error) { notice(error.message, true); }
  });
  document.addEventListener('input', event => { const tools = event.target.closest('.resume-tools [data-editor]')?.closest('.resume-tools'); if (tools) tools.dataset.dirty = '1'; });

  function card(w) {
    const key = w.id, posting = safeURL(w.url);
    const head = `<div class="card-head"><div><strong>${esc(w.title || 'Application')}</strong><div class="meta">${esc(w.company || '')}${w.engine === 'workday' ? ' · Workday' : ''}${w.source === 'autoplay' ? ' · from your priority list' : ''}</div></div><div class="meta">${esc(time(w.updated_at))}${posting ? ` · <a href="${esc(posting)}" target="_blank" rel="noopener noreferrer">Posting ↗</a>` : ''}</div></div>`;
    const shot = w.screenshot_url ? `<img class="shot" alt="Last screen of this application" src="${esc(w.screenshot_url)}?v=${encodeURIComponent(w.updated_at || '')}">` : '';
    const job = esc(w.job_id);
    if (w.status === 'needs_approval' || w.status === 'waiting_answers') {
      const questions = w.questions || [];
      const live = w.status === 'waiting_answers';
      return `${head}<p class="reason">${live ? 'A worker is paused on this question.' : `${questions.length} new question${questions.length === 1 ? '' : 's'}. Your approved edits are remembered. General answers carry across employers; approved writing helps draft similar answers for your review.`}</p>
        <form class="app-form" data-form="${live ? 'live' : 'answers'}" data-job="${job}" data-card="${esc(key)}">${questions.map((q, i) => field(key, live ? {...q, name: q.id} : q, i)).join('')}
        <div class="row"><button class="app-button primary" type="submit">${live ? 'Save answer & continue' : 'Approve answers & continue'}</button>${live ? '' : `<button class="app-button" type="button" data-act="dismiss" data-job="${job}">Skip this role</button>`}</div></form>${shot}`;
    }
    if (w.status === 'needs_resume') return resumeCard(w, head, key, job);
    if (w.status === 'needs_cap_approval') {
      return `${head}<p class="reason">${esc(w.message || `${w.company} limits how many applications one person may send.`)} Decide under Application limits above; this role continues if you allow it.</p>${shot}`;
    }
    if (w.status === 'ready_to_submit') {
      const review = w.review;
      const text = 'Every answer is filled and validated; this form is submitted once, exactly as shown.';
      return `${head}<p class="reason">${text}</p>${review ? `<dl class="app-review">${(review.answers || []).map(a => `<dt>${esc(a.label)}</dt><dd>${esc(a.value)}</dd>`).join('')}</dl>` : ''}${shot}
        <p class="meta">Submitting automatically under your standing authorization; no approval is needed.</p>`;
    }
    if (w.status === 'waiting_review' || w.status === 'awaiting_review') {
      const review = w.review || {};
      return `${head}<p class="reason">Check the answers and the screen, then approve this one submission.</p><dl class="app-review">${(review.answers || []).map(a => `<dt>${esc(a.label)}</dt><dd>${esc(a.value)}</dd>`).join('')}</dl>${shot}
        <p class="meta">This application submits automatically; no approval is needed.</p>`;
    }
    if (w.status === 'needs_verification') {
      return `${head}<p class="reason">${esc(w.message)}</p><form class="app-form" data-form="verify" data-job="${job}" data-card="${esc(key)}"><label for="${esc(key)}-link">Verification link from the Workday email</label><input id="${esc(key)}-link" name="link" type="url" placeholder="https://….myworkdayjobs.com/…" required value="${esc(drafts.get(key)?.link ?? '')}"><div class="row"><button class="app-button primary" type="submit">Verify &amp; continue</button><button class="app-button" type="button" data-act="retry-parked" data-job="${job}">Check my email again</button></div></form>`;
    }
    if (w.status === 'needs_human') {
      return `${head}<p class="reason">${esc(w.message || 'This site needs a sign-in or verification the agent cannot do.')} You can apply on the posting yourself, try again later, or dismiss it.</p>${shot}
        <div class="row"><button class="app-button primary" data-act="retry-parked" data-job="${job}">Try again</button><button class="app-button" data-act="dismiss" data-job="${job}">Dismiss</button></div>`;
    }
    return `${head}<p class="reason">${esc(w.message || 'This run stopped.')}</p>${shot}
      <div class="row"><button class="app-button primary" data-act="retry-parked" data-job="${job}">Try again</button><button class="app-button" data-act="dismiss" data-job="${job}">Dismiss</button></div>`;
  }

  function render(items) {
    const content = $('content');
    const focused = document.activeElement?.closest('article[data-card]');
    const wanted = new Set();
    // Reconcile cards in place. Detaching even an unchanged focused card closes native
    // selects and loses the caret; putting that same node back cannot restore either.
    for (const [index, [title, test]] of GROUPS.entries()) {
      let group = content.querySelector(`[data-approval-group="${index}"]`);
      if (!group) {
        group = document.createElement('section');
        group.dataset.approvalGroup = String(index);
        group.innerHTML = '<h2></h2><div class="approval-cards"></div>';
        content.append(group);
      }
      const cards = group.querySelector('.approval-cards');
      for (const w of items.filter(test)) {
        wanted.add(String(w.id));
        let article = [...content.querySelectorAll('article[data-card]')].find(a => a.dataset.card === String(w.id));
        const signature = JSON.stringify([w.status, w.updated_at, w.questions, w.review]);
        if (!article) {
          article = document.createElement('article');
          article.className = 'card';
          article.dataset.card = String(w.id);
          cards.append(article);
        }
        if (article !== focused) {
          if (article.parentElement !== cards) cards.append(article);
          if (article.dataset.sig !== signature) {
            article.innerHTML = card(w);
            article.dataset.sig = signature;
          }
        }
      }
    }
    for (const article of content.querySelectorAll('article[data-card]')) {
      // Focus protects an existing editor, never a resolved approval's old button.
      if (!wanted.has(article.dataset.card)) article.remove();
    }
    for (const [index, [title]] of GROUPS.entries()) {
      const group = content.querySelector(`[data-approval-group="${index}"]`);
      const count = group.querySelector('.approval-cards').children.length;
      group.hidden = !count;
      group.querySelector('h2').innerHTML = `${esc(title)} <span class="badge${title === 'Verify your account' ? ' warn' : ''}">${count}</span>`;
    }
    const hasCards = Boolean(content.querySelector('article[data-card]'));
    let empty = content.querySelector(':scope > .app-empty');
    if (hasCards) empty?.remove();
    else {
      if (!empty) { empty = document.createElement('p'); empty.className = 'app-empty'; content.append(empty); }
      empty.textContent = 'Nothing needs you right now. Workers keep going through Up next, and anything new shows up here.';
    }
  }

  function showApprovals(approvals) {
    currentApprovals = approvals; $('clearList').disabled = busy || !approvals.length;
    render(approvals);
    document.title = approvals.length ? `(${approvals.length}) Approvals · JobAgent` : 'Approvals · JobAgent';
  }

  async function refresh(forceCaps = false) {
    clearTimeout(timer);
    const version = revision;
    try {
      const [{approvals}, {items}] = await Promise.all([request('/approvals'), request('/help')]);
      if (version !== revision) return; // A poll started before an accepted action is stale.
      $('helpLink').hidden = !items.length; $('helpLink').textContent = `${items.length} posting${items.length === 1 ? '' : 's'} the agent could not finish → Needs help`;
      showApprovals(approvals.filter(w => {
        if (!resolvedCards.has(String(w.id))) return true;
        // Parked approvals resume as a NEW run id. The old posting card is done,
        // including delayed snapshots with changed messages or suggested drafts.
        if (resolvedCards.get(String(w.id)) === null) return false;
        // Live workers can briefly return the question whose answer was just queued.
        if (resolvedCards.get(String(w.id)) === approvalSignature(w)) return false;
        resolvedCards.delete(String(w.id)); // A genuinely new question/review is actionable.
        return true;
      }));
      refreshCaps(forceCaps); }
    catch (error) { if (version === revision) notice(`${error.message} Open this page from the local dashboard (http://127.0.0.1:8000/approvals).`, true); }
    finally { timer = setTimeout(refresh, 4000); }
  }

  async function act(path, body, success, keyToClear) {
    if (busy) { window.UIFeedback?.notify('Another change is still being saved.'); return; } busy = true;
    try {
      const result = await request(path, body); if (keyToClear) drafts.delete(keyToClear);
      revision++;
      const job = path.match(/^\/jobs\/(\d+)\//)?.[1];
      const completedJobs = new Set([job, ...(result?.also_resumed || []).map(String)]);
      showApprovals(currentApprovals.filter(w => {
        const completed = completedJobs.has(String(w.job_id)) ||
          (path === '/caps' && w.company === body.company && w.status === 'needs_cap_approval');
        if (completed) {
          const liveDecision = /\/command$/.test(path) && ['answer', 'approve'].includes(body.action);
          resolvedCards.set(String(w.id), liveDecision ? approvalSignature(w) : null);
          drafts.delete(String(w.id));
        }
        return !completed;
      }));
      const others = result?.also_resumed?.length || 0;
      notice(others ? `${success} Your answer also sent ${others} other application${others === 1 ? '' : 's'} waiting on the same question back to the queue.` : success);
      refresh(path === '/caps'); // The accepted action is complete; polling must not block the next card.
    }
    catch (error) { notice(error.message, true); }
    finally { busy = false; $('clearList').disabled = !currentApprovals.length; }
  }

  document.addEventListener('input', event => {
    const form = event.target.closest('form[data-card]');
    if (!form) return;
    const values = {};
    for (const el of form.querySelectorAll('[name]')) if (el.type !== 'file') values[el.name] = el.value;
    drafts.set(form.dataset.card, values);
  });
  document.addEventListener('submit', event => {
    const capForm = event.target.closest('form[data-cap-form],form[data-cap-new]');
    if (capForm) {
      event.preventDefault();
      const v = Object.fromEntries(new FormData(capForm));
      const company = capForm.dataset.capForm || v.company;
      act('/caps', {company, allow: true, max: v.max ? Number(v.max) : null, days: v.days ? Number(v.days) : null},
          `Allowed: ${company} within ${v.max || 'its'} application limit. Roles there continue.`);
      return;
    }
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    const job = encodeURIComponent(form.dataset.job), values = {};
    for (const el of form.querySelectorAll('[name]')) values[el.name] = el.value;
    if (form.dataset.form === 'verify') act(`/jobs/${job}/verify`, {link: values.link}, 'Verification link saved. That role continues next.', form.dataset.card);
    else if (form.dataset.form === 'live') act(`/jobs/${job}/command`, {action: 'answer', answers: values}, 'Answer sent to the waiting worker.', form.dataset.card);
    else act(`/jobs/${job}/approve-answers`, {answers: values}, 'Approved and removed from Approvals. That role goes to the front of the queue and continues next.', form.dataset.card);
  });
  document.addEventListener('click', event => {
    const letter = event.target.closest('[data-letter-preview]');
    if (letter) {
      const text = document.getElementById(letter.dataset.letterPreview)?.value || '';
      const tab = window.open('', '_blank');
      fetch('/api/applications/cover-letter/preview', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-JobAgent-Application': '1'}, body: JSON.stringify({text})})
        .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Preview failed'); return r.blob(); })
        .then(blob => { tab.location = URL.createObjectURL(blob); })
        .catch(error => { tab?.close(); notice(error.message, true); });
      return;
    }
    const tools = event.target.closest('.resume-tools');
    if (tools) {
      const job = tools.dataset.resumeJob, w = currentApprovals.find(a => String(a.job_id) === job);
      if (event.target.closest('[data-add-bullet]')) {
        const t = document.createElement('textarea'); t.dataset.b = ''; t.rows = 2; t.setAttribute('aria-label', 'Bullet');
        event.target.closest('[data-add-bullet]').before(t); t.focus(); tools.dataset.dirty = '1';
        return;
      }
      if (event.target.closest('[data-resume-save]')) {
        saveDraft(tools, w).then(() => notice('Draft saved. The preview shows exactly what will be submitted.')).catch(error => notice(error.message, true));
        return;
      }
      const choice = event.target.closest('[data-resume]')?.dataset.resume;
      if (!choice) return;
      const label = tools.querySelector('[name="label"]').value;
      if (choice === 'approve') {
        // Approve exactly what the preview shows: unsaved edits are saved first.
        (tools.dataset.dirty ? saveDraft(tools, w) : Promise.resolve()).then(() =>
          act(`/jobs/${job}/resume`, {choice: 'approve', label}, 'Resume approved and saved to your library. That role applies with it next.', tools.dataset.card)).catch(error => notice(error.message, true));
      } else if (choice === 'current') act(`/jobs/${job}/resume`, {choice: 'current'}, 'Applying with your standing resume next.', tools.dataset.card);
      else act(`/jobs/${job}/resume`, {choice: 'variant', variant_id: tools.querySelector('[name="variant_id"]').value}, 'Applying with that saved resume next.', tools.dataset.card);
      return;
    }
    const cap = event.target.closest('[data-cap]');
    if (cap) {
      const allow = cap.dataset.allow === 'true';
      act('/caps', {company: cap.dataset.cap, allow}, allow ? `Allowed applying to ${cap.dataset.cap}.` : `Not applying to ${cap.dataset.cap}. Its roles are dismissed.`);
      return;
    }
    if (event.target.closest('#recheck')) {
      (async () => { try { const r = await request('/approvals/recheck', {}); notice(r.resumed ? `${r.resumed} application${r.resumed === 1 ? '' : 's'} sent back through. Anything still open comes back here.` : 'Nothing is waiting on questions.'); refresh(); } catch (error) { notice(error.message, true); } })();
      return;
    }
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const job = encodeURIComponent(button.dataset.job), a = button.dataset.act;
    if (a === 'approve-submit') act(`/jobs/${job}/approve-submit`, {review_id: button.dataset.review || null}, 'Approved and removed from Approvals. It goes to the front of the queue and is submitted once.');
    else if (a === 'approve-live') act(`/jobs/${job}/command`, {action: 'approve', review_id: button.dataset.review}, 'Submission requested. Waiting for employer confirmation.');
    else if (a === 'retry-parked') act(`/jobs/${job}/retry-parked`, {}, 'Trying that role again next.');
    else if (a === 'dismiss') act(`/jobs/${job}/dismiss`, {}, 'Dismissed. Autoplay will not pick that role again.');
    else act(`/jobs/${job}/command`, {action: a}, a === 'stop' ? 'Stopping that role.' : 'Sent.');
  });
  $('clearList').addEventListener('click', async () => {
    if (busy || !currentApprovals.length) return;
    const ids = currentApprovals.map(item => item.id);
    busy = true; $('clearList').disabled = true;
    try {
      const result = await request('/approvals/clear', {ids});
      revision++;
      ids.forEach(id => drafts.delete(id));
      notice(`Cleared ${result.cleared} approval items. Returned to the application queue. History and approved answers are saved.${result.blocked_remaining ? ` ${result.blocked_remaining} items could not be safely requeued and remain here.` : ''}${result.active_remaining ? ` ${result.active_remaining} active items remain; stop their workers before clearing.` : ''}`);
    } catch (error) { notice(error.message, true); }
    finally { busy = false; await refresh(); }
  });
  refresh();
})();
