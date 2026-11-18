// JobAgent Setup: a step-by-step form over /api/setup. The whole form lives in `state` (the draft the
// server sends); inputs bind to it by path (data-k="about.name"), and nothing is saved until Finish.
'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const embedded = window.top !== window;
if (embedded) document.documentElement.classList.add('embedded');

let state = null, meta = {}, step = 0, visited = 0, errors = {}, saving = false, finished = null;

function get(path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), state); }
function set(path, value) {
  const keys = path.split('.'), last = keys.pop();
  keys.reduce((o, k) => o[k], state)[last] = value;
}

// ------------------------------------------------------------ field helpers
function field(path, label, {type = 'text', hint = '', required = false, wide = false, placeholder = '', attrs = ''} = {}) {
  const v = get(path);
  const err = errors[path];
  return `<label class="${wide ? 'wide' : ''}"><span>${esc(label)}${required ? ' <span aria-hidden="true">*</span>' : ''}</span>
    ${type === 'textarea'
      ? `<textarea data-k="${path}" placeholder="${esc(placeholder)}" ${attrs}>${esc(v)}</textarea>`
      : `<input type="${type}" data-k="${path}" value="${esc(v ?? '')}" placeholder="${esc(placeholder)}" ${required ? 'required' : ''} ${err ? 'aria-invalid="true"' : ''} ${attrs}>`}
    ${err ? `<span class="err">${esc(err)}</span>` : hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
}
function select(path, label, options, hint = '') {
  return `<label>${esc(label)}<select data-k="${path}">${options.map(([v, t]) => `<option value="${esc(v)}" ${get(path) === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
}
// Locations keep their commas ("Seattle, WA"); other lists also split on commas.
function tags(path, label, {hint = '', placeholder = 'Type and press Enter', wide = true, commas = true} = {}) {
  const items = get(path) || [];
  const err = errors[path];
  return `<div class="label ${wide ? 'wide' : ''}">${esc(label)}
    <div class="tags" data-tags="${path}" data-commas="${commas ? 1 : 0}">${items.map((t, i) => `<span class="tag">${esc(t)}<button type="button" data-untag="${i}" aria-label="Remove ${esc(t)}"><i class="fa-solid fa-xmark"></i></button></span>`).join('')}
      <input type="text" placeholder="${esc(placeholder)}" aria-label="${esc(label)}"></div>
    ${err ? `<span class="err">${esc(err)}</span>` : hint ? `<small>${esc(hint)}</small>` : ''}</div>`;
}
function choice(path, value, title, text, type = 'radio') {
  const on = type === 'radio' ? get(path) === value : !!get(path);
  return `<label class="choice"><input type="${type}" name="${path}" data-k="${path}" value="${esc(value)}" ${on ? 'checked' : ''}><strong>${esc(title)}</strong><span>${esc(text)}</span></label>`;
}
function toggle(path, title, text) {
  return `<label class="toggle"><input type="checkbox" data-k="${path}" ${get(path) ? 'checked' : ''}><div><strong>${esc(title)}</strong><span>${esc(text)}</span></div></label>`;
}
const head = (eyebrow, title, lede) => `<div class="eyebrow">${esc(`Step ${step + 1} of ${STEPS.length}`)}</div><h1>${esc(title)}</h1><p class="lede">${esc(lede)}</p>`;
const monthLabel = m => { if (!m) return ''; const [y, mo] = m.split('-'); return new Date(+y, +mo - 1, 1).toLocaleDateString('en-US', {month: 'short', year: 'numeric'}); };

// ------------------------------------------------------------ steps
const STEPS = [
  {key: 'welcome', title: 'Welcome', render: () => `
    ${head('Step 1', meta.needed ? 'Let’s set up JobAgent.' : 'Update your setup.', meta.needed
      ? 'Whatever you study and wherever you want to work, JobAgent finds the roles, ranks each one against your background, and fills in the applications for you in the background. A few minutes here tell it who you are and what you want.'
      : 'Everything below starts from what you saved before. Change what you need; nothing is written until you press Finish.')}
    <div class="panel">
      <div id="drop" role="button" tabindex="0" aria-label="Upload your resume (PDF)">
        <i class="fa-regular fa-file-lines"></i>
        <strong>${meta.resume_uploaded ? 'Resume uploaded. Drop a new PDF to replace it.' : 'Start from your resume (optional)'}</strong>
        <span class="lede" style="font-size:13px">Drop a PDF here or click to choose one. Contact details are filled in for you, and the file becomes the resume your applications send.</span>
        <input type="file" id="resumeFile" accept="application/pdf" hidden>
      </div>
      <div id="resumeNote" class="note hidden" role="status"></div>
    </div>
    <div class="panel tan">
      <div class="review">
        <div class="card"><h2><i class="fa-solid fa-magnifying-glass"></i> Find</h2><span class="lede" style="font-size:13px">Indeed, LinkedIn, Handshake, job-alert emails and employers’ own career sites, searched for the roles you choose.</span></div>
        <div class="card"><h2><i class="fa-solid fa-ranking-star"></i> Rank</h2><span class="lede" style="font-size:13px">Every posting gets a 0–100 fit score and an eligibility check against your degree, graduation date and experience.</span></div>
        <div class="card"><h2><i class="fa-solid fa-bolt"></i> Apply</h2><span class="lede" style="font-size:13px">Application workers fill employer forms from your profile, and ask you only when a question needs you.</span></div>
      </div>
    </div>`},
  {key: 'about', title: 'About you', required: ['about.name', 'about.email'], render: () => `
    ${head('Step 2', 'About you', 'Applications use these exactly as written.')}
    <div class="panel"><div class="card"><div class="fields">
      ${field('about.name', 'Full name', {required: true, attrs: 'autocomplete="name"'})}
      ${field('about.email', 'Email', {type: 'email', required: true, attrs: 'autocomplete="email"'})}
      ${field('about.phone', 'Phone', {type: 'tel', attrs: 'autocomplete="tel"'})}
      ${field('about.location', 'Where you live', {placeholder: 'City, ST', hint: 'City and state, e.g. Austin, TX'})}
      ${field('about.linkedin', 'LinkedIn', {type: 'url', placeholder: 'https://linkedin.com/in/…'})}
      ${field('about.website', 'Website or portfolio', {type: 'url', placeholder: 'https://…'})}
    </div></div></div>`},
  {key: 'education', title: 'Education', required: ['education.institution', 'education.graduation', 'education.majors'], render: () => `
    ${head('Step 3', 'Education', 'Your graduation date decides which new-grad cohorts and start dates fit you.')}
    <div class="panel"><div class="card"><div class="fields">
      ${field('education.institution', 'School', {required: true, wide: true, placeholder: 'University of …', hint: 'Add a short name in brackets if it has one, e.g. “University of Texas at Austin (UT Austin)”.'})}
      ${select('education.degree', 'Degree', [['associate', 'Associate'], ['bachelor', 'Bachelor’s'], ['master', 'Master’s'], ['doctorate', 'Doctorate']])}
      ${field('education.graduation', 'Graduation (month)', {type: 'month', required: true})}
      ${field('education.started', 'Started (month)', {type: 'month'})}
      ${field('education.gpa', 'GPA', {placeholder: '3.6'})}
      ${tags('education.majors', 'Majors', {hint: 'Any field. One or two; press Enter after each.'})}
      ${tags('education.minors', 'Minors', {hint: 'Optional.'})}
      ${tags('education.coursework', 'Relevant coursework', {hint: 'Optional.'})}
    </div></div></div>`},
  {key: 'experience', title: 'Experience', render: renderExperience},
  {key: 'skills', title: 'Skills', render: () => `
    ${head('Step 5', 'Skills', 'Skills are matched against each posting’s requirements, so name what you would put on your resume.')}
    <div class="panel"><div class="card"><div class="fields">
      ${tags('skills.technical', 'Technical skills and tools', {placeholder: 'Excel, Python, Figma, SolidWorks…'})}
      ${tags('skills.other', 'Other skills', {placeholder: 'Spanish, public speaking, financial modeling…'})}
    </div></div></div>`},
  {key: 'search', title: 'What you want', required: ['search.roles', 'search.start_date'], render: () => `
    ${head('Step 6', 'What are you looking for?', 'Your roles, industries and places decide what JobAgent searches for and how it ranks what it finds.')}
    <div class="panel"><div class="card"><div class="fields">
      ${tags('search.roles', 'Roles you want', {placeholder: 'Financial Analyst, Product Designer, Mechanical Engineer…', hint: 'Job titles, most wanted first. The first one gets a priority boost.'})}
      ${tags('search.dream_companies', 'Dream companies', {placeholder: 'Type a company and press Enter', hint: 'Optional. Their postings rank higher.'})}
    </div></div></div>
    <div class="panel tan"><h2>Industries</h2>${multi('search.industries', meta.catalog?.industries || [])}
      <small class="lede" style="font-size:12px">Pick any that interest you, or none for every industry.</small></div>
    <div class="panel tan"><h2>Kind of role</h2><div class="choices">
      ${choice('search.role_type', 'full-time', 'Full-time', 'New-grad and early-career jobs')}
      ${choice('search.role_type', 'internships', 'Internships', 'Internships and co-ops')}
      ${choice('search.role_type', 'both', 'Both', 'Everything early-career')}
    </div></div>
    <div class="panel"><div class="card"><div class="fields">
      ${field('search.start_date', 'Earliest start date', {type: 'date', required: true, hint: 'Postings that need you sooner are flagged.'})}
      ${field('search.min_salary', 'Minimum base salary (USD a year)', {type: 'number', attrs: 'min="0" step="1000"', hint: '0 means no minimum.'})}
      ${field('search.max_required_years', 'Most years of experience a role may require', {type: 'number', attrs: 'min="0" max="15"'})}
      ${tags('search.locations', 'Where you want to work', {placeholder: 'Seattle, WA · Texas · Remote', commas: false, hint: 'Cities, states or Remote. Roles here rank higher. Leave empty for anywhere in the US.'})}
      ${tags('search.degree_fields', 'Degree fields you can claim', {hint: 'When a posting requires a degree in one of these, you qualify. Filled from your majors if left empty.'})}
    </div></div></div>
    <div class="panel tan"><div class="choices">
      ${toggle('search.location_strict', 'Only these places', 'Hide roles outside the places you listed.')}
      ${toggle('search.relocation', 'Open to relocating', 'Roles outside your area stay eligible.')}
      ${toggle('search.remote_ok', 'Remote roles welcome', 'Remote postings are kept.')}
      ${toggle('search.available_during_school_year', 'Available during the school year', 'Off: school-year internships and early starts are flagged.')}
    </div></div>`},
  {key: 'eligibility', title: 'Eligibility', render: () => `
    ${head('Step 7', 'Work eligibility', 'Employers ask this on almost every application; answering once here means the agent never has to ask.')}
    <div class="panel"><div class="choices">
      ${choice('eligibility.work_authorization', 'citizen', 'U.S. citizen', 'No sponsorship needed')}
      ${choice('eligibility.work_authorization', 'permanent_resident', 'Permanent resident', 'No sponsorship needed')}
      ${choice('eligibility.work_authorization', 'authorized', 'Otherwise authorized', 'No sponsorship needed now or later')}
      ${choice('eligibility.work_authorization', 'needs_sponsorship', 'Need sponsorship', 'Now or in the future')}
    </div></div>
    <div class="panel tan">${toggle('eligibility.clearance_eligible', 'Eligible for a U.S. security clearance', 'Keeps defense and government roles that require clearance eligibility.')}</div>`},
  {key: 'sources', title: 'Job sources', render: () => `
    ${head('Step 8', 'Where to look', 'Company career sites are always read. Add the boards you want on top.')}
    <div class="panel">
      <div class="note good"><i class="fa-solid fa-building"></i> ${packNote()} Add employers any time under Sources &amp; watches.</div>
      <div class="choices">
        ${toggle('sources.indeed', 'Indeed', 'Keeps postings that link to the employer’s own application.')}
        ${toggle('sources.linkedin', 'LinkedIn', 'Public search, no account needed. Each result is traced back to the employer.')}
        ${toggle('sources.email', 'Job-alert emails', 'Reads alert emails from boards you subscribe to.')}
        ${toggle('sources.handshake', 'Handshake', 'Your school’s Handshake, with your own sign-in.')}
      </div>
      <div class="card ${get('sources.handshake') ? '' : 'hidden'}" id="hsCard"><div class="fields">
        ${field('sources.handshake_school', 'Your school’s Handshake address', {placeholder: 'e.g. ucla', hint: 'The part before .joinhandshake.com. After setup, run `jobagent handshake-login` once to sign in.'})}
      </div></div>
    </div>`},
  {key: 'connect', title: 'Connect', render: renderConnect},
  {key: 'review', title: 'Review', render: renderReview},
];

function packNote() {
  const chosen = new Set(state.search.industries);
  const packs = (meta.catalog?.packs || []).filter(p => p.industries.some(i => chosen.has(i)));
  return packs.length
    ? `${packs.reduce((n, p) => n + p.count, 0)} employers’ career sites (${packs.map(p => p.name).join(', ')}) are watched for your industries, on top of the job boards.`
    : 'The job boards below find postings across every employer; employers’ own career sites are added as JobAgent finds them.';
}

// Multi-select pills: each toggles membership of its value in the list at `path`.
function multi(path, options) {
  const on = new Set(get(path) || []);
  return `<div class="pills" data-multi="${path}">${options.map(o => `<button type="button" class="pill" aria-pressed="${on.has(o)}" data-value="${esc(o)}">${esc(o)}</button>`).join('')}</div>`;
}

let connectNote = {};
function renderConnect() {
  const a = meta.account || {}, g = meta.gmail || {};
  const note = k => connectNote[k] ? `<div class="note ${connectNote[k].ok ? 'good' : 'bad'}" role="status">${esc(connectNote[k].text)}</div>` : '';
  return `${head('Step 10', 'Connect your accounts', 'Your JobAgent account runs the AI that reads postings and fills forms. The rest is optional but saves you steps.')}
    <div class="panel"><div class="card">
      <h2><i class="fa-solid fa-user"></i> JobAgent account</h2>
      ${a.connected ? `<div class="note good">Signed in as ${esc(a.email)}.</div>` : `
      <div class="fields">
        <label>Email<input type="email" id="acctEmail" value="${esc(state.about.email)}" autocomplete="username"></label>
        <label>Password<input type="password" id="acctPassword" autocomplete="current-password" minlength="8"></label>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap"><button type="button" class="btn dark" data-account="signup">Create account</button><button type="button" class="btn" data-account="login">Sign in</button></div>`}
      ${note('account')}
    </div></div>
    <div class="panel tan"><div class="card">
      <h2><i class="fa-solid fa-key"></i> Password for employer sites</h2>
      <span class="lede" style="font-size:13px">Many employers (Workday, iCIMS and others) need an account to apply. JobAgent creates them with your email and this password. It is kept in your computer’s secure credential store${meta.site_password_saved ? '; one is already saved' : ''}.</span>
      <div class="fields"><label>Password<input type="password" id="sitePassword" autocomplete="new-password" minlength="8"></label></div>
      <div><button type="button" class="btn" id="saveSitePassword">Save password</button></div>
      ${note('site')}
    </div></div>
    <div class="panel"><div class="card">
      <h2><i class="fa-regular fa-envelope"></i> Gmail</h2>
      <span class="lede" style="font-size:13px">Lets JobAgent read verification codes and job-alert emails (read-only; it never sends, deletes or labels).</span>
      ${g.connected ? '<div class="note good">Gmail is connected.</div>' : g.available
        ? '<div><button type="button" class="btn dark" id="connectGmail"><i class="fa-brands fa-google"></i> Connect Gmail</button></div>'
        : '<div class="note">Gmail connection is not available in this build.</div>'}
      ${note('gmail')}
    </div></div>`;
}

async function postJSON(url, body) {
  const res = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body || {})});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(Array.isArray(data.detail) ? data.detail.map(e => e.msg).join('; ') : data.detail || 'Something went wrong');
  return data;
}

function bindConnect() {
  document.querySelectorAll('[data-account]').forEach(b => b.addEventListener('click', async () => {
    try {
      meta.account = await postJSON('/api/setup/account', {email: $('acctEmail').value, password: $('acctPassword').value, mode: b.dataset.account});
      connectNote.account = {ok: true, text: b.dataset.account === 'signup' ? 'Account created.' : 'Signed in.'};
    } catch (err) { connectNote.account = {ok: false, text: err.message}; }
    render();
  }));
  $('saveSitePassword')?.addEventListener('click', async () => {
    try { await postJSON('/api/setup/site-password', {password: $('sitePassword').value}); meta.site_password_saved = true; connectNote.site = {ok: true, text: 'Saved to your credential store.'}; }
    catch (err) { connectNote.site = {ok: false, text: err.message}; }
    render();
  });
  $('connectGmail')?.addEventListener('click', async () => {
    try {
      const {url} = await postJSON('/api/setup/gmail/start');
      window.open(url, '_blank', 'noopener');
      connectNote.gmail = {ok: true, text: 'Finish signing in with Google in the window that opened, then come back here.'};
      const poll = setInterval(async () => {
        const s = await fetch('/api/setup').then(r => r.json()).catch(() => null);
        if (s?.gmail?.connected) { clearInterval(poll); meta.gmail = s.gmail; connectNote.gmail = {ok: true, text: 'Gmail connected.'}; if (STEPS[step].key === 'connect') render(); }
      }, 3000);
      setTimeout(() => clearInterval(poll), 10 * 60 * 1000);
    } catch (err) { connectNote.gmail = {ok: false, text: err.message}; }
    render();
  });
}

function renderExperience() {
  const roles = state.experience, projects = state.projects;
  const role = (r, i) => `<div class="card"><div class="card-head"><h2>${esc(r.title || 'New role')}${r.company ? ` · ${esc(r.company)}` : ''}</h2>
      <button type="button" class="btn small" data-remove="experience.${i}"><i class="fa-regular fa-trash-can"></i>Remove</button></div>
    <div class="fields">
      ${field(`experience.${i}.company`, 'Company', {required: true})}
      ${field(`experience.${i}.title`, 'Title', {required: true})}
      ${field(`experience.${i}.location`, 'Location')}
      ${field(`experience.${i}.start`, 'Started', {type: 'month', required: true})}
      ${field(`experience.${i}.end`, 'Ended', {type: 'month', hint: 'Leave empty if you are still there.'})}
      ${field(`experience.${i}.summary`, 'What you did', {type: 'textarea', wide: true, hint: 'The application agent answers questions from this, so be specific.'})}
      ${tags(`experience.${i}.skills`, 'Key skills from this role', {hint: 'Matched against postings to rank them.'})}
      ${field(`experience.${i}.caution`, 'Anything not to claim (optional)', {wide: true, placeholder: 'e.g. I did not lead the client calls', hint: 'Drafted answers and resumes never claim beyond this.'})}
    </div></div>`;
  const project = (p, i) => `<div class="card"><div class="card-head"><h2>${esc(p.name || 'New project')}</h2>
      <button type="button" class="btn small" data-remove="projects.${i}"><i class="fa-regular fa-trash-can"></i>Remove</button></div>
    <div class="fields">
      ${field(`projects.${i}.name`, 'Project', {required: true})}
      ${field(`projects.${i}.role`, 'Your role')}
      ${field(`projects.${i}.summary`, 'What you built', {type: 'textarea', wide: true})}
      ${tags(`projects.${i}.skills`, 'Key skills')}
      ${field(`projects.${i}.caution`, 'Anything not to claim (optional)', {wide: true})}
    </div></div>`;
  return `${head('Step 4', 'Experience', 'Internships, jobs, research and projects. They are what your fit scores are built from.')}
    <div class="panel">${roles.map(role).join('') || '<div class="note">No roles yet.</div>'}
      <div><button type="button" class="btn dark" data-add="experience"><i class="fa-solid fa-plus"></i>Add a role</button></div></div>
    <div class="panel tan">${projects.map(project).join('') || '<div class="note">No projects yet.</div>'}
      <div><button type="button" class="btn dark" data-add="projects"><i class="fa-solid fa-plus"></i>Add a project</button></div></div>`;
}

function renderReview() {
  const s = state;
  const auth = {citizen: 'U.S. citizen', permanent_resident: 'Permanent resident', authorized: 'Authorized, no sponsorship', needs_sponsorship: 'Needs sponsorship'}[s.eligibility.work_authorization];
  const on = Object.entries({Indeed: s.sources.indeed, LinkedIn: s.sources.linkedin, 'Alert emails': s.sources.email, Handshake: s.sources.handshake}).filter(([, v]) => v).map(([k]) => k);
  const dl = rows => `<dl>${rows.filter(([, v]) => v !== '' && v != null).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  return `${head('Step 11', 'Ready when you are.', meta.needed
      ? 'Finish writes your profile, then JobAgent scores what it already knows and starts its first scan. The first full scan takes a few hours; roles appear as they are found.'
      : 'Finish saves your changes and re-scores every stored posting. The files it replaces are backed up first.')}
    ${finished ? '' : `<div class="panel"><div class="review">
      <div class="card"><h2>You</h2>${dl([['Name', s.about.name], ['Email', s.about.email], ['Phone', s.about.phone], ['Location', s.about.location]])}</div>
      <div class="card"><h2>Education</h2>${dl([['School', s.education.institution], ['Majors', s.education.majors.join(', ')], ['Graduation', monthLabel(s.education.graduation)], ['GPA', s.education.gpa]])}</div>
      <div class="card"><h2>Experience</h2>${dl([['Roles', s.experience.map(r => r.company).join(', ') || 'None'], ['Projects', s.projects.map(p => p.name).join(', ') || 'None'], ['Skills', [...s.skills.technical, ...s.skills.other].length + ' listed']])}</div>
      <div class="card"><h2>Search</h2>${dl([['Roles', s.search.roles.join(', ')], ['Industries', s.search.industries.join(', ') || 'Any'], ['Kind', {"full-time": 'Full-time', internships: 'Internships', both: 'Full-time and internships'}[s.search.role_type]], ['Start', s.search.start_date], ['Minimum', s.search.min_salary ? '$' + Number(s.search.min_salary).toLocaleString() : 'None'], ['Places', (s.search.locations.join(', ') || 'Anywhere in the US') + (s.search.location_strict ? ' (only)' : '')], ['Eligibility', auth]])}</div>
      <div class="card"><h2>Sources</h2>${dl([['Boards', on.join(', ') || 'None'], ['Account', meta.account?.connected ? meta.account.email : 'Not connected'], ['Gmail', meta.gmail?.connected ? 'Connected' : 'Not connected']])}</div>
    </div></div>
    <div id="saveNote" class="note bad hidden" role="alert"></div>`}
    ${finished ? `<div class="panel"><div class="card"><h2>All set</h2><ul class="done-list">${finished.steps.map(t => `<li><i class="fa-solid fa-circle-check"></i>${esc(t)}</li>`).join('')}</ul>
      ${finished.backup ? `<p class="lede" style="font-size:13px">Previous files were backed up to ${esc(finished.backup)}.</p>` : ''}
      <div><a class="btn primary" href="/" id="toDashboard">Open the dashboard<i class="fa-solid fa-arrow-right"></i></a></div></div></div>` : ''}`;
}

// ------------------------------------------------------------ validation
function validate(i) {
  const st = STEPS[i], errs = {};
  for (const path of st.required || []) {
    const v = get(path);
    if (Array.isArray(v) ? !v.filter(Boolean).length : !String(v ?? '').trim()) errs[path] = 'Required';
  }
  if (st.key === 'about' && state.about.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(state.about.email)) errs['about.email'] = 'Enter a valid email address';
  if (st.key === 'experience') {
    state.experience.forEach((r, n) => { for (const k of ['company', 'title', 'start']) if (!String(r[k] || '').trim()) errs[`experience.${n}.${k}`] = 'Required'; });
    state.projects.forEach((p, n) => { if (!String(p.name || '').trim()) errs[`projects.${n}.name`] = 'Required'; });
  }
  if (st.key === 'sources' && state.sources.handshake && !/^[A-Za-z0-9-]+$/.test(state.sources.handshake_school || '')) errs['sources.handshake_school'] = 'Needed to search Handshake';
  errors = errs;
  return !Object.keys(errs).length;
}

// ------------------------------------------------------------ rendering and binding
function render() {
  $('steps').innerHTML = STEPS.map((s, i) => `<li class="${i === step ? 'current' : i < visited || i < step ? 'done' : ''}">
      <button type="button" data-step="${i}" ${i > visited || finished ? 'disabled' : ''} ${i === step ? 'aria-current="step"' : ''}>
        <span class="n">${i < step || (i <= visited && i !== step) ? '<i class="fa-solid fa-check"></i>' : i + 1}</span><span class="label-text">${esc(s.title)}</span></button></li>`).join('');
  $('form').innerHTML = STEPS[step].render();
  $('where').textContent = finished ? '' : `${step + 1} of ${STEPS.length}`;
  $('back').innerHTML = step === 0 ? (embedded ? '<i class="fa-solid fa-xmark"></i>Close' : '') : '<i class="fa-solid fa-arrow-left"></i>Back';
  $('back').classList.toggle('hidden', (step === 0 && !embedded) || !!finished);
  const last = step === STEPS.length - 1;
  $('next').innerHTML = saving ? 'Saving…' : last ? 'Finish setup<i class="fa-solid fa-check"></i>' : 'Continue<i class="fa-solid fa-arrow-right"></i>';
  $('next').disabled = saving;
  $('next').classList.toggle('hidden', !!finished);
  bind();
}

function coerce(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number') return el.value === '' ? 0 : Number(el.value);
  if (el.type === 'month' || el.type === 'date') return el.value || null;
  return el.value;
}

function bind() {
  document.querySelectorAll('[data-k]').forEach(el => {
    const handler = () => {
      if (el.type === 'radio') { if (el.checked) set(el.dataset.k, el.value); }
      else set(el.dataset.k, coerce(el));
      if (el.dataset.k === 'sources.handshake') $('hsCard')?.classList.toggle('hidden', !el.checked);
      if (errors[el.dataset.k]) { delete errors[el.dataset.k]; el.removeAttribute('aria-invalid'); el.parentElement.querySelector('.err')?.remove(); }
    };
    el.addEventListener(el.type === 'radio' || el.type === 'checkbox' ? 'change' : 'input', handler);
  });
  document.querySelectorAll('[data-tags]').forEach(box => {
    const path = box.dataset.tags, input = box.querySelector('input');
    const add = () => {
      const commas = box.dataset.commas === '1';
      const parts = (commas ? input.value.split(',') : [input.value]).map(s => s.trim()).filter(Boolean);
      if (!parts.length) return;
      const list = get(path) || [];
      for (const p of parts) if (!list.some(x => x.toLowerCase() === p.toLowerCase())) list.push(p);
      set(path, list); input.value = ''; delete errors[path];
      rerenderKeepingFocus(path);
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' || (e.key === ',' && box.dataset.commas === '1')) { e.preventDefault(); add(); }
      else if (e.key === 'Backspace' && !input.value && (get(path) || []).length) { get(path).pop(); rerenderKeepingFocus(path); }
    });
    input.addEventListener('blur', add);
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-untag]');
      if (b) { get(path).splice(+b.dataset.untag, 1); rerenderKeepingFocus(path); }
      else input.focus();
    });
  });
  document.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => {
    const blank = b.dataset.add === 'experience'
      ? {company: '', title: '', location: '', start: null, end: null, summary: '', skills: [], caution: ''}
      : {name: '', role: '', summary: '', skills: [], caution: ''};
    state[b.dataset.add].push(blank); render();
    const cards = document.querySelectorAll(`[data-remove^="${b.dataset.add}."]`);
    cards[cards.length - 1]?.closest('.card')?.querySelector('input')?.focus();
  }));
  document.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => {
    const [list, i] = b.dataset.remove.split('.');
    state[list].splice(+i, 1); errors = {}; render();
  }));
  document.querySelectorAll('[data-multi]').forEach(box => box.addEventListener('click', e => {
    const b = e.target.closest('[data-value]'); if (!b) return;
    const list = get(box.dataset.multi) || [], v = b.dataset.value, i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1); else list.push(v);
    set(box.dataset.multi, list); b.setAttribute('aria-pressed', String(i < 0));
  }));
  if (STEPS[step].key === 'connect') bindConnect();
  document.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => go(+b.dataset.step)));
  const drop = $('drop');
  if (drop) {
    const file = $('resumeFile');
    drop.addEventListener('click', () => file.click());
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });
    file.addEventListener('change', () => file.files[0] && upload(file.files[0]));
  }
  $('toDashboard')?.addEventListener('click', e => { if (embedded) { e.preventDefault(); window.parent.postMessage({jobagent: 'setup-saved'}, location.origin); } });
}

function rerenderKeepingFocus(path) {
  render();
  document.querySelector(`[data-tags="${CSS.escape(path)}"] input`)?.focus();
}

async function upload(file) {
  const note = $('resumeNote');
  note.className = 'note'; note.textContent = 'Reading your resume…';
  try {
    const res = await fetch('/api/setup/resume', {method: 'POST', headers: {'Content-Type': 'application/pdf'}, body: file});
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || 'Upload failed');
    const found = body.found || {};
    const filled = [];
    for (const [k, v] of Object.entries(found)) if (v && !state.about[k]) { state.about[k] = v; filled.push(k); }
    meta.resume_uploaded = true;
    note.className = 'note good';
    note.textContent = filled.length ? `Resume saved. Filled in your ${filled.join(', ')}; check them on the next step.` : 'Resume saved. It will be attached to your applications.';
  } catch (err) {
    note.className = 'note bad'; note.textContent = err.message;
  }
}

function go(i) {
  if (i > step && !validate(step)) { render(); document.querySelector('[aria-invalid=true]')?.focus(); return; }
  errors = {};
  step = Math.max(0, Math.min(STEPS.length - 1, i));
  visited = Math.max(visited, step);
  render();
  window.scrollTo({top: 0});
  document.querySelector('main h1')?.focus?.();
}

async function finish() {
  for (let i = 0; i < STEPS.length; i++) if (!validate(i)) { step = i; render(); document.querySelector('[aria-invalid=true]')?.focus(); return; }
  if (!state.search.degree_fields.length) state.search.degree_fields = state.education.majors.map(m => m.toLowerCase());
  saving = true; render();
  try {
    const res = await fetch('/api/setup', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(state)});
    const body = await res.json();
    if (!res.ok) {
      const d = body.detail;
      throw new Error(Array.isArray(d) ? d.map(e => `${e.loc.slice(1).join(' › ')}: ${e.msg}`).join('\n') : d || 'Saving failed');
    }
    finished = body;
  } catch (err) {
    saving = false; render();
    const n = $('saveNote'); n.textContent = err.message; n.classList.remove('hidden');
    return;
  }
  saving = false; render();
}

$('next').addEventListener('click', () => step === STEPS.length - 1 ? finish() : go(step + 1));
$('back').addEventListener('click', () => step === 0 ? window.parent.postMessage({jobagent: 'close-panel'}, location.origin) : go(step - 1));

fetch('/api/setup').then(r => r.json()).then(body => {
  meta = body; state = body.draft;
  state.experience ||= []; state.projects ||= [];
  state.education.minors ||= []; state.search.roles ||= []; state.search.industries ||= []; state.search.dream_companies ||= [];
  if (!meta.needed) visited = STEPS.length - 1;
  render();
}).catch(() => { $('form').innerHTML = '<div class="note bad">Could not load setup. Is JobAgent running?</div>'; });
