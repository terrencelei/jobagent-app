"""Durable local application queue and bounded browser worker supervision."""
from __future__ import annotations
import json
import logging
import os
import re
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from sqlalchemy import and_, func, or_

from ..config import get_settings
from ..db.models import Application, Job, JobStatus
from . import failure_signatures, platform_yield
from ..db.repository import get_db_session, JobRepository
from .fit_review import FitReviewer, current as review_current, learnings
from . import resume_doc
from .writing_learner import WritingLearner, is_writing
from .resume_review import ResumeLibrary, ResumeReviewer, coverage, decode_upload, profile_experience
from .rule_tuner import RuleTuner
from ..settings import save as save_settings, setting
from ..processing.tracks import active_track, get_track, per_track
from ..processing import application_caps
from .. import identity
from .. import vault

TERMINAL = {'completed', 'failed', 'stopped', 'interrupted', 'submitted', 'submitted_pending_receipt', 'submission_unknown', 'blocked', 'skipped',
            'needs_approval', 'ready_to_submit', 'needs_verification', 'needs_human', 'needs_cap_approval', 'needs_resume'}
# Anything that needs him is parked: the run ends, its slot takes the next role, and the role
# waits on the Approvals page until he acts, then goes back to the front of the queue.
PARKED = {'needs_approval', 'ready_to_submit', 'needs_verification', 'needs_human', 'blocked', 'needs_cap_approval', 'needs_resume'}
# Approvals holds only decisions he makes (answers, final approval, a verification link);
# postings the agent could not finish go to Needs help, each with its own chat agent.
ATTENTION = {'needs_approval', 'ready_to_submit', 'needs_verification', 'waiting_review', 'awaiting_review', 'waiting_answers', 'needs_cap_approval', 'needs_resume'}
HELP = {'blocked', 'needs_human', 'failed', 'interrupted', 'submission_unknown'}
# At this volume, select individual roles for the queue instead of spending the employer's
# application budget by taking every matching posting through autoplay.
AUTOPLAY_MANUAL_SELECTION_ROLE_THRESHOLD = 5
# A timeout or a crash is worth one automatic retry before anyone is asked.
TECHNICAL = re.compile(r'Timeout \d+ms exceeded|timed out|Target (page, context or browser )?(has been )?closed|net::ERR|'
                       r'Navigation failed|did not change its state|Execution context was destroyed|browserType\.launch|'
                       r'exited with code|ECONNRESET|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|socket hang up|Protocol error|page changed or a control could not be identified|Workday menu ownership is ambiguous|Resume parser produced|'
                       r'(?:Saved )?Work-history (?:draft is incomplete|reconstruction|verification|date segment|row \d+|Add|Delete)|'
                       r'Cannot reopen saved My Experience|Cannot identify (?:the )?(?:work-history|Work Experience|Education)|Workday Back|Education Add|School dropdown did not resolve|Workday menu did not load valid options', re.I)
# Employer throttles must never pause every application as an AI plan limit.
# Ambiguous HTTP/quota language needs an explicit AI provider or CLI context.
MODEL_LIMIT = re.compile(
    r'(?:usage|session|weekly|daily) limit|'
    r'(?:claude|codex|anthropic|openai|\bCLI\b)[^\n]{0,100}(?:rate limit|limit reached|quota|too many requests)|'
    r'(?:rate limit|limit reached|quota|too many requests)[^\n]{0,100}(?:claude|codex|anthropic|openai|\bCLI\b)', re.I)
AUTO_RETRIES = 1
REPAIRABLE = re.compile(TECHNICAL.pattern + r'|did not retain|could not be verified|dropdown|locator\.|shows [“"\']?Loading|no .*controls|missing application form'
                        r'|^Preparation reached its step limit\. Review the saved view before continuing\.$'
                        r'|^Workday stopped: stayed on (?:Application Questions(?: \d+ of \d+)?|Self Identify)(?:: Errors Found\b|$)'
                        r'|^Workday sign-in: sign-in did not complete(?:\.|$)'
                        r'|^Required fields still need answers: If [\"\']?N/A Other Location[\"\']? selected above,? please explain\s*\*?\s*$', re.I)
REPAIR_BOUNDARY = re.compile(r'captcha|recaptcha|verify you are human|verification code|no saved password|different password|unknown personal|rate-limited|site unavailable:', re.I)


def repair_history(entry):
    return entry.get('attempts', [entry]) if entry else []


# Help repairs escalate across distinct models and stop after three verified attempts.
REPAIR_MODELS = ('claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1')
# Models he can pick per posting on the Help page (first is the engine default).
AGENT_MODELS = {'claude': ('claude-haiku-5-5', 'claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5'),
                'codex': ('gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.4-mini', 'gpt-6.1-sol')}


def repair_allowed(entry, message):
    return len(repair_history(entry)) < len(REPAIR_MODELS)
# An employer site that answers with an error page instead of the form (Workday's "Something went
# wrong ... refresh the page", a 429) is slowing an automated browser down. application-agent
# reports it with a message starting "Rate-limited"; the role goes to the back of the queue and that
# employer is left alone for a while, longer each time, before Needs help is asked.
THROTTLED = re.compile(r'\bRate-limited\b|^Site unavailable:|Too Many Attempts|'
                       r'maximum number of attempts|(?:employer|application site|website)[^\n]{0,100}rate limit', re.I)
# Rate-limit cool-downs, the parallelism cap and steps per run are dashboard settings (jobagent/settings.py).
# Mirrors INTENTS in application-agent/src/companies.mjs: one question, many wordings.
QUESTION_INTENTS = [
    ('how-heard', re.compile(r'how did you (first )?(hear|learn|find out) about|how did you (find|discover) (out about )?(us|this|the|our)|where did you (hear|find|learn) about|(referral|application|candidate) source\b|source of (your )?(application|referral)', re.I)),
    ('phone-type', re.compile(r'phone (device )?type', re.I)),
    ('address-line-1', re.compile(r'^(street )?address( line)? ?1?\s*\*?$|^street address', re.I)),
    ('postal-code', re.compile(r'postal code|zip ?code|^zip\b', re.I)),
    ('city', re.compile(r'^city\s*\*?$', re.I)),
]


def question_key(label):
    label = ' '.join(str(label).replace('*', '').split()).strip()
    intent = next((name for name, pattern in QUESTION_INTENTS if pattern.search(label)), None)
    return f'intent:{intent}' if intent else label.lower()


def names_company(text, company):
    words = [w for w in re.split(r'[^a-z0-9]+', str(company).lower()) if len(w) >= 3]
    return any(re.search(rf'\b{re.escape(w)}\b', str(text).lower()) for w in words)
NO_WORKDAY_PASSWORD = 'WORKDAY_PASSWORD'
ELIGIBLE = {'STRONG_MATCH', 'ELIGIBLE'}
APPLICATION_ROLE_TYPES = {'FULL_TIME', 'INTERNSHIP'}
INTERN_TITLE = re.compile(r'\b(?:intern|interns|internship|co-?op)\b', re.I)


def application_role_types():
    """Role types applied to: full-time, plus internships only while workers.apply_internships is on
    (off since his choice of 2026-11-02)."""
    return {'FULL_TIME', 'INTERNSHIP'} if setting('workers.apply_internships') else {'FULL_TIME'}


def internship_blocked(role_type, title):
    """An internship (by type or by an Intern / Internship / Co-op title) while internships are off."""
    return not setting('workers.apply_internships') and (value(role_type) == 'INTERNSHIP' or bool(INTERN_TITLE.search(title or '')))
# Both engines run through their CLI on the applicant's subscription login, never an API key.
ENGINES = {'claude': 'Claude', 'codex': 'Codex'}
# Application workers may also run on agy (the Antigravity CLI): application-agent cycles through its
# models (model-fallback.mjs). Help chats and repair agents stay on Claude or Codex.
WORKER_ENGINES = {**ENGINES, 'agy': 'agy', 'opencode': 'OpenCode'}
# Discipline filters are jobagent's career clusters.
DISCIPLINES = ['PRODUCT / MECHANICAL DESIGN', 'HARDWARE / SYSTEMS', 'MANUFACTURING / EQUIPMENT / AUTOMATION',
               'AEROSPACE / VEHICLE', 'ROBOTICS / MECHATRONICS', 'DATA / ENGINEERING ANALYTICS', 'TECHNICAL PROGRAM MANAGEMENT']
# Autoplay only takes roles a new graduate can claim; explicit queueing is left to the applicant.
SENIOR_TITLE = re.compile(r'\b(II|III|IV|Senior|Sr\.?|Staff|Lead|Principal|Manager|Director|Head of)\b', re.I)
RECENT = TERMINAL - {'completed', 'submitted', 'skipped'}  # finished runs the Applications panel lists under Recent
REQUEUEABLE = {'failed', 'stopped', 'interrupted', 'skipped'}  # an explicit queue request may revive a skipped role
# A site refusing the worker's browser outright (Akamai / Cloudflare access-denied pages, HTTP 403).
# An employer page saying he already applied to this posting (application-agent src/already-applied.mjs).
ALREADY_APPLIED = re.compile(r"(?:you(?:'ve| have)?|our records show (?:that )?you(?: have)?) already (?:applied|submitted an application) (?:for|to) this (?:position|job|role|opening|requisition|posting)", re.I)
ACCESS_DENIED = re.compile(r'access denied|\bHTTP 403\b|403 Forbidden', re.I)
AGGREGATOR_REFUSAL = 'is a job board the worker cannot apply through'
# Runs that end any of these ways are not failures of the posting: he is deciding, or it went out.
SETTLED = ATTENTION | {'completed', 'submitted', 'submitted_pending_receipt', 'submission_unknown'}


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_suffix('.tmp')
    with open(tmp, 'w', encoding='utf-8') as stream:
        os.chmod(tmp, 0o600)
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    tmp.replace(path)


def read(path, default=None):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def value(v):
    return getattr(v, 'value', v)


class ApplicationRunner:
    def __init__(self, directory=None, agent_dir=None, session_factory=None, popen=None, fit_reviewer=None):
        # After each review batch the rule tuner checks whether the fixed rules have drifted from
        # the reviewer and his labels far enough to revise them.
        self.fit_reviewer = fit_reviewer or FitReviewer(after_batch=RuleTuner().maybe_tune)
        # Limits he set by hand in application-agent's profile (SpaceX) count as already allowed.
        application_caps.seed_from_policy(agent_dir)
        self.directory = Path(directory or get_settings().data_dir / 'application-runner')
        self.agent_dir = Path(agent_dir or _agent_dir())
        self.sessions = session_factory or get_db_session
        self.popen = popen or subprocess.Popen
        self.lock = threading.RLock()
        self.resume_library = ResumeLibrary(self.agent_dir)
        self.resume_reviewer = ResumeReviewer(self._store_resume_review)
        self.writing = WritingLearner(self.agent_dir)
        self.processes = {}
        self.receipt_processes = {}
        self.stop_times = {}
        self._manual_selection_cache_at = 0
        self._manual_selection_cache = set()
        self.shutdown_event = threading.Event()
        self.thread = None
        self._adaptive_started = None
        self._resource_sample = None
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.data = read(self.directory / 'queue.json', {'running': False, 'parallelism': 1, 'jobs': []})
        self.data['running'] = False
        self.data.setdefault('auto_repair_enabled', True)
        if self.data.get('engine') not in WORKER_ENGINES:
            self.data['engine'] = 'claude'
        self.data.setdefault('model', 'claude-sonnet-5-5')
        # Every worker uses the single dashboard model policy; migrate older per-slot overrides.
        self.data['slots'] = [self.data['engine']] * max(1, int(self.data.get('parallelism') or 1))
        self._fit_slots()
        self.data.setdefault('autoplay', {'enabled': True, 'disciplines': list(DISCIPLINES), 'include_eligible': False})
        # Each search track keeps its own discipline choice; the old single list was the mechanical one.
        self.data['autoplay'].setdefault('disciplines_by_track', {'mechanical': list(self.data['autoplay'].get('disciplines') or DISCIPLINES)})
        self.data.setdefault('auto_stop', {'approvals': 0, 'help': 0})
        self.data.setdefault('company_filter', [])
        self.data.setdefault('auto_stop_reason', None)
        self.data.setdefault('skipped', [])
        self.data.setdefault('capped', {})
        self.data.setdefault('cooling', {})
        self._stop_orphans()
        for item in self.data['jobs']:
            if item['status'] not in TERMINAL and item['status'] != 'queued':
                item.update(status='interrupted', message='Server restarted. Inspect the employer application before retrying.', updated_at=now())
        self._save()

    def _stop_orphans(self):
        # A hard server stop (launchd SIGKILL, a crash) leaves workers running with no one
        # watching them. Stop any worker whose command names one of this runner's run folders.
        try:
            listing = subprocess.run(['ps', '-axo', 'pid=,command='], capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.TimeoutExpired):
            return
        runs = {item['id'] for item in self.data['jobs']}
        for line in listing.splitlines():
            pid, _, command = line.strip().partition(' ')
            if not ('dashboard-worker.mjs' in command or 'dashboard-workday.mjs' in command) or str(self.directory) not in command:
                continue
            run = Path(command.split()[-1]).name
            if run not in runs:
                continue
            try:
                atomic(self.directory / run / 'commands.json', {'id': str(uuid.uuid4()), 'action': 'stop'})
                os.killpg(int(pid), signal.SIGTERM)
            except (OSError, ValueError):
                pass

    def _save(self):
        atomic(self.directory / 'queue.json', self.data)

    def _node(self):
        return shutil.which('node') or next((p for p in ['/opt/homebrew/bin/node', '/usr/local/bin/node'] if os.path.isfile(p) and os.access(p, os.X_OK)), None)

    def _resume(self):
        profile = read(self.agent_dir / 'private/profile.json', {})
        return self.agent_dir / profile.get('resumePath', f'private/{identity.resume_filename()}')

    @staticmethod
    def _cli(engine):
        # The dashboard server may start without the login shell's PATH.
        found = shutil.which('opencode' if engine == 'opencode' else engine)
        if found:
            return found
        home = Path.home()
        command = 'opencode' if engine == 'opencode' else engine
        return next((str(p) for p in [home / '.local/bin' / command, Path('/opt/homebrew/bin') / command, Path('/usr/local/bin') / command]
                     if p.is_file() and os.access(p, os.X_OK)), None)

    def model_options(self):
        """Current Claude choices and the account-specific Codex/OpenCode CLI catalogs."""
        options = [{'engine': 'claude', 'model': model, 'label': f'Claude · {model}'} for model in AGENT_MODELS['claude']]
        codex_command = self._cli('codex')
        codex_catalogued = False
        if codex_command:
            try:
                result = subprocess.run([codex_command, 'debug', 'models'], capture_output=True, text=True, timeout=10)
                catalog = json.loads(result.stdout).get('models', []) if result.returncode == 0 else []
                for row in catalog:
                    model = str(row.get('slug') or '').strip()
                    if model:
                        options.append({'engine': 'codex', 'model': model,
                                        'label': f"Codex · {row.get('display_name') or model}"})
                codex_catalogued = bool(catalog)
            except (OSError, subprocess.SubprocessError, ValueError):
                pass
        if not codex_catalogued:
            options.extend({'engine': 'codex', 'model': model, 'label': f'Codex · {model}'} for model in AGENT_MODELS['codex'])
        command = self._cli('opencode')
        if command:
            try:
                result = subprocess.run([command, 'models'], capture_output=True, text=True, timeout=10)
                if result.returncode == 0:
                    for model in dict.fromkeys(line.strip() for line in result.stdout.splitlines() if '/' in line):
                        options.append({'engine': 'opencode', 'model': model, 'label': f'OpenCode · {model}'})
            except (OSError, subprocess.TimeoutExpired):
                pass
        return options

    def configure_agent(self, engine, model, parallelism, usage):
        valid = {(row['engine'], row['model']) for row in self.model_options()}
        if (engine, model) not in valid and not (engine == 'agy' and not model):
            raise ValueError('Choose a model available to Claude, Codex, or OpenCode')
        if type(parallelism) is not int or not 1 <= parallelism <= setting('workers.max_parallelism'):
            raise ValueError(f"Parallel workers must be between 1 and {setting('workers.max_parallelism')}")
        if type(usage) is not int or not 0 <= usage <= 100:
            raise ValueError('Usage limit must be a whole percent from 0 to 100; 0 turns it off')
        with self.lock:
            self.data['engine'] = engine
            self.data['model'] = model
            self.data['parallelism'] = parallelism
            self.data['slots'] = [engine] * parallelism
            save_settings({'workers.usage_pause_percent': usage})
            self._fit_slots()
            self._save()
        return {'ok': True, 'engine': engine, 'model': model, 'parallelism': parallelism, 'usage_pause_percent': usage}

    def _fit_slots(self):
        # One agent per worker slot. New slots start on the default agent; extra ones are dropped.
        slots = [e for e in self.data.get('slots', []) if e in WORKER_ENGINES][:self.data['parallelism']]
        slots += [self.data['engine']] * (self.data['parallelism'] - len(slots))
        self.data['slots'] = slots

    def engines_in_use(self):
        return list(dict.fromkeys(self.data['slots']))

    def set_slot_engine(self, index, engine):
        if engine not in WORKER_ENGINES:
            raise ValueError('Engine must be claude, codex or agy')
        with self.lock:
            if not 0 <= index < len(self.data['slots']):
                raise ValueError('There is no such worker')
            self.data['slots'][index] = engine  # A role already running there keeps its agent.
            self._save()
            return self.snapshot()

    def engine_status(self):
        statuses = read(self.directory / 'engine-status.json', {})
        used = self.engines_in_use()
        checked = [statuses.get(e) for e in used]
        failing = next((c for c in checked if c and c.get('status') != 'ready'), None)
        if failing:
            return failing
        if not all(checked):
            return {}
        return {'status': 'ready', 'checked_at': min(c['checked_at'] for c in checked),
                'message': ' '.join(c['message'] for c in checked)}

    @property
    def configured(self):
        return bool(self._node() and all(self._cli(e) for e in self.engines_in_use()) and (self.agent_dir / 'src/dashboard-worker.mjs').is_file() and (self.agent_dir / 'private/profile.json').is_file() and self._resume().is_file())

    def _job(self, job_id, allow_other=False, human_finish=False):
        archived = [j for j in self.data.get('dismissed_items', []) if j['job_id'] == job_id and j.get('submission_resolution') != 'not_accepted'
                    and (j.get('status') == 'submission_unknown' or j.get('submission_attempted') or j.get('submitted'))]
        if archived:
            # A cleared posting whose durable record proves the employer refused it (the same retry-safe proof
            # reconcile_help accepts) may be applied to again; anything less keeps the duplicate guard.
            durable = read(self.agent_dir / 'state' / f'jobagent-{job_id}.json', {})
            if durable.get('status') == 'verification_not_accepted' and (durable.get('rejection') or {}).get('outcome') in {'rejected', 'verification_code'}:
                for entry in archived:
                    entry.update(submission_resolution='not_accepted', submission_reconciled_at=now())
            else:
                raise ValueError('This posting has archived submission evidence; reconcile it before retrying')
        with self.sessions() as session:
            job = session.get(Job, job_id)
            if not job:
                raise ValueError(f'Job {job_id} was not found')
            from ..processing.us_locations import is_us_location
            if not is_us_location(job.location):
                raise ValueError(f'Job {job_id}: U.S.-only policy requires a confirmed U.S. work location')
            # The shown verdict follows the dashboard's track toggle; a role he queued stays launchable
            # while any search track rates it eligible (or he labelled it a fit there), so flipping the
            # toggle to look at the other track never drops queued applications (2026-10-22).
            from ..processing.tracks import load_tracks
            tracks = list(load_tracks())
            verdicts = {value(job.eligibility)} | {(per_track(job.track_results, t) or {}).get('eligibility') for t in tracks}
            his_fit = any((per_track(job.user_fit_label, t) or {}).get('fit') is True for t in [active_track(), *tracks])
            if internship_blocked(job.role_type, job.title):
                raise ValueError(f'Job {job_id} is an internship; internships are off (Settings: Apply to internships)')
            normal = job.role_type in APPLICATION_ROLE_TYPES and (bool(verdicts & ELIGIBLE) or his_fit)
            explicit_other = (allow_other or job_id in self.data.get('explicit_other_jobs', [])) and job.role_type == 'OTHER' and bool(verdicts & (ELIGIBLE | {'LIKELY_ELIGIBLE'}))
            if value(job.status) not in {'NEW', 'ACTIVE', 'SAVED'} or not (normal or explicit_other):
                raise ValueError(f'Job {job_id} must be an eligible, unapplied full-time or internship role')
            if 'google' in job.company_name.casefold():
                raise ValueError('Google applications are paused')
            if self._manual(job.company_name):
                raise ValueError(f'{job.company_name}: you apply there yourself (Settings: Companies you apply to yourself)')
            from ..discovery.email_alerts import is_aggregator
            url = job.application_url or job.canonical_url
            if is_aggregator(url or ''):
                # ZipRecruiter, LinkedIn, Handshake...: the worker loops on their pages (119 ZipRecruiter runs for 2 postings).
                host = urlsplit(url).hostname or url
                raise ValueError(f"Job {job_id}: {host} {AGGREGATOR_REFUSAL}; add the employer's own posting link instead")
            existing = read(self.agent_dir / 'state' / f'jobagent-{job.id}.json', {})
            waiting_on_him = human_finish and existing.get('status') in {'awaiting_human_submit', 'needs_human_verification'}
            if existing.get('status') in {'submitted', 'submitted_pending_receipt', 'submitting', 'submission_unknown', 'needs_human_verification', 'awaiting_verification_code', 'awaiting_human_submit'} and not waiting_on_him:
                raise ValueError(f'Job {job_id} already has an application or unresolved submission')
            return {'id': job.id, 'company': job.company_name, 'title': job.title,
                    'url': job.application_url or job.canonical_url, 'description': job.description,
                    'source_eligibility': value(job.eligibility), 'sourceEligibility': value(job.eligibility),
                    'location': job.location, 'salaryMin': job.salary_min, 'salaryMax': job.salary_max,
                    'salary': job.salary_raw, 'role_type': job.role_type}

    def _retire_unavailable(self, item, exc):
        message = str(exc)
        if not re.search(r'must be an eligible, unapplied full-time(?: or internship)? role|was not found|Google applications are paused|U.S.-only policy|' + AGGREGATOR_REFUSAL, message):
            return False
        item.update(status='skipped', phase='skipped', message=message, updated_at=now())
        if item['job_id'] not in self.data['skipped']:
            self.data['skipped'].append(item['job_id'])
        return True

    def _item(self, job):
        return {'id': str(uuid.uuid4()), 'job_id': job['id'], 'company': job['company'], 'title': job['title'],
                'url': job['url'], 'status': 'queued', 'phase': 'queued', 'message': 'Waiting to start',
                'queued_at': now(), 'updated_at': now()}

    def _label_fit(self, job_ids):
        """Record his Good-fit verdict on postings the rules rated below eligible: an explicit queue request is that verdict.

        Returns (job_id, previous_label) pairs so a request that then fails validation can be undone."""
        from ..processing.tracks import with_track
        track = active_track()
        labeled = []
        with self.sessions() as session:
            for job_id in job_ids:
                job = session.get(Job, job_id)
                if not job or job.role_type not in APPLICATION_ROLE_TYPES or value(job.status) not in {'NEW', 'ACTIVE', 'SAVED'}:
                    continue
                if value(job.eligibility) in ELIGIBLE or (per_track(job.user_fit_label, track) or {}).get('fit') is True:
                    continue
                labeled.append((job_id, job.user_fit_label))
                job.user_fit_label = with_track(job.user_fit_label, track, {'fit': True, 'note': 'Queued from the dashboard', 'labeled_at': now()})
            session.commit()
        return labeled

    def _unlabel(self, labeled):
        with self.sessions() as session:
            for job_id, previous in labeled:
                job = session.get(Job, job_id)
                if job:
                    job.user_fit_label = previous
            session.commit()

    def queue(self, job_ids, position='end', allow_other_roles=False, mark_fit=False, by_user=True):
        if position not in ('end', 'next'):
            raise ValueError('Position must be end or next')
        with self.lock:
            # Validate the complete request before mutating the queue.
            taken = {item['job_id'] for item in self.data['jobs'] if item['status'] not in REQUEUEABLE}
            wanted = [i for i in dict.fromkeys(job_ids) if i not in taken]
            if not by_user:
                # A posting he deleted from Needs help or Approvals stays deleted (his rule 2026-11-14):
                # an agent may not queue it again, only he can, from the dashboard.
                removed = {j['job_id'] for j in self.data.get('dismissed_items', []) if j.get('individual_clear')} & set(self.data['skipped'])
                refused = [i for i in wanted if i in removed]
                if refused:
                    raise ValueError(f"He removed job {', '.join(map(str, refused))} from his lists; only he can queue it again, from the dashboard")
            # Queueing a posting the rules only rated likely eligible or uncertain is his call that it fits;
            # the label is written first so validation, autoplay and the reviewer all see it.
            labeled = self._label_fit(wanted) if mark_fit else []
            try:
                jobs = [self._job(i, allow_other=allow_other_roles) for i in wanted]
            except ValueError:
                self._unlabel(labeled)
                raise
            # A site that refuses the worker's browser is never launched: the posting goes on his Apply yourself list.
            blocked = [job for job in jobs if self._blocked_host(job['url'])]
            for job in blocked:
                self._to_apply_yourself(job, f"{self._blocked_host(job['url'])} refuses the worker's browser (Settings: Sites that refuse the worker's browser)", source='queued')
            jobs = [job for job in jobs if job not in blocked]
            if allow_other_roles:
                selected = self.data.setdefault('explicit_other_jobs', [])
                selected.extend(job['id'] for job in jobs if job['role_type'] == 'OTHER' and job['id'] not in selected)
            ids = {job['id'] for job in jobs}
            self.data['jobs'] = [j for j in self.data['jobs'] if j['job_id'] not in ids]
            self.data['skipped'] = [i for i in self.data['skipped'] if i not in ids]
            items = [self._item(job) for job in jobs]
            if position == 'next':
                # Play next also pulls an already queued role to the front.
                requested = set(job_ids)
                items += [j for j in self.data['jobs'] if j['status'] == 'queued' and j['job_id'] in requested]
                self.data['jobs'] = [j for j in self.data['jobs'] if j not in items]
                for item in items:
                    item['explicit_next'] = True
                first = next((n for n, j in enumerate(self.data['jobs']) if j['status'] == 'queued'), len(self.data['jobs']))
                self.data['jobs'][first:first] = items
            else:
                self.data['jobs'].extend(items)
            self._save()
            result = {'added': len(jobs), 'duplicate': len(set(job_ids)) - len(jobs) - len(blocked), 'labeled': [job_id for job_id, _ in labeled]}
            if blocked:
                result['apply_yourself'] = [job['id'] for job in blocked]
                result['message'] = (f"{', '.join(sorted({job['company'] for job in blocked}))}: the site refuses the worker's browser, "
                                     'so the posting is on your Apply yourself list with its tailored resume.')
            return result

    def move(self, job_id, index):
        """Move a queued role to a position among the queued roles, like dragging a track in Up Next."""
        with self.lock:
            queued = [j for j in self.data['jobs'] if j['status'] == 'queued']
            item = next((j for j in queued if j['job_id'] == job_id), None)
            if item is None:
                raise ValueError('This role is not waiting in the queue')
            queued.remove(item)
            if index == 0:
                item['explicit_next'] = True
            else:
                item.pop('explicit_next', None)
            queued.insert(max(0, min(index, len(queued))), item)
            others = [j for j in self.data['jobs'] if j['status'] != 'queued']
            self.data['jobs'] = others + queued
            self._save()
            return {'ok': True}

    def skip(self, job_id):
        """Keep a role out of autoplay. It can still be queued by hand."""
        with self.lock:
            if job_id not in self.data['skipped']:
                self.data['skipped'].append(job_id)
            self._save()
            return {'ok': True}

    def remove_from_list(self, job_id):
        """Remove a not-yet-applied posting from the application list without skipping it."""
        with self.lock:
            item = next((j for j in self.data['jobs'] if j['job_id'] == job_id and j['status'] not in REQUEUEABLE), None)
            if item is None:
                raise ValueError('This posting is no longer on the application list')
            with self.sessions() as session:
                if session.query(Application.id).filter(Application.job_id == job_id).first():
                    raise ValueError('This posting has already been applied to and cannot be removed from application history')
            run_state = read(self.directory / item['id'] / 'state.json', {})
            durable = read(self.agent_dir / 'state' / f'jobagent-{job_id}.json', {})
            unresolved = {'submitting', 'submitted', 'submitted_pending_receipt', 'submission_unknown'}
            if (item.get('submitted') or item.get('recorded') or item.get('submission_attempted') or
                    item['status'] in {'completed', 'submitted', 'submitted_pending_receipt', 'submission_unknown'} or
                    run_state.get('submitted') or run_state.get('submission_attempted') or
                    run_state.get('status') in unresolved or durable.get('submittedAt') or
                    durable.get('submissionAttempted') or durable.get('status') in unresolved):
                raise ValueError('A submission may already have been sent; reconcile it before removing this posting')

            if item['id'] in self.processes:
                self._mark_performance_intervention(item)
                item['remove_requested'] = True
                item['message'] = 'Stopping this application so the posting can be removed from the list.'
                self._command(item, {'action': 'stop'})
                self._save()
                return {'ok': True, 'state': 'stopping'}

            try:
                from .assist import get_desk
                desk = get_desk()
                if job_id in desk.processes:
                    desk.stop(job_id)
            except (ImportError, ValueError):
                pass
            self._mark_performance_intervention(item)
            self.data['jobs'].remove(item)  # The Job row remains untouched and returns to Roles you can add.
            self._save()
            return {'ok': True, 'state': 'available'}

    def autoplay_view(self):
        """Autoplay settings as they apply to the active search track."""
        track = get_track()
        autoplay = self.data['autoplay']
        chosen = autoplay['disciplines_by_track'].get(track.key)
        return {**{k: v for k, v in autoplay.items() if k != 'disciplines_by_track'},
                'track': track.key, 'disciplines': list(track.clusters) if chosen is None else chosen}

    def configure_autoplay(self, enabled=None, disciplines=None, include_eligible=None):
        with self.lock:
            autoplay = self.data['autoplay']
            if enabled is not None:
                autoplay['enabled'] = bool(enabled)
            if disciplines is not None:
                track = get_track()
                unknown = set(disciplines) - set(track.clusters)
                if unknown:
                    raise ValueError(f'Unknown discipline: {sorted(unknown)[0]}')
                autoplay['disciplines_by_track'][track.key] = [d for d in track.clusters if d in disciplines]
            if include_eligible is not None:
                autoplay['include_eligible'] = bool(include_eligible)
            self._save()
            return self.snapshot()

    def company_filter_view(self):
        """Companies selected in JobAgent; an empty list leaves all companies in scope."""
        with self.lock:
            return {'companies': list(self.data.get('company_filter') or [])}

    def configure_company_filter(self, companies):
        """Save the shared dashboard and application-agent company allowlist."""
        selected = list(dict.fromkeys(str(name).strip() for name in companies if str(name).strip()))
        with self.sessions() as session:
            available = {name.casefold(): name for (name,) in session.query(Job.company_name).filter(
                Job.company_name.isnot(None), Job.status.in_([JobStatus.NEW, JobStatus.ACTIVE, JobStatus.SAVED])
            ).distinct().all()}
        invalid = [name for name in selected if name.casefold() not in available]
        if invalid:
            raise ValueError('One or more selected companies no longer have open postings')
        selected = list(dict.fromkeys(available[name.casefold()] for name in selected))
        with self.lock:
            self.data['company_filter'] = selected
            self._save()
        return {'companies': selected}

    def _company_in_filter(self, company):
        selected = self.data.get('company_filter') or []
        return not selected or (company or '').casefold() in {name.casefold() for name in selected}

    def _cooling(self, item_or_company):
        company = item_or_company if isinstance(item_or_company, str) else item_or_company['company']
        until = self.data['cooling'].get(company.casefold())
        waiting = item_or_company.get('not_before') if isinstance(item_or_company, dict) else None
        return max(until or '', waiting or '') > now()

    def _capped(self, company):
        until = self.data['capped'].get(company.casefold())
        return bool(until) and until > now()

    def _manual_selection_companies(self):
        """Companies whose scraped roles autoplay must leave for the user's explicit queue selection."""
        caps = {name for name, entry in application_caps.load().items()
                if entry.get('status') in ('pending', 'approved')}
        stamp = time.monotonic()
        if stamp - self._manual_selection_cache_at >= 30:
            with self.sessions() as session:
                counts = session.query(func.lower(Job.company_name), func.count(Job.id)).filter(
                    Job.status.in_([JobStatus.NEW, JobStatus.ACTIVE, JobStatus.SAVED]),
                    Job.role_type.in_(application_role_types())).group_by(func.lower(Job.company_name)).all()
            self._manual_selection_cache = {(name or '').casefold() for name, count in counts
                                            if count >= AUTOPLAY_MANUAL_SELECTION_ROLE_THRESHOLD}
            self._manual_selection_cache_at = stamp
        return caps | self._manual_selection_cache

    def _high_volume_open(self, company, exclude_job_id=None):
        """His choice (2026-11-02): a company left for manual selection only because it has many open roles still
        gets up to workers.high_volume_weekly autoplay applications in any 7 days (its best reviewed fits). Companies
        with a stated employer cap on Approvals stay manual."""
        limit = int(setting('workers.high_volume_weekly') or 0)
        key = (company or '').casefold()
        if limit <= 0 or key not in getattr(self, '_manual_selection_cache', set()):
            return False
        if application_caps.load().get(key, {}).get('status') in ('pending', 'approved', 'declined'):
            return False
        since = datetime.now(timezone.utc) - timedelta(days=7)
        with self.sessions() as session:
            applied = session.query(func.count(Application.id)).join(Job, Job.id == Application.job_id).filter(
                func.lower(Job.company_name) == key, Application.applied_date >= since.replace(tzinfo=None)).scalar() or 0
        reserved = sum(1 for j in self.data['jobs'] if j['company'].casefold() == key and j['job_id'] != exclude_job_id
                       and j['status'] in {'queued', 'starting', 'running', 'needs_resume'})
        return applied + reserved < limit

    def _manual_selection_cap_usage(self, caps):
        """Count applications plus distinct active queue reservations in each employer window."""
        cap_entries = {name.casefold(): entry for name, entry in caps.items()}
        if not cap_entries:
            return {}
        with self.sessions() as session:
            application_rows = session.query(
                Application.job_id, Application.applied_date, Job.company_name
            ).join(Job, Job.id == Application.job_id).all()
        with self.lock:
            queue_items = [dict(item) for item in self.data['jobs']
                           if item.get('status') not in REQUEUEABLE]

        applications = {}
        for job_id, applied_date, company in application_rows:
            if not company:
                continue
            stamp = applied_date.replace(tzinfo=timezone.utc) if applied_date.tzinfo is None else applied_date
            applications.setdefault(company.casefold(), {})[job_id] = stamp

        queued = {}
        for item in queue_items:
            company = (item.get('company') or '').casefold()
            if company not in cap_entries or item.get('job_id') is None:
                continue
            raw_stamp = item.get('queued_at') or item.get('created_at') or item.get('updated_at')
            try:
                stamp = datetime.fromisoformat(str(raw_stamp).replace('Z', '+00:00'))
                stamp = stamp.replace(tzinfo=timezone.utc) if stamp.tzinfo is None else stamp
            except (TypeError, ValueError):
                stamp = datetime.now(timezone.utc)
            queued.setdefault(company, {})[item['job_id']] = (stamp, item)

        now_utc = datetime.now(timezone.utc)
        usage = {}
        for company, entry in cap_entries.items():
            days = entry.get('days')
            since = now_utc - timedelta(days=days or 36500)
            applied_ids = {job_id for job_id, stamp in applications.get(company, {}).items() if stamp >= since}
            queued_ids = set()
            for job_id, (_, item) in queued.get(company, {}).items():
                if item.get('status') in {'completed', 'submitted'} and (item.get('submitted') or item.get('recorded')):
                    applied_ids.add(job_id)
                elif job_id not in applied_ids:
                    queued_ids.add(job_id)
            usage[company] = {'applied': len(applied_ids), 'queued': len(queued_ids),
                              'used': len(applied_ids) + len(queued_ids), 'window_days': days}
        return usage

    def manual_selection_options(self):
        """Open postings from capped or high-volume companies, for his per-role selection queue."""
        with self.lock:
            selected = {item['job_id']: dict(item) for item in self.data['jobs']
                        if item['status'] not in REQUEUEABLE}
        caps = application_caps.load()
        cap_usage = self._manual_selection_cap_usage(caps)
        manual_only = self._manual_selection_companies()
        manual_only |= {name for name, entry in caps.items() if entry.get('status') == 'declined'}
        with self.sessions() as session:
            rows = session.query(Job.id, Job.company_name, Job.title, Job.location, Job.application_url,
                                 Job.canonical_url, Job.role_type, Job.eligibility, Job.priority_score).filter(
                Job.status.in_([JobStatus.NEW, JobStatus.ACTIVE, JobStatus.SAVED]),
                Job.role_type.in_(application_role_types())).order_by(Job.company_name, Job.priority_score.desc(), Job.id).all()
            application_job_ids = {job_id for (job_id,) in session.query(Application.job_id).all()}

        def list_flags(job_id, item):
            run_state = read(self.directory / item.get('id', '') / 'state.json', {}) if item.get('id') else {}
            durable = read(self.agent_dir / 'state' / f'jobagent-{job_id}.json', {})
            applied = (job_id in application_job_ids or item.get('submitted') or item.get('recorded') or
                       item.get('status') in {'completed', 'submitted'} or durable.get('submittedAt') or
                       durable.get('status') == 'submitted' or run_state.get('submitted'))
            unresolved = {'submitting', 'submitted_pending_receipt', 'submission_unknown'}
            removable = not applied and not (
                item.get('submission_attempted') or run_state.get('submission_attempted') or
                durable.get('submissionAttempted') or item.get('status') in unresolved or
                run_state.get('status') in unresolved or durable.get('status') in unresolved)
            return bool(applied), bool(removable)
        groups = {}
        for row in rows:
            company_key = row.company_name.casefold()
            if not self._company_in_filter(row.company_name):
                continue
            if company_key not in manual_only:
                continue
            group = groups.setdefault(company_key, {'company': row.company_name, 'postings': [],
                                                     'application_list': [], 'open_role_count': 0})
            posting = {'job_id': row.id, 'title': row.title, 'location': row.location,
                       'url': row.application_url or row.canonical_url, 'role_type': value(row.role_type),
                       'eligibility': value(row.eligibility), 'priority': round(row.priority_score or 0, 1)}
            group['open_role_count'] += 1
            queued_item = selected.get(row.id)
            if queued_item:
                applied, removable = list_flags(row.id, queued_item)
                posting.update(list_status=queued_item.get('status'), list_message=queued_item.get('message'),
                               applied=applied, removable=removable,
                               remove_pending=bool(queued_item.get('remove_requested')))
                group['application_list'].append(posting)
            else:
                group['postings'].append(posting)

        # Keep already selected postings visible even after their source listing closes
        # or the job moves from the open-posting set.
        for job_id, item in selected.items():
            company_key = (item.get('company') or '').casefold()
            if company_key not in manual_only:
                continue
            group = groups.setdefault(company_key, {'company': item.get('company') or 'Company',
                                                     'postings': [], 'application_list': [], 'open_role_count': 0})
            if any(posting['job_id'] == job_id for posting in group['application_list']):
                continue
            applied, removable = list_flags(job_id, item)
            group['application_list'].append({
                'job_id': job_id, 'title': item.get('title') or 'Application', 'location': item.get('location'),
                'url': item.get('url'), 'role_type': item.get('role_type'), 'eligibility': item.get('eligibility'),
                'list_status': item.get('status'), 'list_message': item.get('message'),
                'applied': applied, 'removable': removable,
                'remove_pending': bool(item.get('remove_requested')),
            })
        output = []
        for company_key, group in groups.items():
            cap = caps.get(company_key)
            if cap:
                cap = {**cap, **cap_usage.get(company_key, {})}
            count = group.pop('open_role_count')
            reasons = []
            if cap:
                reasons.append('application limit')
            if count >= AUTOPLAY_MANUAL_SELECTION_ROLE_THRESHOLD:
                reasons.append(f'{count} open roles')
            group.update(open_roles=count, reasons=reasons, cap=cap,
                         can_select=not cap or cap.get('status') != 'declined')
            output.append(group)
        output.sort(key=lambda group: (-group['open_roles'], group['company'].casefold()))
        return {'companies': output, 'role_threshold': AUTOPLAY_MANUAL_SELECTION_ROLE_THRESHOLD}

    @staticmethod
    def _manual(company):
        """An employer he applies to himself (Settings: Companies you apply to yourself); a listed name
        matches any company containing it."""
        names = [n.strip().casefold() for n in str(setting('workers.manual_companies') or '').split(',') if n.strip()]
        given = (company or '').casefold()
        return any(n in given for n in names)

    @staticmethod
    def _blocked_hosts():
        return [h.strip().lower().lstrip('.') for h in str(setting('workers.blocked_hosts') or '').split(',') if h.strip()]

    def _blocked_host(self, url):
        """The listed site (Settings: Sites that refuse the worker's browser) this URL is on, if any."""
        return self._listed_host(url, self._blocked_hosts())

    @staticmethod
    def _listed_host(url, hosts):
        host = (urlsplit(url or '').hostname or '').lower()
        return next((h for h in hosts if host and (host == h or host.endswith('.' + h))), None)

    @staticmethod
    def _hosts(key):
        return [h.strip().lower().lstrip('.') for h in str(setting(key) or '').split(',') if h.strip()]

    def _visible_host(self, url):
        """Settings: Sites opened in your visible Chrome (Rivian iCIMS, his choice 2026-11-10)."""
        return self._listed_host(url, self._hosts('workers.visible_hosts'))

    def _real_chrome_host(self, url):
        """Settings: Sites filled in the hidden real Chrome (Tesla, his choice 2026-11-10)."""
        return self._listed_host(url, self._hosts('workers.real_chrome_hosts'))

    def _dismiss_gone(self):
        """His rule (2026-11-10): a posting whose page says it is no longer available, or that he already applied,
        is dismissed (off Needs help and off autoplay), never retried. Nothing submitted in the run is touched."""
        for item in list(self.data['jobs']):
            if item['id'] in self.processes or item.get('submitted') or item.get('submission_attempted'):
                continue
            if item['status'] in {'submission_unknown', 'submitted', 'submitted_pending_receipt', 'completed', 'queued', 'starting', 'running'}:
                continue
            already = item.get('phase') == 'already_applied' or ALREADY_APPLIED.search(item.get('message') or '')
            gone = item.get('posting_unavailable') or item.get('message', '').startswith('Posting unavailable:')
            if not (already or gone):
                continue
            reason = 'already applied' if already else 'posting no longer available'
            self.data.setdefault('dismissed_items', []).append({**item, 'dismissed_at': now(), 'individual_clear': True,
                                                               'auto_dismissed': reason})
            self.data['jobs'].remove(item)
            if item['job_id'] not in self.data['skipped']:
                self.data['skipped'].append(item['job_id'])

    def _to_apply_yourself(self, job, reason, source):
        """Keep a posting the worker cannot open on his Apply yourself list, with its tailored resume."""
        entries = self.data.setdefault('apply_yourself', [])
        if any(e['job_id'] == job['id'] for e in entries):
            return False
        entries.append({'job_id': job['id'], 'company': job['company'], 'title': job['title'], 'url': job['url'],
                        'host': self._blocked_host(job['url']), 'reason': reason, 'source': source, 'added_at': now(),
                        **({'resume_variant': job['resume_variant']} if job.get('resume_variant') else {})})
        return True

    def _apply_yourself_resume(self, entry):
        variant = entry.get('resume_variant')
        review = self._resume_reviews().get(str(entry['job_id'])) or {}
        decision = review.get('decision') or {}
        if not variant and decision.get('choice') == 'variant':
            variant = decision.get('variant_id')
        path = variant and self.resume_library.path(variant)
        if path:
            return {'kind': 'tailored', 'path': Path(path), 'label': next((v.get('label') for v in self.resume_library.variants() if v['id'] == variant), None) or review.get('focus')}
        if review.get('draft'):
            return {'kind': 'draft', 'draft': review['draft'], 'label': review.get('focus')}
        return None

    def apply_yourself(self):
        """Postings on sites that refuse the worker's browser, each with the resume tailored for it."""
        with self.lock:
            entries = [dict(e) for e in self.data.get('apply_yourself') or []]
            log = dict(self.data.get('blocked_host_log') or {})
        for entry in entries:
            resume = self._apply_yourself_resume(entry)
            entry['resume'] = ({'kind': resume['kind'], 'label': resume.get('label'),
                                'url': f"/api/applications/apply-yourself/{entry['job_id']}/resume.pdf"} if resume else None)
        return {'postings': entries, 'blocked_hosts': self._blocked_hosts(), 'added_automatically': log}

    def apply_yourself_resume(self, job_id):
        entry = next((e for e in self.data.get('apply_yourself') or [] if e['job_id'] == job_id), None)
        resume = entry and self._apply_yourself_resume(entry)
        if not resume:
            raise ValueError('No tailored resume is saved for this posting')
        return resume['path'].read_bytes() if resume['kind'] == 'tailored' else resume_doc.render_pdf(resume['draft'])

    def apply_yourself_fill(self, job_id):
        """His request (2026-11-02): an Apply yourself posting is filled in his visible Chrome, as Finish in my Chrome does,
        and he finishes and submits it. Starts now, even with workers off, because he is at the screen."""
        with self.lock:
            entry = next((e for e in self.data.get('apply_yourself') or [] if e['job_id'] == job_id), None)
            if entry is None:
                raise ValueError('This posting is not on your Apply yourself list')
            current = next((j for j in self.data['jobs'] if j['job_id'] == job_id), None)
            if current and current['id'] in self.processes:
                raise ValueError('This posting is already being filled')
            state = read(self.agent_dir / 'state' / f'jobagent-{job_id}.json', {})
            if state.get('status') in {'submitted', 'submitted_pending_receipt', 'submitting', 'submission_unknown'}:
                raise ValueError('This application already has a submission on record; check for the employer receipt first')
            fresh = self._item(self._job(job_id, human_finish=True))
            if entry.get('resume_variant'):
                fresh['resume_variant'] = entry['resume_variant']
            fresh.update(human_finish=True, human_intervention=True, source='apply_yourself',
                         message='Opening Chrome to fill this application for you to finish and submit')
            if current:
                self.data['jobs'][self.data['jobs'].index(current)] = fresh
            else:
                self.data['jobs'].append(fresh)
            self._launch(fresh, 0)
            self._save()
            return {'ok': True}

    def remove_apply_yourself(self, job_id):
        """He applied by hand (or no longer wants it): the posting leaves the list."""
        with self.lock:
            before = len(self.data.get('apply_yourself') or [])
            self.data['apply_yourself'] = [e for e in self.data.get('apply_yourself') or [] if e['job_id'] != job_id]
            if len(self.data['apply_yourself']) == before:
                raise ValueError('This posting is not on your Apply yourself list')
            self._save()
            return {'ok': True}

    def _sweep_blocked_hosts(self):
        """Queued or stuck roles on a site that refuses the browser move to the Apply yourself list (not deleted)."""
        for item in list(self.data['jobs']):
            host = self._blocked_host(item.get('url'))
            if not host or item['id'] in self.processes or item['status'] not in {'queued'} | HELP or item.get('human_finish'):
                continue  # his own fill in Chrome (Apply yourself, Finish in my Chrome) stays with him
            if item['status'] == 'submission_unknown' or item.get('submitted') or item.get('submission_attempted'):
                continue
            posting = read(self.directory / item['id'] / 'request.json', {}).get('job', {}).get('url') or item.get('url')
            self._to_apply_yourself(item | {'id': item['job_id'], 'url': posting}, f"{host} refuses the worker's browser"
                                    f"{': ' + item['message'] if item['status'] in HELP and item.get('message') else ''}", source=item.get('source') or 'queued')
            self.data['jobs'].remove(item)

    def _note_access_denied(self, item):
        """Count distinct postings in a row a site refused (access denied / HTTP 403); at the setting's count it joins
        the sites that refuse the browser, with when and why recorded."""
        url = item.get('url') or ''
        host = (urlsplit(url).hostname or '').lower()
        if not host or item['status'] in {'stopped', 'skipped'} or MODEL_LIMIT.search(item.get('message') or ''):
            return None
        # A hiring platform's tenant (acme.wd5.myworkdayjobs.com) is its own site; an employer's site is its domain.
        key = host if platform_yield.platform_of(url) != 'other' else '.'.join(host.split('.')[-2:])
        streaks = self.data.setdefault('access_denied', {})
        if not (item['status'] in HELP and ACCESS_DENIED.search(item.get('message') or '')):
            streaks.pop(key, None)  # the site let a run through: the streak starts over
            return None
        jobs = streaks.setdefault(key, [])
        if item['job_id'] not in jobs:
            jobs.append(item['job_id'])
        threshold = int(setting('workers.blocked_host_denials'))
        if threshold <= 0 or len(jobs) < threshold or self._blocked_host(url):
            return None
        save_settings({'workers.blocked_hosts': ', '.join([*self._blocked_hosts(), key])})
        self.data.setdefault('blocked_host_log', {})[key] = {
            'added_at': now(), 'job_ids': list(jobs),
            'reason': f"Access denied on {len(jobs)} different postings in a row: {str(item.get('message'))[:200]}"}
        streaks.pop(key, None)
        logging.getLogger(__name__).warning('Added %s to the sites that refuse the browser (jobs %s)', key, jobs)
        return key

    def platform_yields(self):
        """Each hiring platform's recent automatic-submit rate, whether autoplay holds it, and its ranking adjustment."""
        days = int(setting('workers.platform_yield_days'))
        stamp = time.monotonic()
        cache = getattr(self, '_yield_cache', None)
        if not cache or cache[0] != days or stamp - cache[1] > 300:
            cache = self._yield_cache = (days, stamp, platform_yield.history(self.directory, days))
        min_jobs, min_success = int(setting('workers.platform_yield_min_jobs')), float(setting('workers.autoplay_min_platform_success'))
        platforms = platform_yield.summarize(cache[2], min_jobs, min_success, float(setting('workers.autoplay_platform_weight')))
        return {'window_days': days, 'min_jobs': min_jobs, 'min_success': min_success,
                'held': [p['platform'] for p in platforms.values() if p['held']],
                'platforms': sorted(platforms.values(), key=lambda p: (-p['jobs'], p['platform']))}

    @staticmethod
    def _title_key(title):
        return ' '.join(re.sub(r'[^a-z0-9]+', ' ', title.casefold()).split())

    def up_next(self, limit=12, busy=()):
        """The priority list as autoplay will take it: best first, filtered to the chosen disciplines."""
        autoplay = self.autoplay_view()
        if not autoplay['disciplines']:
            return []
        seen = ({j['job_id'] for j in self.data['jobs']} | set(self.data['skipped'])
                | {e['job_id'] for e in self.data.get('apply_yourself') or []})
        # The same posting is often listed under two URLs; one application covers both.
        titles = {(j['company'].casefold(), self._title_key(j['title'])) for j in self.data['jobs']}
        levels = ['STRONG_MATCH', 'ELIGIBLE'] if autoplay['include_eligible'] else ['STRONG_MATCH']
        picks, unreviewed = [], []
        workday_ok = self.workday_password_set()
        # Authentication is shared across an employer's postings. A failure on one form
        # (history, a question, CAPTCHA or page loading) does not establish an account failure.
        needs_sign_in = {j['company'].casefold() for j in self.data['jobs']
                         if j['status'] in HELP and re.search(
                             r'sign[- ]?in|log[- ]?in|saved password|credentials|account.*(?:locked|verification)',
                             j.get('message', ''), re.I)}
        manual_only_companies = self._manual_selection_companies()
        cap_entries = application_caps.load()
        with self.sessions() as session:
            # His own label admits a posting whatever the rules said about it.
            rows = (session.query(Job.id, Job.company_name, Job.title, Job.best_career_cluster, Job.priority_score, Job.eligibility,
                                  Job.application_url, Job.canonical_url, Job.fit_review, Job.description_hash, Job.user_fit_label, Job.location)
                    .filter(Job.status.in_([JobStatus.NEW, JobStatus.ACTIVE, JobStatus.SAVED]), Job.role_type.in_(application_role_types()),
                            or_(and_(Job.eligibility.in_(levels), Job.best_career_cluster.in_(autoplay['disciplines'])),
                                Job.user_fit_label.isnot(None)))
                    .order_by(Job.priority_score.desc(), Job.id).all())
            track = active_track()
            _, labels_version = learnings(session, track=track)
        # Yield-aware order: a platform's recent automatic-submit rate shifts its postings' priority, and a platform
        # far below the floor (with enough postings to tell) is left to him. Roles he queues are never held.
        yields = {p['platform']: p for p in self.platform_yields()['platforms']}
        platform = lambda r: platform_yield.platform_of(r.application_url or r.canonical_url)
        rows = sorted(rows, key=lambda r: (-((r.priority_score or 0) + yields[platform(r)]['adjustment']), r.id))
        from ..discovery.email_alerts import is_aggregator
        # No row limit: most of the top of the list is already attempted, parked, senior or
        # skipped, and a cap sized by `limit` left the workers' one-pick lookup with nothing
        # while the panel's twelve-pick preview still showed roles. The list is a few hundred rows.
        from ..processing.us_locations import is_us_location
        for row in rows:
            if not self._company_in_filter(row.company_name):
                continue
            if not is_us_location(row.location):
                continue
            company = row.company_name.casefold()
            if not workday_ok and self._is_workday(row.application_url or row.canonical_url):
                continue  # Every Workday run would stop at sign-in until his password is saved.
            if failure_signatures.holds(self.data.get('breakers') or [], row.application_url or row.canonical_url):
                continue  # its site is held after repeated identical failures
            if yields[platform(row)]['held'] or is_aggregator(row.application_url or row.canonical_url or ''):
                continue  # a low-yield platform, or a job board the worker cannot apply through
            if (row.id in seen or 'google' in company or SENIOR_TITLE.search(row.title) or internship_blocked(None, row.title)
                    or self._capped(row.company_name) or self._cooling(row.company_name) or company in busy or company in needs_sign_in
                    or self._manual(row.company_name) or (company in manual_only_companies and not self._high_volume_open(company))
                    or cap_entries.get(company, {}).get('status') == 'declined'):
                continue
            key = (company, self._title_key(row.title))
            if key in titles:
                continue
            titles.add(key)  # An applied twin also rules this posting out.
            if read(self.agent_dir / 'state' / f'jobagent-{row.id}.json', {}).get('status'):
                continue
            label = per_track(row.user_fit_label, track) or {}
            review = per_track(row.fit_review, track)
            if label.get('fit') is False:
                continue
            if label.get('fit') is not True:
                if value(row.eligibility) not in levels or row.best_career_cluster not in autoplay['disciplines']:
                    continue  # an unlabelled row the query only admitted for its label's sake
                # The rules only reject what they recognise; a model has to have read the posting
                # and judged the work a fit before autoplay takes it. The next picks must also have
                # been judged with his latest labels; deeper ones are refreshed as they come up.
                if setting('review.required'):
                    fresh = labels_version if len(picks) + len(unreviewed) < setting('review.fresh_picks') else None
                    if not review_current(review, row.description_hash, fresh):
                        unreviewed.append(row.id)
                        titles.discard(key)
                        continue
                    if not review.get('fit'):
                        continue
            url = row.application_url or row.canonical_url
            if self._blocked_host(url):
                # Autoplay reached a posting on a site that refuses the browser: his to apply to, with its resume.
                self._to_apply_yourself({'id': row.id, 'company': row.company_name, 'title': row.title, 'url': url},
                                        f"{self._blocked_host(url)} refuses the worker's browser", source='autoplay')
                continue
            plat = yields[platform(row)]
            picks.append({'job_id': row.id, 'company': row.company_name, 'title': row.title, 'discipline': row.best_career_cluster,
                          'priority': round(row.priority_score or 0, 1), 'eligibility': value(row.eligibility),
                          'url': url, 'platform': plat['label'], 'platform_rate': plat['rate'],
                          'platform_adjustment': plat['adjustment']})
            if len(picks) >= limit:
                break
        if unreviewed:
            self.fit_reviewer.request(unreviewed, track)
        return picks

    @staticmethod
    def limit_resets_at(message, at=None):
        """When a plan limit lifts: the time the CLI names ("resets 5pm", "resets 11:30 pm"), else in an hour."""
        at = at or datetime.now().astimezone()
        match = re.search(r'resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?', message or '', re.I)
        if not match:
            return (at + timedelta(hours=1)).astimezone(timezone.utc).isoformat()
        hour, minute, meridiem = int(match.group(1)), int(match.group(2) or 0), (match.group(3) or '').lower()
        if meridiem.startswith('p') and hour < 12:
            hour += 12
        if meridiem.startswith('a') and hour == 12:
            hour = 0
        if hour > 23 or minute > 59:
            return (at + timedelta(hours=1)).astimezone(timezone.utc).isoformat()
        reset = at.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if reset <= at:
            reset += timedelta(days=1)
        return (reset + timedelta(minutes=1)).astimezone(timezone.utc).isoformat()

    def _try_earned_weekly_reset(self):
        # All browser workers share one allowance. Poll once per minute; the helper
        # serializes credit redemption across processes and verifies live capacity.
        stamp = time.monotonic()
        previous = getattr(self, '_weekly_reset_check', None)
        if previous is not None and stamp - previous < (1 if getattr(self, '_weekly_reset_result', {}).get('resumed') else 60):
            return bool(getattr(self, '_weekly_reset_result', {}).get('resumed'))
        self._weekly_reset_check = stamp
        from .codex_usage import try_weekly_reset
        result = try_weekly_reset(self.directory, self._cli('codex') or 'codex')
        self._weekly_reset_result = result
        self.data['weekly_reset'] = {k: result[k] for k in ('status', 'resumed', 'available_count', 'error') if k in result}
        self.data['weekly_reset']['checked_at'] = now()
        return bool(result.get('resumed'))

    def _recover_model_limited_jobs(self):
        # Resume only preparation that stopped at an AI limit; ambiguous employer
        # submissions retain their evidence and are never retried here.
        for item in list(self.data['jobs']):
            if (item['status'] not in {'failed', 'blocked'} or item['id'] in self.processes
                    or item.get('engine') not in WORKER_ENGINES or not MODEL_LIMIT.search(item.get('message', ''))
                    or item.get('submitted') or item.get('submission_attempted')):
                continue
            statuses = read(self.directory / 'engine-status.json', {})
            if statuses.get(item.get('engine'), {}).get('status') == 'usage_limited':
                continue
            durable = read(self.agent_dir / 'state' / f"jobagent-{item['job_id']}.json", {})
            if durable.get('submitted') or durable.get('submission_attempted') or durable.get('submissionAttempted') or durable.get('status') in {'submitted', 'submitted_pending_receipt', 'submitting', 'submission_unknown', 'awaiting_human_submit', 'needs_human_verification', 'awaiting_verification_code'}:
                continue
            try:
                self._resume_from(item['job_id'], {'failed', 'blocked'}, message='AI capacity restored. Continuing preparation.')
            except ValueError:
                pass

    def _record_model_limit(self, item):
        engine = item.get('engine')
        if engine not in WORKER_ENGINES or not MODEL_LIMIT.search(item.get('message', '')):
            return False
        if engine == 'codex' and self._try_earned_weekly_reset():
            return True
        until = self.limit_resets_at(item['message'])
        if not re.search(r'resets?\s+(?:at\s+)?\d{1,2}', item['message'], re.I):
            # No reset time in the message (OpenCode's "Free usage limit reached"): back off 1, 2, 4, 8 h (cap 12 h)
            # instead of re-testing every hour with two real applications (66 failed runs on 10-30/31).
            streaks = self.data.setdefault('limit_streaks', {})
            streaks[engine] = streaks.get(engine, 0) + 1
            until = (datetime.now(timezone.utc) + timedelta(hours=min(12, 2 ** (streaks[engine] - 1)))).isoformat()
        statuses = read(self.directory / 'engine-status.json', {})
        statuses[engine] = {'status': 'usage_limited', 'checked_at': now(), 'until': until,
                            'message': item['message'] + ' Scheduling paused; workers restart on their own once the limit resets. Switch agents or use Retry to go sooner.'}
        atomic(self.directory / 'engine-status.json', statuses)
        # Remember that the limit, not him, turned workers off, so they come back when it lifts.
        self.data['resume_after_limit'] = bool(self.data['running']) or bool(self.data.get('resume_after_limit'))
        self.data['running'] = False
        return True

    USAGE_PROBE_SECONDS = 600

    def _claude_usage(self):
        """Plan utilization from the Claude CLI's rate_limit_event: {'five_hour': 0.38, 'seven_day': 0.29}."""
        command = self._cli('claude')
        if not command:
            return None
        try:
            result = subprocess.run([command, '-p', '--model', 'claude-haiku-5-5', '--output-format', 'stream-json', '--verbose',
                                     '--no-session-persistence', '--tools', ''], input='Reply with ok.', capture_output=True,
                                    text=True, timeout=240)
        except (OSError, subprocess.SubprocessError):
            return None
        for line in result.stdout.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            windows = (event.get('rate_limit_info') or {}).get('unifiedWindows') if event.get('type') == 'rate_limit_event' else None
            if windows:
                # When each window resets, for the switch to agy below (_usage_pause).
                self._usage_resets = {name: datetime.fromtimestamp(w['resetsAt'], timezone.utc).isoformat()
                                      for name, w in windows.items() if w.get('resetsAt')}
                return {name: float(w.get('utilization') or 0) for name, w in windows.items()}
        import logging
        logging.getLogger(__name__).warning('Claude usage probe found no rate_limit_event (exit %s): %s',
                                            result.returncode, (result.stdout[-300:] + result.stderr[-300:]).replace('\n', ' '))
        return None

    def _agy_mark(self, reason=None, until=None):
        """Mark Claude as limited for application-agent's agy fallback (model-fallback.mjs), or clear our mark."""
        path = self.agent_dir / 'state' / 'model-limits.json'
        limits = read(path, {})
        engines = limits.setdefault('engines', {})
        if reason:
            engines['claude'] = {'until': until or (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
                                 'message': reason, 'at': now(), 'source': 'usage_pause'}
        elif engines.get('claude', {}).get('source') == 'usage_pause':
            engines.pop('claude')
        else:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic(path, limits)

    def _agy_fallback(self):
        """For the Applications page, beside the engine menus: engines application-agent has moved to agy,
        the agy models now limited, how many of agy's models are left, and when all of them are used up."""
        limits = read(self.agent_dir / 'state' / 'model-limits.json', {})
        order = read(self.agent_dir / 'state' / 'agy-models.json', {}).get('order') or []
        stamp = datetime.now(timezone.utc).isoformat()
        live = lambda entries: {k: v for k, v in (entries or {}).items() if str(v.get('until', '')) > stamp}
        engines, agy = live(limits.get('engines')), live(limits.get('agy'))
        models = order or sorted(agy)
        left = [m for m in models if m not in agy]
        exhausted = bool(models) and not left
        if not engines and not agy:
            return None
        return {'engines': engines, 'agy_limited': agy, 'agy_models': models, 'agy_left': len(left),
                'agy_exhausted': exhausted,
                # all used up: the first agy model to come back
                'agy_next': min((v['until'] for v in agy.values()), default=None) if exhausted else None}

    def _usage_pause(self):
        """His option (2026-10-18): a Claude plan usage % at which applications stop using Claude.
        Since 2026-10-24 (his choice) workers switch to agy's models there instead of pausing; they pause
        only when every agy model is limited too (application-agent model-fallback.mjs)."""
        threshold = int(setting('workers.usage_pause_percent') or 0)
        paused = self.data.get('auto_stop_reason', '') or ''
        if threshold <= 0:
            if paused.startswith('Claude usage'):
                self.data['auto_stop_reason'] = None
            return
        self._usage_watch_at = now()  # Seen in the snapshot: proves this check is being reached.
        # The CLI probe can take over a minute; run it beside the tick, never inside it, so the
        # queue keeps moving and a slow probe does not leave the reading stale (2026-10-19).
        usage = getattr(self, '_usage_result', None)
        self._usage_result = None
        last = getattr(self, '_usage_checked', float('-inf'))  # never checked yet, however recently the machine booted
        probing = getattr(self, '_usage_thread', None)
        if usage is None and time.monotonic() - last >= self.USAGE_PROBE_SECONDS and not (probing and probing.is_alive()):
            self._usage_checked = time.monotonic()
            def probe():
                self._usage_probe = {'started_at': now(), 'finished_at': None, 'ok': None}
                try:
                    self._usage_result = self._claude_usage()
                    self._usage_probe.update(finished_at=now(), ok=self._usage_result is not None)
                except Exception as exc:  # Surface it; a silent failure froze the reading before.
                    self._usage_probe.update(finished_at=now(), ok=False, error=str(exc)[:200])
            self._usage_thread = threading.Thread(target=probe, daemon=True)
            self._usage_thread.start()
        if usage is None:
            return
        self.data['claude_usage'] = {**usage, 'checked_at': now()}
        peak_name, peak = max(usage.items(), key=lambda kv: kv[1])
        if peak * 100 >= threshold:
            reason = (f'Claude usage {peak * 100:.0f}% ({peak_name.replace("_", "-")} window) reached your {threshold}% limit; '
                      f'applications continue on agy until it resets')
            self._agy_mark(reason, getattr(self, '_usage_resets', {}).get(peak_name))
            self.data['claude_on_agy'] = reason
            if self.data.get('resume_after_usage') and paused.startswith('Claude usage'):
                # Paused by the older rule: carry on, now on agy.
                self.data.update(running=True, stop_after_current=False, resume_after_usage=False, auto_stop_reason=None)
                self._save()
                self._ensure_loop()
        elif self.data.pop('claude_on_agy', None) is not None:
            self._agy_mark(None)
            self._save()
        elif self.data.get('resume_after_usage') and paused.startswith('Claude usage'):
            self.data.update(running=True, stop_after_current=False, resume_after_usage=False, auto_stop_reason=None)
            self._save()
            # After a restart while paused no worker loop exists yet; start it (2026-10-19).
            self._ensure_loop()

    def _expire_model_limits(self):
        # A plan limit is not permanent: once its reset time passes, forget it and, if the limit
        # was what stopped the workers, start them again (unless a backlog limit now applies).
        statuses = read(self.directory / 'engine-status.json', {})
        if statuses.get('codex', {}).get('status') == 'usage_limited' and self._try_earned_weekly_reset():
            statuses.pop('codex')
            atomic(self.directory / 'engine-status.json', statuses)
        self._recover_model_limited_jobs()
        def until(st):  # marks recorded before reset times were kept lift an hour after they were set
            if st.get('until'):
                return st['until']
            try:
                return (datetime.fromisoformat(st['checked_at']) + timedelta(hours=1)).isoformat()
            except (KeyError, ValueError):
                return now()
        expired = [e for e, st in statuses.items() if st.get('status') == 'usage_limited' and until(st) <= now()]
        if expired:
            for engine in expired:
                statuses.pop(engine)
            atomic(self.directory / 'engine-status.json', statuses)
        if not self.data.get('resume_after_limit') or self.data['running']:
            return
        if any(statuses.get(e, {}).get('status') == 'usage_limited' for e in self.engines_in_use()):
            return
        if self._backlog_limit_reason():
            return
        self.data['resume_after_limit'] = False
        self.data['running'] = True
        self._ensure_loop()

    def retry_engine_limits(self):
        with self.lock:
            statuses = read(self.directory / 'engine-status.json', {})
            for engine in self.engines_in_use():
                if statuses.get(engine, {}).get('status') == 'usage_limited':
                    statuses.pop(engine)
            atomic(self.directory / 'engine-status.json', statuses)
        for engine in self.engines_in_use():
            self.check_engine(engine)
        return self.snapshot()

    def check_engine(self, engine=None):
        engine = engine or self.data['engine']
        known = read(self.directory / 'engine-status.json', {}).get(engine, {})
        if known.get('status') == 'usage_limited':
            return known
        name = WORKER_ENGINES[engine]
        command = self._cli(engine)
        status, message = 'not_installed', f'{name} CLI was not found. Install it and sign in first.'
        if command and engine == 'agy':
            # `agy models` lists the models only when signed in.
            try:
                result = subprocess.run([command, 'models'], capture_output=True, text=True, timeout=60)
                models = [l.split('\t')[0] for l in result.stdout.splitlines() if '\t' in l]
                status, message = (('ready', f"agy is signed in ({len(models)} models). Application steps cycle through them as each reaches its limit.")
                                   if models else ('signed_out', 'agy is not signed in. Run `agy` in a terminal and sign in.'))
            except (OSError, subprocess.TimeoutExpired):
                status, message = 'unavailable', 'Could not check agy. Try again.'
        elif command and engine == 'opencode':
            try:
                result = subprocess.run([command, 'models'], capture_output=True, text=True, timeout=15)
                models = [line for line in result.stdout.splitlines() if '/' in line]
                status, message = (('ready', f'OpenCode is ready ({len(models)} available models).') if result.returncode == 0 and models else ('signed_out', 'OpenCode has no available models. Sign in or connect a provider in OpenCode.'))
            except (OSError, subprocess.TimeoutExpired):
                status, message = 'unavailable', 'Could not check OpenCode. Try again.'
        elif command:
            env = vault.model_env()
            args = [command, 'auth', 'status'] if engine == 'claude' else [command, 'login', 'status']
            try:
                result = subprocess.run(args, capture_output=True, text=True, timeout=20, env=env)
                output = result.stdout + result.stderr
                if engine == 'claude':
                    try:
                        auth = json.loads(result.stdout)
                    except ValueError:
                        auth = {}
                    if not auth.get('loggedIn'):
                        status, message = 'signed_out', 'Claude is signed out. Run `claude` in a terminal and log in with your Claude plan.'
                    elif auth.get('authMethod') != 'claude.ai':
                        status, message = 'api_billing', 'Claude is signed in with an API key, which bills per token. Log in with your Claude plan instead.'
                    else:
                        plan = auth.get('subscriptionType')
                        status, message = 'ready', f"Claude is signed in on your {plan.title() + ' ' if plan else ''}plan. Remaining usage is not checked. No API key is used."
                elif 'ChatGPT' in output:
                    status, message = 'ready', 'Codex is ready on your ChatGPT plan. Remaining usage is not checked. No API key is used.'
                elif 'API key' in output:
                    status, message = 'api_billing', 'Codex is signed in with an API key, which bills per token. Run `codex login` with ChatGPT instead.'
                else:
                    status, message = 'signed_out', 'Codex is signed out. Run `codex login` in a terminal first.'
            except (OSError, subprocess.TimeoutExpired):
                status, message = 'unavailable', f'Could not check {name}. Try again.'
        result = {'status': status, 'message': message, 'checked_at': now()}
        with self.lock:
            statuses = read(self.directory / 'engine-status.json', {})
            if statuses.get(engine, {}).get('status') == 'usage_limited':
                return statuses[engine]
            statuses[engine] = result
            atomic(self.directory / 'engine-status.json', statuses)
        return result

    def _backlog_limit_reason(self):
        limits = self.data['auto_stop']
        counts = {'approvals': sum(j['status'] in ATTENTION for j in self.data['jobs']),
                  'help': sum(j['status'] in HELP and j['id'] not in self.processes for j in self.data['jobs'])}
        reached = [f"{counts[key]} {label} (limit {limits[key]})"
                   for key, label in [('approvals', 'need approval'), ('help', 'need help')]
                   if limits[key] > 0 and counts[key] >= limits[key]]
        return 'Auto-stop: ' + '; '.join(reached) if reached else None

    def _enforce_backlog_limits(self):
        reason = self._backlog_limit_reason()
        if self.data['running'] and reason:
            self.data['running'] = False
            self.data['auto_stop_reason'] = reason
            for item in self.data['jobs']:
                if item['id'] in self.processes:
                    self._command(item, {'action': 'stop'})
        return reason

    def configure_auto_stop(self, approvals, help, usage=None):
        if any(type(n) is not int or not 0 <= n <= 10000 for n in (approvals, help)):
            raise ValueError('Auto-stop limits must be whole numbers from 0 to 10000; 0 is off')
        if usage is not None and (type(usage) is not int or not 0 <= usage <= 100):
            raise ValueError('The usage limit must be a whole percent from 0 to 100; 0 is off')
        with self.lock:
            self.data['auto_stop'] = {'approvals': approvals, 'help': help}
            if usage is not None:
                save_settings({'workers.usage_pause_percent': usage})
                self._usage_checked = 0  # Check the new limit on the next tick.
            self._enforce_backlog_limits()
            self._save()
            return self.snapshot()

    def configure_submission(self, require_approval):
        if type(require_approval) is not bool:
            raise ValueError('Submission approval must be on or off')
        from ..settings import save
        with self.lock:
            save({'workers.auto_submit': not require_approval})
            return self.snapshot()

    def control(self, action, parallelism=None, engine=None):
        if action == 'start':
            with self.lock:
                reason = self._backlog_limit_reason()
                if reason:
                    raise ValueError(reason + '. Clear the backlog or raise the limits before starting.')
            # Checked outside the lock: the CLI call takes a second and ticks must keep running.
            for used in self.engines_in_use():
                status = self.check_engine(used)
                if status['status'] != 'ready':
                    raise ValueError(status['message'])
        with self.lock:
            if parallelism is not None:
                if not 1 <= parallelism <= setting('workers.max_parallelism'):
                    raise ValueError(f"Parallelism must be between 1 and {setting('workers.max_parallelism')}")
                self.data['parallelism'] = parallelism
            if engine is not None:
                if engine not in WORKER_ENGINES:
                    raise ValueError('Engine must be claude, codex or agy')
                # The panel-wide choice sets every worker (each card can then override its own) and is
                # the default for new slots and for Needs help chats.
                self.data['engine'] = engine
                self.data['slots'] = [engine] * len(self.data.get('slots', []))
            self._fit_slots()
            if action == 'start':
                if not self.configured:
                    raise ValueError('The application worker, profile, resume and engine CLI must be set up first')
                reason = self._backlog_limit_reason()
                if reason:
                    raise ValueError(reason + '. Clear the backlog or raise the limits before starting.')
                self.data['auto_stop_reason'] = None
                self.data['stop_after_current'] = False
                self.data['running'] = True
                self._ensure_loop()
            elif action == 'configure':
                pass
            elif action == 'stop':
                self.data['resume_after_limit'] = False
                # Pause dispatch only. Active postings retain their browser and run
                # through completion/parking; per-role Stop remains cancellation.
                self.data['running'] = False
                self.data['stop_after_current'] = True
            else:
                raise ValueError('Unknown control action')
            self._save()
            return self.snapshot()

    def _command(self, item, command):
        path = self.directory / item['id'] / 'commands.json'
        if path.exists() and command['action'] != 'stop':
            raise ValueError('The previous command is still being processed')
        atomic(path, {'id': str(uuid.uuid4()), **command})
        if command['action'] == 'stop':
            self.stop_times[item['id']] = time.monotonic()

    def command(self, job_id, action, answers=None, review_id=None):
        with self.lock:
            item = next((j for j in self.data['jobs'] if j['job_id'] == job_id), None)
            if item is None:
                raise ValueError('This job is not in the application queue')
            self._refresh(item)
            if action == 'retry':
                if item['status'] not in REQUEUEABLE or item['id'] in self.processes:
                    raise ValueError('Only failed or stopped preparation can be retried')
                self._mark_performance_intervention(item)
                job = self._job(job_id)
                preserved = {key: item[key] for key in ('approved_answers', 'recovery_ready', 'prepare_manually', 'human_intervention') if key in item}
                item.clear()
                item.update(preserved)
                item.update(id=str(uuid.uuid4()), job_id=job_id, company=job['company'], title=job['title'], url=job['url'], status='queued', phase='queued', message='Queued for another preparation attempt', updated_at=now())
            elif action == 'stop' and item['status'] == 'queued':
                self.data['jobs'].remove(item)  # It never ran, so nothing needs to be kept.
            else:
                if item['id'] not in self.processes:
                    raise ValueError('This application worker is not running')
                if action == 'approve':
                    review = item.get('review') or {}
                    if not review_id or review.get('id') != review_id or item['status'] not in {'waiting_review', 'awaiting_review'}:
                        raise ValueError('The review changed; refresh and review the current answers')
                if action == 'answer':
                    questions = {q['id'] for q in item.get('questions', [])}
                    if not answers or not set(answers) <= questions:
                        raise ValueError('Answers must match the current questions')
                if action not in {'answer', 'approve', 'stop', 'open_browser', 'resume'}:
                    raise ValueError('Unknown application action')
                self._mark_performance_intervention(item)
                self._command(item, {'action': action, 'answers': answers, 'review_id': review_id})
            self._save()
            return {'ok': True}

    def _performance_ledger(self):
        return self.directory / 'automatic-application-performance.json'

    def _record_automatic_attempt(self, item, request=None):
        """Start one denominator row when an application worker actually launches."""
        request = request or read(self.directory / item['id'] / 'request.json', {})
        if not request:
            return
        path = self._performance_ledger()
        ledger = read(path, {})
        if item['id'] in ledger:
            return
        intervention = bool(item.get('human_intervention') or request.get('humanIntervention') or request.get('humanFinish') or not request.get('autoSubmit'))
        ledger[item['id']] = {
            'run_id': item['id'], 'job_id': item['job_id'], 'company': item['company'], 'title': item['title'],
            'started_at': request.get('startedAt') or item.get('updated_at'), 'resolved_at': None,
            'status': item.get('status') or 'starting', 'confirmed': False, 'submitted': False,
            'fully_automatic_submission': False, 'human_intervention': intervention, 'tracked_from_launch': True,
            'counts_as_attempt': True,
        }
        atomic(path, ledger)

    def _mark_performance_intervention(self, item):
        """Remember a human action even if the worker later completes successfully."""
        item['human_intervention'] = True
        path = self._performance_ledger()
        ledger = read(path, {})
        record = ledger.get(item['id'])
        if record:
            record.update(human_intervention=True, submitted=False, fully_automatic_submission=False,
                          legacy_confirmed_automatic=False)
            ledger[item['id']] = record
            atomic(path, ledger)

    def mark_human_intervention(self, job_id):
        with self.lock:
            item = next((j for j in self.data['jobs'] if j['job_id'] == job_id), None)
            if item is None:
                raise ValueError('This posting is no longer in the application agent')
            self._mark_performance_intervention(item)
            self._save()
            return {'ok': True}

    def _record_automatic_outcome(self, item):
        """Refresh an attempt row and credit only a confirmed, uninterrupted automatic submit."""
        request = read(self.directory / item['id'] / 'request.json', {})
        if not request:
            return
        path = self._performance_ledger()
        ledger = read(path, {})
        record = ledger.get(item['id'])
        if not record:
            # Old launched runs are included, but their past intervention history is unknowable.
            record = {'run_id': item['id'], 'job_id': item['job_id'], 'company': item['company'],
                      'title': item['title'], 'started_at': request.get('startedAt') or item.get('updated_at'),
                      'tracked_from_launch': False, 'historical_intervention_unknown': True,
                      'human_intervention': True, 'submitted': False, 'fully_automatic_submission': False}
        legacy_confirmed = bool(record.get('legacy_confirmed_automatic'))
        confirmed = bool(legacy_confirmed or
                         (item.get('submitted') and item.get('status') in {'completed', 'submitted'}))
        intervention = bool(record.get('human_intervention') or item.get('human_intervention') or
                            item.get('human_finish') or item.get('submission_marked_by_user') or
                            request.get('humanIntervention') or request.get('humanFinish') or
                            request.get('autoSubmit') is not True)
        fully_automatic = bool(confirmed and not intervention and
                               (record.get('tracked_from_launch', False) or legacy_confirmed))
        resolved_at = (item.get('updated_at') or now()) if item.get('status') in TERMINAL else record.get('resolved_at')
        record.update(company=item['company'], title=item['title'],
                      status='submitted' if legacy_confirmed else item.get('status'),
                      resolved_at=resolved_at, confirmed=confirmed,
                      human_intervention=intervention, submitted=fully_automatic,
                      fully_automatic_submission=fully_automatic,
                      counts_as_attempt=bool(item.get('status') != 'skipped' or item.get('submission_attempted')))
        ledger[item['id']] = record
        atomic(path, ledger)

    def automatic_performance(self):
        with self.lock:
            records = read(self._performance_ledger(), {})
            records = records if isinstance(records, dict) else {}
            # Include every launched posting from old queue history. Legacy rows without a
            # launch-time intervention flag remain in the denominator but cannot be credited.
            for item in self.data['jobs']:
                if not (self.directory / item['id'] / 'request.json').is_file():
                    continue
                request = read(self.directory / item['id'] / 'request.json', {})
                counts_as_attempt = bool(item.get('status') != 'skipped' or item.get('submission_attempted'))
                if item['id'] not in records:
                    records[item['id']] = {'run_id': item['id'], 'job_id': item['job_id'],
                        'company': item['company'], 'title': item['title'],
                        'started_at': request.get('startedAt') or item.get('updated_at'),
                        'resolved_at': item.get('updated_at'), 'status': item.get('status'),
                        'confirmed': bool(item.get('submitted') and item.get('status') in {'completed', 'submitted'}),
                        'submitted': False, 'fully_automatic_submission': False,
                        'human_intervention': True, 'historical_intervention_unknown': True,
                        'tracked_from_launch': False, 'counts_as_attempt': counts_as_attempt}
                else:
                    records[item['id']]['counts_as_attempt'] = counts_as_attempt
            # The durable application history also contains postings applied to outside the
            # current runner history. Merge it into the denominator by job ID so manual and
            # historical applications count once and receive no automatic-submission credit.
            with self.sessions() as session:
                applications = session.query(
                    Application.job_id, Application.applied_date, Job.company_name, Job.title
                ).join(Job, Job.id == Application.job_id).all()
            application_job_ids = {job_id for job_id, _, _, _ in applications}
            for record in records.values():
                if record.get('job_id') in application_job_ids:
                    record['counts_as_attempt'] = True
            represented_job_ids = {record.get('job_id') for record in records.values()
                                   if record.get('counts_as_attempt') is not False}
            for job_id, applied_date, company, title in applications:
                if job_id in represented_job_ids:
                    continue
                key = f'application-history-{job_id}'
                records[key] = {
                    'run_id': key, 'job_id': job_id, 'company': company, 'title': title,
                    'started_at': applied_date.isoformat() if applied_date else None,
                    'resolved_at': applied_date.isoformat() if applied_date else None,
                    'status': 'applied', 'confirmed': False, 'submitted': False,
                    'fully_automatic_submission': False, 'human_intervention': True,
                    'historical_intervention_unknown': True, 'tracked_from_launch': False,
                    'counts_as_attempt': True, 'source': 'application_history',
                }
                represented_job_ids.add(job_id)
            attempts = list(records.values())
            attempts.sort(key=lambda entry: str(entry.get('started_at') or ''), reverse=True)
            return {'attempts': attempts, 'total_attempts': sum(entry.get('counts_as_attempt') is not False for entry in attempts),
                    'submitted': sum(bool(entry.get('fully_automatic_submission')) for entry in attempts)}

    def _refresh(self, item):
        if item['status'] in TERMINAL and item['status'] not in {'submitted_pending_receipt', 'submission_unknown'} and not (item['status'] == 'needs_human' and item.get('submission_attempted')):
            self._record_automatic_outcome(item)
            self._record_completion(item)
            return
        state = read(self.directory / item['id'] / 'state.json', {})
        for key in ('status', 'phase', 'message', 'url', 'updated_at', 'questions', 'events', 'review', 'usage', 'model_usage', 'submitted', 'submission_attempted', 'cap', 'posting_unavailable', 'not_application', 'receipt', 'receiptSource', 'webpageEvidence', 'ai_model'):
            if key in state:
                item[key] = state[key]
        self._record_automatic_outcome(item)
        if item.get('posting_unavailable') and not item.get('closure_recorded'):
            with self.sessions() as session:
                job = session.get(Job, item['job_id'])
                if job and value(job.status) in {'NEW', 'ACTIVE', 'SAVED'}:
                    job.status = JobStatus.CLOSED
                    session.commit()
            item['closure_recorded'] = True
        # The link led to a contractor marketplace, talent-network sign-up, assessment or identity check
        # instead of an application (not-application.mjs): ignored, and autoplay never takes it again.
        if item.get('not_application') and not item.get('ignore_recorded'):
            with self.sessions() as session:
                job = session.get(Job, item['job_id'])
                if job and value(job.status) in {'NEW', 'ACTIVE', 'SAVED'}:
                    job.status = JobStatus.IGNORED
                    session.commit()
            if item['job_id'] not in self.data['skipped']:
                self.data['skipped'].append(item['job_id'])
            item['ignore_recorded'] = True
        self._record_completion(item)

    def _record_completion(self, item):
        """Repair completion tracking after restart, preserving later pipeline decisions."""
        if item.get('submitted') and item['status'] in {'completed', 'submitted'} and not item.get('recorded'):
            with self.sessions() as session:
                job = session.get(Job, item['job_id'])
                if job and value(job.status) in {'NEW', 'ACTIVE', 'SAVED', 'APPLIED'}:
                    source = 'webpage' if item.get('receiptSource') == 'webpage' else 'employer'
                    JobRepository(session).record_application(item['job_id'], notes=f'Application worker observed {source} confirmation. See local worker evidence.', applied_date=self._submission_date(item))
                session.commit()
            item['recorded'] = True

    def _record_stale_completions(self):
        """Confirmed submissions whose recording was missed (a tick failure, a restart) still become applications."""
        for item in self.data['jobs']:
            if item.get('submitted') and item['status'] in {'completed', 'submitted'} and not item.get('recorded') and item['id'] not in self.processes:
                self._record_completion(item)

    def in_flight_job_ids(self):
        """Jobs whose application went out but is not yet recorded as applied (waiting on the employer's receipt)."""
        with self.lock:
            return [j['job_id'] for j in self.data['jobs']
                    if j['status'] in {'submitted_pending_receipt', 'submission_unknown'}
                    or (j.get('submitted') and j['status'] in {'completed', 'submitted'} and not j.get('recorded'))]

    def _submission_date(self, item):
        """Use the confirmed attempt time, rather than delayed receipt-check time."""
        evidence = item.get('webpageEvidence') or item.get('receipt') or {}
        durable = read(self.agent_dir / 'state' / f"jobagent-{item['job_id']}.json", {})
        request = read(self.directory / item['id'] / 'request.json', {})
        expected = request.get('job', {}).get('url')
        if expected and durable.get('canonicalUrl') not in {None, expected}:
            return None
        raw = evidence.get('submittedAt') or durable.get('submittedAt')
        try:
            submitted = datetime.fromisoformat(raw)
            submitted = submitted.replace(tzinfo=timezone.utc) if submitted.tzinfo is None else submitted.astimezone(timezone.utc)
            return submitted if submitted <= datetime.now(timezone.utc) + timedelta(seconds=5) else None
        except (TypeError, ValueError):
            return None

    def _launch(self, item, slot=0):
        if not item.get('human_finish') and self._visible_host(item.get('url')):
            item.update(human_finish=True, message='Opening your Chrome: this site needs you for its CAPTCHA')
        job = self._job(item['job_id'], human_finish=bool(item.get('human_finish')))  # Recheck immediately before consuming a slot.
        # A worker launched from Approvals or Needs help while workers are off (after a restart, 2026-10-23
        # Howmet) still needs the tick loop to refresh its card and reap it, or it sits as "starting" forever.
        self._ensure_loop()
        # A cover letter approved before letters became files (Varda 9948, 2026-10-22) is printed here instead.
        letters = [a for a in item.get('approved_answers', []) if a.get('answer') and self.cover_letter_question({'label': a.get('question')})]
        if letters and not item.get('documents', {}).get('coverLetter'):
            item['documents'] = {**item.get('documents', {}), 'coverLetter': str(self._write_cover_letter(item['job_id'], letters[-1]['answer']))}
        run_dir = self.directory / item['id']
        engine = self.data['slots'][slot] if slot < len(self.data['slots']) else self.data['engine']
        model = self.data.get('model') if engine == self.data.get('engine') else self._model(engine)
        command = self._cli(engine)
        if not command:
            raise ValueError(f'{WORKER_ENGINES[engine]} CLI was not found')
        workday = (urlsplit(job['url']).hostname or '').endswith('.myworkdayjobs.com')
        try:
            self._snapshot_documents(item)
        except OSError:
            item.pop('sent_documents', None)  # keeping the record never blocks the application itself
        atomic(run_dir / 'request.json', {'job': job, 'profilePath': str(self.agent_dir / 'private/profile.json'),
                                         'resumePath': str(self._resume_for(item)), 'engine': engine, 'command': command,
                                         # In his Chrome window a gap is handed to him at the screen, not parked on Approvals
                                         # (Arista 11814: the City* autocomplete parked twice and closed the window, 2026-10-24).
                                         'model': model, 'source': item.get('source'), 'startedAt': now(),
                                         'autoSubmit': bool(setting('workers.auto_submit')),
                                         'humanFinish': bool(item.get('human_finish')),
                                         'realChrome': bool(self._real_chrome_host(job['url'])),
                                         'maxSteps': setting('workers.max_steps'), 'parkQuestions': not item.get('human_finish'), 'prepareManually': bool(item.get('retries') or item.get('prepare_manually')),
                                         'humanIntervention': bool(item.get('human_intervention')),
                                         'approvedAnswers': item.get('approved_answers', []), 'documents': item.get('documents', {}),
                                         'submit': bool(item.get('submit')), 'autoSubmit': setting('workers.auto_submit'), 'scriptedActions': setting('workers.scripted_actions'), 'directControl': setting('workers.direct_control'), 'verifyLink': item.get('verify_link'),
                                         'headlessOnly': True, 'humanFinish': bool(item.get('human_finish')),
                                         'approvedDigest': item.get('approved_digest'),
                                         'applicationCaps': application_caps.approved_limits()})
        # Platform adapters handle navigation; the selected CLI resolves unfamiliar questions on all platforms.
        script = 'src/dashboard-workday.mjs' if workday else 'src/dashboard-worker.mjs'
        log = open(run_dir / 'worker.log', 'ab')
        os.chmod(run_dir / 'worker.log', 0o600)
        try:
            # Unattended applications must never inherit a manual browser or
            # switch to headed recovery. Explicit viewing uses a separate
            # applicant-requested manual run, not this automatic launcher.
            worker_env = {**os.environ, 'APPLICATION_AGENT_HEADED': '0'}
            worker_env.pop('WORKDAY_CDP', None)
            process = self.popen([self._node() or 'node', str(self.agent_dir / script), str(run_dir)],
                                 cwd=self.agent_dir, stdout=log, stderr=log, start_new_session=True, env=worker_env)
        finally:
            log.close()
        self.processes[item['id']] = process
        item.pop('explicit_next', None)
        item['pid'] = process.pid
        item['engine'] = engine
        item['adapter'] = 'workday' if workday else 'generic'
        item['slot'] = slot
        item.update(status='starting', phase='starting', message='Opening application', updated_at=now())
        self._record_automatic_attempt(item)

    @staticmethod
    def _model(engine):
        # A selected model is stored in queue.json; otherwise use the low-cost current Sonnet model.
        if engine == 'claude':
            return os.environ.get('JOBAGENT_CLAUDE_MODEL', 'claude-sonnet-5-5')
        if engine == 'agy':
            return None  # application-agent picks agy's model (model-fallback.mjs)
        return os.environ.get('JOBAGENT_CODEX_MODEL') or None

    def _reconcile_stale_attention(self):
        for item in self.data['jobs']:
            if item['id'] in self.processes or item['status'] not in HELP | PARKED:
                continue
            if item.get('recovery_hold'):
                continue
            if item['status'] == 'submission_unknown' or item.get('submitted') or item.get('submission_attempted'):
                continue
            message = item.get('message', '')
            if 'Posting unavailable: employer reports that this job page no longer exists' in message:
                item.update(status='skipped', phase='skipped', posting_unavailable=True, updated_at=now())
                with self.sessions() as session:
                    job = session.get(Job, item['job_id'])
                    if job and value(job.status) in {'NEW', 'ACTIVE', 'SAVED'}:
                        job.status = JobStatus.CLOSED
                        session.commit()
                item['closure_recorded'] = True
            else:
                self._retire_unavailable(item, message)

    def tick(self):
        with self.lock:
            self._fit_slots()
            self._expire_model_limits()
            self._usage_pause()
            self._reconcile_stale_attention()
            self._auto_submit_ready()
            self._draft_writing()
            self._retire_submitted_help()
            self._check_receipts()
            try:
                self._record_sent_documents()
            except Exception:
                pass  # retried next tick; never stops dispatch
            for item in self.data['jobs']:
                process = self.processes.get(item['id'])
                if not process:
                    continue
                self._refresh(item)
                self._record_model_limit(item)
                if item['id'] in self.stop_times and time.monotonic() - self.stop_times[item['id']] > 8 and process.poll() is None:
                    self._terminate(process)
                self._stop_if_stalled(item, process)
                if process.poll() is not None:
                    self._refresh(item)
                    if item['status'] not in TERMINAL:
                        item.update(status='interrupted', message=item.pop('stalled', None) or 'Worker exited. Check the employer before retrying.', updated_at=now())
                    self._record_automatic_outcome(item)
                    self._note_run_failure(item)
                    self._note_access_denied(item)
                    self._note_progress(item)
                    self._note_cap(item)
                    if item['status'] == 'needs_cap_approval' and item.get('cap'):
                        application_caps.record(item['company'], item['cap'], 'application page', item['job_id'], item.get('url'))
                    self.processes.pop(item['id'], None)
                    self.stop_times.pop(item['id'], None)
                    limited = self._record_model_limit(item)
                    if not limited and item.get('engine'):
                        (self.data.get('limit_streaks') or {}).pop(item['engine'], None)  # the engine answered again
                    if not limited and not self._cool_down_if_throttled(item):
                        self._retry_if_technical(item)
                    self._hand_off_captcha(item)
            self._record_stale_completions()
            self._sweep_blocked_hosts()
            self._dismiss_gone()
            if any(read(self.directory / 'engine-status.json', {}).get(e, {}).get('status') == 'usage_limited' for e in self.engines_in_use()):
                self.data['running'] = False
            self._enforce_backlog_limits()
            self._update_dispatch_capacity()
            self._update_breakers()
            self._repair_technical_failures(include_approvals=self.data['running'])
            if self.data['running']:
                self._requeue_after_password()
                # His choice (2026-11-02): no internships. A queued one is set aside, not failed.
                if not setting('workers.apply_internships'):
                    for item in [j for j in self.data['jobs'] if j['status'] == 'queued']:
                        role = None
                        with self.sessions() as session:
                            job = session.get(Job, item['job_id'])
                            role = job.role_type if job else None
                        if internship_blocked(role, item.get('title')):
                            item.update(status='skipped', phase='skipped', updated_at=now(),
                                        message='Internships are off (Settings: Apply to internships); not applied to.')
                auto_queued = [j for j in self.data['jobs'] if j['status'] == 'queued' and j.get('source') == 'autoplay'
                               and not j.get('explicit_next')]
                manual_only = self._manual_selection_companies() if auto_queued else set()
                for item in auto_queued:
                    company = item['company'].casefold()
                    if company not in manual_only or self._high_volume_open(company, exclude_job_id=item['job_id']):
                        continue
                    item.update(status='skipped', phase='skipped', updated_at=now(),
                                message=f"Autoplay held this role because {item['company']} requires manual role selection. Add the specific posting to your application queue to apply.")
                    if item['job_id'] not in self.data['skipped']:
                        self.data['skipped'].append(item['job_id'])
                companies = {j['company'].casefold() for j in self.data['jobs'] if j['id'] in self.processes}
                for item in sorted(self.data['jobs'], key=lambda j: (not j.get('explicit_next'), not self._recovery_ready(j))):
                    if self._enforce_backlog_limits():
                        break
                    self._update_dispatch_capacity()
                    slot = self._free_slot(recovery=self._recovery_ready(item) or bool(item.get('explicit_next')))
                    if slot is None:
                        continue
                    # The company filter steers what autoplay picks; a role he queued himself runs regardless
                    # (his instruction 2026-11-12: "just apply to the ones in queue").
                    if (item['status'] != 'queued' or (item.get('source') == 'autoplay' and not self._company_in_filter(item['company'])) or
                            item['company'].casefold() in companies or self._cooling(item)):
                        continue
                    if self._breaker_gate(item) or self._limit_gate(item) or self._resume_gate(item):
                        continue
                    try:
                        self._launch(item, slot)
                        companies.add(item['company'].casefold())
                    except Exception as exc:
                        if not self._retire_unavailable(item, exc):
                            item.update(status='failed', message=str(exc), updated_at=now())
                # With nothing queued that can start, keep going down the priority list.
                attempts = 0
                while self.data['running'] and self.data['autoplay']['enabled'] and self._free_slot() is not None and attempts < 5:
                    if self._enforce_backlog_limits():
                        break
                    self._update_dispatch_capacity()
                    if self._free_slot() is None:
                        break
                    if self._resume_tailoring() and self.resume_reviewer.busy():
                        break  # picks wait for a resume check rather than piling up unchecked
                    attempts += 1
                    pick = next(iter(self.up_next(1, busy=companies)), None)
                    if pick is None:
                        break
                    try:
                        item = self._item(self._job(pick['job_id']))
                    except ValueError:
                        self.data['skipped'].append(pick['job_id'])
                        continue
                    item['source'] = 'autoplay'
                    self.data['jobs'].append(item)
                    if self._resume_gate(item):
                        continue
                    try:
                        self._launch(item, self._free_slot())
                        companies.add(item['company'].casefold())
                    except Exception as exc:
                        if not self._retire_unavailable(item, exc):
                            item.update(status='failed', message=str(exc), updated_at=now())
            self._enforce_backlog_limits()
            self._update_dispatch_capacity()
            self._save()

    def _breaker_ledger(self):
        return self.directory / 'failure-signatures.json'

    def _note_run_failure(self, item):
        """Give a failed run its class and signature, and hold its site when the same failure repeats."""
        if item['status'] not in {'failed', 'interrupted'}:
            return
        threshold = int(setting('workers.breaker_failures'))
        ledger = read(self._breaker_ledger(), {})
        sig, kind = failure_signatures.note_failure(
            ledger, job_id=item['job_id'], message=item.get('message') or '', url=item.get('url'),
            at=item.get('updated_at') or now(), window_minutes=int(setting('workers.breaker_window_minutes')))
        item.update(failure_signature=sig, failure_class=kind)
        atomic(self._breaker_ledger(), ledger)
        breakers = self.data.setdefault('breakers', [])
        if threshold <= 0 or sig not in ledger or any(b['signature'] == sig for b in breakers):
            return
        scope = failure_signatures.tripped(ledger[sig], threshold)
        if scope is None:
            return
        job_ids = sorted({f['job_id'] for f in ledger[sig]['failures']})
        where = 'every site' if scope == '*' else scope
        breakers.append({'signature': sig, 'class': kind, 'scope': scope, 'opened_at': now(), 'job_ids': job_ids,
                         'example': ledger[sig]['example'], 'repair_job_id': None,
                         'message': f"{len(job_ids)} postings failed the same way on {where}; new applications there wait "
                                    f"while one repair agent looks at it: {ledger[sig]['example'][:160]}"})
        logging.getLogger(__name__).warning('Breaker opened on %s for %s (%s)', where, sig, job_ids)

    @staticmethod
    def _reach_url(url):
        parts = urlsplit(url or '')
        return f"{(parts.hostname or '').lower()}{re.sub(r'/+$', '', parts.path or '')}" if parts.hostname else ''

    def _note_progress(self, item):
        """Stop automatic retries of a role whose runs keep ending at the same place.

        A run made progress when it reached what no earlier run of this role did: a different outcome (failure
        signature), a new page, more recorded steps, or new questions flagged. Runs that end waiting on him or
        submitted reset the count; runs stopped at an AI plan limit or an employer throttle (which has its own
        cool-down ladder) and runs he stopped are not counted."""
        status, message = item['status'], item.get('message') or ''
        progress = item['progress'] = item.get('progress') or {'runs': 0, 'signatures': [], 'urls': [], 'events': 0, 'questions': []}
        if status in SETTLED or item.get('submitted') or item.get('submission_attempted'):
            progress['runs'] = 0
            return
        if status not in HELP or MODEL_LIMIT.search(message) or THROTTLED.search(message):
            return
        state = read(self.directory / item['id'] / 'state.json', {})
        signature = failure_signatures.signature(message)
        reach = self._reach_url(state.get('url') or item.get('url'))
        steps = len(state.get('events') or item.get('events') or [])
        questions = sorted({str(q.get('label')) for q in (state.get('questions') or item.get('questions') or []) if q.get('label')})
        earlier = bool(progress['signatures'] or progress['urls'])
        progressed = earlier and (signature not in progress['signatures'] or (reach and reach not in progress['urls'])
                                  or steps > progress['events'] or bool(set(questions) - set(progress['questions'])))
        progress.update(signatures=[*dict.fromkeys([*progress['signatures'], signature])][-20:],
                        urls=[*dict.fromkeys([*progress['urls'], *([reach] if reach else [])])][-20:],
                        events=max(progress['events'], steps), questions=sorted({*progress['questions'], *questions})[-50:])
        # The runs in a row that ended at the same reach, counting the one that first got there.
        progress['runs'] = 1 if progressed or not earlier else progress['runs'] + 1
        cap = int(setting('workers.max_runs_without_progress'))
        if cap > 0 and progress['runs'] >= cap:
            reason = re.sub(r'^Stopped after \d+ runs without progress: ', '', message)
            item.update(progress_capped=True, last_reason=reason,
                        message=f"Stopped after {progress['runs']} runs without progress: {reason}")

    def _breaker_gate(self, item):
        """True when the queued role's site is held; it keeps its place and starts once the hold lifts."""
        breaker = failure_signatures.holds(self.data.get('breakers') or [], item.get('url'))
        if not breaker:
            return False
        item['message'] = f"Waiting: {breaker['message']}"
        return True

    def _update_breakers(self):
        """Lift a hold once its repair finished or it expired."""
        desk = getattr(self, '_repair_desk', None)
        running = set(getattr(desk, 'processes', {}) or {})
        now_at = datetime.now(timezone.utc)
        for breaker in list(self.data.get('breakers') or []):
            repaired = breaker.get('repair_job_id') is not None and breaker['repair_job_id'] not in running
            if repaired or failure_signatures.expired(breaker, now_at, int(setting('workers.breaker_hold_hours'))):
                self._close_breaker(breaker, 'repaired' if repaired else 'expired')

    def _close_breaker(self, breaker, reason):
        self.data['breakers'] = [b for b in self.data.get('breakers') or [] if b is not breaker]
        ledger = read(self._breaker_ledger(), {})
        if breaker['signature'] in ledger:
            ledger[breaker['signature']]['failures'] = []  # count afresh: a repeat after a repair holds again
            atomic(self._breaker_ledger(), ledger)
        retried = []
        # Postings stopped by the same failure try once more; the repaired one is retried by its repair.
        for item in [j for j in self.data['jobs'] if j.get('failure_signature') == breaker['signature']
                     and j['status'] in {'failed', 'interrupted'} and j['job_id'] != breaker.get('repair_job_id')
                     and j['id'] not in self.processes and not j.get('breaker_retried')]:
            try:
                fresh = self._resume_from(item['job_id'], {'failed', 'interrupted'}, retries=item.get('retries', 0),
                                          breaker_retried=True,
                                          message=f'Retrying after the held failure was {reason}')
                retried.append(fresh['job_id'])
            except ValueError:
                pass
        self.data.setdefault('breaker_history', []).append({**breaker, 'closed_at': now(), 'closed_because': reason, 'retried': retried})
        self.data['breaker_history'] = self.data['breaker_history'][-50:]
        logging.getLogger(__name__).info('Breaker on %s closed (%s); retried %s', breaker['scope'], reason, retried)
        return retried

    def clear_breaker(self, signature):
        """He resumes a held site from the dashboard."""
        with self.lock:
            breaker = next((b for b in self.data.get('breakers') or [] if b['signature'] == signature), None)
            if breaker is None:
                raise ValueError('That site is no longer held')
            retried = self._close_breaker(breaker, 'cleared by you')
            self._save()
            return {'ok': True, 'retried': retried}

    def _hand_off_captcha(self, item):
        """His request (2026-11-01): when the CAPTCHA package could not pass a challenge in the hidden relay Chrome,
        he finishes it in a visible Chrome. The worker closed the hidden tab without sending anything (phase
        captcha_handoff); this opens his finish-yourself Chrome with the form refilled, as Finish in my Chrome does."""
        if item.get('phase') != 'captcha_handoff' or item.get('human_finish') or item.get('submission_attempted'):
            return False
        if not setting('workers.captcha_visible_handoff'):
            return False
        try:
            self.finish_myself(item['job_id'])
            return True
        except ValueError as error:
            item['message'] = f"{item.get('message') or ''} Could not open the visible Chrome: {error}".strip()
            return False

    def _retry_if_technical(self, item):
        if item['status'] not in {'blocked', 'failed'} or not TECHNICAL.search(item.get('message') or ''):
            return
        if item.get('retries', 0) >= AUTO_RETRIES:
            return
        try:
            self._resume_from(item['job_id'], {'blocked', 'failed'}, retries=item.get('retries', 0) + 1,
                              message='Retrying once after a technical error')
        except ValueError:
            pass

    def _repair_technical_failures(self, include_approvals=True, job_ids=None, force=False):
        """Diagnose parked technical failures independently from application workers."""
        from contextlib import nullcontext
        from .attention_triage import classify_attention, triage_prompt
        path = self.directory / 'internal-repairs.json'
        approval_path = self.directory / 'background-triage.json'
        attempts, approvals = read(path, {}), read(approval_path, {})
        saved_drafts = read(self.directory / 'answer-drafts.json', {})
        desk = getattr(self, '_repair_desk', None)
        maximum = max(1, min(10, int(setting('workers.max_repair_agents'))))
        launches, budget = 0, None
        claimed = set()
        selected_ids = set(job_ids) if job_ids is not None else None
        coordination = self.agent_dir / 'private' / 'agent-coordination.md'
        try:
            log = coordination.read_text().partition('## Log')[2]
        except OSError:
            log = ''
        for line in log.splitlines():
            match = re.match(r'- (\S+) (?:Claude|Codex): (CLAIM|HOLD|DONE) (\d+)\b', line)
            if not match:
                continue
            stamp, action, job_id = match.groups()
            try:
                at = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
                if at.tzinfo is None:
                    continue
            except ValueError:
                continue
            if action == 'DONE':
                claimed.discard(int(job_id))
            elif action == 'HOLD' or datetime.now(timezone.utc) - at < timedelta(minutes=30):
                claimed.add(int(job_id))
        for item in self.data['jobs']:
            if item['status'] not in {'needs_approval', 'failed', 'blocked', 'needs_human', 'interrupted', 'submission_unknown'}:
                continue
            if selected_ids is not None and item['job_id'] not in selected_ids:
                continue
            durable = read(self.agent_dir / 'state' / f"jobagent-{item['job_id']}.json", {})
            view = {**item, 'questions': [dict(q) for q in item.get('questions', [])]}
            for question in view['questions']:
                draft = saved_drafts.get(str(item['job_id']), {}).get(question.get('label'))
                if draft:
                    question['draft'] = draft
            decision = classify_attention(view, durable, cooling=self._cooling(item))
            previous = item.get('background_triage') or {}
            metadata = {'state': decision['state'], 'reason': decision['reason'],
                        'checked_at': previous.get('checked_at') if previous.get('fingerprint') == decision['fingerprint'] else now(),
                        'fingerprint': decision['fingerprint']}
            item['background_triage'] = metadata
            approval = item['status'] == 'needs_approval'
            if approval and not include_approvals:
                continue
            if not approval and not force and not self.data.get('auto_repair_enabled', True):
                metadata.update(state='auto_repair_off', reason='Automatic diagnosis and repair is turned off. Turn it on or start a repair for this posting.')
                continue
            seen = approvals.get(str(item['job_id']), {}).get('reviews', {})
            busy = desk is not None and item['job_id'] in desk.processes
            if busy:
                metadata.update(state='running', reason='A background agent is reviewing this application.')
                continue
            if item.get('held_for_user'):
                metadata.update(state='needs_user', reason=item.get('message') or f'Waiting on {identity.first_name()}.')
                continue
            if not decision['dispatch']:
                continue
            if approval and decision['fingerprint'] in seen:
                metadata['checked_at'] = seen[decision['fingerprint']]['started_at']
                continue
            if item['id'] in self.processes or item['job_id'] in claimed:
                metadata.update(state='queued', reason='Waiting for the current worker or partner claim.')
                continue
            # One repair covers a held failure: the other postings it stopped wait and are retried when it ends.
            breaker = None if approval else next((b for b in self.data.get('breakers') or []
                                                  if b['signature'] == item.get('failure_signature')), None)
            if breaker and breaker.get('repair_job_id') not in (None, item['job_id']):
                metadata.update(state='same_failure', reason=f"Same failure as posting {breaker['repair_job_id']}, which a repair agent "
                                                             'is already working on; this posting is retried when that repair ends.')
                continue
            if not approval and not repair_allowed(attempts.get(str(item['job_id'])), item.get('message') or ''):
                metadata.update(state='technical_exhausted', reason='Previous CLI diagnosis budget exhausted; technical follow-up is needed, not an applicant answer.')
                continue
            if desk is None:
                command = self._cli(item.get('agent_engine') if item.get('agent_engine') in ENGINES else 'claude')
                if not command or not Path(command).is_file():
                    metadata.update(state='queued', reason='Waiting for the signed-in agent command.')
                    continue
                from .assist import get_desk
                desk = self._repair_desk = get_desk()
            with getattr(desk, 'lock', nullcontext()):
                if budget is None:
                    budget = max(0, maximum - len(desk.processes))
                if not approval and getattr(desk, 'internal_repairs', set()) - {item['job_id']}:
                    metadata.update(state='queued', reason='Waiting for the active code repair to finish before diagnosing another posting.')
                    continue
                busy_companies = {j['company'].casefold() for j in self.data['jobs'] if j['job_id'] in desk.processes}
                if launches >= budget or len(desk.processes) >= maximum or item['job_id'] in desk.processes or item['company'].casefold() in busy_companies:
                    metadata.update(state='queued', reason='Waiting for a background agent or this employer’s current agent.')
                    continue
                started = now()
                launches += 1
                if approval:
                    entry = approvals.setdefault(str(item['job_id']), {'reviews': {}})
                    entry['reviews'][decision['fingerprint']] = {'started_at': started, 'run_id': item['id'], 'state': decision['state']}
                    atomic(approval_path, approvals)
                    repair_model = None
                else:
                    history = repair_history(attempts.get(str(item['job_id'])))
                    repair_model = REPAIR_MODELS[min(len(history), len(REPAIR_MODELS) - 1)]
                    attempts[str(item['job_id'])] = {'attempts': [*history, {'started_at': started, 'run_id': item['id'], 'failure': item.get('message') or '', 'model': repair_model}]}
                    atomic(path, attempts)
                try:
                    # Claude by default; a posting he pinned to Codex keeps Codex. Each repair
                    # attempt is a fresh session so the escalation model starts clean.
                    reviewer = item.get('agent_engine') if item.get('agent_engine') in ENGINES else 'claude'
                    pinned = item.get('agent_model') if item.get('agent_model') in AGENT_MODELS.get(reviewer, ()) else None
                    model = pinned or (repair_model if reviewer == 'claude' else None)
                    if hasattr(desk, 'chat'):
                        chat = desk.chat(item['job_id'])
                        if chat.get('engine') and (chat['engine'] != reviewer or (model and chat.get('model') != model)):
                            chat.setdefault('prior_sessions', []).append({'engine': chat['engine'], 'model': chat.get('model'), 'session': chat.get('session')})
                            chat.update(engine=reviewer, session=None, model=None)
                            desk._save(chat)
                    prompt = triage_prompt(view, decision) if approval else (item.get('message') or decision['reason'])
                    if breaker:
                        where = 'every site' if breaker['scope'] == '*' else breaker['scope']
                        prompt += (f"\n\nThis same failure ({breaker['class']}) stopped {len(breaker['job_ids'])} postings on {where} "
                                   f"(jobs {', '.join(map(str, breaker['job_ids']))}) within {setting('workers.breaker_window_minutes')} minutes. "
                                   'New applications there are held until this repair ends: fix the cause in the application agent '
                                   'so all of them pass, not only this posting.')
                    desk.send(item['job_id'], prompt, engine=reviewer, internal=not approval, **({'model': model} if model else {}))
                    if breaker:
                        breaker['repair_job_id'] = item['job_id']  # the hold lifts when this repair ends
                    # Name the engine and model the session really started with, not the ones asked for.
                    actual = desk.chat(item['job_id']) if hasattr(desk, 'chat') else {}
                    ran, ran_model = (actual.get('engine') if actual.get('engine') in ENGINES else reviewer), actual.get('model') or model
                    metadata.update(state='running', reason=f"A full {ENGINES[ran]}{' (' + ran_model + ')' if ran_model else ''} agent is reviewing this application.", checked_at=started)
                    item['internal_repair'] = 'started'
                except Exception as exc:
                    metadata.update(state='needs_user', reason=f'Could not start background agent review: {exc}')
                    item['internal_repair'] = f'Could not start internal repair: {exc}'

    def configure_auto_repair(self, enabled):
        if type(enabled) is not bool:
            raise ValueError('Automatic diagnosis and repair must be on or off')
        with self.lock:
            self.data['auto_repair_enabled'] = enabled
            self._save()
            if enabled:
                self._ensure_loop()
            else:
                desk = getattr(self, '_repair_desk', None)
                if desk is not None:
                    for job_id in list(getattr(desk, 'internal_repairs', set())):
                        try:
                            desk.stop(job_id)
                        except ValueError:
                            pass
            return {'enabled': enabled}

    def start_repair(self, job_id):
        with self.lock:
            item = next((j for j in self.data['jobs'] if j['job_id'] == job_id and j['status'] in HELP), None)
            if item is None:
                raise ValueError('This posting is no longer waiting in Needs help')
            self._mark_performance_intervention(item)
            try:
                self._repair_technical_failures(include_approvals=False, job_ids={job_id}, force=True)
            except Exception as exc:
                raise ValueError(f'Could not start diagnosis: {exc}') from exc
            desk = getattr(self, '_repair_desk', None)
            if desk is not None and job_id in desk.processes:
                return {'ok': True, 'state': 'running'}
            triage = item.get('background_triage') or {}
            if triage.get('state') == 'queued':
                return {'ok': True, 'state': 'queued'}
            reason = triage.get('reason') or 'No safe repair was started for this posting.'
            raise ValueError(reason)

    def _cool_down_if_throttled(self, item):
        if item['status'] not in {'blocked', 'failed', 'needs_human'} or not THROTTLED.search(item.get('message') or ''):
            return False
        count = item.get('cooldowns', 0)
        cooldowns = [timedelta(minutes=m) for m in setting('workers.rate_limit_cooldowns')]
        if count >= len(cooldowns):
            return False  # It keeps happening after long waits: Needs help.
        until = (datetime.now(timezone.utc) + cooldowns[count]).isoformat()
        self.data['cooling'][item['company'].casefold()] = until
        try:
            fresh = self._resume_from(item['job_id'], {item['status']}, cooldowns=count + 1, not_before=until,
                                      message=f"{item['company']}'s site is unavailable; cooling down, then trying again")
        except ValueError:
            return False
        # Back of the line, not the front.
        self.data['jobs'].remove(fresh)
        self.data['jobs'].append(fresh)
        self._save()
        return True

    def finish_myself(self, job_id):
        """His request from Needs help: fill this application in a plain Chrome window and leave Submit to him
        (2026-10-23). Starts now, even with workers off, because he is waiting at the screen."""
        with self.lock:
            item = next((j for j in self.data['jobs'] if j['job_id'] == job_id and j['status'] in HELP | PARKED), None)
            if item is None or item['id'] in self.processes:
                raise ValueError('This role is not waiting on you')
            state = read(self.agent_dir / 'state' / f'jobagent-{job_id}.json', {})
            if state.get('status') in {'submitted', 'submitted_pending_receipt', 'submitting', 'submission_unknown'}:
                raise ValueError('This application already has a submission on record; check for the employer receipt first')
            self._mark_performance_intervention(item)
            fresh = self._item(self._job(job_id, human_finish=True))
            for key in ('approved_answers', 'resume_variant', 'documents', 'source'):
                if key in item:
                    fresh[key] = item[key]
            fresh.update(human_finish=True, human_intervention=True,
                         message='Opening Chrome to fill this application for you to submit')
            self.data['jobs'][self.data['jobs'].index(item)] = fresh
            self._launch(fresh, 0)
            self._save()
            return {'ok': True}

    def mark_submitted(self, job_id):
        """Record the user's confirmation that a Help posting was submitted and close its Help item."""
        with self.lock:
            item = next((j for j in self.data['jobs'] if j['job_id'] == job_id and j['status'] in HELP
                         and j['id'] not in self.processes), None)
            if item is None:
                raise ValueError('This posting is no longer waiting in Needs help')
            self._mark_performance_intervention(item)
            with self.sessions() as session:
                job = session.get(Job, job_id)
                if job is None:
                    raise ValueError('Job not found')
                JobRepository(session).record_application(
                    job_id, notes='Marked submitted by the user from Needs help.')
                session.commit()
            item.update(status='completed', phase='completed', submitted=True, recorded=True,
                        submission_marked_by_user=True, updated_at=now(),
                        message='Marked submitted by the user; moved to Applied and removed from Needs help.')
            self._record_automatic_outcome(item)
            self._save()
            try:
                from .assist import get_desk
                get_desk().stop(job_id)
            except Exception:
                pass
            return {'ok': True, 'job_id': job_id, 'status': 'APPLIED'}

    def _retire_submitted_help(self):
        """A submitted application never stays on Needs help (his rule, 2026-10-23): once the job is recorded as
        applied (by a worker, by him, or by Mark applied) or its state shows a confirmed submission, the item is closed."""
        now_ts = time.monotonic()
        if now_ts - getattr(self, '_help_sweep_at', 0) < 15:
            return
        self._help_sweep_at = now_ts
        waiting = [j for j in self.data['jobs'] if j['status'] in HELP and j['id'] not in self.processes]
        if not waiting:
            return
        with self.sessions() as session:
            applied = {job.id for job in session.query(Job).filter(Job.id.in_([j['job_id'] for j in waiting]))
                       if value(job.status) in {'APPLIED', 'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN'}}
        for item in waiting:
            state = read(self.agent_dir / 'state' / f"jobagent-{item['job_id']}.json", {})
            confirmed = state.get('status') == 'submitted'
            if item['job_id'] not in applied and not confirmed:
                continue
            item.update(status='completed', phase='completed', submitted=True, recorded=item['job_id'] in applied, updated_at=now(),
                        message='Submitted' + (' (recorded as applied)' if item['job_id'] in applied else ' (employer confirmation on file)') + '; removed from Needs help.')
            self._record_completion(item)  # a confirmed submission is an application on record (Varda 9911, 2026-10-23)
            try:
                from .assist import get_desk
                get_desk().stop(item['job_id'])  # its Help chat agent has nothing left to do
            except Exception:
                pass

    def help_items(self):
        with self.lock:
            items = json.loads(json.dumps([j for j in self.data['jobs'] if j['status'] in HELP and j['id'] not in self.processes]))
            for item in items:
                item['screenshot_url'] = f"/api/applications/workers/{item['id']}/screenshot" if (self.directory / item['id'] / 'screenshot.jpg').is_file() else None
                resume = self._help_resume(item)
                item['resume'] = resume and {'label': resume['label'], 'tailored': resume['tailored'],
                                             'url': f"/api/applications/help/{item['job_id']}/resume.pdf"}
            return items

    def _help_resume(self, item):
        """The resume a Needs help posting uploaded (its sent copy), else the one it would upload: its tailored copy or the standing resume."""
        sent = item.get('sent_documents') and Path(item['sent_documents'])
        if sent and (sent / identity.resume_filename()).is_file():
            label = read(sent / 'sent.json', {}).get('resume_label') or self._resume_label(item)
            return {'path': sent / identity.resume_filename(), 'label': label, 'tailored': label.startswith('Tailored')}
        try:
            path = Path(self._resume_for(item))
        except Exception:
            return None
        if not path.is_file():
            return None
        label = self._resume_label(item)
        return {'path': path, 'label': label, 'tailored': label.startswith('Tailored')}

    def help_resume(self, job_id):
        with self.lock:
            item = next((j for j in self.data['jobs'] if j['job_id'] == job_id and j['status'] in HELP), None)
            resume = item and self._help_resume(item)
        if not resume:
            raise ValueError('No resume is saved for this posting')
        return resume['path'].read_bytes()

    @staticmethod
    def _available_memory_bytes():
        try:
            return os.sysconf('SC_AVPHYS_PAGES') * os.sysconf('SC_PAGE_SIZE')
        except (ValueError, OSError, AttributeError):
            pass
        # macOS exposes reclaimable pages through vm_stat rather than sysconf.
        try:
            result = subprocess.run(['/usr/bin/vm_stat'], capture_output=True, text=True, timeout=2)
            page_size = int(re.search(r'page size of (\d+) bytes', result.stdout).group(1))
            pages = sum(int(m.group(1)) for key in ('Pages free', 'Pages inactive', 'Pages speculative')
                        if (m := re.search(rf'^{key}:\s+(\d+)', result.stdout, re.M)))
            return pages * page_size if pages else None
        except (OSError, subprocess.TimeoutExpired, AttributeError, ValueError):
            return None

    @staticmethod
    def _current_cpu_idle():
        # macOS load includes blocked work and stays high after a burst. Confirm
        # current CPU use before holding new browsers solely on that lagging value.
        if sys.platform != 'darwin':
            return None
        try:
            result = subprocess.run(['/usr/bin/top', '-l', '2', '-n', '0', '-s', '1'],
                                    capture_output=True, text=True, timeout=3)
            if result.returncode:
                return None
            samples = re.findall(r'CPU usage:[^\n]*?([\d.]+)% idle', result.stdout)
            idle = float(samples[-1]) if samples else None
            return idle if idle is not None and 0 <= idle <= 100 else None
        except (OSError, subprocess.TimeoutExpired, ValueError):
            return None

    def _resource_capacity(self, configured):
        stamp = time.monotonic()
        if self._resource_sample is None or stamp - self._resource_sample[0] >= 15:
            try:
                load = os.getloadavg()[0]
            except (OSError, AttributeError):
                load = 0
            self._resource_sample = (stamp, self._available_memory_bytes(), load, os.cpu_count() or 1, len(self.processes))
        _, available, load, cpus, sampled_active = self._resource_sample
        active = len(self.processes)
        capacity = configured
        if available is not None:
            available -= max(0, active - sampled_active) * 512 * 1024**2
            capacity = min(capacity, active + max(0, (available - 2 * 1024**3) // (512 * 1024**2)))
        if load > cpus * 2:
            sample = getattr(self, '_cpu_idle_sample', None)
            if sample is None or sample[0] != self._resource_sample[0]:
                sample = self._cpu_idle_sample = (self._resource_sample[0], self._current_cpu_idle())
            if sample[1] is None or sample[1] < 30:
                capacity = min(capacity, active)  # Let running browsers finish while the host recovers.
        return int(capacity)

    def _update_dispatch_capacity(self):
        configured = self.data['parallelism']
        active = len(self.processes)
        counts = {'approvals': sum(j['status'] in ATTENTION for j in self.data['jobs']),
                  'help': sum(j['status'] in HELP and j['id'] not in self.processes for j in self.data['jobs'])}
        reserves = [max(0, limit - counts[key] - 1) for key, limit in self.data['auto_stop'].items() if limit > 0]
        backlog = min([configured, *reserves])
        if not self.data['running']:
            self._adaptive_started = None
        elif self._adaptive_started is None:
            self._adaptive_started = time.monotonic()
        # Small manually selected pools retain their existing immediate scheduling.
        elapsed = max(0, time.monotonic() - self._adaptive_started) if self._adaptive_started is not None else 0
        ramp = configured if configured <= 5 else min(configured, 2 + 2 * int(elapsed // 10))
        resources = configured if configured <= 5 else self._resource_capacity(configured)
        recovery = min(configured, backlog, ramp, resources)
        attention = sum(counts.values())
        soft = setting('workers.attention_soft_limit')
        pressure = (configured * max(0, soft - attention) + soft - 1) // soft
        effective = min(recovery, pressure)
        reasons = []
        if pressure < configured:
            reasons.append('Prioritizing resolved applications while the attention backlog drains')
        if backlog < configured:
            reasons.append('Reserving room below the approval and help limits')
        if resources < configured:
            reasons.append('Waiting for CPU or memory capacity')
        if ramp < configured:
            reasons.append('Increasing the worker pool gradually')
        self.data['adaptive'] = {'configured': configured, 'effective': effective,
                                 'resource_limit': resources, 'backlog_limit': backlog, 'ramp_limit': ramp,
                                 'fresh_limit': effective, 'recovery_limit': recovery,
                                 'attention_count': attention, 'attention_soft_limit': soft,
                                 'active': active, 'reason': '; '.join(reasons)}
        return effective

    @staticmethod
    def _recovery_ready(item):
        return bool(item.get('recovery_ready') or item.get('approved_answers'))

    def _free_slot(self, recovery=False):
        busy = {j.get('slot') for j in self.data['jobs'] if j['id'] in self.processes}
        adaptive = self.data.get('adaptive', {})
        total_limit = adaptive.get('recovery_limit', adaptive.get('effective', self.data['parallelism']))
        if len(self.processes) >= min(self.data['parallelism'], total_limit):
            return None
        if not recovery:
            # Recovery work shares the global resource/backlog ceiling, but must
            # not consume the separate allowance for fresh priority applications.
            fresh = sum(j['id'] in self.processes and not (self._recovery_ready(j) or j.get('explicit_next'))
                        for j in self.data['jobs'])
            if fresh >= adaptive.get('fresh_limit', adaptive.get('effective', self.data['parallelism'])):
                return None
        statuses = read(self.directory / 'engine-status.json', {})
        return next((i for i in range(self.data['parallelism']) if i not in busy and
                     statuses.get(self.data['slots'][i], {}).get('status', 'ready') == 'ready'), None)

    def workday_password_set(self):
        # Checks only that he has filled it in; the value is never read into the dashboard.
        try:
            text = (self.agent_dir / 'private/workday.env').read_text()
        except OSError:
            return bool(os.environ.get('WORKDAY_PASSWORD'))
        return bool(re.search(r'^\s*(?:export\s+)?WORKDAY_PASSWORD\s*=\s*["\']?[^\s"\']', text, re.M))

    @staticmethod
    def _is_workday(url):
        return (urlsplit(url or '').hostname or '').endswith('.myworkdayjobs.com')

    def _requeue_after_password(self):
        # Workday roles parked only for the missing password go back in line once it is there.
        if not self.workday_password_set():
            return
        for item in [j for j in self.data['jobs'] if j['status'] == 'blocked' and NO_WORKDAY_PASSWORD in (j.get('message') or '')]:
            try:
                self._resume_from(item['job_id'], {'blocked'})
            except ValueError:
                pass

    def approvals(self):
        with self.lock:
            items = json.loads(json.dumps([j for j in self.data['jobs'] if j['status'] in ATTENTION]))
            suggestions = read(self.directory / 'answer-drafts.json', {})
            learned_notes = read(self.directory / 'writing-drafts.json', {})
            learned = {item['job_id']: item for item in self._answer_memory({'action': 'suggest', 'items': items}) or []}
            for item in items:
                memory = learned.get(item['job_id'], {})
                saved = suggestions.get(str(item['job_id']), {})
                for question in item.get('questions', []):
                    label = question.get('label')
                    if label in memory.get('drafts', {}):
                        question.update(memory['drafts'][label])
                    if label in memory.get('facts', {}):
                        question['draft'] = memory['facts'][label]
                        question['note'] = 'Reused from your confirmed facts or approved answers.'
                    if question.get('label') in saved and not question.get('options'):
                        question['draft'] = saved[question['label']]
                        question.pop('note', None); question.pop('draftSource', None)  # the template draft's note no longer applies
                        learned_note = learned_notes.get(str(item['job_id']), {}).get(question['label'])
                        if learned_note and learned_note.get('draft') == question['draft']:
                            question['note'] = learned_note['note']
                for question in item.get('questions', []):
                    if self.cover_letter_question(question):
                        question['cover_letter'] = True
                if item['status'] == 'needs_resume':
                    item['resume_variants'] = [{k: v.get(k) for k in ('id', 'label', 'focus')} for v in self.resume_library.variants()]
                    try:
                        item['resume_draft'] = self.resume_draft(item['job_id'])
                    except ValueError:
                        item['resume_draft'] = None
                item['screenshot_url'] = f"/api/applications/workers/{item['id']}/screenshot" if (self.directory / item['id'] / 'screenshot.jpg').is_file() else None
            return items

    def _answer_memory(self, payload):
        script = self.agent_dir / 'tools/answer-memory.mjs'
        if not script.is_file():
            return None
        cache_key = None
        if payload.get('action') == 'suggest':
            from .answer_suggestion_cache import AnswerSuggestionCache, suggestion_key
            cache = getattr(self, '_suggestion_cache', None)
            if cache is None:
                cache = self._suggestion_cache = AnswerSuggestionCache()
            cache_key = suggestion_key(payload, self.agent_dir, self.directory)
            cached = cache.get(cache_key)
            if cached is not None:
                return cached
        payload = {**payload, 'profilePath': str(self.agent_dir / 'private/profile.json'),
                   'bankDir': str(self.agent_dir / 'private/companies'), 'runDirectory': str(self.directory)}
        try:
            result = subprocess.run([self._node() or 'node', str(script)], input=json.dumps(payload),
                                    capture_output=True, text=True, timeout=25, cwd=self.agent_dir)
            if result.returncode:
                raise ValueError('Could not save or load reusable answers. Your approval has not been submitted; try again.')
            decoded = json.loads(result.stdout)
            if cache_key is not None:
                cache.put(cache_key, decoded)
            return decoded
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
            raise ValueError('Answer memory is temporarily unavailable; try again.') from exc

    def resolve_known_approvals(self, job_ids=None):
        with self.lock:
            items = [j for j in self.data['jobs'] if j['status'] == 'needs_approval' and (job_ids is None or j['job_id'] in job_ids)]
            suggestions = self._answer_memory({'action': 'suggest', 'items': items}) or []
            resolved = []; blocked = []
            for item in suggestions:
                if not item.get('facts'):
                    continue
                try:
                    result = self.resolve_facts(item['job_id'], item['facts'])
                    resolved.append({'job_id': item['job_id'], **result})
                except ValueError as exc:
                    blocked.append({'job_id': item['job_id'], 'reason': str(exc)})
            return {'resolved': resolved, 'blocked': blocked}

    def save_answer_drafts(self, job_id, drafts):
        """Save suggestions for review without approving answers or resuming a worker."""
        with self.lock:
            item = next((j for j in self.data['jobs'] if j['job_id'] == job_id and j['status'] == 'needs_approval'), None)
            if item is None:
                raise ValueError('This approval is no longer waiting. Refresh the page.')
            questions = {q['label']: q for q in item.get('questions', [])}
            if any(label not in questions or questions[label].get('options') for label in drafts):
                raise ValueError('Drafts must match free-text questions on this approval')
            suggestions = read(self.directory / 'answer-drafts.json', {})
            suggestions.setdefault(str(job_id), {}).update({label: str(value).strip() for label, value in drafts.items()})
            atomic(self.directory / 'answer-drafts.json', suggestions)
            return {'ok': True, 'saved': len(drafts)}

    def _resume_from(self, job_id, statuses, **extra):
        # A parked role goes back to the front of the queue as a fresh run carrying his decisions.
        item = next((j for j in self.data['jobs'] if j['job_id'] == job_id), None)
        if item is None or item['status'] not in statuses or item['id'] in self.processes:
            raise ValueError('This approval is no longer waiting. Refresh the page.')
        # A role stopped for runs without progress is only started again by Try again (his, or a repair's).
        if item.get('progress_capped') and not extra.pop('allow_capped', False):
            raise ValueError(item.get('message') or 'Stopped after runs without progress')
        extra.pop('allow_capped', None)
        fresh = self._item(self._job(job_id))
        if item.get('progress') and 'progress' not in extra:
            fresh['progress'] = item['progress']
        fresh['approved_answers'] = list(item.get('approved_answers', []))
        fresh['recovery_ready'] = bool(fresh['approved_answers'] or (statuses & ATTENTION and not extra.get('retries')))
        fresh['prepare_manually'] = bool(item.get('prepare_manually') or 'Resume parser produced' in item.get('message', ''))
        if 'resume_variant' in item:  # a resumed role uploads the same resume it started with
            fresh['resume_variant'] = item['resume_variant']
        if item.get('documents'):  # and documents approved for it (a cover letter)
            fresh['documents'] = item['documents']
        fresh.update({'source': item.get('source'), 'message': 'Approved. Continuing next.', **extra})
        self.data['jobs'].remove(item)
        first = next((n for n, j in enumerate(self.data['jobs']) if j['status'] == 'queued'), len(self.data['jobs']))
        self.data['jobs'].insert(first, fresh)
        self._save()
        return fresh

    def approve_answers(self, job_id, answers):
        with self.lock:
            item = next((j for j in self.data['jobs'] if j['job_id'] == job_id and j['status'] == 'needs_approval'), None)
            if item is None:
                raise ValueError('This approval is no longer waiting. Refresh the page.')
            questions = {q['label']: q for q in item.get('questions', [])}
            answers = {k: str(v).strip() for k, v in (answers or {}).items()}
            if not set(answers) <= set(questions):
                raise ValueError('Answers must match the questions on this approval')
            missing = [label for label, q in questions.items() if q.get('required') and not answers.get(label)]
            if missing:
                raise ValueError(f'Answer every required question: {missing[0]}')
            options = {label: q['options'] for label, q in questions.items() if q.get('options')}
            wrong = [label for label, value in answers.items() if value and label in options and value not in options[label]]
            if wrong:
                raise ValueError(f'Choose one of the listed options for: {wrong[0]}')
            if any(re.fullmatch(r'(?:select(?: one| an? (?:answer|option))?|please select(?: one)?|choose an? (?:answer|option))[.\s…]*', value, re.I) for value in answers.values()):
                raise ValueError('Choose a real answer; a placeholder cannot be approved')
            self._job(job_id)
            shown = self._shown_drafts(item)
            approved_now = [{'question': label, 'answer': value, 'type': questions[label].get('type'), 'approvedAt': now(),
                             **({'draft': shown[label]} if shown.get(label) else {})}
                            for label, value in answers.items() if value]
            try:  # his edits teach future drafts; a logging failure never blocks the approval
                self.writing.record(item, approved_now)
            except OSError:
                pass
            memory = self._answer_memory({'action': 'learn', 'company': item['company'], 'jobId': str(job_id), 'approvals': approved_now})
            approved = {a['question']: a for a in item.get('approved_answers', [])}
            approved.update({a['question']: a for a in approved_now})
            item['approved_answers'] = list(approved.values())
            letters = [label for label in answers if answers[label] and self.cover_letter_question(questions[label])]
            if letters:  # an approved letter is uploaded as a PDF under his resume's letterhead
                item['documents'] = {**item.get('documents', {}), 'coverLetter': str(self._write_cover_letter(job_id, answers[letters[0]]))}
            resumed = self._share_answers(item, answers, set(memory['sharedQuestions']) if memory and 'sharedQuestions' in memory else None)
            self._resume_from(job_id, {'needs_approval'})  # last, so it runs first
            return {'ok': True, 'also_resumed': resumed}

    def _shown_drafts(self, item):
        """The drafts the Approvals page showed for this item, as approvals() builds them."""
        try:
            shown = {}
            suggested = self._answer_memory({'action': 'suggest', 'items': [json.loads(json.dumps(item))]})
            memory = suggested[0] if isinstance(suggested, list) and suggested and isinstance(suggested[0], dict) else {}
            for label, d in (memory.get('drafts') or {}).items():
                shown[label] = d.get('draft') if isinstance(d, dict) else d
            shown.update(read(self.directory / 'answer-drafts.json', {}).get(str(item['job_id']), {}))
            return {k: v for k, v in shown.items() if isinstance(v, str)}
        except Exception:  # capturing the draft must never block his approval
            return {}

    def _draft_writing(self):
        """Draft each newly parked written question once with the learned style (one model call at a time)."""
        if not setting('workers.learned_drafts') or self.writing.drafting:
            return
        saved = read(self.directory / 'answer-drafts.json', {})
        tried = read(self.directory / 'writing-drafts.json', {})
        for item in self.data['jobs']:
            if item['status'] != 'needs_approval':
                continue
            done = tried.get(str(item['job_id']), {})
            todo = [q for q in item.get('questions', []) if is_writing(q) and q['label'] not in saved.get(str(item['job_id']), {})
                    and q['label'] not in done]
            if not todo:
                continue
            self.writing.drafting.add(item['job_id'])
            self._spawn(self._draft_writing_for, dict(item), todo)
            return

    @staticmethod
    def _spawn(target, *args):
        threading.Thread(target=target, args=args, daemon=True, name=getattr(target, '__name__', 'runner-task')).start()

    def _draft_writing_for(self, item, questions):
        job_id = item['job_id']
        try:
            try:
                job = {**self._job(job_id), 'job_id': job_id}
                profile = read(self.agent_dir / 'private/profile.json', {})
                template = ''
                if any(self.cover_letter_question(q) for q in questions):
                    template = '\n\n'.join(p.read_text() for p in (self.agent_dir / 'docs/cover-letter-template.md', self.agent_dir / 'private/cover-letter-base.md') if p.is_file())
                drafts = self.writing.draft(job, questions, profile, self.agent_dir / 'private/companies', template)
            except Exception as exc:
                drafts, error = {}, str(exc)[:200]
            else:
                error = None
            with self.lock:
                saved = read(self.directory / 'answer-drafts.json', {})
                tried = read(self.directory / 'writing-drafts.json', {})
                mine = saved.setdefault(str(job_id), {})
                notes = tried.setdefault(str(job_id), {})
                waiting = next((j for j in self.data['jobs'] if j['job_id'] == job_id and j['status'] == 'needs_approval'), None)
                for q in questions:
                    d = drafts.get(q['label'])
                    if d and waiting and q['label'] not in mine:  # never replace a draft someone saved meanwhile
                        mine[q['label']] = d['draft']
                    notes[q['label']] = {**(d or {}), 'at': now(), **({'error': error} if error else {})}
                atomic(self.directory / 'answer-drafts.json', saved)
                atomic(self.directory / 'writing-drafts.json', tried)
        finally:
            self.writing.drafting.discard(job_id)

    @staticmethod
    def cover_letter_question(question):
        """A cover-letter upload parked for his text (Greenhouse 'Cover Letter* (Attach)'), not a typed question."""
        label = question.get('label') or ''
        return bool(re.search(r'cover\s*letter', label, re.I)) and bool(
            re.search(r'\battach\b', label, re.I) or str(question.get('approvalReason', '')).startswith('Required upload'))

    def cover_letter_pdf(self, text):
        header = self.resume_library.structure(self._resume()) or {'name': identity.candidate_name().upper(), 'contact': [], 'sections': [{'title': 'X'}]}
        return resume_doc.render_cover_letter(header, text, datetime.now().strftime('%B %-d, %Y'))

    def _write_cover_letter(self, job_id, text):
        path = self.agent_dir / 'private/cover-letters' / str(job_id) / identity.cover_letter_filename()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_bytes(self.cover_letter_pdf(text))
        return path

    def resolve_facts(self, job_id, answers):
        """Record supported factual answers while leaving prose and unknowns for review."""
        with self.lock:
            item = next((j for j in self.data['jobs'] if j['job_id'] == job_id and j['status'] == 'needs_approval'), None)
            if item is None:
                raise ValueError('This approval is no longer waiting. Refresh the page.')
            questions = {q['label']: q for q in item.get('questions', [])}
            answers = {label: str(answer).strip() for label, answer in answers.items() if str(answer).strip()}
            if any(re.fullmatch(r'(?:select(?: one| an? (?:answer|option))?|please select(?: one)?|choose an? (?:answer|option))[.\s…]*', answer, re.I) for answer in answers.values()):
                raise ValueError('A placeholder is not a confirmed factual answer')
            def factual_textarea(label):
                return bool(re.fullmatch(r'(?:Which company are you currently employed with|In which city and state are you located|(?:please (?:provide|enter|list) your |what is your )?(?:current |home |mailing )?(?:street )?address|Please state your name and current date in the box below)[.?*\s]*', label, re.I))
            if any(label not in questions or questions[label].get('type') == 'textarea' and not factual_textarea(label) for label in answers):
                raise ValueError('Only factual questions on this approval can be resolved')
            if any(questions[label].get('options') and answer not in questions[label]['options'] for label, answer in answers.items()):
                raise ValueError('Choose one of the listed options')
            if questions and all(label in answers for label in questions):
                self._job(job_id)  # Validate before modifying a stale or already-submitted card.
            approved = {a['question']: a for a in item.get('approved_answers', [])}
            approved.update({label: {'question': label, 'answer': answer} for label, answer in answers.items()})
            item['approved_answers'] = list(approved.values())
            item['questions'] = [q for q in item.get('questions', []) if q['label'] not in answers]
            resumed = not item['questions']
            if resumed:
                self._resume_from(job_id, {'needs_approval'}, message='Known factual answers resolved. Continuing next.')
            else:
                item['message'] = f'{len(answers)} known factual answer(s) resolved; {len(item["questions"])} question(s) still need your input.'
                self._save()
            return {'ok': True, 'resolved': len(answers), 'resumed': resumed}

    def _share_answers(self, source, answers, shareable_labels=None):
        """Other applications parked on the same question get his answer and go back in the queue.

        Only answers that are not about the employer he answered for are shared (the same rule
        application-agent uses to learn them for every employer); the rerun parks again with just
        the questions that are still open, if any.
        """
        source_questions = {q['label']: q for q in source.get('questions', [])}
        shared = {question_key(label): value for label, value in answers.items()
                  if value and len(value) <= 150 and '\n' not in value
                  and source_questions.get(label, {}).get('type') != 'textarea'
                  and (shareable_labels is None or label in shareable_labels)
                  and not re.search(r'know (?:anyone|someone|people)|friends?|relatives?|family|personal connections?|referred|referral', label, re.I)
                  and not names_company(f'{label} {value}', source['company'])}
        resumed = []
        for other in [j for j in self.data['jobs'] if j['status'] == 'needs_approval' and j is not source]:
            matched = {q['label']: shared[question_key(q['label'])] for q in other.get('questions', [])
                       if question_key(q['label']) in shared and not names_company(q['label'], other['company'])}
            if not matched:
                continue
            options = {q['label']: q.get('options') for q in other.get('questions', [])}
            matched = {label: value for label, value in matched.items() if not options.get(label) or value in options[label]}
            if not matched:
                continue
            approved = {a['question']: a for a in other.get('approved_answers', [])}
            approved.update({label: {'question': label, 'answer': value} for label, value in matched.items()})
            other['approved_answers'] = list(approved.values())
            try:
                self._resume_from(other['job_id'], {'needs_approval'}, message='Resumed with an answer you gave for another application')
                resumed.append(other['job_id'])
            except ValueError:
                pass
        return resumed

    def recheck_approvals(self, job_ids=None):
        """Send every application waiting on questions back through with everything learned since."""
        with self.lock:
            waiting = [j['job_id'] for j in self.data['jobs'] if j['status'] == 'needs_approval' and j['id'] not in self.processes and (job_ids is None or j['job_id'] in job_ids)]
            resumed = 0
            for job_id in waiting:
                try:
                    self._resume_from(job_id, {'needs_approval'}, message='Rechecking with answers learned since it was flagged')
                    resumed += 1
                except ValueError:
                    pass
            return {'resumed': resumed}

    def _auto_submit_ready(self):
        """His rule (2026-10-18): no manual Approve & submit. A validated form waiting at
        ready_to_submit is submitted once, exactly as reviewed (its digest), when auto-submit is on."""
        if not setting('workers.auto_submit'):
            return
        for item in list(self.data['jobs']):
            if item['status'] != 'ready_to_submit' or item['id'] in self.processes:
                continue
            try:
                self._resume_from(item['job_id'], {'ready_to_submit'}, submit=True,
                                  approved_digest=(item.get('review') or {}).get('digest'),
                                  message='Submitting automatically under your standing authorization')
            except ValueError:
                pass

    def approve_submit(self, job_id, review_id=None):
        with self.lock:
            item = next((j for j in self.data['jobs'] if j['job_id'] == job_id and j['status'] == 'ready_to_submit'), None)
            review = (item or {}).get('review') or {}
            if review and review.get('id') != review_id:
                raise ValueError('This review changed. Refresh the page and check it again.')
            self._resume_from(job_id, {'ready_to_submit'}, submit=True, approved_digest=review.get('digest'))
            return {'ok': True}

    def verify(self, job_id, link):
        parts = urlsplit(str(link).strip())
        if parts.scheme != 'https' or not (parts.hostname or '').endswith('.myworkdayjobs.com'):
            raise ValueError('Paste the https://….myworkdayjobs.com link from the Workday email')
        with self.lock:
            self._resume_from(job_id, {'needs_verification'}, verify_link=parts.geturl())
            return {'ok': True}

    def hold_for_user(self, job_id, message):
        """Park a role on Help with what only he can do; no automatic retry or repair agent touches it
        until he (or a Retry) releases it. Never used on a role with uncertain submission evidence."""
        message = str(message or '').strip()
        if not message:
            raise ValueError(f'Say what {identity.first_name()} needs to do')
        with self.lock:
            item = next((j for j in self.data['jobs'] if j['job_id'] == job_id), None)
            if item is None or item['id'] in self.processes:
                raise ValueError('This role is running or not in the queue')
            if item['status'] in {'completed', 'submitted', 'submission_unknown', 'submitted_pending_receipt'}:
                raise ValueError('A submitted or uncertain application cannot be put on hold')
            item.update(status='needs_human', phase='human', held_for_user=True, message=f'Waiting on {identity.first_name()}: {message}',
                        updated_at=now(), questions=[], review=None)
            self._save()
            return {'ok': True}

    def retry_parked(self, job_id, by_user=False):
        """Try again. His (from the dashboard) starts the runs-without-progress count over; a repair agent's
        gets one more run that must show progress."""
        with self.lock:
            # A verification retry reruns the role, which reads the emailed link from his mailbox itself.
            self._resume_from(job_id, {'blocked', 'needs_human', 'interrupted', 'failed', 'needs_verification'}, allow_capped=True,
                              **({'progress': None} if by_user else {}))
            return {'ok': True}

    @staticmethod
    def _posting_key(url):
        parts = urlsplit(url or '')
        host = parts.hostname or ''
        if host == 'boards.greenhouse.io':
            host = 'job-boards.greenhouse.io'
        path = parts.path.rstrip('/')
        path = re.sub(r'/(?:application|apply)$', '', path)
        if host == 'job-boards.greenhouse.io' and re.fullmatch(r'/[^/]+/jobs/\d+', path):
            return host, path
        if host in {'jobs.ashbyhq.com', 'jobs.lever.co'} and re.fullmatch(r'/[^/]+/[a-f0-9-]{36}', path):
            return host, path
        return None

    def reconcile_help(self, job_ids=None):
        """Resolve current-search conflicts, exact rediscoveries and verified outcomes."""
        with self.lock:
            items = [j for j in self.data['jobs'] if j['status'] in HELP | {'submitted_pending_receipt'} and j['id'] not in self.processes and not j.get('held_for_user') and (job_ids is None or j['job_id'] in job_ids)]
            audit = []
            for item in items:
                request = read(self.directory / item['id'] / 'request.json', {})
                durable = read(self.agent_dir / 'state' / f"jobagent-{item['job_id']}.json", {})
                job = {**request.get('job', {}), 'company': item['company'], 'title': item['title'],
                       'url': durable.get('canonicalUrl') or request.get('job', {}).get('url') or item.get('url')}
                audit.append({'job_id': item['job_id'], 'job': job, 'durable': durable})
            script = self.agent_dir / 'tools/reconcile-help.mjs'
            evidence = {}
            if script.is_file():
                response = subprocess.run([self._node() or 'node', str(script)],
                    input=json.dumps({'items': audit, 'receiptFile': str(self.directory / 'recovered-receipts.json')}),
                    capture_output=True, text=True, timeout=25, cwd=self.agent_dir)
                if response.returncode:
                    raise ValueError('Help evidence could not be checked; no postings were changed')
                evidence = {a['job_id']: a for a in json.loads(response.stdout)}
            result = {'completed': [], 'linked': [], 'skipped': [], 'requeued': [], 'remaining': []}
            posting_evidence = read(self.directory / 'help-posting-evidence.json', {})
            with self.sessions() as session:
                rows = session.query(Job.id, Job.canonical_url, Job.application_url).all()
            index = {}
            for job_id, canonical, application in rows:
                for url in (canonical, application):
                    key = self._posting_key(url)
                    if key:
                        index.setdefault(key, set()).add(job_id)
            for item, inspected in zip(items, audit):
                job_id = item['job_id']; proof = evidence.get(job_id, {})
                receipt = proof.get('receipt')
                if receipt:
                    atomic(self.agent_dir / 'state' / f'jobagent-{job_id}.json',
                           {**inspected['durable'], 'status': 'submitted', 'company': item['company'],
                            'canonicalUrl': inspected['job']['url'], 'receiptSource': 'mailbox',
                            'receiptEvidence': receipt, 'updatedAt': now()})
                    state = read(self.directory / item['id'] / 'state.json', {})
                    state.update(status='completed', phase='completed', submitted=True, submission_attempted=True,
                                 receipt=receipt, receiptSource='mailbox', updated_at=now(),
                                 message='Existing employer receipt verified; no new application was submitted')
                    atomic(self.directory / item['id'] / 'state.json', state)
                    item.update(state)
                    self._refresh(item)  # Also preserve application tracking for this receipt.
                    with self.sessions() as session:
                        job = session.get(Job, job_id)
                        if job and value(job.status) in {'NEW', 'ACTIVE', 'SAVED'}:
                            JobRepository(session).record_application(job_id, notes='Existing employer receipt verified during recovery.')
                            session.commit()
                    item['recorded'] = True
                    result['completed'].append(job_id)
                    continue
                if item['status'] == 'submitted_pending_receipt' and not proof.get('verificationNotAccepted'):
                    # A changed search filter or missing mail cannot resolve an
                    # already attempted submission. Keep its duplicate guard.
                    result['remaining'].append(job_id)
                    continue
                checked = posting_evidence.get(str(job_id), {})
                if (checked.get('resolution') in {'unavailable', 'outside_search'} and checked.get('checked_at') and
                    self._posting_key(checked.get('posting_url')) and
                    self._posting_key(checked.get('posting_url')) == self._posting_key(inspected['job']['url'])):
                    item.update(status='skipped', phase='skipped', updated_at=now(),
                                posting_evidence=checked, message='Resolved: ' + checked['reason'])
                    result['skipped'].append(job_id)
                    continue
                with self.sessions() as session:
                    job = session.get(Job, job_id)
                    status = value(job.status) if job else None
                    fit = value(job.eligibility) if job else None
                    # His own fit label overrides the rules here as it does when queueing.
                    if job and (per_track(job.user_fit_label, active_track()) or {}).get('fit') is True:
                        fit = 'ELIGIBLE'
                    role_type = job.role_type if job else None
                if not job:
                    from ..processing.qualifications import off_discipline_title
                    source = read(self.directory / item['id'] / 'request.json', {}).get('job', {})
                    mismatch = off_discipline_title(item['title'], source.get('description', ''))
                    if mismatch or re.search(r'\bkernel engineer\b', item['title'], re.I):
                        item.update(status='skipped', phase='skipped', updated_at=now(),
                                    message='Resolved: this older posting is outside the current search. History preserved.')
                        result['skipped'].append(job_id)
                        continue
                # His rule (2026-10-18): never drop a role that is not verified submitted just because
                # the rules now rate it differently; only a posting he or the employer closed leaves.
                if job and status in {'CLOSED', 'IGNORED', 'REJECTED', 'WITHDRAWN'}:
                    item.update(status='skipped', phase='skipped', updated_at=now(),
                                message=f'Resolved: outside the current search or unavailable ({status}, {fit}). Application history preserved.')
                    result['skipped'].append(job_id)
                    continue
                key = self._posting_key(inspected['job']['url'])
                candidates = index.get(key, set()) - {job_id} if key else set()
                if not job and len(candidates) == 1:
                    target = next(iter(candidates))
                    if item.get('approved_answers'):
                        self._answer_memory({'action': 'learn', 'company': item['company'], 'jobId': str(job_id),
                                             'approvals': item['approved_answers']})
                    existing = next((j for j in self.data['jobs'] if j['job_id'] == target), None)
                    if not existing:
                        try:
                            self.queue([target])
                        except ValueError:
                            result['remaining'].append(job_id); continue
                    item.update(status='skipped', phase='skipped', resolved_to_job_id=target, updated_at=now(),
                                message=f'Resolved: this exact employer posting is tracked as job {target}. History and approved answers preserved.')
                    result['linked'].append({'job_id': job_id, 'current_job_id': target})
                    continue
                if proof.get('verificationNotAccepted') and job and status in {'NEW', 'ACTIVE', 'SAVED'}:
                    if item.get('auto_retry_declined'):
                        result['remaining'].append(job_id)
                        continue
                    archive = self.agent_dir / 'state/archive'
                    earlier = list(archive.glob(f'jobagent-{job_id}-not-accepted-*.json'))
                    rejection = inspected['durable'].get('rejection') or {}
                    atomic(archive / f'jobagent-{job_id}-not-accepted-{uuid.uuid4()}.json', inspected['durable'])
                    atomic(self.agent_dir / 'state' / f'jobagent-{job_id}.json',
                           {**inspected['durable'], 'status': 'verification_not_accepted', 'reconciledAt': now(),
                            'reconciliationEvidence': proof.get('verificationEvidence') or 'Worker explicitly recorded verification_not_accepted'})
                    for archived in self.data.get('dismissed_items', []):
                        if archived['job_id'] == job_id and archived['id'] == item['id'] and not archived.get('submitted'):
                            archived.update(submission_resolution='not_accepted', submission_reconciled_at=now())
                    item.update(submission_resolution='not_accepted', submission_attempted=False, submitted=False)
                    # A spam/risk-score flag is a human-verification boundary: a headless retry is flagged
                    # again and every attempt adds spam signal (1X, 2026-10-22: four runs in three minutes).
                    # Any other explicit rejection gets one automatic retry; a second one waits for him.
                    if rejection.get('outcome') == 'flagged_spam' or earlier:
                        item.update(auto_retry_declined=True, updated_at=now())
                        result['remaining'].append(job_id)
                        continue
                    try:
                        self._resume_from(job_id, HELP | {'submitted_pending_receipt'}, message='Employer explicitly rejected the previous submission; safely retrying with the current worker')
                        result['requeued'].append(job_id)
                        continue
                    except ValueError:
                        pass
                if item.get('submission_attempted') and inspected['durable'].get('status') in {'needs_human_verification', 'awaiting_human_submit', 'awaiting_verification_code'}:
                    path = self.directory / item['id'] / 'state.json'
                    original = read(path, {})
                    backup = path.with_name('state-before-verification-reconciliation.json')
                    if not backup.exists():
                        atomic(backup, original)
                    state = {**original, 'status': 'needs_human', 'phase': 'verification',
                             'submission_attempted': True, 'submitted': False, 'updated_at': now(),
                             'message': 'Employer verification is still unresolved; no acceptance receipt has been found. Check or complete the employer verification before retrying. Receipt monitoring remains active.'}
                    atomic(path, state)
                    item.update(state)
                result['remaining'].append(job_id)
            self._save()
            return result

    def _fresh_cleared_item(self, item):
        if item['status'] == 'submission_unknown' or item.get('submitted') or item.get('submission_attempted'):
            raise ValueError('Submission must be reconciled before retrying')
        fresh = self._item(self._job(item['job_id']))
        fresh['approved_answers'] = list(item.get('approved_answers', []))
        fresh['message'] = 'Returned to queue from ' + item.get('dismissed_from', 'attention list')
        fresh['source'] = 'cleared'
        return fresh

    def clear_attention(self, category, ids):
        statuses = ATTENTION if category == 'approvals' else HELP if category == 'help' else None
        if statuses is None:
            raise ValueError('Unknown list')
        with self.lock:
            selected = [j for j in self.data['jobs'] if j['id'] in ids and j['status'] in statuses]
            cleared = 0; active = 0; blocked = []
            archive = self.data.setdefault('dismissed_items', [])
            for item in selected:
                if item['id'] in self.processes:
                    active += 1
                    continue
                if category == 'help':
                    # His request (2026-11-14): Clear list on Needs help removes the postings outright,
                    # like the per-posting Dismiss, instead of sending them back to the queue.
                    if item['status'] == 'submission_unknown' or item.get('submitted') or item.get('submission_attempted'):
                        blocked.append({'job_id': item['job_id'], 'reason': 'Submission must be reconciled before clearing in bulk'})
                        continue
                    archive.append({**item, 'dismissed_at': now(), 'dismissed_from': category, 'individual_clear': True})
                    self.data['jobs'].remove(item)
                    if item['job_id'] not in self.data['skipped']:
                        self.data['skipped'].append(item['job_id'])
                    cleared += 1
                    continue
                if item['status'] == 'needs_resume':  # clearing a resume card means: go ahead with the standing resume
                    self._record_resume_decision(item['job_id'], {'choice': 'current', 'decided_at': now(), 'via': 'clear'})
                try:
                    fresh = self._fresh_cleared_item(item)
                except ValueError as exc:
                    if str(exc) == f"Job {item['job_id']} was not found":
                        archive.append({**item, 'dismissed_at': now(), 'dismissed_from': category,
                                        'individual_clear': True, 'clear_reason': str(exc)})
                        self.data['jobs'].remove(item)
                        cleared += 1
                        continue
                    blocked.append({'job_id': item['job_id'], 'reason': str(exc)})
                    continue
                archive.append({**item, 'dismissed_at': now(), 'dismissed_from': category, 'requeued_at': now()})
                self.data['jobs'].remove(item)
                self.data['jobs'].append(fresh)
                self.data['skipped'] = [i for i in self.data['skipped'] if i != item['job_id']]
                cleared += 1
            self._save()
            return {'cleared': cleared, 'active_remaining': active, 'blocked_remaining': len(blocked), 'blocked': blocked}

    def restore_cleared(self):
        with self.lock:
            restored = 0; blocked = []
            present = {j['job_id'] for j in self.data['jobs']}
            for item in self.data.get('dismissed_items', []):
                if item.get('individual_clear') or item.get('requeued_at') or item['job_id'] in present:
                    continue
                try:
                    fresh = self._fresh_cleared_item(item)
                except ValueError as exc:
                    blocked.append({'job_id': item['job_id'], 'reason': str(exc)})
                    continue
                self.data['jobs'].append(fresh); present.add(item['job_id'])
                self.data['skipped'] = [i for i in self.data['skipped'] if i != item['job_id']]
                item['requeued_at'] = now(); restored += 1
            self._save()
            return {'restored': restored, 'blocked': blocked}

    def set_agent_engine(self, job_id, engine, model=None):
        """His per-posting choice of engine and model for this posting's Help agent and its next runs."""
        if engine not in ENGINES:
            raise ValueError('Engine must be claude or codex')
        if model is not None and model not in AGENT_MODELS.get(engine, ()):
            raise ValueError(f'Unknown {ENGINES[engine]} model: {model}')
        with self.lock:
            item = next((j for j in self.data['jobs'] if j['job_id'] == job_id), None)
            if item is None:
                raise ValueError('This posting is no longer in the application agent')
            item['agent_engine'] = engine
            if model:
                item['agent_model'] = model
            else:
                item.pop('agent_model', None)
            self._save()
        return {'ok': True, 'job_id': job_id, 'agent_engine': engine, 'agent_model': model}

    def clear_cooldown(self, company):
        """His request (2026-11-10, Tesla): end a company's site cooldown now, so its queued roles start at once."""
        with self.lock:
            key = str(company or '').strip().casefold()
            cleared = self.data.get('cooling', {}).pop(key, None) is not None
            for item in self.data['jobs']:
                if item['status'] == 'queued' and str(item.get('company') or '').casefold() == key and item.get('not_before'):
                    item.pop('not_before', None)
                    item.update(cooldowns=0, message='Waiting to start')
                    cleared = True
            if not cleared:
                raise ValueError('No cooldown is running for that company')
            self._save()
            return {'ok': True}

    def dismiss_recent(self, job_id=None):
        """His request (2026-11-10): take one finished run, or all of them (job_id None), off the Recent list.
        Only the listing changes: the run, its evidence, receipt checks and Help/Approvals items are untouched,
        and a later run of the same posting is listed again."""
        with self.lock:
            runs = [j['id'] for j in self.data['jobs'] if j['status'] in RECENT and j['id'] not in self.processes
                    and (job_id is None or j['job_id'] == job_id)]
            if job_id is not None and not runs:
                raise ValueError('This posting is not in Recent')
            present = {j['id'] for j in self.data['jobs']}
            hidden = [i for i in self.data.get('recent_hidden') or [] if i in present]
            added = [i for i in runs if i not in hidden]
            self.data['recent_hidden'] = hidden + added
            self._save()
            return {'ok': True, 'dismissed': len(added)}

    def dismiss(self, job_id):
        # Keeps the role off autoplay too; it can still be queued by hand later.
        with self.lock:
            item = next((j for j in self.data['jobs'] if j['job_id'] == job_id and j['status'] in PARKED | HELP and j['id'] not in self.processes), None)
            if item is None:
                raise ValueError('Only parked approvals can be dismissed')
            self.data.setdefault('dismissed_items', []).append({**item, 'dismissed_at': now(), 'individual_clear': True})
            self.data['jobs'].remove(item)
            if job_id not in self.data['skipped']:
                self.data['skipped'].append(job_id)
            self._save()
            return {'ok': True}

    def restore_dismissed(self):
        """Explicitly recover individual dismissals without losing submission safeguards."""
        with self.lock:
            result = {'queued': [], 'attention': [], 'already_present': []}
            present = {j['job_id']: j for j in self.data['jobs']}
            for archived in self.data.get('dismissed_items', []):
                if not archived.get('individual_clear') or archived.get('recovered_at'):
                    continue
                job_id = archived['job_id']
                current = present.get(job_id)
                if current is not None:
                    approved = {a['question']: a for a in archived.get('approved_answers', [])}
                    approved.update({a['question']: a for a in current.get('approved_answers', [])})
                    if approved:
                        current['approved_answers'] = list(approved.values())
                    result['already_present'].append(job_id)
                else:
                    durable = read(self.agent_dir / 'state' / f'jobagent-{job_id}.json', {})
                    uncertain = (archived.get('submission_attempted') or archived.get('submitted') or
                                 archived['status'] == 'submission_unknown' or
                                 durable.get('submission_attempted') or durable.get('submitted') or
                                 durable.get('status') in {'submitted', 'submitted_pending_receipt', 'submitting',
                                     'submission_unknown', 'needs_human_verification', 'awaiting_verification_code', 'awaiting_human_submit'})
                    try:
                        if uncertain:
                            raise ValueError('Existing submission or verification must be reconciled before retrying')
                        fresh = self._fresh_cleared_item(archived)
                    except ValueError as exc:
                        # Keep the run ID so screenshots, chat and receipt checks survive.
                        fresh = {**archived, 'status': 'needs_human', 'phase': 'needs_human',
                                 'recovery_hold': True, 'recovery_reason': str(exc), 'updated_at': now()}
                        if uncertain:
                            fresh['submission_attempted'] = True
                        fresh['message'] = 'Recovered from individual dismissal. ' + str(exc) + '. Previous issue: ' + archived.get('message', '')
                        for key in ('dismissed_at', 'dismissed_from', 'individual_clear', 'clear_reason', 'requeued_at'):
                            fresh.pop(key, None)
                        result['attention'].append(job_id)
                    else:
                        fresh['source'] = 'recovered_dismissal'
                        fresh['message'] = 'Recovered from individual dismissal; waiting to apply'
                        result['queued'].append(job_id)
                    self.data['jobs'].append(fresh)
                    present[job_id] = fresh
                self.data['skipped'] = [i for i in self.data['skipped'] if i != job_id]
                archived['recovered_at'] = now()
            self._save()
            return result

    @staticmethod
    def _resume_tailoring():
        return setting('workers.resume_tailoring')

    def _resume_reviews(self):
        return read(self.directory / 'resume-reviews.json', {})

    def _store_resume_review(self, job_id, result):
        with self.lock:
            reviews = self._resume_reviews()
            reviews[str(job_id)] = {**reviews.get(str(job_id), {}), **result}
            atomic(self.directory / 'resume-reviews.json', reviews)

    def _record_resume_decision(self, job_id, decision):
        reviews = self._resume_reviews()
        reviews.setdefault(str(job_id), {})['decision'] = decision
        atomic(self.directory / 'resume-reviews.json', reviews)

    def _resume_for(self, item):
        # A tailored copy he approved, else the standing resume (also when a chosen copy has since been removed).
        chosen = item.get('resume_variant') and self.resume_library.path(item['resume_variant'])
        return chosen or self._resume()

    def _resume_inputs(self, job_id):
        def inputs():
            job = self._job(job_id)
            library = self.resume_library
            base = library.structure(self._resume())
            if not base:
                raise RuntimeError('The standing resume is not in the layout the tailoring renderer prints')
            variants = [{**v, 'resume': library.structure(library.dir / v['id'] / library.filename)} for v in library.variants()]
            older = [library.text(p) for p in library.archived()]
            profile = read(self.agent_dir / 'private/profile.json', {})
            return job, base, [v for v in variants if v['resume']], older, profile_experience(profile), library.kept()
        return inputs

    def _resume_gate(self, item):
        """Hold a role until its resume is settled: the standing one, an approved tailored copy that suits the posting,
        or his decision on a tailored draft on Approvals. Returns True when the role must not start."""
        if 'resume_variant' in item or not self._resume_tailoring():
            return False
        entry = self._resume_reviews().get(str(item['job_id'])) or {}
        decision = entry.get('decision')
        if decision:
            item['resume_variant'] = decision.get('variant_id') if decision.get('choice') == 'variant' else None
            return False
        if 'verdict' not in entry:
            if item.get('submit') or item.get('approved_answers'):
                return False  # a role already under way when this check arrived keeps the standing resume
            if self.resume_reviewer.start(item['job_id'], self._resume_inputs(item['job_id'])):
                item['message'] = 'Tailoring your resume to this posting'
            return True
        if entry['verdict'] == 'variant' and self.resume_library.path(entry.get('variant_id')):
            item['resume_variant'] = entry['variant_id']
            return False
        if entry['verdict'] != 'tailor' or not entry.get('draft'):
            item['resume_variant'] = None
            return False
        if not setting('workers.resume_tailoring_approval'):
            return self._auto_approve_resume(item, entry)
        item.update(status='needs_resume', phase='needs_resume', updated_at=now(),
                    resume_review={k: entry.get(k) for k in ('focus', 'summary', 'keywords', 'verify', 'base_coverage')},
                    message=f"Tailored resume drafted for {entry.get('focus') or 'this posting'}. Review, edit if needed, and approve it before this application is submitted.")
        return True

    def _auto_approve_resume(self, item, entry):
        """He no longer reviews tailored resumes (2026-10-23): a draft that fits one page is used as drafted; one that
        runs over falls back to the standing resume. Returns False: the role starts."""
        draft, focus = entry['draft'], entry.get('focus') or 'Tailored'
        if resume_doc.fit(draft)['fits']:
            label = re.sub(r'\s+', ' ', focus).strip()[:80].rstrip(' ,;&') or 'Tailored'
            variant_id = self.resume_library.add(label, focus, resume_doc.render_pdf(draft), item['job_id'], structure=draft)
            decision = {'choice': 'variant', 'variant_id': variant_id, 'decided_at': now(), 'via': 'automatic'}
        else:
            variant_id, decision = None, {'choice': 'current', 'variant_id': None, 'decided_at': now(), 'via': 'automatic: draft ran past one page'}
        self._record_resume_decision(item['job_id'], decision)
        item['resume_variant'] = variant_id
        return False

    def _resume_label(self, item):
        variant = item.get('resume_variant')
        found = next((v for v in self.resume_library.variants() if v['id'] == variant), None) if variant else None
        return f"Tailored: {found['label']}" if found else 'Standing resume'

    def _snapshot_documents(self, item):
        """Keep the exact files this application uploads with the posting, so he knows which resume an employer saw
        (his request, 2026-10-23): private/applications/<job>/ holds the resume, any cover letter, and sent.json."""
        import hashlib
        folder = self.agent_dir / 'private/applications' / str(item['job_id'])
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        resume = Path(self._resume_for(item))
        shutil.copy2(resume, folder / identity.resume_filename())
        sent = {'job_id': item['job_id'], 'company': item.get('company'), 'title': item.get('title'), 'run': item['id'], 'at': now(),
                'resume_label': self._resume_label(item), 'resume_variant': item.get('resume_variant'), 'resume_source': str(resume),
                'resume_sha256': hashlib.sha256(resume.read_bytes()).hexdigest()}
        structure = resume.parent / 'resume.json'
        if item.get('resume_variant') and structure.is_file():
            shutil.copy2(structure, folder / 'resume.json')
        letter = (item.get('documents') or {}).get('coverLetter')
        if letter and Path(letter).is_file():
            shutil.copy2(letter, folder / identity.cover_letter_filename())
            sent['cover_letter'] = str(folder / identity.cover_letter_filename())
        atomic(folder / 'sent.json', sent)
        item['sent_documents'] = str(folder)

    def _record_sent_documents(self):
        """Point each recorded application at the resume (and cover letter) its run uploaded."""
        from ..db.models import Application
        pending = [j for j in self.data['jobs'] if j.get('sent_documents') and not j.get('sent_recorded')
                   and (j.get('submitted') or j.get('recorded') or j['status'] in {'submitted', 'completed', 'submitted_pending_receipt'})]
        if not pending:
            return
        with self.sessions() as session:
            for item in pending:
                app = session.query(Application).filter_by(job_id=item['job_id']).first()
                if app is None:
                    continue  # recorded when the application is; checked again next tick
                sent = read(Path(item['sent_documents']) / 'sent.json', {})
                app.resume_path = str(Path(item['sent_documents']) / identity.resume_filename())
                app.resume_version = sent.get('resume_label') or 'Standing resume'
                if sent.get('cover_letter'):
                    app.cover_letter_path = sent['cover_letter']
                item['sent_recorded'] = True
            session.commit()

    def sent_resume(self, job_id):
        path = self.agent_dir / 'private/applications' / str(job_id) / identity.resume_filename()
        if not path.is_file():
            raise ValueError('No resume is recorded for this posting')
        return path

    def _waiting_resume(self, job_id):
        item = next((j for j in self.data['jobs'] if j['job_id'] == job_id and j['status'] == 'needs_resume'), None)
        if item is None:
            raise ValueError('This resume is no longer waiting. Refresh the page.')
        draft = (self._resume_reviews().get(str(job_id)) or {}).get('draft')
        if not draft:
            raise ValueError('This role has no tailored draft')
        return item, draft

    def resume_draft(self, job_id):
        """The draft for the editor, with whether it fits one page and which posting keywords it carries."""
        with self.lock:
            item, draft = self._waiting_resume(job_id)
            keywords = (item.get('resume_review') or {}).get('keywords') or []
            return {'resume': draft, 'fit': resume_doc.fit(draft), 'coverage': coverage(keywords, draft)}

    def save_resume_draft(self, job_id, resume):
        """His edits (from the Approvals editor or an uploaded Word copy) replace the draft; nothing is approved."""
        with self.lock:
            item, draft = self._waiting_resume(job_id)
            resume = resume_doc.normalize(resume)
            self._store_resume_review(job_id, {'draft': resume, 'edited_at': now()})
            return self.resume_draft(job_id)

    def import_resume_docx(self, job_id, data):
        with self.lock:
            item, draft = self._waiting_resume(job_id)
            return self.save_resume_draft(job_id, resume_doc.from_docx(decode_upload(data), template=draft))

    def resume_draft_file(self, job_id, kind):
        with self.lock:
            item, draft = self._waiting_resume(job_id)
            if kind == 'png':
                return resume_doc.render_png(draft)
            return resume_doc.render_pdf(draft) if kind == 'pdf' else resume_doc.to_docx(draft)

    def decide_resume(self, job_id, choice, variant_id=None, label=None, focus=None, data=None):
        """His resume for a role waiting on a tailored draft: 'approve' the draft (as edited), 'upload' his own PDF,
        a saved 'variant', or 'current' (the standing resume)."""
        with self.lock:
            item = next((j for j in self.data['jobs'] if j['job_id'] == job_id and j['status'] == 'needs_resume'), None)
            if item is None:
                raise ValueError('This resume is no longer waiting. Refresh the page.')
            review = item.get('resume_review') or {}
            name = re.sub(r'\s+', ' ', (label or review.get('focus') or 'Tailored')).strip()[:80].rstrip(' ,;&') or 'Tailored'
            if choice == 'approve':
                item, draft = self._waiting_resume(job_id)
                fitted = resume_doc.fit(draft)
                if not fitted['fits']:
                    raise ValueError(f"The draft runs {fitted['lines_over']} line(s) past one page. Shorten it before approving.")
                variant_id = self.resume_library.add(name, focus or review.get('focus') or name, resume_doc.render_pdf(draft), job_id, structure=draft)
                choice = 'variant'
            elif choice == 'upload':
                if not data:
                    raise ValueError('Choose the PDF to upload')
                variant_id = self.resume_library.add(name, focus or review.get('focus') or name, decode_upload(data), job_id)
                choice = 'variant'
            elif choice == 'variant':
                if not self.resume_library.path(variant_id):
                    raise ValueError('That resume is no longer in your library')
                self.resume_library.note_use(variant_id, job_id)
            elif choice == 'current':
                self.resume_library.note_kept(review.get('focus'), job_id)
            else:
                raise ValueError('Choose approve, upload, variant or current')
            variant_id = variant_id if choice == 'variant' else None
            self._record_resume_decision(job_id, {'choice': choice, 'variant_id': variant_id, 'decided_at': now()})
            label = next((v['label'] for v in self.resume_library.variants() if v['id'] == variant_id), None)
            self._resume_from(job_id, {'needs_resume'}, message=f'Applying with your approved {label} resume.' if label else 'Applying with your standing resume.')
            self._save()
            return {'ok': True, 'variant_id': variant_id}

    def _limit_gate(self, item):
        """Hold a role whose employer states an application limit he has not allowed, or whose allowed
        limit is used up. Returns True when the role must not start."""
        entry = application_caps.load().get(application_caps.key(item['company']))
        if not entry:
            return False
        if entry['status'] == 'pending':
            item.update(status='needs_cap_approval', phase='needs_cap_approval', cap=entry, updated_at=now(),
                        message=f"{item['company']} limits applications: \"{entry.get('quote', '')}\" Waiting for your approval before applying there.")
            return True
        if entry['status'] == 'declined':
            item.update(status='skipped', phase='skipped', updated_at=now(), message=f"You chose not to apply to {item['company']} because of its application limit.")
            return True
        used = self.applications_within(item['company'], entry.get('days'))
        if entry.get('max') and used >= entry['max']:
            item.update(status='queued', message=f"{item['company']}'s limit of {entry['max']} applications is used up; waiting for the window to clear.",
                        not_before=(datetime.now(timezone.utc) + timedelta(days=1)).isoformat())
            return True
        return False

    def _caps_view(self):
        """Employer limits for the Approvals page, with how many applications each window already holds."""
        out = []
        for entry in application_caps.load().values():
            try:
                used = self.applications_within(entry['company'], entry.get('days'))
            except Exception:
                used = None
            out.append({**entry, 'used': used})
        return sorted(out, key=lambda e: (e['status'] != 'pending', e['company'].casefold()))

    def applications_within(self, company, days):
        """His recorded applications to a company in the last `days` (all time when no window is stated)."""
        from ..db.models import Application
        since = datetime.now(timezone.utc) - timedelta(days=days or 36500)
        with self.sessions() as session:
            rows = (session.query(Application.applied_date).join(Job, Job.id == Application.job_id)
                    .filter(Job.company_name.ilike(company)).all())
        return sum((d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d) >= since for (d,) in rows)

    def decide_cap(self, company, allow, max_count=None, days=None):
        """His decision on an employer's application limit; parked roles there resume or are dismissed."""
        with self.lock:
            entry = application_caps.decide(company, allow, max_count, days)
            for item in [j for j in self.data['jobs'] if j['company'].casefold() == company.casefold() and j['status'] == 'needs_cap_approval']:
                if allow:
                    # The cap decision card names this one posting, so approving the cap is an
                    # explicit selection for this run. Other postings remain manual-queue only.
                    item['source'] = 'manual_cap_selection'
                    self._resume_from(item['job_id'], {'needs_cap_approval'}, message=f'Approved applying to {company} within its limit.')
                else:
                    self.data.setdefault('dismissed_items', []).append({**item, 'dismissed_at': now(), 'individual_clear': True})
                    self.data['jobs'].remove(item)
                    if item['job_id'] not in self.data['skipped']:
                        self.data['skipped'].append(item['job_id'])
            self._save()
            return entry

    def _note_cap(self, item):
        # The worker enforces employer caps; remember them so autoplay stops picking that employer.
        match = re.search(r'cap reached until (\S+)', item.get('message') or '')
        if match:
            until = match.group(1) if re.match(r'\d{4}-\d{2}-\d{2}', match.group(1)) else (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
            self.data['capped'][item['company'].casefold()] = until

    def _ensure_loop(self):
        """The tick loop refreshes, reaps and dispatches workers; it must be alive whenever one may be running."""
        if getattr(self, 'shutdown_event', None) is None or self.shutdown_event.is_set():
            return
        if getattr(self, 'thread', None) is None or not self.thread.is_alive():
            self.thread = threading.Thread(target=self._loop, daemon=True, name='application-runner')
            self.thread.start()

    def _loop(self):
        while not self.shutdown_event.wait(1):
            try:
                self.tick()
            except Exception:
                # Stop dispatch after an unexpected persistence/DB failure, and say why: a silent
                # failure here left the usage check from running for hours (2026-10-19).
                import logging
                logging.getLogger(__name__).exception('Application runner tick failed')
                with self.lock:
                    self.data['running'] = False

    def _check_receipts(self):
        """Verify delayed mail without occupying browser slots or resubmitting."""
        for run_id, process in list(self.receipt_processes.items()):
            if process.poll() is not None:
                self.receipt_processes.pop(run_id)
        script = self.agent_dir / 'tools/verify-application-receipt.mjs'
        eligible = lambda item: item['status'] in {'submitted_pending_receipt', 'submission_unknown'} or (item['status'] in HELP and (item.get('submission_attempted') or item.get('phase') == 'human_submit'))
        from .receipt_batch import schedule_receipt_batch
        if schedule_receipt_batch(self, eligible):
            return
        # Old jobs must not monopolize a slow mailbox client. Check never-seen jobs
        # first, then the least recently checked, regardless of queue order.
        def checked_at(item):
            try:
                return datetime.fromisoformat(item['receipt_checked_at']).timestamp()
            except (KeyError, ValueError, TypeError, OverflowError):
                return float('-inf')
        for item in sorted(self.data['jobs'], key=checked_at):
            if item['id'] in self.processes or not eligible(item):
                continue
            self._refresh(item)
            if not eligible(item):
                continue
            checked = item.get('receipt_checked_at')
            if checked:
                try:
                    if (datetime.now(timezone.utc) - datetime.fromisoformat(checked)).total_seconds() < 300:
                        continue
                except (ValueError, TypeError):
                    pass
            run_dir = self.directory / item['id']
            if not self.data['running'] or self.receipt_processes or not script.is_file() or not (run_dir / 'request.json').is_file():
                continue
            item['receipt_checked_at'] = now()
            try:
                with open(run_dir / 'receipt.log', 'ab') as log:
                    os.chmod(run_dir / 'receipt.log', 0o600)
                    self.receipt_processes[item['id']] = self.popen([self._node() or 'node', str(script), str(run_dir)],
                                                                 cwd=self.agent_dir, stdout=log, stderr=log, start_new_session=True)
            except OSError as exc:
                item['receipt_error'] = str(exc)

    def _stop_if_stalled(self, item, process):
        """A worker whose own state has not changed for workers.stall_minutes while it is actively working is hung
        (Blue Origin 14222 sat 19 h at a Workday error page, holding a restart and every other launch that long). It is
        stopped and the run ends as interrupted with that reason, so the cooldown and retry-cap rules take over.
        Hand-offs to him, approvals and anything that reached submission are never stopped here."""
        minutes = setting('workers.stall_minutes')
        if not minutes or item['id'] in self.stop_times or process.poll() is not None:
            return
        if item.get('status') not in {'starting', 'running'} or item.get('submitted') or item.get('submission_attempted'):
            return
        try:
            last = datetime.fromisoformat(str(item.get('updated_at') or '').replace('Z', '+00:00'))
        except ValueError:
            return
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        if (datetime.now(timezone.utc) - last).total_seconds() < minutes * 60:
            return
        item['stalled'] = f"Stopped: the worker made no progress for {minutes} minutes (last: {str(item.get('message') or '')[:160]})"
        self._terminate(process)

    @staticmethod
    def _terminate(process):
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=3)
        except ProcessLookupError:
            pass

    def shutdown(self):
        self.shutdown_event.set()
        with self.lock:
            self.data['running'] = False
            for process in self.processes.values():
                self._terminate(process)
            for process in self.receipt_processes.values():
                self._terminate(process)
            self.receipt_processes.clear()
            for item in self.data['jobs']:
                if item['id'] in self.processes:
                    self._refresh(item)
                    if item['status'] not in TERMINAL:
                        item.update(status='interrupted', message='Server stopped; inspect the employer before retrying.')
            self.processes.clear()
            self._save()

    def snapshot(self):
        with self.lock:
            jobs = json.loads(json.dumps(self.data['jobs']))
            # One card per running worker. Finished and parked roles leave the worker (a parked one
            # keeps its screen on Approvals); the panel lists them compactly while workers are on.
            workers = [j for j in jobs if j['id'] in self.processes or (j['status'] not in TERMINAL and j['status'] != 'queued')]
            # Manual submissions can leave an older stopped/failed worker behind.
            # Keep its evidence, but use the database to hide resolved roles here.
            with self.sessions() as session:
                resolved = {row.id for row in session.query(Job.id).filter(
                    Job.id.in_([j['job_id'] for j in jobs]),
                    Job.status.in_([JobStatus.APPLIED, JobStatus.IGNORED])).all()}
            recent_hidden = set(self.data.get('recent_hidden') or [])
            recent = [{k: j.get(k) for k in ('job_id', 'company', 'title', 'url', 'status', 'message', 'updated_at')}
                      for j in jobs if j['status'] in RECENT
                      and j['id'] not in self.processes and j['job_id'] not in resolved
                      and j['id'] not in recent_hidden
                      and j['job_id'] not in self.data['skipped']][-10:][::-1] if self.data['running'] else []
            for item in workers:
                item['screenshot_url'] = f"/api/applications/workers/{item['id']}/screenshot" if (self.directory / item['id'] / 'screenshot.jpg').is_file() else None
            return {'running': self.data['running'], 'breakers': list(self.data.get('breakers') or []), 'auto_repair_enabled': self.data.get('auto_repair_enabled', True), 'parallelism': self.data['parallelism'], 'adaptive': self.data.get('adaptive', {}), 'weekly_reset': self.data.get('weekly_reset', {}), 'max_parallelism': setting('workers.max_parallelism'), 'recent': recent,
                    'stopping_after_current': bool(self.data.get('stop_after_current') and not self.data['running'] and self.processes),
                    'require_submission_approval': not setting('workers.auto_submit'),
                    'auto_stop': dict(self.data['auto_stop']), 'auto_stop_reason': self.data['auto_stop_reason'], 'agy_fallback': self._agy_fallback(),
                    'auto_stop_blocked': self._backlog_limit_reason(),
                    'usage_pause_percent': setting('workers.usage_pause_percent'), 'claude_usage': self.data.get('claude_usage'), 'usage_probe': {**(getattr(self, '_usage_probe', None) or {}), 'checked_by_watch_at': getattr(self, '_usage_watch_at', None)},
                    'workday_password_set': self.workday_password_set(),
                    'configured': self.configured, 'engine': self.data['engine'], 'engines': WORKER_ENGINES,
                    'max_parallelism': setting('workers.max_parallelism'), 'model': self._model(self.data['engine']),
                    'engine_status': self.engine_status(),
                    'slots': [{'index': i, 'engine': e, 'worker': next((j['id'] for j in self.data['jobs'] if j['id'] in self.processes and j.get('slot') == i), None)}
                              for i, e in enumerate(self.data['slots'])],
                    'workers': workers, 'queue': [{**j, 'not_before': max(j.get('not_before') or '', self.data['cooling'].get(j['company'].casefold()) or '') or None}
                                                 for j in jobs if j['status'] == 'queued'],
                    'autoplay': self.autoplay_view(), 'disciplines': list(get_track().clusters), 'track': get_track().key, 'up_next': self._safe_up_next(),
                    'platform_yield': self._safe_platform_yields(),
                    'apply_yourself': [{k: e.get(k) for k in ('job_id', 'company', 'title', 'url', 'host', 'reason', 'added_at')}
                                       for e in self.data.get('apply_yourself') or []],
                    'caps': self._caps_view(),
                    'fit_review': {'paused_until': self.fit_reviewer.paused_until.isoformat() if self.fit_reviewer.paused_until else None,
                                   'error': self.fit_reviewer.last_error},
                    'counts': {'queued': sum(j['status'] == 'queued' for j in jobs),
                               'ready': sum(j['status'] == 'queued' and not self._cooling(j) for j in jobs),
                               'delayed': sum(j['status'] == 'queued' and self._cooling(j) for j in jobs),
                               'active': len(self.processes), 'waiting': sum(j['status'].startswith(('waiting', 'awaiting')) for j in jobs),
                               'completed': sum(j['status'] in {'completed', 'submitted'} for j in jobs),
                               'awaiting_receipt': sum(j['status'] == 'submitted_pending_receipt' for j in jobs),
                               'failed': sum(j['status'] in {'failed', 'interrupted', 'submission_unknown'} for j in jobs),
                               'approvals': sum(j['status'] in ATTENTION for j in jobs),
                               'help': sum(j['status'] in HELP and j['id'] not in self.processes for j in jobs)}}

    def cost_report(self):
        """Aggregate run attempts into one usage and API-equivalent cost row per posting."""
        from .application_costs import estimate, model_id
        with self.lock:
            applications = {}
            total_cost = 0.0
            priced = 0
            legacy_total = 0.0
            legacy_runs = 0
            # Every run of a posting counts, not only the queue's latest one: a final run that needed no model
            # (answers already approved) hid the model calls of the runs before it (lesson 430).
            runs = {}
            for request_path in self.directory.glob('*/request.json'):
                request = read(request_path, {})
                job_id = (request.get('job') or {}).get('id')
                if job_id is not None:
                    runs.setdefault(job_id, []).append(request_path.parent)
            latest = {}
            for item in self.data['jobs']:
                self._refresh(item)
                latest[item['job_id']] = item
            for job_id, item in latest.items():
                run_dirs = runs.get(job_id) or [self.directory / item['id']]
                if self.directory / item['id'] not in run_dirs:
                    run_dirs.append(self.directory / item['id'])
                application = applications.setdefault(job_id, {
                    'job_id': job_id, 'company': item['company'], 'title': item['title'],
                    'url': item.get('url'), 'status': item.get('status'), 'updated_at': item.get('updated_at') or '',
                    'attempt_count': 0, 'model_usage': {}})
                for run_dir in run_dirs:
                    current = run_dir == self.directory / item['id']
                    state = read(run_dir / 'state.json', {})
                    request = read(run_dir / 'request.json', {})
                    usage = (item.get('usage') if current else None) or state.get('usage') or {}
                    model_usage = state.get('model_usage') or (item.get('model_usage') if current else None) or {}
                    application['attempt_count'] += 1
                    self._meter_run(application, model_usage, usage, request, item if current else {}, model_id)
            rows = []
            total_attempts = 0
            for application in applications.values():
                models = []
                for (label, legacy), tokens in application.pop('model_usage').items():
                    model = model_id(label)
                    cost = estimate(tokens, model, legacy=legacy)
                    models.append({'model': model or label, 'calls': tokens.get('calls'),
                                   'input_tokens': sum(tokens.get(k, 0) for k in ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')),
                                   'output_tokens': tokens.get('output_tokens', 0), 'estimated_cost_usd': cost,
                                   'legacy_upper_bound': bool(legacy and cost is not None)})
                row_costs = [m['estimated_cost_usd'] for m in models if m['estimated_cost_usd'] is not None and not m['legacy_upper_bound']]
                row_legacy_costs = [m['estimated_cost_usd'] for m in models if m['estimated_cost_usd'] is not None and m['legacy_upper_bound']]
                row_cost = round(sum(row_costs), 8) if row_costs else None
                row_legacy_cost = round(sum(row_legacy_costs), 8) if row_legacy_costs else None
                if row_cost is not None:
                    total_cost += row_cost
                    priced += 1
                if row_legacy_cost is not None:
                    legacy_total += row_legacy_cost
                    legacy_runs += 1
                total_attempts += application['attempt_count']
                rows.append({**application, 'models': models,
                             'estimated_cost_usd': row_cost,
                             'legacy_upper_bound_usd': row_legacy_cost,
                             'has_usage': bool(models),
                             'legacy_upper_bound': any(m['legacy_upper_bound'] for m in models)})
            rows.sort(key=lambda row: row.get('updated_at') or '', reverse=True)
            return {'rows': rows, 'total_applications': len(rows), 'total_attempts': total_attempts,
                    'priced_runs': priced, 'legacy_runs': legacy_runs,
                    'estimated_total_usd': round(total_cost, 8),
                    'legacy_upper_bound_total_usd': round(legacy_total, 8),
                    'platform_yield': self._safe_platform_yields(),
                    'basis': 'Anthropic Claude Platform standard token rates checked 2026-10-26; API-equivalent estimate, not subscription billing.'}

    @staticmethod
    def _meter_run(application, model_usage, usage, request, item, model_id):
        """Add one run's recorded usage to a posting's per-model meters."""
        if model_usage:
            for label, tokens in model_usage.items():
                model = model_id(label) or model_id(request.get('model'))
                key = (model or label, False)
                meter = application['model_usage'].setdefault(key, {'calls': 0, 'input_tokens': 0,
                    'cache_read_input_tokens': 0, 'cache_creation_input_tokens': 0, 'output_tokens': 0})
                for token_key in meter:
                    meter[token_key] += tokens.get(token_key, 0) or 0
        elif usage.get('input_tokens') or usage.get('output_tokens'):
            model = model_id(request.get('model')) or model_id(item.get('ai_model'))
            key = (model or item.get('ai_model') or request.get('engine') or 'unknown', True)
            meter = application['model_usage'].setdefault(key, {'calls': None, 'input_tokens': 0, 'output_tokens': 0})
            meter['input_tokens'] += usage.get('input_tokens', 0)
            meter['output_tokens'] += usage.get('output_tokens', 0)

    def _safe_platform_yields(self):
        try:
            return self.platform_yields()
        except Exception:
            return None

    def _safe_up_next(self):
        try:
            return self.up_next()
        except Exception:
            return []  # A database hiccup must not blank the whole panel.

    def live_frames(self):
        with self.lock:
            return [(item['id'], self.directory / item['id'] / 'screenshot.jpg') for item in self.data['jobs'] if item['id'] in self.processes]

    def screenshot(self, worker_id):
        with self.lock:
            if not any(j['id'] == worker_id for j in self.data['jobs']):
                raise ValueError('Worker not found')
            return self.directory / worker_id / 'screenshot.jpg'


_runner = None
_singleton_lock = threading.Lock()


def get_runner():
    global _runner
    with _singleton_lock:
        if _runner is None:
            _runner = ApplicationRunner()
            threading.Thread(target=_watch_limits, args=(_runner,), daemon=True, name='application-limit-watch').start()
            if _runner.data.get('auto_repair_enabled', True):
                _runner._ensure_loop()
        return _runner


def _watch_limits(runner):
    # Workers may be off (stopped by a plan limit) with nothing ticking, so a light watcher lifts
    # expired limits and restarts them.
    while not runner.shutdown_event.wait(30):
        try:
            with runner.lock:
                runner._expire_model_limits()
                # A usage pause must lift even when no worker loop is ticking (restart while paused).
                runner._usage_pause()
                runner._record_stale_completions()
                runner._save()
        except Exception:
            pass


def shutdown_runner():
    if _runner is not None:
        _runner.shutdown()


def _agent_dir():
    from jobagent.config import AGENT_DIR
    return AGENT_DIR
