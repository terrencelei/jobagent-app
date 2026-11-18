"""Complete history export with truthful dates and spreadsheet-safe text."""
from contextlib import contextmanager
import csv
from datetime import datetime, timezone
import io
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from jobagent.db.models import Base, Job, JobStatus, Application, UserPreference, PreferenceType
from jobagent.ui import application_export as module


@pytest.fixture
def session():
    engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def add(session, status=JobStatus.APPLIED, **changes):
    number = session.query(Job).count() + 1
    values = dict(id=number, company_name='Example', title='Mechanical Engineer', description='Design hardware',
                  location='Springfield, CA', canonical_url=f'https://example.com/jobs/{number}',
                  application_url=f'https://example.com/jobs/{number}/apply', source_ats='direct', status=status,
                  role_type='FULL_TIME')
    values.update(changes)
    job = Job(**values)
    session.add(job)
    session.flush()
    return job


def decode(content):
    assert content.startswith(b'\xef\xbb\xbf')
    return list(csv.DictReader(io.StringIO(content.decode('utf-8-sig'), newline='')))


def test_export_keeps_all_application_statuses_and_later_closed_history(session):
    submitted = datetime(2026, 10, 1, 12, tzinfo=timezone.utc)
    interview = datetime(2026, 10, 2, 12, tzinfo=timezone.utc)
    offer = datetime(2026, 10, 3, 12, tzinfo=timezone.utc)
    jobs = [add(session, status=status) for status in module.PIPELINE]
    restored = add(session, status=JobStatus.CLOSED)
    app = Application(job_id=restored.id, status=JobStatus.CLOSED, applied_date=submitted,
                      notes='Previously submitted', confirmation_id='confirmation-123')
    session.add(app)
    session.add_all([
        UserPreference(job_id=restored.id, preference_type=PreferenceType.INTERVIEW, created_at=interview),
        UserPreference(job_id=restored.id, preference_type=PreferenceType.OFFER, created_at=offer),
    ])
    add(session, status=JobStatus.ACTIVE)
    add(session, status=JobStatus.SAVED)
    session.flush()
    rows = decode(module.application_csv(session))
    assert len(rows) == len(jobs) + 1
    closed = next(r for r in rows if r['job_id'] == str(restored.id))
    assert closed['status'] == 'CLOSED' and closed['application_status'] == 'CLOSED'
    assert closed['applied_at'] == submitted.isoformat()
    assert closed['interview_at'] == interview.isoformat()
    assert closed['offer_at'] == offer.isoformat()
    assert closed['rejected_at'] == closed['withdrawn_at'] == ''
    assert closed['confirmation_id'] == 'confirmation-123'
    assert {r['status'] for r in rows} == {s.value for s in module.PIPELINE} | {'CLOSED'}


def test_unknown_legacy_dates_stay_blank_and_pending_is_explicit_opt_in(session):
    legacy = add(session, status=JobStatus.REJECTED)
    pending = add(session, status=JobStatus.NEW)
    queue = {pending.id: {'status': 'submitted_pending_receipt'}}
    rows = decode(module.application_csv(session, queue=queue))
    assert [r['job_id'] for r in rows] == [str(legacy.id)]
    assert rows[0]['applied_at'] == rows[0]['rejected_at'] == ''
    rows = decode(module.application_csv(session, queue=queue, include_pending=True))
    queued = next(r for r in rows if r['job_id'] == str(pending.id))
    assert queued['status'] == 'NEW'
    assert queued['queue_status'] == 'submitted_pending_receipt'
    assert queued['submission_confirmation'] == 'awaiting_receipt'
    assert queued['applied_at'] == ''  # An attempt is not a confirmed submission.


def test_unicode_quotes_newlines_formula_guard_and_private_field_exclusion(session):
    job = add(session, company_name='Müller, “Hardware”', title='=HYPERLINK("https://evil.example")',
              user_notes='Line one, quoted "notes"\nLine two')
    session.add(Application(job_id=job.id, status=JobStatus.APPLIED,
                            notes=' \t+SUM(1,2)', answers={'password': 'must-not-export'},
                            resume_path='/private/must-not-export.pdf'))
    session.flush()
    content = module.application_csv(session)
    row = decode(content)[0]
    assert row['company'] == 'Müller, “Hardware”'
    assert row['title'].startswith("'=HYPERLINK")
    assert row['application_notes'] == "' \t+SUM(1,2)"
    assert row['notes'] == 'Line one, quoted "notes"\nLine two'
    assert b'must-not-export' not in content and b'password' not in content
    for value in ('=1+1', '+1', '-1', '@SUM(A1)', '\tformula', '\rformula', '\nformula', '  =1', '\ufeff=1', '\u00a0=1', '\x00=1'):
        assert module.spreadsheet_cell(value).startswith("'")
    assert module.spreadsheet_cell('APPLIED') == 'APPLIED'


def test_local_download_and_cross_site_restrictions(session, monkeypatch, tmp_path):
    add(session)
    @contextmanager
    def sessions():
        yield session
    monkeypatch.setattr(module, 'get_db_session', sessions)
    monkeypatch.setattr(module, 'get_settings', lambda: type('Settings', (), {'data_dir': tmp_path})())
    app = FastAPI()
    app.include_router(module.router)
    client = TestClient(app, base_url='http://127.0.0.1:8000')
    response = client.get('/api/applications/export.csv')
    assert response.status_code == 200
    assert response.headers['content-disposition'].startswith('attachment;')
    assert response.headers['cache-control'] == 'no-store'
    assert response.headers['content-type'] == 'text/csv; charset=utf-8'
    assert decode(response.content)[0]['status'] == 'APPLIED'
    assert client.get('/api/applications/export.csv', headers={'Origin': 'http://127.0.0.1:8000'}).status_code == 200
    assert client.get('/api/applications/export.csv', headers={'Origin': 'https://evil.example'}).status_code == 403
    assert client.get('/api/applications/export.csv', headers={'Sec-Fetch-Site': 'cross-site'}).status_code == 403
    assert client.get('/api/applications/export.csv?include_pending=invalid').status_code == 422


def test_queue_snapshot_read_is_optional_and_never_creates_runner(tmp_path):
    path = tmp_path / 'queue.json'
    assert module.queue_records(path) == {}
    path.write_text('{bad json')
    assert module.queue_records(path) == {}
    path.write_text(json.dumps({'jobs': None}))
    assert module.queue_records(path) == {}
    path.write_text(json.dumps({'jobs': [{'job_id': 1, 'status': 'queued'}, {'job_id': 'bad'}]}))
    assert module.queue_records(path) == {1: {'job_id': 1, 'status': 'queued'}}
