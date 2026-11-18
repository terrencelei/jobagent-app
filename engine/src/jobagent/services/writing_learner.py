"""Future written answers learn from how he edits and approves the current ones (his request, 2026-10-22).

Three parts, all in application-agent's private/ folder so the drafting skill reads the same files:
- writing-feedback.jsonl: every approved written answer with the draft he was shown, so his edits are kept.
- writing-style.md: a short style guide a model infers from those edits (what he cuts, adds, rewords,
  length, tone, claims he avoids), rebuilt in the background after each edited approval.
- Drafts: each written question parked on Approvals is drafted by a model from the posting, his
  confirmed experience, the style guide, his approved answers (it picks the relevant ones by meaning)
  and his recent edits. Drafts stay review-only; nothing here approves or submits anything.
"""
import json
import re
import subprocess
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

from .attention_triage import FACTUAL, WRITING
from .fit_review import _cli, _env
from .resume_review import profile_experience
from . import unai
from ..settings import model_id, setting
from .. import identity

MIN_WORDS = 8  # shorter answers are facts, not writing
STYLE_SCHEMA = {'type': 'object', 'additionalProperties': False, 'properties': {'guide': {'type': 'string'}}, 'required': ['guide']}
DRAFT_SCHEMA = {'type': 'object', 'additionalProperties': False, 'properties': {'drafts': {'type': 'array', 'items': {
    'type': 'object', 'additionalProperties': False, 'properties': {
        'label': {'type': 'string'}, 'draft': {'type': 'string'}, 'examples_used': {'type': 'array', 'items': {'type': 'string'}},
        'notes': {'type': 'string'}}, 'required': ['label', 'draft', 'examples_used', 'notes']}}}, 'required': ['drafts']}

STYLE_SYSTEM = """You maintain a short writing style guide for one job applicant, {name}, a {major} new grad.
You get the current guide and pairs of (draft he was shown, answer he approved) from his job applications.
Infer ONLY from what his edits show: what he cuts, adds, reorders or rewords; length; tone and voice; how he
frames projects and claims; phrases he removes; facts he corrects. Unedited approvals show drafts he accepted
as they were.
Write the guide as at most 12 rules, each one line plus a short before -> after quote from his edits. Newer
edits win over older ones; drop rules his newer edits contradict. Do not invent preferences the pairs do not
show. Under 450 words. Markdown bullet list, no preamble."""

DRAFT_SYSTEM = """You draft written answers to job-application questions for {name}, a {major} new grad,
for his review. He edits and approves every draft before it is submitted, and his approved wording is used verbatim.
Follow his writing style guide; it is learned from how he edits drafts. Reuse and adapt his approved answers to
similar questions (choose them by meaning, not keywords). Match his recent edits.
Rules: facts only from his profile, resume experience and approved answers; never invent numbers, results, tools,
team sizes or dates. Respect every caution listed with a project or role in the profile (what they did and did
not do); never claim beyond it. Motivation answers must be specific to this company and role, from the posting;
never carry another company's name or motivation over. No cliches ("passionate", "fast-paced"). First person, plain,
specific. Respect any word limit. A cover letter follows the cover-letter template given and is the whole letter,
greeting to sign-off. In examples_used list the companies/questions of the approved answers you drew on; in notes,
anything he should confirm.

""" + unai.RULES

REVISE_SYSTEM = """You revise drafted job-application answers so they read as plainly written by the applicant.
Each draft comes with the phrases that were flagged. Make the smallest change that removes each flagged pattern,
unless the phrase is literal or technical and doing real work, in which case keep it. Never change a fact, number,
name, tool, date or claim, never add content, and never go over the word limit. Keep his first-person voice.

""" + unai.RULES
REVISE_SCHEMA = {'type': 'object', 'required': ['drafts'], 'properties': {'drafts': {'type': 'array', 'items': {
    'type': 'object', 'required': ['label', 'draft'], 'properties': {'label': {'type': 'string'}, 'draft': {'type': 'string'}}}}}}


def now():
    return datetime.now(timezone.utc).isoformat()


def words(text):
    return len(str(text or '').split())


def is_writing(question):
    """A question whose answer is his prose (not a fact or a choice)."""
    label = question.get('label') or ''
    if question.get('options'):
        return False
    if re.search(r'cover\s*letter', label, re.I):
        return True
    if FACTUAL.search(label):
        return False
    return bool(WRITING.search(label) or re.search(r'\b(?:excit\w*|interest\w*|passion\w*|inspir\w*)\b', label, re.I)
                or question.get('type') == 'textarea' and re.search(r'\b(?:describe|explain|tell|share|why|what|how)\b', label, re.I))


class WritingLearner:
    def __init__(self, agent_dir, run=subprocess.run):
        self.private = Path(agent_dir) / 'private'
        self.feedback = self.private / 'writing-feedback.jsonl'
        self.style = self.private / 'writing-style.md'
        self.run = run
        self._lock = threading.Lock()
        self._style_running = self._style_dirty = False
        self.drafting = set()

    # ---------------------------------------------------------------- capture

    def record(self, job, approvals):
        """approvals: [{question, answer, draft}] for one approval; keeps the written ones with the draft he saw."""
        entries = [{'at': now(), 'job_id': job.get('job_id'), 'company': job.get('company'), 'title': job.get('title'),
                    'question': a['question'], 'draft': (a.get('draft') or '').strip(), 'final': a['answer'].strip(),
                    'edited': bool(a.get('draft')) and (a.get('draft') or '').strip() != a['answer'].strip()}
                   for a in approvals if a.get('answer') and (words(a['answer']) >= MIN_WORDS or words(a.get('draft')) >= MIN_WORDS)
                   and (is_writing({'label': a['question'], 'type': a.get('type')})
                        or words(a['answer']) >= MIN_WORDS and not FACTUAL.search(a['question']))]
        if not entries:
            return []
        with self._lock:
            self.private.mkdir(parents=True, exist_ok=True)
            with self.feedback.open('a') as f:
                for e in entries:
                    f.write(json.dumps(e, ensure_ascii=False) + '\n')
        if any(e['edited'] for e in entries):
            self.refresh_style_later()
        return entries

    def entries(self):
        try:
            return [json.loads(line) for line in self.feedback.read_text().splitlines() if line.strip()]
        except (OSError, ValueError):
            return []

    # ---------------------------------------------------------------- learn

    def refresh_style_later(self):
        with self._lock:
            if self._style_running:
                self._style_dirty = True
                return
            self._style_running = True

        def work():
            while True:
                try:
                    self.refresh_style()
                except Exception:
                    pass  # the old guide stays; the next edited approval tries again
                with self._lock:
                    if not self._style_dirty:
                        self._style_running = False
                        return
                    self._style_dirty = False
        threading.Thread(target=work, name='writing-style', daemon=True).start()

    def refresh_style(self):
        log = self.entries()
        edited = [e for e in log if e['edited']][-30:]
        if not edited:
            return None
        accepted = [e for e in log if not e['edited']][-10:]
        current = self.style.read_text() if self.style.is_file() else '(none yet)'
        prompt = (f'Current guide:\n{current}\n\nHis edits, oldest first (JSON):\n'
                  + json.dumps([{k: e[k] for k in ('company', 'question', 'draft', 'final')} for e in edited], ensure_ascii=False)
                  + '\n\nDrafts he approved unchanged (JSON):\n'
                  + json.dumps([{k: e[k] for k in ('company', 'question', 'final')} for e in accepted], ensure_ascii=False)[:8000])
        guide = self._claude(prompt, identity.personalize(STYLE_SYSTEM), STYLE_SCHEMA)['guide'].strip()
        header = (f'<!-- Learned from {len(edited)} edited and {len(accepted)} unedited approvals; '
                  f'rebuilt {now()} by jobagent writing_learner. Edit freely; it is used as written. -->\n')
        self.style.write_text(header + guide + '\n')
        return guide

    # ---------------------------------------------------------------- use

    def examples(self, bank_dir):
        """His approved written answers across employers, newest first."""
        out = []
        for path in Path(bank_dir).glob('*.json'):
            try:
                bank = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            if path.stem in ('shared',):
                continue
            for a in (bank.get('answers') or {}).values():
                if isinstance(a.get('answer'), str) and words(a['answer']) >= MIN_WORDS and a.get('approvedAt') and a.get('question') \
                        and is_writing({'label': a['question'], 'type': a.get('type')}):
                    out.append({'company': bank.get('company') or path.stem, 'question': a['question'], 'answer': a['answer'], 'at': a['approvedAt']})
        return sorted(out, key=lambda e: e['at'], reverse=True)

    def draft(self, job, questions, profile, bank_dir, template=''):
        """Model drafts for written questions: {label: {draft, note}}."""
        edits = [{k: e[k] for k in ('company', 'question', 'draft', 'final')} for e in self.entries() if e['edited']][-10:]
        style = self.style.read_text() if self.style.is_file() else '(no guide yet)'
        posting = {'company': job.get('company'), 'title': job.get('title'), 'location': job.get('location'),
                   'description': (job.get('description') or '')[:12000]}
        asks = [{'label': q['label'], 'max_words': q.get('maxWords'), 'required': bool(q.get('required'))} for q in questions]
        prompt = (f'His writing style guide:\n{style}\n\nHis recent edits (draft -> approved, JSON):\n{json.dumps(edits, ensure_ascii=False)[:9000]}\n\n'
                  f'His approved answers (JSON, newest first):\n{json.dumps(self.examples(bank_dir)[:40], ensure_ascii=False)[:16000]}\n\n'
                  f'His confirmed experience (JSON):\n{json.dumps(profile_experience(profile), ensure_ascii=False)[:12000]}\n\n'
                  + (f'Cover-letter template:\n{template[:6000]}\n\n' if template else '')
                  + f'Posting (JSON):\n{json.dumps(posting, ensure_ascii=False)}\n\nQuestions to draft (JSON):\n{json.dumps(asks, ensure_ascii=False)}')
        result = self._claude(prompt, identity.personalize(DRAFT_SYSTEM), DRAFT_SCHEMA)
        labels = {q['label'] for q in questions}
        out = {}
        for d in result.get('drafts', []):
            if d.get('label') in labels and d.get('draft', '').strip():
                used = ', '.join(d.get('examples_used') or [])[:200]
                note = 'Drafted from your writing style guide' + (f' and your approved answers ({used})' if used else '') + '.'
                if d.get('notes'):
                    note += f" Check: {d['notes'][:300]}"
                out[d['label']] = {'draft': d['draft'].strip(), 'note': note}
        return self.plain(out, {q['label']: q.get('maxWords') for q in questions})

    def plain(self, drafts, limits=None):
        """One revision pass over drafts that still show machine-sounding phrasing (services/unai.py). A revision is
        kept only when it shows fewer such patterns, stays within the word limit and has not grown or shrunk by
        more than a fifth; otherwise the first draft stands. A failed pass never loses a draft."""
        flagged = {label: unai.tells(d['draft']) for label, d in drafts.items()}
        flagged = {label: hits for label, hits in flagged.items() if hits}
        if not flagged:
            return drafts
        asks = [{'label': label, 'max_words': (limits or {}).get(label), 'flagged': [f'{kind}: "{phrase}"' for kind, phrase in hits],
                 'draft': drafts[label]['draft']} for label, hits in flagged.items()]
        try:
            result = self._claude('Drafts to revise (JSON):\n' + json.dumps(asks, ensure_ascii=False), REVISE_SYSTEM, REVISE_SCHEMA)
        except Exception:
            return drafts
        for revised in result.get('drafts', []):
            label, text = revised.get('label'), str(revised.get('draft') or '').strip()
            if label not in flagged or not text:
                continue
            before, limit = drafts[label]['draft'], (limits or {}).get(label)
            words = len(text.split())
            if len(unai.tells(text)) < len(flagged[label]) and (not limit or words <= limit) and 0.8 <= words / max(1, len(before.split())) <= 1.2:
                drafts[label] = {**drafts[label], 'draft': text}
        return drafts

    def _claude(self, prompt, system, schema):
        command = _cli('claude')
        if not command:
            raise RuntimeError('claude CLI not found')
        args = [command, '-p', '--output-format', 'json', '--json-schema', json.dumps(schema), '--system-prompt', system,
                '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--model', model_id('workers.writing_model')]
        with tempfile.TemporaryDirectory(prefix='jobagent-writing-') as directory:
            result = self.run(args, input=prompt, text=True, capture_output=True, env=_env(), cwd=directory, timeout=setting('workers.resume_review_timeout_seconds'))
        data = json.loads(result.stdout or 'null') if result.returncode == 0 else None
        if not data or data.get('is_error') or not data.get('structured_output'):
            raise RuntimeError(f'Writing model did not complete: {str((data or {}).get("result") or result.stderr)[:200]}')
        return data['structured_output']
