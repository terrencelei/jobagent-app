"""FastAPI local web server and REST API for JobAgent."""

import logging
from pathlib import Path
from typing import Literal, Optional
from fastapi import FastAPI, HTTPException, Query, Request, Depends
from fastapi.responses import HTMLResponse, FileResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import uvicorn
from sqlalchemy import func

from ..config import get_settings
from ..db.models import Job, JobStatus, utc_now
from ..db.repository import JobRepository, get_db_session, init_db
from ..discovery.source_catalog import CHANNELS
from ..agents.application_agent import ApplicationAgent
from ..services.scheduler import RefreshScheduler, is_discovery_active, request_discovery, discovery_error, next_discovery_at
from .exporter import export_static_dashboard, dashboard_template
from .dashboard import dashboard_counts, jobs_query, job_payload, label_agreement, source_counts

logger = logging.getLogger("jobagent.ui")
from contextlib import asynccontextmanager


@asynccontextmanager
async def _lifespan(_app):
    # A fresh install has an empty database: create the tables however the server was started.
    try:
        from ..db.repository import init_db
        init_db()
    except Exception:
        logging.getLogger("jobagent.ui").exception("Could not initialise the database")
    yield


app = FastAPI(title="JobAgent API", version="0.1.0", lifespan=_lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["Content-Type"])
from .application_routes import router as application_router
app.include_router(application_router)
from .application_export import router as application_export_router
app.include_router(application_export_router)
from .company_logos import router as company_logo_router
app.include_router(company_logo_router)
from .profile_routes import router as profile_router
app.include_router(profile_router)
from .assistant_routes import router as assistant_router
app.include_router(assistant_router)
from .setup_routes import router as setup_router, setup_needed
app.include_router(setup_router)

TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"


class StatusUpdateRequest(BaseModel):
    status: JobStatus
    notes: Optional[str] = None


def tune_later(track):
    import threading
    from ..services.rule_tuner import RuleTuner
    threading.Thread(target=RuleTuner().maybe_tune, args=(track,), daemon=True, name='rule-tuner').start()


class FitLabelRequest(BaseModel):
    fit: Optional[bool] = None  # null clears his label
    note: str = Field(default='', max_length=1000)


@app.get("/", response_class=HTMLResponse)
def index_page():
    # A fresh install has no profile of its own yet: Setup comes first.
    if setup_needed():
        return RedirectResponse('/setup', status_code=307)
    return HTMLResponse(dashboard_template(), headers={"Cache-Control": "no-store"})


@app.get('/feedback.js')
def feedback_script():
    return FileResponse(TEMPLATES_DIR.parent / 'feedback.js', media_type='text/javascript', headers={'Cache-Control': 'no-cache'})


@app.get("/dashboard.js")
def dashboard_script():
    return FileResponse(TEMPLATES_DIR.parent / "dashboard.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


@app.get('/applications.js')
def application_script():
    return FileResponse(TEMPLATES_DIR.parent / 'applications.js', media_type='text/javascript', headers={'Cache-Control': 'no-cache'})


@app.get('/approvals', response_class=HTMLResponse)
def approvals_page():
    return HTMLResponse((TEMPLATES_DIR / 'approvals.html').read_text(), headers={'Cache-Control': 'no-store'})


@app.get('/approvals.js')
def approvals_script():
    return FileResponse(TEMPLATES_DIR.parent / 'approvals.js', media_type='text/javascript', headers={'Cache-Control': 'no-cache'})


@app.get('/results', response_class=HTMLResponse)
def results_page():
    return HTMLResponse((TEMPLATES_DIR / 'results.html').read_text(), headers={'Cache-Control': 'no-store'})


@app.get('/results.js')
def results_script():
    return FileResponse(TEMPLATES_DIR.parent / 'results.js', media_type='text/javascript', headers={'Cache-Control': 'no-cache'})


@app.get('/profile', response_class=HTMLResponse)
def profile_page():
    return HTMLResponse((TEMPLATES_DIR / 'profile.html').read_text(), headers={'Cache-Control': 'no-store'})


@app.get('/profile.js')
def profile_script():
    return FileResponse(TEMPLATES_DIR.parent / 'profile.js', media_type='text/javascript', headers={'Cache-Control': 'no-cache'})


@app.get('/help', response_class=HTMLResponse)
def help_page():
    return HTMLResponse((TEMPLATES_DIR / 'help.html').read_text(), headers={'Cache-Control': 'no-store'})


@app.get('/help.js')
def help_script():
    return FileResponse(TEMPLATES_DIR.parent / 'help.js', media_type='text/javascript', headers={'Cache-Control': 'no-cache'})


@app.get('/manual-selection', response_class=HTMLResponse)
def manual_selection_page():
    return HTMLResponse((TEMPLATES_DIR / 'manual-selection.html').read_text(), headers={'Cache-Control': 'no-store'})


@app.get('/manual-selection.js')
def manual_selection_script():
    return FileResponse(TEMPLATES_DIR.parent / 'manual-selection.js', media_type='text/javascript', headers={'Cache-Control': 'no-cache'})


@app.get('/costs', response_class=HTMLResponse)
def application_costs_page():
    return HTMLResponse((TEMPLATES_DIR / 'costs.html').read_text(), headers={'Cache-Control': 'no-store'})


@app.get('/costs.js')
def application_costs_script():
    return FileResponse(TEMPLATES_DIR.parent / 'costs.js', media_type='text/javascript', headers={'Cache-Control': 'no-cache'})


@app.get('/applications.css')
def application_styles():
    return FileResponse(TEMPLATES_DIR.parent / 'applications.css', media_type='text/css', headers={'Cache-Control': 'no-cache'})


@app.get("/api/status")
def get_status():
    try:
        from ..services.application_runner import get_runner
        auto_performance = get_runner().automatic_performance()
    except Exception:
        auto_performance = {'attempts': [], 'total_attempts': 0, 'submitted': 0}
    with get_db_session() as session:
        latest = JobRepository(session).get_latest_search_run()
        now = utc_now()
        return {"counts": dashboard_counts(session, now, in_flight_job_ids()), "timestamp": now.isoformat(),
                "source_counts": source_counts(session, now),
                "auto_application_performance": auto_performance,
                "is_scanning": is_discovery_active(), "scan_error": discovery_error(),
                "next_scan_at": (lambda t: t.isoformat() if t else None)(next_discovery_at()),
                "latest_run": {"completed_at": latest.completed_at.isoformat() if latest.completed_at else None,
                               "sources_checked": latest.sources_checked, "jobs_scanned": latest.jobs_scanned,
                               "new_jobs": latest.new_jobs, "errors_count": latest.errors_count,
                               "source_results": (latest.summary_data or {}).get('source_results', [])} if latest else None}


def in_flight_job_ids():
    """Submitted applications still waiting for the employer's receipt; Find roles leaves them out."""
    try:
        from ..services.application_runner import get_runner
        return get_runner().in_flight_job_ids()
    except Exception:  # the runner is optional for the dashboard itself
        return ()


@app.get("/api/jobs")
def list_jobs(tab: str = Query("top_priority"), cluster: Optional[str] = Query(None),
              query: Optional[str] = Query(None), limit: int = Query(100, ge=1, le=500),
              offset: int = Query(0, ge=0), applied_days: Optional[int] = Query(None, ge=1, le=3650),
              states: Optional[str] = Query(None, max_length=400), sort: Optional[str] = Query(None, max_length=20)):
    with get_db_session() as session:
        now = utc_now()
        try:
            from ..services.application_runner import get_runner
            company_filter = get_runner().company_filter_view()['companies']
        except Exception:
            company_filter = []
        try:
            selection = jobs_query(session, tab, cluster, query, now, applied_days, in_flight_job_ids(), company_filter,
                                   states=[code for code in (states or '').split(',') if code], sort=sort)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        total = selection.count()
        jobs = [job_payload(j, now) for j in selection.offset(offset).limit(limit).all()]
        return {"count": len(jobs), "total": total, "offset": offset, "jobs": jobs}


@app.get('/api/locations')
def list_locations():
    """States that open postings are in, with how many postings each has, for the location filter."""
    from collections import Counter
    from .locations import state_of, label
    with get_db_session() as session:
        rows = session.query(Job.location, func.count(Job.id)).filter(Job.status.in_([JobStatus.NEW, JobStatus.ACTIVE, JobStatus.SAVED])).group_by(Job.location).all()
    counts = Counter()
    for place, number in rows:
        code = state_of(place)
        if code:
            counts[code] += number
    return {'states': [{'code': code, 'name': label(code), 'count': number} for code, number in sorted(counts.items(), key=lambda item: label(item[0]))]}


@app.get('/api/companies')
def list_companies():
    with get_db_session() as session:
        names = session.query(Job.company_name).filter(
            Job.company_name.isnot(None), Job.status.in_([JobStatus.NEW, JobStatus.ACTIVE, JobStatus.SAVED])
        ).distinct().all()
        return {'companies': sorted({name for (name,) in names if name})}


@app.get("/api/jobs/{job_id}")
def get_job_detail(job_id: int):
    with get_db_session() as session:
        job = JobRepository(session).get_job_by_id(job_id)
        if job is None:
            raise HTTPException(404, "Job not found")
        result = job_payload(job, detail=True)
        result["label_agreement"] = label_agreement(session)
        from ..processing.tracks import active_track
        from ..services.rule_tuner import RuleTuner
        result["rule_tuning"] = RuleTuner().status(session, active_track())
        result["cover_letter_draft"] = ApplicationAgent(session).generate_cover_letter(job)
        return result


@app.post("/api/jobs/{job_id}/fit-label")
def label_fit(job_id: int, req: FitLabelRequest):
    """His verdict on a posting: overrides the rules and the reviewer, and teaches the reviewer."""
    from datetime import datetime, timezone
    with get_db_session() as session:
        job = JobRepository(session).get_job_by_id(job_id)
        if job is None:
            raise HTTPException(404, "Job not found")
        from ..processing.tracks import active_track, per_track, with_track
        track = active_track()
        job.user_fit_label = with_track(job.user_fit_label, track, None if req.fit is None else {
            'fit': req.fit, 'note': req.note.strip(), 'labeled_at': datetime.now(timezone.utc).isoformat()})
        session.commit()
        # His labels are the strongest evidence; let the tuner check the rules against them.
        tune_later(track)
        return {"success": True, "job_id": job_id, "track": track, "label": per_track(job.user_fit_label, track)}

@app.get("/api/rule-tuning")
def rule_tuning():
    from ..processing.tracks import load_tracks
    from ..services.rule_tuner import RuleTuner, history
    tuner = RuleTuner()
    with get_db_session() as session:
        return {"tracks": {k: tuner.status(session, k) for k in load_tracks()}, "history": history()}


class TrackRequest(BaseModel):
    track: str


@app.get("/api/track")
def get_track_choice():
    from ..processing.tracks import active_track, load_tracks
    return {"track": active_track(), "tracks": [{"key": t.key, "label": t.label} for t in load_tracks().values()]}


@app.post("/api/track")
def choose_track(req: TrackRequest):
    """Switch the dashboard and autoplay to another search track."""
    from ..processing.tracks import load_tracks
    from ..tracking.reclassify import show_track
    if req.track not in load_tracks():
        raise HTTPException(422, "Unknown track")
    with get_db_session() as session:
        rescored = show_track(session, req.track)
        try:
            export_static_dashboard(session)
        except Exception:
            logger.exception("Static export failed after switching track")
    return {"track": req.track, "rescored": rescored}


class BulkStatusRequest(BaseModel):
    job_ids: list[int] = Field(min_length=1, max_length=500)
    status: Literal['APPLIED', 'IGNORED']
    notes: Optional[str] = Field(default=None, max_length=1000)


@app.post("/api/jobs/bulk-status")
def bulk_status(req: BulkStatusRequest):
    """The list's checkboxes: mark the ticked postings applied, or delete them (IGNORED, so scans do not bring them back)."""
    status = JobStatus(req.status)
    history = {JobStatus.APPLIED, JobStatus.INTERVIEW, JobStatus.OFFER, JobStatus.REJECTED, JobStatus.WITHDRAWN}
    changed, skipped = [], []
    with get_db_session() as session:
        repo = JobRepository(session)
        for job_id in dict.fromkeys(req.job_ids):
            job = repo.get_job_by_id(job_id)
            # A posting already in his application history keeps that record: bulk actions never rewrite it.
            if job is None or job.status in history:
                skipped.append(job_id)
                continue
            if status == JobStatus.APPLIED:
                repo.record_application(job_id, notes=req.notes)
            else:
                repo.set_job_status(job_id, status, notes=req.notes)
            changed.append(job_id)
        session.commit()
        try:
            export_static_dashboard(session)
        except Exception:
            logger.exception("Static export failed after committed bulk status update")
    return {"changed": changed, "skipped": skipped, "status": status.value}


@app.post("/api/jobs/{job_id}/status")
def update_status(job_id: int, req: StatusUpdateRequest):
    with get_db_session() as session:
        repo = JobRepository(session)
        if repo.get_job_by_id(job_id) is None:
            raise HTTPException(404, "Job not found")
        if req.status == JobStatus.APPLIED:
            repo.record_application(job_id, notes=req.notes)
        else:
            repo.set_job_status(job_id, req.status, notes=req.notes)
        # Autoflush is disabled; commit before counting/exporting so artifacts agree.
        session.commit()
        warning = None
        try:
            export_static_dashboard(session)
        except Exception:
            logger.exception("Static export failed after committed status update")
            warning = "Status saved; snapshot refresh failed."
        return {"success": True, "job_id": job_id, "new_status": req.status.value, "warning": warning}


@app.post("/api/search", status_code=202)
def trigger_search():
    started = request_discovery()
    return {"success": True, "started": started, "is_scanning": True}



def local_source_mutation(request: Request):
    from urllib.parse import urlparse
    origin = request.headers.get('origin')
    if origin and origin != 'null' and urlparse(origin).hostname not in ('localhost', '127.0.0.1'):
        raise HTTPException(403, 'Use the local dashboard to manage sources.')


class AddSourceRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    url: str = Field(default='', max_length=2048)
    watch: bool = False


class WatchAllRequest(BaseModel):
    enabled: bool


class WatchRequest(BaseModel):
    company: str = Field(min_length=1, max_length=255)
    enabled: bool


@app.get('/api/sources')
def list_sources():
    from ..db.models import SourceRecord, CompanyWatch, SourceTask
    from ..discovery.source_catalog import serialize_source
    from ..services.watch import notification_status
    with get_db_session() as session:
        sources = [serialize_source(s) for s in session.query(SourceRecord).order_by(SourceRecord.company_name)]
        watches = {w.company_key: {'enabled': w.enabled, 'baseline_ready': w.baseline_at is not None,
                   'last_checked': w.last_checked_at, 'error': w.last_error} for w in session.query(CompanyWatch)}
        tasks = [{'id': t.id, 'kind': t.kind, 'status': t.status, 'error': t.error}
                 for t in session.query(SourceTask).order_by(SourceTask.id.desc()).limit(5)]
        return {'sources': sources, 'watches': watches, 'notifications': notification_status(session), 'tasks': tasks}


@app.post('/api/sources', status_code=202, dependencies=[Depends(local_source_mutation)])
def add_source(req: AddSourceRequest):
    from ..agents.source_agent import queue_task
    if not req.name.strip(): raise HTTPException(422, 'Company name is required.')
    return {'task_id': queue_task('add', {'name': req.name.strip(), 'url': req.url.strip(), 'watch': req.watch})}


@app.get('/api/email-alerts')
def email_alerts():
    from ..services.scheduler import email_alerts_status
    return email_alerts_status()


@app.post('/api/email-alerts/scan', status_code=202, dependencies=[Depends(local_source_mutation)])
def scan_email_alerts():
    from ..services.scheduler import email_alerts_status, request_email_alerts
    started = request_email_alerts()
    return {'started': started, **email_alerts_status()}


@app.post('/api/sources/audit', status_code=202, dependencies=[Depends(local_source_mutation)])
def audit_sources():
    from ..agents.source_agent import queue_task
    return {'task_id': queue_task('audit', {})}


@app.post('/api/sources/{source_id}/{action}', status_code=202, dependencies=[Depends(local_source_mutation)])
def change_source(source_id: int, action: str):
    from ..agents.source_agent import queue_task
    from ..db.models import SourceRecord
    if action not in ('remove', 'recheck'): raise HTTPException(404, 'Unknown action')
    with get_db_session() as session:
        if not session.get(SourceRecord, source_id): raise HTTPException(404, 'Source not found')
    return {'task_id': queue_task(action, {'id': source_id})}


@app.get('/api/source-tasks/{task_id}')
def source_task(task_id: int):
    from ..db.models import SourceTask
    with get_db_session() as session:
        task = session.get(SourceTask, task_id)
        if not task: raise HTTPException(404, 'Task not found')
        return {'id': task.id, 'status': task.status, 'result': task.result, 'error': task.error}


@app.post('/api/watches/all', dependencies=[Depends(local_source_mutation)])
def update_all_watches(req: WatchAllRequest):
    from ..services.watch import watch_all
    with get_db_session() as session:
        changed = watch_all(session, req.enabled)
    return {'enabled': req.enabled, 'changed': changed}


@app.post('/api/watches', dependencies=[Depends(local_source_mutation)])
def update_watch(req: WatchRequest):
    from ..agents.source_agent import set_watch
    from ..db.models import SourceRecord
    with get_db_session() as session:
        source = next((s for s in session.query(SourceRecord).filter_by(enabled=True)
                       if s.company_name.casefold() == req.company.casefold() and s.ats_type not in CHANNELS), None)
        if req.enabled and not source: raise HTTPException(422, 'Add a working company source before watching it.')
        watch = set_watch(session, source.company_name if source else req.company, req.enabled, minimum_fit=0)
        return {'enabled': watch.enabled, 'company': watch.company_name}


class SettingsRequest(BaseModel):
    values: dict = Field(default_factory=dict)
    reset: list = Field(default_factory=list)


@app.get('/api/settings')
def list_settings():
    from ..settings import describe
    return {'settings': describe(), 'rescore': _rescore_state}


@app.post('/api/settings', dependencies=[Depends(local_source_mutation)])
def save_settings(req: SettingsRequest):
    """Store his changes to tunable parameters; scoring changes take effect after a rescore."""
    from ..settings import BY_KEY, describe, save
    try:
        changed = save(req.values, req.reset)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    needs = sorted({BY_KEY[k].applies for k in changed if BY_KEY[k].applies != 'next use'})
    return {'changed': changed, 'needs': needs, 'settings': describe()}


_rescore_state = {'running': False, 'result': None, 'error': None}


@app.post('/api/rescore', status_code=202, dependencies=[Depends(local_source_mutation)])
def rescore_postings():
    """Re-judge every stored posting with the current rules and settings, then prune."""
    import threading
    if _rescore_state['running']:
        return _rescore_state
    def work():
        from ..processing.track_eval import prune_rejected
        from ..tracking.reclassify import reclassify_jobs
        _rescore_state.update(running=True, error=None)
        try:
            with get_db_session() as session:
                changed = reclassify_jobs(session)
                removed = prune_rejected(session)
                export_static_dashboard(session)
            _rescore_state['result'] = {'changed': changed, 'removed': removed, 'at': utc_now().isoformat()}
        except Exception as exc:
            logger.exception('Rescore failed')
            _rescore_state['error'] = str(exc)[:300]
        finally:
            _rescore_state['running'] = False
    threading.Thread(target=work, daemon=True, name='rescore').start()
    _rescore_state['running'] = True
    return _rescore_state


def run_server(host: str = "127.0.0.1", port: int = 8000):
    settings = get_settings()
    init_db()
    # Publish every setting's effective value for the application agent to read.
    from ..settings import write as write_settings
    write_settings()
    from ..agents.source_agent import recover_tasks
    recover_tasks()
    # Email postings still waiting for a source scan: add them before the scheduler starts one.
    try:
        from ..discovery.email_alerts import add_pending
        with get_db_session() as session:
            add_pending(session)
    except Exception:
        logger.exception('Could not add waiting email-alert postings at startup')
    scheduler = RefreshScheduler(blocking=False)
    scheduler.start()
    try:
        uvicorn.run(app, host=host or settings.server_host, port=port or settings.server_port)
    finally:
        from ..services.application_runner import shutdown_runner
        shutdown_runner()
        scheduler.scheduler.shutdown(wait=False)
