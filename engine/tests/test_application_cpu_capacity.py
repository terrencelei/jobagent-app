"""Current macOS CPU use and preserved facts on safe preparation retry."""
from types import SimpleNamespace
import pytest
from jobagent.services import application_runner as module
from test_application_runner import runner, park


def test_high_lagging_load_with_idle_cpu_permits_capacity_but_keeps_memory_limit(runner, monkeypatch):
    monkeypatch.setattr(module.time, 'monotonic', lambda: 1000)
    runner.processes.update(a=object(), b=object())
    runner._resource_sample = (1000, 5 * 1024**3, 57, 10, 2)
    calls = []
    monkeypatch.setattr(runner, '_current_cpu_idle', lambda: calls.append(1) or 67)
    assert runner._resource_capacity(20) == 8  # Two active plus six spare memory slots.
    assert runner._resource_capacity(20) == 8
    assert calls == [1]
    runner._resource_sample = (1001, 1024**3, 57, 10, 2)
    assert runner._resource_capacity(20) == 2  # Idle CPU cannot waive the memory reserve.
    assert len(calls) == 2


@pytest.mark.parametrize('idle', [None, 0, 29.9])
def test_busy_or_unknown_cpu_retains_conservative_hold(runner, monkeypatch, idle):
    monkeypatch.setattr(module.time, 'monotonic', lambda: 1000)
    runner.processes['active'] = object()
    runner._resource_sample = (1000, 16 * 1024**3, 57, 10, 1)
    monkeypatch.setattr(runner, '_current_cpu_idle', lambda: idle)
    assert runner._resource_capacity(20) == 1


def test_mac_cpu_probe_uses_last_sample_and_handles_failures(monkeypatch):
    monkeypatch.setattr(module.sys, 'platform', 'darwin')
    calls = []
    def run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0, stdout='CPU usage: 90% user, 5% sys, 5% idle\nCPU usage: 20% user, 12% sys, 68% idle\n')
    monkeypatch.setattr(module.subprocess, 'run', run)
    assert module.ApplicationRunner._current_cpu_idle() == 68
    assert calls[0][0] == ['/usr/bin/top', '-l', '2', '-n', '0', '-s', '1']
    assert calls[0][1]['timeout'] == 3
    monkeypatch.setattr(module.subprocess, 'run', lambda *a, **kw: SimpleNamespace(returncode=0, stdout='unavailable'))
    assert module.ApplicationRunner._current_cpu_idle() is None
    def timeout(*args, **kwargs):
        raise module.subprocess.TimeoutExpired('top', 3)
    monkeypatch.setattr(module.subprocess, 'run', timeout)
    assert module.ApplicationRunner._current_cpu_idle() is None
    monkeypatch.setattr(module.sys, 'platform', 'linux')
    monkeypatch.setattr(module.subprocess, 'run', lambda *a, **kw: pytest.fail('Linux must retain the existing load fallback'))
    assert module.ApplicationRunner._current_cpu_idle() is None


def test_safe_retry_retains_approved_facts_and_preparation_mode(runner):
    runner.queue([1])
    item = park(runner, 1, 'stopped', approved_answers=[{'question': 'OPT status', 'answer': 'Not applicable'}],
                recovery_ready=True, prepare_manually=True)
    old_id = item['id']
    runner.command(1, 'retry')
    assert item['status'] == 'queued' and item['id'] != old_id
    assert item['approved_answers'] == [{'question': 'OPT status', 'answer': 'Not applicable'}]
    assert item['recovery_ready'] and item['prepare_manually']
    # A durable unresolved submission still blocks retry before any saved facts are changed.
    item['status'] = 'stopped'
    module.atomic(runner.agent_dir / 'state/jobagent-1.json', {'status': 'submitted_pending_receipt'})
    with pytest.raises(ValueError, match='unresolved submission'):
        runner.command(1, 'retry')
    assert item['approved_answers'][0]['answer'] == 'Not applicable'


def test_explicit_play_next_precedes_new_recovery_inserts_within_resource_limit(runner, monkeypatch):
    monkeypatch.setattr(module.time, 'monotonic', lambda: 1000)
    monkeypatch.setattr(runner, '_resource_capacity', lambda configured: 1)
    runner.data.update(running=True, parallelism=20, slots=['codex'] * 20)
    runner._adaptive_started = 0
    runner.data['autoplay']['enabled'] = False
    runner.queue([1,3])
    runner.move(1, 0)
    # A newly approved item inserts ahead in durable order after Play next was set.
    park(runner, 3, 'needs_approval', questions=[{'label': 'Start', 'required': True}])
    runner.approve_answers(3, {'Start': 'June 2027'})
    assert [j['job_id'] for j in runner.data['jobs']] == [3,1]
    runner.popen = lambda *args, **kwargs: type('Process', (), {'pid': 99999999, 'poll': lambda self: None})()
    runner.tick()
    active = [j for j in runner.data['jobs'] if j['id'] in runner.processes]
    assert [j['job_id'] for j in active] == [1]
    assert 'explicit_next' not in active[0]
    assert next(j for j in runner.data['jobs'] if j['job_id'] == 3)['status'] == 'queued'


def test_play_next_flag_is_set_through_queue_and_cleared_when_moved_away(runner):
    runner.queue([1,3])
    runner.queue([1], position='next')
    assert next(j for j in runner.data['jobs'] if j['job_id'] == 1)['explicit_next']
    runner.move(1, 1)
    assert 'explicit_next' not in next(j for j in runner.data['jobs'] if j['job_id'] == 1)
