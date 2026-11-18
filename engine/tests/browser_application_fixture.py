"""Isolated two-worker fixture: no real employers or API requests."""
from pathlib import Path
from tempfile import mkdtemp
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import threading,json
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from jobagent.db.models import Base,Job,EligibilityStatus
from jobagent.services.application_runner import ApplicationRunner
from jobagent.ui import server,application_routes
root=Path(mkdtemp(prefix='jobagent-app-e2e-'));agent=root/'agent';(agent/'src').mkdir(parents=True);(agent/'private').mkdir()
submissions=[]
class Employer(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.end_headers()
  if self.path.startswith('/submit'):
   submissions.append(self.path);(root/'submissions.json').write_text(json.dumps(submissions));body='<h1>Application received</h1>'
  else:body='''<html><body style="background:#f1f5f9;font:18px system-ui;padding:60px"><h1>Mechanical Engineer — Test Employer</h1><p>Local test application. No real employer receives this form.</p><form action="/submit"><label>Name<input name="name" required></label><br><br><label>Why this role?<textarea name="why" required></textarea></label><br><br><button type="submit">Submit application</button></form></body></html>'''
  self.wfile.write(body.encode())
 def log_message(self,*a):pass
employer=ThreadingHTTPServer(('127.0.0.1',0),Employer);threading.Thread(target=employer.serve_forever,daemon=True).start()
profile={'resumePath':'private/resume.pdf','answers':{'fullName':'Fixture Applicant'},'policy':{}}
(agent/'private/profile.json').write_text(json.dumps(profile));(agent/'private/resume.pdf').write_text('fixture resume')
worker_module=(Path(__file__).resolve().parents[2]/'application-agent/src/dashboard-worker.mjs').as_uri()
wrapper='''import {runWorker} from WORKER_MODULE;

const execImpl=async(_command,_args,prompt)=>{const input=JSON.parse(prompt);const controls=input.page.frames.flatMap(f=>f.controls);const target=controls.find(c=>c.type==='text'&&!c.value)||controls.find(c=>c.type==='textarea'&&!c.value)||controls.find(c=>c.type==='submit');return{code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:target.type==='text'?'fill':target.type==='textarea'?'ask':'review',control:target.id,fact:'fullName',message:''},usage:{input_tokens:1,output_tokens:1}})};};
await runWorker(process.argv[2],{execImpl,stateRoot:process.cwd()+'/state',allowLocalFixture:true});
'''
(agent/'src/dashboard-worker.mjs').write_text(wrapper.replace('WORKER_MODULE',json.dumps(worker_module)))
engine=create_engine('sqlite:///'+str(root/'test.db'),connect_args={'check_same_thread':False});Base.metadata.create_all(engine)
@contextmanager
def sessions():
 with Session(engine) as s:
  yield s
  s.commit()
with sessions() as s:
 for id,company in [(1,'Fixture Robotics'),(2,'Fixture Aerospace')]:
  url=f'http://127.0.0.1:{employer.server_port}/job/{id}'
  s.add(Job(id=id,company_name=company,title='Mechanical Engineer',description='BS Mechanical Engineering',location='San Francisco, California, United States',canonical_url=url,application_url=url,source_ats='direct',role_type='FULL_TIME',eligibility=EligibilityStatus.ELIGIBLE))
# Isolated settings: standing auto-submit on (as he runs it); nothing that would call a real model CLI.
from jobagent import settings as jobagent_settings
(root/'settings.json').write_text(json.dumps({'overrides':{'workers.auto_submit':True,'workers.resume_tailoring':False,'workers.learned_drafts':False}}))
jobagent_settings.settings_path=lambda:root/'settings.json'
runner=ApplicationRunner(root/'runs',agent,sessions)
runner.data['autoplay']['enabled']=False  # only the two roles the smoke queues
runner.data['engine']='claude'
runner._cli=lambda engine: '/fixture/claude'
runner.check_engine=lambda engine=None: {'status':'ready','message':'Local fixture CLI'}
server.get_db_session=sessions;application_routes.get_runner=lambda:runner
Path('/tmp/application-e2e-path').write_text(str(root))
import uvicorn
try:uvicorn.run(server.app,host='127.0.0.1',port=8877,log_level='warning')
finally:runner.shutdown();employer.shutdown()
