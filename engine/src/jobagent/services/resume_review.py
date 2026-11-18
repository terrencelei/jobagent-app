"""Before a role starts, a model makes sure the resume it uploads is tailored to the posting.

His standing resume (2026-10-22) leans robotics and controls. For postings in other areas
(automotive, aerospace, consumer electronics, manufacturing, ...) he wants a tailored copy that
expands on his experience in the posting's own terms so it scores well with applicant tracking
systems, and he approves every tailored copy before it is submitted. The reviewer reads the posting
against his standing resume, the tailored copies in application-agent's private/resumes/ library,
older resumes and his confirmed profile, and answers: the standing resume is right, a saved copy
fits, or here is a full tailored draft. Drafts are structures printed by `resume_doc.render_pdf` in
his resume's exact layout; one that runs past the page is sent back once to be shortened. A cheaper Claude model
drafts, then a different model (Codex, else a free OpenCode model) rewords the draft so it does not read as one
model's prose; the reword is kept only if it still fits the page and keeps the posting keywords. A failed review
never blocks an application; the standing resume is used.
"""
import base64
import json
import re
import subprocess
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

from . import resume_doc
from .fit_review import _cli, _env
from ..settings import model_id, setting
from .. import identity

ENTRY = {'type': 'object', 'additionalProperties': False, 'properties': {
    'org': {'type': 'string'}, 'dates': {'type': 'string'}, 'role': {'type': 'string'}, 'location': {'type': 'string'},
    'bullets': {'type': 'array', 'items': {'type': 'string'}}}, 'required': ['org', 'dates', 'role', 'location', 'bullets']}
SECTION = {'type': 'object', 'additionalProperties': False, 'properties': {
    'title': {'type': 'string'}, 'kind': {'type': 'string', 'enum': ['entries', 'skills']},
    'entries': {'type': 'array', 'items': ENTRY},
    'lines': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False, 'properties': {
        'label': {'type': 'string'}, 'text': {'type': 'string'}}, 'required': ['label', 'text']}}},
    'required': ['title', 'kind', 'entries', 'lines']}
SCHEMA = {'type': 'object', 'additionalProperties': False, 'properties': {
    'verdict': {'type': 'string', 'enum': ['base', 'variant', 'tailor']},
    'variant_id': {'type': 'string'},
    'focus': {'type': 'string'},
    'summary': {'type': 'string'},
    'keywords': {'type': 'array', 'items': {'type': 'string'}},
    'verify': {'type': 'array', 'items': {'type': 'string'}},
    'sections': {'type': 'array', 'items': SECTION}},
    'required': ['verdict', 'variant_id', 'focus', 'summary', 'keywords', 'verify', 'sections']}

SYSTEM = """You tailor a mechanical engineering new graduate's one-page resume to one job posting so it reads well to a
recruiter and scores well with applicant tracking systems (ATS). His standing resume leans robotics and controls.

You get: the standing resume (JSON), tailored copies he already approved (each with its focus), older resumes, his
confirmed experience from his application profile, and the posting.

verdict:
- "base": the posting is robotics, controls, mechatronics or automation work and the standing resume already uses most
  of its key terms. Return sections as [].
- "variant": an approved tailored copy was made for essentially this kind of role and already uses most of this
  posting's key terms (set variant_id). Return sections as [].
- "tailor": otherwise, e.g. automotive, vehicle dynamics, aerospace structures, consumer electronics, thermal,
  manufacturing or test roles. Return the complete tailored resume in sections.

keywords: the 10-20 hard skills, tools, methods and domain terms an ATS would match for this posting, each copied
verbatim from the posting (2-4 words at most, e.g. "mechanism design", "GD&T", "sealing systems").

Writing the tailored resume:
- Same structure as the standing resume: section titles EDUCATION, PROFESSIONAL EXPERIENCE, PROJECTS & OUTSIDE
  EXPERIENCE, SKILLS; each entry has org, dates, role, location and bullets; SKILLS has lines with label and text.
- Keep EDUCATION entries (school, degree, dates) exactly as in the standing resume. Choose the Relevant Coursework
  line for this posting from the courses on his transcript (completed or in progress): drop courses the posting does
  not care about and name the ones it does, most relevant first. He holds two degrees (Mechanical Engineering;
  Statistics and Data Science), so a data, software or machine learning posting gets statistics, data science,
  machine learning, programming and computer vision courses, and a mechanical posting gets mechanical ones. Write
  each course's full name, not the transcript's abbreviation (e.g. "STAT MACHINE LEARN" is Statistical Machine
  Learning, "DESIGN OF EXPERMNTS" is Design of Experiments); never name a course that is not on the transcript. The
  coursework line may move under the degree it belongs to, and the specialization line may be dropped when the
  posting does not weight it.
- ATS software matches the posting's exact phrases. Work every keyword into the resume verbatim wherever his sources
  support the underlying work, describing his real work in the posting's words: O-ring seal design is "sealing system"
  work, an actuator mechanism is "mechanism design", FEA is "CAE" and "engineering analysis", GD&T drawings are "part
  and assembly drawings", supplier parts are "supplier" work, prototypes are "proof-of-concept prototypes". Do not claim
  the posting's product domain itself (e.g. vehicle closures) unless he has worked on it.
- Expand on his experience with details from the profile and older resumes (specific mechanisms, analyses, tools and results
  named in their sources) and choose, reorder and reword
  entries and bullets so the most relevant come first. Drop less relevant entries or bullets to make room.
- Reasonable elaboration of work he describes is fine. Never invent employers, titles, dates, numbers, certifications,
  software he has not listed, results or responsibilities he did not have. Entries must come from his sources with
  their real org, role, dates and location.
- verify: every statement in the draft that is not explicit in his sources (an elaboration he should confirm), quoted
  briefly. Empty when everything is directly supported.
- One page: the standing resume fills the page exactly. Keep the same number of printed lines: each bullet line holds
  about 125 characters, and every bullet should be one or two full lines. If you add a bullet, remove one.
- Skills: put the posting's tools and methods he has first; add only skills that appear in his sources.
focus: the area the posting weights, in a few words (it labels the tailored copy).
summary: one or two sentences on what the posting emphasizes and what the tailored copy changes."""

REWORD_SCHEMA = {'type': 'object', 'additionalProperties': False, 'properties': {
    'verify': {'type': 'array', 'items': {'type': 'string'}}, 'sections': {'type': 'array', 'items': SECTION}},
    'required': ['verify', 'sections']}

REWORD = """You are a second editor on a mechanical engineering new graduate's one-page resume, already tailored to a job
posting by another model. Reword it so it reads as written by one careful engineer: concrete verbs, varied sentence
openings, no filler, buzzwords or repeated phrasing. Change wording only:
- Keep every section, entry, org, role, dates, location and skills label exactly as given, in the same order.
- Keep every fact. Never add employers, numbers, tools, certifications, results or responsibilities that are not in
  the draft or his sources.
- Keep each posting keyword listed below verbatim wherever the draft has it; ATS software matches exact phrases.
- Keep the length: the page is full. Each bullet line holds about 125 characters; keep every bullet to the same
  number of printed lines as in the draft (one or two).
verify: the draft's verify list, plus any statement of yours not explicit in his sources, quoted briefly.
Return the complete resume as JSON with sections and verify."""

PDF_LIMIT = 10 * 1024 * 1024
VARIANT_COVERAGE = 0.6


def now():
    return datetime.now(timezone.utc).isoformat()


class ResumeLibrary:
    """Tailored copies in application-agent/private/resumes/<id>/<Name>_Resume.pdf (plus resume.json when the
    copy was drafted here), indexed by library.json. Every copy keeps the standing filename, since the employer
    sees the uploaded file's name. Superseded standing resumes are kept in archive/ as fact sources."""

    def __init__(self, agent_dir, filename=None):
        self.dir = Path(agent_dir) / 'private/resumes'
        self.index = self.dir / 'library.json'
        self.filename = filename or identity.resume_filename()
        self._parsed = {}

    def _index(self):
        try:
            return json.loads(self.index.read_text())
        except (OSError, ValueError):
            return {}

    def variants(self):
        return [v for v in self._index().get('variants', []) if (self.dir / v['id'] / self.filename).is_file()]

    def path(self, variant_id):
        return next((self.dir / v['id'] / self.filename for v in self.variants() if v['id'] == variant_id), None)

    def structure(self, path):
        """A resume PDF as a structure (resume.json beside it when there is one); None when it cannot be read."""
        path = Path(path)
        saved = path.parent / 'resume.json'
        if saved.is_file():
            return json.loads(saved.read_text())
        key = (str(path), path.stat().st_mtime_ns)
        if key not in self._parsed:
            try:
                self._parsed[key] = resume_doc.parse_pdf(path.read_bytes())
            except Exception:
                self._parsed[key] = None
        return self._parsed[key]

    def text(self, path):
        structure = self.structure(path)
        if structure:
            return resume_doc.plain_text(structure)
        from pypdf import PdfReader
        return '\n'.join(p.extract_text() or '' for p in PdfReader(str(path)).pages)

    def archived(self):
        return sorted((self.dir / 'archive').glob('*.pdf'))

    def add(self, label, focus, pdf_bytes, job_id=None, structure=None):
        if len(pdf_bytes) > PDF_LIMIT or not pdf_bytes.startswith(b'%PDF'):
            raise ValueError('Upload a PDF of at most 10 MB')
        slug = re.sub(r'[^a-z0-9]+', '-', label.casefold()).strip('-')[:40] or 'tailored'
        taken = {v['id'] for v in self.variants()}
        variant_id = slug if slug not in taken else next(f'{slug}-{n}' for n in range(2, 1000) if f'{slug}-{n}' not in taken)
        folder = self.dir / variant_id
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        (folder / self.filename).write_bytes(pdf_bytes)
        if structure:
            (folder / 'resume.json').write_text(json.dumps(structure, indent=1))
        self.text(folder / self.filename)  # an unreadable PDF fails here, before it is indexed
        entries = self.variants() + [{'id': variant_id, 'label': label.strip(), 'focus': focus.strip(), 'added_at': now(),
                                      'job_ids': [job_id] if job_id else []}]
        self._write(entries)
        return variant_id

    def kept(self):
        return self._index().get('kept_current', [])

    def note_kept(self, focus, job_id):
        """He applied with his standing resume instead of a tailored draft: the reviewer stops tailoring for that area."""
        if focus and focus.casefold() not in {k['focus'].casefold() for k in self.kept()}:
            self._write(self.variants(), self.kept() + [{'focus': focus, 'job_id': job_id, 'at': now()}])

    def note_use(self, variant_id, job_id):
        entries = self.variants()
        for v in entries:
            if v['id'] == variant_id and job_id not in v.setdefault('job_ids', []):
                v['job_ids'].append(job_id)
        self._write(entries)

    def _write(self, entries, kept=None):
        self.dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = self.index.with_suffix('.tmp')
        tmp.write_text(json.dumps({'variants': entries, 'kept_current': self.kept() if kept is None else kept}, indent=2))
        tmp.replace(self.index)


def decode_upload(data):
    try:
        return base64.b64decode(data.split(',', 1)[-1], validate=True)
    except ValueError as exc:
        raise ValueError('The uploaded file could not be read') from exc


COURSE = re.compile(r'(?P<code>[A-Z][A-Z ]{0,7}?\s?\d{1,3}[A-Z]{0,2})\s?-(?P<title>[A-Z0-9&:,/ \-]+?)\s+(?:[A-F][+-]?|P|NP)?\s*'
                    r'\d{5}\s+(?P<attempted>\d+\.\d)\s+(?P<completed>\d+\.\d)')
_courses = {}


def transcript_courses(path):
    """The courses on his transcript PDF as {code, title, status}, without grades, ID or GPA. [] when unreadable."""
    try:
        path = Path(path); key = (str(path), path.stat().st_mtime_ns)
    except (OSError, TypeError):
        return []
    if key not in _courses:
        try:
            from pypdf import PdfReader
            text = re.sub(r'\s+', ' ', ' '.join(p.extract_text() or '' for p in PdfReader(str(path)).pages))
            _courses[key] = [{'code': m['code'], 'title': m['title'].strip(),
                              'status': 'in progress' if float(m['completed']) == 0 < float(m['attempted']) else 'completed'}
                             for m in COURSE.finditer(text)]
        except Exception:
            _courses[key] = []
    return _courses[key]


def profile_experience(profile):
    """His confirmed experience beyond the resume: work history, projects and skills from profile.json, and the
    courses on his transcript (documents.transcript)."""
    keep = {'workHistory': ('title', 'company', 'location', 'from', 'to', 'description'),
            'projects': ('name', 'sponsor', 'program', 'drafts', 'summary', 'description')}
    out = {key: [{k: e[k] for k in fields if e.get(k)} for e in profile.get(key) or [] if isinstance(e, dict)] for key, fields in keep.items()}
    out['skills'] = [profile.get('resumeSkills'), profile.get('additionalConfirmedSkills')]
    out['transcriptCourses'] = transcript_courses((profile.get('documents') or {}).get('transcript'))
    return out


def _norm(text):
    # ATS-style matching: case, '&' vs 'and', hyphens and slashes, punctuation and plural 's' do not matter.
    text = re.sub(r'[-/]', ' ', str(text).casefold().replace('&', ' and '))
    words = re.findall(r'[a-z0-9+#.]+', text)
    return ' ' + ' '.join(w.rstrip('.').removesuffix('s') if len(w) > 3 else w.rstrip('.') for w in words) + ' '


def coverage(keywords, resume):
    """Which posting keywords appear in a resume's text, as an ATS would match them."""
    text = _norm(resume_doc.plain_text(resume) if isinstance(resume, dict) else resume)
    found = [k for k in keywords if k and _norm(k) in text]
    return {'found': found, 'missing': [k for k in keywords if k and k not in found], 'total': len([k for k in keywords if k])}


def review_prompt(job, base, variants, older, experience, kept=()):
    posting = {'company': job['company'], 'title': job['title'], 'location': job.get('location'),
               'description': (job.get('description') or '')[:setting('review.max_description_chars')]}
    copies = [{'variant_id': v['id'], 'label': v['label'], 'focus': v.get('focus', ''), 'resume': v['resume']} for v in variants]
    return (f'Standing resume (JSON):\n{json.dumps(base, ensure_ascii=False)}\n\n'
            f'Approved tailored copies (JSON):\n{json.dumps(copies, ensure_ascii=False)}\n\n'
            f'Older resumes (fact sources only):\n{json.dumps(older, ensure_ascii=False)}\n\n'
            f'Courses on his transcript (JSON):\n{json.dumps(experience.get("transcriptCourses") or [], ensure_ascii=False)}\n\n'
            f'Confirmed experience from his profile (JSON):\n{json.dumps({k: v for k, v in experience.items() if k != "transcriptCourses"}, ensure_ascii=False)[:14000]}\n\n'
            f'Areas where he chose his standing resume over a tailored draft (use "base" for these): '
            f'{json.dumps([k["focus"] for k in kept], ensure_ascii=False)}\n\n'
            f'Posting (JSON):\n{json.dumps(posting, ensure_ascii=False)}')


def _claude(prompt, run):
    command = _cli('claude')
    if not command:
        raise RuntimeError('claude CLI not found')
    args = [command, '-p', '--output-format', 'json', '--json-schema', json.dumps(SCHEMA), '--system-prompt', SYSTEM,
            '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--model', model_id('workers.resume_review_model')]
    with tempfile.TemporaryDirectory(prefix='jobagent-resume-') as directory:
        result = run(args, input=prompt, text=True, capture_output=True, env=_env(), cwd=directory, timeout=setting('workers.resume_review_timeout_seconds'))
    data = json.loads(result.stdout or 'null') if result.returncode == 0 else None
    if not data or data.get('is_error') or not data.get('structured_output'):
        raise RuntimeError(f'Resume review did not complete: {str((data or {}).get("result") or result.stderr)[:200]}')
    return data['structured_output']


def reword_prompt(draft, keywords, verify, job, sources):
    return (f'Posting keywords (keep verbatim): {json.dumps(keywords, ensure_ascii=False)}\n\n'
            f'Posting: {job["company"]}, {job["title"]}\n\n'
            f'His sources (facts only):\n{sources[:20000]}\n\n'
            f'Verify list so far: {json.dumps(verify, ensure_ascii=False)}\n\n'
            f'Tailored draft (JSON):\n{json.dumps({"sections": draft["sections"]}, ensure_ascii=False)}')


def _codex(prompt, run):
    command = _cli('codex')
    if not command:
        raise RuntimeError('codex CLI not found')
    with tempfile.TemporaryDirectory(prefix='jobagent-resume-reword-') as directory:
        schema, output = Path(directory) / 'schema.json', Path(directory) / 'result.json'
        schema.write_text(json.dumps(REWORD_SCHEMA))
        args = [command, 'exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config',
                '--sandbox', 'read-only', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'multi_agent',
                '-c', 'model_reasoning_effort="low"', '--output-schema', str(schema), '-o', str(output), '-C', directory]
        if setting('workers.resume_reword_codex_model'):
            args += ['-m', setting('workers.resume_reword_codex_model')]
        result = run(args + ['-'], input=f'{REWORD}\n\n{prompt}', text=True, capture_output=True, env=_env(), timeout=setting('workers.resume_review_timeout_seconds'))
        if result.returncode or not output.exists():
            raise RuntimeError(f'Codex reword did not complete: {(result.stderr or "")[-200:]}')
        return json.loads(output.read_text())


def _opencode(prompt, run):
    command, model = _cli('opencode'), setting('workers.resume_reword_opencode_model')
    if not command:
        raise RuntimeError('opencode CLI not found')
    config = json.dumps({'agent': {'jobagent': {'mode': 'primary', 'tools': {'*': False}, 'permission': {'*': 'deny'}}}})
    with tempfile.TemporaryDirectory(prefix='jobagent-resume-reword-') as directory:
        result = run([command, 'run', '--standalone', '--agent', 'jobagent', '--model', model, '--format', 'json'],
                     input=f'{REWORD}\nReturn only JSON matching {json.dumps(REWORD_SCHEMA)}.\n\n{prompt}', text=True, capture_output=True,
                     env={**_env(), 'OPENCODE_CONFIG_CONTENT': config}, cwd=directory, timeout=setting('workers.resume_review_timeout_seconds'))
    texts, failure = [], ''
    for line in (result.stdout or '').splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        texts += [t for t in [(event.get('part') or {}).get('text'), event.get('text')] if isinstance(t, str) and t]
        if event.get('type') == 'error':
            failure = str((event.get('error') or {}).get('message') or event.get('error'))
    found = re.search(r'\{[\s\S]*\}', texts[-1] if texts else '')
    if result.returncode or not found:
        raise RuntimeError(f'OpenCode reword did not complete: {(failure or result.stderr or "")[-200:]}')
    return json.loads(found.group(0))


def reword(draft, keywords, verify, job, base, facts, run):
    """A second model's wording of the draft, or None (with the reason) when no engine produced one that keeps
    the draft's fit, keywords and entries."""
    engine = setting('workers.resume_reword_engine')
    engines = {'codex': [('codex', _codex), ('opencode', _opencode)], 'opencode': [('opencode', _opencode)]}.get(engine, [])
    prompt, errors, sources = reword_prompt(draft, keywords, verify, job, facts), [], facts.casefold()
    entries = lambda d: [(s['title'], [(e['org'], e['role']) for e in s.get('entries', [])]) for s in d['sections']]
    for name, call in engines:
        try:
            answer = call(prompt, run)
            candidate, flags = guard({'name': '', 'contact': [], 'sections': answer.get('sections') or []}, base, sources)
        except Exception as exc:
            errors.append(f'{name}: {str(exc)[:160]}')
            continue
        if entries(candidate) != entries(draft):
            errors.append(f'{name}: changed the entries'); continue
        if not resume_doc.fit(candidate)['fits']:
            errors.append(f'{name}: ran past the page'); continue
        if len(coverage(keywords, candidate)['found']) < len(coverage(keywords, draft)['found']):
            errors.append(f'{name}: dropped posting keywords'); continue
        said = [str(v)[:300] for v in answer.get('verify') or []][:16]
        return {'draft': candidate, 'verify': list(dict.fromkeys(verify + said + flags)), 'by': name}, errors
    return None, errors


def guard(draft, base, sources):
    """Hold a draft to his facts: name, contact and education come from the standing resume, and an entry no source
    names is flagged for him to check."""
    draft = {**draft, 'name': base['name'], 'contact': base['contact']}
    education = next((s for s in base['sections'] if s['title'] == 'EDUCATION'), None)
    flags = []
    for section in draft['sections']:
        if section['title'] == 'EDUCATION' and education:
            mine = {(e['org'], e['role']): e for e in education['entries']}
            section['entries'] = [{**e, 'dates': mine[(e['org'], e['role'])]['dates']} if (e['org'], e['role']) in mine else e
                                  for e in section['entries']]
            section['style'] = 'education'
            continue
        for entry in section.get('entries', []):
            if entry['org'] and entry['org'].casefold() not in sources:
                flags.append(f"New entry \"{entry['org']}\" is not in your resumes or profile")
    return resume_doc.normalize(draft), flags


def review(job, base, variants, older, experience, kept=(), run=subprocess.run):
    """The reviewer's verdict; a tailored draft comes back fitted to one page (or marked as running over)."""
    prompt = review_prompt(job, base, variants, older, experience, kept)
    verdict = _claude(prompt, run)
    ids = {v['id']: v for v in variants}
    kind = verdict['verdict'] if verdict['verdict'] != 'variant' or verdict.get('variant_id') in ids else 'tailor'
    # A saved copy is reused only when it already carries most of this posting's keywords (Tesla 2977/14641 were
    # handed a copy matching 6 of 15); otherwise the posting gets its own draft.
    keywords = [str(k) for k in verdict.get('keywords', [])]
    if kind == 'variant' and keywords and len(coverage(keywords, ids[verdict['variant_id']]['resume'])['found']) < VARIANT_COVERAGE * len(keywords):
        kind, verdict = 'tailor', {**verdict, 'sections': []}
    out = {'verdict': kind, 'variant_id': verdict.get('variant_id') if kind == 'variant' else None,
           'focus': str(verdict.get('focus', ''))[:80], 'summary': str(verdict.get('summary', ''))[:600],
           'keywords': [str(k)[:60] for k in verdict.get('keywords', [])][:24], 'reviewed_at': now()}
    if kind != 'tailor':
        return out
    if not verdict.get('sections'):  # a "variant" pointing at an unknown copy, or an empty draft: ask for the draft
        verdict = _claude(prompt + '\n\nReturn verdict "tailor" with the complete tailored resume.', run)
    facts = json.dumps([base, [v['resume'] for v in variants], older, experience], ensure_ascii=False)
    sources = facts.casefold()
    best = None
    # Up to two revisions: work in posting keywords still missing, and bring an overflowing draft back to one page.
    for attempt in range(3):
        draft, flags = guard({'name': '', 'contact': [], 'sections': verdict.get('sections') or []}, base, sources)
        fitted, cov = resume_doc.fit(draft), coverage(out['keywords'], draft)
        score = (fitted['fits'], len(cov['found']))
        if best is None or score > best[0]:
            best = (score, draft, flags, verdict.get('verify', []))
        asks = []
        if not fitted['fits']:
            asks.append(f"It runs {fitted['lines_over']} printed line(s) past the one page: shorten it by at least that many lines, keeping the strongest content.")
        if cov['total'] and len(cov['found']) < 0.8 * cov['total']:
            asks.append(f"These posting keywords are still missing: {json.dumps(cov['missing'])}. Work each one in verbatim wherever his sources "
                        'support the underlying work (reword bullets, the coursework line or the skills lines); leave out any he has no basis for.')
        if not asks or attempt == 2:
            break
        retry = _claude(f"{prompt}\n\nYour draft (JSON):\n{json.dumps(draft, ensure_ascii=False)}\n\n" + ' '.join(asks) +
                        ' Return the complete revised resume, keep it to one page, and list in verify every statement not explicit in his sources.', run)
        if not retry.get('sections'):
            break
        verdict = retry
    _, draft, flags, verify = best
    verify = [str(v)[:300] for v in verify][:12] + flags
    if best[0][0]:  # only a draft that fits the page is reworded
        reworded, errors = reword(draft, out['keywords'], verify, job, base, facts, run)
        if reworded:
            draft, verify, out['reworded_by'] = reworded['draft'], reworded['verify'], reworded['by']
        if errors:
            out['reword_errors'] = errors
    out.update(draft=draft, verify=verify,
               fit=resume_doc.fit(draft), coverage=coverage(out['keywords'], draft), base_coverage=coverage(out['keywords'], base))
    return out


class ResumeReviewer:
    """Runs reviews in the background, at most `capacity` at once; results land in resume-reviews.json via `store`."""

    def __init__(self, store, run=subprocess.run, capacity=2):
        self.store, self.run, self.capacity = store, run, capacity
        self.pending = set()
        self._lock = threading.Lock()

    def busy(self):
        with self._lock:
            return len(self.pending) >= self.capacity

    def start(self, job_id, inputs):
        """inputs() returns review()'s positional inputs; it runs on the review thread."""
        with self._lock:
            if job_id in self.pending:
                return True
            if len(self.pending) >= self.capacity:
                return False
            self.pending.add(job_id)

        def work():
            try:
                result = review(*inputs(), run=self.run)
            except Exception as exc:  # never block an application on a failed review
                result = {'verdict': 'base', 'error': str(exc)[:300], 'reviewed_at': now()}
            try:
                self.store(job_id, result)
            finally:
                with self._lock:
                    self.pending.discard(job_id)
        threading.Thread(target=work, name=f'resume-review-{job_id}', daemon=True).start()
        return True
