from datetime import datetime, timedelta, timezone

from test_application_runner import runner, FakeProcess, add_jobs, park  # noqa: F401
from jobagent.db.models import Job, JobStatus, EligibilityStatus


def test_delayed_explicit_queue_moves_on_to_priority_then_resumes_when_due(runner):
    add_jobs(runner, [(10, 'Priority Co', 'Test Engineer', 'AEROSPACE / VEHICLE', EligibilityStatus.STRONG_MATCH, 90),
                      (11, 'Lower Co', 'Build Engineer', 'AEROSPACE / VEHICLE', EligibilityStatus.STRONG_MATCH, 80)])
    runner.queue([1], position='next')
    delayed = runner.data['jobs'][0]
    delayed['not_before'] = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    runner.data.update(running=True, parallelism=1)
    runner.popen = lambda *args, **kwargs: FakeProcess()
    runner.tick()
    assert delayed['status'] == 'queued'
    first = next(j for j in runner.data['jobs'] if j['id'] in runner.processes)
    assert first['job_id'] == 10
    assert first['source'] == 'autoplay'
    runner.processes.clear()
    first['status'] = 'completed'
    delayed['not_before'] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    runner.tick()
    assert delayed['id'] in runner.processes
    assert not any(j['job_id'] == 11 for j in runner.data['jobs'])


def test_active_recovery_leaves_a_fresh_priority_allowance_with_total_ceiling(runner):
    runner.queue([1, 3])
    recovery, fresh = runner.data['jobs']
    recovery.update(recovery_ready=True, slot=0)
    runner.processes[recovery['id']] = FakeProcess()
    runner.data.update(parallelism=3, slots=['codex'] * 3)
    runner.data['adaptive'] = {'fresh_limit': 1, 'recovery_limit': 2}
    assert runner._free_slot() == 1
    fresh['slot'] = 1
    runner.processes[fresh['id']] = FakeProcess()
    assert runner._free_slot() is None
    assert runner._free_slot(recovery=True) is None
    runner.data['adaptive']['recovery_limit'] = 3
    assert runner._free_slot() is None  # only one fresh application at a time
    assert runner._free_slot(recovery=True) == 2


def test_recent_excludes_applied_manual_submissions_and_ignored_roles_without_erasing_evidence(runner):
    runner.queue([1, 2, 3])
    for item in runner.data['jobs']:
        item.update(status='stopped', message='Old browser handoff')
    with runner.sessions() as session:
        session.get(Job, 1).status = JobStatus.APPLIED
        session.get(Job, 2).status = JobStatus.IGNORED
        session.commit()
    runner.data['running'] = True
    assert [j['job_id'] for j in runner.snapshot()['recent']] == [3]
    assert len(runner.data['jobs']) == 3
    runner.skip(3)
    assert runner.snapshot()['recent'] == []


def test_recent_hides_confirmed_completions_but_retains_pending_receipts(runner):
    runner.queue([1, 2, 3])
    for item, status in zip(runner.data['jobs'], ['completed', 'submitted', 'submitted_pending_receipt']):
        item['status'] = status
    runner.data['running'] = True
    assert [j['job_id'] for j in runner.snapshot()['recent']] == [3]
