from contextlib import contextmanager
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from jobagent.db.models import Base, Job, JobStatus, EligibilityStatus, SourceRecord, WatchAlert, utc_now
from jobagent.agents import source_agent as agent
from jobagent.discovery import source_catalog as catalog, source_health as health
from jobagent.services.watch import process_watches, deliver_pending
from jobagent.ui import server


@pytest.fixture
def db(monkeypatch, tmp_path):
    engine=create_engine(f'sqlite:///{tmp_path}/sources.db',connect_args={'check_same_thread':False})
    Base.metadata.create_all(engine)
    session=sessionmaker(bind=engine,autoflush=False,expire_on_commit=False)()
    @contextmanager
    def session_scope():
        yield session
        session.commit()
    monkeypatch.setattr(agent,'get_db_session',session_scope)
    # Source tasks run inline: a background task outliving the test would use this database after teardown.
    from concurrent.futures import Future
    class Inline:
        def submit(self, fn, *args, **kwargs):
            future = Future()
            try:
                future.set_result(fn(*args, **kwargs))
            except Exception as error:
                future.set_exception(error)
            return future
    monkeypatch.setattr(agent, '_executor', Inline())
    monkeypatch.setattr(server,'get_db_session',session_scope)
    monkeypatch.setattr(catalog,'get_settings',lambda:SimpleNamespace(config_dir=tmp_path))
    yield session
    session.close();engine.dispose()


def job(db, **kwargs):
    values=dict(company_name='Example',title='Mechanical Engineer',normalized_title='mechanical engineer',
                canonical_url=f'https://example.com/jobs/{db.query(Job).count()}',application_url='https://example.com/apply',
                description='BS Mechanical Engineering',source_ats='direct',status=JobStatus.NEW,
                role_type='FULL_TIME',eligibility=EligibilityStatus.ELIGIBLE,relevance_score=1,discovery_date=utc_now())
    values.update(kwargs)
    j=Job(**values);db.add(j);db.flush();return j


class Sender:
    ready=True
    fail=False
    def __init__(self):self.messages=[]
    def available(self):return self.ready
    def send(self,subject,body):
        self.messages.append((subject,body))
        if self.fail:raise RuntimeError('handoff uncertain')


RESULT=[{'company':'Example','jobs_found':1,'error':None}]


def baseline(db):
    watch=agent.set_watch(db,'Example',True)
    process_watches(db,RESULT,sender=Sender(),now=utc_now()-timedelta(seconds=2))
    return watch


def test_watch_baseline_and_all_eligible_low_score_dedup(db):
    job(db,discovery_date=utc_now()-timedelta(days=1))
    sender=Sender();watch=agent.set_watch(db,'Example',True)
    process_watches(db,RESULT,sender=sender)
    assert not sender.messages and watch.baseline_at
    job(db)
    job(db,eligibility=EligibilityStatus.INELIGIBLE)
    job(db,status=JobStatus.APPLIED)
    job(db,role_type='INTERNSHIP')
    job(db,posting_date=utc_now()-timedelta(days=10))
    process_watches(db,RESULT,sender=sender)
    process_watches(db,RESULT,sender=sender)
    assert len(sender.messages)==1
    assert db.query(WatchAlert).count()==1
    assert 'Fit: 1/100' in sender.messages[0][1]


def test_unavailable_retry_and_disabled_cancels(db):
    baseline(db);job(db);sender=Sender();sender.ready=False
    process_watches(db,RESULT,sender=sender)
    assert db.query(WatchAlert).one().status=='pending'
    sender.ready=True;deliver_pending(db,sender=sender)
    assert len(sender.messages)==1
    job(db);sender.ready=False;process_watches(db,RESULT,sender=sender)
    agent.set_watch(db,'Example',False);db.commit()
    agent.set_watch(db,'Example',True);db.commit()
    sender.ready=True;deliver_pending(db,sender=sender)
    assert len(sender.messages)==1
    assert db.query(WatchAlert).filter_by(status='cancelled').count()==1


def test_uncertain_handoff_never_resends(db):
    baseline(db);job(db);sender=Sender();sender.fail=True
    process_watches(db,RESULT,sender=sender)
    assert db.query(WatchAlert).one().status=='uncertain'
    process_watches(db,RESULT,sender=sender)
    assert len(sender.messages)==1


def test_failed_scan_does_not_baseline_or_alert(db):
    watch=agent.set_watch(db,'Example',True);sender=Sender();job(db)
    process_watches(db,[{'company':'Example','jobs_found':0,'error':'offline'}],sender=sender)
    assert watch.baseline_at is None and watch.last_error and not sender.messages


def test_pending_now_ineligible_is_cancelled(db):
    baseline(db);j=job(db);sender=Sender();sender.ready=False
    process_watches(db,RESULT,sender=sender)
    j.status=JobStatus.APPLIED;db.commit();sender.ready=True
    deliver_pending(db,sender=sender)
    assert not sender.messages and db.query(WatchAlert).one().status=='cancelled'


def test_agent_persists_verified_source_and_removal(db, monkeypatch):
    monkeypatch.setattr(agent,'public_url',lambda u:u)
    monkeypatch.setattr(agent,'probe_source',lambda *a:health.HealthResult('working','verified',2))
    manager=agent.SourceManagementAgent()
    result=manager.add('Example','https://jobs.lever.co/example',watch=True)
    source=db.get(SourceRecord,result['source_id'])
    assert source.enabled and source.ats_type=='lever'
    assert catalog.read_overrides()['added'][0]['target']['company_slug']=='example'
    manager.add('Example','https://jobs.lever.co/example')
    assert db.query(SourceRecord).count()==1
    manager.remove(source.id)
    assert source.key in catalog.read_overrides()['disabled'] and not source.enabled
    manager.recheck(source.id)
    assert source.enabled and not catalog.read_overrides()['disabled']


def test_failed_add_does_not_change_config(db,monkeypatch):
    monkeypatch.setattr(agent,'public_url',lambda u:u)
    monkeypatch.setattr(agent,'probe_source',lambda *a:health.HealthResult('missing','HTTP 404'))
    with pytest.raises(ValueError):agent.SourceManagementAgent().add('Bad','https://jobs.lever.co/bad')
    assert not db.query(SourceRecord).count() and not catalog.read_overrides()['added']


@pytest.mark.parametrize('payload,expected',[({'jobs':[]},'empty'),({'message':'OK'},'unreadable'),({'jobs':[{'id':1}]},'working')])
def test_probe_schema_not_just_http_200(monkeypatch,payload,expected):
    monkeypatch.setattr(health,'get_public',lambda *a,**k:httpx.Response(200,json=payload))
    assert health.probe_source('greenhouse',{'board_token':'example'}).health==expected


def test_private_redirect_rejected(monkeypatch):
    def addresses(host,*a,**k):return [(2,1,6,'',('127.0.0.1' if host=='localhost' else '8.8.8.8',443))]
    monkeypatch.setattr(health.socket,'getaddrinfo',addresses)
    client=Mock();client.get.return_value=httpx.Response(302,headers={'location':'http://localhost/private'})
    with pytest.raises(ValueError,match='public website'):health.get_public(client,'https://example.com')
    assert client.get.call_count==1


def test_direct_scraper_extracts_job_link():
    from jobagent.scrapers.company_sites import CompanyCareerScraper
    scraper=CompanyCareerScraper(request_delay=0)
    scraper.get_with_retry=lambda *a:httpx.Response(200,text='<a href="/jobs/123">Mechanical Engineer</a>')
    try:
        jobs=scraper.discover_jobs({'name':'Example','career_url':'https://example.com/careers'})
        assert len(jobs)==1 and 'Employer requirements not fetched.' in jobs[0]['description']
    finally:scraper.close()


def test_sources_api_toggle_and_task_validation(db,monkeypatch):
    from jobagent.services import watch
    monkeypatch.setattr(watch,'notification_status',lambda s:{'recipient':'test@example.com'})
    source=SourceRecord(key='x',company_name='Example',ats_type='lever',target={'career_url':'https://jobs.lever.co/example'},enabled=True)
    db.add(source);db.commit()
    monkeypatch.setattr(agent,'queue_task',lambda kind,payload:42)
    with TestClient(server.app) as client:
        assert len(client.get('/api/sources').json()['sources'])==1
        assert client.post('/api/watches',json={'company':'Example','enabled':True}).json()['enabled']
        assert client.post('/api/watches',json={'company':'Unknown','enabled':True}).status_code==422
        assert client.post('/api/sources',json={'name':'Example','url':'https://jobs.lever.co/example'}).json()['task_id']==42
        assert client.post('/api/sources',json={'name':'Example','url':'https://jobs.lever.co/example'},headers={'Origin':'https://evil.example'}).status_code==403
        assert client.post('/api/sources/999/remove').status_code==404
        assert client.get('/api/source-tasks/999').status_code==404


def test_seed_keeps_removed_sources_disabled_and_multiple_searches(db):
    target=catalog.source_target('Example','lever','example')
    key=catalog.source_key('lever',target)
    catalog.update_overrides(disabled=[key])
    config=SimpleNamespace(target_companies={'lever':[{'name':'Example','company_slug':'example'}],
        'siemens':[{'name':'Siemens','career_url':'https://jobs.siemens.com/SearchJobs/mechanical'},
                   {'name':'Siemens','career_url':'https://jobs.siemens.com/SearchJobs/graduate'}]},github_sources=[])
    catalog.seed_sources(db,config);db.commit();catalog.seed_sources(db,config)
    assert db.query(SourceRecord).count()==3
    assert not db.query(SourceRecord).filter_by(key=key).one().enabled


def test_discovery_uses_only_enabled_catalog_sources(db,monkeypatch):
    from jobagent.discovery import search_agent
    from jobagent.config import SearchConfig
    for name,enabled in [('Working',True),('Broken',False)]:
        db.add(SourceRecord(key=name,company_name=name,ats_type='lever',target={'name':name,'company_slug':name},enabled=enabled))
    db.commit()
    scraper=Mock(last_error=None,truncated=False);scraper.discover_jobs.return_value=[]
    monkeypatch.setattr(search_agent,'get_scraper_for_ats',lambda ats:scraper)
    result=search_agent.SearchAgent(db,SearchConfig(cadence={},query_templates={},target_companies={},locations={})).run_discovery()
    assert result['sources_checked']==1
    assert scraper.discover_jobs.call_args.args[0]['name']=='Working'


def test_seed_updates_configured_limits_without_restoring_removed_source(db):
    from jobagent.config import GitHubSource
    source=GitHubSource(repository='example/jobs',max_jobs=100)
    config=SimpleNamespace(target_companies={},github_sources=[source])
    catalog.seed_sources(db,config);db.commit()
    record=db.query(SourceRecord).one()
    catalog.update_overrides(disabled=[record.key])
    config.github_sources=[source.model_copy(update={'max_jobs':500})]
    catalog.seed_sources(db,config)
    assert record.target['max_jobs']==500 and not record.enabled


def test_watch_all_active_sources_and_one_digest_email(db):
    session = db
    from jobagent.db.models import SourceRecord, CompanyWatch, WatchAlert, Job, JobStatus, EligibilityStatus
    from jobagent.services.watch import watch_all, deliver_pending
    for i, (name, ats, enabled) in enumerate([('Acme', 'greenhouse', True), ('Bolt', 'lever', True), ('Gone', 'lever', False), ('Repo', 'github', True)]):
        session.add(SourceRecord(key=f'k{i}', company_name=name, ats_type=ats, target={}, enabled=enabled))
    session.commit()
    assert watch_all(session, True) == 2
    assert {w.company_name for w in session.query(CompanyWatch).filter_by(enabled=True)} == {'Acme', 'Bolt'}
    assert watch_all(session, True) == 0
    for watch in session.query(CompanyWatch):
        job = Job(company_name=watch.company_name, title='Engineer', description='d', canonical_url=f'https://x/{watch.company_name}',
                  application_url=f'https://x/{watch.company_name}', source_ats='direct', role_type='FULL_TIME',
                  status=JobStatus.NEW, eligibility=EligibilityStatus.STRONG_MATCH, relevance_score=80)
        session.add(job); session.flush()
        session.add(WatchAlert(watch_id=watch.id, job_id=job.id, status='pending'))
    session.commit()
    sent = []
    class Sender:
        def available(self): return True
        def send(self, subject, body): sent.append((subject, body))
    deliver_pending(session, sender=Sender())
    assert len(sent) == 1 and sent[0][0] == 'JobAgent: 2 new eligible roles at 2 companies'
    assert '== Acme ==' in sent[0][1] and '== Bolt ==' in sent[0][1]
    assert watch_all(session, False) == 2 and not session.query(CompanyWatch).filter_by(enabled=True).count()

def test_discovery_runs_continuously():
    from jobagent.services.scheduler import discovery_interval_minutes, RefreshScheduler
    assert discovery_interval_minutes({'discovery_interval_minutes': 15}) == 15
    assert discovery_interval_minutes({'discovery_interval_hours': 1}) == 60
    scheduler = RefreshScheduler(blocking=False)
    job = scheduler.scheduler.get_job('job_discovery')
    assert job.trigger.interval.total_seconds() == 15 * 60 and job.max_instances == 1 and job.coalesce


def test_breezy_board_url_is_detected_and_probed(monkeypatch):
    from jobagent.agents.source_agent import infer_adapter
    ats, target = infer_adapter('Planted Solar', 'https://planted-solar-inc.breezy.hr/')
    assert ats == 'breezy' and target['company_slug'] == 'planted-solar-inc'
    assert target['career_url'] == 'https://planted-solar-inc.breezy.hr'
    monkeypatch.setattr(health, 'get_public', lambda client, url, **k: httpx.Response(200, json=[{'id': 'a'}] if url.endswith('/json') else {}))
    assert health.probe_source('breezy', target).health == 'working'
    monkeypatch.setattr(health, 'get_public', lambda *a, **k: httpx.Response(200, json=[]))
    assert health.probe_source('breezy', target).health == 'empty'


def test_smartrecruiters_adapter_inference_and_health(monkeypatch):
    ats, target = agent.infer_adapter('Arista Networks','https://jobs.smartrecruiters.com/AristaNetworks')
    assert ats == 'smartrecruiters'
    assert target['company_slug'] == 'AristaNetworks'
    monkeypatch.setattr(health,'get_public',lambda *args,**kwargs: Mock(status_code=200,json=lambda: {'content':[{'id':'123'}]}))
    assert health.probe_source(ats,target).working
