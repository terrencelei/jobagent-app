"""Leads (company + title) are resolved to employer postings through Indeed's app API."""
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from jobagent import settings
from jobagent.config import IndeedSearch
from jobagent.discovery import indeed, leads
from jobagent.discovery.indeed import IndeedScraper
from jobagent.discovery.leads import Resolver, core_title, lookup, same_company, unknown
from test_indeed import job, response


@pytest.fixture
def scraper():
    instance = IndeedScraper(IndeedSearch(queries=[], resolve_redirect_hosts=[]), request_delay=0)
    yield instance
    instance.close()


@pytest.mark.parametrize('title, core', [
    ("New Graduate Engineer, Mechanical - '26/'27 (Starlink)", 'New Graduate Engineer, Mechanical'),
    ('Engineer I, Mechanical (R6302)', 'Engineer I, Mechanical'),
    ('Fluid Systems & Propulsion Engineer I – Early Career & New Graduate Rotation (2027 Starts)', 'Fluid Systems & Propulsion Engineer I'),
    ('2027 Associate Mechanical Engineer / Mechanical Engineer', '2027 Associate Mechanical Engineer / Mechanical Engineer'),
    ('Mechanical Engineer JR123456', 'Mechanical Engineer'),
])
def test_core_title(title, core):
    assert core_title(title) == core


def test_company_match_uses_the_first_distinctive_word():
    assert same_company('Archer Aviation Inc', 'Archer')
    assert same_company('ANDURIL INDUSTRIES', 'Anduril Industries')
    assert not same_company('Archer Aviation Inc', 'Joby Aviation')
    assert not same_company('The Boeing Company', 'Lockheed Martin')


def test_lookup_wants_the_same_company_and_title_and_prefers_the_lead_city(scraper):
    results = [job(key='a', company='Other Co', title='New Graduate Engineer, Mechanical', url='https://example.com/a'),
               job(key='b', company='SpaceX', title='Software Engineer', url='https://example.com/b'),
               job(key='c', company='SpaceX', title='New Graduate Engineer, Mechanical (Cape Canaveral)', city='Cape Canaveral', state='FL', url='https://boards.greenhouse.io/spacex/jobs/1'),
               job(key='d', company='SpaceX', title='New Graduate Engineer, Mechanical (Starlink)', city='Bastrop', state='TX', url='https://boards.greenhouse.io/spacex/jobs/2')]
    scraper.client.post = MagicMock(return_value=response(results))
    lead = {'company': 'SpaceX', 'title': "New Graduate Engineer, Mechanical - '26/'27 (Starlink)", 'location': 'Bastrop, TX', 'url': 'https://www.linkedin.com/jobs/view/1'}
    record = lookup(lead, scraper, 'linkedin')
    assert record['canonical_url'] == 'https://boards.greenhouse.io/spacex/jobs/2'
    assert record['raw_source_data']['source'] == 'linkedin' and record['raw_source_data']['resolved_by'] == 'indeed'
    assert record['raw_source_data']['lead']['url'] == lead['url']
    sent = scraper.client.post.call_args.kwargs['json']['query']
    assert '"\\"New Graduate Engineer, Mechanical\\" SpaceX"' in sent and 'limit: 10' in sent and 'filters' not in sent
    # No exact-phrase match: the title's words are tried once more, then the lead is given up.
    scraper.client.post.reset_mock()
    assert lookup({'company': 'Nobody', 'title': 'Mechanical Engineer'}, scraper, 'linkedin') is None
    assert [c.kwargs['json']['query'].split('what: ')[1][:40] for c in scraper.client.post.call_args_list] == [
        '"\\"Mechanical Engineer\\" Nobody", locati', '"Mechanical Engineer Nobody", location: ']
    assert lookup({'company': '', 'title': 'Mechanical Engineer'}, scraper, 'linkedin') is None


def test_resolver_is_off_when_disabled_paused_or_capped(scraper):
    scraper.client.post = MagicMock(return_value=response([job(company='Acme', title='Mechanical Engineer I', url='https://example.com/1')]))
    lead = {'company': 'Acme', 'title': 'Mechanical Engineer I'}
    resolver = Resolver('email_alert', scraper)
    settings.save({'indeed.resolve_leads': False})
    assert resolver.lookup(lead) is None and scraper.client.post.call_count == 0
    settings.save({'indeed.resolve_leads': True, 'indeed.lead_lookups_per_run': 1})
    assert resolver.lookup(lead)['company_name'] == 'Acme'
    assert not resolver.available and resolver.lookup(lead) is None and scraper.client.post.call_count == 1
    settings.save({'indeed.lead_lookups_per_run': 300})
    indeed.save_state({'cooldown_until': (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()})
    assert Resolver('email_alert', scraper).lookup(lead) is None and scraper.client.post.call_count == 1


def test_a_refusal_during_a_lookup_pauses_indeed(scraper):
    scraper.client.post = MagicMock(return_value=response([], status=429))
    resolver = Resolver('linkedin', scraper)
    assert resolver.lookup({'company': 'Acme', 'title': 'Mechanical Engineer'}) is None
    assert 'refused' in resolver.error and indeed.cooldown_until() is not None
    assert not resolver.available


def test_unknown_leads_are_deduplicated_against_the_store():
    known = {('spacex', 'new graduate engineer, mechanical')}
    out = unknown([{'company': 'SpaceX', 'title': 'New Graduate Engineer, Mechanical'},
                   {'company': 'Acme', 'title': 'Mechanical Engineer'},
                   {'company': 'ACME', 'title': 'Mechanical Engineer'}], known)
    assert [lead['company'] for lead in out] == ['Acme']
