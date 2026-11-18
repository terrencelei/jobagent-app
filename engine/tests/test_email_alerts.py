import json
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from jobagent.db.models import Base, Job, EligibilityStatus
from jobagent.discovery import email_alerts as ea

POSTING_TEXT = ("Archer Aviation\nFlight Test Engineer\nSalinas, CA\n" + "Plan and run flight tests of the aircraft. " * 20 +
                "\nRequired: Bachelor's degree in Mechanical or Aerospace Engineering.")


@pytest.fixture
def session():
    engine = create_engine('sqlite:///:memory:'); Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    s.add(Job(company_name='Known Co', title='Mechanical Engineer', normalized_title='mechanical engineer', description='d',
              canonical_url='https://k/1', application_url='https://k/1', source_ats='direct', eligibility=EligibilityStatus.ELIGIBLE))
    s.commit()
    yield s
    s.close()


@pytest.fixture(autouse=True)
def no_indeed_network(monkeypatch):
    """The Indeed lookup (discovery/leads.py) must answer from a stub, never the network."""
    import httpx
    monkeypatch.setattr(httpx.Client, 'post', lambda self, url, json=None, **kw: httpx.Response(
        200, json={'data': {'jobSearch': {'pageInfo': {'nextCursor': None}, 'results': []}}}, request=httpx.Request('POST', url)))


class FakeReader:
    pages = {}
    def __enter__(self): return self
    def __exit__(self, *a): pass
    def read(self, url):
        return self.pages.get(url, (url, ''))


def fake_cli(emails, found):
    calls = []
    def run(args, **kw):
        calls.append((args, kw))
        if 'mcp__claude_ai_Gmail__search_threads' in args:
            out = {'emails': emails}
        else:
            out = {'candidates': found.get(json.loads(json.dumps(kw['input'])), []), 'note': ''}
            out['candidates'] = next((v for k, v in found.items() if k in kw['input']), [])
        return SimpleNamespace(returncode=0, stdout=json.dumps({'is_error': False, 'structured_output': out}), stderr='')
    run.calls = calls
    return run


def email(mid, *postings):
    return {'message_id': mid, 'sender': 'alerts@example.com', 'subject': 's', 'postings': list(postings)}


def post(company, title, url):
    return {'company': company, 'title': title, 'location': 'Salinas, CA', 'url': url}


def test_postings_are_found_by_link_or_by_agent_and_checked(session, monkeypatch):
    monkeypatch.setattr(ea, '_cli', lambda: '/bin/claude')
    FakeReader.pages = {
        'https://careers.acme.com/jobs/1': ('https://careers.acme.com/jobs/1', POSTING_TEXT.replace('Archer Aviation', 'Acme Robotics').replace('Flight Test Engineer', 'Robotics Test Engineer')),
        'https://job-boards.greenhouse.io/archer56/jobs/7985643003': ('https://job-boards.greenhouse.io/archer56/jobs/7985643003', POSTING_TEXT),
        'https://wrong.example.com/job': ('https://wrong.example.com/job', 'Some Other Company\nAccountant\n' + 'x ' * 400),
    }
    run = fake_cli([email('m1',
                          post('Acme Robotics', 'Robotics Test Engineer', 'https://careers.acme.com/jobs/1'),            # readable employer link
                          post('Archer', 'Flight Test Engineer', 'https://email.notifications.joinhandshake.com/c/abc'),  # login wall: agent
                          post('Nowhere Inc', 'Manufacturing Engineer', 'https://www.linkedin.com/comm/jobs/view/1'),    # agent finds only a wrong page
                          post('Known Co', 'Mechanical Engineer', 'https://x'),                                         # already stored
                          post('Etched', 'Mechanical / Thermal Intern', 'https://x'),                                    # internship
                          post('Big Co', 'Senior Mechanical Engineer', 'https://x'),                                    # senior
                          post('Bank', 'Accountant', 'https://x'))],                                                    # outside both searches
                   {'"Archer"': [{'url': 'https://www.linkedin.com/jobs/view/9', 'reason': ''},                          # board copy: never read
                                 {'url': 'https://job-boards.greenhouse.io/archer56/jobs/7985643003', 'reason': ''}],
                    '"Nowhere Inc"': [{'url': 'https://wrong.example.com/job', 'reason': ''}]})
    records, report = ea.collect(session, run, FakeReader)
    assert [(r['company_name'], r['raw_source_data']['found_by'], r['source_ats']) for r in records] == [
        ('Acme Robotics', 'link', 'email_alert'), ('Archer', 'agent', 'greenhouse')]
    assert report['by_link'] == 1 and report['by_agent'] == 1 and report['skipped'] == 4
    assert report['not_found'][0]['company'] == 'Nowhere Inc'
    gmail = [a for a, _ in run.calls if 'mcp__claude_ai_Gmail__search_threads' in a][0]
    assert gmail[gmail.index('--tools') + 1] == ''  # Gmail reads only, no built-in tools
    search = [a for a, _ in run.calls if 'WebSearch' in a][0]
    assert search[search.index('--tools') + 1] == 'WebSearch,WebFetch'


def test_each_email_is_handled_once(session, monkeypatch):
    monkeypatch.setattr(ea, '_cli', lambda: '/bin/claude')
    FakeReader.pages = {}
    run = fake_cli([email('m1')], {})
    ea.collect(session, run, FakeReader)
    assert 'm1' in ea.load_state()['processed_message_ids']
    _, report = ea.collect(session, run, FakeReader)
    assert report['emails'] == 0
    assert '"m1"' in [kw['input'] for a, kw in run.calls if 'mcp__claude_ai_Gmail__search_threads' in a][-1]


def test_agent_searches_are_capped_per_check(session, monkeypatch):
    from jobagent import settings
    monkeypatch.setattr(ea, '_cli', lambda: '/bin/claude')
    settings.save({'email.max_agent_searches_per_run': 1})
    FakeReader.pages = {}
    run = fake_cli([email('m2', post('A Co', 'Test Engineer', 'https://www.linkedin.com/a'), post('B Co', 'Test Engineer', 'https://www.linkedin.com/b'))], {})
    _, report = ea.collect(session, run, FakeReader)
    assert sum('WebSearch' in a for a, _ in run.calls) == 1 and len(report['not_found']) == 2


def test_page_must_name_the_company_and_carry_the_title():
    p = {'company': 'Archer Aviation Inc', 'title': 'Flight Test Engineer (Onsite)'}
    assert ea.matches(p, POSTING_TEXT, 'https://jobs.example.com/1')
    assert not ea.matches(p, POSTING_TEXT.replace('Archer', 'Joby'), 'https://jobs.example.com/1')
    assert not ea.matches(p, 'Archer\nSoftware Engineer', 'https://jobs.example.com/1')
    assert ea.is_aggregator('https://utexas.joinhandshake.com/login') and not ea.is_aggregator('https://job-boards.greenhouse.io/x')


def test_a_readable_job_board_copy_is_the_last_resort(session, monkeypatch):
    monkeypatch.setattr(ea, '_cli', lambda: '/bin/claude')
    board = 'https://www.ziprecruiter.com/km/abc'
    FakeReader.pages = {board: (board, POSTING_TEXT.replace('Archer Aviation', 'Crown Poly').replace('Flight Test Engineer', 'Mechanical Engineer'))}
    run = fake_cli([email('m3', post('Crown Poly, Inc.', 'Mechanical Engineer', board))], {})
    records, report = ea.collect(session, run, FakeReader)
    assert [(r['raw_source_data']['found_by'], r['source_ats']) for r in records] == [('job board', 'ziprecruiter')]
    assert sum('WebSearch' in a for a, _ in run.calls) == 1  # the employer's own posting was looked for first


def test_postings_found_during_a_source_scan_wait_for_it(session, monkeypatch):
    from contextlib import contextmanager
    from jobagent.services import scheduler
    monkeypatch.setattr(ea, 'collect', lambda s, run, reader: ([{'title': 'x'}], {'emails': 1}))
    @contextmanager
    def scope():
        yield session
    monkeypatch.setattr('jobagent.db.repository.get_db_session', scope)
    monkeypatch.setattr(scheduler, '_claim_discovery', lambda: False)
    report = ea.scan()
    assert report['waiting'] == 1 and ea.load_state()['pending_records'] == [{'title': 'x'}]
    added = []
    monkeypatch.setattr('jobagent.tracking.lifecycle.JobLifecyclePipeline.process_discovered_jobs', lambda self, recs: added.extend(recs) or {'new_jobs': len(recs)})
    ea.add_pending(session)
    assert added == [{'title': 'x'}] and 'pending_records' not in ea.load_state()


def test_a_board_posting_is_found_on_indeed_before_the_agent_and_old_ones_are_retried(session, monkeypatch):
    import httpx
    from test_indeed import job, response
    monkeypatch.setattr(ea, '_cli', lambda: '/bin/claude')
    FakeReader.pages = {}
    monkeypatch.setattr(httpx.Client, 'post', lambda self, url, json=None, **kw: response([
        job(company='Archer Aviation', title='Flight Test Engineer', city='Salinas', state='CA', url='https://boards.greenhouse.io/archer56/jobs/7985643003')]))
    run = fake_cli([email('m9', post('Archer Aviation', 'Flight Test Engineer', 'https://email.notifications.joinhandshake.com/c/abc'))], {})
    records, report = ea.collect(session, run, FakeReader)
    assert report['by_indeed'] == 1 and not any('WebSearch' in a for a, _ in run.calls)
    assert records[0]['source_ats'] == 'greenhouse' and records[0]['raw_source_data']['found_by'] == 'indeed'
    assert records[0]['raw_source_data']['message_id'] == 'm9' and records[0]['raw_source_data']['alert_url'].startswith('https://email.notifications')
    ea.save_state({**ea.load_state(), 'unresolved': [post('Archer Aviation', 'Flight Test Engineer', 'https://www.ziprecruiter.com/km/x'),
                                                     post('Known Co', 'Mechanical Engineer', 'https://www.ziprecruiter.com/km/y')]})
    records, report = ea.collect(session, fake_cli([], {}), FakeReader)
    assert report['by_indeed_retry'] == 1 and len(records) == 1 and ea.load_state()['unresolved'] == []
