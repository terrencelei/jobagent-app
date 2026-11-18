"""Public Oracle Fusion Candidate Experience listings and complete requisitions."""
from datetime import datetime
import re
from urllib.parse import urlparse
from bs4 import BeautifulSoup
from .base import BaseScraper
from ..processing.eligibility import clean_html_text
from ..processing.normalize import canonicalize_url, compute_description_hash, extract_salary, normalize_location, normalize_title


class OracleScraper(BaseScraper):
    def board(self, target):
        if getattr(self, '_board', None) and self._board_url == target.get('career_url'):
            return self._board
        url = target.get('career_url') or ''
        response = self.get_with_retry(url)
        response.raise_for_status()
        base = BeautifulSoup(response.text, 'html.parser').select_one('base[data-apibaseurl][data-sitenumber]')
        if not base:
            raise ValueError('Not an Oracle Fusion Candidate Experience board')
        api = base['data-apibaseurl'].rstrip('/')
        parsed = urlparse(api)
        site = base['data-sitenumber']
        if (parsed.scheme != 'https' or not (parsed.hostname or '').endswith('.oraclecloud.com')
                or parsed.username or parsed.password or parsed.port not in (None, 443)
                or parsed.path or not re.fullmatch(r'[A-Za-z0-9_-]+', site)):
            raise ValueError('Invalid public Oracle API configuration')
        public = urlparse(str(response.url))
        match = re.match(r'(.*?/sites/[^/]+)', public.path)
        if not match:
            raise ValueError('Oracle careers URL must identify a site')
        board = f'{public.scheme}://{public.netloc}{match[1]}'
        self._board = (api + '/hcmRestApi/resources/latest/', site, board)
        self._board_url = target.get('career_url')
        return self._board

    def search_page(self, target, offset=0, limit=100):
        api, site, _ = self.board(target)
        keyword = target.get('keyword', 'engineer')
        if any(c in keyword for c in ',;"'):
            raise ValueError('Oracle keyword cannot contain finder delimiters')
        finder = f'findReqs;siteNumber={site},keyword={keyword},limit={limit},offset={offset}'
        response = self.get_with_retry(api + 'recruitingCEJobRequisitions', params={
            'onlyData': 'true', 'finder': finder, 'expand': 'requisitionList'})
        response.raise_for_status()
        items = response.json().get('items')
        if not isinstance(items, list) or len(items) != 1:
            raise ValueError('Oracle search response is missing its result envelope')
        result = items[0]
        rows = result.get('requisitionList')
        total = result.get('TotalJobsCount')
        if not isinstance(rows, list) or not isinstance(total, int) or total < 0:
            raise ValueError('Oracle search response is missing requisitions or total count')
        if any(not isinstance(row, dict) or not row.get('Id') or not row.get('Title') for row in rows):
            raise ValueError('Malformed Oracle requisition summary')
        return rows, total

    def discover_jobs(self, target):
        self.last_error = None
        self.truncated = False
        jobs, seen = [], set()
        offset = 0
        try:
            for _ in range(100):
                rows, total = self.search_page(target, offset)
                if not rows:
                    if offset < total:
                        raise ValueError('Oracle pagination ended before the reported total')
                    break
                if all(str(row['Id']) in seen for row in rows):
                    raise ValueError('Oracle pagination repeated a page')
                for row in rows:
                    req = str(row['Id'])
                    if req in seen:
                        continue
                    seen.add(req)
                    if target.get('country') and row.get('PrimaryLocationCountry') != target['country']:
                        continue
                    title = row['Title'].lower()
                    if target.get('title_keywords') and not any(word.lower() in title for word in target['title_keywords']):
                        continue
                    if any(word.lower() in title for word in target.get('exclude_title_keywords', [])):
                        continue
                    job = self.fetch_job(target, req)
                    if job:
                        jobs.append(job)
                    elif self.last_error:
                        raise ValueError(self.last_error)
                offset += len(rows)
                if offset >= total:
                    break
            else:
                self.truncated = True
                raise ValueError('Oracle pagination reached its safety limit')
        except Exception as exc:
            self.last_error = str(exc)
        return jobs

    def fetch_job(self, target, job_id):
        try:
            if not re.fullmatch(r'[A-Za-z0-9_-]+', str(job_id)):
                raise ValueError('Invalid Oracle requisition id')
            api, site, board = self.board(target)
            response = self.get_with_retry(api + 'recruitingCEJobRequisitionDetails', params={
                'onlyData': 'true', 'finder': f'ById;Id="{job_id}",siteNumber={site}'})
            response.raise_for_status()
            items = response.json().get('items')
            if not isinstance(items, list):
                raise ValueError('Malformed Oracle detail response')
            if not items:
                return None
            item = items[0]
            if str(item.get('Id')) != str(job_id) or not item.get('Title'):
                raise ValueError('Oracle returned the wrong requisition')
            description = clean_html_text('\n'.join(item.get(key) or '' for key in (
                'ExternalDescriptionStr', 'ExternalResponsibilitiesStr', 'ExternalQualificationsStr')))
            if not description:
                raise ValueError('Oracle requisition has no complete description')
            title, location = item['Title'], item.get('PrimaryLocation') or ''
            normalized, _, _ = normalize_location(location)
            salary_raw, salary_min, salary_max = extract_salary(description)
            date = item.get('ExternalPostedStartDate')
            url = board + '/job/' + str(job_id)
            return {'external_req_id': str(job_id), 'company_name': target['name'], 'title': title,
                'normalized_title': normalize_title(title), 'location': location, 'normalized_location': normalized,
                'department': item.get('Department'), 'description': description,
                'description_hash': compute_description_hash(description), 'canonical_url': canonicalize_url(url),
                'application_url': url, 'source_ats': 'oracle', 'salary_raw': salary_raw,
                'salary_min': salary_min, 'salary_max': salary_max,
                'posting_date': datetime.fromisoformat(date.replace('Z', '+00:00')) if date else None,
                'raw_source_data': item}
        except Exception as exc:
            self.last_error = str(exc)
            return None

    def check_status(self, job_url):
        try:
            response = self.get_with_retry(job_url, max_retries=2)
            if response.status_code in (404, 410):
                return False, f'HTTP {response.status_code} Not Found'
            if response.status_code == 200:
                text = BeautifulSoup(response.text, 'html.parser').get_text(' ', strip=True)
                if re.search(r'job is no longer available|no longer accepting applications', text, re.I):
                    return False, 'Explicit Oracle posting closure notice'
        except Exception:
            pass
        return True, None
