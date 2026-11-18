"""Employer adapters must work through source add/health/repair, not only standalone."""
from unittest.mock import Mock

import httpx
import pytest

from jobagent.agents.source_agent import infer_adapter
from jobagent.agents.source_repair import ADAPTERS
from jobagent.discovery.source_health import probe_source


@pytest.mark.parametrize('url,ats', [
    ('https://www.bmwgroup.jobs/us/en.html', 'bmw'),
    ('https://jobs.mercedes-benz.com/enUS', 'mercedes'),
    ('https://careers.ibm.com/en_US/careers/SearchJobs/', 'ibm'),
    ('https://www.ibm.com/careers/search?q=mechanical', 'ibm'),
    ('https://careers.rivian.com/jobs', 'rivian'),
    ('https://www.tesla.com/careers/search', 'tesla'),
])
def test_official_board_routes_to_persistent_adapter(url, ats):
    selected, target = infer_adapter('Employer', url)
    assert selected == ats and target['ats_type'] == ats
    assert target['career_url'].startswith('https://')
    assert ats in ADAPTERS


@pytest.mark.parametrize('url', [
    'https://careers.ibm.com.example.org/jobs',
    'https://jobs.mercedes-benz.com.example.org/enUS',
    'https://www.bmwgroup.jobs.example.org/us/en.html',
])
def test_employer_adapter_requires_exact_official_host(url):
    assert infer_adapter('Employer', url) is None


@pytest.mark.parametrize('url', ['https://careers.rivian.com/jobs?keywords=intern&country=United%20States', 'https://www.ibm.com/careers/search?q=mechanical'])
def test_source_add_preserves_official_search_scope(url):
    from urllib.parse import urlparse
    _, target = infer_adapter('Employer', url)
    assert urlparse(target['career_url']).query == urlparse(url).query


@pytest.mark.parametrize('ats,class_name', [('bmw', 'BMWScraper'), ('mercedes', 'MercedesScraper'), ('ibm', 'IBMScraper'), ('rivian', 'RivianScraper')])
def test_normal_scan_registry_instantiates_real_employer_parser(ats, class_name):
    from jobagent.scrapers import get_scraper_for_ats
    worker = get_scraper_for_ats(ats)
    try:
        assert worker.__class__.__name__ == class_name
        assert callable(worker.probe)
    finally:
        worker.close()


@pytest.fixture
def adapter(monkeypatch):
    from jobagent import scrapers
    from jobagent.discovery import source_health
    worker = Mock()
    monkeypatch.setattr(scrapers, 'get_scraper_for_ats', lambda ats: worker)
    monkeypatch.setattr(source_health, 'public_url', lambda url: url)
    return worker


def test_health_counts_verified_employer_jobs(adapter):
    adapter.probe.return_value = ([{'title': 'Mechanical Engineer', 'canonical_url': 'https://example.org/jobs/1', 'description': 'Actual employer requirements'}], 315)
    result = probe_source('ibm', {'career_url': 'https://careers.ibm.com/'})
    assert result.working and result.jobs_found == 315
    adapter.close.assert_called_once()


@pytest.mark.parametrize('payload', [([], 1), ([{'title': 'Missing details'}], 1), ([], -1), (None, 0)])
def test_schema_failure_does_not_become_healthy_empty(adapter, payload):
    adapter.probe.return_value = payload
    result = probe_source('rivian', {'career_url': 'https://careers.rivian.com/'})
    assert not result.working and result.health == 'unreadable'
    adapter.close.assert_called_once()


def test_explicit_empty_employer_board_stays_enabled(adapter):
    adapter.probe.return_value = ([], 0)
    assert probe_source('bmw', {'career_url': 'https://www.bmwgroup.jobs/'}).health == 'empty'


@pytest.mark.parametrize('status,expected', [(403, 'blocked'), (429, 'temporary_error'), (503, 'temporary_error'), (404, 'missing')])
def test_health_preserves_transient_endpoint_error(adapter, status, expected):
    response = httpx.Response(status, request=httpx.Request('GET', 'https://careers.rivian.com/api/jobs'))
    adapter.probe.side_effect = httpx.HTTPStatusError('endpoint failure', request=response.request, response=response)
    assert probe_source('rivian', {'career_url': 'https://careers.rivian.com/'}).health == expected
    adapter.close.assert_called_once()
