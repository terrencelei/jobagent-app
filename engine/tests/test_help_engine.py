from datetime import datetime, timedelta, timezone
import json
import json
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jobagent.services.assist import AssistDesk
from jobagent.ui import application_routes
from test_application_runner import runner, FakeProcess  # noqa: F401 (fixture)


def test_application_runs_use_the_dashboard_model_even_when_a_help_chat_is_pinned(runner):
    # One dashboard model policy drives every worker; a Help-chat engine pin no longer changes the run.
    runner.queue([1])
    item = runner.data['jobs'][0]
    runner.data.update(engine='codex', model='gpt-6.1-sol')
    runner.data['slots'] = ['codex'] * len(runner.data['slots'])
    runner.popen = lambda *args, **kwargs: FakeProcess()
    runner.set_agent_engine(1, 'claude', 'claude-fable-5-1')
    runner._launch(item)
    request = json.loads((runner.directory / item['id'] / 'request.json').read_text())
    assert (request['engine'], request['model']) == ('codex', 'gpt-6.1-sol')
    with pytest.raises(ValueError, match='claude or codex'):
        runner.set_agent_engine(1, 'gpt')
    with pytest.raises(ValueError, match='no longer'):
        runner.set_agent_engine(3, 'claude')
    with pytest.raises(ValueError, match='Unknown Claude model'):
        runner.set_agent_engine(1, 'claude', 'gpt-6.1-sol')


def test_switching_the_help_agent_keeps_the_old_session_and_refuses_while_busy(runner, tmp_path):
    runner.queue([1])
    desk = AssistDesk(runner)
    desk.directory = tmp_path / 'chats'; desk.directory.mkdir()
    log = desk.chat(1); log.update(engine='codex', session='abc'); desk._save(log)
    switched = desk.switch_engine(1, 'claude')
    assert switched['engine'] == 'claude' and switched['session'] is None
    assert switched['prior_sessions'] == [{'engine': 'codex', 'model': None, 'session': 'abc'}]
    desk.processes[1] = FakeProcess()
    with pytest.raises(ValueError, match='still working'):
        desk.switch_engine(1, 'codex')


def test_engine_route_validates_and_records_the_choice(runner, tmp_path, monkeypatch):
    runner.queue([1])
    desk = AssistDesk(runner)
    desk.directory = tmp_path / 'chats'; desk.directory.mkdir()
    monkeypatch.setattr(application_routes, 'get_runner', lambda: runner)
    monkeypatch.setattr(application_routes, 'get_desk', lambda: desk)
    app = FastAPI(); app.include_router(application_routes.router)
    client = TestClient(app)
    headers = {'X-JobAgent-Application': '1'}
    prefix = application_routes.router.prefix
    assert client.post(f'{prefix}/help/1/engine', json={'engine': 'claude'}, headers=headers).json()['agent_engine'] == 'claude'
    assert runner.data['jobs'][0]['agent_engine'] == 'claude' and desk.chat(1)['engine'] == 'claude'
    assert client.post(f'{prefix}/help/1/engine', json={'engine': 'gpt'}, headers=headers).status_code == 422


def test_help_agents_run_sonnet_5_5_by_default_and_fable_5_1_when_escalated(runner):
    import json as _json
    from test_application_runner import FakeChatProcess, park, wait_idle
    runner.queue([1]); park(runner, 1, 'blocked', message='An unfamiliar dropdown failed')
    seen = []
    def popen(args, **kwargs):
        seen.append(args)
        return FakeChatProcess([_json.dumps({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'Done.'}]}})])
    desk = AssistDesk(runner, cli_resolver=lambda _: '/fixture/claude', popen=popen)
    desk.send(1, 'Inspect this failure', engine='claude'); wait_idle(desk, 1)
    assert seen[0][seen[0].index('--model') + 1] == 'claude-sonnet-5-5'
    log = desk.chat(1); log.update(session=None, model=None); desk._save(log)
    desk.send(1, 'Second attempt', engine='claude', model='claude-fable-5-1'); wait_idle(desk, 1)
    assert seen[1][seen[1].index('--model') + 1] == 'claude-fable-5-1'


def test_reconcile_keeps_a_rule_rejected_posting_he_marked_as_a_fit(runner):
    from jobagent.db.models import Job, EligibilityStatus
    from test_application_runner import park
    runner.queue([1]); park(runner, 1, 'needs_human', message='Stopped')
    with runner.sessions() as session:
        job = session.get(Job, 1); job.eligibility = EligibilityStatus.INELIGIBLE
        job.user_fit_label = {'mechanical': {'fit': True, 'note': 'He asked to apply'}}; session.commit()
    result = runner.reconcile_help([1])
    assert 1 not in result['skipped'] and runner.data['jobs'][0]['status'] != 'skipped'



def test_ready_to_submit_items_submit_automatically_without_a_button(runner, monkeypatch):
    import jobagent.services.application_runner as module
    original = module.setting
    monkeypatch.setattr(module, 'setting', lambda key, *a: True if key == 'workers.auto_submit' else original(key, *a))
    runner.queue([1])
    item = runner.data['jobs'][0]
    item.update(status='ready_to_submit', review={'digest': 'abc'})
    runner._auto_submit_ready()
    item = next(j for j in runner.data['jobs'] if j['job_id'] == 1)
    assert item['status'] == 'queued' and item.get('submit') is True and item.get('approved_digest') == 'abc'


def test_an_explicit_queue_request_revives_a_skipped_role(runner):
    runner.queue([1]); item = runner.data['jobs'][0]
    item.update(status='skipped', message='Resolved: outside the current search')
    runner.queue([1], 'next')
    assert next(j for j in runner.data['jobs'] if j['job_id'] == 1)['status'] == 'queued'


def test_usage_pause_stops_new_applications_at_his_limit_and_resumes_after_reset(runner, monkeypatch):
    import jobagent.services.application_runner as module
    original = module.setting
    limit = {'value': 80}
    monkeypatch.setattr(module, 'setting', lambda key, *a: limit['value'] if key == 'workers.usage_pause_percent' else original(key, *a))
    runner.data['running'] = True

    def check():  # The probe runs on its own thread; its reading applies on the next tick.
        runner._usage_checked = float('-inf')
        runner._usage_pause()
        if getattr(runner, '_usage_thread', None):
            runner._usage_thread.join()
        runner._usage_pause()
    limits = runner.agent_dir / 'state' / 'model-limits.json'
    def claude_mark():
        return json.loads(limits.read_text()).get('engines', {}).get('claude') if limits.exists() else None
    # At his limit Claude is marked for application-agent's agy fallback; workers keep running (2026-10-24).
    runner._claude_usage = lambda: {'five_hour': 0.83, 'seven_day': 0.40}
    runner._usage_resets = {'five_hour': '2026-10-24T23:00:00+00:00'}
    check()
    assert runner.data['running'] is True and not runner.data.get('auto_stop_reason')
    assert claude_mark()['until'] == '2026-10-24T23:00:00+00:00' and 'Claude usage 83%' in claude_mark()['message']
    runner._claude_usage = lambda: {'five_hour': 0.10, 'seven_day': 0.40}
    check()
    assert runner.data['running'] is True and claude_mark() is None
    # Off (0) never pauses; a pause he set by hand is never undone by the usage check.
    limit['value'] = 0; runner._claude_usage = lambda: {'five_hour': 0.99}
    check(); assert runner.data['running'] is True
    limit['value'] = 80; runner.data.update(running=False, auto_stop_reason=None, resume_after_usage=False)
    runner._claude_usage = lambda: {'five_hour': 0.10}
    check(); assert runner.data['running'] is False


def test_auto_stop_form_sets_the_usage_limit_and_reports_it(runner):
    from jobagent.settings import setting
    snap = runner.configure_auto_stop(0, 0, 80)
    assert setting('workers.usage_pause_percent') == 80 and snap['usage_pause_percent'] == 80
    runner.configure_auto_stop(0, 0)  # Older clients that omit usage keep his limit.
    assert setting('workers.usage_pause_percent') == 80
    import pytest
    with pytest.raises(ValueError):
        runner.configure_auto_stop(0, 0, 101)


def test_a_role_held_for_alex_stays_on_help_until_he_releases_it(runner):
    from test_application_runner import park
    runner.queue([1]); park(runner, 1, 'failed', message='claude did not answer within 180s')
    runner.hold_for_user(1, 'Choose how IBMid should do two-step sign-in.')
    item = runner.data['jobs'][0]
    assert item['status'] == 'needs_human' and item['held_for_user'] and item['message'].startswith('Waiting on Alex: Choose')
    assert any(h['job_id'] == 1 for h in runner.help_items())
    assert runner.reconcile_help([1])['requeued'] == [] and runner.data['jobs'][0]['status'] == 'needs_human'
    runner.retry_parked(1)  # His Retry releases it.
    assert runner.data['jobs'][0]['status'] == 'queued' and not runner.data['jobs'][0].get('held_for_user')
    with pytest.raises(ValueError):
        runner.hold_for_user(1, '')


def test_a_usage_pause_lifts_and_starts_the_worker_loop_after_a_restart(runner, monkeypatch):
    import jobagent.services.application_runner as module
    original = module.setting
    monkeypatch.setattr(module, 'setting', lambda key, *a: 60 if key == 'workers.usage_pause_percent' else original(key, *a))
    started = []
    monkeypatch.setattr(module.threading.Thread, 'start', lambda self: started.append(self.name))
    runner.thread = None
    runner.data.update(running=False, resume_after_usage=True,
                       auto_stop_reason='Claude usage 61% (seven-day window) reached your 60% pause limit')
    runner._usage_result = {'five_hour': 0.1, 'seven_day': 0.5}
    runner._usage_pause()
    assert runner.data['running'] is True and 'application-runner' in started


def test_workers_paused_by_the_old_usage_rule_carry_on_with_agy(runner, monkeypatch):
    import jobagent.services.application_runner as module
    original = module.setting
    monkeypatch.setattr(module, 'setting', lambda key, *a: 80 if key == 'workers.usage_pause_percent' else original(key, *a))
    monkeypatch.setattr(module.threading.Thread, 'start', lambda self: None)
    runner.thread = None
    runner.data.update(running=False, resume_after_usage=True,
                       auto_stop_reason='Claude usage 84% (seven-day window) reached your 80% pause limit')
    runner._usage_result = {'five_hour': 0.05, 'seven_day': 0.84}
    runner._usage_pause()
    assert runner.data['running'] is True and runner.data['claude_on_agy'].startswith('Claude usage 84%')


def test_the_applications_page_shows_which_agy_model_a_worker_uses(runner):
    from test_application_runner import park
    stamp = (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()
    limits = runner.agent_dir / 'state' / 'model-limits.json'
    limits.parent.mkdir(parents=True, exist_ok=True)
    limits.write_text(json.dumps({'engines': {'claude': {'until': stamp, 'message': 'Claude usage limit reached.'}},
                                  'agy': {'claude-opus-4-6-thinking': {'until': stamp}, 'gone': {'until': '2020-01-01T00:00:00+00:00'}}}))
    snap = runner.snapshot()
    assert set(snap['agy_fallback']['engines']) == {'claude'}
    assert set(snap['agy_fallback']['agy_limited']) == {'claude-opus-4-6-thinking'}   # expired entries are dropped
    runner.queue([1]); item = runner.data['jobs'][0]
    (runner.directory / item['id']).mkdir(parents=True, exist_ok=True)
    (runner.directory / item['id'] / 'state.json').write_text(json.dumps({'status': 'running', 'phase': 'reading', 'ai_model': 'agy:gemini-3.8-flash-low'}))
    runner._refresh(item)
    assert item['ai_model'] == 'agy:gemini-3.8-flash-low'
    order = runner.agent_dir / 'state' / 'agy-models.json'
    order.write_text(json.dumps({'order': ['gemini-3.8-flash-low', 'claude-opus-4-6-thinking']}))
    snap = runner.snapshot()['agy_fallback']
    assert snap['agy_left'] == 1 and snap['agy_models'] == ['gemini-3.8-flash-low', 'claude-opus-4-6-thinking']
    assert snap['agy_exhausted'] is False and snap['agy_next'] is None
    soon = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    limits.write_text(json.dumps({'engines': {'claude': {'until': stamp}},
                                  'agy': {'claude-opus-4-6-thinking': {'until': stamp}, 'gemini-3.8-flash-low': {'until': soon}}}))
    snap = runner.snapshot()['agy_fallback']
    assert snap['agy_exhausted'] is True and snap['agy_left'] == 0 and snap['agy_next'] == soon   # all used up: first one back
    limits.write_text('{}')
    assert runner.snapshot()['agy_fallback'] is None


def test_agy_can_be_chosen_for_a_worker_or_all_workers(runner):
    import pytest
    runner.data['parallelism'] = 2; runner._fit_slots()
    snap = runner.set_slot_engine(1, 'agy')
    assert snap['slots'][1]['engine'] == 'agy' and snap['engines']['agy'] == 'agy'
    with pytest.raises(ValueError):
        runner.set_slot_engine(0, 'gemini')
    with pytest.raises(ValueError):            # Help chats and repair agents stay on Claude or Codex
        runner.set_agent_engine(1, 'agy')
    assert runner._model('agy') is None
