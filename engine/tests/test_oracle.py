import httpx
from jobagent.scrapers import get_scraper_for_ats
from jobagent.scrapers.oracle import OracleScraper
from jobagent.agents.source_agent import infer_adapter
from jobagent.discovery import source_health

BOARD = 'https://careers.fixture.example/en/sites/Fixture/jobs'
API = 'https://tenant.fa.ocs.oraclecloud.com'
TARGET = {'name': 'Fixture', 'career_url': BOARD, 'country': 'US'}
HTML = f'<base data-apibaseurl="{API}" data-sitenumber="CX_1">'


def response(url, data=None, text=None, status=200):
    return httpx.Response(status, request=httpx.Request('GET', url), json=data, text=text)


def detail(req):
    return {'Id': req, 'Title': 'Mechanical Engineering - Recent Grad/Full Time',
        'PrimaryLocation': 'United States', 'ExternalDescriptionStr': '<p>Build mechanisms.</p>',
        'ExternalQualificationsStr': '<p>Graduate between August 2026 and May 2027.</p>',
        'ExternalResponsibilitiesStr': '<p>Test prototypes.</p>',
        'ExternalPostedStartDate': '2026-09-08T12:55:00+00:00'}


def test_pagination_country_filter_and_complete_requirements():
    scraper = get_scraper_for_ats('oracle')
    assert isinstance(scraper, OracleScraper)
    calls = []
    def get(url, **kwargs):
        calls.append((url, kwargs))
        if url == BOARD:
            return response(url, text=HTML)
        finder = kwargs['params']['finder']
        if 'Details' in url:
            req = finder.split('Id="')[1].split('"')[0]
            return response(url, {'items': [detail(req)]})
        rows = ([{'Id': '1', 'Title': 'Engineer', 'PrimaryLocationCountry': 'US'},
                 {'Id': '2', 'Title': 'Engineer', 'PrimaryLocationCountry': 'IN'}]
                if 'offset=0' in finder else [{'Id': '3', 'Title': 'Engineer', 'PrimaryLocationCountry': 'US'}])
        return response(url, {'items': [{'requisitionList': rows, 'TotalJobsCount': 3}]})
    scraper.get_with_retry = get
    try:
        jobs = scraper.discover_jobs(TARGET)
        assert [j['external_req_id'] for j in jobs] == ['1', '3']
        assert 'Graduate between August 2026 and May 2027' in jobs[0]['description']
        assert 'Test prototypes' in jobs[0]['description']
        assert jobs[0]['posting_date'].year == 2026
        assert jobs[0]['application_url'] == 'https://careers.fixture.example/en/sites/Fixture/job/1'
        assert any('offset=2' in k.get('params', {}).get('finder', '') for _, k in calls)
        assert scraper.last_error is None
    finally:
        scraper.close()


def test_repeated_pages_and_malformed_schema_are_errors():
    for result in ({'items': []}, {'items': [{'TotalJobsCount': 4, 'requisitionList': [{'Id': '1', 'Title': 'Engineer'}]}]}):
        scraper = OracleScraper(request_delay=0)
        scraper.get_with_retry = lambda url, **kw: response(url, text=HTML) if url == BOARD else response(url, result)
        scraper.fetch_job = lambda *args: None
        try:
            scraper.discover_jobs(TARGET)
            assert scraper.last_error
        finally:
            scraper.close()


def test_target_title_filters_exclude_operator_and_technician_roles():
    scraper = OracleScraper(request_delay=0)
    rows = [{'Id': '1', 'Title': 'Manufacturing Engineer'},
            {'Id': '2', 'Title': 'Manufacturing Operator'},
            {'Id': '3', 'Title': 'Equipment Engineering Technician'}]
    scraper.search_page = lambda *args, **kw: (rows, 3)
    scraper.fetch_job = lambda target, req: {'external_req_id': req}
    try:
        jobs = scraper.discover_jobs({'title_keywords': ['engineer'], 'exclude_title_keywords': ['technician']})
        assert jobs == [{'external_req_id': '1'}]
        assert scraper.last_error is None
    finally:
        scraper.close()


def test_invalid_api_host_is_not_contacted():
    scraper = OracleScraper(request_delay=0)
    calls = []
    def get(url, **kw):
        calls.append(url)
        return response(url, text='<base data-apibaseurl="http://127.0.0.1" data-sitenumber="CX_1">')
    scraper.get_with_retry = get
    try:
        assert scraper.discover_jobs(TARGET) == []
        assert 'Invalid public Oracle' in scraper.last_error
        assert calls == [BOARD]
    finally:
        scraper.close()


def test_health_and_source_inference(monkeypatch):
    monkeypatch.setattr(source_health, 'public_url', lambda url: url)
    monkeypatch.setattr(OracleScraper, 'search_page', lambda *args, **kw: ([], 0))
    assert source_health.probe_source('oracle', TARGET).health == 'empty'
    for url in ['https://careers.honeywell.com/en/sites/Honeywell/jobs/preview/155571/',
                API + '/hcmUI/CandidateExperience/en/sites/CX/job/123']:
        ats, target = infer_adapter('Fixture', url)
        assert ats == 'oracle' and target['career_url'].endswith('/jobs')


def test_status_does_not_close_jobs_on_outages():
    scraper = OracleScraper(request_delay=0)
    try:
        scraper.get_with_retry = lambda url, **kw: response(url, status=503)
        assert scraper.check_status(BOARD + '/job/1') == (True, None)
        scraper.get_with_retry = lambda url, **kw: response(url, status=404)
        assert scraper.check_status(BOARD + '/job/1')[0] is False
    finally:
        scraper.close()
