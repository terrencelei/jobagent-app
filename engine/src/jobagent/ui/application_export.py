"""Local, read-only CSV export of recorded application history."""
from __future__ import annotations

import csv
from datetime import timezone
import io
import json
from pathlib import Path

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from sqlalchemy import or_
from sqlalchemy.orm import joinedload

from ..config import get_settings
from ..db.models import Application, Job, JobStatus, PreferenceType, UserPreference
from ..db.repository import get_db_session
from .application_routes import local_application_request


router = APIRouter(prefix='/api/applications', dependencies=[Depends(local_application_request)])
PIPELINE = {JobStatus.APPLIED, JobStatus.INTERVIEW, JobStatus.OFFER, JobStatus.REJECTED, JobStatus.WITHDRAWN}
COLUMNS = (
    'schema_version', 'job_id', 'application_id', 'company', 'title', 'status', 'application_status',
    'role_type', 'location', 'canonical_url', 'application_url', 'external_req_id', 'source_ats',
    'applied_at', 'interview_at', 'offer_at', 'rejected_at', 'withdrawn_at', 'application_updated_at',
    'notes', 'application_notes', 'confirmation_id', 'queue_status', 'submission_confirmation',
)


def iso(value):
    if value is None:
        return ''
    return (value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)).isoformat()


def enum_value(value):
    return value.value if hasattr(value, 'value') else value or ''


def spreadsheet_cell(value):
    """Treat untrusted posting/notes text as text when opened in Excel or Sheets."""
    text = '' if value is None else str(value)
    probe = text
    while probe and (probe[0].isspace() or ord(probe[0]) < 32 or probe[0] == '\ufeff'):
        probe = probe[1:]
    if probe.startswith(('=', '+', '-', '@')) or text.startswith(('\t', '\r', '\n')):
        return "'" + text
    return text


def queue_records(path: Path):
    """Read a snapshot without creating or controlling an ApplicationRunner."""
    try:
        content = json.loads(path.read_text())
    except (OSError, ValueError, TypeError):
        return {}
    records = {}
    items = content.get('jobs', []) if isinstance(content, dict) else []
    for item in items if isinstance(items, list) else []:
        if isinstance(item, dict) and type(item.get('job_id')) is int:
            records[item['job_id']] = item
    return records


def application_rows(session, *, queue=None, include_pending=False):
    queue = queue or {}
    membership = [Application.id.isnot(None), Job.status.in_(PIPELINE)]
    if include_pending and queue:
        membership.append(Job.id.in_(list(queue)))
    jobs = (session.query(Job).outerjoin(Application, Application.job_id == Job.id)
            .options(joinedload(Job.application)).filter(or_(*membership))
            .order_by(Application.applied_date.desc().nullslast(), Job.id.desc()).all())
    events = {}
    if jobs:
        for event in (session.query(UserPreference).filter(UserPreference.job_id.in_([j.id for j in jobs]))
                      .order_by(UserPreference.created_at, UserPreference.id)):
            stage = {PreferenceType.INTERVIEW: 'interview_at', PreferenceType.OFFER: 'offer_at'}.get(event.preference_type)
            if stage is None:
                stage = {'User marked REJECTED': 'rejected_at', 'User marked WITHDRAWN': 'withdrawn_at'}.get(event.notes)
            if stage:
                events.setdefault(event.job_id, {}).setdefault(stage, iso(event.created_at))
    for job in jobs:
        app = job.application
        queued = queue.get(job.id, {})
        state = queued.get('status', '')
        confirmation = ('confirmed' if state in {'completed', 'submitted'} else
                        'awaiting_receipt' if state in {'submitted_pending_receipt', 'submission_unknown'} else
                        'recorded' if app is not None or job.status in PIPELINE else '')
        row = dict.fromkeys(COLUMNS, '')
        row.update(schema_version='1', job_id=job.id, application_id=app.id if app else '',
                   company=job.company_name, title=job.title, status=enum_value(job.status),
                   application_status=enum_value(app.status) if app else '', role_type=job.role_type,
                   location=job.location, canonical_url=job.canonical_url, application_url=job.application_url,
                   external_req_id=job.external_req_id, source_ats=job.source_ats,
                   applied_at=iso(app.applied_date) if app else '',
                   application_updated_at=iso(app.updated_at) if app else '',
                   notes=job.user_notes, application_notes=app.notes if app else '',
                   confirmation_id=app.confirmation_id if app else '', queue_status=state,
                   submission_confirmation=confirmation)
        row.update(events.get(job.id, {}))
        yield row


def application_csv(session, *, queue=None, include_pending=False):
    content = io.StringIO(newline='')
    writer = csv.DictWriter(content, fieldnames=COLUMNS, lineterminator='\r\n')
    writer.writeheader()
    for row in application_rows(session, queue=queue, include_pending=include_pending):
        writer.writerow({key: spreadsheet_cell(value) for key, value in row.items()})
    return content.getvalue().encode('utf-8-sig')


@router.get('/export.csv')
def export_application_history(include_pending: bool = False):
    queue = queue_records(get_settings().data_dir / 'application-runner' / 'queue.json')
    with get_db_session() as session:
        content = application_csv(session, queue=queue, include_pending=include_pending)
    return Response(content, media_type='text/csv; charset=utf-8', headers={
        'Content-Disposition': 'attachment; filename="jobagent-application-history.csv"',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    })
