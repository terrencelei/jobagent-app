"""Background scheduler for automated discovery and job status verification."""

import logging
import signal
import sys
import threading
import time
from typing import Optional
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.schedulers.blocking import BlockingScheduler

from ..config import SearchConfig, load_search_config
from ..db.repository import get_db_session
from ..db.models import utc_now
from ..discovery.search_agent import SearchAgent
from ..tracking.lifecycle import JobLifecyclePipeline

logger = logging.getLogger("jobagent.scheduler")

_is_scanning = False
_scan_lock = threading.Lock()
_scheduler = None


def discovery_interval_minutes(cadence) -> float:
    # Searching is continuous: a new full scan starts this many minutes after the last one began,
    # or as soon as it finishes if it ran longer. Older configs gave the interval in hours.
    if cadence.get('discovery_interval_minutes'):
        return float(cadence['discovery_interval_minutes'])
    return float(cadence.get('discovery_interval_hours', 0.25)) * 60


def next_discovery_at():
    job = _scheduler.get_job('job_discovery') if _scheduler else None
    return job.next_run_time if job else None


def is_discovery_active() -> bool:
    """Check whether a background discovery scrape is actively in progress."""
    global _is_scanning
    return _is_scanning


_last_discovery_error = None


def discovery_error():
    return _last_discovery_error


def _claim_discovery():
    global _is_scanning, _last_discovery_error
    with _scan_lock:
        if _is_scanning:
            return False
        _is_scanning = True
        _last_discovery_error = None
        return True


def _release_discovery():
    global _is_scanning
    with _scan_lock:
        _is_scanning = False


def _perform_discovery():
    global _is_scanning, _last_discovery_error
    try:
        with get_db_session() as session:
            scan_started = utc_now()
            stats = SearchAgent(session).run_discovery()
            from .watch import process_watches
            process_watches(session, stats.get('source_results', []))
            # Postings an inbox check found while this scan held the pipeline.
            from ..discovery.email_alerts import add_pending
            add_pending(session)
            # Every scan also checks that open postings it did not list are still up (his rule 2026-11-14).
            try:
                from ..settings import setting
                limit = int(setting('search.verify_per_scan'))
                if limit:
                    pipeline = JobLifecyclePipeline(session)
                    closed = pipeline.verify_active_jobs(max_check=limit, seen_before=scan_started,
                                                         max_seconds=float(setting('search.verify_minutes')) * 60)
                    logger.warning("Posting check after scan: %s", {**pipeline.last_verification, 'closed': closed})
            except Exception:
                session.rollback()
                logger.exception("Posting check after scan failed")
            from ..ui.exporter import export_static_dashboard
            export_static_dashboard(session)
            logger.info("Discovery complete: %s", stats)
    except Exception as exc:
        _last_discovery_error = str(exc)
        logger.exception("Discovery failed")
    finally:
        _release_discovery()


def run_discovery_task():
    if _claim_discovery():
        _perform_discovery()


def request_discovery():
    """Reserve the same worker used by hourly scans before returning to the UI."""
    if not _claim_discovery():
        return False
    threading.Thread(target=_perform_discovery, name="jobagent-discovery", daemon=True).start()
    return True


_email_state = {'running': False, 'error': None}


def run_email_alerts_task():
    """One check of the job-alert emails (discovery/email_alerts.py); never two at once."""
    with _scan_lock:
        if _email_state['running']:
            return None
        _email_state.update(running=True, error=None)
    try:
        from ..discovery.email_alerts import scan
        return scan()
    except Exception as exc:
        _email_state['error'] = str(exc)[:300]
        logger.exception('Email alert check failed')
    finally:
        _email_state['running'] = False


def request_email_alerts():
    if _email_state['running']:
        return False
    threading.Thread(target=run_email_alerts_task, name='jobagent-email-alerts', daemon=True).start()
    return True


def email_alerts_status():
    from ..discovery.email_alerts import load_state
    state = load_state()
    job = _scheduler.get_job('email_alerts') if _scheduler else None
    return {'running': _email_state['running'], 'error': _email_state['error'], 'last_scan_at': state.get('last_scan_at'),
            'last_report': state.get('last_report'), 'unresolved': state.get('unresolved', [])[:20],
            'next_at': job.next_run_time.isoformat() if job and job.next_run_time else None}


def run_verification_task() -> None:
    logger.info("Executing scheduled job status verification...")
    with get_db_session() as session:
        pipeline = JobLifecyclePipeline(session)
        closed = pipeline.verify_active_jobs(max_check=50)
        logger.info(f"Status verification completed: {closed} jobs closed")


class RefreshScheduler:
    def __init__(self, search_config: Optional[SearchConfig] = None, blocking: bool = False):
        self.config = search_config or load_search_config()
        self.cadence = self.config.cadence
        self.blocking = blocking
        self.scheduler = BlockingScheduler() if blocking else BackgroundScheduler()
        self._setup_jobs()

    def _setup_jobs(self) -> None:
        verify_hours = self.cadence.get("high_priority_verify_hours", 4)
        # max_instances/coalesce: a scan that outlasts the interval is followed by one more scan,
        # never a pile-up; _claim_discovery also keeps a manual scan and a watch scan from overlapping.
        self.scheduler.add_job(
            run_discovery_task,
            "interval",
            minutes=discovery_interval_minutes(self.cadence),
            id="job_discovery",
            name="Continuous Job Discovery",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
            misfire_grace_time=None,
        )
        self.scheduler.add_job(
            run_verification_task,
            "interval",
            hours=verify_hours,
            id="job_verification",
            name="Periodic Status Verification",
            replace_existing=True,
        )
        from ..settings import setting
        self.scheduler.add_job(run_email_alerts_task, 'interval', minutes=setting('email.scan_interval_minutes'), id='email_alerts',
                               name='Postings from job-alert emails', replace_existing=True, max_instances=1, coalesce=True)
        from .watch import run_watch_scan
        self.scheduler.add_job(run_watch_scan, 'interval', minutes=15, id='company_watches',
                               name='Watch selected companies and email new eligible roles', replace_existing=True)
        from .maintenance import run_maintenance
        # Sunday 04:00 local: trim posting history and compact the SQLite file (skips itself while a scan or worker runs).
        self.scheduler.add_job(run_maintenance, 'cron', day_of_week='sun', hour=4, id='maintenance',
                               name='Trim posting history and compact the database', replace_existing=True, misfire_grace_time=6 * 3600)

    def start(self) -> None:
        global _scheduler
        _scheduler = self.scheduler
        logger.info("Starting JobAgent refresh scheduler...")
        # Run an initial discovery run immediately
        if self.blocking:
            try:
                run_discovery_task()
            except Exception as e:
                logger.error(f"Initial discovery failed: {e}")

            def handle_exit(signum, frame):
                logger.info("Shutting down daemon gracefully...")
                self.scheduler.shutdown(wait=False)
                sys.exit(0)

            signal.signal(signal.SIGINT, handle_exit)
            signal.signal(signal.SIGTERM, handle_exit)
            self.scheduler.start()
        else:
            self.scheduler.start()
            # In non-blocking daemon mode, trigger initial discovery in background thread immediately
            init_thread = threading.Thread(target=run_discovery_task, daemon=True, name="JobAgent-InitialDiscovery")
            init_thread.start()

    def stop(self) -> None:
        if self.scheduler.running:
            self.scheduler.shutdown(wait=False)
            logger.info("JobAgent refresh scheduler stopped.")
