from test_application_runner import runner, park  # noqa: F401
from jobagent.services.application_runner import atomic


def test_earned_reset_prevents_limit_pause_and_is_exposed_safely(runner, monkeypatch):
    from jobagent.services import codex_usage
    calls = []
    monkeypatch.setattr(codex_usage, 'try_weekly_reset', lambda *args: calls.append(args) or {'status': 'reset', 'resumed': True, 'available_count': 2, 'limits': {'secret': 'never expose'}})
    runner.queue([1]); runner.data['running'] = True
    item = park(runner, 1, 'failed', engine='codex', message='Weekly usage limit reached')
    assert runner._record_model_limit(item)
    assert runner.data['running']
    assert runner.data['weekly_reset']['status'] == 'reset'
    assert 'limits' not in runner.data['weekly_reset']
    runner._recover_model_limited_jobs()
    assert runner.data['jobs'][0]['status'] == 'queued'


def test_no_credit_pauses_and_polling_does_not_spend_repeatedly(runner, monkeypatch):
    from jobagent.services import codex_usage
    calls = []
    monkeypatch.setattr(codex_usage, 'try_weekly_reset', lambda *args: calls.append(args) or {'status': 'no_credit', 'resumed': False})
    runner.queue([1]); runner.data['running'] = True
    item = park(runner, 1, 'failed', engine='codex', message='Weekly usage limit reached')
    runner._record_model_limit(item); runner._record_model_limit(item)
    assert len(calls) == 1
    assert not runner.data['running'] and runner.data['resume_after_limit']


def test_model_recovery_preserves_submission_uncertainty(runner):
    runner.queue([1, 3])
    park(runner, 1, 'failed', engine='codex', message='Weekly usage limit reached', submission_attempted=True)
    item = park(runner, 3, 'failed', engine='codex', message='Weekly usage limit reached')
    atomic(runner.agent_dir / 'state/jobagent-3.json', {'submissionAttempted': True})
    runner._recover_model_limited_jobs()
    assert all(j['status'] == 'failed' for j in runner.data['jobs'])


def test_manual_stop_cancels_scheduled_limit_resume(runner):
    runner.data['resume_after_limit'] = True
    runner.control('stop')
    assert not runner.data['resume_after_limit']
