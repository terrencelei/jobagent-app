"""Repeated identical failures hold a site, get one repair, and retry the rest when it ends."""
import json
import threading
from types import SimpleNamespace

from jobagent.db.models import Job, JobStatus
from jobagent.services import failure_signatures as fs
from test_application_runner import runner, park  # noqa: F401 (fixture)

TIMEOUT = 'locator.click: Timeout 30000ms exceeded waiting for locator("[data-ja-control=\\"f0c{n}\\"]")'


def test_signatures_drop_per_posting_details_and_classes_name_the_failure():
    a = fs.signature('locator.click: Timeout 30000ms exceeded at https://acme.wd1.myworkdayjobs.com/x/R123 "Next"')
    b = fs.signature('locator.click: Timeout 20000ms exceeded at https://other.wd5.myworkdayjobs.com/y/R9 "Save"')
    assert a == b
    assert fs.failure_class('proxy.connectOverCDP: Timeout 30000ms exceeded') == 'browser'
    assert fs.failure_class('Claude usage limit reached. resets 5pm') == 'model_limit'
    assert fs.failure_class('Site unavailable: the page stayed blank') == 'site_blocked'
    assert fs.platform('https://acme.wd1.myworkdayjobs.com/x') == 'myworkdayjobs.com'


def test_a_system_failure_on_two_sites_holds_every_site_and_exempt_failures_never_trip():
    ledger = {}
    for job_id, url in [(1, 'https://a.icims.com/j'), (2, 'https://b.lever.co/j'), (3, 'https://c.icims.com/j')]:
        sig, _ = fs.note_failure(ledger, job_id=job_id, message='Worker exited. Check the employer before retrying.',
                                 url=url, at='2026-10-29T20:00:00+00:00', window_minutes=120)
    assert fs.tripped(ledger[sig], 3) == '*'
    ledger = {}
    for job_id in (1, 2, 3):
        fs.note_failure(ledger, job_id=job_id, message='CAPTCHA still open', url='https://a.icims.com/j',
                        at='2026-10-29T20:00:00+00:00', window_minutes=120)
    assert ledger == {}
    # Failures outside the window, or the same posting twice, do not add up.
    ledger = {}
    for job_id, at in [(1, '2026-10-29T10:00:00+00:00'), (2, '2026-10-29T20:00:00+00:00'), (2, '2026-10-29T20:05:00+00:00')]:
        sig, _ = fs.note_failure(ledger, job_id=job_id, message='Cannot identify Work Experience Add control',
                                 url='https://a.myworkdayjobs.com/j', at=at, window_minutes=120)
    assert len(ledger[sig]['failures']) == 1 and fs.tripped(ledger[sig], 2) is None


def test_three_identical_failures_hold_the_site_one_repair_runs_and_the_rest_retry_after(runner):
    runner.queue([1, 2, 3])
    sends = []
    desk = SimpleNamespace(processes={}, lock=threading.RLock(), internal_repairs=set())
    def send(job_id, message, internal=False, engine=None, **_):
        sends.append((job_id, message))
        desk.processes[job_id] = object()
    desk.send = send
    runner._repair_desk = desk
    for job_id in (1, 2, 3):
        item = park(runner, job_id, 'failed', message=TIMEOUT.format(n=job_id), url=f'https://acme.wd1.myworkdayjobs.com/x/{job_id}',
                    updated_at='2026-10-29T20:00:00+00:00')
        runner._note_run_failure(item)
    [breaker] = runner.data['breakers']
    assert breaker['scope'] == 'myworkdayjobs.com' and breaker['job_ids'] == [1, 2, 3]
    assert runner.snapshot()['breakers'][0]['signature'] == breaker['signature']
    # A queued Workday role waits; a role on another site still starts.
    waiting = {'job_id': 9, 'url': 'https://zeta.wd3.myworkdayjobs.com/j/1', 'message': ''}
    assert runner._breaker_gate(waiting) and waiting['message'].startswith('Waiting: 3 postings failed the same way')
    assert not runner._breaker_gate({'url': 'https://jobs.lever.co/acme/1'})
    # One repair covers the signature; it is told about the other postings.
    runner._repair_technical_failures(include_approvals=False)
    assert [job_id for job_id, _ in sends] == [1]
    assert 'stopped 3 postings on myworkdayjobs.com' in sends[0][1]
    assert breaker['repair_job_id'] == 1
    others = [j for j in runner.data['jobs'] if j['job_id'] in (2, 3)]
    assert all(j['background_triage']['state'] == 'same_failure' for j in others)
    # The repair ends: the hold lifts and the other two postings are retried once.
    desk.processes.clear()
    runner._update_breakers()
    assert runner.data['breakers'] == []
    retried = {j['job_id']: j for j in runner.data['jobs'] if j['job_id'] in (2, 3)}
    assert all(j['status'] == 'queued' and j['breaker_retried'] for j in retried.values())
    assert runner.data['breaker_history'][-1]['closed_because'] == 'repaired'
    ledger = json.loads((runner.directory / 'failure-signatures.json').read_text())
    assert ledger[breaker['signature']]['failures'] == []


def test_he_can_resume_a_held_site_and_holds_expire(runner):
    runner.data['breakers'] = [{'signature': 'sig', 'class': 'timeout', 'scope': 'icims.com', 'opened_at': '2026-01-01T00:00:00+00:00',
                                'job_ids': [1, 2, 3], 'example': 'x', 'repair_job_id': None, 'message': 'held'}]
    runner._update_breakers()  # opened long ago: past the hold
    assert runner.data['breakers'] == [] and runner.data['breaker_history'][-1]['closed_because'] == 'expired'
    runner.data['breakers'] = [{'signature': 'sig2', 'class': 'timeout', 'scope': 'icims.com', 'opened_at': fs_now(),
                                'job_ids': [1], 'example': 'x', 'repair_job_id': None, 'message': 'held'}]
    assert runner.clear_breaker('sig2')['ok'] and runner.data['breakers'] == []


def fs_now():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def test_a_not_application_run_is_ignored_and_never_taken_by_autoplay_again(runner):
    runner.queue([1])
    item = runner.data['jobs'][0]
    item['status'] = 'running'
    (runner.directory / item['id']).mkdir(parents=True, exist_ok=True)
    (runner.directory / item['id'] / 'state.json').write_text(json.dumps(
        {'status': 'skipped', 'phase': 'skipped', 'not_application': 'contractor_marketplace',
         'message': 'Not an application: mercor.com is a contractor marketplace'}))
    runner._refresh(item)
    assert item['status'] == 'skipped' and item['not_application'] == 'contractor_marketplace'
    assert 1 in runner.data['skipped']
    with runner.sessions() as session:
        assert session.get(Job, 1).status == JobStatus.IGNORED
