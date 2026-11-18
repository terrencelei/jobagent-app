"""GitHub feeds are untrusted discovery leads, not eligibility or closure evidence."""
from unittest.mock import MagicMock, patch

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from jobagent.config import GitHubSource, load_search_config
from jobagent.discovery.github import GitHubJobsScraper, markdown_rows, relevant_title
from jobagent.discovery.search_agent import SearchAgent
from jobagent.db.models import Base, Job, JobStatus
from jobagent.tracking.lifecycle import JobLifecyclePipeline


TABLE = '''# Hardware Jobs
<details>
<summary>Hardware Engineering</summary>
| Company | Role | Location | Posted | **Apply** |
|---|---|---|---|---|
| **Example** | Mechanical Engineer I | San Jose, CA | 2d | [<img alt="Apply">](https://jobs.lever.co/example/a?utm_source=github) |
| ↳ | Robotics Engineer | Austin, TX \\| Remote | 1d | <a href="https://jobs.lever.co/example/b"><img alt="Apply"></a> |
| ↳ | Mechanical Engineer | US | 1d | 🔒 |
</details>
<details>
<summary>Inactive roles</summary>
| Company | Role | Location | Posted | Apply |
|---|---|---|---|---|
| Gone | Mechanical Engineer | US | 1d | [Apply](https://example.com/closed) |
</details>
## International
| Company | Role | Location | Posted | Apply |
|---|---|---|---|---|
| Abroad | Mechanical Engineer | London, UK | 1d | [Apply](https://example.com/abroad) |
'''


def response(text='', data=None, status=200, url='https://raw.githubusercontent.com/example/jobs/main/README.md'):
    return httpx.Response(status, text=text if data is None else None, json=data,
                          request=httpx.Request('GET', url))


@pytest.fixture
def scraper():
    instance = GitHubJobsScraper(request_delay=0)
    yield instance
    instance.close()


@pytest.fixture
def session():
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def test_markdown_buttons_continuation_and_archived_sections():
    rows = list(markdown_rows(TABLE))
    assert len(rows) == 2
    assert rows[1]['company_name'] == 'Example'
    assert rows[1]['locations'] == 'Austin, TX | Remote'
    assert rows[0]['url'].startswith('https://jobs.lever.co/example/a')


def test_mixed_repo_heading_does_not_hide_new_grad_section():
    text = '''# Hardware Internships and New Grad Jobs
## USA
### Internships
| Company | Position | Location | Posting | Age |
|---|---|---|---|---|
| Example | Hardware Engineer | US | [Apply](https://example.com/intern) | 0d |
### New Grad
| Company | Position | Location | Posting | Age |
|---|---|---|---|---|
| Example | Hardware Engineer | US | [Apply](https://example.com/grad) | 0d |
'''
    rows = list(markdown_rows(text))
    assert len(rows) == 1
    assert rows[0]['url'].endswith('/grad')


@pytest.mark.parametrize('title', [
    'Mechanical Engineer I', '2027 New Graduate - Thermal Engineer', 'Robotics Engineer',
    'Manufacturing Engineer', 'Controls Engineer', 'Hardware Test Engineer', 'Mechatronics Engineer'])
def test_supported_tracks(title):
    assert relevant_title(title)


@pytest.mark.parametrize('title', [
    'Senior Mechanical Engineer', 'Mechanical Engineer III', 'Software Test Engineer',
    'Business Systems Engineer', 'Frontend Engineer - Robotics', 'Manufacturing Intern Summer 2027',
    'Mechanical Engineering Co-Op', 'Hardware Sales Manager', 'Marketing Coordinator'])
def test_unrelated_senior_and_intern_tracks(title):
    assert not relevant_title(title)


def test_feed_uuid_and_relative_age_are_not_employer_facts(scraper):
    scraper.get_with_retry = MagicMock(return_value=response(TABLE))
    jobs = scraper.discover_jobs({'repository': 'example/jobs'})
    assert len(jobs) == 2
    assert jobs[0]['canonical_url'] == 'https://jobs.lever.co/example/a'
    assert jobs[0]['external_req_id'] is None
    assert jobs[0]['posting_date'] is None
    assert jobs[0]['source_ats'] == 'lever'
    assert jobs[0]['raw_source_data']['github_source_url'].endswith('/blob/main/README.md')
    assert 'Employer requirements not fetched.' in jobs[0]['description']
    assert 'Target Degree Level:' not in jobs[0]['description']


def test_json_active_visibility_filter_and_dedup(scraper):
    item = dict(company_name='Example', title='Mechanical Engineer I', active=True,
                url='https://jobs.lever.co/example/a', id='feed-uuid', locations=['US'])
    data = [item, {**item, 'url':item['url']+'?utm_source=github'},
            {**item, 'active':False}, {**item, 'is_visible':False},
            {**item, 'title':'Software Engineer'}, {**item, 'url':'javascript:alert(1)'}, None]
    scraper.get_with_retry = MagicMock(return_value=response(data=data))
    jobs = scraper.discover_jobs({'repository':'example/jobs', 'format':'simplify_json'})
    assert len(jobs) == 1
    assert jobs[0]['external_req_id'] is None


def test_redirect_resolves_to_employer_and_failures_are_not_fake_jobs(scraper):
    table = TABLE.replace('https://jobs.lever.co/example/a?utm_source=github', 'https://zapply.jobs/l/a')
    scraper.get_with_retry = MagicMock(side_effect=[response(table), response(url='https://jobs.lever.co/example/a')])
    jobs = scraper.discover_jobs({'repository':'example/jobs','resolve_redirect_hosts':['zapply.jobs']})
    assert jobs[0]['canonical_url'] == 'https://jobs.lever.co/example/a'
    assert jobs[0]['raw_source_data']['listing']['url'] == 'https://zapply.jobs/l/a'
    scraper.get_with_retry = MagicMock(side_effect=[response(table), response(status=429, url='https://zapply.jobs/l/a')])
    jobs = scraper.discover_jobs({'repository':'example/jobs','resolve_redirect_hosts':['zapply.jobs']})
    assert len(jobs) == 1 and scraper.warnings
    scraper.get_with_retry = MagicMock(side_effect=[response(table), response(status=403, url='https://jobs.lever.co/example/a')])
    jobs = scraper.discover_jobs({'repository':'example/jobs','resolve_redirect_hosts':['zapply.jobs']})
    assert len(jobs) == 2
    assert jobs[0]['raw_source_data']['discovery_only']


def test_failure_does_not_close_jobs_and_limit_is_reported(scraper):
    scraper.get_with_retry = MagicMock(return_value=response(status=403))
    assert scraper.discover_jobs({'repository':'example/jobs'}) == []
    assert scraper.last_error
    assert scraper.check_status('https://example.com/role') == (True, None)
    scraper.get_with_retry = MagicMock(return_value=response(TABLE))
    assert len(scraper.discover_jobs({'repository':'example/jobs','max_jobs':1})) == 1
    assert scraper.truncated
    scraper.get_with_retry = MagicMock(return_value=response('No more tables'))
    assert scraper.discover_jobs({'repository':'example/jobs'}) == []
    assert 'format may have changed' in scraper.last_error


def test_needs_review_then_employer_description_and_application_are_preserved(scraper, session):
    scraper.get_with_retry = MagicMock(return_value=response(TABLE))
    raw = scraper.discover_jobs({'repository':'example/jobs'})[0]
    pipeline = JobLifecyclePipeline(session)
    pipeline.process_discovered_jobs([raw])
    job = session.query(Job).one()
    assert job.eligibility.value == 'UNCERTAIN'
    job.status = JobStatus.APPLIED
    employer = {**raw, 'description':'Required Qualifications:\nBS in Mechanical Engineering.\n5 years experience.',
                'raw_source_data':{'employer':True}}
    pipeline.process_discovered_jobs([employer])
    pipeline.process_discovered_jobs([raw])
    assert session.query(Job).count() == 1
    assert job.description == employer['description']
    assert job.status == JobStatus.APPLIED
    assert job.eligibility.value == 'LIKELY_INELIGIBLE'


def test_employer_enrichment_keeps_provenance_and_requirements(scraper):
    scraper.get_with_retry = MagicMock(return_value=response(TABLE))
    raw = scraper.discover_jobs({'repository':'example/jobs'})[0]
    official = {**raw, 'external_req_id':'a', 'description':'Required: 5 years experience.',
                'raw_source_data':{'lists':[{'text':'Required','content':'5 years experience.'}]}}
    with patch('jobagent.scrapers.get_scraper_for_ats') as factory:
        factory.return_value.discover_jobs.return_value = [official]
        enriched = scraper.enrich_job(raw)
        scraper.enrich_job(raw)
        factory.return_value.discover_jobs.assert_called_once()
    assert not enriched['raw_source_data']['discovery_only']
    assert enriched['raw_source_data']['github_repository'] == 'example/jobs'
    assert enriched['description'] == official['description']


def test_workday_details_and_transient_failure(scraper):
    scraper.get_with_retry = MagicMock(return_value=response(TABLE))
    raw = scraper.discover_jobs({'repository':'example/jobs'})[0]
    raw.update(source_ats='workday',canonical_url='https://example.wd5.myworkdayjobs.com/en-US/Careers/job/City/Mechanical_JR123')
    scraper.get_with_retry = MagicMock(return_value=response(data={'jobPostingInfo':{
        'title':'Mechanical Engineer I','jobDescription':'<h3>Required</h3><p>BS in Mechanical Engineering. 5 years experience.</p>',
        'location':'Austin, TX','jobReqId':'JR123','timeType':'Full time','canApply':True}}))
    detail = scraper.enrich_job(raw)
    assert detail['external_req_id'] == 'JR123'
    assert '5 years experience' in detail['description']
    assert scraper.get_with_retry.call_args.args[0] == 'https://example.wd5.myworkdayjobs.com/wday/cxs/example/Careers/job/City/Mechanical_JR123'
    scraper.get_with_retry = MagicMock(return_value=response(status=403))
    assert scraper.enrich_job(raw) == raw
    assert scraper.warnings


def test_same_title_different_employer_links_are_distinct(scraper, session):
    scraper.get_with_retry = MagicMock(return_value=response(TABLE))
    raw = scraper.discover_jobs({'repository':'example/jobs'})[0]
    second = {**raw, 'canonical_url':'https://jobs.lever.co/example/other',
              'application_url':'https://jobs.lever.co/example/other',
              'description': raw['description'].replace('/example/a', '/example/other')}
    pipeline = JobLifecyclePipeline(session)
    pipeline.process_discovered_jobs([raw, second])
    assert session.query(Job).count() == 2


def test_discovery_integration_reports_errors_and_skips_employers(session):
    config = load_search_config().model_copy(update={'github_sources':[
        GitHubSource(repository='example/jobs',max_details=0), GitHubSource(repository='example/off',enabled=False)]})
    with patch.object(GitHubJobsScraper,'get_with_retry',return_value=response(TABLE)):
        with patch('jobagent.discovery.search_agent.get_scraper_for_ats') as employer:
            result = SearchAgent(session, config).run_discovery(github_only=True)
            employer.assert_not_called()
    assert result['sources_checked'] == 1
    assert result['new_jobs'] == 2
    assert result['source_results'][0]['ats'] == 'github'
    with patch.object(GitHubJobsScraper,'get_with_retry',return_value=response(status=429)):
        result = SearchAgent(session, config).run_discovery(github_only=True)
    assert result['errors_count'] == 1
    assert session.query(Job).count() == 2


def test_detail_http_failure_does_not_mark_repository_broken(scraper):
    scraper.get_with_retry = MagicMock(return_value=response(TABLE))
    raw = scraper.discover_jobs({'repository':'example/jobs'})[0]
    raw.update(source_ats='workday',canonical_url='https://example.wd5.myworkdayjobs.com/Careers/job/City/Mechanical_JR123')
    def blocked(*args, **kwargs):
        scraper.last_error = 'HTTP 403: employer detail'
        return response(status=403)
    scraper.get_with_retry = blocked
    assert scraper.enrich_job(raw) == raw
    assert scraper.last_error is None
    assert 'Employer details unavailable' in scraper.warnings[-1]


def test_trakker_current_sections_preserve_usa_new_grad_only():
    table = '''# Hardware Internships and New Grad Jobs
## USA
### Internships (238)
| Company | Position | Location | Posting | Age |
|---|---|---|---|---|
| Example | Mechanical Intern | USA | [Apply](https://example.com/jobs/intern) | 0d |
### New Grad (54)
| Company | Position | Location | Posting | Age |
|---|---|---|---|---|
| Example | Mechanical Engineer I | USA | [Apply](https://example.com/jobs/graduate) | 0d |
## International
### New Grad (25)
| Company | Position | Location | Posting | Age |
|---|---|---|---|---|
| Example | Mechanical Engineer I | UK | [Apply](https://example.com/jobs/uk) | 0d |
'''
    rows=list(markdown_rows(table))
    assert len(rows)==1 and rows[0]['url'].endswith('/graduate')
