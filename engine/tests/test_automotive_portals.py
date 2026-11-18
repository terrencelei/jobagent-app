import json

import httpx
import pytest

from jobagent.scrapers.automotive_portals import BMWScraper, MercedesScraper


def response(text, status=200):
    return httpx.Response(status, text=text, request=httpx.Request("GET", "https://example.test"))


def bmw_page(ids, total):
    return '<div class="grp-jobfinder__table" data-counter="%s">%s</div>' % (total, ''.join(
        f'<div class="grp-jobfinder__wrapper" data-job-id="{i}"><a class="grp-jobfinder__link-jobdescription" href="/us/en/jobfinder/job-description-copy.{i}.html" aria-label="Mechanical Engineer"></a></div>' for i in ids))


def bmw_detail(req="123"):
    return f'''<div itemtype="https://schema.org/JobPosting"><span class="cmp-title__text-title1">Mechanical Engineer</span>
    <div itemprop="description"><h2>Qualifications</h2><p>Bachelor degree and CAD experience.</p></div>
    <span itemprop="identifier">{req}</span><div class="grp-jobdescription__jobLocation">Spartanburg, SC</div>
    <span itemprop="datePosted">20261015</span><a class="grp-jobdescription-apply-button" href="https://career5.successfactors.eu/careers?career_job_req_id={req}">Apply</a></div>'''


def mb_row(req="123"):
    return {"ID":req,"PositionID":"mer000abc", "PositionTitle":"Mechanical Intern", "PositionURI":f"https://jobs.mercedes-benz.com/en/mechanical-intern-{req}-mer000abc",
            "PositionLocation":[{"CityName":"Sunnyvale, CA","CountryName":"United States"}],"PublicationStartDate":"2026-10-15",
            "PositionFormattedDescription":[{"Tasks":"<p>CAD design.</p>","Qualifications":"<p>Enrolled in Mechanical Engineering; return to school required.</p>"}],
            "ApplyURI":["https://tas-daimler.taleo.net/careersection/ex/jobapply.ftl?job=mer000abc"]}


def mb_result(rows, total):
    return json.dumps({"SearchResult":{"SearchResultCountAll":total,"SearchResultItems":[{"MatchedObjectDescriptor":row} for row in rows]}})


def test_bmw_probe_real_shape_preserves_country_filter_and_detail(monkeypatch):
    scraper = BMWScraper(request_delay=0)
    calls=[]
    def get(url, **kwargs):
        calls.append((url,kwargs))
        if url.endswith('en.html'):
            return response('<div data-jobfinder-path="/_jcr_content/jobfinder.jobfinder_table.content.html"></div>')
        if 'jobfinder_table' in url:
            assert kwargs['params']['filterSearch']=='location_US'
            return response(bmw_page(['123'],1))
        return response(bmw_detail())
    monkeypatch.setattr(scraper,'get_with_retry',get)
    rows,total=scraper.probe({'career_url':'https://www.bmwgroup.jobs/us/en.html#location=US'})
    assert total==1 and rows[0]['external_req_id']=='123'
    assert 'Bachelor degree' in rows[0]['description']
    assert rows[0]['location']=='Spartanburg, SC'
    assert rows[0]['application_url'].startswith('https://career5.successfactors.eu/')


def test_bmw_full_pagination_and_repetition_is_error(monkeypatch):
    s=BMWScraper(request_delay=0); s._config_key='x'; s._config=('https://www.bmwgroup.jobs/search','location_US','')
    offsets=[]
    def get(url,**kwargs):
        offset=kwargs['params']['rowIndex']; offsets.append(offset)
        return response(bmw_page(['1','2'] if offset==0 else ['3'],3))
    monkeypatch.setattr(s,'get_with_retry',get)
    monkeypatch.setattr(s,'fetch_job',lambda target,req:{'external_req_id':req})
    assert len(s.discover_jobs({'career_url':'x'}))==3
    assert offsets==[0,2] and s.last_error is None
    monkeypatch.setattr(s,'get_with_retry',lambda *a,**k:response(bmw_page(['1','2'],3)))
    assert len(s.discover_jobs({'career_url':'x'}))==2
    assert 'repeated' in s.last_error


@pytest.mark.parametrize('html',['<html>challenge</html>',bmw_page([],5)])
def test_bmw_malformed_is_not_empty_success(monkeypatch,html):
    s=BMWScraper(request_delay=0);s._config_key='x';s._config=('https://www.bmwgroup.jobs/search','location_US','')
    monkeypatch.setattr(s,'get_with_retry',lambda *a,**k:response(html))
    assert s.discover_jobs({'career_url':'x'})==[] and s.last_error


def test_bmw_mismatched_detail_rejected(monkeypatch):
    s=BMWScraper(request_delay=0)
    monkeypatch.setattr(s,'get_with_retry',lambda *a,**k:response(bmw_detail('999')))
    assert s.fetch_job({},'123') is None


def test_mercedes_country_pagination_and_complete_requirements(monkeypatch):
    s=MercedesScraper(request_delay=0);calls=[]
    def get(url,**kwargs):
        assert url=='https://jobs.api.mercedes-benz.com/search'
        payload=json.loads(kwargs['params']['data']);calls.append(payload)
        criteria=payload['SearchCriteria']
        if criteria[0]['CriterionName'] in ('ID','PositionID'):
            return response(mb_result([mb_row()],1))
        assert criteria==[{'CriterionName':'PositionLocation.Country','CriterionValue':['475']}]
        return response(mb_result([mb_row()],1))
    monkeypatch.setattr(s,'get_with_retry',get)
    rows,total=s.probe({})
    assert total==1 and 'return to school required' in rows[0]['description']
    assert rows[0]['external_req_id']=='mer000abc'
    assert s.fetch_job({},'mer000abc')['title']=='Mechanical Intern'
    assert calls[-1]['SearchCriteria'][0]['CriterionName']=='PositionID'


def test_mercedes_full_pagination_and_repetition(monkeypatch):
    s=MercedesScraper(request_delay=0);offsets=[]
    def get(url,**kwargs):
        p=json.loads(kwargs['params']['data']);offset=p['SearchParameters']['FirstItem'];offsets.append(offset)
        return response(mb_result([mb_row('1'),mb_row('2')] if offset==1 else [mb_row('3')],3))
    monkeypatch.setattr(s,'get_with_retry',get)
    monkeypatch.setattr(s,'fetch_job',lambda target,req:{'external_req_id':req})
    assert len(s.discover_jobs({}))==3 and offsets==[1,3]
    monkeypatch.setattr(s,'get_with_retry',lambda *a,**k:response(mb_result([mb_row('1')],2)))
    assert len(s.discover_jobs({}))==1 and 'repeated' in s.last_error


@pytest.mark.parametrize('payload',[{}, {'SearchResult':{'SearchResultCountAll':2,'SearchResultItems':[]}}, {'SearchResult':{'SearchResultCountAll':1,'SearchResultItems':[{'MatchedObjectDescriptor':{'ID':'1'}}]}}])
def test_mercedes_malformed_not_healthy(monkeypatch,payload):
    s=MercedesScraper(request_delay=0)
    monkeypatch.setattr(s,'get_with_retry',lambda *a,**k:response(json.dumps(payload)))
    assert s.discover_jobs({})==[] and s.last_error


@pytest.mark.parametrize('cls',[BMWScraper,MercedesScraper])
@pytest.mark.parametrize('status,body,active',[(429,'rate limit',True),(503,'outage',True),(200,'<script>this job is no longer available</script><main>Mechanical Engineer</main>',True),(200,'<main>This position is no longer available</main>',False),(404,'missing',False)])
def test_status_conservative(monkeypatch,cls,status,body,active):
    s=cls(request_delay=0)
    monkeypatch.setattr(s,'get_with_retry',lambda *a,**k:response(body,status))
    assert s.check_status('https://example.test/job')[0] is active


def test_bmw_uses_truthful_native_http_client_identity():
    scraper=BMWScraper(request_delay=0)
    assert scraper.client.headers['User-Agent']==f'python-httpx/{httpx.__version__}'
    scraper.close()


def test_mercedes_listing_details_are_reused_without_per_job_requests(monkeypatch):
    scraper=MercedesScraper(request_delay=0);calls=[]
    def get(url,**kwargs):
        calls.append(url)
        return response(mb_result([mb_row('123'),mb_row('124')],2))
    monkeypatch.setattr(scraper,'get_with_retry',get)
    jobs=scraper.discover_jobs({})
    assert len(jobs)==2 and len(calls)==1
    assert all('return to school required' in job['description'] for job in jobs)
