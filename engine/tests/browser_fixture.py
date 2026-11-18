import tempfile,os,json
from pathlib import Path
from datetime import timedelta
root=Path(tempfile.mkdtemp(prefix='jobagent-browser-'))
os.environ['JOBAGENT_DB_URL']='sqlite:///'+str(root/'test.db')
from jobagent.db.repository import init_db,get_db_session
from jobagent.db.models import Job,JobStatus,EligibilityStatus,utc_now
from jobagent.ui import server
from jobagent.ui.exporter import export_static_dashboard
init_db()
with get_db_session() as s:
 for i in range(112):
  status=JobStatus.ACTIVE if i<105 else [JobStatus.SAVED,JobStatus.APPLIED,JobStatus.INTERVIEW,JobStatus.OFFER,JobStatus.REJECTED,JobStatus.CLOSED,JobStatus.IGNORED][i-105]
  s.add(Job(company_name='Hardware & Co',title=f'Mechanical Engineer I {i}',normalized_title=f'mechanical engineer i {i}',description='Required: BS in Mechanical Engineering. One year of experience.',canonical_url=f'https://example.com/jobs/{i}',application_url=f'https://example.com/jobs/{i}',source_ats='direct',status=status,role_type='FULL_TIME',eligibility=EligibilityStatus.ELIGIBLE,priority_score=86,urgency_score=92,best_career_cluster='PRODUCT / MECHANICAL DESIGN',discovery_date=utc_now()-timedelta(hours=1)))
 s.commit();export_static_dashboard(s,root/'docs')
server.export_static_dashboard=lambda s:export_static_dashboard(s,root/'docs')
Path('/private/tmp/jobagent-browser-fixture-path.json').write_text(json.dumps({'root':str(root)}))
import uvicorn
uvicorn.run(server.app,host='127.0.0.1',port=8877,log_level='warning')
