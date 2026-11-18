"""Retry cap, aggregator refusal, platform-aware autoplay and the Apply yourself list."""
from contextlib import contextmanager
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from jobagent import settings
from jobagent.db.models import Base, EligibilityStatus, Job
from jobagent.services import platform_yield
from jobagent.services.application_runner import ApplicationRunner, atomic
from jobagent.ui import application_routes

S = EligibilityStatus.STRONG_MATCH
CLUSTER = 'PRODUCT / MECHANICAL DESIGN'


@pytest.fixture
def runner(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 'test.db'), connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)

    @contextmanager
    def sessions():
        with Session(engine) as session:
            yield session
    agent = tmp_path / 'agent'
    (agent / 'private').mkdir(parents=True)
    (agent / 'src').mkdir()
    (agent / 'src/dashboard-worker.mjs').touch()
    r = ApplicationRunner(tmp_path / 'runs', agent, sessions)
    r._cli = lambda engine: f'/fixture/bin/{engine}'
    r.data['auto_repair_enabled'] = False  # no repair agents in these tests
    yield r
    r.shutdown_event.set()


def add(runner, job_id, url, company=None, priority=50, application_url=None):
    with runner.sessions() as session:
        session.add(Job(id=job_id, fit_review={'fit': True, 'hash': None}, company_name=company or f'Co{job_id}',
                        title=f'Mechanical Engineer {job_id}', description='d', location='United States',
                        canonical_url=url, application_url=application_url or url, source_ats='direct',
                        role_type='FULL_TIME', eligibility=S, best_career_cluster=CLUSTER, priority_score=priority))
        session.commit()


class Exited:
    pid = 99999999
    def poll(self): return 0


def item_for(runner, job_id):
    return next(j for j in runner.data['jobs'] if j['job_id'] == job_id)


def end_run(runner, job_id, status, message, url='https://example.com/apply', events=3, questions=()):
    """The current run of this role ends the given way (as a worker writes state.json) and the tick reaps it."""
    item = item_for(runner, job_id)
    atomic(runner.directory / item['id'] / 'state.json', {
        'status': status, 'phase': status, 'message': message, 'url': url, 'updated_at': '2026-11-01T00:00:00Z',
        'events': [{'message': f'step {n}'} for n in range(events)], 'questions': [{'label': q} for q in questions]})
    runner.processes[item['id']] = Exited()
    runner.tick()
    return next((j for j in runner.data['jobs'] if j['job_id'] == job_id), None)  # None: moved to Apply yourself


# 1. Retry cap ---------------------------------------------------------------------------------------------

def test_role_stops_after_runs_without_progress_and_automatic_retries_refuse_it(runner):
    add(runner, 1, 'https://example.com/1')
    runner.queue([1])
    failure = 'Required fields still need answers: Badge number'
    assert end_run(runner, 1, 'failed', failure)['progress']['runs'] == 1
    runner.retry_parked(1)                               # a repair agent's retry (not his)
    assert end_run(runner, 1, 'failed', failure)['progress']['runs'] == 2
    runner.retry_parked(1)
    item = end_run(runner, 1, 'failed', failure)
    assert item['progress_capped'] and item['status'] == 'failed'
    assert item['message'] == f'Stopped after 3 runs without progress: {failure}'
    assert item in runner.help_items() or any(h['job_id'] == 1 for h in runner.help_items())
    # Automatic paths (technical retry, cool-down, breaker, password requeue) go through _resume_from and are refused.
    with pytest.raises(ValueError, match='Stopped after 3 runs'):
        runner._resume_from(1, {'failed'}, retries=1)
    # A repair agent's Try again gets one more run, which must show progress.
    runner.retry_parked(1)
    item = end_run(runner, 1, 'failed', failure)
    assert item['progress_capped'] and item['message'].startswith('Stopped after 4 runs without progress: Required fields')
    # His Try again starts the count over.
    runner.retry_parked(1, by_user=True)
    assert not item_for(runner, 1).get('progress')
    assert end_run(runner, 1, 'failed', failure)['progress']['runs'] == 1


def test_technical_auto_retry_stops_at_the_cap(runner):
    settings.save({'workers.max_runs_without_progress': 2})
    add(runner, 1, 'https://example.com/1')
    runner.queue([1])
    timeout = 'locator.click: Timeout 10000ms exceeded.'
    item = end_run(runner, 1, 'failed', timeout)
    assert item['status'] == 'queued' and item['retries'] == 1        # the one automatic retry still happens
    item = end_run(runner, 1, 'failed', timeout)
    assert item['progress_capped'] and item['status'] == 'failed'


def test_progress_resets_the_count(runner):
    add(runner, 1, 'https://example.com/1')
    runner.queue([1])
    end_run(runner, 1, 'failed', 'Required fields still need answers: A')
    runner.retry_parked(1)
    assert end_run(runner, 1, 'failed', 'Required fields still need answers: A')['progress']['runs'] == 2
    runner.retry_parked(1)
    # A different failure (the earlier one was fixed) is progress.
    assert end_run(runner, 1, 'failed', 'Workday stopped: stayed on Self Identify')['progress']['runs'] == 1
    runner.retry_parked(1)
    # So are more recorded steps, a new page, or new questions flagged.
    assert end_run(runner, 1, 'failed', 'Workday stopped: stayed on Self Identify', events=9)['progress']['runs'] == 1
    runner.retry_parked(1)
    assert end_run(runner, 1, 'failed', 'Workday stopped: stayed on Self Identify', url='https://example.com/review', events=9)['progress']['runs'] == 1
    runner.retry_parked(1)
    assert end_run(runner, 1, 'needs_human', 'Workday stopped: stayed on Self Identify', url='https://example.com/review', events=9,
                   questions=['Veteran status'])['progress']['runs'] == 1


def test_waiting_on_him_resets_and_throttles_or_ai_limits_do_not_count(runner):
    add(runner, 1, 'https://example.com/1')
    runner.queue([1])
    end_run(runner, 1, 'failed', 'Required fields still need answers: A')
    runner.retry_parked(1)
    end_run(runner, 1, 'failed', 'Required fields still need answers: A')
    runner.retry_parked(1)
    item = end_run(runner, 1, 'needs_approval', '1 new question flagged for your approval.', questions=['Start date'])
    assert item['progress']['runs'] == 0 and not item.get('progress_capped')
    item.update(status='failed')  # (as if he answered and it failed again)
    for message in ('Site unavailable: Workday reports a temporary service interruption.', 'Claude usage limit reached; resets 5pm'):
        item = item_for(runner, 1)
        item.update(status='queued')
        item = end_run(runner, 1, 'blocked', message)
        assert item['progress']['runs'] == 0 and not item.get('progress_capped')


def test_cap_zero_turns_it_off(runner):
    settings.save({'workers.max_runs_without_progress': 0})
    add(runner, 1, 'https://example.com/1')
    runner.queue([1])
    for _ in range(5):
        item = end_run(runner, 1, 'failed', 'Required fields still need answers: A')
        runner.retry_parked(1)
    assert not item.get('progress_capped')


def test_his_retry_from_the_dashboard_resets_but_an_agents_curl_does_not(runner, monkeypatch):
    add(runner, 1, 'https://example.com/1')
    runner.queue([1])
    end_run(runner, 1, 'failed', 'Required fields still need answers: A')
    monkeypatch.setattr(application_routes, 'get_runner', lambda: runner)
    app = FastAPI()
    app.include_router(application_routes.router)
    client = TestClient(app)
    assert client.post('/api/applications/jobs/1/retry-parked', headers={'X-JobAgent-Application': '1'}).status_code == 200
    assert item_for(runner, 1)['progress']['runs'] == 1           # agent curl: carried over
    end_run(runner, 1, 'failed', 'Required fields still need answers: A')
    response = client.post('/api/applications/jobs/1/retry-parked',
                           headers={'X-JobAgent-Application': '1', 'Sec-Fetch-Site': 'same-origin'})
    assert response.status_code == 200 and not item_for(runner, 1).get('progress')


def test_his_queueing_resets_the_count(runner):
    add(runner, 1, 'https://example.com/1')
    runner.queue([1])
    for _ in range(3):
        end_run(runner, 1, 'failed', 'Required fields still need answers: A')
        if not item_for(runner, 1).get('progress_capped'):
            runner.retry_parked(1)
    assert item_for(runner, 1)['progress_capped']
    assert runner.queue([1])['added'] == 1
    assert item_for(runner, 1)['status'] == 'queued' and not item_for(runner, 1).get('progress')


# 1b. Aggregators --------------------------------------------------------------------------------------

def test_job_board_links_are_refused_unless_the_employer_posting_was_resolved(runner):
    add(runner, 1, 'https://www.ziprecruiter.com/jobs/v2/abc')
    add(runner, 2, 'https://www.ziprecruiter.com/jobs/v2/def', application_url='https://boards.greenhouse.io/acme/jobs/1')
    with pytest.raises(ValueError, match='ziprecruiter.com is a job board the worker cannot apply through'):
        runner.queue([1])
    assert runner.queue([2])['added'] == 1
    assert [p['job_id'] for p in runner.up_next()] == []        # 2 is queued; 1 is never picked
    # One already in the queue is retired (skipped), not sent to Needs help.
    runner.data['jobs'] = [runner._item({'id': 1, 'company': 'Co1', 'title': 't', 'url': 'https://www.ziprecruiter.com/jobs/v2/abc'})]
    runner.data['running'] = True
    runner.popen = lambda *a, **k: Exited()
    runner.tick()
    assert item_for(runner, 1)['status'] == 'skipped'


# 2. Platform-aware autoplay ---------------------------------------------------------------------------

def history_run(runner, n, job_id, url, submitted):
    run = runner.directory / f'hist-{n}'
    atomic(run / 'request.json', {'job': {'id': job_id, 'url': url}})
    atomic(run / 'state.json', {'status': 'completed' if submitted else 'failed', 'submitted': submitted,
                                'updated_at': '2099-01-01T00:00:00Z'})


def test_platform_classification():
    assert platform_yield.platform_of('https://acme.wd5.myworkdayjobs.com/x/job/1') == 'workday'
    assert platform_yield.platform_of('https://boards.greenhouse.io/acme/jobs/1') == 'greenhouse'
    assert platform_yield.platform_of('https://egup.fa.us2.oraclecloud.com/hcmUI/x') == 'oraclecloud'
    assert platform_yield.platform_of('https://careers-rivian.icims.com/jobs/1/job') == 'icims'
    assert platform_yield.platform_of('https://www.amazon.jobs/en/jobs/1') == 'amazon'
    assert platform_yield.platform_of('https://career5.successfactors.com/x') == 'successfactors'
    assert platform_yield.platform_of('https://careers.gene.com/us/en/job/202410-1/x') == 'phenom'
    assert platform_yield.platform_of('https://www.tesla.com/careers/search/job/1') == 'other'


def test_autoplay_holds_low_yield_platforms_and_ranks_by_yield(runner):
    for n in range(5):
        history_run(runner, n, 100 + n, f'https://egup.fa.us2.oraclecloud.com/job/{n}', submitted=False)
        history_run(runner, 10 + n, 200 + n, f'https://boards.greenhouse.io/acme/jobs/{n}', submitted=True)
    history_run(runner, 20, 300, 'https://jobs.lever.co/acme/1', submitted=False)   # 1 posting: too few, neutral
    add(runner, 1, 'https://egup.fa.us2.oraclecloud.com/job/new', priority=95)
    add(runner, 2, 'https://example.com/2', priority=80)
    add(runner, 3, 'https://boards.greenhouse.io/acme/jobs/new', priority=75)
    add(runner, 4, 'https://jobs.lever.co/acme/new', priority=70)
    yields = runner.platform_yields()
    rates = {p['platform']: p for p in yields['platforms']}
    assert yields['held'] == ['oraclecloud'] and rates['oraclecloud']['rate'] == 0 and rates['greenhouse']['rate'] == 1
    assert rates['lever']['neutral'] and not rates['lever']['held'] and rates['lever']['adjustment'] == 0
    # Greenhouse (100%) gets +10 by default, so 75 + 10 outranks 80; Oracle is held out of autoplay entirely.
    picks = runner.up_next()
    assert [p['job_id'] for p in picks] == [3, 2, 4]
    assert picks[0]['platform'] == 'Greenhouse' and picks[0]['platform_rate'] == 1
    # He can still queue a role there himself.
    assert runner.queue([1])['added'] == 1
    # The floor, sample and weight are settings.
    settings.save({'workers.autoplay_min_platform_success': 0, 'workers.autoplay_platform_weight': 0})
    runner.data['jobs'] = []
    assert [p['job_id'] for p in runner.up_next()] == [1, 2, 3, 4]
    settings.save({'workers.platform_yield_min_jobs': 50, 'workers.autoplay_min_platform_success': 0.25})
    assert runner.platform_yields()['held'] == []
    assert runner.snapshot()['platform_yield']['window_days'] == 21
    assert 'platform_yield' in runner.cost_report()


# 3. Sites that refuse the browser ---------------------------------------------------------------------

def test_blocked_host_postings_go_to_apply_yourself_on_queue_autoplay_and_sweep(runner, monkeypatch):
    settings.save({'workers.blocked_hosts': 'tesla.com'})
    add(runner, 1, 'https://www.tesla.com/careers/search/job/1', company='Tesla', priority=99)
    add(runner, 2, 'https://www.tesla.com/careers/search/job/2', company='Tesla', priority=98)
    add(runner, 3, 'https://example.com/3', priority=10)
    add(runner, 4, 'https://www.tesla.com/careers/search/job/4', company='Tesla Energy', priority=97)
    result = runner.queue([1, 3])
    assert result['added'] == 1 and result['apply_yourself'] == [1] and 'Apply yourself' in result['message']
    assert [j['job_id'] for j in runner.data['jobs']] == [3]
    # Autoplay reaching one puts it on the list instead of picking it.
    assert [p['job_id'] for p in runner.up_next()] == []
    listed = {e['job_id']: e for e in runner.apply_yourself()['postings']}
    assert set(listed) == {1, 2, 4} and listed[2]['source'] == 'autoplay' and listed[1]['host'] == 'tesla.com'
    # A role already queued before the host was listed (2977, 14641) leaves the queue for the list on the next tick.
    settings.save({'workers.blocked_hosts': 'tesla.com, example.com'})
    item = item_for(runner, 3)
    item['resume_variant'] = 'tailored-x'
    runner.tick()
    assert runner.data['jobs'] == []
    entry = next(e for e in runner.data['apply_yourself'] if e['job_id'] == 3)
    assert entry['resume_variant'] == 'tailored-x'
    pdf = runner.directory / 'tailored.pdf'
    pdf.write_bytes(b'%PDF-1.4 tailored')
    monkeypatch.setattr(runner.resume_library, 'path', lambda v: pdf if v == 'tailored-x' else None)
    monkeypatch.setattr(runner.resume_library, 'variants', lambda: [{'id': 'tailored-x', 'label': 'Embodied AI'}])
    shown = next(e for e in runner.apply_yourself()['postings'] if e['job_id'] == 3)
    assert shown['resume'] == {'kind': 'tailored', 'label': 'Embodied AI', 'url': '/api/applications/apply-yourself/3/resume.pdf'}
    assert runner.apply_yourself_resume(3) == b'%PDF-1.4 tailored'
    with pytest.raises(ValueError, match='No tailored resume'):
        runner.apply_yourself_resume(1)
    assert runner.remove_apply_yourself(3)['ok'] and all(e['job_id'] != 3 for e in runner.data['apply_yourself'])


def test_repeated_access_denied_adds_the_site_with_when_and_why(runner):
    for n in range(1, 6):
        add(runner, n, f'https://careers.blocky.com/job/{n}')
    settings.save({'workers.blocked_hosts': 'tesla.com'})
    runner.queue([1, 2, 3, 4, 5])
    denied = 'Site unavailable: access denied (HTTP 403). The queue will retry after a cooldown.'
    end_run(runner, 1, 'blocked', denied, url='https://careers.blocky.com/job/1')
    end_run(runner, 2, 'failed', 'Required fields still need answers: A', url='https://careers.blocky.com/job/2')  # let through: streak resets
    end_run(runner, 3, 'blocked', denied, url='https://careers.blocky.com/job/3')
    end_run(runner, 4, 'blocked', denied, url='https://www.blocky.com/job/4')
    assert 'blocky.com' not in settings.setting('workers.blocked_hosts')
    end_run(runner, 5, 'blocked', denied, url='https://careers.blocky.com/job/5')
    assert settings.setting('workers.blocked_hosts') == 'tesla.com, blocky.com'
    log = runner.data['blocked_host_log']['blocky.com']
    assert log['job_ids'] == [3, 4, 5] and 'Access denied on 3 different postings' in log['reason'] and log['added_at']
    # Every waiting or stuck role on that site leaves the queue for the Apply yourself list, keeping why.
    listed = {e['job_id']: e for e in runner.data['apply_yourself']}
    assert set(listed) == {1, 2, 3, 4, 5} and runner.data['jobs'] == []
    assert listed[2]['reason'] == "blocky.com refuses the worker's browser: Required fields still need answers: A"
    assert runner.apply_yourself()['added_automatically']['blocky.com']['job_ids'] == [3, 4, 5]


def test_platform_tenant_hosts_are_blocked_alone(runner):
    settings.save({'workers.blocked_host_denials': 2})
    for n in (1, 2):
        add(runner, n, f'https://acme.wd5.myworkdayjobs.com/x/job/{n}')
    runner.queue([1, 2])
    denied = 'Site unavailable: access denied (HTTP 403).'
    end_run(runner, 1, 'blocked', denied, url='https://acme.wd5.myworkdayjobs.com/x/job/1')
    end_run(runner, 2, 'blocked', denied, url='https://acme.wd5.myworkdayjobs.com/x/job/2')
    assert settings.setting('workers.blocked_hosts').endswith('acme.wd5.myworkdayjobs.com')
    assert runner._blocked_host('https://other.wd1.myworkdayjobs.com/x') is None


def test_new_settings_are_in_the_registry():
    for key, default in [('workers.max_runs_without_progress', 3), ('workers.platform_yield_days', 21),
                         ('workers.platform_yield_min_jobs', 5), ('workers.autoplay_min_platform_success', 0.25),
                         ('workers.blocked_hosts', ''), ('workers.real_chrome_hosts', 'tesla.com'),
                         ('workers.visible_hosts', 'us-careers-rivian.icims.com, careers.rivian.com'), ('workers.blocked_host_denials', 3)]:
        s = settings.BY_KEY[key]
        assert s.default == default and s.label and s.help


# 2026-11-10: Tesla in the hidden real Chrome, Rivian in his visible Chrome, closed/already-applied postings dismissed.

def test_real_chrome_and_visible_hosts_route_the_launch(runner):
    add(runner, 1, 'https://www.tesla.com/careers/search/job/1', company='Tesla')
    add(runner, 2, 'https://us-careers-rivian.icims.com/jobs/2/job', company='Rivian')
    add(runner, 3, 'https://example.com/3')
    runner.queue([1, 2, 3])
    assert runner.data.get('apply_yourself', []) == []
    launched = {}
    runner.popen = lambda *a, **k: Exited()
    for job_id in (1, 2, 3):
        item = item_for(runner, job_id)
        runner._launch(item, 0)
        launched[job_id] = json.loads((runner.directory / item['id'] / 'request.json').read_text())
    assert launched[1]['realChrome'] is True and launched[1]['humanFinish'] is False
    assert launched[2]['humanFinish'] is True and item_for(runner, 2)['human_finish'] is True
    assert launched[3]['realChrome'] is False and launched[3]['humanFinish'] is False


def test_unavailable_and_already_applied_postings_are_dismissed(runner):
    for n in (1, 2, 3, 4):
        add(runner, n, f'https://example.com/{n}')
    runner.queue([1, 2, 3, 4])
    end_run(runner, 1, 'skipped', 'Posting unavailable: Ashby says "Job not found" for this exact job.')
    end_run(runner, 2, 'needs_human', 'Hyundai says: "You already applied for this position." Nothing was submitted in this run.')
    end_run(runner, 3, 'blocked', 'Workday stopped: Workday says: "You\'ve already applied for this job." Nothing was submitted in this run.')
    end_run(runner, 4, 'needs_human', 'An hCaptcha blocks the login.')
    assert [j['job_id'] for j in runner.data['jobs']] == [4]
    dismissed = {d['job_id']: d['auto_dismissed'] for d in runner.data['dismissed_items']}
    assert dismissed == {1: 'posting no longer available', 2: 'already applied', 3: 'already applied'}
    assert {1, 2, 3} <= set(runner.data['skipped'])


def test_a_submitted_run_is_never_dismissed(runner):
    add(runner, 1, 'https://example.com/1')
    runner.queue([1])
    item = item_for(runner, 1)
    item['submission_attempted'] = True
    item.update(status='needs_human', message='You already applied for this position.')
    runner._dismiss_gone()
    assert item_for(runner, 1)
