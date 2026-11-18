"""Setup: one guided page that makes JobAgent work for any student.

A fresh install (no setup record and no postings yet) opens /setup instead of the dashboard. The page
collects who the student is, their education and experience, the roles, industries and places they want,
work eligibility, which job sources to read, and connects their JobAgent account, a password for employer
sites and (optionally) Gmail. Finish writes:

- config/profile.yaml: the candidate profile every rule and score reads (identity.py, eligibility, scorer);
- config/tracks.yaml, config/ranking.yaml, config/search.yaml: the search built from their roles,
  industries and places (search_profile.py);
- dashboard settings: which sources run and whether internships are applied to;
- the application agent's private/profile.json, when that agent is installed;
- the candidate facts in the database, and data/setup.json to record that setup is done.

Secrets (account token, site password, Gmail refresh token) go to the operating system's credential store
(vault.py), never to these files. Every file Setup replaces is first copied to data/backups/setup-<time>/.
Running Setup again (sidebar -> Setup) starts from the saved answers, so it doubles as a guided edit.
"""
import base64
import hashlib
import json
import re
import secrets as pysecrets
import shutil
import threading
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import List, Literal, Optional
from urllib.parse import urlencode

import httpx
import yaml
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field, field_validator

from .. import search_profile, vault
from ..config import DEFAULT_CONFIG_DIR, config_path, get_settings

router = APIRouter()
TEMPLATES_DIR = Path(__file__).resolve().parent / 'templates'
_lock = threading.Lock()
SETUP_VERSION = 2


def _config_dir() -> Path:
    return DEFAULT_CONFIG_DIR


def _data_dir() -> Path:
    return get_settings().data_dir


def _marker_path() -> Path:
    return _data_dir() / 'setup.json'


def _agent_dir() -> Path:
    from .profile_routes import AGENT_DIR
    return AGENT_DIR


def file_stem() -> str:
    from ..identity import file_stem as stem
    return stem()


def setup_record() -> Optional[dict]:
    try:
        return json.loads(_marker_path().read_text())
    except (OSError, ValueError):
        return None


def setup_needed() -> bool:
    """True on a fresh install: setup was never completed and no posting has been stored yet."""
    if setup_record():
        return False
    try:
        from ..db.models import Job
        from ..db.repository import get_db_session
        with get_db_session() as session:
            return session.query(Job.id).first() is None
    except Exception:
        return True


# ---------------------------------------------------------------- the form

Month = str  # "YYYY-MM"


def _month_ok(v):
    if v is not None and not re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])', v):
        raise ValueError('Use a month like 2027-06')
    return v


def _nonempty(v):
    return [i.strip() for i in v if i and i.strip()]


class About(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=200)
    phone: str = Field(default='', max_length=40)
    location: str = Field(default='', max_length=120)
    linkedin: str = Field(default='', max_length=300)
    website: str = Field(default='', max_length=300)

    @field_validator('email')
    @classmethod
    def _email(cls, v):
        if not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', v.strip()):
            raise ValueError('Enter a valid email address')
        return v.strip()


class Education(BaseModel):
    institution: str = Field(min_length=1, max_length=200)
    degree: Literal['associate', 'bachelor', 'master', 'doctorate'] = 'bachelor'
    majors: List[str] = Field(min_length=1, max_length=3)
    minors: List[str] = Field(default_factory=list, max_length=3)
    graduation: Month
    gpa: str = Field(default='', max_length=20)
    coursework: List[str] = Field(default_factory=list, max_length=40)
    started: Optional[Month] = None

    _m = field_validator('graduation', 'started')(classmethod(lambda cls, v: _month_ok(v)))

    @field_validator('majors')
    @classmethod
    def _majors(cls, v):
        v = _nonempty(v)
        if not v:
            raise ValueError('Add at least one major')
        return v


class Role(BaseModel):
    company: str = Field(min_length=1, max_length=160)
    title: str = Field(min_length=1, max_length=160)
    location: str = Field(default='', max_length=120)
    start: Month
    end: Optional[Month] = None  # empty = current
    summary: str = Field(default='', max_length=4000)
    skills: List[str] = Field(default_factory=list, max_length=40)
    caution: str = Field(default='', max_length=1000)  # what not to claim about this role


class Project(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    role: str = Field(default='', max_length=160)
    summary: str = Field(default='', max_length=4000)
    skills: List[str] = Field(default_factory=list, max_length=40)
    caution: str = Field(default='', max_length=1000)


class Skills(BaseModel):
    technical: List[str] = Field(default_factory=list, max_length=80)
    other: List[str] = Field(default_factory=list, max_length=80)


class Search(BaseModel):
    roles: List[str] = Field(min_length=1, max_length=12)
    industries: List[str] = Field(default_factory=list, max_length=12)
    dream_companies: List[str] = Field(default_factory=list, max_length=40)
    role_type: Literal['full-time', 'internships', 'both'] = 'full-time'
    start_date: str
    available_during_school_year: bool = False
    locations: List[str] = Field(default_factory=list, max_length=40)
    location_strict: bool = False
    relocation: bool = True
    remote_ok: bool = True
    min_salary: int = Field(default=0, ge=0, le=1_000_000)
    max_required_years: int = Field(default=2, ge=0, le=15)
    degree_fields: List[str] = Field(default_factory=list, max_length=40)

    @field_validator('roles')
    @classmethod
    def _roles(cls, v):
        v = _nonempty(v)
        if not v:
            raise ValueError('Add at least one role')
        return v

    @field_validator('start_date')
    @classmethod
    def _date(cls, v):
        date.fromisoformat(v)
        return v


class Eligibility(BaseModel):
    work_authorization: Literal['citizen', 'permanent_resident', 'authorized', 'needs_sponsorship'] = 'citizen'
    clearance_eligible: bool = True


class Sources(BaseModel):
    indeed: bool = True
    linkedin: bool = True
    email: bool = True
    handshake: bool = False
    handshake_school: str = Field(default='', max_length=60, pattern=r'^[A-Za-z0-9-]*$')


class SetupForm(BaseModel):
    about: About
    education: Education
    experience: List[Role] = Field(default_factory=list, max_length=30)
    projects: List[Project] = Field(default_factory=list, max_length=30)
    skills: Skills = Field(default_factory=Skills)
    search: Search
    eligibility: Eligibility = Field(default_factory=Eligibility)
    sources: Sources = Field(default_factory=Sources)


AUTH_TEXT = {
    'citizen': ('U.S. Citizen', 'Authorized to work in the US without sponsorship', False),
    'permanent_resident': ('U.S. Permanent Resident', 'Authorized to work in the US without sponsorship', False),
    'authorized': ('Authorized to work in the US', 'Authorized to work in the US without sponsorship', False),
    'needs_sponsorship': ('Requires sponsorship', 'Will require visa sponsorship', True),
}
DEGREE_NAMES = {'associate': 'Associate Degree', 'bachelor': "Bachelor's Degree", 'master': "Master's Degree", 'doctorate': 'Doctorate'}


# ---------------------------------------------------------------- reading the current state

def _month(value) -> str:
    return str(value or '')[:7]


def _read_yaml(path: Path) -> dict:
    try:
        return yaml.safe_load(path.read_text(encoding='utf-8')) or {}
    except (OSError, yaml.YAMLError):
        return {}


def _catalog() -> dict:
    packs = search_profile.company_packs()
    return {'packs': [{'key': k, 'name': p.get('name', k), 'industries': p.get('industries') or [],
                       'count': sum(len(v or []) for v in (p.get('target_companies') or {}).values())} for k, p in packs.items()],
            'industries': list(search_profile.INDUSTRIES)}


def _blank_draft() -> dict:
    today = date.today()
    grad = date(today.year + (1 if today.month > 5 else 0), 6, 1)
    return {
        'about': {'name': '', 'email': '', 'phone': '', 'location': '', 'linkedin': '', 'website': ''},
        'education': {'institution': '', 'degree': 'bachelor', 'majors': [], 'minors': [], 'graduation': grad.strftime('%Y-%m'),
                      'gpa': '', 'coursework': [], 'started': None},
        'experience': [], 'projects': [], 'skills': {'technical': [], 'other': []},
        'search': {'roles': [], 'industries': [], 'dream_companies': [], 'role_type': 'full-time',
                   'start_date': grad.replace(day=15).isoformat(), 'available_during_school_year': False,
                   'locations': [], 'location_strict': False, 'relocation': True, 'remote_ok': True, 'min_salary': 0,
                   'max_required_years': 2, 'degree_fields': []},
        'eligibility': {'work_authorization': 'citizen', 'clearance_eligible': True},
        'sources': {'indeed': True, 'linkedin': True, 'email': True, 'handshake': False, 'handshake_school': ''},
    }


def current_draft() -> dict:
    """The form as the saved configuration fills it in (for re-running setup)."""
    from ..settings import setting
    data = _read_yaml(config_path('profile.yaml', _config_dir()))
    cand, edu = data.get('candidate') or {}, data.get('education') or {}
    if not cand.get('name'):
        return _blank_draft()
    search = _read_yaml(config_path('search.yaml', _config_dir()))
    prefs = cand.get('search_preferences') or {}
    auth = 'needs_sponsorship' if cand.get('requires_sponsorship') else (
        'citizen' if 'citizen' in str(cand.get('citizenship', '')).lower() else
        'permanent_resident' if 'permanent' in str(cand.get('citizenship', '')).lower() else 'authorized')
    skills = data.get('skills') or {}
    seeking = cand.get('seeking_role_type', 'full-time')
    return {
        'about': {k: str(cand.get(k) or '') for k in ('name', 'email', 'phone', 'location', 'linkedin', 'website')},
        'education': {'institution': edu.get('institution', ''), 'degree': cand.get('highest_degree', 'bachelor'),
                      'majors': [m.get('name', '') for m in edu.get('majors') or []], 'minors': list(edu.get('minors') or []),
                      'graduation': _month(edu.get('graduation_date')), 'gpa': str(edu.get('gpa') or ''),
                      'coursework': list(edu.get('coursework') or []), 'started': _month(edu.get('start_date')) or None},
        'experience': [{'company': e.get('company', ''), 'title': e.get('title', ''), 'location': e.get('location', ''),
                        'start': _month(e.get('start_date')), 'end': None if e.get('is_current') else (_month(e.get('end_date')) or None),
                        'summary': ' '.join(str(e.get('summary') or '').split()), 'skills': list(e.get('signals') or []),
                        'caution': e.get('caution', '')} for e in data.get('experience') or []],
        'projects': [{'name': p.get('name', ''), 'role': p.get('role', ''), 'summary': ' '.join(str(p.get('summary') or '').split()),
                      'skills': list(p.get('signals') or []), 'caution': p.get('caution', '')} for p in data.get('projects') or []],
        'skills': {'technical': list((skills.get('programming') or {}).get('explicit') or []),
                   'other': list((skills.get('engineering') or {}).get('explicit') or [])},
        'search': {'roles': list(prefs.get('roles') or []), 'industries': list(prefs.get('industries') or []),
                   'dream_companies': list(prefs.get('dream_companies') or []),
                   'role_type': 'both' if 'intern' in seeking and 'full' in seeking else 'internships' if 'intern' in seeking else 'full-time',
                   'start_date': str(cand.get('target_start_date') or edu.get('graduation_date') or ''),
                   'available_during_school_year': bool(cand.get('available_during_school_year')),
                   'locations': list(cand.get('target_locations') or []), 'location_strict': bool(cand.get('location_strict')),
                   'relocation': bool(cand.get('relocation_allowed', True)), 'remote_ok': bool(cand.get('remote_ok', True)),
                   'min_salary': int(cand.get('salary_threshold_annual') or 0),
                   'max_required_years': int(cand.get('max_required_experience_years') or 2),
                   'degree_fields': list(cand.get('acceptable_degree_fields') or [])},
        'eligibility': {'work_authorization': auth,
                        'clearance_eligible': 'eligible' in str(cand.get('security_clearance', '')).lower()},
        'sources': {'indeed': bool(setting('indeed.enabled')), 'linkedin': bool(setting('linkedin.enabled')),
                    'email': bool(setting('email.enabled')), 'handshake': bool(setting('handshake.enabled')),
                    'handshake_school': str((search.get('handshake') or {}).get('school') or '')},
    }


# ---------------------------------------------------------------- writing

def _mid_month(month: str) -> str:
    y, m = map(int, month.split('-'))
    return date(y, m, 15).isoformat()


def _season(d: date) -> str:
    return ('Winter', 'Winter', 'Spring', 'Spring', 'Spring', 'Summer', 'Summer', 'Summer', 'Fall', 'Fall', 'Fall', 'Winter')[d.month - 1]


def build_profile(form: SetupForm, base: dict) -> dict:
    """profile.yaml for this form. Keys the form does not cover are kept from base (re-running setup)."""
    out = dict(base)
    cand = dict(base.get('candidate') or {})
    citizenship, work_auth, sponsor = AUTH_TEXT[form.eligibility.work_authorization]
    start = date.fromisoformat(form.search.start_date)
    fields = form.search.degree_fields or [m.lower() for m in form.education.majors]
    cand.update({
        'name': form.about.name.strip(), 'email': form.about.email, 'phone': form.about.phone.strip(),
        'location': form.about.location.strip(), 'linkedin': form.about.linkedin.strip(), 'website': form.about.website.strip(),
        'citizenship': citizenship, 'work_authorization': work_auth, 'requires_sponsorship': sponsor,
        'security_clearance': 'None (Eligible for U.S. clearance)' if form.eligibility.clearance_eligible and not sponsor else 'None',
        'target_start_date': start.isoformat(), 'earliest_start_date': start.isoformat(), 'target_season': f'{_season(start)} {start.year}',
        'available_during_school_year': form.search.available_during_school_year,
        'relocation_allowed': form.search.relocation, 'salary_threshold_annual': form.search.min_salary,
        'seeking_role_type': {'full-time': 'full-time', 'internships': 'internships', 'both': 'full-time-and-internships'}[form.search.role_type],
        'max_required_experience_years': form.search.max_required_years, 'highest_degree': form.education.degree,
        'acceptable_degree_fields': fields, 'target_locations': form.search.locations, 'remote_ok': form.search.remote_ok,
        'location_strict': form.search.location_strict,
        'search_preferences': {'roles': form.search.roles, 'industries': form.search.industries,
                               'dream_companies': form.search.dream_companies},
    })
    out['candidate'] = cand
    old_edu = base.get('education') or {}
    old_majors = {m.get('name'): m for m in old_edu.get('majors') or []}
    out['education'] = {**old_edu, 'institution': form.education.institution.strip(), 'degree': DEGREE_NAMES[form.education.degree],
                        'majors': [old_majors.get(m, {'name': m}) for m in form.education.majors], 'minors': form.education.minors,
                        'expected_graduation': datetime.strptime(form.education.graduation, '%Y-%m').strftime('%B %Y'),
                        'graduation_date': _mid_month(form.education.graduation), 'gpa': form.education.gpa.strip(),
                        'coursework': form.education.coursework}
    if form.education.started:
        out['education']['start_date'] = f'{form.education.started}-01'
    old_roles = {(e.get('company'), e.get('title')): e for e in base.get('experience') or []}
    out['experience'] = [{**old_roles.get((r.company, r.title), {'weight_multiplier': 1.0}),
                          'company': r.company.strip(), 'title': r.title.strip(), 'location': r.location.strip(),
                          'start_date': f'{r.start}-01', 'end_date': f'{r.end}-01' if r.end else None, 'is_current': not r.end,
                          'summary': r.summary.strip() or f'{r.title} at {r.company}', 'caution': r.caution.strip(),
                          'signals': [s.strip().lower() for s in r.skills if s.strip()]} for r in form.experience]
    old_projects = {p.get('name'): p for p in base.get('projects') or []}
    out['projects'] = [{**old_projects.get(p.name, {}), 'name': p.name.strip(), 'role': p.role.strip(),
                        'summary': p.summary.strip() or p.name, 'caution': p.caution.strip(),
                        'signals': [s.strip().lower() for s in p.skills if s.strip()]} for p in form.projects]
    old_skills = base.get('skills') or {}
    out['skills'] = {'programming': {**(old_skills.get('programming') or {}), 'explicit': form.skills.technical},
                     'engineering': {**(old_skills.get('engineering') or {}), 'explicit': form.skills.other}}
    return out


def _split_name(name: str):
    parts = name.strip().split()
    return (parts[0], ' '.join(parts[1:])) if parts else ('', '')


def build_agent_profile(form: SetupForm, base: dict, resume_rel: Optional[str]) -> dict:
    """The application agent's profile.json. Contact answers and policy always follow the form; work history
    and education are written only while the agent has none (the Profile page edits them afterwards)."""
    out = dict(base)
    answers = dict(out.get('answers') or {})
    first, last = _split_name(form.about.name)
    city = form.about.location.split(',')[0].strip()
    state = form.about.location.split(',')[1].strip() if ',' in form.about.location else ''
    for key, value in {'firstName': first, 'lastName': last, 'fullName': form.about.name.strip(), 'email': form.about.email,
                       'phone': form.about.phone.strip(), 'city': city, 'addressCity': city, 'addressState': state,
                       'linkedin': form.about.linkedin.strip(), 'website': form.about.website.strip()}.items():
        if value:
            answers[key] = value
    answers.setdefault('country', 'United States')
    out['answers'] = answers
    policy = dict(out.get('policy') or {})
    policy.update(minimumBaseSalary=form.search.min_salary, availableFrom=form.search.start_date)
    policy.setdefault('allowedHosts', [])
    out['policy'] = policy
    split = lambda month: [str(int(month[5:7])), month[:4]] if month else []
    if not out.get('workHistory'):
        out['workHistory'] = [{'title': r.title, 'company': r.company, 'location': r.location, 'from': split(r.start),
                               'to': split(r.end) if r.end else [], 'description': r.summary} for r in form.experience]
    if not out.get('education'):
        out['education'] = [{'school': form.education.institution, 'degree': DEGREE_NAMES[form.education.degree], 'field': m,
                             'from': split(form.education.started or ''), 'to': split(form.education.graduation),
                             'searchAs': form.education.institution} for m in form.education.majors]
    if not out.get('projects'):
        out['projects'] = [{'key': re.sub(r'[^a-z0-9]+', '-', p.name.lower()).strip('-'), 'name': p.name, 'status': 'complete',
                            'includeInProseDrafts': True, 'description': p.summary, 'caution': p.caution} for p in form.projects]
    if resume_rel:
        out['resumePath'] = resume_rel
    return out


def _backup(paths) -> Path:
    folder = _data_dir() / 'backups' / f"setup-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    for path in paths:
        if path.is_file():
            folder.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, folder / (path.parent.name + '-' + path.name))
    return folder


def _write(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(text, encoding='utf-8')
    tmp.replace(path)


def _uploaded_resume() -> Path:
    return _data_dir() / 'setup' / 'resume.pdf'


def refresh_candidate_facts():
    """Re-seed the candidate profile and profile.yaml facts in the database from the new profile."""
    from ..db.models import CandidateFact, CandidateProfile
    from ..db.repository import get_db_session, init_db
    with get_db_session() as session:
        session.query(CandidateFact).filter(CandidateFact.source_reference.like('profile.yaml%')).delete(synchronize_session=False)
        session.query(CandidateProfile).delete(synchronize_session=False)
        session.flush()
        init_db(session=session)


def _after_setup(fresh: bool):
    """Rescore stored postings for the new profile; on a fresh install, start the first scan."""
    import logging
    log = logging.getLogger('jobagent.setup')
    try:
        refresh_candidate_facts()
        from ..db.repository import get_db_session
        from ..tracking.reclassify import reclassify_jobs
        with get_db_session() as session:
            reclassify_jobs(session)
    except Exception:
        log.exception('Rescoring after setup failed')
    if fresh:
        try:
            from ..services.scheduler import request_discovery
            request_discovery()
        except Exception:
            log.exception('Could not start the first scan after setup')


def save_setup(form: SetupForm, run_after=True) -> dict:
    from ..processing.tracks import set_active_track
    from .. import settings as settings_mod
    if form.sources.handshake and not form.sources.handshake_school.strip():
        raise HTTPException(422, "Give your school's Handshake address to search Handshake, or turn Handshake off.")
    fresh = setup_needed()
    with _lock:
        cfg = _config_dir()
        names = ('profile.yaml', 'tracks.yaml', 'ranking.yaml', 'search.yaml')
        agent_dir = _agent_dir()
        agent_profile = agent_dir / 'private' / 'profile.json'
        backup = _backup([cfg / n for n in names] + [agent_profile])

        base = {} if fresh else _read_yaml(cfg / 'profile.yaml')
        _write(cfg / 'profile.yaml', search_profile.dump(build_profile(form, base),
               'Written by JobAgent Setup (/setup). Edit here or re-run Setup from the sidebar.'))
        s = form.search
        skills = [*form.skills.technical, *form.skills.other, *(k for r in form.experience for k in r.skills)]
        _write(cfg / 'tracks.yaml', search_profile.dump(search_profile.build_tracks(s.roles, form.education.majors, s.industries),
               'Written by Setup from your roles, majors and industries.'))
        _write(cfg / 'ranking.yaml', search_profile.dump(search_profile.build_ranking(s.roles, skills, s.industries, s.dream_companies),
               'Written by Setup: shipped weights plus your roles and dream companies.'))
        _write(cfg / 'search.yaml', search_profile.dump(
            search_profile.build_search(s.roles, s.locations, s.industries, s.role_type, form.sources.handshake_school,
                                        s.remote_ok, s.relocation),
            'Written by Setup: job-board queries for your roles, your places, and employer packs for your industries.'))

        settings_mod.save({'indeed.enabled': form.sources.indeed, 'linkedin.enabled': form.sources.linkedin,
                           'email.enabled': form.sources.email, 'handshake.enabled': form.sources.handshake,
                           'workers.apply_internships': s.role_type != 'full-time'})
        set_active_track('primary', cfg)

        steps = ['Profile saved', f'Search built for {len(s.roles)} role{"s" if len(s.roles) != 1 else ""}']
        resume_rel = None
        if agent_dir.is_dir():
            if _uploaded_resume().is_file():
                resume_rel = f'private/{file_stem()}_Resume.pdf'
                (agent_dir / 'private').mkdir(parents=True, exist_ok=True)
                shutil.copy2(_uploaded_resume(), agent_dir / resume_rel)
            try:
                base_agent = {} if fresh else json.loads(agent_profile.read_text())
            except (OSError, ValueError):
                base_agent = {}
            _write(agent_profile, json.dumps(build_agent_profile(form, base_agent, resume_rel), indent=2) + '\n')
            steps.append('Application agent profile saved')
        else:
            steps.append('Application agent not installed: applying stays manual until it is')

        record = {'completed_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'version': SETUP_VERSION,
                  'backup': str(backup) if backup.exists() else None}
        _write(_marker_path(), json.dumps(record, indent=2))
    if run_after:
        threading.Thread(target=_after_setup, args=(fresh,), daemon=True, name='setup-rescore').start()
        steps.append('Rescoring postings' + (' and starting the first scan' if fresh else ''))
    return {'ok': True, 'fresh': fresh, 'steps': steps, 'backup': record['backup']}


# ---------------------------------------------------------------- account, site password, Gmail

class AccountForm(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=8, max_length=200)
    mode: Literal['login', 'signup'] = 'login'


def account_state() -> dict:
    return {'connected': bool(vault.get(vault.ACCOUNT_TOKEN)), 'email': vault.get(vault.ACCOUNT_EMAIL) or '',
            'backend': vault.backend_url()}


def connect_account(form: AccountForm, client: Optional[httpx.Client] = None) -> dict:
    """Sign in to (or create) the student's JobAgent account; the device token goes to the credential store."""
    client = client or httpx.Client(timeout=20)
    try:
        res = client.post(f'{vault.backend_url()}/auth/{form.mode}', json={'email': form.email, 'password': form.password})
    except httpx.HTTPError:
        raise HTTPException(502, 'Could not reach JobAgent. Check your internet connection and try again.')
    body = res.json() if res.headers.get('content-type', '').startswith('application/json') else {}
    if res.status_code >= 400 or not body.get('token'):
        detail = body.get('detail') or (body.get('error') or {}).get('message') or 'Sign-in failed'
        raise HTTPException(400 if res.status_code < 500 else 502, detail)
    vault.put(vault.ACCOUNT_TOKEN, body['token'])
    vault.put(vault.ACCOUNT_EMAIL, form.email)
    return account_state()


class SitePassword(BaseModel):
    password: str = Field(min_length=8, max_length=200)


GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
_pending_gmail: dict = {}


def google_client() -> Optional[dict]:
    """JobAgent's Google OAuth client (type "Desktop app"): env vars, or a client file shipped with the app."""
    import os
    cid = os.environ.get('JOBAGENT_GOOGLE_CLIENT_ID')
    if cid:
        return {'client_id': cid, 'client_secret': os.environ.get('JOBAGENT_GOOGLE_CLIENT_SECRET', '')}
    path = config_path('google_oauth_client.json', _config_dir())
    try:
        raw = json.loads(path.read_text())
        return raw.get('installed') or raw.get('web') or raw
    except (OSError, ValueError):
        return None


def gmail_auth_url(redirect_uri: str) -> str:
    client = google_client()
    if not client:
        raise HTTPException(503, 'Gmail connection is not configured in this build.')
    verifier = base64.urlsafe_b64encode(pysecrets.token_bytes(48)).rstrip(b'=').decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    state = pysecrets.token_urlsafe(24)
    _pending_gmail.clear()
    _pending_gmail[state] = {'verifier': verifier, 'redirect_uri': redirect_uri, 'at': time.time()}
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + urlencode({
        'client_id': client['client_id'], 'redirect_uri': redirect_uri, 'response_type': 'code', 'scope': GMAIL_SCOPE,
        'access_type': 'offline', 'prompt': 'consent', 'code_challenge': challenge, 'code_challenge_method': 'S256', 'state': state})


def finish_gmail(code: str, state: str, client: Optional[httpx.Client] = None) -> str:
    pending = _pending_gmail.pop(state, None)
    if not pending or time.time() - pending['at'] > 900:
        raise HTTPException(400, 'This Gmail sign-in expired. Start it again from Setup.')
    oauth = google_client() or {}
    client = client or httpx.Client(timeout=20)
    res = client.post('https://oauth2.googleapis.com/token', data={
        'code': code, 'client_id': oauth.get('client_id', ''), 'client_secret': oauth.get('client_secret', ''),
        'redirect_uri': pending['redirect_uri'], 'grant_type': 'authorization_code', 'code_verifier': pending['verifier']})
    grant = res.json()
    if res.status_code >= 400 or not grant.get('refresh_token'):
        raise HTTPException(400, f"Gmail sign-in failed: {grant.get('error_description') or grant.get('error') or res.status_code}")
    if GMAIL_SCOPE not in str(grant.get('scope', '')).split():
        raise HTTPException(400, 'Google granted a different permission than reading mail.')
    vault.put(vault.GMAIL_REFRESH, grant['refresh_token'])
    profile = client.get('https://gmail.googleapis.com/gmail/v1/users/me/profile',
                         headers={'Authorization': f"Bearer {grant.get('access_token', '')}"})
    address = profile.json().get('emailAddress', '') if profile.status_code == 200 else ''
    # The application agent reads verification codes with this token file (private/, never committed).
    agent = _agent_dir()
    if agent.is_dir():
        token_file = agent / 'private' / 'gmail-token.json'
        _write(token_file, json.dumps({'client_id': oauth.get('client_id', ''), 'client_secret': oauth.get('client_secret', ''),
                                       'refresh_token': grant['refresh_token'], 'scope': GMAIL_SCOPE,
                                       'created_at': datetime.now(timezone.utc).isoformat()}, indent=1))
        token_file.chmod(0o600)
    return address


# ---------------------------------------------------------------- resume reading

def read_resume(pdf: bytes) -> dict:
    """Contact details found in a resume PDF, to pre-fill the first step. Nothing else is guessed."""
    import io
    from pypdf import PdfReader
    text = '\n'.join((page.extract_text() or '') for page in PdfReader(io.BytesIO(pdf)).pages[:2])
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    found = {}
    if m := re.search(r'[\w.+-]+@[\w-]+(?:\.[\w-]+)+', text):
        found['email'] = m.group(0)
    if m := re.search(r'(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}', text):
        found['phone'] = m.group(0).strip()
    if m := re.search(r'(?:https?://)?(?:www\.)?linkedin\.com/in/[\w-]+/?', text, re.I):
        found['linkedin'] = m.group(0) if m.group(0).startswith('http') else 'https://' + m.group(0)
    if m := re.search(r'(?:https?://)?(?:[\w-]+\.)?(?:github\.(?:com|io)/?[\w-]*|[\w-]+\.github\.io)', text, re.I):
        found['website'] = m.group(0) if m.group(0).startswith('http') else 'https://' + m.group(0)
    for line in lines[:3]:
        if 1 < len(line.split()) <= 4 and re.fullmatch(r"[A-Za-z][A-Za-z .'-]+", line):
            found['name'] = line.title() if line.isupper() else line
            break
    return found


# ---------------------------------------------------------------- routes

@router.get('/setup', response_class=HTMLResponse)
def setup_page():
    return HTMLResponse((TEMPLATES_DIR / 'setup.html').read_text(), headers={'Cache-Control': 'no-store'})


@router.get('/setup.js')
def setup_script():
    return FileResponse(TEMPLATES_DIR.parent / 'setup.js', media_type='text/javascript', headers={'Cache-Control': 'no-cache'})


@router.get('/api/setup')
def setup_state():
    needed = setup_needed()
    return {'needed': needed, 'record': setup_record(), 'draft': _blank_draft() if needed else current_draft(),
            'catalog': _catalog(), 'agent_installed': _agent_dir().is_dir(), 'resume_uploaded': _uploaded_resume().is_file(),
            'account': account_state(), 'site_password_saved': bool(vault.get(vault.SITE_PASSWORD)),
            'gmail': {'available': bool(google_client()), 'connected': bool(vault.get(vault.GMAIL_REFRESH))}}


@router.post('/api/setup/resume')
async def setup_resume(request: Request):
    body = await request.body()
    if not body.startswith(b'%PDF'):
        raise HTTPException(415, 'Upload your resume as a PDF.')
    if len(body) > 10 * 1024 * 1024:
        raise HTTPException(413, 'That PDF is over 10 MB.')
    path = _uploaded_resume()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    try:
        found = read_resume(body)
    except Exception:
        found = {}
    return {'ok': True, 'found': found}


@router.post('/api/setup/account')
def setup_account(form: AccountForm):
    return connect_account(form)


@router.post('/api/setup/site-password')
def setup_site_password(form: SitePassword):
    vault.put(vault.SITE_PASSWORD, form.password)
    return {'ok': True}


@router.post('/api/setup/gmail/start')
def setup_gmail_start(request: Request):
    redirect = f'http://127.0.0.1:{request.url.port or 8000}/api/setup/gmail/callback'
    return {'url': gmail_auth_url(redirect)}


@router.get('/api/setup/gmail/callback', response_class=HTMLResponse)
def setup_gmail_callback(code: str = '', state: str = '', error: str = ''):
    if error:
        message = 'Gmail was not connected. You can close this tab and try again from Setup.'
    else:
        address = finish_gmail(code, state)
        message = f'Gmail connected{f" ({address})" if address else ""}. You can close this tab and go back to Setup.'
    return HTMLResponse(f'<!doctype html><meta charset="utf-8"><title>JobAgent</title>'
                        f'<body style="font-family:system-ui;padding:48px;background:#f5f1eb;color:#15241c">'
                        f'<h1 style="font-family:Georgia,serif;color:#1a4d3a">JobAgent</h1><p>{message}</p></body>')


@router.post('/api/setup')
def setup_save(form: SetupForm):
    return save_setup(form)
