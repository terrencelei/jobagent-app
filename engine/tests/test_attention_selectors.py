from test_application_runner import runner  # noqa: F401
from jobagent.db.models import Job, EligibilityStatus, JobStatus


def test_known_answer_selection_keeps_other_claimed_jobs_out(runner, monkeypatch):
    runner.queue([1, 3])
    for item in runner.data['jobs']:
        item['status'] = 'needs_approval'
    seen = []
    monkeypatch.setattr(runner, '_answer_memory', lambda payload: seen.append([j['job_id'] for j in payload['items']]) or [])
    runner.resolve_known_approvals([3])
    runner.resolve_known_approvals([])
    assert seen == [[3], []]


def test_help_selection_and_empty_selection_do_not_modify_other_jobs(runner):
    runner.queue([1, 3])
    for item in runner.data['jobs']:
        item['status'] = 'needs_human'
    with runner.sessions() as session:
        for job_id in [1, 3]:
            session.get(Job, job_id).status = JobStatus.CLOSED  # only closed postings leave
        session.commit()
    assert runner.reconcile_help([])['skipped'] == []
    assert runner.reconcile_help([3])['skipped'] == [3]
    assert next(j for j in runner.data['jobs'] if j['job_id'] == 1)['status'] == 'needs_human'
