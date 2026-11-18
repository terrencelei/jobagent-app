import json
import pytest
from test_application_runner import runner, FakeProcess  # noqa: F401
from jobagent.db import Job


@pytest.mark.parametrize('workday', [False, True])
def test_unattended_workers_force_headless_and_cannot_inherit_a_manual_browser(runner, monkeypatch, workday):
    monkeypatch.setenv('APPLICATION_AGENT_HEADED', '1')
    monkeypatch.setenv('WORKDAY_CDP', 'http://127.0.0.1:9222')
    if workday:
        with runner.sessions() as session:
            job = session.get(Job, 1)
            job.canonical_url = job.application_url = 'https://fixture.myworkdayjobs.com/Jobs/job/Engineer_JR123'
            session.commit()
    runner.queue([1]);item = runner.data['jobs'][0];calls = []
    runner.popen = lambda args, **kwargs: calls.append((args, kwargs)) or FakeProcess()
    runner._launch(item)
    request = json.loads((runner.directory / item['id'] / 'request.json').read_text())
    assert request['headlessOnly'] is True
    assert calls[0][1]['env']['APPLICATION_AGENT_HEADED'] == '0'
    assert 'WORKDAY_CDP' not in calls[0][1]['env']
    assert calls[0][0][1].endswith('dashboard-workday.mjs' if workday else 'dashboard-worker.mjs')
    # This changes the child's environment, never the user's explicit manual tools.
    import os
    assert os.environ['APPLICATION_AGENT_HEADED'] == '1'
