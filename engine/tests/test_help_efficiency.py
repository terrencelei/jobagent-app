import json
from jobagent.services.assist import AssistDesk
from test_application_runner import runner, FakeChatProcess, park, wait_idle  # noqa: F401


def test_resumed_help_uses_current_delta_instead_of_repeating_rules(runner):
    runner.queue([1]);item = park(runner, 1, 'blocked', message='An unfamiliar dropdown failed')
    prompts = []
    # Capture stdin before the pump closes it.
    class Capture:
        def write(self, text): prompts.append(text)
        def close(self): pass
        def flush(self): pass
    def popen(*args, **kwargs):
        p = FakeChatProcess([json.dumps({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'Diagnosed.'}]}})])
        p.stdin = Capture()
        return p
    desk = AssistDesk(runner, cli_resolver=lambda _: '/fixture/claude', popen=popen)
    desk.send(1, 'Inspect this failure');wait_idle(desk, 1)
    desk.send(1, 'Continue your diagnosis');wait_idle(desk, 1)
    assert len(prompts) == 2
    assert 'application_dossier.py' in prompts[0]
    assert 'Current posting update' in prompts[1]
    assert 'An unfamiliar dropdown failed' in prompts[1]
    assert 'Continue your diagnosis' in prompts[1]
    assert 'submission guards still apply' in prompts[1]
    assert len(prompts[1]) < len(prompts[0]) / 3


def test_answer_suggestions_reuse_subprocess_result_and_invalidate_confirmed_sources(runner, monkeypatch):
    from types import SimpleNamespace
    from jobagent.services import application_runner as module
    tools = runner.agent_dir / 'tools';tools.mkdir()
    (tools / 'answer-memory.mjs').write_text('// fixture')
    profile = runner.agent_dir / 'private/profile.json';profile.write_text('{}')
    calls = []
    def run(*args, **kwargs):
        calls.append(kwargs['input'])
        return SimpleNamespace(returncode=0, stdout='[{"job_id":1,"facts":{}}]')
    monkeypatch.setattr(module.subprocess, 'run', run)
    payload = {'action':'suggest', 'items':[{'id':'run-1','job_id':1,'questions':[{'label':'School?'}]}]}
    assert runner._answer_memory(payload) == runner._answer_memory(payload)
    assert len(calls) == 1
    profile.write_text('{"new":"confirmed fact"}')
    runner._answer_memory(payload)
    assert len(calls) == 2
    # Learning/writes must execute each time, even with identical arguments.
    runner._answer_memory({'action':'learn'});runner._answer_memory({'action':'learn'})
    assert len(calls) == 4
