"""Base scraper architecture with rate limiting, exponential backoff, and safe error handling."""

from abc import ABC, abstractmethod
from datetime import datetime, timezone
import logging
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse
import httpx

from ..config import get_settings

logger = logging.getLogger("jobagent.scrapers")


class ScrapingError(Exception):
    """Temporary or fatal scraping error."""
    pass


class BaseScraper(ABC):
    def __init__(self, request_delay: Optional[float] = None, timeout: Optional[float] = None):
        self.last_error = None
        settings = get_settings()
        self.request_delay = request_delay if request_delay is not None else settings.rate_limit_delay
        self.timeout = timeout if timeout is not None else settings.request_timeout
        self.user_agent = settings.user_agent
        self._last_request_time: Dict[str, float] = {}
        self.client = httpx.Client(
            headers={
                "User-Agent": self.user_agent,
                "Accept": "application/json, text/html, */*",
                "Accept-Language": "en-US,en;q=0.9",
            },
            timeout=self.timeout,
            follow_redirects=True,
        )

    def _wait_for_rate_limit(self, domain: str) -> None:
        """Enforce domain-level politeness interval."""
        last_time = self._last_request_time.get(domain, 0.0)
        elapsed = time.time() - last_time
        if elapsed < self.request_delay:
            time.sleep(self.request_delay - elapsed)
        self._last_request_time[domain] = time.time()

    def get_with_retry(
        self,
        url: str,
        max_retries: int = 3,
        backoff_factor: float = 1.5,
        params: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> httpx.Response:
        domain = urlparse(url).netloc
        attempt = 0
        current_delay = 1.0

        while attempt < max_retries:
            self._wait_for_rate_limit(domain)
            try:
                response = self.client.get(url, params=params, headers=headers)
                if response.status_code >= 400:
                    self.last_error = f"HTTP {response.status_code}: {url}"
                if response.status_code in (429, 500, 502, 503, 504):
                    attempt += 1
                    if attempt >= max_retries:
                        return response
                    logger.warning(
                        f"HTTP {response.status_code} on {url}. Retrying in {current_delay:.1f}s (attempt {attempt}/{max_retries})..."
                    )
                    time.sleep(current_delay)
                    current_delay *= backoff_factor
                    continue
                return response
            except (httpx.RequestError, httpx.TimeoutException) as e:
                attempt += 1
                if attempt >= max_retries:
                    self.last_error = f"Request failed: {url}: {e}"
                    raise ScrapingError(f"Request failed for {url} after {max_retries} attempts: {e}") from e
                logger.warning(f"Network error on {url}: {e}. Retrying in {current_delay:.1f}s...")
                time.sleep(current_delay)
                current_delay *= backoff_factor

        raise ScrapingError(f"Exhausted retries for {url}")

    @abstractmethod
    def discover_jobs(self, target: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Discover active postings for the given company/board target."""
        pass

    @abstractmethod
    def fetch_job(self, target: Dict[str, Any], job_id: str) -> Optional[Dict[str, Any]]:
        """Fetch full details for a single job."""
        pass

    @abstractmethod
    def check_status(self, job_url: str) -> Tuple[bool, Optional[str]]:
        """
        Check if a job is still active.
        Returns: (is_active, closure_evidence)
        IMPORTANT: Temporary errors, rate limits, timeouts must return (True, None) so
        jobs are never accidentally marked CLOSED.
        """
        pass

    def close(self) -> None:
        self.client.close()
