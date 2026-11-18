"""Automatic Help diagnoses share a bounded pool and preserve submission guards."""
import json
import threading
from datetime import datetime, timezone
from types import SimpleNamespace
import pytest
from jobagent.services import application_runner as module


@pytest.fixture
def runner(tmp_path, monkeypatch):
    candidate = module.ApplicationRunner.__new__(module.ApplicationRunner)
    candidate.directory = tmp_path / 'runs'
    candidate.directory.mkdir()
    candidate.agent_dir = tmp_path / 'agent'
    (candidate.agent_dir / 'state').mkdir(parents=True)
    (candidate.agent_dir / 'private').mkdir()
    candidate.data = {'jobs':[], 'engine':'codex'}
    candidate.processes = {}
    candidate._cooling = lambda item: False
    candidate._repair_desk = SimpleNamespace(processes={}, lock=threading.RLock(), calls=[])
    def send(job_id, message, internal=False, engine=None, **_):
        candidate._repair_desk.calls.append((job_id, internal))
        candidate._repair_desk.processes[job_id] = object()
    candidate._repair_desk.send = send
    monkeypatch.setattr(module, 'setting', lambda key: 4 if key == 'workers.max_repair_agents' else None)
    return candidate


def add(runner, job_id, **changes):
    item = {'id':f'run-{job_id}', 'job_id':job_id, 'company':f'Employer {job_id}',
            'status':'failed', 'message':'Timeout 30000ms exceeded'}
    item.update(changes)
    runner.data['jobs'].append(item)
    return item


def test_four_distinct_repairs_start_together_with_persistent_attempt_limits(runner):
    for job_id in range(1, 7):
        add(runner, job_id)
    runner._repair_technical_failures()
    assert runner._repair_desk.calls == [(1, True), (2, True), (3, True), (4, True)]
    attempts = json.loads((runner.directory / 'internal-repairs.json').read_text())
    assert len(attempts) == 4
    runner._repair_technical_failures()
    assert len(runner._repair_desk.calls) == 4
    # Rounds two and three: the first four escalate (Opus 5.5, then Fable 5.1) before new jobs start.
    for start in (4, 8):
        runner._repair_desk.processes.clear()
        runner._repair_technical_failures()
        assert runner._repair_desk.calls[start:] == [(1, True), (2, True), (3, True), (4, True)]
    for start in (12, 14, 16):
        runner._repair_desk.processes.clear()
        runner._repair_technical_failures()
        assert runner._repair_desk.calls[start:] == [(5, True), (6, True)]
    # After Sonnet 5.5, Opus 5.5 and Fable 5.1 each tried once, nothing is retried.
    runner._repair_desk.processes.clear()
    runner._repair_technical_failures()
    assert len(runner._repair_desk.calls) == 18
    models = [a.get('model') for a in json.loads((runner.directory / 'internal-repairs.json').read_text())['1']['attempts']]
    assert models == ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']


def test_public_help_agents_consume_budget_and_protect_same_employer(runner):
    add(runner, 1, company='Busy Employer')
    add(runner, 2, company='busy employer')
    for job_id in range(3, 8):
        add(runner, job_id)
    runner._repair_desk.processes[1] = object()  # A user's active Help conversation.
    runner._repair_technical_failures()
    assert runner._repair_desk.calls == [(3, True), (4, True), (5, True)]
    assert len(runner._repair_desk.processes) == 4
    assert 'internal_repair' not in runner.data['jobs'][1]


def test_uncertain_submissions_captchas_unknown_answers_and_claims_never_launch(runner):
    add(runner, 1, submission_attempted=True)
    add(runner, 2)
    (runner.agent_dir/'state/jobagent-2.json').write_text(json.dumps({'status':'submission_unknown'}))
    add(runner, 3)
    (runner.agent_dir/'state/jobagent-3.json').write_text(json.dumps({'status':'failed','submissionAttempted':True}))
    add(runner, 4, message='Timeout 30000ms exceeded; captcha still open')
    add(runner, 5, message='Unknown personal fact: explain why you want this role')
    add(runner, 6, status='needs_approval')
    add(runner, 7)
    add(runner, 8)
    add(runner, 9)
    stamp = datetime.now(timezone.utc).isoformat()
    (runner.agent_dir/'private/agent-coordination.md').write_text(
        f'## Log\n- {stamp} Claude: CLAIM 7 Investigating\n'
        '- 2025-01-01T00:00:00Z Codex: HOLD 8 Awaiting user\n')
    runner._repair_technical_failures()
    # Each approval now receives one initial Codex triage, including an empty-label card.
    assert runner._repair_desk.calls == [(6, False), (9, True)]


def test_an_exhausted_repair_budget_still_requires_manual_diagnosis(runner):
    # The budget is three model attempts (Sonnet 5.5, Opus 5.5, Fable 5.1); a fourth failure goes to him.
    item = add(runner, 1, message='Timeout 90000ms exceeded at the third distinct page')
    (runner.directory/'internal-repairs.json').write_text(json.dumps({'1':{'attempts':[
        {'failure':f'Timeout {n}ms exceeded'} for n in [10000,20000,30000]]}}))
    runner._repair_technical_failures()
    assert not runner._repair_desk.calls
    assert 'internal_repair' not in item
    assert item['background_triage']['state'] == 'technical_exhausted'


@pytest.mark.parametrize('message', [
    'Preparation reached its step limit. Review the saved view before continuing.',
    'Workday stopped: stayed on Application Questions 2 of 2: Errors Found Please review the required fields.',
    'Workday stopped: stayed on Application Questions',
    'Workday stopped: stayed on Application Questions: Errors Found A required field is missing',
    'Required fields still need answers: If "N/A Other Location" selected above, please explain*',
    'Workday sign-in: sign-in did not complete',
    'Required fields still need answers: If N/A Other Location selected above please explain',
    'Workday stopped: stayed on Application Questions: Errors Found Please review required fields.',
    'Workday stopped: stayed on Self Identify: Errors Found Please review the required fields.',
])
def test_observed_preparation_errors_receive_diagnosis_without_blind_retry(runner, message):
    add(runner, 1, message=message)
    runner._repair_technical_failures()
    assert runner._repair_desk.calls == [(1, True)]
    assert runner.data['jobs'][0]['status'] == 'failed'


@pytest.mark.parametrize('message', [
    'Workday stopped: stayed on Application Questions 2 of 2: Errors Found CAPTCHA verification required',
    'Workday stopped: stayed on Self Identify: Errors Found unknown personal information',
    'Workday sign-in: sign-in did not complete. No saved password',
    'Preparation reached its step limit. Review the saved view before continuing. Verification code required',
    'Required fields still need answers: Explain why you want to work here',
])
def test_new_preparation_diagnoses_preserve_human_and_unknown_fact_boundaries(runner, message):
    add(runner, 1, message=message)
    runner._repair_technical_failures()
    assert runner._repair_desk.calls == []
