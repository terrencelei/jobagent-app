"""Handshake is read with his own signed-in browser session; a lapsed session pauses the channel."""
from datetime import datetime, timedelta, timezone

import pytest

from jobagent import settings
from jobagent.discovery import handshake
from jobagent.discovery.handshake import due, login, check_session, probe, signed_in_url
from jobagent.discovery.source_health import probe_source


class FakePage:
    def __init__(self, urls, saml=0):
        self.urls, self.saml, self.url = list(urls), saml, ''
        self.goto_calls = []

    def goto(self, url, **kw):
        self.goto_calls.append(url); self.url = url

    def wait_for_timeout(self, ms):
        if self.urls:
            self.url = self.urls.pop(0)

    def locator(self, selector):
        page = self
        class L:
            def count(self): return page.saml
        return L()

    def close(self): pass


class FakeContext:
    def __init__(self, page):
        self.pages = [page]; self.page = page
    def new_page(self): return self.page


def browser_factory(page):
    class B:
        def __init__(self, headless=True): self.headless = headless
        def __enter__(self): self.context = FakeContext(page); return self
        def __exit__(self, *a): pass
    return B


@pytest.mark.parametrize('url, ok', [
    ('https://app.joinhandshake.com/stu/postings', True),
    ('https://app.joinhandshake.com/job-search/?query=x', True),
    ('https://utexas.joinhandshake.com/login', False),
    ('https://utexas.joinhandshake.com/auth/saml/348/session/new', False),
    ('https://sso.utexas.edu/idp/profile/SAML2/Redirect/SSO', False),
    ('https://api-xxxx.duosecurity.com/frame/v4/auth', False),
])
def test_signed_in_urls(url, ok):
    assert signed_in_url(url) is ok


def test_login_waits_for_the_app_and_records_the_session():
    page = FakePage(['https://utexas.joinhandshake.com/login', 'https://sso.utexas.edu/idp/login', 'https://app.joinhandshake.com/stu'])
    handshake.profile_dir().mkdir(parents=True, exist_ok=True)
    ok, message = login(1, browser_factory(page), log=lambda *a: None)
    assert ok and 'Signed in' in message
    assert page.goto_calls == [handshake.login_url()]
    assert handshake.load_state()['signed_in_at'] and due()[0]
    assert probe().health == 'working' and probe_source('handshake', handshake.source_target()).health == 'working'


def test_no_sign_in_in_time_saves_nothing(monkeypatch):
    monkeypatch.setattr(handshake.time, 'time', iter(range(0, 10_000, 100)).__next__)
    page = FakePage(['https://utexas.joinhandshake.com/login'] * 50)
    ok, message = login(1, browser_factory(page), log=lambda *a: None)
    assert not ok and 'nothing was saved' in message
    assert 'signed_in_at' not in handshake.load_state()


def test_without_a_session_the_channel_waits_and_says_so():
    ready, reason = due()
    assert not ready and 'handshake-login' in reason
    assert probe().health == 'blocked' and 'needs a sign-in' in probe().detail
    handshake.profile_dir().mkdir(parents=True, exist_ok=True)
    handshake.mark_signed_in()
    assert due() == (True, '')
    ok, detail = check_session(browser_factory(FakePage(['https://utexas.joinhandshake.com/login'])))
    assert not ok and 'lapsed' in detail and not due()[0] and probe().health == 'blocked'
    ok, detail = check_session(browser_factory(FakePage(['https://app.joinhandshake.com/stu'])))
    assert ok and due()[0]
    handshake.logout()
    assert not handshake.profile_dir().exists() and 'handshake-login' in due()[1]


def test_interval_pause_and_setting():
    handshake.profile_dir().mkdir(parents=True, exist_ok=True)
    handshake.mark_signed_in()
    now = datetime(2026, 10, 22, 12, tzinfo=timezone.utc)
    handshake.save_state({**handshake.load_state(), 'last_scan_at': (now - timedelta(hours=1)).isoformat()})
    assert due(now)[1] == 'not due yet' and due(now, force=True)[0] and due(now + timedelta(hours=7))[0]
    message = handshake.pause('refused a request (HTTP 429)')
    assert 'paused until' in message and not due(force=True)[0]
    settings.save({'handshake.enabled': False})
    assert 'off in Settings' in due(now)[1]
    settings.save({'handshake.enabled': True})


from unittest.mock import MagicMock
from jobagent.config import HandshakeSearch
from jobagent.discovery.handshake import HandshakeScraper, Refused


def hs_job(job_id='1', title='Mechanical Engineer I', company='Example Corp', apply_type='EXTERNAL', url='https://boards.greenhouse.io/example/jobs/123',
           city='Austin', state='Texas', country='United States', created='2026-10-20T10:00:00-07:00', job_type='JOB', employment='FULL_TIME', remote=False,
           salary=None, html='<p>Required: BS in Mechanical Engineering.</p>'):
    return {'node': {'id': job_id, 'job': {
        'id': job_id, 'title': title, 'createdAt': created, 'expirationDate': '2026-11-20T00:00:00-07:00', 'remote': remote, 'onSite': not remote, 'hybrid': False,
        'description': html, 'jobType': {'behaviorIdentifier': job_type, 'name': job_type.title()},
        'employmentType': {'behaviorIdentifier': employment, 'name': employment.title()},
        'locations': [{'name': f'{city}, {state}, {country}', 'city': city, 'state': state, 'country': country}] if city else [],
        'employer': {'id': '9', 'name': company},
        'salaryRange': salary or {'min': 9000000, 'max': 11000000, 'currency': 'USD', 'paySchedule': {'behaviorIdentifier': 'YEARLY'}},
        'jobApplySetting': {'applyType': apply_type, 'externalApplyType': 'URL', 'externalUrl': url, 'alternativeExternalUrl': None},
        'atsIntegrated': False, 'atsProvider': None}}}


class FakeSession:
    pages = {}
    signed_in = True
    calls = []

    def __enter__(self): return self
    def __exit__(self, *a): pass

    def search(self, query, after, first):
        FakeSession.calls.append((query, after, first))
        result = FakeSession.pages[(query, after)]
        if isinstance(result, Exception):
            raise result
        return result


def scraper_with(pages, resolver=None, signed_in=True, queries=('mechanical engineer',)):
    FakeSession.pages, FakeSession.signed_in, FakeSession.calls = pages, signed_in, []
    resolver = resolver or MagicMock(error=None, lookup=lambda lead: None)
    return HandshakeScraper(HandshakeSearch(queries=list(queries)), resolver=resolver, session_factory=FakeSession, request_delay=0)


def test_employer_links_become_records_and_handshake_only_jobs_become_leads(monkeypatch):
    settings.save({'handshake.max_agent_searches_per_run': 0})
    handshake.profile_dir().mkdir(parents=True, exist_ok=True); handshake.mark_signed_in()
    monkeypatch.setattr(handshake, 'datetime', type('D', (), {'now': staticmethod(lambda tz=None: datetime(2026, 10, 21, 12, tzinfo=timezone.utc)),
                                                              'fromisoformat': staticmethod(datetime.fromisoformat)}))
    page = {'totalCount': 9, 'pageInfo': {'hasNextPage': False, 'endCursor': 'x'}, 'edges': [
        hs_job(),                                                                                         # employer link
        hs_job('2', apply_type='HANDSHAKE', url=None, company='Salient Motion', title='Mechanical Design Engineer', city='Hawthorne', state='California'),
        hs_job('3', apply_type='HANDSHAKE_AND_EXTERNAL', url='https://jobs.ashbyhq.com/relling/abc', company='Relling', title='Mechatronics Engineer - New Grad'),
        hs_job('4', title='Mechanical Engineering Intern', job_type='INTERNSHIP'),
        hs_job('5', title='Senior Mechanical Engineer', url='https://example.com/5'),
        hs_job('6', city='Toronto', state='Ontario', country='Canada', url='https://example.com/6'),
        hs_job('7', company='Known Co', title='Mechanical Engineer', url='https://example.com/7'),
        hs_job('8', apply_type='EXTERNAL', url='https://www.linkedin.com/jobs/view/8', company='Board Co', title='Manufacturing Engineer'),  # a job-board link is not an employer link
        hs_job('9', created='2026-09-01T10:00:00-07:00', url='https://example.com/9'),                     # older than the window: reading stops
    ]}
    resolver = MagicMock(error=None)
    resolver.lookup = lambda lead: ({'company_name': lead['company'], 'title': lead['title'], 'canonical_url': 'https://salient.example/1',
                                     'raw_source_data': {'source': 'handshake', 'resolved_by': 'indeed'}} if lead['company'] == 'Salient Motion' else None)
    scraper = scraper_with({('mechanical engineer', None): page}, resolver)
    scraper.known = {('known co', 'mechanical engineer')}
    records = scraper.discover_jobs()
    assert [r['company_name'] for r in records] == ['Example Corp', 'Relling', 'Salient Motion']
    first = records[0]
    assert first['canonical_url'] == 'https://boards.greenhouse.io/example/jobs/123' and first['source_ats'] == 'greenhouse'
    assert first['location'] == 'Austin, Texas' and first['employment_type'] == 'Full-time'
    assert (first['salary_raw'], first['salary_min'], first['salary_max']) == ('$90,000 - $110,000 a year', 90000.0, 110000.0)
    assert first['posting_date'] == datetime.fromisoformat('2026-10-20T10:00:00-07:00')
    assert first['raw_source_data']['handshake_url'] == 'https://utexas.joinhandshake.com/jobs/1' and first['raw_source_data']['apply_type'] == 'EXTERNAL'
    assert records[2]['raw_source_data']['handshake_url'] == 'https://utexas.joinhandshake.com/jobs/2'
    r = scraper.report
    assert (r['results'], r['employer_link'], r['handshake_only'], r['off_track'], r['outside_us'], r['known'], r['by_indeed'], r['unresolved']) == (8, 2, 2, 2, 1, 1, 1, 1)
    assert handshake.load_state()['unresolved'][0]['company'] == 'Board Co'
    assert FakeSession.calls == [('mechanical engineer', None, 25)]
    assert scraper.last_error is None


def test_paging_follows_the_cursor_up_to_the_results_wanted():
    settings.save({'handshake.results_per_query': 30, 'handshake.max_agent_searches_per_run': 0})
    handshake.profile_dir().mkdir(parents=True, exist_ok=True); handshake.mark_signed_in()
    now = datetime.now(timezone.utc).isoformat()
    p1 = {'pageInfo': {'hasNextPage': True, 'endCursor': 'c1'}, 'edges': [hs_job(str(i), title='Software Engineer', created=now) for i in range(25)]}
    p2 = {'pageInfo': {'hasNextPage': True, 'endCursor': 'c2'}, 'edges': [hs_job(str(i), title='Software Engineer', created=now) for i in range(25, 30)]}
    scraper = scraper_with({('mechanical engineer', None): p1, ('mechanical engineer', 'c1'): p2})
    scraper.discover_jobs()
    assert [(a, f) for _, a, f in FakeSession.calls] == [(None, 25), ('c1', 5)] and scraper.truncated


def test_a_lapsed_session_or_a_refusal_pauses_the_channel():
    settings.save({'handshake.max_agent_searches_per_run': 0})
    handshake.profile_dir().mkdir(parents=True, exist_ok=True); handshake.mark_signed_in()
    scraper = scraper_with({}, signed_in=False)
    assert scraper.discover_jobs() == [] and 'lapsed' in scraper.last_error and 'handshake-login' in due()[1]
    handshake.mark_signed_in()
    scraper = scraper_with({('mechanical engineer', None): Refused(403)})
    assert scraper.discover_jobs() == [] and 'refused' in scraper.last_error and 'paused' in due(force=True)[1]
    assert probe().health == 'blocked'
