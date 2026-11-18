"""Source-management agent: inspect, select an adapter, verify, and edit persistent configuration."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict
import threading
import time
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from ..db.models import SourceRecord, SourceTask, CompanyWatch, WatchAlert, utc_now
from ..db.repository import get_db_session
from ..discovery.source_catalog import source_key, source_target, update_overrides
from ..discovery.source_health import get_public, public_url, probe_source


def infer_adapter(name, url):
    parsed=urlparse(url); host=(parsed.hostname or '').lower()
    path=[p for p in parsed.path.split('/') if p]
    employer_boards = {
        'www.bmwgroup.jobs': ('bmw', 'https://www.bmwgroup.jobs/us/en.html'),
        'bmwgroup.jobs': ('bmw', 'https://www.bmwgroup.jobs/us/en.html'),
        'jobs.mercedes-benz.com': ('mercedes', 'https://jobs.mercedes-benz.com/enUS'),
        'careers.ibm.com': ('ibm', 'https://www.ibm.com/careers/search'),
        'careers.rivian.com': ('rivian', 'https://careers.rivian.com/jobs'),
        'www.tesla.com': ('tesla', 'https://www.tesla.com/careers/search'),
        'tesla.com': ('tesla', 'https://www.tesla.com/careers/search'),
    }
    if host in ('www.ibm.com', 'ibm.com') and parsed.path.startswith('/careers'):
        employer_boards[host] = ('ibm', 'https://www.ibm.com/careers/search')
    if host in employer_boards:
        ats, board = employer_boards[host]
        if parsed.query and ats in ('ibm', 'rivian'):
            board += '?' + parsed.query
        return ats, source_target(name, ats, url=board)
    known={'job-boards.greenhouse.io':'greenhouse','boards.greenhouse.io':'greenhouse',
           'jobs.lever.co':'lever','jobs.ashbyhq.com':'ashby'}
    if host=='boards-api.greenhouse.io' and len(path)>=3 and path[:2]==['v1','boards']:
        return 'greenhouse',source_target(name,'greenhouse',path[2])
    if host in known and path:
        ats=known[host]
        return ats,source_target(name,ats,path[0],url)
    if host.endswith('.breezy.hr') and host.count('.')==2:
        return 'breezy',source_target(name,'breezy',host.split('.')[0])
    if host in ('jobs.smartrecruiters.com', 'careers.smartrecruiters.com') and path:
        return 'smartrecruiters',source_target(name,'smartrecruiters',path[0],url)
    if host.endswith('.myworkdayjobs.com') and path:
        return 'workday',source_target(name,'workday',url=url)
    if (host.endswith('.oraclecloud.com') or host == 'careers.honeywell.com') and '/sites/' in parsed.path:
        return 'oracle',source_target(name,'oracle',url=url)
    if host in ('www.amazon.jobs','amazon.jobs'):
        return 'amazon',source_target(name,'amazon',url='https://www.amazon.jobs')
    if host=='jobs.siemens.com' and 'SearchJobs' in parsed.path:
        return 'siemens',source_target(name,'siemens',url=url)
    if host=='jobs.apple.com' and parsed.path.endswith('/search'):
        return 'browser',source_target(name,'browser',url=url)
    if host in ('www.metacareers.com','www.google.com','apply.careers.microsoft.com') and ('career' in host or '/careers/' in parsed.path):
        return 'browser',source_target(name,'browser',url=url)
    return None


class SourceManagementAgent:
    def add(self, name, url='', watch=False):
        if url:
            return self._add(name, url, watch)
        # Name only: a CLI researches the board; each proposal is verified exactly like a pasted URL.
        with get_db_session() as session:
            existing=session.query(SourceRecord).filter(SourceRecord.company_name.ilike(name),SourceRecord.enabled.is_(True)).first()
            if existing:
                return {'source_id':existing.id,'company':existing.company_name,'adapter':existing.ats_type,'health':existing.health,
                        'message':f'{existing.company_name} is already an active source ({existing.target.get("career_url")}).'}
        from .source_research import research
        candidates,note=research(name)
        failures=[]
        for candidate in candidates:
            try:
                result=self._add(name,candidate,watch)
                result['message']=f'Found {name} at {candidate}. '+result['message']
                return result
            except Exception as exc:
                failures.append(f'{candidate}: {exc}')
        raise ValueError(f'Could not find a working job board for {name}. '+('Tried '+'; '.join(failures) if failures else note or 'No board found.')+' Paste the careers URL instead.')

    def _add(self, name, url, watch=False):
        public_url(url)
        selected=infer_adapter(name,url)
        if not selected:
            with httpx.Client(timeout=15,headers={'User-Agent':'JobAgent/1.0'}) as client:
                response=get_public(client,url);response.raise_for_status()
                selected=infer_adapter(name,str(response.url))
                soup=BeautifulSoup(response.text,'html.parser')
                base=soup.select_one('base[data-apibaseurl][data-sitenumber]')
                if not selected and base and (urlparse(base['data-apibaseurl']).hostname or '').endswith('.oraclecloud.com'):
                    selected=('oracle',source_target(name,'oracle',url=str(response.url)))
                for node in soup.select('a[href], iframe[src]'):
                    if selected:break
                    candidate=urljoin(str(response.url),node.get('href') or node.get('src'))
                    selected=infer_adapter(name,candidate)
        ats,target=selected or ('direct',source_target(name,'direct',url=url))
        result=probe_source(ats,target)
        if not result.working:
            raise ValueError(f'Could not add {name}: {result.detail}. Supply the company’s job-board/search URL.')
        key=source_key(ats,target)
        update_overrides(added={'key':key,'ats_type':ats,'target':target},enabled=[key])
        with get_db_session() as session:
            source=session.query(SourceRecord).filter_by(key=key).first()
            if not source:
                source=SourceRecord(key=key,company_name=name,ats_type=ats,target=target,origin='dashboard')
                session.add(source)
            source.enabled=True; source.health=result.health;source.detail=result.detail
            source.checked_at=utc_now();source.jobs_found=result.jobs_found
            session.flush()
            if watch:
                set_watch(session,source.company_name,True)
            id=source.id
        return {'source_id':id,'company':name,'adapter':ats,'health':result.health,
                'message':f'{name} verified and added. Future scans will use this source.',
                'config_file':'config/source_overrides.yaml'}

    def remove(self, id):
        with get_db_session() as session:
            source=session.get(SourceRecord,id)
            if not source:raise ValueError('Source not found')
            update_overrides(disabled=[source.key]);source.enabled=False
        return {'source_id':id,'message':'Removed from active scans. Job history is preserved.'}

    def recheck(self,id):
        with get_db_session() as session:
            source=session.get(SourceRecord,id)
            if not source:raise ValueError('Source not found')
            target=dict(source.target);ats=source.ats_type;key=source.key
        result=probe_source(ats,target)
        update_overrides(enabled=[key] if result.working else [], disabled=[] if result.working else [key])
        with get_db_session() as session:
            source=session.get(SourceRecord,id);source.health=result.health;source.detail=result.detail
            source.jobs_found=result.jobs_found;source.checked_at=utc_now();source.enabled=result.working
        return {'source_id':id,**asdict(result),'message':result.detail}

    def audit(self):
        with get_db_session() as session:
            records=[(s.id,s.key,s.company_name,s.ats_type,dict(s.target)) for s in session.query(SourceRecord).filter_by(enabled=True)]
        semaphores={ats:threading.Semaphore(2) for _,_,_,ats,_ in records}
        def check(record):
            id,key,name,ats,target=record
            with semaphores[ats]:
                result=probe_source(ats,target)
                if not result.working:
                    time.sleep(1);result=probe_source(ats,target)
            return {'source_id':id,'key':key,'company':name,'working':result.working,**asdict(result)}
        with ThreadPoolExecutor(max_workers=8) as pool:
            results=list(pool.map(check,records))
        update_overrides(disabled=[r['key'] for r in results if not r['working']])
        with get_db_session() as session:
            for r in results:
                source=session.get(SourceRecord,r['source_id']);source.enabled=r['working'];source.health=r['health']
                source.detail=r['detail'];source.jobs_found=r['jobs_found'];source.checked_at=utc_now()
        return {'checked':len(results),'removed':sum(not r['working'] for r in results),'sources':results}


def set_watch(session,company,enabled,minimum_fit=0):
    key=company.strip().casefold()
    watch=session.query(CompanyWatch).filter_by(company_key=key).first()
    if not watch:
        watch=CompanyWatch(company_key=key,company_name=company,enabled=False,minimum_fit=minimum_fit)
        session.add(watch)
    if enabled and not watch.enabled:
        watch.started_at=utc_now();watch.baseline_at=None;watch.last_error=None
    if not enabled and watch.id:
        session.query(WatchAlert).filter_by(watch_id=watch.id,status="pending").update({"status":"cancelled"})
    watch.enabled=enabled;watch.minimum_fit=minimum_fit
    session.flush()
    return watch


_executor=ThreadPoolExecutor(max_workers=1,thread_name_prefix='source-agent')


def run_task(id):
    with get_db_session() as session:
        task=session.get(SourceTask,id)
        if not task or task.status!='queued':return
        task.status='running';kind=task.kind;payload=dict(task.payload)
    try:
        from .source_repair import repair
        agent=SourceManagementAgent()
        result={'add':agent.add,'remove':agent.remove,'recheck':agent.recheck,'audit':agent.audit,'repair':repair}[kind](**payload)
        with get_db_session() as session:
            task=session.get(SourceTask,id);task.status='complete';task.result=result;task.completed_at=utc_now()
    except Exception as exc:
        with get_db_session() as session:
            task=session.get(SourceTask,id);task.status='failed';task.error=str(exc)[:1000];task.completed_at=utc_now()


def queue_task(kind,payload):
    with get_db_session() as session:
        task=SourceTask(kind=kind,payload=payload);session.add(task);session.flush();id=task.id
    _executor.submit(run_task,id)
    return id


def recover_tasks():
    with get_db_session() as session:
        for task in session.query(SourceTask).filter(SourceTask.status.in_(['queued','running'])):
            task.status='failed';task.error='Interrupted by a restart. Recheck the source before retrying.';task.completed_at=utc_now()
