"""Search agent for coordinating multi-source job discovery."""

import logging
import re
from typing import Any, Dict, List, Optional, Set
from sqlalchemy.orm import Session

from ..config import SearchConfig, load_search_config
from ..identity import grad_timing
from ..db.models import Company, SourceRecord
from .source_catalog import CHANNELS
from urllib.parse import urlparse
from ..scrapers import get_scraper_for_ats
from ..tracking.lifecycle import JobLifecyclePipeline

logger = logging.getLogger("jobagent.discovery")


class SearchAgent:
    def __init__(self, session: Session, search_config: Optional[SearchConfig] = None):
        self.session = session
        self.config = search_config or load_search_config()
        self.pipeline = JobLifecyclePipeline(session)

        # Build search keywords
        self.role_keywords = set(k.lower() for k in self.config.query_templates.get("role_titles", []))
        self.qualifier_keywords = set(k.lower() for k in self.config.query_templates.get("early_career_qualifiers", []))

        # Core filter terms for relevant hardware engineering positions
        self.broad_engineering_terms = {
            "mechanical", "hardware", "product design", "robotics", "mechatronics",
            "systems", "manufacturing", "automation", "controls", "test",
            "electromechanical", "aerospace", "actuator", "tpm", "program manager",
            "process engineer", "equipment engineer", "thermal", "structures",
            "sensor", "optics", "embedded"
        }

    def is_title_relevant(self, title: str) -> bool:
        """Check if job title matches any early career hardware engineering path."""
        t_lower = title.lower()
        # Direct term match
        if any(term in t_lower for term in self.broad_engineering_terms):
            return True
        # Explicit early career graduation match
        if any(term in t_lower for term in [str(grad_timing().year), "new grad", "university", "entry level", "early career", "intern"]):
            return True
        return False

    def run_discovery(
        self,
        specific_company: Optional[str] = None,
        max_sources: Optional[int] = None,
        github_only: bool = False,
        source_ids: Optional[List[int]] = None,
        indeed_only: bool = False,
        only: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Run discovery across configured target ATS boards and company career sites.
        """
        companies_query = self.session.query(Company).filter(Company.is_active.is_(True))
        if specific_company:
            companies_query = companies_query.filter(Company.name.ilike(f"%{specific_company}%"))

        # `only` scans one discovery channel (github, indeed, linkedin) instead of the employer catalog.
        only = only or ('github' if github_only else 'indeed' if indeed_only else None)
        if only and specific_company:
            raise ValueError("Choose either a company search or a single-channel scan")
        channel_only = only is not None
        targets = [] if channel_only else companies_query.all()
        catalog = self.session.query(SourceRecord).filter(SourceRecord.enabled.is_(True))
        if source_ids is not None:
            catalog = catalog.filter(SourceRecord.id.in_(source_ids))
        if specific_company:
            catalog = catalog.filter(SourceRecord.company_name.ilike(f"%{specific_company}%"))
        use_catalog = self.session.query(SourceRecord.id).first() is not None
        catalog_entries = catalog.all() if use_catalog else []
        if use_catalog:
            targets = [] if channel_only else [s for s in catalog_entries if s.ats_type not in CHANNELS]
        if max_sources:
            targets = targets[:max_sources]

        logger.info(f"Starting discovery across {len(targets)} sources...")
        raw_discovered: List[Dict[str, Any]] = []
        sources_checked = 0
        source_results = []
        source_errors = []

        for comp in targets:
            scraper = None
            name = comp.company_name if isinstance(comp, SourceRecord) else comp.name
            try:
                sources_checked += 1
                scraper = get_scraper_for_ats(comp.ats_type or "direct")
                name = comp.company_name if isinstance(comp, SourceRecord) else comp.name
                target_dict = dict(comp.target) if isinstance(comp, SourceRecord) else {
                    "name": comp.name,
                    "company_slug": comp.slug,
                    "board_token": comp.board_token,
                    "career_url": comp.career_url,
                    "ats_type": comp.ats_type,
                }
                parsed = urlparse(target_dict.get('career_url') or '')
                parts = [p for p in parsed.path.split('/') if p]
                if parts and parsed.hostname in ('jobs.lever.co', 'jobs.ashbyhq.com', 'boards.greenhouse.io', 'job-boards.greenhouse.io'):
                    target_dict['company_slug'] = parts[0]
                    if comp.ats_type == 'greenhouse':
                        target_dict['board_token'] = parts[0]
                jobs = scraper.discover_jobs(target_dict)
                error = scraper.last_error
                source_results.append({'source_id': comp.id if isinstance(comp, SourceRecord) else None, 'company': name, 'ats': comp.ats_type, 'jobs_found': len(jobs), 'error': error, 'truncated': bool(getattr(scraper, 'truncated', False))})
                if error:
                    source_errors.append({'source': name, 'error': error})
                for j in jobs:
                    # Filter for relevance to avoid bloating database with unrelated positions (e.g. Sales, Legal)
                    if self.is_title_relevant(j.get("title", "")):
                        raw_discovered.append(j)
            except Exception as e:
                logger.error(f"Error discovering jobs for {name}: {e}")
                source_errors.append({'source': name, 'error': str(e)})
                source_results.append({'source_id': comp.id if isinstance(comp, SourceRecord) else None, 'company': name, 'ats': comp.ats_type, 'jobs_found': 0, 'error': str(e)})
            finally:
                if scraper is not None:
                    scraper.close()

        # GitHub is a discovery channel, not an employer or an ATS. Keep it out of
        # the company catalog and preserve the actual application provider on each job.
        if not specific_company and source_ids is None and only in (None, 'github'):
            from .github import GitHubJobsScraper
            from ..config import GitHubSource
            github_sources = [GitHubSource(**s.target) for s in catalog_entries if s.ats_type == 'github'] if use_catalog else self.config.github_sources
            github_ids = {(s.target['repository'], s.target.get('ref','main'), s.target.get('path','README.md')):s.id for s in catalog_entries if s.ats_type=='github'}
            for source in github_sources:
                source_id = github_ids.get((source.repository, source.ref, source.path))
                if not source.enabled:
                    continue
                scraper = GitHubJobsScraper()
                sources_checked += 1
                try:
                    jobs = scraper.discover_jobs(source)
                    discovery_error = scraper.last_error
                    detailed, attempted = 0, 0
                    for index, job in enumerate(jobs):
                        if attempted >= source.max_details:
                            break
                        if job['source_ats'] not in ('greenhouse', 'lever', 'ashby', 'breezy', 'workday'):
                            continue
                        existing, _ = self.pipeline.deduplicator.resolve_job(job)
                        if existing and existing.description and not any(marker in existing.description for marker in (
                            'Employer requirements not fetched.', 'Source: Early-Career & New Grad Network')):
                            continue
                        attempted += 1
                        jobs[index] = scraper.enrich_job(job)
                        detailed += not jobs[index]['raw_source_data'].get('discovery_only', True)
                    raw_discovered.extend(jobs)
                    source_results.append({'source_id': source_id, 'company': source.repository, 'ats': 'github',
                                           'jobs_found': len(jobs), 'error': discovery_error,
                                           'truncated': scraper.truncated, 'warnings': scraper.warnings,
                                           'details_fetched': detailed, 'details_attempted': attempted})
                    if discovery_error:
                        source_errors.append({'source': source.repository, 'error': discovery_error})
                except Exception as exc:
                    source_results.append({'source_id':source_id,'company':source.repository,'ats':'github','jobs_found':0,'error':str(exc)})
                    source_errors.append({'source': source.repository, 'error': str(exc)})
                finally:
                    scraper.close()

        # Indeed and LinkedIn are read through their public/app APIs (discovery/indeed.py,
        # discovery/linkedin.py), each at most every N minutes of its settings, keeping only postings
        # with an employer apply link.
        if not specific_company and source_ids is None and only != 'github':
            from . import handshake, indeed, linkedin
            for name, module, cls, config in (('indeed', indeed, indeed.IndeedScraper, self.config.indeed),
                                              ('linkedin', linkedin, linkedin.LinkedInScraper, self.config.linkedin),
                                              ('handshake', handshake, handshake.HandshakeScraper, self.config.handshake)):
                if only and only != name:
                    continue
                source = next((s for s in catalog_entries if s.ats_type == name), None)
                ready, reason = module.due(force=only == name)
                if (source is None and use_catalog) or not ready:
                    if only == name:
                        logger.info(f"{module.SOURCE_NAME} not searched: {reason}")
                    continue
                scraper = cls(config)
                sources_checked += 1
                source_id = source.id if source else None
                try:
                    scraper.prepare(self.session)
                    jobs = scraper.discover_jobs(source.target if source else None)
                    raw_discovered.extend(jobs)
                    source_results.append({'source_id': source_id, 'company': module.SOURCE_NAME, 'ats': name,
                                           'jobs_found': len(jobs), 'error': scraper.last_error,
                                           'truncated': scraper.truncated, 'warnings': scraper.warnings,
                                           'report': scraper.report})
                    if scraper.last_error:
                        source_errors.append({'source': module.SOURCE_NAME, 'error': scraper.last_error})
                except Exception as exc:
                    logger.exception(f"{module.SOURCE_NAME} search failed")
                    source_results.append({'source_id': source_id, 'company': module.SOURCE_NAME, 'ats': name, 'jobs_found': 0, 'error': str(exc)})
                    source_errors.append({'source': module.SOURCE_NAME, 'error': str(exc)})
                finally:
                    scraper.close()

        logger.info(f"Scanned {len(raw_discovered)} relevant jobs from {sources_checked} sources.")
        # Pass to lifecycle pipeline
        summary = self.pipeline.process_discovered_jobs(raw_discovered, sources_checked=sources_checked)
        from ..db.models import SearchRun
        latest = self.session.query(SearchRun).order_by(SearchRun.id.desc()).first()
        summary['source_results'] = source_results
        summary['errors_count'] += len(source_errors)
        summary['error_log'].extend(source_errors)
        if latest:
            latest.errors_count = summary['errors_count']
            latest.error_log = summary['error_log']
            latest.summary_data = {'source_results': source_results}
            self.session.commit()
        from ..agents.source_repair import schedule_repairs
        from ..agents.source_agent import _executor, run_task
        task_ids = schedule_repairs(self.session, source_results)
        self.session.commit()
        for task_id in task_ids:
            _executor.submit(run_task, task_id)
        summary['source_repair_tasks'] = task_ids
        return summary
