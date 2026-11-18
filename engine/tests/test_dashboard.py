"""Counters, queue membership, status persistence and static/live parity."""
import re
import json
from contextlib import contextmanager
from datetime import timedelta
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from jobagent.db.models import Base, Job, JobStatus, EligibilityStatus, Application, utc_now
from jobagent.db.repository import JobRepository
from jobagent.ui.dashboard import dashboard_counts, tab_filters, jobs_query
from jobagent.ui.exporter import export_static_dashboard
from jobagent.ui.server import app


@pytest.fixture
def session():
    engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine, autoflush=False)() as db:
        yield db
    engine.dispose()


def add(session, **kwargs):
    n = session.query(Job).count() + 1
    values = dict(company_name='Test', title='Mechanical Engineer I', normalized_title='mechanical engineer i',
                  description='BS in Mechanical Engineering. 1 year of experience.', canonical_url=f'https://example.com/{n}',
                  application_url=f'https://example.com/{n}', source_ats='direct', status=JobStatus.NEW,
                  eligibility=EligibilityStatus.ELIGIBLE, role_type='FULL_TIME', priority_score=85, urgency_score=80,
                  discovery_date=utc_now()-timedelta(hours=1))
    values.update(kwargs)
    job=Job(**values);session.add(job);session.flush();return job


def test_counts_use_exact_tab_membership(session, tmp_path):
    now=utc_now()
    add(session)
    add(session,title='Mechanical Engineer II',normalized_title='mechanical engineer ii',early_career_boost=True)
    add(session,status=JobStatus.SAVED)
    add(session,status=JobStatus.APPLIED,title='Applied Role',normalized_title='applied role')  # a twin title would hide the open rows
    add(session,role_type='INTERNSHIP')
    add(session,role_type='OTHER')
    add(session,eligibility=EligibilityStatus.UNCERTAIN)
    add(session,eligibility=EligibilityStatus.INELIGIBLE)
    add(session,discovery_date=now-timedelta(hours=24,minutes=1),priority_score=84.99,urgency_score=79.99)
    add(session,posting_date=now+timedelta(days=1))
    counts=dashboard_counts(session,now)
    assert counts['ACTIVE']==4
    assert counts['NEW_GRAD']==3
    assert counts['NEW_TODAY']==2
    assert counts['HIGH_MATCH']==3
    assert counts['URGENT']==3
    export_static_dashboard(session,tmp_path)
    data=json.loads((tmp_path/'data.js').read_text().split('=',1)[1].strip().rstrip(';'))
    from jobagent.ui.dashboard import TAB_COUNTS
    for tab,key in TAB_COUNTS.items():
        ids={j['id'] for j in data['jobs'] if tab in j['tabs']}
        assert len(ids)==data['stats']['counts'][key]
        assert ids=={j.id for j in jobs_query(session,tab).all()}
    assert (tmp_path/'dashboard.js').exists()
    assert '<script src="data.js"></script>' in (tmp_path/'index.html').read_text()


@pytest.fixture
def client(session, tmp_path):
    @contextmanager
    def get_session():
        yield session
    with patch('jobagent.ui.server.get_db_session',get_session), patch('jobagent.ui.server.export_static_dashboard',lambda s:export_static_dashboard(s,tmp_path)):
        yield TestClient(app)


def test_api_validates_params_paginates_and_persists_status(session,client):
    first=add(session);add(session);session.commit()
    result=client.get('/api/jobs?limit=1').json()
    assert result['total']==2 and result['count']==1
    assert client.get('/api/jobs?tab=typo').status_code==422
    assert client.get('/api/jobs?limit=-1').status_code==422
    assert client.get('/api/jobs?offset=-1').status_code==422
    assert client.post(f'/api/jobs/{first.id}/status',json={'status':'typo'}).status_code==422
    assert client.post('/api/jobs/9999/status',json={'status':'SAVED'}).status_code==404
    assert client.post(f'/api/jobs/{first.id}/status',json={'status':'APPLIED','notes':'receipt checked'}).status_code==200
    assert client.get('/api/status').json()['counts']['APPLIED']==1
    assert client.get('/api/jobs?tab=applied').json()['jobs'][0]['id']==first.id
    client.post(f'/api/jobs/{first.id}/status',json={'status':'INTERVIEW','notes':'phone screen'})
    assert session.query(Application).filter_by(job_id=first.id).one().status==JobStatus.INTERVIEW
    assert client.get(f'/api/jobs/{first.id}').json()['notes']=='phone screen'
    assert client.get('/api/status').json()['counts']['APPLIED']==0
    assert client.get('/api/status').json()['counts']['INTERVIEW']==1


def test_scan_is_nonblocking_and_shares_worker(client):
    with patch('jobagent.ui.server.request_discovery',return_value=False):
        response=client.post('/api/search')
        assert response.status_code==202
        assert response.json()['started'] is False


def test_literal_search_and_cluster(session):
    add(session,title='Mechanical 100% Test',best_career_cluster='ROBOTICS / MECHATRONICS')
    add(session,title='Mechanical 1000 Test')
    assert jobs_query(session,'top_priority',query='%').count()==1
    assert jobs_query(session,'top_priority',cluster='ROBOTICS / MECHATRONICS').count()==1


def test_find_roles_hides_applied_twins_and_in_flight_submissions(session):
    open_role = add(session, title='Open role', normalized_title='open role')
    add(session, title='Applied twin', normalized_title='twin title', status=JobStatus.APPLIED, company_name='Acme')
    twin = add(session, title='Applied twin (other listing)', normalized_title='twin title', company_name='ACME')
    pending = add(session, title='Awaiting receipt', normalized_title='awaiting receipt')
    assert {j.id for j in jobs_query(session, 'top_priority').all()} == {open_role.id, pending.id}
    assert {j.id for j in jobs_query(session, 'top_priority', in_flight=[pending.id]).all()} == {open_role.id}
    assert dashboard_counts(session, in_flight=[pending.id])['ACTIVE'] == 1
    assert twin.id not in {j.id for j in jobs_query(session, 'new_grad').all()}


def test_interviews_ignore_discovery_discipline(session, client):
    first = add(session, status=JobStatus.INTERVIEW, company_name='SpaceX',
                best_career_cluster='MANUFACTURING / EQUIPMENT / AUTOMATION')
    second = add(session, status=JobStatus.INTERVIEW, company_name='Relativity Space',
                 best_career_cluster='AEROSPACE / VEHICLE')
    session.commit()
    params = {'tab': 'interview', 'cluster': 'ROBOTICS / MECHATRONICS'}
    result = client.get('/api/jobs', params=params).json()
    assert result['total'] == 2
    assert {j['id'] for j in result['jobs']} == {first.id, second.id}
    result = client.get('/api/jobs', params={**params, 'query': 'SpaceX'}).json()
    assert [j['id'] for j in result['jobs']] == [first.id]


def test_saved_notes_and_idempotent_application_events(session,client):
    from jobagent.db.models import UserPreference
    job=add(session);session.commit()
    for _ in range(2):
        client.post(f'/api/jobs/{job.id}/status',json={'status':'SAVED','notes':'follow up Friday'})
    assert client.get(f'/api/jobs/{job.id}').json()['notes']=='follow up Friday'
    assert session.query(UserPreference).count()==1
    for _ in range(2):
        client.post(f'/api/jobs/{job.id}/status',json={'status':'APPLIED','notes':'confirmed'})
    assert session.query(Application).count()==1
    assert session.query(UserPreference).count()==2


def test_interview_tab_clears_inherited_filters(session, tmp_path):
    playwright = pytest.importorskip('playwright.sync_api')
    add(session, company_name='SpaceX', status=JobStatus.INTERVIEW,
        best_career_cluster='MANUFACTURING / EQUIPMENT / AUTOMATION')
    add(session, company_name='Relativity Space', status=JobStatus.INTERVIEW,
        best_career_cluster='AEROSPACE / VEHICLE')
    export_static_dashboard(session, tmp_path)
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            # Exercise the offline snapshot without a running API or CDN assets.
            page.route('http://**/*', lambda route: route.abort())
            page.route('https://**/*', lambda route: route.abort())
            page.goto((tmp_path / 'index.html').as_uri())
            page.add_style_tag(content='.hidden { display: none !important; }')
            page.wait_for_function("document.querySelector('#resultCount').textContent.includes('Showing')")
            page.select_option('#clusterFilter', 'PRODUCT / MECHANICAL DESIGN')
            page.fill('#searchInput', 'unrelated role')
            page.click('[data-tab="interview"]')
            playwright.expect(page.locator('#jobGrid .job-card')).to_have_count(2)
            playwright.expect(page.locator('#clusterFilter')).to_have_value('')
            playwright.expect(page.locator('#clusterFilter')).to_be_disabled()
            assert page.evaluate("snapshotRequest('/api/jobs?tab=interview&cluster=ROBOTICS%20%2F%20MECHATRONICS').total") == 2
            playwright.expect(page.locator('#searchInput')).to_have_value('')
            playwright.expect(page.locator('[data-tab="interview"] .tab-count')).to_have_text('2')
            page.fill('#searchInput', 'SpaceX')
            playwright.expect(page.locator('#jobGrid .job-card')).to_have_count(1)
            page.click('#clearFilters')
            playwright.expect(page.locator('#jobGrid .job-card')).to_have_count(2)
            playwright.expect(page.locator('#clearFilters')).to_be_hidden()
        finally:
            browser.close()


def test_sources_button_opens_offline_and_recovers(session, tmp_path):
    playwright = pytest.importorskip('playwright.sync_api')
    export_static_dashboard(session, tmp_path)
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('http://**/*', lambda route: route.abort())
            page.route('https://**/*', lambda route: route.abort())
            page.goto((tmp_path / 'index.html').as_uri())
            page.add_style_tag(content='.hidden { display: none !important; }')
            page.wait_for_function("document.querySelector('#resultCount').textContent.includes('Showing')")
            page.click('#sourcesBtn')
            playwright.expect(page.locator('#sourcesModal')).to_be_visible()
            playwright.expect(page.locator('#sourcesConnection')).to_be_visible()
            playwright.expect(page.locator('#addSourceBtn')).to_be_disabled()
            playwright.expect(page.get_by_role('link', name='Open live dashboard')).to_have_attribute('href', 'http://127.0.0.1:8000/#sources')
            page.route('**/api/sources', lambda route: route.fulfill(json={
                'sources': [], 'watches': {}, 'tasks': [],
                'notifications': {'recipient':'test@example.com', 'available':True, 'pending':0, 'sent':0, 'uncertain':0}}))
            page.get_by_role('button', name='Retry connection').click()
            playwright.expect(page.locator('#sourcesConnection')).to_be_hidden()
            playwright.expect(page.locator('#addSourceBtn')).to_be_enabled()
            playwright.expect(page.locator('#notificationInfo')).to_contain_text('test@example.com')
            assert not errors
        finally:
            browser.close()


def test_dashboard_script_is_versioned_and_revalidated(session, tmp_path):
    client = TestClient(app)
    response = client.get('/')
    assert response.headers['cache-control'] == 'no-store'
    assert 'dashboard.js?v=' in response.text
    assert client.get('/dashboard.js').headers['cache-control'] == 'no-cache'
    export_static_dashboard(session, tmp_path)
    assert 'dashboard.js?v=' in (tmp_path / 'index.html').read_text()


def test_application_panel_handles_engine_sign_in_and_inline_drafts(session, tmp_path):
    from urllib.parse import urlsplit
    playwright = pytest.importorskip('playwright.sync_api')
    export_static_dashboard(session, tmp_path)
    state = {'running': False, 'parallelism': 2, 'configured': True, 'engine': 'claude', 'engines': {'claude': 'Claude', 'codex': 'Codex'}, 'engine_status': {}, 'counts': {},
             'queue': [], 'workers': [{'id':'fixture', 'job_id':1, 'title':'Mechanical Engineer',
                'company':'Fixture Company', 'status':'waiting_answers', 'phase':'answers', 'events':[],
                'questions':[{'id':'why', 'label':'Why this role?', 'type':'textarea', 'required':True}]}]}
    commands = []
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.route('https://**/*', lambda route: route.abort())
            page.route('http://**/*', lambda route: route.abort())
            def local(route):
                path = urlsplit(route.request.url).path
                if path.startswith('/api/applications'):
                    if route.request.method == 'POST':
                        commands.append(route.request.post_data_json)
                        if path.endswith('/check-engine'): state['engine_status']={'status':'ready','message':'Connected'}
                    route.fulfill(json=state['engine_status'] if path.endswith('/check-engine') else state)
                else:
                    file = tmp_path / path.lstrip('/')
                    if file.is_file(): route.fulfill(path=str(file))
                    else: route.abort()
            page.route('http://127.0.0.1:8123/**', local)
            page.goto('http://127.0.0.1:8123/index.html#applications')
            expect = playwright.expect
            # Start/Stop live on the main dashboard (hidden in a static snapshot); the panel reports sign-in.
            expect(page.locator('#appEngineStatus')).to_be_hidden()  # an unchecked engine is unknown, not failure
            page.get_by_label('Why this role?').fill('An answer I am still editing')
            state['engine_status']={'status':'signed_out','message':'Claude is signed out'}
            page.locator('#applicationPanel [data-action="refresh"]').click()
            expect(page.locator('#appEngineStatus')).to_have_text('Claude is signed out')
            expect(page.locator('#appEngineStatus')).to_have_class(re.compile(r'\berror\b'))
            expect(page.get_by_label('Why this role?')).to_have_value('An answer I am still editing')
            page.get_by_role('button',name='Check sign-in',exact=True).click()
            expect(page.locator('#appEngineStatus')).to_have_text('Connected')
            expect(page.locator('#appEngineStatus')).not_to_have_class(re.compile(r'\berror\b'))
            page.get_by_role('button',name='Save answers & continue').click()
            page.wait_for_function("document.querySelector('#appNotice').textContent === 'Changes saved.'")
            assert commands[-1] == {'action':'answer', 'answers':{'why':'An answer I am still editing'}}
        finally:
            browser.close()


def test_applied_orders_by_actual_submission_time_and_preserves_legacy_rows(session, client, tmp_path):
    now = utc_now()
    oldest = add(session, status=JobStatus.APPLIED, priority_score=100,
                 posting_date=now, discovery_date=now)
    newest = add(session, status=JobStatus.APPLIED, priority_score=1,
                 posting_date=now-timedelta(days=90), discovery_date=now-timedelta(days=80))
    tied_newest = add(session, status=JobStatus.APPLIED, priority_score=2)
    legacy = add(session, status=JobStatus.APPLIED, priority_score=100)
    legacy_second = add(session, status=JobStatus.APPLIED, priority_score=0)
    for job, submitted in [(oldest, now-timedelta(days=5)), (newest, now), (tied_newest, now)]:
        session.add(Application(job_id=job.id, status=JobStatus.APPLIED, applied_date=submitted))
    session.commit()
    expected = [tied_newest.id, newest.id, oldest.id, legacy_second.id, legacy.id]
    assert [j.id for j in jobs_query(session, 'applied').all()] == expected
    payload = client.get('/api/jobs', params={'tab':'applied', 'limit':2}).json()
    assert payload['total'] == 5
    assert [j['id'] for j in payload['jobs']] == expected[:2]
    assert payload['jobs'][0]['applied_date'] == now.isoformat()
    assert client.get('/api/jobs', params={'tab':'applied', 'offset':2}).json()['jobs'][0]['id'] == oldest.id
    export_static_dashboard(session, tmp_path)
    data = json.loads((tmp_path/'data.js').read_text().split('=',1)[1].strip().rstrip(';'))
    exported = {j['id']:j for j in data['jobs']}
    assert exported[newest.id]['applied_date'] == now.isoformat()
    assert exported[legacy.id]['applied_date'] is None


def test_company_selection_does_not_hide_application_history(session):
    offer = add(session, title='Offer role', company_name='RTX', status=JobStatus.OFFER)
    applied = add(session, title='Applied role', company_name='RTX', status=JobStatus.APPLIED)
    add(session, title='Open RTX role', company_name='RTX')
    kept = add(session, title='Open Acme role', company_name='Acme')
    assert {j.id for j in jobs_query(session, 'offer', companies=['Acme']).all()} == {offer.id}
    assert {j.id for j in jobs_query(session, 'applied', companies=['Acme']).all()} == {applied.id}
    assert {j.id for j in jobs_query(session, 'top_priority', companies=['Acme']).all()} == {kept.id}


def test_bulk_status_marks_applied_or_deletes_and_leaves_application_history(session,client):
    a,b,c=add(session),add(session),add(session);session.commit()
    client.post(f'/api/jobs/{c.id}/status',json={'status':'INTERVIEW'})
    done=client.post('/api/jobs/bulk-status',json={'job_ids':[a.id,c.id,9999],'status':'APPLIED'}).json()
    assert done['changed']==[a.id] and done['skipped']==[c.id,9999]
    assert session.query(Application).filter_by(job_id=a.id).one().status==JobStatus.APPLIED
    assert session.query(Application).filter_by(job_id=c.id).one().status==JobStatus.INTERVIEW
    assert client.post('/api/jobs/bulk-status',json={'job_ids':[b.id,a.id],'status':'IGNORED'}).json()['changed']==[b.id]
    assert session.get(type(b),b.id).status==JobStatus.IGNORED and session.get(type(a),a.id).status==JobStatus.APPLIED
    assert client.post('/api/jobs/bulk-status',json={'job_ids':[b.id],'status':'CLOSED'}).status_code==422
    assert client.post('/api/jobs/bulk-status',json={'job_ids':[],'status':'APPLIED'}).status_code==422
