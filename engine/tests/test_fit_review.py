import json
from types import SimpleNamespace

from jobagent.services import fit_review


def job(**kw):
    return SimpleNamespace(**{'company_name': 'Siemens', 'title': 'Sales Orchestrator', 'location': 'US', 'salary_raw': None,
                              'description': 'Sell automation products.', 'description_hash': 'h1', **kw})


def test_review_reads_the_posting_with_his_background_and_no_tools(monkeypatch):
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'secret')
    monkeypatch.setattr(fit_review, '_cli', lambda name: '/bin/' + name)
    calls = []
    def run(args, **kw):
        calls.append((args, kw))
        out = {'is_error': False, 'structured_output': {'fit': False, 'work': 'Sells products.', 'reason': 'Sales, not engineering.', 'missing_requirements': []}}
        return SimpleNamespace(returncode=0, stdout=json.dumps(out), stderr='')
    verdict = fit_review.review_posting(job(), 'BS Mechanical Engineering', run)
    args, kw = calls[0]
    assert verdict['fit'] is False and verdict['hash'] == 'h1' and verdict['engine'] == 'claude'
    assert args[args.index('--tools') + 1] == '' and '--strict-mcp-config' in args
    assert 'Sales Orchestrator' in kw['input'] and 'BS Mechanical Engineering' in kw['input']
    assert 'ANTHROPIC_API_KEY' not in kw['env']


def test_a_verdict_only_counts_for_the_text_it_read():
    assert fit_review.current({'fit': True, 'hash': 'h1'}, 'h1')
    assert not fit_review.current({'fit': True, 'hash': 'h1'}, 'h2')
    assert not fit_review.current(None, 'h1')


def test_candidate_summary_names_his_majors():
    text = fit_review.candidate_summary()
    assert 'Mechanical Engineering' in text and 'Statistics' in text


def test_reviewer_is_told_titles_and_listed_tools_are_not_decisive():
    from jobagent.processing.tracks import get_track
    for key in ('mechanical', 'data'):
        text = fit_review.instructions(get_track(key))
        assert 'title is not decisive' in text and 'MSC Adams' in text and get_track(key).label in text


def test_his_labels_become_examples_and_a_version(monkeypatch):
    from contextlib import contextmanager
    from datetime import datetime, timedelta, timezone
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from jobagent.db.models import Base, Job, EligibilityStatus
    engine = create_engine('sqlite://'); Base.metadata.create_all(engine)
    old = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
    new = datetime.now(timezone.utc).isoformat()
    with Session(engine) as s:
        for i, label, review in [(1, {'fit': False, 'note': 'builds Adams', 'labeled_at': old}, {'fit': True, 'work': 'Develops Adams'}),
                                 (2, {'fit': True, 'note': '', 'labeled_at': old}, None),
                                 (3, {'fit': True, 'note': '', 'labeled_at': new}, None)]:   # not settled yet
            s.add(Job(id=i, company_name='Co', title=f'T{i}', description='d', canonical_url=f'https://x/{i}', application_url=f'https://x/{i}',
                      source_ats='direct', eligibility=EligibilityStatus.ELIGIBLE, user_fit_label=label, fit_review=review))
        s.commit()
        examples, version = fit_review.learnings(s)
    assert [e['title'] for e in examples] == ['T1', 'T2'] and examples[0]['reviewer_disagreed'] and examples[0]['his_note'] == 'builds Adams'
    assert version == old
    assert 'builds Adams' in fit_review.posting_prompt(job(), 'BSME', examples)
    assert not fit_review.current({'hash': 'h', 'labels_version': ''}, 'h', old)
    assert fit_review.current({'hash': 'h', 'labels_version': old}, 'h', old)


def test_fit_label_api_saves_and_clears(monkeypatch):
    from contextlib import contextmanager
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from sqlalchemy.pool import StaticPool
    from jobagent.db.models import Base, Job, EligibilityStatus
    from jobagent.ui import server
    engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool); Base.metadata.create_all(engine)
    with Session(engine) as s:
        s.add(Job(id=7, company_name='Co', title='T', description='d', canonical_url='https://x/7', application_url='https://x/7',
                  source_ats='direct', eligibility=EligibilityStatus.ELIGIBLE)); s.commit()
    @contextmanager
    def scope():
        with Session(engine) as s:
            yield s
    monkeypatch.setattr(server, 'get_db_session', scope)
    tuned = []
    monkeypatch.setattr(server, 'tune_later', tuned.append)
    app = TestClient(server.app)
    r = app.post('/api/jobs/7/fit-label', json={'fit': False, 'note': 'software role'})
    assert r.status_code == 200 and r.json()['label']['fit'] is False
    with Session(engine) as s:
        assert s.get(Job, 7).user_fit_label['mechanical']['note'] == 'software role'
    assert app.post('/api/jobs/7/fit-label', json={'fit': None}).json()['label'] is None
    assert tuned == ['mechanical', 'mechanical']


def test_possible_masters_does_not_establish_enrollment():
    text = fit_review.candidate_summary()
    assert "master's" in text and 'unconfirmed' in text
    policy = fit_review.instructions()
    assert 'considering' in policy and 'enrollment' in policy
