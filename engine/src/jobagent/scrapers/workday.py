"""Workday public CXS adapter, with bounded pagination and full job details."""

from datetime import datetime, timezone
import logging
import re
from urllib.parse import urlparse
from .base import BaseScraper
from ..processing.eligibility import clean_html_text
from ..processing.normalize import canonicalize_url, compute_description_hash, extract_salary, normalize_location, normalize_title

logger = logging.getLogger('jobagent.scrapers.workday')


class WorkdayScraper(BaseScraper):
    @staticmethod
    def board(career_url):
        parsed=urlparse(career_url)
        parts=[p for p in parsed.path.split('/') if p]
        if parts and re.fullmatch(r'[a-z]{2}-[A-Z]{2}',parts[0]):
            parts=parts[1:]
        if not parts:
            raise ValueError('Workday URL has no career site')
        origin=f'{parsed.scheme}://{parsed.netloc}'
        tenant=parsed.netloc.split('.')[0]
        site=parts[0]
        return origin,site,f'{origin}/wday/cxs/{tenant}/{site}'

    def discover_jobs(self,target):
        self.truncated=False
        discovered=[]
        try:
            origin,site,cxs=self.board(target.get('career_url') or '')
            max_pages=int(target.get('max_pages',5))
            max_details=int(target.get('max_details',40))
            seen=set()
            queries=target.get('queries') or ['engineer']
            title_filter=target.get('title_include')
            exhausted=set()
            for query, page in ((q, p) for q in queries for p in range(max_pages)):
                if query in exhausted:continue
                self._wait_for_rate_limit(urlparse(origin).netloc)
                response=self.client.post(cxs+'/jobs',json={'appliedFacets':target.get('applied_facets') or {},'limit':20,'offset':page*20,'searchText':query})
                if response.status_code!=200:
                    self.last_error=f'Workday listing HTTP {response.status_code}: {cxs}/jobs'
                    break
                data=response.json();postings=data.get('jobPostings',[])
                if not postings:
                    exhausted.add(query);continue
                for post in postings:
                    path=post.get('externalPath','')
                    if not path or path in seen:continue
                    seen.add(path)
                    if title_filter and not re.search(title_filter, post.get('title',''), re.I):continue
                    detail={}
                    if len(discovered)<max_details:
                        result=self.get_with_retry(cxs+'/'+path.lstrip('/'))
                        if result.status_code==200:detail=result.json().get('jobPostingInfo',{})
                    else:self.truncated=True
                    title=detail.get('title') or post.get('title','')
                    location=detail.get('location') or post.get('locationsText','')
                    description=clean_html_text(detail.get('jobDescription',''))
                    if not description:
                        description=f'Position: {title}\nEmployer requirements not fetched.'
                    url=canonicalize_url(detail.get('externalUrl') or f'{origin}/{site}/{path.lstrip("/")}')
                    date=None
                    if detail.get('startDate'):
                        try:date=datetime.fromisoformat(detail['startDate'].replace('Z','+00:00')).replace(tzinfo=timezone.utc)
                        except ValueError:pass
                    salary,minimum,maximum=extract_salary(description)
                    bullets=post.get('bulletFields') or []
                    discovered.append(dict(external_req_id=str(detail.get('jobReqId') or (bullets[0] if bullets else path)),company_name=target.get('name','Unknown'),title=title,normalized_title=normalize_title(title),location=location,normalized_location=normalize_location(location)[0],employment_type=detail.get('timeType'),description=description,description_hash=compute_description_hash(description),canonical_url=url,application_url=url,source_ats='workday',salary_raw=salary,salary_min=minimum,salary_max=maximum,posting_date=date,raw_source_data={'listing':post,'jobPostingInfo':detail}))
                if (page+1)*20>=data.get('total',len(postings)):
                    exhausted.add(query)
                elif page+1==max_pages:
                    self.truncated=True
        except Exception as exc:
            self.last_error=str(exc)
            logger.warning('Workday discovery failed: %s',exc)
        return discovered

    def fetch_job(self,target,job_id):
        try:
            _,_,cxs=self.board(target['career_url'])
            response=self.get_with_retry(cxs+'/'+job_id.lstrip('/'))
            if response.status_code==200:return response.json().get('jobPostingInfo')
        except Exception as exc:
            self.last_error=str(exc)
        return None

    def check_status(self,job_url):
        """Ask the posting API, because the public page answers 200 for a removed posting (2026-11-14).

        404 S21 = no such posting; 403 S22 = the posting exists but is no longer published; a live one
        returns jobPostingInfo. Anything else (outage, rate limit, odd URL) is not evidence.
        """
        try:
            origin,site,cxs=self.board(job_url)
            path=urlparse(job_url).path
            at=path.lower().find('/job/')
            if at<0:return True,None
            response=self.get_with_retry(cxs+path[at:],max_retries=2)
            try:body=response.json()
            except ValueError:return True,None
            code=body.get('errorCode') if isinstance(body,dict) else None
            if response.status_code==404 and code in ('S21','HTTP_404'):return False,'Workday: posting not found'
            if response.status_code==403 and code=='S22':return False,'Workday: posting no longer published'
            info=body.get('jobPostingInfo') if isinstance(body,dict) else None
            if response.status_code==200 and isinstance(info,dict) and (info.get('posted') is False or info.get('canApply') is False):
                return False,'Workday: posting closed to applications'
        except Exception as exc:
            logger.warning('Workday status verification failed: %s',exc)
        return True,None
