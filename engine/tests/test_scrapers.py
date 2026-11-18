"""Tests for Greenhouse, Lever, Ashby, and Workday scrapers."""

from unittest.mock import MagicMock
import pytest
from jobagent.scrapers.ashby import AshbyScraper
from jobagent.scrapers.greenhouse import GreenhouseScraper
from jobagent.scrapers.lever import LeverScraper
from jobagent.scrapers.workday import WorkdayScraper


def test_greenhouse_scraper_parsing():
    scraper = GreenhouseScraper()
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "jobs": [
            {
                "id": 123456,
                "title": "Mechanical Design Engineer, New Grad",
                "content": "<p>Design high-reliability mechanisms. Salary: $95,000 - $120,000.</p>",
                "absolute_url": "https://boards.greenhouse.io/andurilindustries/jobs/123456?gh_jid=123456",
                "location": {"name": "Costa Mesa, CA"},
                "requisition_id": "REQ-ANDURIL-99",
                "updated_at": "2026-09-01T12:00:00Z",
            }
        ]
    }
    scraper.get_with_retry = MagicMock(return_value=mock_resp)

    jobs = scraper.discover_jobs({"board_token": "andurilindustries", "name": "Anduril"})
    assert len(jobs) == 1
    j = jobs[0]
    assert j["external_req_id"] == "REQ-ANDURIL-99"
    assert j["title"] == "Mechanical Design Engineer, New Grad"
    assert j["salary_min"] == 95000.0
    assert j["salary_max"] == 120000.0
    assert "Costa Mesa" in j["location"]
    assert j["canonical_url"] == "https://boards.greenhouse.io/andurilindustries/jobs/123456"


def test_amazon_required_leadership_experience_is_not_hidden_in_preferred_text():
    from jobagent.scrapers.amazon import AmazonScraper
    from jobagent.processing.eligibility import split_required_and_preferred
    from jobagent.processing.qualifications import required_experience_years
    scraper = AmazonScraper(request_delay=0)
    try:
        job = scraper._parse({'id': '123', 'title': 'Product Design Mechanical Engineer',
            'description': 'Preferred Qualifications\nHelpful team background.',
            'basic_qualifications': "Bachelor's degree in Engineering.<br/>5+ years leading new product design and manufacturing support.",
            'preferred_qualifications': '10+ years of experience is preferred.'}, 'Amazon')
        required, preferred = split_required_and_preferred(job['description'])
        assert required_experience_years(required) == 5
        assert '10+ years' in preferred and '5+ years leading' in required
    finally:
        scraper.close()


def test_lever_scraper_parsing():
    scraper = LeverScraper()
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = [
        {
            "id": "hermeus-1122",
            "text": "Manufacturing Engineer, New Grad",
            "descriptionPlain": "Build supersonic flight hardware. Base: $90,000 - $110,000.",
            "additionalPlain": "Requirements: BS in Mechanical or Aerospace Engineering.",
            "hostedUrl": "https://jobs.lever.co/hermeus/hermeus-1122?lever-source=Applied",
            "applyUrl": "https://jobs.lever.co/hermeus/hermeus-1122/apply",
            "categories": {"location": "Atlanta, GA", "commitment": "Full-time", "team": "Manufacturing"},
            "createdAt": 1726000000000,
        }
    ]
    scraper.get_with_retry = MagicMock(return_value=mock_resp)

    jobs = scraper.discover_jobs({"company_slug": "hermeus", "name": "Hermeus"})
    assert len(jobs) == 1
    j = jobs[0]
    assert j["external_req_id"] == "hermeus-1122"
    assert j["title"] == "Manufacturing Engineer, New Grad"
    assert j["salary_min"] == 90000.0
    assert j["source_ats"] == "lever"
    assert j["canonical_url"] == "https://jobs.lever.co/hermeus/hermeus-1122"


def test_ashby_scraper_parsing():
    scraper = AshbyScraper()
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "jobs": [
            {
                "id": "varda-99",
                "title": "Robotics & Automation Engineer",
                "descriptionHtml": "<p>Automated orbital manufacturing capsules.</p>",
                "locationName": "El Segundo, CA",
                "jobUrl": "https://jobs.ashbyhq.com/varda/varda-99",
                "compensation": {"minCompensation": 95000, "maxCompensation": 125000},
            }
        ]
    }
    scraper.get_with_retry = MagicMock(return_value=mock_resp)

    jobs = scraper.discover_jobs({"company_slug": "varda", "name": "Varda Space"})
    assert len(jobs) == 1
    j = jobs[0]
    assert j["title"] == "Robotics & Automation Engineer"
    assert j["salary_min"] == 95000.0
    assert j["source_ats"] == "ashby"


def test_lever_preserves_required_and_preferred_lists():
    from jobagent.processing.eligibility import EligibilityEngine
    scraper=LeverScraper(request_delay=0)
    response=MagicMock(status_code=200)
    response.json.return_value=[{'id':'test','text':'Mechanical Engineer','descriptionPlain':'Build systems.',
        'lists':[{'text':'Required Qualifications','content':'<li>BS in Mechanical Engineering.</li><li>1 year experience.</li>'},
                 {'text':'Preferred Qualifications','content':'<li>5 years experience.</li>'}],
        'categories':{'location':'Los Angeles, CA'},'salaryRange':{'currency':'USD','interval':'per-year','min':91000,'max':115000}}]
    scraper.get_with_retry=MagicMock(return_value=response)
    job=scraper.discover_jobs({'company_slug':'test'})[0]
    assert 'Required Qualifications\n' in job['description']
    assert job['salary_min']==91000
    assert EligibilityEngine().evaluate(job['title'],job['description'])[0].value=='ELIGIBLE'
    scraper.close()


def test_ashby_current_schema_location_and_compensation():
    scraper=AshbyScraper(request_delay=0)
    response=MagicMock(status_code=200)
    response.json.return_value={'jobs':[{'id':'x','title':'Mechanical Engineer','location':'San Francisco',
        'descriptionHtml':'<h3>Requirements</h3><p>BS in Mechanical Engineering.</p>',
        'jobUrl':'https://jobs.ashbyhq.com/test/x','applyUrl':'https://jobs.ashbyhq.com/test/x/application',
        'compensation':{'scrapeableCompensationSalarySummary':'$100K - $130K','summaryComponents':[{'compensationType':'Salary','currencyCode':'USD','interval':'1 YEAR','minValue':100000,'maxValue':130000}]}},
        {'id':'hidden','isListed':False}]}
    scraper.get_with_retry=MagicMock(return_value=response)
    jobs=scraper.discover_jobs({'company_slug':'test'})
    assert len(jobs)==1 and jobs[0]['location']=='San Francisco'
    assert jobs[0]['salary_min']==100000
    assert jobs[0]['application_url'].endswith('/application')
    assert scraper.get_with_retry.call_args.kwargs['params']=={'includeCompensation':'true'}
    scraper.close()


def test_workday_paginates_and_reads_full_requirements():
    scraper=WorkdayScraper(request_delay=0)
    listing1=MagicMock(status_code=200);listing2=MagicMock(status_code=200)
    listing1.json.return_value={'total':21,'jobPostings':[{'title':'Mechanical Engineer','externalPath':'/job/City/Mechanical_1','bulletFields':['R1']}]}
    listing2.json.return_value={'total':21,'jobPostings':[{'title':'Test Engineer','externalPath':'/job/City/Test_2','bulletFields':['R2']}]}
    scraper.client.post=MagicMock(side_effect=[listing1,listing2])
    detail=MagicMock(status_code=200)
    detail.json.return_value={'jobPostingInfo':{'jobDescription':'<h3>Requirements</h3><p>BS in Mechanical Engineering. 1 year experience.</p>','location':'San Jose, CA','timeType':'Full time'}}
    scraper.get_with_retry=MagicMock(return_value=detail)
    jobs=scraper.discover_jobs({'name':'Company','career_url':'https://company.wd1.myworkdayjobs.com/en-US/Careers/job/City/X'})
    assert len(jobs)==2
    assert scraper.client.post.call_args_list[1].kwargs['json']['offset']==20
    assert scraper.client.post.call_args_list[0].args[0]=='https://company.wd1.myworkdayjobs.com/wday/cxs/company/Careers/jobs'
    assert jobs[0]['canonical_url']=='https://company.wd1.myworkdayjobs.com/Careers/job/City/Mechanical_1'
    assert '1 year experience' in jobs[0]['description']
    assert jobs[0]['source_ats']=='workday'
    scraper.close()


def test_greenhouse_update_timestamp_is_not_posting_date():
    scraper=GreenhouseScraper(request_delay=0)
    response=MagicMock(status_code=200)
    response.json.return_value={'jobs':[{'id':1,'title':'Engineer','content':'<h3>Required Qualifications</h3><p>BS in Mechanical Engineering.</p>','updated_at':'2026-09-19T00:00:00Z'}]}
    scraper.get_with_retry=MagicMock(return_value=response)
    job=scraper.discover_jobs({'board_token':'test'})[0]
    assert job['posting_date'] is None
    assert 'Required Qualifications\n' in job['description']
    scraper.close()


def test_browser_scraper_resolves_each_site_to_a_real_posting_url():
    """Google's links are relative to the applications root, not the results path."""
    from jobagent.scrapers.browser_sites import BrowserCareerScraper as B
    google = B._resolve("jobs/results/12345-senior-mechanical-engineer",
                        "https://www.google.com/about/careers/applications/jobs/results?q=x")
    assert google == ("https://www.google.com/about/careers/applications/"
                      "jobs/results/12345-senior-mechanical-engineer")
    assert "jobs/jobs" not in google

    ms = B._resolve("/careers/job/1970393556928879",
                    "https://apply.careers.microsoft.com/careers?query=x")
    assert ms == "https://apply.careers.microsoft.com/careers/job/1970393556928879"


def test_browser_scraper_rejects_page_chrome_as_a_title():
    """These pages lead with "Jobs" or "Job Details"; neither is a job title."""
    from jobagent.scrapers.browser_sites import BrowserCareerScraper as B
    assert B._clean_title("Jobs") == ""
    assert B._clean_title("Job Details") == ""
    assert B._clean_title("Mechanical Engineer, Robotics") == "Mechanical Engineer, Robotics"
    assert B._title_from_slug(
        "https://www.google.com/about/careers/applications/jobs/results/123-staff-mechanical-engineer"
    ) == "Staff Mechanical Engineer"


def test_browser_scraper_recognizes_apple_roles_and_rejects_expired_pages():
    import re
    from jobagent.scrapers.browser_sites import BrowserCareerScraper as B
    from jobagent.agents.source_agent import infer_adapter
    url = 'https://jobs.apple.com/en-us/search?team=mechanical-engineering-HRDWR-ME'
    scraper = B(request_delay=0)
    try:
        assert re.search(scraper._pattern_for(url), '/en-us/details/200123456-0836/product-design-engineer')
        assert B.launch_options(url)['args'] == ['--disable-http2']
        assert 'args' not in B.launch_options('https://example.com/?jobs.apple.com')
        assert infer_adapter('Apple', url)[0] == 'browser'
        page = MagicMock()
        page.inner_text.return_value = 'Page not found. This role does not exist or is no longer available.'
        context = MagicMock(); context.new_page.return_value = page
        assert scraper._read_posting(context, url, url, 'Apple', 'Mechanical Engineer') is None
        page.close.assert_called_once()
        page.inner_text.return_value = ('Camera Mechanical Design Engineer\nCupertino, California\n'
            "Minimum Qualifications\nBachelor degree in Mechanical Engineering. Mechanical CAD experience. "
            'Design and prototype camera mechanisms. Pay & Benefits\nThe base pay range for this role is '
            'between $150,400 and $225,300. Benefits depend on applicable plan terms.')
        detail = 'https://jobs.apple.com/en-us/details/200123456-0836/camera-mechanical-design-engineer'
        parsed = scraper._read_posting(context, detail, detail, 'Apple', 'Camera Mechanical Design Engineer')
        assert (parsed['salary_min'], parsed['salary_max']) == (150400, 225300)
    finally:
        scraper.close()


def test_amazon_scraper_keeps_the_qualifications_in_the_description():
    """Eligibility is decided on the requirements, which Amazon keeps in separate fields."""
    from jobagent.scrapers.amazon import AmazonScraper
    parsed = AmazonScraper()._parse({
        "id_icims": "10503749",
        "title": "Mechanical Engineer II",
        "description": "Build robots.",
        "basic_qualifications": "- BS degree in mechanical engineering<br/>- 3+ years",
        "preferred_qualifications": "- Knowledge of Ansys",
        "job_path": "/en/jobs/10503749/mechanical-engineer-ii",
        "normalized_location": "Seattle, Washington, USA",
        "posted_date": "August 17, 2026",
    }, "Amazon")
    assert parsed["external_req_id"] == "10503749"
    assert "3+ years" in parsed["description"]
    assert "Ansys" in parsed["description"]
    assert parsed["canonical_url"].startswith("https://www.amazon.jobs/en/jobs/10503749")
    assert parsed["source_ats"] == "amazon"


def test_breezy_scraper_reads_feed_and_posting_description():
    from jobagent.scrapers.breezy import BreezyScraper
    scraper = BreezyScraper(request_delay=0)
    feed = MagicMock(status_code=200)
    feed.json.return_value = [{
        "id": "af671c453f97", "name": "Field Robotics Engineer",
        "url": "https://planted-solar-inc.breezy.hr/p/af671c453f97-field-robotics-engineer",
        "published_date": "2026-09-21T16:04:47.056Z", "type": {"id": "fullTime", "name": "Full-Time"},
        "location": {"name": "Oakland, CA", "is_remote": False}, "department": "Robotics", "salary": "",
    }]
    page = MagicMock(status_code=200, text='<script type="application/ld+json">{"@type":"JobPosting","description":'
                     '"<p>Requirements: BS in Mechanical Engineering. $120,000 - $150,000 per year.</p>"}</script>')
    scraper.get_with_retry = MagicMock(side_effect=lambda url, **k: feed if url.endswith("/json") else page)

    jobs = scraper.discover_jobs({"company_slug": "planted-solar-inc", "name": "Planted Solar"})
    assert len(jobs) == 1
    j = jobs[0]
    assert j["source_ats"] == "breezy" and j["title"] == "Field Robotics Engineer"
    assert "BS in Mechanical Engineering" in j["description"]
    assert j["salary_min"] == 120000.0 and j["location"] == "Oakland, CA"
    assert j["canonical_url"] == "https://planted-solar-inc.breezy.hr/p/af671c453f97-field-robotics-engineer"
    assert j["posting_date"].year == 2026


def test_breezy_closed_posting_redirects_to_board_home():
    from jobagent.scrapers.breezy import BreezyScraper
    scraper = BreezyScraper(request_delay=0)
    scraper.get_with_retry = MagicMock(return_value=MagicMock(status_code=200, url="https://planted-solar-inc.breezy.hr/"))
    assert scraper.check_status("https://planted-solar-inc.breezy.hr/p/000-gone")[0] is False
    scraper.get_with_retry = MagicMock(return_value=MagicMock(status_code=200, url="https://planted-solar-inc.breezy.hr/p/abc-role"))
    assert scraper.check_status("https://planted-solar-inc.breezy.hr/p/abc-role") == (True, None)


def test_workday_targeted_queries_deduplicate_without_losing_later_pages():
    scraper = WorkdayScraper(request_delay=0)
    def listing(path, title, total):
        return MagicMock(status_code=200, json=lambda: {'total': total, 'jobPostings': [{'externalPath':path,'title':title}]})
    scraper.client.post = MagicMock(side_effect=[
        listing('/job/a','Mechanical Engineer',1),
        listing('/job/a','Mechanical Engineer',21),
        listing('/job/b','Thermal Engineer',21),
        listing('/job/c','Software Engineer',1)])
    scraper.get_with_retry = MagicMock(return_value=MagicMock(status_code=200,json=lambda: {'jobPostingInfo': {'jobDescription':'<p>BS Mechanical Engineering. Requirements: 1 year experience.</p>'}}))
    try:
        jobs = scraper.discover_jobs({'name':'Example','career_url':'https://example.wd1.myworkdayjobs.com/Careers',
            'queries':['mechanical','thermal','software'],'title_include':'mechanical|thermal',
            'applied_facets':{'Country':['verified-us-id']}})
        assert len(jobs) == 2
        assert scraper.get_with_retry.call_count == 2
        assert scraper.client.post.call_args.kwargs['json']['appliedFacets'] == {'Country':['verified-us-id']}
        assert [c.kwargs['json']['searchText'] for c in scraper.client.post.call_args_list] == ['mechanical','thermal','thermal','software']
    finally:
        scraper.close()


def test_smartrecruiters_pagination_filters_and_full_qualifications():
    from jobagent.scrapers.smartrecruiters import SmartRecruitersScraper
    scraper = SmartRecruitersScraper(request_delay=0)
    details = {'id':'2','name':'Mechanical NPI Engineer','active':True,
        'location':{'fullLocation':'Santa Clara, CA, United States'},
        'postingUrl':'https://jobs.smartrecruiters.com/AristaNetworks/2',
        'jobAd':{'sections':{'qualifications':{'title':'Qualifications','text':'<p>BS Mechanical Engineering. 1 year experience.</p>'},
            'additionalInformation':{'title':'Additional Information','text':'<p>Salary: $110,000 - $175,000.</p>'}}},
        'typeOfEmployment':{'label':'Full-time'}}
    pages = [
        {'totalFound':101,'content':[{'id':'1','name':'Software Engineer','location':{'country':'us'}},
            {'id':'3','name':'Mechanical Engineer','location':{'country':'in'}}]},
        {'totalFound':101,'content':[{'id':'2','name':'Mechanical NPI Engineer','location':{'country':'us'}}]}]
    scraper.get_with_retry = MagicMock(side_effect=[MagicMock(status_code=200,json=lambda:pages[0]),
        MagicMock(status_code=200,json=lambda:pages[1]), MagicMock(status_code=200,json=lambda:details)])
    try:
        jobs = scraper.discover_jobs({'name':'Arista Networks','career_url':'https://jobs.smartrecruiters.com/AristaNetworks','country':'us','title_include':'mechanical'})
        assert len(jobs) == 1
        assert jobs[0]['salary_min'] == 110000
        assert 'Qualifications' in jobs[0]['description'] and '1 year experience' in jobs[0]['description']
        assert jobs[0]['employment_type'] == 'Full-time'
        assert scraper.get_with_retry.call_args_list[1].kwargs['params']['offset'] == 100
        assert scraper._parse({**details,'active':False},{'name':'Arista Networks'}) is None
    finally:
        scraper.close()
