"""The dashboard's greeting, daily status report and agent conversation.

The report is counted from the database and the application runner. The conversation is one tool-enabled Claude
session on his plan (services/dashboard_assistant.py): it acts for him with full permissions, except that the code
of JobAgent and the application agent is read-only to it. It may also offer buttons from ACTIONS for things only
the page can do.
"""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..db.models import Application, Job, JobStatus, utc_now
from ..db.repository import get_db_session
from ..config import get_settings
from ..services.dashboard_assistant import DashboardAssistant
from ..settings import model_id
from .profile_routes import load_profile, local_only

router = APIRouter()
ACTIONS = {'start_workers': 'Start the application workers', 'stop_workers': 'Stop the application workers',
           'open_approvals': 'Open Approvals', 'open_help': 'Open Needs help', 'open_results': 'Open Results', 'open_profile': 'Open Profile',
           'open_agent': 'Open the Application Agent panel', 'scan_sources': 'Scan job sources now',
           'queue_role': 'Add a role to the application queue', 'search_roles': 'Filter the role list by words', 'filter_states': 'Show only roles in given states',
           'sort_roles': 'Sort the role list'}
def first_name() -> str:
    try:
        answers = load_profile().get('answers') or {}
    except HTTPException:
        return ''
    return str(answers.get('preferredName') or answers.get('firstName') or '').strip()


def runner_counts() -> dict:
    try:
        from ..services.application_runner import get_runner
        snapshot = get_runner().snapshot()
        return {'workers_on': bool(snapshot.get('running')), **{k: int(v) for k, v in (snapshot.get('counts') or {}).items()}}
    except Exception:
        return {}


def report() -> dict:
    """Today's numbers: what was submitted, what came back, what is waiting on him."""
    now = utc_now()
    start = now - timedelta(hours=24)
    with get_db_session() as session:
        applications = session.query(Application).all()
        status = lambda row: row.status.value if hasattr(row.status, 'value') else str(row.status)
        recent = lambda value: value is not None and value.replace(tzinfo=None) >= start.replace(tzinfo=None)
        submitted = sum(1 for row in applications if recent(row.applied_date))
        rejected = sum(1 for row in applications if status(row) == 'REJECTED' and recent(row.updated_at))
        new_roles = session.query(Job).filter(Job.status.in_([JobStatus.NEW, JobStatus.ACTIVE]), Job.discovery_date >= start).count()
        totals = {name: sum(1 for row in applications if status(row) == name) for name in ('APPLIED', 'REJECTED', 'INTERVIEW', 'OFFER', 'WITHDRAWN')}
        interviewed = sum(1 for row in applications if row.interviewed or status(row) in ('INTERVIEW', 'OFFER'))
    counts = runner_counts()
    lines = [f"{submitted} application{'s' if submitted != 1 else ''} submitted in the last 24 hours.",
             f"{new_roles} new matching role{'s' if new_roles != 1 else ''} found."]
    if rejected:
        lines.append(f"{rejected} rejection{'s' if rejected != 1 else ''} recorded.")
    waiting = [f"{counts[k]} {label}" for k, label in (('approvals', 'waiting for your approval'), ('help', 'needing help')) if counts.get(k)]
    lines.append(('Waiting on you: ' + ' and '.join(waiting) + '.') if waiting else 'Nothing is waiting on you.')
    if counts:
        lines.append(f"Workers are {'on' if counts.get('workers_on') else 'off'} with {counts.get('queued', 0)} role{'s' if counts.get('queued', 0) != 1 else ''} queued.")
    lines.append(f"So far: {len(applications)} applications, {interviewed} interviewed, {totals['OFFER']} offer{'s' if totals['OFFER'] != 1 else ''}.")
    return {'name': first_name(), 'lines': lines, 'numbers': {'submitted_24h': submitted, 'new_roles_24h': new_roles, 'rejections_24h': rejected, 'applications': len(applications),
                                                              'interviewed': interviewed, **{k.lower(): v for k, v in totals.items()}, **counts}}


def context() -> dict:
    data = report()
    with get_db_session() as session:
        top = session.query(Job).filter(Job.status.in_([JobStatus.NEW, JobStatus.ACTIVE])).order_by(Job.priority_score.desc()).limit(25).all()
        roles = [{'job_id': j.id, 'company': j.company_name, 'title': j.title, 'location': j.location, 'fit': round(j.relevance_score or 0, 1),
                  'eligibility': str(getattr(j.eligibility, 'value', j.eligibility) or ''), 'salary': j.salary_raw} for j in top]
        moving = session.query(Application, Job).join(Job, Job.id == Application.job_id).filter(Application.status != JobStatus.APPLIED).order_by(Application.updated_at.desc()).limit(25).all()
        outcomes = [{'company': j.company_name, 'title': j.title, 'status': str(getattr(a.status, 'value', a.status)), 'interviewed': bool(a.interviewed)} for a, j in moving]
    return {'today': data['lines'], 'numbers': data['numbers'], 'top_roles_by_priority': roles, 'applications_with_an_outcome': outcomes,
            'dashboard_can': ACTIONS}


class ChatRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


_assistant = None


def get_assistant() -> DashboardAssistant:
    global _assistant
    if _assistant is None:
        _assistant = DashboardAssistant(get_settings().data_dir, ACTIONS, context, lambda: model_id('assistant.model'))
    return _assistant


def invoke(action, *args):
    try:
        return action(*args)
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@router.get('/api/assistant/report')
def daily_report():
    return report()


@router.get('/api/assistant/chat')
def chat():
    return get_assistant().chat()


@router.post('/api/assistant/chat', dependencies=[Depends(local_only)])
def send(body: ChatRequest):
    return invoke(get_assistant().send, body.text)


@router.post('/api/assistant/chat/stop', dependencies=[Depends(local_only)])
def stop():
    return invoke(get_assistant().stop)


@router.post('/api/assistant/chat/new', dependencies=[Depends(local_only)])
def new_chat():
    return invoke(get_assistant().reset)
