"""Indeed is read through the Indeed app's API: employer apply links only, refusals pause the channel."""
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from jobagent.config import IndeedSearch, SearchConfig
from jobagent.db.models import Base, Job, SourceRecord
from jobagent.discovery import indeed
from jobagent.discovery.indeed import API_URL, IndeedScraper, due, probe
from jobagent.discovery.search_agent import SearchAgent
from jobagent.discovery.source_health import probe_source
from jobagent.tracking.lifecycle import JobLifecyclePipeline


def job(key='k1', title='Mechanical Engineer I', company='Example Corp', url='https://boards.greenhouse.io/example/jobs/123?gh_src=indeed',
        country='US', city='Austin', state='TX', attributes=('CF3CP',), html='<p>Required: BS in Mechanical Engineering.</p><p>0-2 years.</p>',
        compensation=None, posted=1760000000000):
    return {'job': {'key': key, 'title': title, 'sourceEmployerName': company, 'dateOnIndeed': posted,
                    'description': {'html': html},
                    'location': {'countryCode': country, 'admin1Code': state, 'city': city},
                    'compensation': compensation or {'currencyCode': 'USD', 'baseSalary': {'unitOfWork': 'YEAR', 'range': {'min': 90000.0, 'max': 110000.0}}},
                    'attributes': [{'key': a, 'label': a} for a in attributes],
                    'employer': {'name': company, 'dossier': {'links': {'corporateWebsite': 'https://example.com'}}},
                    'recruit': {'viewJobUrl': url}}}


def response(results, cursor=None, status=200):
    body = {'data': {'jobSearch': {'pageInfo': {'nextCursor': cursor}, 'results': results}}}
    return httpx.Response(status, json=body if status == 200 else {'errors': ['refused']}, request=httpx.Request('POST', API_URL))


@pytest.fixture
def scraper():
    instance = IndeedScraper(IndeedSearch(queries=['mechanical engineer new grad']), request_delay=0)
    yield instance
    instance.close()


@pytest.fixture
def session():
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def test_only_employer_apply_links_in_the_us_on_track_are_kept(scraper):
    results = [
        job(),
        job(key='k2', url=None),                                                    # applies on Indeed only
        job(key='k3', url='https://www.indeed.com/applystart?jk=k3'),
        job(key='k4', url='https://www.linkedin.com/jobs/view/4'),                  # another job board
        job(key='k5', title='Senior Mechanical Engineer', url='https://example.com/5'),
        job(key='k6', title='Software Engineer', url='https://example.com/6'),
        job(key='k7', url='https://example.com/7', attributes=('VDTG7',)),          # internship
        job(key='k8', url='https://example.com/8', country='CA', state='ON', city='Toronto'),
        job(key='k9', url='https://example.com/9', company=''),
        job(key='k1', url='https://example.com/dup'),                               # same key again
    ]
    scraper.client.post = MagicMock(return_value=response(results))
    jobs = scraper.discover_jobs()
    assert [j['raw_source_data']['indeed_key'] for j in jobs] == ['k1']
    kept = jobs[0]
    assert kept['canonical_url'] == 'https://boards.greenhouse.io/example/jobs/123'
    assert kept['application_url'].endswith('gh_src=indeed')
    assert kept['source_ats'] == 'greenhouse'
    assert kept['company_name'] == 'Example Corp' and kept['location'] == 'Austin, TX'
    assert kept['employment_type'] == 'Full-time'
    assert kept['external_req_id'] is None
    assert (kept['salary_raw'], kept['salary_min'], kept['salary_max']) == ('$90,000 - $110,000 a year', 90000.0, 110000.0)
    assert kept['posting_date'] == datetime.fromtimestamp(1760000000, tz=timezone.utc)
    assert 'BS in Mechanical Engineering' in kept['description'] and '<p>' not in kept['description']
    assert kept['raw_source_data']['indeed_url'] == 'https://www.indeed.com/viewjob?jk=k1'
    assert scraper.report['kept'] == 1 and scraper.report['indeed_only'] == 3 and scraper.report['off_track'] == 3
    assert scraper.report['outside_us'] == 1 and scraper.report['unnamed'] == 1 and scraper.report['duplicates'] == 1
    assert scraper.last_error is None
    sent = scraper.client.post.call_args.kwargs['json']['query']
    assert '"mechanical engineer new grad"' in sent and 'start: "168h"' in sent and 'limit: 100' in sent
    assert scraper.client.headers['indeed-app-info'].startswith('appv=')


def test_locations_without_a_city_and_remote_roles_still_name_the_us(scraper):
    results = [job(key='a', city=None, state='TX', url='https://example.com/a'),
               job(key='b', city=None, state=None, url='https://example.com/b', attributes=('CF3CP', 'DSQF7')),
               job(key='c', url='https://example.com/c', compensation={'currencyCode': 'USD', 'baseSalary': {'unitOfWork': 'HOUR', 'range': {'min': 28.0}}},
                   html='<p>Pay: $95,000 - $105,000 per year.</p>')]
    scraper.client.post = MagicMock(return_value=response(results))
    jobs = {j['raw_source_data']['indeed_key']: j for j in scraper.discover_jobs()}
    assert jobs['a']['location'] == 'TX, United States'
    assert jobs['b']['location'] == 'United States (Remote)'
    assert jobs['c']['salary_min'] == 95000.0 and jobs['c']['salary_max'] == 105000.0


def test_pages_follow_the_cursor_up_to_the_results_wanted(scraper, monkeypatch):
    monkeypatch.setattr(indeed, 'setting', lambda key: {'indeed.results_per_query': 150, 'indeed.hours_old': 72,
                                                         'indeed.request_pause_seconds': 0, 'indeed.cooldown_hours': 6,
                                                         'indeed.enabled': True, 'indeed.scan_interval_minutes': 360}[key])
    first = response([job(key=f'p{i}', url=f'https://example.com/{i}') for i in range(100)], cursor='c2')
    second = response([job(key=f'q{i}', url=f'https://example.com/q{i}') for i in range(50)], cursor='c3')
    scraper.client.post = MagicMock(side_effect=[first, second])
    jobs = scraper.discover_jobs()
    assert len(jobs) == 150 and scraper.client.post.call_count == 2
    queries = [c.kwargs['json']['query'] for c in scraper.client.post.call_args_list]
    assert 'cursor:' not in queries[0] and 'cursor: "c2"' in queries[1] and 'limit: 50' in queries[1]
    assert 'start: "72h"' in queries[0]
    assert scraper.truncated


def test_a_refusal_pauses_the_channel_and_a_failure_is_reported(scraper):
    scraper.client.post = MagicMock(return_value=response([], status=403))
    assert scraper.discover_jobs() == []
    assert 'refused' in scraper.last_error and 'paused until' in scraper.last_error
    ready, reason = due(force=True)
    assert not ready and 'paused' in reason
    assert probe().health == 'blocked'
    assert probe_source('indeed', indeed.source_target()).health == 'blocked'
    state = indeed.load_state()
    assert state['last_report']['error'] == scraper.last_error
    indeed.save_state({})
    scraper.client.post = MagicMock(return_value=httpx.Response(200, json={'errors': [{'message': 'bad query'}]}, request=httpx.Request('POST', API_URL)))
    assert scraper.discover_jobs() == []
    assert 'bad query' in scraper.last_error
    assert scraper.check_status('https://example.com/1') == (True, None)


def test_the_channel_runs_on_its_own_interval():
    now = datetime(2026, 10, 21, 12, tzinfo=timezone.utc)
    assert due(now) == (True, '')
    indeed.save_state({'last_scan_at': (now - timedelta(hours=1)).isoformat()})
    assert due(now)[1] == 'not due yet'
    assert due(now, force=True) == (True, '')
    assert due(now + timedelta(hours=7)) == (True, '')
    from jobagent import settings
    settings.save({'indeed.enabled': False})
    assert 'off in Settings' in due(now + timedelta(hours=7))[1]
    settings.save({'indeed.enabled': True})


def test_probe_sends_one_small_query(monkeypatch):
    monkeypatch.setattr(indeed, 'load_search_config', lambda: SearchConfig(cadence={}, query_templates={}, target_companies={}, locations={},
                                                                          indeed=IndeedSearch(queries=['robotics engineer'])))
    posted = []
    def post(self, url, json=None, **kwargs):
        posted.append(json['query'])
        return response([job()])
    monkeypatch.setattr(httpx.Client, 'post', post)
    result = probe()
    assert result.health == 'working' and result.jobs_found == 1
    assert 'limit: 5' in posted[0] and '"robotics engineer"' in posted[0]


def test_scan_reads_indeed_through_the_catalog_and_stores_the_posting(session, monkeypatch):
    session.add(SourceRecord(key='indeed', company_name='Indeed', ats_type='indeed', target=indeed.source_target(), enabled=True))
    session.commit()
    monkeypatch.setattr(httpx.Client, 'post', lambda self, url, json=None, **kw: response([job()]))
    config = SearchConfig(cadence={}, query_templates={}, target_companies={}, locations={}, indeed=IndeedSearch(queries=['mechanical engineer']))
    stats = SearchAgent(session, config).run_discovery()
    assert stats['sources_checked'] == 1
    result = stats['source_results'][0]
    assert result['ats'] == 'indeed' and result['jobs_found'] == 1 and not result['error']
    stored = session.query(Job).one()
    assert stored.company_name == 'Example Corp' and stored.source_ats == 'greenhouse'
    assert stored.raw_source_data['source'] == 'indeed'
    record = session.query(SourceRecord).one()
    assert record.health == 'working' and record.jobs_found == 1
    # Within the interval the next scan leaves Indeed alone.
    stats = SearchAgent(session, config).run_discovery()
    assert stats['sources_checked'] == 0
    # The Indeed record is a channel, never a company target.
    stats = SearchAgent(session, config).run_discovery(indeed_only=True)
    assert stats['sources_checked'] == 1 and stats['source_results'][0]['ats'] == 'indeed'


def test_a_second_read_through_indeed_merges_with_the_employer_posting(session, scraper):
    scraper.client.post = MagicMock(return_value=response([job()]))
    raw = scraper.discover_jobs()[0]
    pipeline = JobLifecyclePipeline(session)
    employer = {**raw, 'description': 'Required Qualifications:\nBS in Mechanical Engineering.\n0-2 years.', 'raw_source_data': {'employer': True}}
    pipeline.process_discovered_jobs([employer])
    pipeline.process_discovered_jobs([raw])
    assert session.query(Job).count() == 1


def test_a_refused_short_link_is_a_warning_not_the_channel_error():
    scraper = IndeedScraper(IndeedSearch(queries=['q'], resolve_redirect_hosts=['grnh.se']), request_delay=0)
    try:
        scraper.client.post = MagicMock(return_value=response([job(url='https://grnh.se/abc')]))
        scraper.get_with_retry = MagicMock(return_value=httpx.Response(403, request=httpx.Request('GET', 'https://grnh.se/abc')))
        scraper.get_with_retry.side_effect = lambda url, **kw: (setattr(scraper, 'last_error', f'HTTP 403: {url}'), httpx.Response(403, request=httpx.Request('GET', url)))[1]
        jobs = scraper.discover_jobs()
        assert jobs[0]['application_url'] == 'https://grnh.se/abc' and scraper.last_error is None
        assert scraper.warnings == ['Could not resolve grnh.se link https://grnh.se/abc']
        scraper.get_with_retry = MagicMock(return_value=httpx.Response(200, request=httpx.Request('GET', 'https://boards.greenhouse.io/x/jobs/9')))
        assert scraper.discover_jobs()[0]['canonical_url'] == 'https://boards.greenhouse.io/x/jobs/9'
    finally:
        scraper.close()
