from contextlib import contextmanager
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from jobagent.db.models import Base, SourceRecord
from jobagent.agents import source_agent, source_research
from jobagent.discovery.source_health import HealthResult


@pytest.fixture
def db(monkeypatch):
    engine=create_engine('sqlite://');Base.metadata.create_all(engine)
    session=sessionmaker(bind=engine,expire_on_commit=False)()
    @contextmanager
    def scope():
        yield session
        session.commit()
    monkeypatch.setattr(source_agent,'get_db_session',scope)
    monkeypatch.setattr(source_agent,'update_overrides',Mock())
    monkeypatch.setattr(source_agent,'public_url',lambda x:x)
    yield session
    session.close();engine.dispose()


def test_name_only_researches_and_adds_first_working_board(db,monkeypatch):
    monkeypatch.setattr(source_research,'research',lambda name:(['https://jobs.lever.co/wrong','https://job-boards.greenhouse.io/flyzipline'],''))
    probe=Mock(side_effect=[HealthResult('missing','404'),HealthResult('working','parsed',12)])
    monkeypatch.setattr(source_agent,'probe_source',probe)
    result=source_agent.SourceManagementAgent().add('Zipline')
    source=db.get(SourceRecord,result['source_id'])
    assert source.ats_type=='greenhouse' and source.target['board_token']=='flyzipline' and source.enabled
    assert 'Found Zipline' in result['message']


def test_name_only_reports_every_failed_candidate(db,monkeypatch):
    monkeypatch.setattr(source_research,'research',lambda name:(['https://jobs.lever.co/nope'],''))
    monkeypatch.setattr(source_agent,'probe_source',Mock(return_value=HealthResult('missing','404')))
    with pytest.raises(ValueError,match='jobs.lever.co/nope'):
        source_agent.SourceManagementAgent().add('Nope')
    assert not db.query(SourceRecord).count()


def test_name_only_skips_research_for_an_active_source(db,monkeypatch):
    db.add(SourceRecord(key='k',company_name='Zipline',ats_type='greenhouse',target={'career_url':'https://job-boards.greenhouse.io/flyzipline'},enabled=True));db.commit()
    monkeypatch.setattr(source_research,'research',Mock(side_effect=AssertionError('no research')))
    assert 'already an active source' in source_agent.SourceManagementAgent().add('zipline')['message']


def test_greenhouse_api_url_is_recognised():
    ats,target=source_agent.infer_adapter('Zipline','https://boards-api.greenhouse.io/v1/boards/flyzipline/jobs')
    assert ats=='greenhouse' and target['board_token']=='flyzipline'


def test_research_uses_claude_web_tools_only_without_api_keys(monkeypatch):
    monkeypatch.setenv('ANTHROPIC_API_KEY','secret')
    monkeypatch.setattr(source_research,'_cli',lambda name:'/bin/'+name)
    calls=[]
    def run(args,**kw):
        calls.append((args,kw))
        out={'is_error':False,'structured_output':{'found':True,'candidates':[{'url':'https://jobs.lever.co/x','reason':''},{'url':'javascript:alert(1)','reason':''}],'note':''}}
        return SimpleNamespace(returncode=0,stdout=json.dumps(out),stderr='')
    urls,_=source_research.research('X',run=run)
    args,kw=calls[0]
    assert urls==['https://jobs.lever.co/x']
    assert args[args.index('--tools')+1]=='WebSearch,WebFetch' and '--strict-mcp-config' in args
    assert 'ANTHROPIC_API_KEY' not in kw['env']


def test_research_falls_back_to_codex_then_explains(monkeypatch):
    monkeypatch.setattr(source_research,'_cli',lambda name:None)
    with pytest.raises(RuntimeError,match='Paste the careers URL'):
        source_research.research('X',run=Mock())


def test_direct_posting_text_drops_page_chrome():
    from jobagent.scrapers.company_sites import posting_text
    html='<html><header>Menu</header><script>x=1</script><main><h1>Mechanical Engineer</h1><p>Bachelor’s degree required.</p></main><footer>© Co</footer></html>'
    text=posting_text(html)
    assert 'Mechanical Engineer' in text and 'Bachelor' in text and 'Menu' not in text and 'x=1' not in text and '©' not in text
