from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from jobagent.db.models import Base, SourceRecord, SourceTask
from jobagent.agents import source_repair as repair
from jobagent.discovery.source_health import HealthResult
from jobagent.discovery.source_catalog import source_key


@pytest.fixture
def db(monkeypatch):
    engine=create_engine('sqlite://');Base.metadata.create_all(engine)
    session=sessionmaker(bind=engine,expire_on_commit=False)()
    @contextmanager
    def scope():
        yield session
        session.commit()
    monkeypatch.setattr(repair,'get_db_session',scope)
    monkeypatch.setattr(repair,'update_overrides',Mock())
    monkeypatch.setattr(repair,'public_url',lambda x:x)
    target={'name':'Fixture','career_url':'https://example.com/old'}
    session.add(SourceRecord(key=source_key('direct',target),company_name='Fixture',ats_type='direct',target=target,enabled=True))
    session.commit()
    yield session
    session.close();engine.dispose()


def proposal(action='repair'):
    return {'action':action,'ats':'lever','url':'https://jobs.lever.co/fixture','reason':'Official careers link moved','repository':'','ref':'','path':''}


def test_repair_verified_and_persisted(db,monkeypatch):
    monkeypatch.setattr(repair,'propose',lambda *a:proposal())
    monkeypatch.setattr(repair,'probe_source',Mock(side_effect=[HealthResult('missing','404'),HealthResult('working','parsed',3)]))
    result=repair.repair(1,{'error':'404'})
    source=db.get(SourceRecord,1)
    assert result['outcome']=='repair' and source.enabled and source.ats_type=='lever'
    assert source.target['company_slug']=='fixture'
    assert repair.update_overrides.call_args.kwargs['disabled']


def test_unrepairable_removed_history_preserved(db,monkeypatch):
    monkeypatch.setattr(repair,'propose',lambda *a:proposal('remove'))
    monkeypatch.setattr(repair,'probe_source',lambda *a:HealthResult('missing','404'))
    assert repair.repair(1,{'error':'404'})['outcome']=='remove'
    assert db.get(SourceRecord,1).enabled is False
    assert db.query(SourceRecord).count()==1


def test_cli_failure_never_removes(db,monkeypatch):
    monkeypatch.setattr(repair,'propose',Mock(side_effect=RuntimeError('usage limit')))
    monkeypatch.setattr(repair,'probe_source',lambda *a:HealthResult('blocked','403'))
    assert repair.repair(1,{'error':'403'})['outcome']=='defer'
    assert db.get(SourceRecord,1).enabled
    repair.update_overrides.assert_not_called()


def test_healthy_empty_and_partial_retained_without_cli(db,monkeypatch):
    cli=Mock();monkeypatch.setattr(repair,'propose',cli)
    monkeypatch.setattr(repair,'probe_source',lambda *a:HealthResult('empty','No vacancies'))
    assert repair.repair(1,{'truncated':True})['outcome']=='keep'
    cli.assert_not_called()
    assert db.get(SourceRecord,1).health=='empty'


def test_failed_replacement_removed_only_if_original_still_broken(db,monkeypatch):
    monkeypatch.setattr(repair,'propose',lambda *a:proposal())
    monkeypatch.setattr(repair,'probe_source',Mock(side_effect=[HealthResult('missing','404'),HealthResult('missing','404'),HealthResult('working','recovered',2)]))
    assert repair.repair(1,{'error':'404'})['outcome']=='keep'
    assert db.get(SourceRecord,1).ats_type=='direct'
    repair.update_overrides.assert_not_called()


def test_scan_queue_deduplicated_and_includes_zero_results(db):
    rows=[{'source_id':1,'jobs_found':0,'error':None}]
    assert len(repair.schedule_repairs(db,rows))==1
    assert repair.schedule_repairs(db,rows)==[]
    assert db.query(SourceTask).one().kind=='repair'
    assert db.get(SourceRecord,1).health=='repair_queued'


def test_disabled_source_not_queued(db):
    db.get(SourceRecord,1).enabled=False
    assert repair.schedule_repairs(db,[{'source_id':1,'error':'404'}])==[]


def test_cli_auth_and_environment(monkeypatch,tmp_path):
    monkeypatch.setenv('OPENAI_API_KEY','secret');monkeypatch.setenv('CODEX_API_KEY','secret')
    def run(args,**kwargs):
        assert 'OPENAI_API_KEY' not in kwargs['env'] and 'CODEX_API_KEY' not in kwargs['env']
        if args[1]=='login':return SimpleNamespace(returncode=0,stdout='Logged in using API key',stderr='')
        pytest.fail('API authentication must not start the agent')
    monkeypatch.setattr(repair.subprocess,'run',run)
    with pytest.raises(RuntimeError,match='ChatGPT'):repair.propose({}, {})


def test_scan_exception_dispatches_repair_after_commit(db,monkeypatch):
    from jobagent.discovery import search_agent
    from jobagent.agents import source_agent
    from jobagent.config import SearchConfig
    monkeypatch.setattr(search_agent,'get_scraper_for_ats',Mock(side_effect=RuntimeError('broken adapter')))
    executor=Mock();monkeypatch.setattr(source_agent,'_executor',executor)
    scan=search_agent.SearchAgent(db,SearchConfig(cadence={},query_templates={},target_companies={},locations={}))
    scan.pipeline=SimpleNamespace(process_discovered_jobs=lambda *a,**kw:{'errors_count':0,'error_log':[]})
    result=scan.run_discovery()
    assert result['source_results'][0]['source_id']==1
    assert len(result['source_repair_tasks'])==1
    executor.submit.assert_called_once_with(source_agent.run_task,result['source_repair_tasks'][0])


def test_temporary_source_outage_deferred(db,monkeypatch):
    monkeypatch.setattr(repair,'propose',lambda *a:proposal('remove'))
    monkeypatch.setattr(repair,'probe_source',lambda *a:HealthResult('temporary_error','HTTP 429'))
    assert repair.repair(1,{'error':'429'})['outcome']=='defer'
    assert db.get(SourceRecord,1).enabled
