"""Company watch agent with a baseline, eligibility filtering, and durable email deduplication."""
from datetime import timezone
import subprocess
import time

_availability_cache = {}

from sqlalchemy import or_, func

from ..config import load_profile_config, get_settings
from ..db.models import CompanyWatch, WatchAlert, Job, JobStatus, SourceRecord, utc_now
from ..db.repository import get_db_session
from ..discovery.source_catalog import CHANNELS

APPLICABLE = ('STRONG_MATCH','ELIGIBLE','LIKELY_ELIGIBLE')


class DeliveryUncertain(Exception):
    pass


class AppleMailSender:
    """Use the user's configured Mail account; no passwords are stored by JobAgent."""
    def __init__(self, address=None):
        self.address=address or load_profile_config(get_settings().config_dir).candidate['email']

    def available(self):
        cached = _availability_cache.get(self.address)
        if cached and time.monotonic() - cached[0] < 60: return cached[1]
        script='tell application "Mail" to get email addresses of every account'
        try:
            result=subprocess.run(['osascript','-e',script],capture_output=True,text=True,timeout=10)
            available = result.returncode==0 and self.address in result.stdout
            _availability_cache[self.address] = (time.monotonic(), available)
            return available
        except (OSError,subprocess.TimeoutExpired):return False

    def send(self, subject, body):
        script='''on run argv
set mailAddress to item 1 of argv
set mailSubject to item 2 of argv
set mailBody to item 3 of argv
tell application "Mail"
set outgoingMessage to make new outgoing message with properties {subject:mailSubject, content:mailBody, visible:false, sender:mailAddress}
tell outgoingMessage
make new to recipient at end of to recipients with properties {address:mailAddress}
end tell
return send outgoingMessage
end tell
end run'''
        try:
            result=subprocess.run(['osascript','-e',script,self.address,subject,body],capture_output=True,text=True,timeout=30)
        except subprocess.TimeoutExpired as exc:
            raise DeliveryUncertain('Mail handoff timed out; automatic resend is disabled to avoid duplicates.') from exc
        if result.returncode or result.stdout.strip().lower()!='true':
            raise DeliveryUncertain('Mail did not confirm the send request. Check Mail before retrying.')


def notification_status(session):
    sender=AppleMailSender()
    return {'recipient':sender.address, 'transport':'Apple Mail',
            'available':sender.available(), 'interval_minutes':15,
            'watched':session.query(CompanyWatch).filter_by(enabled=True).count(),
            'pending':session.query(WatchAlert).filter_by(status='pending').count(),
            'uncertain':session.query(WatchAlert).filter(WatchAlert.status.in_(['sending','uncertain'])).count(),
            'sent':session.query(WatchAlert).filter_by(status='sent').count()}


def process_watches(session, source_results, *, sender=None, now=None):
    now=now or utc_now()
    successful={r['company'].casefold() for r in source_results if not r.get('error') or r.get('jobs_found',0)>0}
    for watch in session.query(CompanyWatch).filter_by(enabled=True).all():
        if watch.company_key not in successful:
            watch.last_error='No complete successful company scan yet; alerts held until verification succeeds.'
            continue
        watch.last_checked_at=now
        watch.last_error='Partial source coverage; alerts cover verified roles found in this scan.' if any(
            r['company'].casefold()==watch.company_key and (r.get('truncated') or r.get('error')) for r in source_results) else None
        if watch.baseline_at is None:
            watch.baseline_at=now
            continue  # the first successful scan establishes existing openings, not an email flood
        # Only new discoveries after the baseline are eligible. Known old posting dates
        # also suppress notifications when an old role first appears through another source.
        jobs=session.query(Job).filter(
            func.lower(Job.company_name)==watch.company_name.lower(), Job.discovery_date>watch.baseline_at,
            Job.status.in_([JobStatus.NEW,JobStatus.ACTIVE]), Job.role_type=='FULL_TIME',
            Job.eligibility.in_(APPLICABLE), Job.relevance_score>=watch.minimum_fit,
            or_(Job.posting_date.is_(None), Job.posting_date>=watch.started_at)).all()
        existing={a.job_id for a in session.query(WatchAlert).filter_by(watch_id=watch.id)}
        for job in jobs:
            if job.id not in existing:
                session.add(WatchAlert(watch_id=watch.id,job_id=job.id,status='pending'))
    session.commit()
    deliver_pending(session,sender=sender)


def deliver_pending(session, *, sender=None):
    sender=sender or AppleMailSender()
    pending=session.query(WatchAlert).filter_by(status='pending').all()
    if not pending:return
    if not sender.available():
        for alert in pending:alert.error='Configured email account is unavailable in Apple Mail; retained for retry.'
        session.commit();return
    groups={}
    for alert in pending:groups.setdefault(alert.watch_id,[]).append(alert.id)
    # Persist every claim BEFORE the external side effect, so a crash or timeout never resends.
    batches=[]
    for watch_id,ids in groups.items():
        watch=session.get(CompanyWatch,watch_id)
        if not watch or not watch.enabled:continue
        claimed=[]
        for id in ids:
            job=session.get(Job,session.get(WatchAlert,id).job_id)
            if not job or job.status not in (JobStatus.NEW,JobStatus.ACTIVE) or job.eligibility.value not in APPLICABLE or job.role_type!='FULL_TIME' or job.relevance_score<watch.minimum_fit:
                session.get(WatchAlert,id).status='cancelled';continue
            count=session.query(WatchAlert).filter_by(id=id,status='pending').update({'status':'sending','error':None})
            if count:claimed.append(id)
        if claimed:batches.append((watch,claimed))
    session.commit()
    if not batches:return
    # One digest per scan, however many watched companies posted, so watching everything
    # never floods the inbox.
    total=sum(len(ids) for _,ids in batches)
    subject=(f'JobAgent: {total} new eligible role(s) at {batches[0][0].company_name}' if len(batches)==1
             else f'JobAgent: {total} new eligible roles at {len(batches)} companies')
    lines=['New roles that pass your saved eligibility filters:','']
    for watch,ids in batches:
        lines += [f'== {watch.company_name} ==','']
        for id in ids:
            job=session.get(Job,session.get(WatchAlert,id).job_id)
            lines += [job.title, job.location or 'Location not listed',job.salary_raw or 'Salary not listed',
                      f'Fit: {job.relevance_score:.0f}/100',job.application_url,'']
    lines += ['Review these roles in JobAgent: http://127.0.0.1:8000',
              'You can turn off company alerts under Sources & watches in the dashboard.']
    claimed=[id for _,ids in batches for id in ids]
    try:
        sender.send(subject,'\n'.join(lines))
        for id in claimed:
            alert=session.get(WatchAlert,id);alert.status='sent';alert.sent_at=utc_now()
    except Exception as exc:
        for id in claimed:
            alert=session.get(WatchAlert,id);alert.status='uncertain';alert.error=str(exc)[:500]
    session.commit()


def watch_all(session, enabled):
    """Watch (or stop watching) every active company source in one step."""
    from ..agents.source_agent import set_watch
    if not enabled:
        changed=0
        for watch in session.query(CompanyWatch).filter_by(enabled=True).all():
            set_watch(session,watch.company_name,False,minimum_fit=watch.minimum_fit);changed+=1
        session.commit();return changed
    companies={}
    for source in session.query(SourceRecord).filter_by(enabled=True):
        if source.ats_type not in CHANNELS:companies.setdefault(source.company_name.casefold(),source.company_name)
    already={w.company_key for w in session.query(CompanyWatch).filter_by(enabled=True)}
    changed=0
    for key,name in companies.items():
        if key not in already:
            set_watch(session,name,True,minimum_fit=0);changed+=1
    session.commit();return changed


def run_watch_scan():
    from .scheduler import _claim_discovery, _release_discovery
    from ..discovery.search_agent import SearchAgent
    if not _claim_discovery():return
    try:
        with get_db_session() as session:
            watched={w.company_key for w in session.query(CompanyWatch).filter_by(enabled=True)}
            ids=[s.id for s in session.query(SourceRecord).filter_by(enabled=True) if s.company_name.casefold() in watched and s.ats_type not in CHANNELS]
            if not ids:return
            stats=SearchAgent(session).run_discovery(source_ids=ids)
            process_watches(session,stats['source_results'])
            from ..ui.exporter import export_static_dashboard
            export_static_dashboard(session)
    finally:_release_discovery()
