import httpx

from jobagent.scrapers.rivian import RivianScraper


def row(job_id="123", **updates):
    return {"data": {"req_id": job_id, "title": "Mechanical Engineer", "description": "<p>Build vehicles</p>",
                     "qualifications": "Bachelor in mechanical engineering", "full_location": "Irvine, California",
                     "apply_url": f"https://us-careers-rivian.icims.com/jobs/{job_id}/login", **updates}}


def scraper(handler):
    instance = RivianScraper(request_delay=0)
    instance.client.close()
    instance.client = httpx.Client(transport=httpx.MockTransport(handler))
    return instance


def test_paginates_and_keeps_filters_and_full_descriptions():
    calls = []
    def respond(request):
        calls.append(dict(request.url.params))
        return httpx.Response(200, json={"jobs": [row(str(len(calls)))], "totalCount": 2})
    s = scraper(respond)
    jobs = s.discover_jobs({"name": "Rivian", "career_url": "https://careers.rivian.com/jobs?keywords=mechanical&country=United+States"})
    assert len(jobs) == 2 and s.last_error is None
    assert [c["page"] for c in calls] == ["1", "2"]
    assert all(c["keywords"] == "mechanical" and c["country"] == "United States" for c in calls)
    assert "Bachelor" in jobs[0]["description"]
    assert jobs[0]["application_url"].endswith("/1/login")
    s.close()


def test_fetch_uses_keyword_and_exact_id_not_first_result():
    def respond(request):
        assert request.url.params["keywords"] == "123"
        return httpx.Response(200, json={"jobs": [row("999"), row()], "totalCount": 2})
    s = scraper(respond)
    assert s.fetch_job({}, "123")["external_req_id"] == "123"
    s.close()


def test_empty_schema_challenge_and_repeated_page_are_errors():
    for payload in ({"error": "challenge"}, {"jobs": [], "totalCount": 10}, {"jobs": [row()], "totalCount": 200}):
        s = scraper(lambda request: httpx.Response(200, json=payload))
        s.discover_jobs({})
        assert s.last_error
        s.close()


def test_valid_empty_board_and_hidden_rows():
    s = scraper(lambda request: httpx.Response(200, json={"jobs": [], "totalCount": 0}))
    assert s.probe({}) == ([], 0)
    assert s.discover_jobs({}) == [] and s.last_error is None
    s.close()
    s = scraper(lambda request: httpx.Response(200, json={"jobs": [row(applyable=False)], "totalCount": 1}))
    assert s.discover_jobs({}) == []
    assert s.check_status("https://careers.rivian.com/jobs/123") == (False, "Rivian API explicitly marks the requisition unavailable")
    s.close()


def test_status_transient_missing_or_ambiguous_stays_active():
    for status, payload in ((403, {}), (200, {"jobs": [], "totalCount": 0}), (200, {"jobs": [row("999")], "totalCount": 1})):
        s = scraper(lambda request: httpx.Response(status, json=payload))
        assert s.check_status("https://careers.rivian.com/jobs/123") == (True, None)
        s.close()


def test_truncation_is_reported_even_when_returning_partial_results():
    s = scraper(lambda request: httpx.Response(200, json={"jobs": [row()], "totalCount": 200}))
    s.MAX_PAGES = 1
    assert len(s.discover_jobs({})) == 1
    assert "truncated" in s.last_error
    s.close()


def test_probe_returns_pipeline_jobs_with_validated_total():
    s = scraper(lambda request: httpx.Response(200, json={"jobs": [row()], "totalCount": 1}))
    jobs, total = s.probe({})
    assert total == 1
    assert jobs[0]["canonical_url"] == "https://careers.rivian.com/careers-home/jobs/123"
    assert jobs[0]["title"] == "Mechanical Engineer"
    assert "Build vehicles" in jobs[0]["description"]
    s.close()
