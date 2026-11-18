"""SmartRecruiters public postings, with complete qualification sections."""
import re
from datetime import datetime
from urllib.parse import quote, urlparse

from .base import BaseScraper
from ..processing.eligibility import clean_html_text
from ..processing.normalize import canonicalize_url, compute_description_hash, extract_salary, normalize_location, normalize_title


class SmartRecruitersScraper(BaseScraper):
    @staticmethod
    def board(target):
        token = target.get('company_slug') or target.get('board_token')
        if not token:
            token = urlparse(target['career_url']).path.strip('/').split('/')[0]
        return f'https://api.smartrecruiters.com/v1/companies/{quote(token, safe="")}/postings'

    def discover_jobs(self, target):
        self.truncated = False
        jobs, seen = [], set()
        base = self.board(target)
        try:
            for page in range(int(target.get('max_pages', 5))):
                response = self.get_with_retry(base, params={'limit': 100, 'offset': page * 100})
                response.raise_for_status()
                data = response.json()
                for row in data['content']:
                    req = str(row['id'])
                    if req in seen:
                        continue
                    seen.add(req)
                    if target.get('country') and row.get('location', {}).get('country', '').lower() != target['country'].lower():
                        continue
                    if target.get('title_include') and not re.search(target['title_include'], row.get('name', ''), re.I):
                        continue
                    if len(jobs) >= int(target.get('max_details', 40)):
                        self.truncated = True
                        continue
                    detail_response = self.get_with_retry(base + '/' + quote(req, safe=''))
                    if detail_response.status_code != 200:
                        continue
                    job = self._parse(detail_response.json(), target)
                    if job:
                        jobs.append(job)
                if (page + 1) * 100 >= data['totalFound'] or not data['content']:
                    break
            else:
                self.truncated = True
        except Exception as exc:
            self.last_error = str(exc)
        return jobs

    def _parse(self, data, target):
        if data.get('active') is False:
            return None
        sections = data.get('jobAd', {}).get('sections', {})
        description = '\n\n'.join(clean_html_text('<h2>' + s.get('title', '') + '</h2>' + s.get('text', '')) for s in sections.values())
        if not description.strip():
            return None
        title = data['name']
        loc = data.get('location', {})
        location = loc.get('fullLocation') or ', '.join(str(loc[k]) for k in ('city', 'region', 'country') if loc.get(k))
        salary, minimum, maximum = extract_salary(description)
        url = canonicalize_url(data['postingUrl'])
        return dict(external_req_id=str(data['id']), company_name=target['name'], title=title,
                    normalized_title=normalize_title(title), location=location,
                    normalized_location=normalize_location(location)[0], description=description,
                    description_hash=compute_description_hash(description), canonical_url=url,
                    application_url=data.get('applyUrl') or url, source_ats='smartrecruiters',
                    employment_type=data.get('typeOfEmployment', {}).get('label'),
                    department=data.get('department', {}).get('label'), salary_raw=salary,
                    salary_min=minimum, salary_max=maximum,
                    posting_date=datetime.fromisoformat(data['releasedDate'].replace('Z', '+00:00')) if data.get('releasedDate') else None,
                    raw_source_data=data)

    def fetch_job(self, target, job_id):
        response = self.get_with_retry(self.board(target) + '/' + quote(str(job_id), safe=''))
        return response.json() if response.status_code == 200 else None

    def check_status(self, job_url):
        response = self.get_with_retry(job_url, max_retries=2)
        return (False, f'HTTP {response.status_code}') if response.status_code in (404, 410) else (True, None)
