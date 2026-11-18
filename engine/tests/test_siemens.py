"""Coverage for Siemens filtered pagination, details and conservative status checks."""
from unittest.mock import MagicMock

import httpx
import pytest

from jobagent.scrapers import get_scraper_for_ats
from jobagent.scrapers.siemens import SiemensScraper

ROOT = SiemensScraper.ROOT
SEARCH = ROOT + 'SearchJobs/Automation%20Genesis?42386=%5B812209%5D&folderRecordsPerPage=6'
NEXT = SEARCH + '&folderOffset=6'


def response(url, html, status=200):
    return httpx.Response(status, text=html, request=httpx.Request('GET', url))


def detail(job_id):
    fields = {'Job ID': job_id, 'Posted since': '22-Sep-2026',
              'Location(s)': 'Mason - Ohio - United States of America',
              'Organization': 'Digital Industries'}
    return '<h3 class="section__header__text__title">Automation Genesis - Engineering Track</h3><article class="article--details">' + ''.join(
        f'<div class="article__content__view__field"><div class="article__content__view__field__label">{k}</div><div class="article__content__view__field__value">{v}</div></div>'
        for k, v in fields.items()) + '</article><article class="article--details"><h3>Basic Qualifications</h3><p>BS in Mechanical Engineering. Graduate by June 2027.</p><p>$81,000 - $84,000 annually.</p></article>' + f'<a href="{ROOT}ApplicationMethods?folderId={job_id}">Apply</a>'


def test_pagination_deduplication_and_full_details():
    scraper = get_scraper_for_ats('siemens')
    assert isinstance(scraper, SiemensScraper)
    pages = {
        SEARCH: f'<a href="{ROOT}JobDetail/123">Engineering</a><a href="{ROOT}JobDetail/123">Learn more</a><a href="https://example.com/en_US/externaljobs/JobDetail/999">Share</a><a aria-label="Go to Next Page, Number 2" href="{NEXT}">Next &gt;&gt;</a>',
        NEXT: f'<a href="{ROOT}JobDetail/456">Engineering</a>',
        ROOT + 'JobDetail/123': detail('123'),
        ROOT + 'JobDetail/456': detail('456'),
    }
    scraper.get_with_retry = MagicMock(side_effect=lambda url: response(url, pages[url]))
    try:
        jobs = scraper.discover_jobs({'name': 'Siemens', 'career_url': SEARCH})
        assert [j['external_req_id'] for j in jobs] == ['123', '456']
        assert scraper.get_with_retry.call_count == 4
        assert scraper.last_error is None
        job = jobs[0]
        assert 'Basic Qualifications\n' in job['description']
        assert 'Graduate by June 2027' in job['description']
        assert 'Mason' in job['location']
        assert (job['salary_min'], job['salary_max']) == (81000, 84000)
        assert job['posting_date'].isoformat() == '2026-09-22T00:00:00+00:00'
        assert job['application_url'].endswith('ApplicationMethods?folderId=123')
    finally:
        scraper.close()


def test_unrecognized_search_reports_failure():
    scraper = SiemensScraper()
    scraper.get_with_retry = MagicMock(return_value=response(SEARCH, '<html>Service unavailable</html>'))
    try:
        assert scraper.discover_jobs({'career_url': SEARCH}) == []
        assert 'Unrecognized' in scraper.last_error
    finally:
        scraper.close()


@pytest.mark.parametrize('status,text,active', [
    (503, 'Job is no longer available', True),
    (404, '', False), (410, '', False),
    (200, 'Job is no longer available', False),
    (200, 'Apply', True),
])
def test_status_only_closes_on_reliable_evidence(status, text, active):
    scraper = SiemensScraper()
    scraper.get_with_retry = MagicMock(return_value=response(ROOT, text, status))
    try:
        assert scraper.check_status(ROOT)[0] is active
    finally:
        scraper.close()
