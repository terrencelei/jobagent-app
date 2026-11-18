from contextlib import contextmanager
import json
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
import pytest
from jobagent.db.models import Base, Job, JobStatus, EligibilityStatus
from jobagent.services.application_runner import ApplicationRunner, atomic
from jobagent.ui import application_routes

@pytest.fixture
def runner(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 'test.db'), connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    @contextmanager
    def sessions():
        with Session(engine) as session:
            yield session
    with sessions() as session:
        for i, company in [(1, 'Acme'), (2, 'Acme'), (3, 'Other'), (4, 'Google')]:
            session.add(Job(id=i, fit_review={'fit': True, 'hash': None}, company_name=company, title='Mechanical Engineer', description='Design', location='United States',
                            canonical_url=f'https://example.com/{i}', application_url=f'https://example.com/{i}',
                            source_ats='direct', role_type='FULL_TIME', eligibility=EligibilityStatus.ELIGIBLE))
        session.commit()
    agent = tmp_path / 'agent'
    (agent / 'private').mkdir(parents=True)
    (agent / 'src').mkdir()
    (agent / 'src/dashboard-worker.mjs').touch()
    runner = ApplicationRunner(tmp_path / 'runs', agent, sessions)
    runner._cli = lambda engine: f'/fixture/bin/{engine}'
    yield runner
    runner.shutdown_event.set()  # a launch starts the tick loop; leave no thread behind at interpreter exit

class FakeProcess:
    pid = 99999999
    def poll(self): return None

def test_answer_drafts_are_review_only_and_survive_restart(runner):
    runner.queue([1])
    item = runner.data['jobs'][0]
    item.update(status='needs_approval', questions=[
        {'label': 'Describe a project', 'type': 'textarea', 'required': True},
        {'label': 'Travel?', 'options': ['Yes', 'No'], 'required': True},
    ])
    runner._save()
    assert runner.save_answer_drafts(1, {'Describe a project': 'A résumé-based draft.'})['saved'] == 1
    assert item['status'] == 'needs_approval'
    assert not item.get('approved_answers')
    assert 'draft' not in item['questions'][0]
    assert runner.approvals()[0]['questions'][0]['draft'] == 'A résumé-based draft.'
    recovered = ApplicationRunner(runner.directory, runner.agent_dir, runner.sessions)
    assert recovered.approvals()[0]['questions'][0]['draft'] == 'A résumé-based draft.'
    with pytest.raises(ValueError, match='free-text'):
        runner.save_answer_drafts(1, {'Travel?': 'Yes'})
    with pytest.raises(ValueError, match='free-text'):
        runner.save_answer_drafts(1, {'Unknown question': 'Invented'})
    runner.data['jobs'][0]['status'] = 'completed'
    with pytest.raises(ValueError, match='no longer waiting'):
        runner.save_answer_drafts(1, {'Describe a project': 'Late draft'})

def test_queue_rejects_whole_invalid_batch_and_deduplicates(runner):
    with pytest.raises(ValueError, match='Google'): runner.queue([1, 4])
    assert runner.snapshot()['queue'] == []
    assert runner.queue([1, 1])['added'] == 1
    assert runner.queue([1])['duplicate'] == 1
    with runner.sessions() as session:
        session.get(Job, 2).status = JobStatus.APPLIED
        session.commit()
    with pytest.raises(ValueError, match='unapplied'): runner.queue([2])

def test_dispatch_serializes_company_and_rechecks_eligibility(runner):
    launches = []
    runner.popen = lambda *a, **kw: launches.append(a) or FakeProcess()
    runner.queue([1, 2, 3])
    runner.data.update(running=True, parallelism=3)
    runner.tick()
    assert len(launches) == 2
    assert [j['job_id'] for j in runner.snapshot()['queue']] == [2]
    with runner.sessions() as session:
        session.get(Job, 2).eligibility = EligibilityStatus.INELIGIBLE
        session.commit()
    runner.processes.clear()
    runner.tick()
    assert runner.data['jobs'][1]['status'] == 'skipped'
    assert runner.help_items() == []

def test_restart_never_resumes_active_or_submitting(runner):
    runner.queue([1, 2])
    runner.data['jobs'][0]['status'] = 'submitting'
    runner.data['running'] = True
    runner._save()
    recovered = ApplicationRunner(runner.directory, runner.agent_dir, runner.sessions)
    assert recovered.data['running'] is False
    assert recovered.data['jobs'][0]['status'] == 'interrupted'
    assert recovered.data['jobs'][1]['status'] == 'queued'

def test_review_approval_requires_current_identifier(runner):
    runner.queue([1])
    item = runner.data['jobs'][0]
    runner.processes[item['id']] = FakeProcess()
    atomic(runner.directory / item['id'] / 'state.json', {'status': 'waiting_review', 'review': {'id': 'fresh'}})
    with pytest.raises(ValueError, match='review changed'): runner.command(1, 'approve', review_id='old')
    runner.command(1, 'approve', review_id='fresh')
    command = json.loads((runner.directory / item['id'] / 'commands.json').read_text())
    assert command['review_id'] == 'fresh'
    with pytest.raises(ValueError, match='previous command'): runner.command(1, 'approve', review_id='fresh')

def test_employer_acknowledgement_does_not_record_applied(runner):
    runner.queue([1])
    item = runner.data['jobs'][0]
    atomic(runner.directory / item['id'] / 'state.json', {'status': 'submitted_pending_receipt'})
    runner._refresh(item)
    with runner.sessions() as session: assert session.get(Job, 1).status == JobStatus.NEW

def test_existing_submission_blocks_duplicate(runner):
    atomic(runner.agent_dir / 'state/jobagent-1.json', {'status': 'submission_unknown'})
    with pytest.raises(ValueError, match='unresolved submission'): runner.queue([1])

def test_private_api_denies_cross_origin_and_csrf(runner, monkeypatch):
    monkeypatch.setattr(application_routes, 'get_runner', lambda: runner)
    app = FastAPI()
    app.include_router(application_routes.router)
    client = TestClient(app)
    assert client.get('/api/applications').status_code == 200
    for headers in [{'Origin': 'https://evil.example'}, {'Origin': 'null'}, {'Host': 'evil.example'}]:
        assert client.get('/api/applications', headers=headers).status_code == 403
    assert client.post('/api/applications/queue', json={'job_ids': [1]}).status_code == 403
    assert client.post('/api/applications/queue', json={'job_ids': [1]}, headers={'X-JobAgent-Application': '1'}).status_code == 200
    assert client.get('/api/applications/workers/not-real/screenshot').status_code == 409

def test_retry_preparation_gets_new_run_and_blocks_submission_uncertainty(runner):
    runner.queue([1])
    item = runner.data['jobs'][0]
    old_id = item['id']
    item.update(status='failed', review={'id': 'old'}, questions=[{'id': 'old'}])
    runner.command(1, 'retry')
    assert item['id'] != old_id and item['status'] == 'queued'
    assert 'review' not in item and 'questions' not in item
    item['status'] = 'stopped'
    atomic(runner.agent_dir / 'state/jobagent-1.json', {'status': 'submission_unknown'})
    with pytest.raises(ValueError, match='unresolved submission'): runner.command(1, 'retry')
    assert item['job_id'] == 1

def test_pending_receipt_not_counted_confirmed(runner):
    runner.queue([1])
    runner.data['jobs'][0]['status'] = 'submitted_pending_receipt'
    counts = runner.snapshot()['counts']
    assert counts['completed'] == 0 and counts['awaiting_receipt'] == 1

class Completed:
    def __init__(self, stdout): self.stdout, self.stderr = stdout, ''

def test_engine_check_refuses_api_billing_and_blocks_start(runner, monkeypatch):
    from jobagent.services import application_runner
    calls = []
    outputs = {'claude': json.dumps({'loggedIn': True, 'authMethod': 'apiKey'}), 'codex': 'Logged in using an API key - sk-***'}
    def run(args, **kw):
        calls.append((args, kw['env']))
        return Completed(outputs[args[0].rsplit('/', 1)[-1]])
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'fixture-secret')
    monkeypatch.setattr(application_runner.subprocess, 'run', run)
    assert runner.check_engine()['status'] == 'api_billing'
    assert 'ANTHROPIC_API_KEY' not in calls[-1][1]
    with pytest.raises(ValueError, match='API key'): runner.control('start')
    assert runner.data['running'] is False
    assert runner.check_engine('codex')['status'] == 'api_billing'
    outputs.update(claude=json.dumps({'loggedIn': True, 'authMethod': 'claude.ai', 'subscriptionType': 'pro'}), codex='Logged in using ChatGPT')
    assert runner.check_engine('codex')['status'] == 'ready'
    assert 'Pro plan' in runner.check_engine()['message']
    assert runner.snapshot()['engine_status']['status'] == 'ready'

def test_engine_and_parallelism_controls_reach_the_worker_request(runner):
    runner.popen = lambda *a, **kw: FakeProcess()
    from jobagent.settings import setting
    maximum = setting('workers.max_parallelism')
    with pytest.raises(ValueError, match=f'between 1 and {maximum}'): runner.control('configure', parallelism=maximum + 1)
    with pytest.raises(ValueError, match='claude, codex or agy'): runner.control('configure', engine='openai')
    snap = runner.control('configure', parallelism=5, engine='codex')
    assert snap['engine'] == 'codex' and snap['parallelism'] == 5
    runner.queue([1])
    runner.data['running'] = True
    runner.tick()
    item = runner.data['jobs'][0]
    request = json.loads((runner.directory / item['id'] / 'request.json').read_text())
    assert request['engine'] == 'codex' and request['command'] == '/fixture/bin/codex'
    assert item['engine'] == 'codex'
    # A restart keeps the selected engine.
    assert ApplicationRunner(runner.directory, runner.agent_dir, runner.sessions).data['engine'] == 'codex'

def queued(runner):
    return [j['job_id'] for j in runner.snapshot()['queue']]

def add_jobs(runner, rows):
    with runner.sessions() as session:
        for i, company, title, cluster, eligibility, priority in rows:
            session.add(Job(id=i, fit_review={'fit': True, 'hash': None}, company_name=company, title=title, description='d', location='United States', canonical_url=f'https://example.com/{i}',
                            application_url=f'https://example.com/{i}', source_ats='direct', role_type='FULL_TIME',
                            eligibility=eligibility, best_career_cluster=cluster, priority_score=priority))
        session.commit()

def test_queue_like_up_next_play_next_reorder_and_remove(runner):
    runner.queue([1, 3])
    runner.queue([2], position='next')
    assert queued(runner) == [2, 1, 3]
    runner.queue([3], position='next')  # already queued: moves to the front
    assert queued(runner) == [3, 2, 1]
    runner.move(1, 0)
    assert queued(runner) == [1, 3, 2]
    runner.command(3, 'stop')  # removing a queued role deletes it outright
    assert queued(runner) == [1, 2]
    assert runner.queue([3])['added'] == 1

def test_autoplay_follows_priority_within_disciplines_and_skips(runner):
    S, E = EligibilityStatus.STRONG_MATCH, EligibilityStatus.ELIGIBLE
    add_jobs(runner, [
        (10, 'Rocket Co', 'Test Engineer I', 'AEROSPACE / VEHICLE', S, 90),
        (11, 'Rocket Co', 'Test Engineer I', 'AEROSPACE / VEHICLE', S, 89),         # same posting twice
        (12, 'Bot Co', 'Senior Robotics Engineer', 'ROBOTICS / MECHATRONICS', S, 88), # seniority
        (13, 'Bot Co', 'Robotics Engineer', 'ROBOTICS / MECHATRONICS', S, 80),
        (14, 'Chip Co', 'Hardware Engineer', 'HARDWARE / SYSTEMS', E, 95),          # only with include_eligible
        (15, 'Google', 'Mechanical Engineer', 'PRODUCT / MECHANICAL DESIGN', S, 99),
    ])
    assert [p['job_id'] for p in runner.up_next()] == [10, 13]
    assert all(p['url'].startswith('https://example.com/') for p in runner.up_next())  # the panel links each title to the posting
    runner.configure_autoplay(include_eligible=True)
    assert [p['job_id'] for p in runner.up_next()] == [14, 10, 13]
    runner.configure_autoplay(disciplines=['ROBOTICS / MECHATRONICS'])
    assert [p['job_id'] for p in runner.up_next()] == [13]
    runner.skip(13)
    assert runner.up_next() == []
    with pytest.raises(ValueError, match='Unknown discipline'): runner.configure_autoplay(disciplines=['Poetry'])

def test_workers_take_queue_first_then_autoplay(runner):
    add_jobs(runner, [(10, 'Rocket Co', 'Test Engineer I', 'AEROSPACE / VEHICLE', EligibilityStatus.STRONG_MATCH, 90),
                      (13, 'Bot Co', 'Robotics Engineer', 'ROBOTICS / MECHATRONICS', EligibilityStatus.STRONG_MATCH, 80)])
    launched = []
    runner.popen = lambda args, **kw: launched.append(args[-1]) or FakeProcess()
    runner.queue([3])
    runner.data.update(running=True, parallelism=2)
    runner.tick()
    jobs = {j['job_id']: j for j in runner.data['jobs']}
    assert set(jobs) == {3, 10} and jobs[10]['source'] == 'autoplay'
    runner.data['autoplay']['enabled'] = False
    runner.processes.clear()
    runner.tick()
    assert 13 not in {j['job_id'] for j in runner.data['jobs']}

def test_cap_failure_keeps_autoplay_off_that_employer(runner):
    add_jobs(runner, [(10, 'Rocket Co', 'Test Engineer I', 'AEROSPACE / VEHICLE', EligibilityStatus.STRONG_MATCH, 90),
                      (11, 'Rocket Co', 'Build Engineer', 'AEROSPACE / VEHICLE', EligibilityStatus.STRONG_MATCH, 85)])
    runner._note_cap({'company': 'Rocket Co', 'message': 'Employer application cap reached until 2999-01-01'})
    assert runner.up_next() == []

def park(runner, job_id, status, **extra):
    item = next(j for j in runner.data['jobs'] if j['job_id'] == job_id)
    item.update(status=status, **extra)
    return item

def test_flagged_questions_free_the_slot_and_approval_resumes_first(runner):
    launched = []
    runner.popen = lambda args, **kw: launched.append(args) or FakeProcess()
    runner.data['autoplay']['enabled'] = False
    runner.queue([1, 3])
    runner.data.update(running=True, parallelism=1)
    runner.tick()
    first = runner.data['jobs'][0]
    assert first['job_id'] == 1 and len(launched) == 1
    request = json.loads((runner.directory / first['id'] / 'request.json').read_text())
    assert request['parkQuestions'] is True and request['submit'] is False
    # The worker parks with a question and exits: its slot goes to the next role.
    runner.processes.clear()
    park(runner, 1, 'needs_approval', questions=[{'label': 'Why us?', 'required': True, 'type': 'textarea'},
                                                 {'label': 'Relocate?', 'options': ['Yes', 'No']}])
    runner.tick()
    assert [a[-1] for a in launched][-1].endswith(next(j['id'] for j in runner.data['jobs'] if j['job_id'] == 3))
    assert [a['job_id'] for a in runner.approvals()] == [1]
    assert runner.snapshot()['counts']['approvals'] == 1
    with pytest.raises(ValueError, match='required'): runner.approve_answers(1, {'Relocate?': 'Yes'})
    with pytest.raises(ValueError, match='listed options'): runner.approve_answers(1, {'Why us?': 'Rockets', 'Relocate?': 'Maybe'})
    with pytest.raises(ValueError, match='match the questions'): runner.approve_answers(1, {'Other': 'x'})
    runner.approve_answers(1, {'Why us?': 'Rockets', 'Relocate?': 'Yes'})
    assert queued(runner) == [1] and runner.approvals() == []
    runner.processes.clear()
    runner.tick()
    resumed = next(j for j in runner.data['jobs'] if j['job_id'] == 1)
    request = json.loads((runner.directory / resumed['id'] / 'request.json').read_text())
    assert [(a['question'], a['answer']) for a in request['approvedAnswers']] == [('Why us?', 'Rockets'), ('Relocate?', 'Yes')]
    assert request['approvedAnswers'][0]['type'] == 'textarea'
    assert all(a.get('approvedAt') for a in request['approvedAnswers'])

def test_parallelism_one_means_one_browser(runner):
    runner.popen = lambda args, **kw: FakeProcess()
    runner.data['autoplay']['enabled'] = False
    runner.queue([1, 3])
    runner.data.update(running=True, parallelism=1)
    runner.tick()
    atomic(runner.directory / runner.data['jobs'][0]['id'] / 'state.json', {'status': 'waiting_review'})
    runner.tick()
    assert len(runner.processes) == 1
    assert [w['job_id'] for w in runner.snapshot()['workers']] == [1]

def test_workday_routes_to_its_runner_and_submits_only_after_approval(runner):
    launched = []
    runner.popen = lambda args, **kw: launched.append(args) or FakeProcess()
    with runner.sessions() as session:
        session.get(Job, 1).application_url = 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/X_R1'
        session.commit()
    runner.data['autoplay']['enabled'] = False
    runner.queue([1])
    runner.data.update(running=True, parallelism=1)
    runner.tick()
    assert launched[-1][1].endswith('src/dashboard-workday.mjs')
    runner.processes.clear()
    park(runner, 1, 'ready_to_submit')
    runner.approve_submit(1)
    runner.tick()
    item = next(j for j in runner.data['jobs'] if j['job_id'] == 1)
    assert json.loads((runner.directory / item['id'] / 'request.json').read_text())['submit'] is True
    assert item['engine'] == 'claude'
    assert item['adapter'] == 'workday'

def test_verification_link_and_dismiss(runner):
    runner.queue([1, 3])
    park(runner, 1, 'needs_verification')
    with pytest.raises(ValueError, match='myworkdayjobs'): runner.verify(1, 'https://evil.example/verify')
    runner.verify(1, 'https://acme.wd5.myworkdayjobs.com/verify?token=abc')
    assert next(j for j in runner.data['jobs'] if j['job_id'] == 1)['verify_link'].startswith('https://acme')
    park(runner, 3, 'blocked', message='sign-in failed')
    runner.dismiss(3)
    assert 3 in runner.data['skipped'] and all(j['job_id'] != 3 for j in runner.data['jobs'])
    with pytest.raises(ValueError, match='no longer waiting'): runner.approve_submit(1)

def test_stopping_workers_clears_finished_previews(runner):
    runner.queue([1, 3])
    park(runner, 1, 'failed')
    park(runner, 3, 'needs_approval', questions=[])
    runner.data['running'] = True
    snap = runner.snapshot()
    assert snap['workers'] == [] and {r['job_id'] for r in snap['recent']} == {1, 3}
    assert all('url' in r for r in snap['recent'])  # Recent links each posting like the other lists
    runner.control('stop')
    assert runner.snapshot()['recent'] == []
    assert [a['job_id'] for a in runner.approvals()] == [3]

def test_stop_finishes_current_posting_without_dispatching_next(runner):
    runner.queue([1, 3])
    active, queued = runner.data['jobs']
    active.update(status='running', slot=0)
    process = FakeProcess()
    runner.processes[active['id']] = process
    runner.data['running'] = True
    snap = runner.control('stop')
    assert not snap['running'] and snap['stopping_after_current']
    assert active['id'] in runner.processes
    assert not (runner.directory / active['id'] / 'commands.json').exists()
    assert not runner.stop_times
    runner.tick()
    assert active['status'] == 'running' and queued['status'] == 'queued'
    active['status'] = 'completed'
    process.poll = lambda: 0
    runner.tick()
    assert active['id'] not in runner.processes
    assert not runner.snapshot()['stopping_after_current']
    assert queued['status'] == 'queued'

def test_per_role_stop_still_cancels_immediately(runner):
    runner.queue([1])
    active = runner.data['jobs'][0]
    active['status'] = 'running'
    runner.processes[active['id']] = FakeProcess()
    runner.command(1, 'stop')
    assert json.loads((runner.directory / active['id'] / 'commands.json').read_text())['action'] == 'stop'
    assert active['id'] in runner.stop_times

def test_workday_waits_for_password_then_parked_roles_requeue(runner):
    with runner.sessions() as session:
        for i in (10, 11):
            session.add(Job(id=i, fit_review={'fit': True, 'hash': None}, company_name=f'Co{i}', title='Engineer', description='d', source_ats='workday', location='United States',
                            canonical_url=f'https://co{i}.wd1.myworkdayjobs.com/x/{i}', application_url=f'https://co{i}.wd1.myworkdayjobs.com/x/{i}',
                            role_type='FULL_TIME', eligibility=EligibilityStatus.STRONG_MATCH, best_career_cluster='HARDWARE / SYSTEMS', priority_score=90))
        session.commit()
    env = runner.agent_dir / 'private/workday.env'
    env.write_text('# comment\nWORKDAY_PASSWORD=\n')
    assert not runner.workday_password_set()
    assert all(p['job_id'] not in (10, 11) for p in runner.up_next())
    runner.queue([10])
    park(runner, 10, 'blocked', message='Workday sign-in: not signed in; add WORKDAY_PASSWORD to private/workday.env')
    runner.popen = lambda args, **kw: FakeProcess()
    runner.data.update(running=True, parallelism=1)
    runner.data['autoplay']['enabled'] = False
    runner.tick()
    assert next(j for j in runner.data['jobs'] if j['job_id'] == 10)['status'] == 'blocked'
    env.write_text('WORKDAY_PASSWORD=fixture\n')
    assert runner.workday_password_set() and 11 in [p['job_id'] for p in runner.up_next()]
    runner.tick()
    assert next(j for j in runner.data['jobs'] if j['job_id'] == 10)['status'] == 'starting'

def test_final_approval_is_bound_to_the_reviewed_form(runner):
    runner.queue([1])
    park(runner, 1, 'ready_to_submit', review={'id': 'r1', 'digest': 'abc', 'answers': []})
    with pytest.raises(ValueError, match='review changed'): runner.approve_submit(1, 'old')
    runner.approve_submit(1, 'r1')
    item = next(j for j in runner.data['jobs'] if j['job_id'] == 1)
    assert item['approved_digest'] == 'abc' and item['status'] == 'queued'

def test_autoplay_skips_employers_parked_at_sign_in(runner):
    add_jobs(runner, [(10, 'Bigco', 'Engineer I', 'HARDWARE / SYSTEMS', EligibilityStatus.STRONG_MATCH, 90),
                      (11, 'Bigco', 'Engineer, Robotics', 'HARDWARE / SYSTEMS', EligibilityStatus.STRONG_MATCH, 85),
                      (12, 'Smallco', 'Engineer', 'HARDWARE / SYSTEMS', EligibilityStatus.STRONG_MATCH, 80)])
    runner.queue([10])
    park(runner, 10, 'needs_human', message='Workday sign-in: saved password was rejected')
    assert [p['job_id'] for p in runner.up_next()] == [12]
    runner.dismiss(10)  # dismissing the parked role lets autoplay try that employer again
    assert 11 in [p['job_id'] for p in runner.up_next()]

def test_live_stream_sends_each_running_workers_new_frames(runner, monkeypatch):
    import asyncio
    from starlette.requests import Request
    runner.queue([1])
    item = runner.data['jobs'][0]
    runner.processes[item['id']] = FakeProcess()
    frame = runner.directory / item['id'] / 'screenshot.jpg'
    frame.parent.mkdir(parents=True)
    frame.write_bytes(b'\xff\xd8first')
    monkeypatch.setattr(application_routes, 'get_runner', lambda: runner)
    calls = {'n': 0}
    async def disconnected():
        calls['n'] += 1
        return calls['n'] > 3
    request = Request({'type': 'http', 'method': 'GET', 'path': '/', 'headers': [], 'query_string': b''})
    request.is_disconnected = disconnected
    async def collect():
        response = await application_routes.live_previews(request)
        chunks = []
        async for chunk in response.body_iterator:
            chunks.append(chunk)
            if len(chunks) == 2:
                frame.write_bytes(b'\xff\xd8second')
        return ''.join(chunks)
    body = asyncio.run(collect())
    events = [json.loads(line[6:]) for line in body.splitlines() if line.startswith('data: ')]
    import base64
    assert [base64.b64decode(e['jpeg']) for e in events] == [b'\xff\xd8first', b'\xff\xd8second']
    assert all(e['id'] == item['id'] for e in events)

class DoneProcess:
    pid = 99999998
    returncode = 0
    def poll(self): return 0

def test_technical_failure_retries_once_then_needs_help(runner):
    runner.popen = lambda args, **kw: FakeProcess()
    runner.data['autoplay']['enabled'] = False
    runner.queue([1])
    runner.data.update(running=True, parallelism=1)
    runner.tick()
    item = runner.data['jobs'][0]
    atomic(runner.directory / item['id'] / 'state.json', {'status': 'blocked', 'message': 'Workday stopped: locator.fill: Timeout 20000ms exceeded.'})
    runner.processes[item['id']] = DoneProcess()
    runner.data['running'] = False
    runner.tick()
    retry = next(j for j in runner.data['jobs'] if j['job_id'] == 1)
    assert retry['status'] == 'queued' and retry['retries'] == 1 and runner.help_items() == []
    runner.data['running'] = True
    runner.tick()
    atomic(runner.directory / retry['id'] / 'state.json', {'status': 'blocked', 'message': 'Workday stopped: locator.fill: Timeout 20000ms exceeded.'})
    runner.processes[retry['id']] = DoneProcess()
    runner.data['running'] = False
    runner.tick()
    assert [h['job_id'] for h in runner.help_items()] == [1]
    assert runner.approvals() == [] and runner.snapshot()['counts']['help'] == 1

def test_a_real_block_goes_straight_to_help(runner):
    runner.queue([1])
    item = park(runner, 1, 'needs_human', message='This site asks for a CAPTCHA')
    runner._retry_if_technical(item)
    assert [h['job_id'] for h in runner.help_items()] == [1]

class FakeChatProcess:
    def __init__(self, lines, code=0):
        import io
        self.stdin, self.stdout, self.stderr = io.StringIO(), iter(lines), io.StringIO('')
        self.returncode, self.pid = code, 99999997
    def wait(self): return self.returncode

def wait_idle(desk, job_id):
    import time
    for _ in range(100):
        if not desk.chat(job_id)['busy']:
            return desk.chat(job_id)
        time.sleep(0.02)
    raise AssertionError('chat stayed busy')

def test_each_problem_gets_its_own_resumable_agent(runner, monkeypatch):
    from jobagent.services.assist import AssistDesk
    runner.queue([1, 3])
    park(runner, 1, 'blocked', message='Workday stopped: locator.check failed')
    calls = []
    replies = [[json.dumps({'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'name': 'Bash', 'input': {'command': 'cat state.json'}}, {'type': 'text', 'text': 'The radio click did not register.'}]}})],
               [json.dumps({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'Queued it again.'}]}})]]
    def popen(args, **kw):
        calls.append((args, kw))
        return FakeChatProcess(replies[len(calls) - 1])
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'fixture-secret')
    desk = AssistDesk(runner, cli_resolver=lambda engine: f'/fixture/{engine}', popen=popen)
    desk.send(1, 'Why did this stop?')
    log = wait_idle(desk, 1)
    assert [m['role'] for m in log['messages']] == ['user', 'activity', 'activity', 'agent']
    assert log['messages'][-1]['text'] == 'The radio click did not register.'
    first_args, first_kw = calls[0]
    assert '--session-id' in first_args and 'ANTHROPIC_API_KEY' not in first_kw['env']
    assert first_kw['cwd'] == runner.agent_dir
    assert first_args[first_args.index('--tools') + 1] == 'default'
    assert first_args[first_args.index('--permission-mode') + 1] == 'bypassPermissions'
    assert '--allowedTools' not in first_args
    assert '/opt/homebrew/bin' in first_kw['env']['PATH'] and '/.local/bin' in first_kw['env']['PATH']
    desk.send(1, 'Fix it')
    wait_idle(desk, 1)
    assert calls[1][0][calls[1][0].index('--resume') + 1] == log['session']
    assert desk.chat(3)['messages'] == []  # another posting has its own, empty conversation

def test_briefing_names_the_run_and_how_to_requeue(runner):
    from jobagent.services.assist import AssistDesk
    runner.queue([1])
    item = park(runner, 1, 'blocked', message='Timeout 20000ms exceeded')
    text = AssistDesk(runner, cli_resolver=lambda e: '/x').briefing(item)
    assert 'Timeout 20000ms exceeded' in text and str(runner.directory / item['id']) in text
    assert '/api/applications/jobs/1/retry-parked' in text and 'Never submit' in text

def test_briefing_signs_the_shared_log_as_the_engine_that_runs(runner):
    from jobagent.services.assist import AssistDesk
    runner.queue([1])
    item = park(runner, 1, 'blocked', message='Timeout 20000ms exceeded')
    desk = AssistDesk(runner, cli_resolver=lambda e: '/x')
    claude, codex = desk.briefing(item, 'claude'), desk.briefing(item, 'codex')
    assert 'Claude: CLAIM' in claude and 'Claude: DONE' in claude and 'Codex: CLAIM' not in claude
    assert 'Codex: CLAIM' in codex and 'Codex: DONE' in codex and 'Claude: CLAIM' not in codex
    assert '{agent}' not in claude + codex

def test_internal_repair_is_bounded_and_preserves_submission_boundaries(runner, monkeypatch):
    import jobagent.services.application_runner as module
    original_setting = module.setting
    monkeypatch.setattr(module, 'setting', lambda key, *args: 1 if key == 'workers.max_repair_agents' else original_setting(key, *args))
    class Desk:
        processes = {}
        calls = []
        def send(self, job_id, text, internal=False, engine=None, **_):
            self.calls.append((job_id, text, internal))
    desk = runner._repair_desk = Desk()
    runner.queue([1, 3])
    first = park(runner, 1, 'failed', message='Cannot identify Work Experience Add control', retries=1)
    item = park(runner, 3, 'needs_human', message='The page did not retain the supplied answer')
    runner._repair_technical_failures()
    assert desk.calls == [(1, 'Cannot identify Work Experience Add control', True)]
    first['status'] = 'completed'  # keep job 1's Fable escalation out of the boundary checks below
    # A configured one-agent pool serializes; attempted submissions are never sent for repair.
    desk.processes = {1: object()}
    runner._repair_technical_failures()
    assert len(desk.calls) == 1
    desk.processes = {}
    item['submission_attempted'] = True
    runner._repair_technical_failures()
    assert len(desk.calls) == 1
    item['submission_attempted'] = False
    from jobagent.services.application_runner import atomic
    state_path = runner.agent_dir / 'state' / 'jobagent-3.json'
    atomic(state_path, {'status': 'submitted_pending_receipt'})
    runner._repair_technical_failures()
    assert len(desk.calls) == 1  # durable evidence wins over a stale dashboard item
    atomic(state_path, {'status': 'failed'})
    item['message'] = 'Dropdown needs reCAPTCHA verification'
    runner._repair_technical_failures()
    assert len(desk.calls) == 1
    item['message'] = 'The page did not retain the supplied answer'
    runner._repair_technical_failures()
    assert desk.calls[-1][0] == 3
    runner._repair_technical_failures()
    assert len(desk.calls) == 3 and desk.calls[-1][0] == 3  # Opus 5.5 after Sonnet 5.5
    runner._repair_technical_failures()
    assert len(desk.calls) == 4 and desk.calls[-1][0] == 3  # then one Fable 5.1 escalation
    runner._repair_technical_failures()
    assert len(desk.calls) == 4  # then the durable attempt ledger gives up

def test_distinct_repair_failures_have_a_per_posting_budget():
    from jobagent.services.application_runner import repair_allowed
    # Sonnet 5.5, Opus 5.5, then Fable 5.1, once each (even for the same failure), then give up.
    assert repair_allowed(None, 'missing Add control')
    entry = {'attempts': [{'failure': 'missing Add control'}]}
    assert repair_allowed(entry, 'missing Add control')
    entry['attempts'].append({'failure': 'missing Add control'})
    assert repair_allowed(entry, 'missing Add control')
    entry['attempts'].append({'failure': 'missing Add control'})
    assert not repair_allowed(entry, 'missing Add control')
    assert not repair_allowed(entry, 'another new technical error')

def test_internal_repair_prompt_requires_reproduction_and_verified_retry(runner, monkeypatch):
    from jobagent.services.assist import AssistDesk
    runner.data['engine'] = 'codex'
    runner.queue([1])
    park(runner, 1, 'failed', message='School dropdown did not resolve')
    calls = []
    def popen(args, **kw):
        process = FakeChatProcess([])
        process.arguments = args
        calls.append(process)
        return process
    desk = AssistDesk(runner, cli_resolver=lambda e: '/fixture/codex', popen=popen)
    monkeypatch.setattr(desk, '_repair_deadline', lambda *args: None)
    # Retain the stdin contents for inspection after the pump closes it.
    import io
    class Input(io.StringIO):
        def close(self): pass
    original = desk.popen
    def launch(*a, **kw):
        process = original(*a, **kw)
        process.stdin = Input()
        return process
    desk.popen = launch
    desk.send(1, 'Repair the failed control', internal=True)
    log = wait_idle(desk, 1)
    prompt = calls[0].stdin.getvalue()
    assert 'local browser fixture' in prompt and 'Run the relevant tests before requeuing' in prompt
    assert 'Do not directly submit' in prompt and 'invent personal facts' in prompt
    assert log['messages'][0]['role'] == 'activity'
    assert 'sandbox_mode="danger-full-access"' in calls[0].arguments
    assert 'approval_policy="never"' in calls[0].arguments

def test_codex_chat_records_its_thread_for_resuming(runner):
    from jobagent.services.assist import AssistDesk
    runner.queue([1])
    park(runner, 1, 'blocked', message='x')
    runner.data['engine'] = 'codex'
    calls = []
    def popen(args, **kw):
        calls.append(args)
        return FakeChatProcess([json.dumps({'type': 'thread.started', 'thread_id': 'thread-123'}),
                                json.dumps({'type': 'item.completed', 'item': {'type': 'command_execution', 'command': 'ls'}}),
                                json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'Looked at it.'}})])
    desk = AssistDesk(runner, cli_resolver=lambda e: f'/fixture/{e}', popen=popen)
    desk.send(1, 'Look')
    assert wait_idle(desk, 1)['session'] == 'thread-123'
    desk.send(1, 'Again')
    wait_idle(desk, 1)
    assert calls[1][:3] == ['/fixture/codex', 'exec', 'resume'] and 'thread-123' in calls[1]
    assert 'sandbox_mode="danger-full-access"' in calls[0]
    assert 'sandbox_mode="danger-full-access"' in calls[1]
    assert all('web_search="live"' in args and 'approval_policy="never"' in args for args in calls)
    assert not any('--ignore-user-config' in args or '--disable' in args for args in calls)

def test_control_failure_does_not_block_employer_autoplay(runner):
    add_jobs(runner, [(10, 'Bigco', 'Engineer I', 'HARDWARE / SYSTEMS', EligibilityStatus.STRONG_MATCH, 90),
                      (11, 'Bigco', 'Engineer, Robotics', 'HARDWARE / SYSTEMS', EligibilityStatus.STRONG_MATCH, 85)])
    runner.queue([10])
    park(runner, 10, 'failed', message='The page changed or a control could not be identified', retries=1)
    assert [p['job_id'] for p in runner.up_next()] == [11]

def test_each_worker_slot_runs_its_own_agent(runner):
    launched = []
    runner.popen = lambda args, **kw: launched.append(args[-1]) or FakeProcess()
    runner.data['autoplay']['enabled'] = False
    runner.control('configure', parallelism=2, engine='claude')
    runner.set_slot_engine(1, 'codex')
    with pytest.raises(ValueError, match='no such worker'): runner.set_slot_engine(2, 'codex')
    assert [s['engine'] for s in runner.snapshot()['slots']] == ['claude', 'codex']
    runner.queue([1, 3])
    runner.data['running'] = True
    runner.tick()
    requests = {json.loads((runner.directory / j['id'] / 'request.json').read_text())['job']['id']: (j['slot'], json.loads((runner.directory / j['id'] / 'request.json').read_text())['engine']) for j in runner.data['jobs']}
    assert requests == {1: (0, 'claude'), 3: (1, 'codex')}
    assert [s['worker'] is not None for s in runner.snapshot()['slots']] == [True, True]
    # Switching a busy slot changes the next role there, not the running one.
    runner.set_slot_engine(0, 'codex')
    assert next(j for j in runner.data['jobs'] if j['job_id'] == 1)['engine'] == 'claude'
    # Growing the pool adds slots on the default agent; the panel-wide choice resets them all.
    runner.control('configure', parallelism=3)
    assert runner.data['slots'] == ['codex', 'codex', 'claude']
    runner.control('configure', engine='claude')
    assert runner.data['slots'] == ['claude', 'claude', 'claude']
    assert runner.engines_in_use() == ['claude']

def test_one_pick_reaches_past_a_long_run_of_excluded_roles(runner):
    rows = [(100 + i, f'Seniorco{i}', 'Senior Engineer', 'HARDWARE / SYSTEMS', EligibilityStatus.STRONG_MATCH, 99 - i * 0.1) for i in range(60)]
    rows.append((200, 'Freshco', 'Engineer I', 'HARDWARE / SYSTEMS', EligibilityStatus.STRONG_MATCH, 50))
    add_jobs(runner, rows)
    assert [p['job_id'] for p in runner.up_next(1)] == [200]
    assert runner.up_next(1) == runner.up_next(12)[:1]


def test_auto_stop_approval_limit_blocks_dispatch_and_start(runner):
    runner.queue([1,3])
    runner.data['jobs'][0]['status']='needs_approval'
    runner.configure_auto_stop(1,0)
    runner.data['running']=True
    runner.tick()
    assert not runner.data['running']
    assert '1 need approval' in runner.snapshot()['auto_stop_reason']
    assert runner.data['jobs'][1]['status']=='queued'
    with pytest.raises(ValueError,match='Clear the backlog'):
        runner.control('start')


def test_auto_stop_help_limit_and_disabled_defaults(runner):
    runner.queue([1,3])
    runner.data['jobs'][0]['status']='blocked'
    assert runner.snapshot()['auto_stop_blocked'] is None
    runner.data['running']=True
    runner.configure_auto_stop(0,1)
    assert not runner.data['running']
    assert '1 need help' in runner.snapshot()['auto_stop_reason']
    runner.configure_auto_stop(0,0)
    assert runner.snapshot()['auto_stop_blocked'] is None
    assert not runner.data['running']  # Raising limits never silently resumes.


def test_auto_stop_stops_active_worker_and_preserves_queue(runner):
    runner.queue([1,3])
    parked,active=runner.data['jobs']
    parked['status']='ready_to_submit';active['status']='running'
    runner.processes[active['id']]=FakeProcess()
    runner.data['running']=True
    runner.configure_auto_stop(1,0)
    assert active['id'] in runner.processes
    assert json.loads((runner.directory/active['id']/'commands.json').read_text())['action']=='stop'
    assert active['id'] in runner.stop_times
    assert not runner.data['running']


def test_backlog_reservation_prevents_a_second_launch_failure(runner):
    runner.queue([1,3])
    runner.configure_auto_stop(0,2)
    runner.data.update(running=True,parallelism=3)
    def fail(*args):raise RuntimeError('launch failed')
    runner._launch=fail
    runner.tick()
    assert runner.data['jobs'][0]['status']=='failed'
    assert runner.data['jobs'][1]['status']=='queued'
    assert runner.data['running']  # No hard-limit stop was necessary.
    assert runner.data['adaptive']['effective'] == 0


def test_auto_stop_persisted_and_api_validation(runner,monkeypatch):
    runner.configure_auto_stop(7,3)
    recovered=ApplicationRunner(runner.directory,runner.agent_dir,runner.sessions)
    assert recovered.snapshot()['auto_stop']=={'approvals':7,'help':3}
    monkeypatch.setattr(application_routes,'get_runner',lambda:runner)
    app=FastAPI();app.include_router(application_routes.router)
    client=TestClient(app);headers={'X-JobAgent-Application':'1'}
    for bad in [-1,1.5,True,10001]:
        assert client.post('/api/applications/auto-stop',json={'approvals':bad,'help':2},headers=headers).status_code==422
    assert client.post('/api/applications/auto-stop',json={'approvals':5,'help':2}).status_code==403
    response=client.post('/api/applications/auto-stop',json={'approvals':5,'help':2},headers=headers)
    assert response.status_code==200
    assert response.json()['auto_stop']=={'approvals':5,'help':2}


def test_session_limit_pauses_dispatch_and_survives_auth_check(runner):
    runner.queue([1,3]);limited,queued=runner.data['jobs']
    limited.update(engine='claude',status='running')
    class Exited:
        def poll(self):return 1
    runner.processes[limited['id']]=Exited()
    atomic(runner.directory/limited['id']/'state.json',{'status':'failed','message':"Claude CLI failed: You've hit your session limit · resets 10:10pm"})
    runner.data['running']=True
    runner.tick()
    assert runner.data['running'] is False
    assert queued['status']=='queued'
    assert runner.check_engine('claude')['status']=='usage_limited'
    assert runner.engine_status()['status']=='usage_limited'
    assert not limited.get('auto_retries')


def test_workday_step_limit_not_mistaken_for_model_limit(runner):
    runner.data['running']=True
    assert not runner._record_model_limit({'engine':'workday','message':'step limit reached'})
    assert not runner._record_model_limit({'engine':'claude','message':'Preparation reached its step limit'})
    assert runner.data['running']


def test_switching_engines_and_explicit_retry(runner,monkeypatch):
    runner._record_model_limit({'engine':'claude','message':'Claude usage limit reached'})
    runner.control('configure',engine='codex')
    assert runner.engine_status().get('status')!='usage_limited'
    runner.control('configure',engine='claude')
    assert runner.engine_status()['status']=='usage_limited'
    monkeypatch.setattr(runner,'check_engine',lambda *a:{'status':'ready'})
    assert runner.retry_engine_limits()['engine_status'].get('status')!='usage_limited'
    assert not runner.data['running']


def test_clear_lists_scoped_archived_and_never_resumes_workers(runner):
    runner.queue([1,2,3])
    approval,help_item,new_item=runner.data['jobs']
    approval['status']='needs_approval';help_item['status']='submission_unknown';new_item['status']='ready_to_submit'
    result=runner.clear_attention('approvals',[approval['id'],help_item['id']])
    assert result=={'cleared':1,'active_remaining':0,'blocked_remaining':0,'blocked':[]}
    assert help_item in runner.data['jobs'] and new_item in runner.data['jobs']
    assert runner.data['dismissed_items'][0]['status']=='needs_approval'
    assert approval['job_id'] not in runner.data['skipped']
    assert runner.data['jobs'][-1]['job_id']==approval['job_id']
    assert runner.data['jobs'][-1]['status']=='queued'
    assert runner.data['jobs'][-1]['id']!=approval['id']
    assert not runner.data['running']
    assert runner.clear_attention('help',[help_item['id']])['blocked_remaining']==1
    assert help_item in runner.data['jobs']
    with runner.sessions() as session:
        assert session.get(Job,1).status==JobStatus.NEW
    recovered=ApplicationRunner(runner.directory,runner.agent_dir,runner.sessions)
    assert len(recovered.data['dismissed_items'])==1


def test_clear_preserves_active_review_and_new_arrivals(runner):
    runner.queue([1,3]);active,new=runner.data['jobs']
    active['status']='waiting_review';new['status']='needs_approval'
    runner.processes[active['id']]=FakeProcess()
    assert runner.clear_attention('approvals',[active['id']])=={'cleared':0,'active_remaining':1,'blocked_remaining':0,'blocked':[]}
    assert len(runner.approvals())==2
    assert not (runner.directory/active['id']/'commands.json').exists()


def test_clear_endpoint_requires_local_mutation_header(runner,monkeypatch):
    monkeypatch.setattr(application_routes,'get_runner',lambda:runner)
    app=FastAPI();app.include_router(application_routes.router);client=TestClient(app)
    runner.queue([1]);item=runner.data['jobs'][0];item['status']='needs_approval'
    body={'ids':[item['id']]}
    assert client.post('/api/applications/approvals/clear',json=body).status_code==403
    response=client.post('/api/applications/approvals/clear',json=body,headers={'X-JobAgent-Application':'1'})
    assert response.status_code==200 and response.json()['cleared']==1


def test_clear_preserves_answers_but_not_submission_permission(runner):
    runner.queue([1]);item=runner.data['jobs'][0]
    item.update(status='ready_to_submit',submit=True,approved_digest='old',approved_answers=[{'question':'CAD','answer':'Some'}])
    runner.clear_attention('approvals',[item['id']])
    fresh=runner.data['jobs'][0]
    assert fresh['approved_answers']==item['approved_answers']
    assert not fresh.get('submit') and not fresh.get('approved_digest')


def test_restore_old_clears_once_preserves_order(runner):
    runner.queue([1,3]);old,queued=runner.data['jobs']
    old.update(status='failed',dismissed_from='help')
    runner.data['dismissed_items']=[old];runner.data['jobs']=[queued];runner.data['skipped']=[1]
    assert runner.restore_cleared()['restored']==1
    assert [j['job_id'] for j in runner.data['jobs']]==[3,1]
    assert runner.restore_cleared()['restored']==0
    assert 1 not in runner.data['skipped']


def test_flagged_requires_individual_clear_and_keeps_submission_guard(runner):
    runner.queue([1,3]);flagged,normal=runner.data['jobs']
    flagged.update(status='submission_unknown',submission_attempted=True)
    normal['status']='failed'
    result=runner.clear_attention('help',[flagged['id'],normal['id']])
    assert result['cleared']==1 and result['blocked_remaining']==1
    assert any(j['id']==flagged['id'] for j in runner.help_items())
    runner.dismiss(1)
    assert not runner.help_items()
    saved=runner.data['dismissed_items'][-1]
    assert saved['individual_clear'] and saved['submission_attempted']
    assert saved['status']=='submission_unknown'
    assert runner.restore_cleared()['restored']==0
    with pytest.raises(ValueError,match='submission evidence'):
        runner.queue([1])


def test_help_clear_list_removes_postings_without_requeueing(runner):
    runner.queue([1,3]);failed,queued=runner.data['jobs']
    failed['status']='failed'
    result=runner.clear_attention('help',[failed['id'],queued['id']])
    assert result=={'cleared':1,'active_remaining':0,'blocked_remaining':0,'blocked':[]}
    assert runner.data['jobs']==[queued] and not runner.help_items()
    saved=runner.data['dismissed_items'][-1]
    assert saved['id']==failed['id'] and saved['individual_clear'] and saved['dismissed_from']=='help'
    assert 1 in runner.data['skipped']
    assert runner.restore_cleared()['restored']==0
    assert [j['job_id'] for j in runner.data['jobs']]==[3]


def test_explicit_recovery_restores_answers_and_is_idempotent(runner):
    runner.queue([1, 3])
    item = runner.data['jobs'][0]
    item.update(status='needs_approval', approved_answers=[{'question': 'CAD', 'answer': 'Yes'}], submit=True)
    runner.dismiss(1)
    result = runner.restore_dismissed()
    assert result == {'queued': [1], 'attention': [], 'already_present': []}
    restored = runner.data['jobs'][-1]
    assert restored['status'] == 'queued' and restored['approved_answers'] == item['approved_answers']
    assert not restored.get('submit') and 1 not in runner.data['skipped']
    assert runner.restore_dismissed() == {'queued': [], 'attention': [], 'already_present': []}


def test_explicit_recovery_preserves_submission_attempt_and_run(runner):
    runner.queue([1])
    item = runner.data['jobs'][0]
    item.update(status='needs_human', submission_attempted=True, message='Waiting for verification')
    runner.dismiss(1)
    assert runner.restore_dismissed()['attention'] == [1]
    restored = runner.data['jobs'][0]
    assert restored['id'] == item['id'] and restored['submission_attempted']
    assert restored['status'] == 'needs_human' and restored['recovery_hold']
    assert 'Waiting for verification' in restored['message']
    with pytest.raises(ValueError, match='submission evidence'):
        runner._job(1)


def test_explicit_recovery_reads_durable_submission_evidence(runner):
    runner.queue([1]); runner.data['jobs'][0]['status'] = 'failed'; runner.dismiss(1)
    atomic(runner.agent_dir / 'state/jobagent-1.json', {'status': 'needs_human_verification', 'submission_attempted': True})
    assert runner.restore_dismissed()['attention'] == [1]
    assert runner.data['jobs'][0]['submission_attempted']


def test_explicit_recovery_keeps_missing_and_applied_roles_visible(runner):
    runner.queue([1, 3])
    for item in runner.data['jobs']:
        item['status'] = 'failed'
    runner.dismiss(1); runner.dismiss(3)
    with runner.sessions() as session:
        session.get(Job, 1).status = JobStatus.APPLIED
        session.delete(session.get(Job, 3)); session.commit()
    assert runner.restore_dismissed()['attention'] == [1, 3]
    runner._reconcile_stale_attention()
    assert all(j['status'] == 'needs_human' for j in runner.data['jobs'])
    assert len(runner.help_items()) == 2
    with runner.sessions() as session:
        assert session.get(Job, 1).status == JobStatus.APPLIED


def test_explicit_recovery_preserves_live_attempt_and_endpoint_protection(runner, monkeypatch):
    runner.queue([1]); runner.data['jobs'][0]['status'] = 'failed'; runner.dismiss(1)
    runner.queue([1]); current = runner.data['jobs'][0]; current['status'] = 'running'
    monkeypatch.setattr(application_routes, 'get_runner', lambda: runner)
    app = FastAPI(); app.include_router(application_routes.router); client = TestClient(app)
    assert client.post('/api/applications/restore-dismissed').status_code == 403
    response = client.post('/api/applications/restore-dismissed', headers={'X-JobAgent-Application': '1'})
    assert response.json()['already_present'] == [1]
    assert runner.data['jobs'] == [current] and current['status'] == 'running'


def test_approved_edits_are_persisted_before_the_worker_resumes(runner, monkeypatch):
    runner.queue([1]); item = runner.data['jobs'][0]
    item.update(status='needs_approval', questions=[{'label': 'Describe a technical challenge', 'required': True, 'type': 'textarea'}])
    calls = []
    def memory(payload):
        assert item in runner.data['jobs'] and item['status'] == 'needs_approval'
        calls.append(payload)
        return {'sharedQuestions': []}
    monkeypatch.setattr(runner, '_answer_memory', memory)
    runner.approve_answers(1, {'Describe a technical challenge': 'My edited answer'})
    learn = [c for c in calls if c['action'] == 'learn']  # a 'suggest' call first reads the draft he was shown
    assert len(learn) == 1 and learn[0]['approvals'][0]['answer'] == 'My edited answer'
    assert learn[0]['approvals'][0]['type'] == 'textarea'
    assert learn[0]['approvals'][0]['approvedAt']
    assert runner.data['jobs'][0]['approved_answers'][0]['answer'] == 'My edited answer'


def test_memory_failure_leaves_approval_waiting(runner, monkeypatch):
    runner.queue([1]); item = runner.data['jobs'][0]
    item.update(status='needs_approval', questions=[{'label': 'Why?', 'required': True, 'type': 'textarea'}])
    def unavailable(payload):
        raise ValueError('Memory unavailable')
    monkeypatch.setattr(runner, '_answer_memory', unavailable)
    with pytest.raises(ValueError, match='Memory unavailable'):
        runner.approve_answers(1, {'Why?': 'Edited text'})
    assert runner.data['jobs'] == [item] and item['status'] == 'needs_approval'
    assert not item.get('approved_answers')


def test_dropdown_placeholder_cannot_be_approved_or_resolved_as_a_fact(runner):
    runner.queue([1]); item = runner.data['jobs'][0]
    item.update(status='needs_approval', questions=[{'label': 'Country', 'required': True, 'options': ['Select One', 'United States']}])
    with pytest.raises(ValueError, match='placeholder'):
        runner.approve_answers(1, {'Country': 'Select One'})
    with pytest.raises(ValueError, match='placeholder'):
        runner.resolve_facts(1, {'Country': 'Select One'})
    assert item['status'] == 'needs_approval' and not item.get('approved_answers')


def test_approved_connection_answer_is_never_shared_with_another_employer(runner):
    runner.queue([1, 3])
    for item in runner.data['jobs']:
        item.update(status='needs_approval', questions=[{'label': 'Do you know anyone here?', 'required': True, 'options': ['Yes', 'No']}])
    runner.approve_answers(1, {'Do you know anyone here?': 'No'})
    other = next(j for j in runner.data['jobs'] if j['job_id'] == 3)
    assert other['status'] == 'needs_approval' and not other.get('approved_answers')


def test_approval_drafts_are_review_only_and_manual_edits_take_priority(runner, monkeypatch):
    runner.queue([1]); item = runner.data['jobs'][0]
    item.update(status='needs_approval', questions=[{'label': 'Describe a technical challenge', 'type': 'textarea', 'required': True}])
    monkeypatch.setattr(runner, '_answer_memory', lambda payload: [{'job_id': 1, 'facts': {}, 'drafts': {'Describe a technical challenge': {'draft': 'Remembered example', 'note': 'Review this draft'}}}])
    assert runner.approvals()[0]['questions'][0]['draft'] == 'Remembered example'
    runner.save_answer_drafts(1, {'Describe a technical challenge': 'My draft edit'})
    assert runner.approvals()[0]['questions'][0]['draft'] == 'My draft edit'
    assert not item.get('approved_answers') and item['status'] == 'needs_approval'


def test_help_reconciliation_preserves_uncertainty_and_resolves_current_search_conflicts(runner):
    runner.queue([1, 3])
    runner.data['jobs'][0].update(status='needs_human', submission_attempted=True)
    runner.data['jobs'][1].update(status='needs_human')
    with runner.sessions() as session:
        session.get(Job, 3).eligibility = EligibilityStatus.INELIGIBLE
        session.commit()
    # A rules change alone never removes an unsubmitted role (his rule, 2026-10-18).
    assert runner.reconcile_help()['skipped'] == []
    with runner.sessions() as session:
        session.get(Job, 3).status = JobStatus.CLOSED
        session.commit()
    result = runner.reconcile_help()
    assert result['skipped'] == [3] and result['remaining'] == [1]
    assert runner.data['jobs'][0]['submission_attempted']
    assert runner.data['jobs'][0]['status'] == 'needs_human'


def test_pending_receipt_is_not_skipped_when_search_changes(runner):
    runner.queue([1]); item = runner.data['jobs'][0]
    item.update(status='submitted_pending_receipt', submission_attempted=True)
    with runner.sessions() as session:
        session.get(Job, 1).eligibility = EligibilityStatus.INELIGIBLE
        session.commit()
    result = runner.reconcile_help()
    assert result['remaining'] == [1] and not result['skipped']
    assert item['status'] == 'submitted_pending_receipt' and item['submission_attempted']


def test_reviewed_rejection_recovers_pending_attempt_with_archive(runner, monkeypatch):
    from types import SimpleNamespace
    import jobagent.services.application_runner as module
    runner.queue([1]); item = runner.data['jobs'][0]
    item.update(status='submitted_pending_receipt', submission_attempted=True)
    path = runner.agent_dir / 'state/jobagent-1.json'
    atomic(path, {'status': 'submitted_pending_receipt', 'canonicalUrl': 'https://example.com/1'})
    script = runner.agent_dir / 'tools/reconcile-help.mjs'
    script.parent.mkdir(); script.touch()
    monkeypatch.setattr(module.subprocess, 'run', lambda *args, **kwargs: SimpleNamespace(
        returncode=0, stdout=json.dumps([{'job_id': 1, 'verificationNotAccepted': True,
                                       'verificationEvidence': {'observedFailure': 'validation_error'}}])))
    result = runner.reconcile_help()
    assert result['requeued'] == [1]
    assert runner.data['jobs'][0]['status'] == 'queued'
    assert not runner.data['jobs'][0].get('submission_attempted')
    assert json.loads(path.read_text())['status'] == 'verification_not_accepted'
    assert len(list((runner.agent_dir / 'state/archive').glob('jobagent-1-*.json'))) == 1


def _rejection_evidence(monkeypatch, evidence):
    from types import SimpleNamespace
    import jobagent.services.application_runner as module
    monkeypatch.setattr(module.subprocess, 'run', lambda *args, **kwargs: SimpleNamespace(
        returncode=0, stdout=json.dumps([{'job_id': 1, 'verificationNotAccepted': True, 'verificationEvidence': evidence}])))


def test_spam_flagged_rejection_is_never_retried_automatically(runner, monkeypatch):
    runner.queue([1]); item = runner.data['jobs'][0]
    item.update(status='needs_human', phase='submission_rejected', message='Not submitted: flagged as possible spam')
    path = runner.agent_dir / 'state/jobagent-1.json'
    atomic(path, {'status': 'verification_not_accepted', 'canonicalUrl': 'https://example.com/1',
                  'rejection': {'source': 'webpage', 'outcome': 'flagged_spam', 'messages': ['flagged as possible spam']}})
    script = runner.agent_dir / 'tools/reconcile-help.mjs'
    script.parent.mkdir(); script.touch()
    _rejection_evidence(monkeypatch, {'observedFailure': 'spam_rejection'})
    for _ in range(3):  # the dashboard polls reconcile every few seconds
        result = runner.reconcile_help()
        assert result['requeued'] == [] and result['remaining'] == [1]
    assert item['status'] == 'needs_human' and item['auto_retry_declined']
    assert not item.get('submission_attempted')
    assert len(list((runner.agent_dir / 'state/archive').glob('jobagent-1-*.json'))) == 1


def test_explicit_rejection_gets_one_automatic_retry(runner, monkeypatch):
    runner.queue([1]); item = runner.data['jobs'][0]
    item.update(status='needs_human', phase='submission_rejected')
    path = runner.agent_dir / 'state/jobagent-1.json'
    durable = {'status': 'verification_not_accepted', 'canonicalUrl': 'https://example.com/1',
               'rejection': {'source': 'webpage', 'outcome': 'invalid_fields', 'messages': ['Please select a country']}}
    atomic(path, durable)
    script = runner.agent_dir / 'tools/reconcile-help.mjs'
    script.parent.mkdir(); script.touch()
    _rejection_evidence(monkeypatch, {'observedFailure': 'validation_error'})
    assert runner.reconcile_help()['requeued'] == [1]
    assert runner.data['jobs'][0]['status'] == 'queued'
    # The retried worker is rejected the same way: that stays on Needs help instead of looping.
    runner.data['jobs'][0].update(status='needs_human', phase='submission_rejected')
    atomic(path, durable)
    result = runner.reconcile_help()
    assert result['requeued'] == [] and result['remaining'] == [1]
    assert runner.data['jobs'][0]['status'] == 'needs_human' and runner.data['jobs'][0]['auto_retry_declined']
    assert len(list((runner.agent_dir / 'state/archive').glob('jobagent-1-*.json'))) == 2


def test_help_links_only_exact_postings_not_shared_career_pages(runner):
    runner.queue([1]); item = runner.data['jobs'][0]
    url = 'https://boards.greenhouse.io/example/jobs/123456'
    item.update(status='needs_human', url=url)
    with runner.sessions() as session:
        session.get(Job, 3).canonical_url = 'https://job-boards.greenhouse.io/example/jobs/123456'
        session.delete(session.get(Job, 1)); session.commit()
    result = runner.reconcile_help()
    assert result['linked'] == [{'job_id': 1, 'current_job_id': 3}]
    assert next(j for j in runner.data['jobs'] if j['job_id'] == 3)['status'] == 'queued'
    assert item['status'] == 'skipped' and item['resolved_to_job_id'] == 3
    assert runner._posting_key('https://example.com/careers') is None

def test_plan_limit_lifts_at_its_reset_time_and_workers_come_back(runner):
    from datetime import datetime, timezone as tz
    at = datetime(2026, 9, 26, 14, 0, tzinfo=tz.utc)
    assert runner.limit_resets_at("You've hit your usage limit · resets 5pm", at).startswith('2026-09-26T17:01')
    assert runner.limit_resets_at('limit reached, resets 11:30 am', at).startswith('2026-09-27T11:31')
    assert runner.limit_resets_at('usage limit reached', at).startswith('2026-09-26T15:00')
    runner.data['running'] = True
    runner.queue([1])
    item = park(runner, 1, 'failed', message='Claude usage limit reached. resets 5pm', engine='claude')
    assert runner._record_model_limit(item)
    assert runner.data['running'] is False and runner.data['resume_after_limit']
    runner._expire_model_limits()
    assert runner.data['running'] is False  # still limited
    statuses = json.loads((runner.directory / 'engine-status.json').read_text())
    statuses['claude']['until'] = '2000-01-01T00:00:00+00:00'
    atomic(runner.directory / 'engine-status.json', statuses)
    runner.thread = type('T', (), {'is_alive': lambda self: True})()
    runner._expire_model_limits()
    assert runner.data['running'] is True and not runner.data['resume_after_limit']
    assert 'claude' not in json.loads((runner.directory / 'engine-status.json').read_text())

def test_a_limit_does_not_restart_workers_he_stopped(runner):
    runner.data['running'] = False
    runner.queue([1])
    item = park(runner, 1, 'failed', message='usage limit reached', engine='claude')
    runner._record_model_limit(item)
    statuses = json.loads((runner.directory / 'engine-status.json').read_text())
    statuses['claude']['until'] = '2000-01-01T00:00:00+00:00'
    atomic(runner.directory / 'engine-status.json', statuses)
    runner._expire_model_limits()
    assert runner.data['running'] is False

def test_an_answer_resumes_other_applications_parked_on_the_same_question(runner):
    runner.queue([1, 2, 3])
    park(runner, 1, 'needs_approval', questions=[{'label': 'How Did You Hear About Us?', 'required': True},
                                                 {'label': 'Have you previously been employed by Acme?', 'required': True, 'options': ['Yes', 'No']}])
    park(runner, 2, 'needs_approval', questions=[{'label': 'How did you hear about this opportunity?', 'required': True}])
    park(runner, 3, 'needs_approval', questions=[{'label': 'Have you previously been employed by Other?', 'required': True}])
    result = runner.approve_answers(1, {'How Did You Hear About Us?': 'Career Site', 'Have you previously been employed by Acme?': 'No'})
    assert result['also_resumed'] == [2]
    assert queued(runner)[0] == 1  # the one he answered runs first
    second = next(j for j in runner.data['jobs'] if j['job_id'] == 2)
    assert second['status'] == 'queued' and second['approved_answers'] == [{'question': 'How did you hear about this opportunity?', 'answer': 'Career Site'}]
    assert next(j for j in runner.data['jobs'] if j['job_id'] == 3)['status'] == 'needs_approval'  # employer-specific, not shared

def test_question_keys_match_wordings_but_not_employers():
    from jobagent.services.application_runner import question_key, names_company
    assert question_key('How Did You Hear About Us?*') == question_key('How did you learn about this opportunity?') == 'intent:how-heard'
    assert question_key('Address Line 1') == 'intent:address-line-1'
    assert names_company('Have you worked for Leidos?', 'Leidos') and not names_company('Have you worked here?', 'Leidos')

def test_recheck_sends_every_parked_question_back_through(runner):
    runner.queue([1, 2])
    park(runner, 1, 'needs_approval', questions=[{'label': 'Postal Code'}])
    park(runner, 2, 'ready_to_submit')
    assert runner.recheck_approvals() == {'resumed': 1}
    assert queued(runner) == [1]

def test_factual_resolution_preserves_prose_review_and_resumes_only_complete_cards(runner):
    runner.queue([1, 2])
    park(runner, 1, 'needs_approval', questions=[{'label':'Citizen?', 'options':['Yes','No']}, {'label':'Why us?', 'type':'textarea'}])
    park(runner, 2, 'needs_approval', questions=[{'label':'Citizen?', 'options':['Yes','No']}])
    with pytest.raises(ValueError, match='Only factual'):
        runner.resolve_facts(1, {'Why us?':'Unapproved prose'})
    with pytest.raises(ValueError, match='listed options'):
        runner.resolve_facts(1, {'Citizen?':'Maybe'})
    assert runner.resolve_facts(1, {'Citizen?':'Yes'}) == {'ok':True,'resolved':1,'resumed':False}
    assert runner.approvals()[0]['questions'] == [{'label':'Why us?', 'type':'textarea'}]
    assert runner.resolve_facts(2, {'Citizen?':'Yes'})['resumed'] is True
    assert queued(runner) == [2]
    assert runner.recheck_approvals([99]) == {'resumed':0}


def test_current_address_textarea_resolves_as_a_fact(runner):
    runner.queue([1])
    park(runner, 1, 'needs_approval', questions=[{'label':'Please provide your current address', 'type':'textarea'}, {'label':'Why us?', 'type':'textarea'}])
    assert runner.resolve_facts(1, {'Please provide your current address':'1 Main St, Town, CA 90000'})['resolved'] == 1
    with pytest.raises(ValueError, match='Only factual'):
        runner.resolve_facts(1, {'Why us?':'Prose'})


def test_verification_retries_without_a_link(runner):
    runner.queue([1])
    park(runner, 1, 'needs_verification')
    runner.retry_parked(1)
    item = next(j for j in runner.data['jobs'] if j['job_id'] == 1)
    assert item['status'] == 'queued' and not item.get('verify_link')

def test_rate_limited_role_goes_to_the_back_and_its_employer_cools_down(runner):
    add_jobs(runner, [(10, 'Acme', 'Test Engineer I', 'AEROSPACE / VEHICLE', EligibilityStatus.STRONG_MATCH, 90)])
    launched = []
    runner.popen = lambda args, **kw: launched.append(args[-1]) or FakeProcess()
    runner.data['autoplay']['enabled'] = False
    runner.queue([1, 3])
    runner.data.update(running=True, parallelism=1)
    runner.tick()
    item = runner.data['jobs'][0]
    atomic(runner.directory / item['id'] / 'state.json', {'status': 'blocked', 'message': "Rate-limited: the employer's site showed a Workday error page (VPS|x) after a refresh."})
    runner.processes[item['id']] = DoneProcess()
    runner.tick()
    assert queued(runner) == [1] and runner.help_items() == []  # 3 took the slot; 1 waits at the back
    retry = next(j for j in runner.data['jobs'] if j['job_id'] == 1)
    assert retry['cooldowns'] == 1 and retry['not_before'] > item['updated_at']
    assert 'acme' in runner.data['cooling']
    # While Acme cools down neither the role nor autoplay goes back to it.
    runner.processes.clear()
    runner.data['autoplay']['enabled'] = True
    runner.tick()
    assert retry['status'] == 'queued' and all(p['company'] != 'Acme' for p in runner.up_next())
    # Once the wait is over it runs again.
    runner.data['cooling']['acme'] = retry['not_before'] = '2000-01-01T00:00:00+00:00'
    runner.processes.clear()
    runner.data['autoplay']['enabled'] = False
    runner.tick()
    assert retry['status'] == 'starting'

def test_rate_limited_again_after_every_cooldown_needs_help(runner):
    runner.queue([1])
    item = park(runner, 1, 'blocked', message='Rate-limited: Workday error page', cooldowns=3)
    assert runner._cool_down_if_throttled(item) is False
    assert [h['job_id'] for h in runner.help_items()] == [1]


def test_autoplay_takes_only_postings_a_model_read_and_judged_a_fit(runner):
    S = EligibilityStatus.STRONG_MATCH
    add_jobs(runner, [(20, 'A', 'Mechanical Engineer I', 'PRODUCT / MECHANICAL DESIGN', S, 90),
                      (21, 'B', 'Mechanical Engineer I', 'PRODUCT / MECHANICAL DESIGN', S, 80),
                      (22, 'C', 'Mechanical Engineer I', 'PRODUCT / MECHANICAL DESIGN', S, 70)])
    requested = []
    runner.fit_reviewer.request = lambda ids, track=None: requested.extend(ids)
    with runner.sessions() as session:
        session.get(Job, 20).fit_review = None                                   # not read yet
        session.get(Job, 21).fit_review = {'fit': False, 'hash': None, 'reason': 'sales role'}
        session.get(Job, 22).description_hash = 'new'                             # read an older version
        session.commit()
    assert [p['job_id'] for p in runner.up_next() if p['job_id'] >= 20] == []
    assert requested[:2] == [20, 22]


def test_his_label_overrides_rules_and_reviewer(runner):
    S, I = EligibilityStatus.STRONG_MATCH, EligibilityStatus.INELIGIBLE
    add_jobs(runner, [(30, 'D', 'Mechanical Engineer I', 'PRODUCT / MECHANICAL DESIGN', S, 90),
                      (31, 'E', 'Power Systems Engineer', 'OTHER', I, 80)])
    with runner.sessions() as session:
        session.get(Job, 30).user_fit_label = {'fit': False, 'note': 'too far from home', 'labeled_at': '2026-01-01T00:00:00+00:00'}
        session.get(Job, 31).user_fit_label = {'fit': True, 'note': 'ME degree listed', 'labeled_at': '2026-01-01T00:00:00+00:00'}
        session.get(Job, 31).fit_review = None
        session.commit()
    picks = [p['job_id'] for p in runner.up_next() if p['job_id'] >= 30]
    assert picks == [31]
    runner.queue([31])  # his fit label also lets him queue a posting the rules rejected

@pytest.mark.parametrize('message', ['Site unavailable: access denied (HTTP 403)', 'Site unavailable: application page stayed blank after a reload'])
def test_site_outage_is_cooled_before_asking_for_help(runner, message):
    runner.queue([1])
    item = park(runner, 1, 'blocked', message=message)
    assert runner._cool_down_if_throttled(item) is True
    assert runner.help_items() == []
    assert runner.data['jobs'][0]['cooldowns'] == 1


def test_confirmed_missing_posting_closes_only_unapplied_jobs(runner):
    runner.queue([1])
    item = runner.data['jobs'][0]
    atomic(runner.directory / item['id'] / 'state.json', {'status':'skipped', 'posting_unavailable':True})
    runner._refresh(item)
    with runner.sessions() as session:
        assert session.get(Job, 1).status == JobStatus.CLOSED
    assert runner.help_items() == []

def test_existing_stale_help_retires_but_uncertain_submission_is_preserved(runner):
    runner.queue([1,3])
    first=park(runner,1,'blocked',message='Workday stopped: Posting unavailable: employer reports that this job page no longer exists')
    second=park(runner,3,'submission_unknown',message='Job 3 must be an eligible, unapplied full-time role',submission_attempted=True)
    runner.tick()
    assert first['status']=='skipped'
    assert [i['job_id'] for i in runner.help_items()]==[3]
    with runner.sessions() as session:
        assert session.get(Job,1).status==JobStatus.CLOSED
        assert session.get(Job,3).status==JobStatus.NEW


def test_malformed_resume_history_retry_selects_manual_preparation(runner):
    runner.queue([1])
    item=park(runner,1,'blocked',message='Workday stopped: Resume parser produced 3 unmatched or duplicate work-history entries.')
    runner._retry_if_technical(item)
    fresh=runner.data['jobs'][0]
    assert fresh['retries']==1
    runner.popen=lambda *args, **kwargs:FakeProcess()
    runner._launch(fresh)
    request=json.loads((runner.directory/fresh['id']/'request.json').read_text())
    assert request['prepareManually'] is True

def test_existing_malformed_history_uses_manual_mode_on_explicit_retry(runner):
    runner.queue([1])
    park(runner,1,'blocked',message='Workday stopped: Resume parser produced 2 duplicate work-history entries.')
    runner.retry_parked(1)
    assert runner.data['jobs'][0]['prepare_manually'] is True

@pytest.mark.parametrize('message', [
    'Workday stopped: Work-history draft is incomplete: 4 confirmed profile entries are missing.',
    'Workday stopped: Saved work-history verification failed: row 5: end date differs',
    'Workday stopped: Work-history date segment startDate-dateSectionYear-input could not be focused',
    'Workday stopped: Workday Back did not reach the previous step after two attempts',
])
def test_history_recovery_failure_retries_once_without_requesting_answers(runner, message):
    runner.queue([1])
    item = park(runner, 1, 'blocked', message=message)
    runner._retry_if_technical(item)
    fresh = runner.data['jobs'][0]
    assert fresh['status'] == 'queued' and fresh['retries'] == 1
    assert runner.help_items() == [] and runner.approvals() == []
    fresh.update(status='blocked', message=message)
    runner._retry_if_technical(fresh)
    assert [h['job_id'] for h in runner.help_items()] == [1]


def test_submission_policy_toggle_is_persisted_and_used_by_new_workers(runner, monkeypatch, tmp_path):
    from jobagent import settings
    monkeypatch.setattr(settings, 'settings_path', lambda: tmp_path / 'policy-settings.json')
    settings._cache['stamp'] = None
    runner.configure_submission(False)
    assert runner.snapshot()['require_submission_approval'] is False
    assert settings.overrides()['workers.auto_submit'] is True
    runner.queue([1])
    requests = []
    runner.popen = lambda *args, **kwargs: FakeProcess()
    runner._launch(runner.data['jobs'][0])
    request_path = runner.directory / runner.data['jobs'][0]['id'] / 'request.json'
    assert json.loads(request_path.read_text())['autoSubmit'] is True
    runner.configure_submission(True)
    assert runner.snapshot()['require_submission_approval'] is True
    runner._launch(runner.data['jobs'][0])
    assert json.loads(request_path.read_text())['autoSubmit'] is False
    with pytest.raises(ValueError):
        runner.configure_submission('false')


def test_submission_policy_api_rejects_non_boolean_and_cross_origin(runner, monkeypatch):
    monkeypatch.setattr(application_routes, 'get_runner', lambda: runner)
    choices = []
    monkeypatch.setattr(runner, 'configure_submission', lambda choice: choices.append(choice) or {'require_submission_approval': choice})
    app = FastAPI()
    app.include_router(application_routes.router)
    client = TestClient(app)
    assert client.post('/api/applications/submission-policy', json={'require_approval': False}).status_code == 403
    headers = {'X-JobAgent-Application': '1'}
    assert client.post('/api/applications/submission-policy', json={'require_approval': 'false'}, headers=headers).status_code == 422
    assert client.post('/api/applications/submission-policy', json={'require_approval': False}, headers={**headers, 'Origin': 'https://evil.example'}).status_code == 403
    assert client.post('/api/applications/submission-policy', json={'require_approval': False}, headers=headers).json()['require_submission_approval'] is False
    assert choices == [False]


def test_clear_archives_missing_posting_without_requeueing_it(runner):
    runner.queue([1])
    item = runner.data['jobs'][0]
    item['status'] = 'needs_approval'
    with runner.sessions() as session:
        session.delete(session.get(Job, 1))
        session.commit()
    result = runner.clear_attention('approvals', [item['id']])
    assert result['cleared'] == 1 and result['blocked_remaining'] == 0
    assert runner.data['jobs'] == []
    assert runner.data['dismissed_items'][0]['clear_reason'] == 'Job 1 was not found'
    assert runner.restore_cleared()['restored'] == 0


def test_delayed_receipt_promotes_terminal_application_without_resubmitting(runner):
    runner.queue([1])
    item = runner.data['jobs'][0]
    item.update(status='submitted_pending_receipt', submission_attempted=True)
    atomic(runner.directory / item['id'] / 'state.json', {'status': 'completed', 'submitted': True,
           'receipt': {'messageId': 'abcdef1234567890'}, 'receiptSource': 'mailbox'})
    runner.popen = lambda *args, **kwargs: pytest.fail('Receipt evidence must never relaunch a submission')
    runner._check_receipts()
    assert item['status'] == 'completed' and item['recorded'] is True
    assert item['receiptSource'] == 'mailbox'
    with runner.sessions() as session:
        assert session.get(Job, 1).status == JobStatus.APPLIED


def test_receipt_checks_use_one_separate_process_and_cooldown(runner):
    runner.queue([1, 3])
    script = runner.agent_dir / 'tools/verify-application-receipt.mjs'
    script.parent.mkdir()
    script.touch()
    calls = []
    runner.popen = lambda *args, **kwargs: calls.append(args[0]) or FakeProcess()
    runner.data['running'] = True
    for item in runner.data['jobs']:
        item['status'] = 'submitted_pending_receipt'
        atomic(runner.directory / item['id'] / 'request.json', {})
    runner._check_receipts()
    assert len(calls) == 1 and not runner.processes
    assert calls[0][1] == str(script)
    runner._check_receipts()
    assert len(calls) == 1
    runner.receipt_processes.clear()
    runner._check_receipts()
    assert len(calls) == 2  # The second application can check while the first cools down.
    runner.receipt_processes.clear()
    runner._check_receipts()
    assert len(calls) == 2


def test_receipt_checks_prioritize_unchecked_then_oldest(runner):
    runner.queue([1, 2, 3])
    script = runner.agent_dir / 'tools/verify-application-receipt.mjs'
    script.parent.mkdir()
    script.touch()
    runner.data['running'] = True
    calls = []
    runner.popen = lambda *args, **kwargs: calls.append(args[0]) or FakeProcess()
    first, second, third = runner.data['jobs']
    for item in runner.data['jobs']:
        item['status'] = 'submitted_pending_receipt'
        atomic(runner.directory / item['id'] / 'request.json', {})
    first['receipt_checked_at'] = '2026-01-02T00:00:00+00:00'
    second['receipt_checked_at'] = '2026-01-01T00:00:00+00:00'
    runner._check_receipts()
    assert calls[-1][-1] == str(runner.directory / third['id'])
    runner.receipt_processes.clear()
    runner._check_receipts()
    assert calls[-1][-1] == str(runner.directory / second['id'])


def test_completed_tracking_repairs_after_restart_and_preserves_interview(runner):
    runner.queue([1, 3])
    first, second = runner.data['jobs']
    for item in runner.data['jobs']:
        item.update(status='completed', submitted=True, receiptSource='webpage',
                    webpageEvidence={'text': 'Your application has been submitted'})
    with runner.sessions() as session:
        session.get(Job, 3).status = JobStatus.INTERVIEW
        session.commit()
    runner._refresh(first)
    runner._refresh(second)
    assert first['recorded'] and second['recorded']
    with runner.sessions() as session:
        assert session.get(Job, 1).status == JobStatus.APPLIED
        assert session.get(Job, 3).status == JobStatus.INTERVIEW


def test_form_failure_does_not_block_other_employer_postings(runner):
    add_jobs(runner, [(10, 'Bigco', 'Engineer I', 'HARDWARE / SYSTEMS', EligibilityStatus.STRONG_MATCH, 90),
                      (11, 'Bigco', 'Engineer, Robotics', 'HARDWARE / SYSTEMS', EligibilityStatus.STRONG_MATCH, 85)])
    runner.queue([10])
    park(runner, 10, 'blocked', message='Saved work-history verification failed after repair')
    assert 11 in [p['job_id'] for p in runner.up_next()]


def test_snapshot_distinguishes_ready_queue_from_retry_delay(runner):
    runner.queue([1, 3])
    runner.data['jobs'][0]['not_before'] = '2099-01-01T00:00:00+00:00'
    counts = runner.snapshot()['counts']
    assert counts['queued'] == 2 and counts['ready'] == 1 and counts['delayed'] == 1


def test_explicit_other_roles_remain_allowed_after_answer_and_restart(runner):
    with runner.sessions() as session:
        job=session.get(Job,1);job.role_type='OTHER';job.eligibility=EligibilityStatus.LIKELY_ELIGIBLE
        session.commit()
    with pytest.raises(ValueError,match='full-time'): runner.queue([1])
    runner.queue([1],allow_other_roles=True)
    park(runner,1,'needs_approval',questions=[{'label':'Shift','required':True}])
    runner.approve_answers(1,{'Shift':'Day only'})
    assert runner._job(1)['role_type']=='OTHER'
    restored=ApplicationRunner(runner.directory,runner.agent_dir,runner.sessions)
    assert restored._job(1)['role_type']=='OTHER'
    assert 1 not in [p['job_id'] for p in restored.up_next()]


def test_explicit_other_queue_still_rejects_ineligible_and_applied_without_mutation(runner):
    with runner.sessions() as session:
        session.get(Job,1).role_type='OTHER';session.get(Job,1).eligibility=EligibilityStatus.LIKELY_ELIGIBLE
        session.get(Job,3).eligibility=EligibilityStatus.INELIGIBLE
        session.commit()
    with pytest.raises(ValueError): runner.queue([1,3],allow_other_roles=True)
    assert not runner.data.get('explicit_other_jobs') and not runner.snapshot()['queue']
    with runner.sessions() as session:
        session.get(Job,1).status=JobStatus.APPLIED;session.commit()
    with pytest.raises(ValueError): runner.queue([1],allow_other_roles=True)


def test_manual_challenge_receipt_can_complete_without_resubmitting(runner):
    runner.queue([1])
    item=runner.data['jobs'][0]
    item.update(status='needs_human',submission_attempted=True)
    atomic(runner.directory/item['id']/'state.json',{'status':'completed','submitted':True,'receipt':{'messageId':'abcdef1234567890'},'receiptSource':'mailbox'})
    runner.popen=lambda *args,**kwargs: pytest.fail('Never relaunch an application to reconcile its receipt')
    runner._check_receipts()
    assert item['status']=='completed' and item['recorded']
    with runner.sessions() as session: assert session.get(Job,1).status==JobStatus.APPLIED


def test_help_agent_path_uses_login_tools_outside_runtime_venv():
    from pathlib import Path
    from jobagent.services.assist import login_agent_path
    import jobagent.services.assist as assist
    runtime = str(Path(assist.__file__).resolve().parents[3] / '.venv/bin')
    result = login_agent_path(runtime + ':/usr/bin:/bin')
    assert runtime not in result.split(':')
    assert '/opt/homebrew/bin' in result and '/.local/bin' in result


def test_failed_first_claude_chat_gets_a_fresh_session(runner):
    from jobagent.services.assist import AssistDesk
    runner.queue([1])
    park(runner, 1, 'blocked', message='Fixture')
    calls = []
    def popen(args, **kw):
        calls.append(args)
        if len(calls) == 1:
            return FakeChatProcess([json.dumps({'type':'result','is_error':True,'result':'Sign in required'})], code=1)
        return FakeChatProcess([json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':'Ready'}]}})])
    desk = AssistDesk(runner, cli_resolver=lambda e:'/fixture/claude', popen=popen)
    desk.send(1, 'Look', engine='claude')
    assert wait_idle(desk, 1)['session'] is None
    desk.send(1, 'Try again')
    assert wait_idle(desk, 1)['session'] is not None
    assert '--resume' not in calls[1] and '--session-id' in calls[1]


def test_internships_queue_and_resume_with_existing_submission_guards(runner, monkeypatch):
    _internships_on(monkeypatch)  # these cover the internship path, used while workers.apply_internships is on
    with runner.sessions() as session:
        job = session.get(Job, 1)
        job.role_type = 'INTERNSHIP'
        job.title = 'Mechanical Engineering Intern'
        session.commit()
    assert runner.queue([1])['added'] == 1
    assert runner._job(1)['role_type'] == 'INTERNSHIP'
    park(runner, 1, 'needs_approval', questions=[{'label': 'Start date', 'required': True}])
    runner.approve_answers(1, {'Start date': 'June 2027'})
    assert runner.data['jobs'][0]['status'] == 'queued'
    atomic(runner.agent_dir / 'state/jobagent-1.json', {'status': 'submitted_pending_receipt'})
    with pytest.raises(ValueError, match='unresolved submission'):
        runner._job(1)


def test_internship_autoplay_requires_current_fit_and_keeps_role_guards(runner, monkeypatch):
    _internships_on(monkeypatch)  # these cover the internship path, used while workers.apply_internships is on
    S, I = EligibilityStatus.STRONG_MATCH, EligibilityStatus.INELIGIBLE
    add_jobs(runner, [(20, 'Intern Co', 'Mechanical Engineering Intern', 'PRODUCT / MECHANICAL DESIGN', S, 99),
                      (21, 'Overseas Co', 'Mechanical Engineering Intern', 'PRODUCT / MECHANICAL DESIGN', S, 98),
                      (22, 'Contract Co', 'Mechanical Engineering Contract', 'PRODUCT / MECHANICAL DESIGN', S, 97),
                      (23, 'Wrong Co', 'Mechanical Engineering Intern', 'PRODUCT / MECHANICAL DESIGN', I, 96),
                      (24, 'Unread Co', 'Mechanical Engineering Intern', 'PRODUCT / MECHANICAL DESIGN', S, 95)])
    with runner.sessions() as session:
        for job_id in (20, 21, 23, 24):
            session.get(Job, job_id).role_type = 'INTERNSHIP'
        session.get(Job, 21).location = 'Toronto, Canada'
        session.get(Job, 22).role_type = 'OTHER'
        session.get(Job, 24).fit_review = None
        session.commit()
    requested = []
    runner.fit_reviewer.request = lambda ids, track=None: requested.extend(ids)
    assert [p['job_id'] for p in runner.up_next() if p['job_id'] >= 20] == [20]
    assert 24 in requested
    with pytest.raises(ValueError, match='U.S.-only'):
        runner.queue([21])
    with pytest.raises(ValueError, match='eligible'):
        runner.queue([23])
    runner.queue([20])
    assert all(p['job_id'] != 20 for p in runner.up_next())


def test_help_reconciliation_does_not_retire_eligible_internships(runner, monkeypatch):
    _internships_on(monkeypatch)  # these cover the internship path, used while workers.apply_internships is on
    with runner.sessions() as session:
        session.get(Job, 1).role_type = 'INTERNSHIP'
        session.commit()
    runner.queue([1])
    park(runner, 1, 'needs_human', message='Employer form needs repair')
    result = runner.reconcile_help()
    assert result['remaining'] == [1] and result['skipped'] == []


def test_confirmation_records_attempt_date_and_pipeline_edits_preserve_it(runner):
    from jobagent.db.models import Application
    from jobagent.db.repository import JobRepository
    runner.queue([1]); item = runner.data['jobs'][0]
    item.update(status='completed', submitted=True, receiptSource='webpage',
                receipt={'submittedAt': '2026-01-02T03:04:05Z'})
    runner._refresh(item)
    with runner.sessions() as session:
        app = session.query(Application).filter_by(job_id=1).one()
        assert app.applied_date.isoformat().startswith('2026-01-02T03:04:05')
        JobRepository(session).record_application(1, status=JobStatus.INTERVIEW)
        session.commit()
        assert app.applied_date.isoformat().startswith('2026-01-02T03:04:05')


def test_future_submission_date_rejected_before_job_status_changes(runner):
    from datetime import datetime, timezone, timedelta
    from jobagent.db.repository import JobRepository
    with runner.sessions() as session:
        before = session.get(Job, 1).status
        with pytest.raises(ValueError, match='future'):
            JobRepository(session).record_application(1, applied_date=datetime.now(timezone.utc) + timedelta(days=1))
        assert session.get(Job, 1).status == before


def test_large_worker_pool_ramps_to_twenty_and_retains_independent_slots(runner, monkeypatch):
    import jobagent.services.application_runner as module
    clock = [1000.0]
    monkeypatch.setattr(module.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(runner, '_resource_capacity', lambda configured: configured)
    add_jobs(runner, [(100 + i, f'Company {i}', 'Mechanical Engineer', 'HARDWARE / SYSTEMS',
                       EligibilityStatus.STRONG_MATCH, 90) for i in range(24)])
    runner.data.update(running=True, parallelism=20, engine='codex', slots=['codex'] * 20)
    runner._fit_slots()
    runner.data['autoplay']['enabled'] = False
    runner.queue(list(range(100,124)))
    launched = []
    runner.popen = lambda *args, **kwargs: launched.append(args) or FakeProcess()
    runner.tick()
    assert len(runner.processes) == 2
    clock[0] += 10
    runner.tick()
    assert len(runner.processes) == 4
    clock[0] += 80
    runner.tick()
    assert len(runner.processes) == 20
    assert len({j['slot'] for j in runner.data['jobs'] if j['id'] in runner.processes}) == 20
    assert all(j['engine'] == 'codex' for j in runner.data['jobs'] if j['id'] in runner.processes)
    assert runner.snapshot()['adaptive']['effective'] == 20
    runner.tick()
    assert len(launched) == 20


def test_dispatch_reserves_every_active_workers_possible_attention_outcome(runner, monkeypatch):
    import jobagent.services.application_runner as module
    monkeypatch.setattr(module.time, 'monotonic', lambda: 1000)
    monkeypatch.setattr(runner, '_resource_capacity', lambda configured: configured)
    runner.data.update(running=True, parallelism=20)
    runner._adaptive_started = 0
    runner._fit_slots()
    runner.data['auto_stop'] = {'approvals': 50, 'help': 50}
    runner.data['jobs'] = [{'id': f'parked-{i}', 'job_id': 200+i, 'status': 'needs_approval'} for i in range(47)]
    assert runner._update_dispatch_capacity() == 0
    assert runner.data['adaptive']['recovery_limit'] == 2
    runner.processes.update(a=FakeProcess(), b=FakeProcess())
    assert runner._free_slot(recovery=True) is None
    runner.data['jobs'][0]['status'] = 'completed'
    assert runner._update_dispatch_capacity() == 0
    assert runner.data['adaptive']['recovery_limit'] == 3
    assert runner._free_slot(recovery=True) is not None
    runner.data['auto_stop']['help'] = 2
    runner.data['jobs'].append({'id': 'help', 'status': 'blocked'})
    assert runner._update_dispatch_capacity() == 0
    assert runner._free_slot() is None
    assert len(runner.processes) == 2 and not runner.stop_times


def test_resource_capacity_counts_running_workers_plus_spare_memory(runner, monkeypatch):
    import jobagent.services.application_runner as module
    monkeypatch.setattr(module.time, 'monotonic', lambda: 1000)
    monkeypatch.setattr(module.os, 'getloadavg', lambda: (0,0,0))
    monkeypatch.setattr(module.os, 'cpu_count', lambda: 8)
    monkeypatch.setattr(runner, '_available_memory_bytes', lambda: 3 * 1024**3)
    runner.processes.update({str(i): FakeProcess() for i in range(12)})
    assert runner._resource_capacity(20) == 14  # 2 GiB reserve, 512 MiB per additional browser.
    runner.processes['extra'] = FakeProcess()
    assert runner._resource_capacity(20) == 14  # Cached spare memory is not spent twice.
    runner.processes.pop('extra')
    runner._resource_sample = (1000, 1024**3, 0, 8, 12)
    assert runner._resource_capacity(20) == 12
    runner._resource_sample = (1000, None, 20, 8, 12)
    monkeypatch.setattr(runner, '_current_cpu_idle', lambda: None)
    assert runner._resource_capacity(20) == 12
    assert len(runner.processes) == 12 and not runner.stop_times


def test_failed_engine_slots_do_not_dispatch_while_healthy_slots_continue(runner):
    runner.data.update(parallelism=20, engine='codex')
    runner._fit_slots()
    runner.data['slots'][0] = 'claude'
    atomic(runner.directory / 'engine-status.json', {'claude': {'status': 'usage_limited'}})
    assert runner._free_slot() == 1
    atomic(runner.directory / 'engine-status.json', {'codex': {'status': 'error'}, 'claude': {'status': 'usage_limited'}})
    assert runner._free_slot() is None


def test_attention_pressure_slows_fresh_applications_but_prioritizes_resolved_work(runner, monkeypatch):
    import jobagent.services.application_runner as module
    monkeypatch.setattr(module.time, 'monotonic', lambda: 1000)
    monkeypatch.setattr(runner, '_resource_capacity', lambda configured: configured)
    runner.data.update(running=True, parallelism=20, slots=['codex'] * 20)
    runner._adaptive_started = 0
    runner.data['auto_stop'] = {'approvals': 50, 'help': 50}
    runner.data['autoplay']['enabled'] = False
    # Combined attention, rather than either category alone, pressures dispatch.
    runner.data['jobs'] = [{'id': f'waiting-{i}', 'job_id': 200+i, 'company': f'Waiting {i}',
                            'status': 'needs_approval' if i < 10 else 'needs_human',
                            'message': 'An applicant decision is required'} for i in range(20)]
    assert runner._update_dispatch_capacity() == 0
    assert runner.data['adaptive']['recovery_limit'] == 20
    for item in runner.data['jobs'][:10]:
        item['status'] = 'completed'
    assert runner._update_dispatch_capacity() == 10
    for item in runner.data['jobs'][:10]:
        item['status'] = 'needs_approval'
    runner.queue([1,3])
    fresh, recovery = runner.data['jobs'][-2:]
    recovery['approved_answers'] = [{'question': 'Start date', 'answer': 'June 2027'}]
    runner.popen = lambda *args, **kwargs: FakeProcess()
    runner.tick()
    assert recovery['id'] in runner.processes and fresh['status'] == 'queued'
    assert runner.data['running'] and not runner.stop_times
    # Clearing attention automatically permits new work, without Start or a restart.
    for item in runner.data['jobs'][:20]:
        item['status'] = 'completed'
    runner.tick()
    assert fresh['id'] in runner.processes


def test_attention_pressure_cannot_bypass_resources_or_turn_plain_retries_into_recovery(runner, monkeypatch):
    import jobagent.services.application_runner as module
    monkeypatch.setattr(module.time, 'monotonic', lambda: 1000)
    runner.data.update(running=True, parallelism=20)
    runner._adaptive_started = 0
    monkeypatch.setattr(runner, '_resource_capacity', lambda configured: 0)
    runner._update_dispatch_capacity()
    assert runner._free_slot(recovery=True) is None
    assert not runner._recovery_ready({'retries': 1, 'status': 'queued'})
    assert runner._recovery_ready({'approved_answers': [{'question': 'Known fact', 'answer': 'Yes'}]})


@pytest.mark.parametrize('message', [
    'Ford application site: Too Many Attempts. Try Again Later. This is a rate limit on the email step.',
    'Employer reCAPTCHA is exceeding its Enterprise free quota',
    'Website returned 429 Too Many Requests',
    'Rate-limited: employer daily application quota reached',
])
def test_employer_limits_do_not_pause_model_capacity(runner, message):
    runner.data['running'] = True
    assert not runner._record_model_limit({'engine': 'claude', 'message': message})
    assert runner.data['running']


@pytest.mark.parametrize('message', [
    'Claude CLI failed: rate limit reached',
    'OpenAI quota exceeded',
    'Too many requests from Anthropic',
    "You've hit your session limit · resets 5:10pm",
])
def test_actual_model_limits_still_pause_dispatch(runner, message):
    runner.data['running'] = True
    assert runner._record_model_limit({'engine': 'claude', 'message': message})
    assert not runner.data['running']


def test_ford_email_throttle_cools_only_its_employer(runner):
    runner.queue([1, 3])
    item = park(runner, 1, 'needs_human', engine='claude',
                message='Ford application site: Too Many Attempts. Try Again Later. This is a rate limit on the email step.')
    runner.data['running'] = True
    assert not runner._record_model_limit(item)
    assert runner._cool_down_if_throttled(item)
    assert runner.data['running']
    assert queued(runner) == [3, 1]
    assert runner.data['cooling']['acme']
    assert 'other' not in runner.data['cooling']


def test_explicit_queue_marks_good_fit_for_roles_rated_below_eligible(runner):
    from jobagent.processing.tracks import active_track, per_track
    with runner.sessions() as session:
        session.get(Job, 1).eligibility = EligibilityStatus.LIKELY_ELIGIBLE
        session.commit()
    with pytest.raises(ValueError, match='eligible'): runner.queue([1])
    result = runner.queue([1, 2], mark_fit=True)
    assert result['added'] == 2 and result['labeled'] == [1]  # job 2 is rules-eligible; it needs no label
    with runner.sessions() as session:
        label = per_track(session.get(Job, 1).user_fit_label, active_track())
        assert session.get(Job, 2).user_fit_label is None
    assert label['fit'] is True and label['note'] == 'Queued from the dashboard' and label['labeled_at']
    assert runner._job(1)['id'] == 1  # the label keeps it valid for launch and resume checks
    assert [j['job_id'] for j in runner.snapshot()['queue']] == [1, 2]


def test_queue_mark_fit_undoes_its_label_when_validation_fails(runner):
    with runner.sessions() as session:
        job = session.get(Job, 1); job.eligibility = EligibilityStatus.UNCERTAIN; job.location = 'Toronto, Canada'
        session.commit()
    with pytest.raises(ValueError, match='U.S.'): runner.queue([1], mark_fit=True)
    with runner.sessions() as session:
        assert session.get(Job, 1).user_fit_label is None
    assert not runner.snapshot()['queue']


def test_queue_route_accepts_mark_fit(runner, monkeypatch):
    monkeypatch.setattr(application_routes, 'get_runner', lambda: runner)
    with runner.sessions() as session:
        session.get(Job, 1).eligibility = EligibilityStatus.LIKELY_ELIGIBLE
        session.commit()
    app = FastAPI()
    app.include_router(application_routes.router)
    client = TestClient(app)
    headers = {'X-JobAgent-Application': '1'}
    assert client.post('/api/applications/queue', json={'job_ids': [1]}, headers=headers).status_code == 409
    response = client.post('/api/applications/queue', json={'job_ids': [1], 'mark_fit': True}, headers=headers)
    assert response.status_code == 200 and response.json()['labeled'] == [1]


def test_a_queued_role_survives_the_dashboard_track_toggle(runner):
    """Switching the shown track re-labels every posting; a role another track rates eligible stays launchable."""
    with runner.sessions() as session:
        job = session.get(Job, 1)
        job.eligibility = EligibilityStatus.INELIGIBLE      # the shown (data-track) verdict after a toggle
        job.track_results = {'mechanical': {'eligibility': 'STRONG_MATCH'}, 'data': {'eligibility': 'INELIGIBLE'}}
        other = session.get(Job, 3)
        other.eligibility = EligibilityStatus.INELIGIBLE
        other.track_results = {'mechanical': {'eligibility': 'INELIGIBLE'}, 'data': {'eligibility': 'INELIGIBLE'}}
        session.commit()
    assert runner._job(1)['id'] == 1
    with pytest.raises(ValueError, match='must be an eligible'):
        runner._job(3)


def test_companies_he_applies_to_himself_are_never_queued_or_picked(runner):
    from jobagent import settings
    settings.save({'workers.manual_companies': 'TikTok, Acme'})
    with pytest.raises(ValueError, match='apply there yourself'):
        runner.queue([1])                       # Acme
    assert runner.queue([3])['added'] == 1     # Other
    assert runner._manual('TikTok USDS JV') and runner._manual('acme corp') and not runner._manual('Other')
    settings.save({'workers.manual_companies': ''})
    assert settings.setting('workers.manual_companies') == '' and not runner._manual('Acme')


def test_a_worker_launched_while_workers_are_off_still_gets_the_tick_loop(runner):
    # After a restart with workers off no loop exists; approving answers launches a worker that the loop
    # must refresh and reap (Howmet 11608 sat as "starting" with a dead process, 2026-10-23).
    runner.data['running'] = False
    runner.thread = None
    runner.tick = lambda: None
    runner._ensure_loop()
    assert runner.thread is not None and runner.thread.is_alive() and runner.data['running'] is False
    runner.shutdown_event.set()
    runner.thread.join(3)
    runner.thread = None
    runner._ensure_loop()  # a stopped runner never restarts its loop
    assert runner.thread is None


def test_confirmed_submission_from_needs_help_is_recorded_as_applied(runner):
    runner.queue([1, 3])
    park(runner, 1, 'needs_human', message='Finish the remaining fields and press Submit yourself.')
    atomic(runner.agent_dir / 'state/jobagent-1.json', {'status': 'submitted'})
    runner._help_sweep_at = 0
    runner._retire_submitted_help()
    item = next(j for j in runner.data['jobs'] if j['job_id'] == 1)
    assert item['status'] == 'completed' and item['submitted'] and item['recorded']
    with runner.sessions() as session: assert session.get(Job, 1).status == JobStatus.APPLIED
    # A recording missed earlier (tick failure, restart) is caught up and such roles count as in flight until then.
    park(runner, 3, 'completed', submitted=True, recorded=False)
    assert runner.in_flight_job_ids() == [3]
    runner._record_stale_completions()
    with runner.sessions() as session: assert session.get(Job, 3).status == JobStatus.APPLIED
    assert runner.in_flight_job_ids() == []


def test_finish_in_my_chrome_hands_gaps_to_him_instead_of_parking(runner):
    launched = []
    runner.popen = lambda args, **kw: launched.append(args) or FakeProcess()
    runner.queue([1])
    park(runner, 1, 'needs_approval', questions=[{'label': 'City*', 'required': True, 'type': 'text'}],
         approved_answers=[{'question': 'City*', 'answer': 'Springfield'}])
    runner.finish_myself(1)
    item = next(j for j in runner.data['jobs'] if j['job_id'] == 1)
    request = json.loads((runner.directory / item['id'] / 'request.json').read_text())
    assert request['humanFinish'] is True and request['parkQuestions'] is False  # a gap is handed over at the screen
    assert [(a['question'], a['answer']) for a in request['approvedAnswers']] == [('City*', 'Springfield')]
    assert len(launched) == 1 and item['human_finish'] is True


class HungProcess:
    pid = 99999997
    def __init__(self): self.code = None
    def poll(self): return self.code


def _hung(runner, status, minutes_ago, **state):
    import json as _json
    from datetime import datetime as _dt, timedelta as _td, timezone as _tz
    runner.queue([1])
    item = runner.data['jobs'][0]
    stamp = (_dt.now(_tz.utc) - _td(minutes=minutes_ago)).isoformat()
    folder = runner.directory / item['id']; folder.mkdir(parents=True, exist_ok=True)
    (folder / 'state.json').write_text(_json.dumps({'status': status, 'message': 'Workday showed a Workday error page; refreshing once after a pause', 'updated_at': stamp, **state}))
    item.update(status=status, updated_at=stamp)
    process = HungProcess()
    runner.processes[item['id']] = process
    killed = []
    runner._terminate = lambda p: (killed.append(p), setattr(p, 'code', -15))
    return item, process, killed


def test_a_worker_with_no_progress_for_the_stall_limit_is_stopped(runner):
    item, process, killed = _hung(runner, 'running', 45)
    runner.tick()
    assert killed == [process] and item['status'] == 'interrupted'
    assert 'no progress for 30 minutes' in item['message'] and 'Workday error page' in item['message']
    assert item['id'] not in runner.processes


def test_a_recent_handed_off_or_submitting_worker_is_left_alone(runner):
    for status, minutes, extra in [('running', 5, {}), ('needs_human', 120, {}), ('running', 120, {'submission_attempted': True})]:
        runner.data['jobs'].clear(); runner.processes.clear()
        item, process, killed = _hung(runner, status, minutes, **extra)
        runner.tick()
        assert killed == [] and item['id'] in runner.processes, (status, minutes, extra)

def test_help_item_opens_the_resume_its_run_uploaded(runner, tmp_path):
    runner.queue([1])
    item = park(runner, 1, 'needs_human', message='This site asks for a CAPTCHA')
    assert runner.help_items()[0]['resume'] is None  # no standing resume and nothing sent yet
    sent = tmp_path / 'sent'
    sent.mkdir()
    (sent / 'Alex_Rivera_Resume.pdf').write_bytes(b'%PDF-tailored')
    (sent / 'sent.json').write_text(json.dumps({'resume_label': 'Tailored: Thermal systems'}))
    item['sent_documents'] = str(sent)
    resume = runner.help_items()[0]['resume']
    assert resume == {'label': 'Tailored: Thermal systems', 'tailored': True, 'url': '/api/applications/help/1/resume.pdf'}
    assert runner.help_resume(1) == b'%PDF-tailored'
    with pytest.raises(ValueError):
        runner.help_resume(2)

def test_failed_relay_captcha_opens_the_visible_finish_chrome(runner):
    launched = []
    runner._launch = lambda item, delay: launched.append(item)
    runner.queue([1])
    item = park(runner, 1, 'needs_human', phase='captcha_handoff', submission_attempted=False,
                message='Vision model declined. Nothing was sent to the employer.')
    assert runner._hand_off_captcha(item) is True
    fresh = next(j for j in runner.data['jobs'] if j['job_id'] == 1)
    assert fresh['human_finish'] is True and launched == [fresh]

def test_captcha_handoff_never_follows_a_submission_attempt(runner):
    runner._launch = lambda item, delay: pytest.fail('must not open a second window')
    runner.queue([1])
    item = park(runner, 1, 'needs_human', phase='captcha_handoff', submission_attempted=True)
    assert runner._hand_off_captcha(item) is False
    other = park(runner, 1, 'needs_human', phase='verification', submission_attempted=False)
    assert runner._hand_off_captcha(other) is False

def test_a_cleared_posting_with_proven_refusal_can_be_queued_again(runner):
    runner.data.setdefault('dismissed_items', []).append({'job_id': 1, 'status': 'submission_unknown', 'id': 'x'})
    with pytest.raises(ValueError):
        runner.queue([1])
    state = runner.agent_dir / 'state'
    state.mkdir(exist_ok=True)
    atomic(state / 'jobagent-1.json', {'status': 'verification_not_accepted', 'rejection': {'outcome': 'rejected'}})
    runner.queue([1])
    assert any(j['job_id'] == 1 and j['status'] == 'queued' for j in runner.data['jobs'])
    assert runner.data['dismissed_items'][0]['submission_resolution'] == 'not_accepted'

def test_a_limit_with_no_reset_time_backs_off_instead_of_hourly(runner):
    from datetime import datetime, timezone
    msg = 'OpenCode failed: Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.'
    hours = []
    for _ in range(5):
        item = {'engine': 'opencode', 'message': msg}
        assert runner._record_model_limit(item)
        until = json.loads((runner.directory / 'engine-status.json').read_text())['opencode']['until']
        hours.append(round((datetime.fromisoformat(until) - datetime.now(timezone.utc)).total_seconds() / 3600))
    assert hours == [1, 2, 4, 8, 12]
    named = {'engine': 'claude', 'message': "Claude usage limit reached; resets 5pm"}
    assert runner._record_model_limit(named) and 'claude' not in runner.data['limit_streaks']

def test_cost_report_adds_every_run_of_a_posting(runner):
    runner.queue([1])
    item = runner.data['jobs'][0]
    item['status'] = 'completed'
    old = runner.directory / 'older-run'
    old.mkdir(parents=True)
    atomic(old / 'request.json', {'job': {'id': 1}, 'model': 'claude-sonnet-5-5'})
    atomic(old / 'state.json', {'status': 'needs_approval', 'model_usage': {'claude:claude-sonnet-5-5': {
        'calls': 3, 'input_tokens': 1000, 'cache_read_input_tokens': 0, 'cache_creation_input_tokens': 0, 'output_tokens': 100}}})
    latest = runner.directory / item['id']
    latest.mkdir(parents=True, exist_ok=True)
    atomic(latest / 'request.json', {'job': {'id': 1}})
    atomic(latest / 'state.json', {'status': 'completed', 'usage': {}, 'model_usage': {}})
    row = next(r for r in runner.cost_report()['rows'] if r['job_id'] == 1)
    assert row['attempt_count'] == 2
    assert row['estimated_cost_usd'] == round((1000 * 2.0 + 100 * 10.0) / 1_000_000, 8)
    assert row['models'][0]['calls'] == 3

def test_busy_company_gets_a_few_autoplay_picks_per_week(runner, monkeypatch):
    from jobagent.services import application_runner as ar
    from jobagent import settings as st
    runner._manual_selection_cache = {'acme'}
    monkeypatch.setattr(ar.application_caps, 'load', lambda: {})
    monkeypatch.setattr(ar, 'setting', lambda key: 2 if key == 'workers.high_volume_weekly' else st.setting(key))
    assert runner._high_volume_open('Acme') is True
    runner.queue([1])
    assert runner._high_volume_open('Acme') is True          # one reserved, limit 2
    runner.queue([2])
    assert runner._high_volume_open('Acme') is False         # two reserved: the week's picks are used
    assert runner._high_volume_open('Acme', exclude_job_id=2) is True
    assert runner._high_volume_open('Other') is False        # not a busy company: the normal rules decide
    monkeypatch.setattr(ar.application_caps, 'load', lambda: {'acme': {'status': 'pending'}})
    assert runner._high_volume_open('Acme', exclude_job_id=2) is False  # a stated employer cap stays manual
    monkeypatch.setattr(ar, 'setting', lambda key: 0 if key == 'workers.high_volume_weekly' else st.setting(key))
    monkeypatch.setattr(ar.application_caps, 'load', lambda: {})
    assert runner._high_volume_open('Acme', exclude_job_id=2) is False

def test_apply_yourself_posting_is_filled_in_his_chrome(runner):
    launched = []
    runner._launch = lambda item, delay: launched.append(item)
    runner.data['apply_yourself'] = [{'job_id': 1, 'company': 'Acme', 'title': 'Mechanical Engineer', 'url': 'https://example.com/1',
                                      'host': 'example.com', 'reason': 'refuses the browser', 'resume_variant': 'v1'}]
    assert runner.apply_yourself_fill(1) == {'ok': True}
    item = next(j for j in runner.data['jobs'] if j['job_id'] == 1)
    assert item['human_finish'] is True and item['resume_variant'] == 'v1' and launched == [item]
    with pytest.raises(ValueError):
        runner.apply_yourself_fill(2)

def test_internships_are_off_by_his_choice(runner, monkeypatch):
    from jobagent.services import application_runner as ar
    from jobagent import settings as st
    on = {'v': False}
    monkeypatch.setattr(ar, 'setting', lambda key: on['v'] if key == 'workers.apply_internships' else st.setting(key))
    assert ar.internship_blocked('INTERNSHIP', 'Mechanical Engineer') is True
    assert ar.internship_blocked('FULL_TIME', 'Mechanical Engineering Intern - Summer 2027') is True
    assert ar.internship_blocked('FULL_TIME', 'Co-op, Test Engineering') is True
    assert ar.internship_blocked('FULL_TIME', 'Internal Tools Engineer') is False
    assert ar.application_role_types() == {'FULL_TIME'}
    runner.queue([1])
    item = runner.data['jobs'][0]
    item['title'] = 'Mechanical Engineering Intern'
    runner.data['running'] = True
    runner.tick()
    assert item['status'] == 'skipped' and 'Internships are off' in item['message']
    on['v'] = True
    assert ar.application_role_types() == {'FULL_TIME', 'INTERNSHIP'} and ar.internship_blocked('INTERNSHIP', 'x') is False


def _internships_on(monkeypatch):
    from jobagent.services import application_runner as ar
    from jobagent import settings as st
    real = st.setting
    monkeypatch.setattr(ar, 'setting', lambda key: True if key == 'workers.apply_internships' else real(key))


def test_recent_runs_can_be_dismissed_one_by_one_or_all_at_once(runner):
    runner.queue([1, 3])
    runner.data['running'] = True
    first = park(runner, 1, 'stopped', message='Stopped by applicant')
    park(runner, 3, 'submitted_pending_receipt', message='Submit was clicked once.')
    assert [r['job_id'] for r in runner.snapshot()['recent']] == [3, 1]
    assert runner.dismiss_recent(1) == {'ok': True, 'dismissed': 1}
    assert [r['job_id'] for r in runner.snapshot()['recent']] == [3]
    # Only the listing changes: the run stays, and a new run of the posting is listed again.
    assert first in runner.data['jobs'] and 1 not in runner.data['skipped']
    first['id'] = 'a-later-run'
    assert [r['job_id'] for r in runner.snapshot()['recent']] == [3, 1]
    assert runner.dismiss_recent()['dismissed'] == 2 and runner.snapshot()['recent'] == []
    assert next(j for j in runner.data['jobs'] if j['job_id'] == 3)['status'] == 'submitted_pending_receipt'
    with pytest.raises(ValueError):
        runner.dismiss_recent(4)


def test_a_company_cooldown_can_be_cleared_on_request(runner):
    runner.queue([1])
    item = next(j for j in runner.data['jobs'] if j['job_id'] == 1)
    item.update(not_before='2999-01-01T00:00:00+00:00', cooldowns=2, message="Acme's site is unavailable; cooling down, then trying again")
    runner.data['cooling']['acme'] = '2999-01-01T00:00:00+00:00'
    assert runner.clear_cooldown('Acme') == {'ok': True}
    assert 'acme' not in runner.data['cooling'] and 'not_before' not in item and item['cooldowns'] == 0
    with pytest.raises(ValueError):
        runner.clear_cooldown('Acme')


def test_agent_cannot_requeue_a_posting_he_deleted_from_help_but_he_can(runner):
    runner.queue([1]);failed=runner.data['jobs'][0];failed['status']='failed'
    runner.clear_attention('help',[failed['id']])
    with pytest.raises(ValueError,match='only he can queue it again'):
        runner.queue([1],by_user=False)
    assert not runner.data['jobs']
    assert runner.queue([3],by_user=False)['added']==1   # a posting he never deleted is still an agent's to queue
    assert runner.queue([1])['added']==1 and 1 not in runner.data['skipped']
