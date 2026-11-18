"""LinkedIn's public search gives leads; postings come from Indeed or the agent, never LinkedIn itself."""
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from jobagent import settings
from jobagent.config import IndeedSearch, LinkedInSearch, SearchConfig
from jobagent.db.models import Base, Job, SourceRecord
from jobagent.discovery import linkedin
from jobagent.discovery.linkedin import SEARCH_URL, EMPTY_PAGE, LinkedInScraper, due, parse_cards, probe
from jobagent.discovery.search_agent import SearchAgent
from test_indeed import job, response


def card(job_id, title, company, location='Boston, MA', posted='2026-10-15'):
    return f'''<li><div class="base-card base-search-card" data-entity-urn="urn:li:jobPosting:{job_id}">
      <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/{job_id}"><span class="sr-only">{title}</span></a>
      <div class="base-search-card__info"><h3 class="base-search-card__title">{title}</h3>
      <h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="https://www.linkedin.com/company/x">{company}</a></h4>
      <div class="base-search-card__metadata"><span class="job-search-card__location">{location}</span>
      <time class="job-search-card__listdate" datetime="{posted}">6 days ago</time></div></div></div></li>'''


def page(*cards):
    return '<ul>' + ''.join(cards) + '</ul>'


def html(text, status=200, url=SEARCH_URL):
    return httpx.Response(status, text=text, request=httpx.Request('GET', url))


@pytest.fixture
def scraper():
    instance = LinkedInScraper(LinkedInSearch(queries=['mechanical engineer new grad']), request_delay=0)
    yield instance
    instance.close()


@pytest.fixture
def session():
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def test_cards_parse_and_a_blocked_page_is_told_from_an_empty_one():
    leads = parse_cards(page(card('11', 'Robotics Autonomy Engineer', 'Cleo Robotics'), card('12', 'Mechanical Engineer', 'Acme', 'Austin, TX', '2026-10-20')))
    assert [(l['id'], l['title'], l['company'], l['location'], l['posted'], l['url']) for l in leads] == [
        ('11', 'Robotics Autonomy Engineer', 'Cleo Robotics', 'Boston, MA', '2026-10-15', 'https://www.linkedin.com/jobs/view/11'),
        ('12', 'Mechanical Engineer', 'Acme', 'Austin, TX', '2026-10-20', 'https://www.linkedin.com/jobs/view/12')]
    assert parse_cards(EMPTY_PAGE) == [] and parse_cards('') == []
    with pytest.raises(ValueError):
        parse_cards('<html><body>Sign in to continue</body></html>')


def test_leads_are_resolved_on_indeed_and_the_rest_wait_for_the_next_run(scraper):
    settings.save({'linkedin.max_agent_searches_per_run': 0})
    scraper.client.get = MagicMock(return_value=html(page(
        card('1', 'Mechanical Engineer Asc - Early Career', 'Lockheed Martin', 'Littleton, CO'),
        card('2', 'Senior Mechanical Engineer', 'Acme'),
        card('3', 'Mechanical Engineering Intern', 'Acme'),
        card('4', 'Engineer I, Mechanical (R6302)', 'Shield AI', 'San Diego, CA'),
        card('5', 'New Graduate Engineer, Mechanical', 'SpaceX', 'Bastrop, TX'))))
    scraper.known = {('spacex', 'new graduate engineer, mechanical')}
    resolver = MagicMock()
    resolver.error = None
    resolver.lookup = lambda lead: ({'company_name': 'Lockheed Martin', 'title': lead['title'], 'canonical_url': 'https://lockheed.example/1',
                                     'raw_source_data': {'source': 'linkedin', 'resolved_by': 'indeed'}} if lead['company'] == 'Lockheed Martin' else None)
    scraper.resolver = resolver
    records = scraper.discover_jobs()
    assert [r['company_name'] for r in records] == ['Lockheed Martin']
    assert records[0]['raw_source_data']['linkedin_url'] == 'https://www.linkedin.com/jobs/view/1'
    report = scraper.report
    assert (report['cards'], report['off_track'], report['known'], report['leads'], report['by_indeed'], report['unresolved']) == (5, 2, 1, 2, 1, 1)
    state = linkedin.load_state()
    assert state['unresolved'][0]['company'] == 'Shield AI' and state['last_scan_at']
    params = scraper.client.get.call_args.kwargs['params']
    assert params['keywords'] == 'mechanical engineer new grad' and params['f_TPR'] == 'r604800' and params['start'] == 0
    # The unresolved lead is carried into the next run and tried again.
    scraper.client.get = MagicMock(return_value=html(EMPTY_PAGE))
    scraper.discover_jobs()
    assert scraper.report['leads'] == 1 and linkedin.load_state()['unresolved'][0]['company'] == 'Shield AI'


def test_pages_follow_start_up_to_the_results_wanted(scraper):
    settings.save({'linkedin.results_per_query': 20, 'linkedin.max_agent_searches_per_run': 0})
    first = html(page(*[card(str(i), 'Software Engineer', 'Acme') for i in range(10)]))
    second = html(page(*[card(str(i), 'Software Engineer', 'Acme') for i in range(10, 20)]))
    scraper.client.get = MagicMock(side_effect=[first, second, html(page())])
    scraper.resolver = MagicMock(error=None, lookup=lambda lead: None)
    scraper.discover_jobs()
    assert scraper.client.get.call_count == 2 and scraper.truncated
    assert [c.kwargs['params']['start'] for c in scraper.client.get.call_args_list] == [0, 10]


def test_a_refusal_pauses_the_channel(scraper):
    scraper.client.get = MagicMock(return_value=html('', status=429))
    scraper.resolver = MagicMock(error=None, lookup=lambda lead: None)
    assert scraper.discover_jobs() == []
    assert 'refused' in scraper.last_error and not due(force=True)[0]
    assert probe().health == 'blocked'
    linkedin.save_state({})
    now = datetime(2026, 10, 21, 12, tzinfo=timezone.utc)
    assert due(now) == (True, '')
    linkedin.save_state({'last_scan_at': (now - timedelta(hours=1)).isoformat()})
    assert due(now)[1] == 'not due yet' and due(now, force=True)[0] and due(now + timedelta(hours=7))[0]


def test_scan_reads_linkedin_through_the_catalog_and_stores_the_employer_posting(session, monkeypatch):
    settings.save({'linkedin.max_agent_searches_per_run': 0})
    session.add(SourceRecord(key='li', company_name='LinkedIn', ats_type='linkedin', target=linkedin.source_target(), enabled=True))
    session.commit()
    monkeypatch.setattr(httpx.Client, 'get', lambda self, url, params=None, **kw: html(page(card('7', 'Mechanical Engineer I', 'Example Corp', 'Austin, TX'))))
    monkeypatch.setattr(httpx.Client, 'post', lambda self, url, json=None, **kw: response([job()]))
    config = SearchConfig(cadence={}, query_templates={}, target_companies={}, locations={},
                          indeed=IndeedSearch(queries=[], resolve_redirect_hosts=[]), linkedin=LinkedInSearch(queries=['mechanical engineer']))
    stats = SearchAgent(session, config).run_discovery(only='linkedin')
    assert stats['sources_checked'] == 1 and stats['source_results'][0]['ats'] == 'linkedin'
    stored = session.query(Job).one()
    assert stored.company_name == 'Example Corp' and stored.source_ats == 'greenhouse'
    assert stored.canonical_url == 'https://boards.greenhouse.io/example/jobs/123'
    assert stored.raw_source_data['source'] == 'linkedin' and stored.raw_source_data['resolved_by'] == 'indeed'
    assert session.query(SourceRecord).one().health == 'working'
    # Known now: the next forced run has no new lead.
    stats = SearchAgent(session, config).run_discovery(only='linkedin')
    assert stats['source_results'][0]['report']['known'] == 1 and stats['source_results'][0]['jobs_found'] == 0
