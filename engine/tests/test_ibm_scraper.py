"""Contract tests for IBM's public full-body careers API."""

import json

import httpx
import pytest

from jobagent.scrapers.ibm import IBMScraper


def hit(job_id=123, *, country="United States", body="Mechanical design responsibilities. Bachelor's degree required."):
    return {"_source": {
        "title": "Mechanical Engineering Intern 2027",
        "url": f"https://careers.ibm.com/careers/JobDetail?jobId={job_id}",
        "description": "Truncated teaser...", "body": body,
        "field_text_01": job_id, "field_keyword_05": country,
        "field_keyword_19": "San Jose, US" if country else "",
        "field_keyword_08": "Hardware", "field_keyword_18": "Internship",
    }}


def result(rows, total=None, **extra):
    return {"hits": {"total": {"value": len(rows) if total is None else total, "relation": "eq"}, "hits": rows}, **extra}


@pytest.fixture
def scraper():
    instance = IBMScraper(request_delay=0)
    yield instance
    instance.close()


def install(scraper, handler):
    scraper.client.close()
    scraper.client = httpx.Client(transport=httpx.MockTransport(handler))


def test_live_bundle_payload_and_fullbody_contract(scraper):
    def handler(request):
        assert str(request.url) == IBMScraper.API
        assert request.method == "POST"
        data = json.loads(request.content)
        assert data["appId"] == "careers"
        assert data["scopes"] == ["careers2"]
        assert data["query"]["bool"]["must"][0]["simple_query_string"] == {"query": "mechanical", "fields": ["title", "body"]}
        assert data["size"] == 2
        assert data["sort"] == [{"_id": "asc"}]
        assert "body" in data["_source"]
        return httpx.Response(200, json=result([hit()]))
    install(scraper, handler)
    rows, total = scraper.probe({"name": "IBM", "career_url": "https://www.ibm.com/careers/search?q=mechanical"})
    assert total == 1
    assert rows[0]["description"] == "Mechanical design responsibilities. Bachelor's degree required."
    assert rows[0]["external_req_id"] == "123"
    assert rows[0]["canonical_url"] == "https://careers.ibm.com/en_US/careers/JobDetail?jobId=123"
    assert rows[0]["location"] == "San Jose, US, United States"
    assert rows[0]["source_ats"] == "ibm"


def test_api_locale_is_not_an_invented_location(scraper):
    install(scraper, lambda _: httpx.Response(200, json=result([hit(country="")])))
    rows, _ = scraper.probe({})
    assert rows[0]["location"] == ""


def test_pagination_honors_total_and_id_dedup(scraper):
    scraper.PAGE_SIZE = 2
    offsets = []
    def handler(request):
        offset = json.loads(request.content)["from"]
        offsets.append(offset)
        return httpx.Response(200, json=result([hit(1), hit(2)] if offset == 0 else [hit(3)], 3))
    install(scraper, handler)
    assert [r["external_req_id"] for r in scraper.discover_jobs({})] == ["1", "2", "3"]
    assert offsets == [0, 2]
    assert scraper.last_error is None


def test_repeated_pages_surface_incompleteness(scraper):
    install(scraper, lambda _: httpx.Response(200, json=result([hit()], 3)))
    assert len(scraper.discover_jobs({})) == 1
    assert "repeated" in scraper.last_error


def test_page_limit_is_explicitly_truncated(scraper):
    scraper.MAX_PAGES = 1
    install(scraper, lambda _: httpx.Response(200, json=result([hit()], 3)))
    assert len(scraper.discover_jobs({})) == 1
    assert "truncated" in scraper.last_error


@pytest.mark.parametrize("payload", [
    {}, {"hits": {"total": 2, "hits": []}}, result([hit()], 0),
    {"hits": {"total": {"value": 1, "relation": "gte"}, "hits": [hit()]}},
    result([hit()], timed_out=True), result([hit()], _shards={"failed": 1}),
    result([{**hit(), "_source": {**hit()["_source"], "field_text_01": 999}}]),
    result([hit(body="")]),
    result([{**hit(), "_source": {**hit()["_source"], "url": "https://example.com/careers/JobDetail?jobId=123"}}]),
])
def test_schema_and_partial_failures_are_not_healthy(scraper, payload):
    install(scraper, lambda _: httpx.Response(200, json=payload))
    with pytest.raises(ValueError):
        scraper.probe({})
    scraper.discover_jobs({})
    assert scraper.last_error


def test_transient_post_retry_does_not_close_posting(scraper, monkeypatch):
    monkeypatch.setattr("jobagent.scrapers.ibm.time.sleep", lambda _: None)
    calls = []
    def handler(request):
        calls.append(request.method)
        return httpx.Response(503) if len(calls) < 3 else httpx.Response(200, json=result([hit()]))
    install(scraper, handler)
    assert scraper.check_status("https://careers.ibm.com/en_US/careers/JobDetail?jobId=123") == (True, None)
    assert calls == ["POST", "POST", "POST"]


def test_fetch_job_bypasses_target_search_and_requires_exact_id(scraper):
    def handler(request):
        data = json.loads(request.content)
        assert data["query"]["bool"]["must"] == [{"simple_query_string": {"query": "123", "fields": ["field_text_01"]}}]
        return httpx.Response(200, json=result([hit()]))
    install(scraper, handler)
    assert scraper.fetch_job({"search": "unrelated"}, "123")["external_req_id"] == "123"


@pytest.mark.parametrize("status,closed", [(202, False), (403, False), (404, True), (410, True)])
def test_absence_in_index_needs_real_detail_closure(scraper, status, closed):
    install(scraper, lambda request: httpx.Response(200, json=result([])) if request.method == "POST" else httpx.Response(status))
    active, evidence = scraper.check_status("https://careers.ibm.com/en_US/careers/JobDetail?jobId=123")
    assert active is not closed
    assert bool(evidence) is closed
