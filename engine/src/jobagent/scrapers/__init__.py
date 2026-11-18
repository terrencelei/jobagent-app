"""Scrapers package for JobAgent."""

from typing import Dict, Type
from .base import BaseScraper, ScrapingError
from .greenhouse import GreenhouseScraper
from .lever import LeverScraper
from .breezy import BreezyScraper
from .ashby import AshbyScraper
from .workday import WorkdayScraper
from .company_sites import CompanyCareerScraper
from .amazon import AmazonScraper
from .siemens import SiemensScraper
from .browser_sites import BrowserCareerScraper
from .oracle import OracleScraper
from .smartrecruiters import SmartRecruitersScraper
from .rivian import RivianScraper
from .automotive_portals import BMWScraper, MercedesScraper
from .ibm import IBMScraper

_SCRAPER_REGISTRY: Dict[str, Type[BaseScraper]] = {
    "greenhouse": GreenhouseScraper,
    "lever": LeverScraper,
    "breezy": BreezyScraper,
    "ashby": AshbyScraper,
    "workday": WorkdayScraper,
    "direct": CompanyCareerScraper,
    "company": CompanyCareerScraper,
    "apple": CompanyCareerScraper,
    "tesla": CompanyCareerScraper,
    "amazon": AmazonScraper,
    "siemens": SiemensScraper,
    "browser": BrowserCareerScraper,
    "oracle": OracleScraper,
    "smartrecruiters": SmartRecruitersScraper,
    "rivian": RivianScraper,
    "bmw": BMWScraper,
    "mercedes": MercedesScraper,
    "ibm": IBMScraper,
}


def get_scraper_for_ats(ats_type: str) -> BaseScraper:
    clean_type = ats_type.lower() if ats_type else "direct"
    scraper_cls = _SCRAPER_REGISTRY.get(clean_type, CompanyCareerScraper)
    return scraper_cls()


__all__ = [
    "BaseScraper",
    "ScrapingError",
    "GreenhouseScraper",
    "AmazonScraper",
    "SiemensScraper",
    "BrowserCareerScraper",
    "LeverScraper",
    "BreezyScraper",
    "AshbyScraper",
    "WorkdayScraper",
    "CompanyCareerScraper",
    "get_scraper_for_ats",
]
