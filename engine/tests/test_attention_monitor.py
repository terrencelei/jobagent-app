import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('attention_monitor', Path(__file__).parents[1] / 'tools/monitor_application_attention.py')
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


def test_monitor_uses_only_known_fact_and_evidence_reconciliation():
    calls = []
    def api(method, path, body=None):
        calls.append((method, path))
        if not path:
            return {'running': True, 'counts': {'approvals': 1, 'help': 1}}
        if method == 'POST':
            return {'resolved': []}
        return {'items': [{'job_id': 1, 'company': 'Example', 'status': 'needs_human', 'message': 'CAPTCHA'}],
                'approvals': [{'job_id': 2, 'status': 'needs_approval', 'message': 'Unknown personal fact'}]}
    result = monitor.monitor_pass(api)
    assert [path for method, path in calls if method == 'POST'] == ['/approvals/resolve-known', '/help/reconcile']
    assert len(result['pending']) == 2
    assert not result['errors']


def test_monitor_respects_pause_and_continues_after_a_resolution_error():
    for running in [False, True]:
        calls = []
        def api(method, path, body=None):
            calls.append((method, path))
            if not path:
                return {'running': running, 'counts': {'approvals': 1, 'help': 1}}
            if path == '/approvals/resolve-known':
                raise RuntimeError('answer memory unavailable')
            return {'items': [], 'approvals': []}
        result = monitor.monitor_pass(api)
        posts = [path for method, path in calls if method == 'POST']
        assert posts == (['/approvals/resolve-known', '/help/reconcile'] if running else [])
        assert len(result['errors']) == (1 if running else 0)


def test_partner_claim_blocks_only_its_category_and_expires():
    from datetime import datetime, timezone
    now = datetime(2026, 10, 16, 5, 0, tzinfo=timezone.utc)
    text = '''## Log
- 2026-10-16T04:40Z Claude: CLAIM 1 (Example)
- 2026-10-16T04:20Z Codex: CLAIM 2 (Expired)
- 2026-10-16T04:50Z Claude: CLAIM 3 (Completed)
- 2026-10-16T04:51Z Claude: DONE 3
'''
    claims = monitor.active_claims(text, now)
    assert set(claims) == {1}
    posts = []
    def api(method, path, body=None):
        if not path:
            return {'running': True, 'counts': {'help': 1, 'approvals': 1}}
        if method == 'POST':
            posts.append(path)
            return {}
        return {'items': [{'job_id': 2}], 'approvals': [{'job_id': 1}]}
    result = monitor.monitor_pass(api, claims)
    assert posts == ['/help/reconcile']
    assert result['held_for_partner'] == [{'category': 'approvals', 'job_ids': [1]}]


def test_waiting_on_user_holds_do_not_expire_and_future_claims_are_not_stolen():
    from datetime import datetime, timezone
    now = datetime(2026, 10, 16, 5, 0, tzinfo=timezone.utc)
    text = '''## Log
- 2026-10-15T01:00Z Claude: HOLD 1 awaiting user address
- 2026-10-16T05:10Z Claude: CLAIM 2 clock discrepancy
- 2026-10-15T01:00Z Claude: HOLD 3 done
- 2026-10-16T04:59Z Codex: DONE 3
'''
    assert set(monitor.active_claims(text, now)) == {1, 2}


def test_claimed_item_does_not_block_other_items_in_category():
    posts = []
    def api(method, path, body=None):
        if not path:
            return {'running': True, 'counts': {'approvals': 2, 'help': 0}}
        if method == 'POST':
            posts.append((path, body)); return {}
        return {'approvals': [{'job_id': 1}, {'job_id': 2}]}
    result = monitor.monitor_pass(api, {1: {'owner': 'Codex'}})
    assert posts == [('/approvals/resolve-known', {'job_ids': [2]})]
    assert result['held_for_partner'] == [{'category': 'approvals', 'job_ids': [1]}]
    assert result['interval_seconds'] == 20


def test_monitor_recovers_available_quota_without_forcing_a_manual_start(monkeypatch):
    monkeypatch.setattr(monitor, 'restore_weekly_capacity', lambda state: {'status': 'reset', 'resumed': True})
    calls = []
    def api(method, path, body=None):
        calls.append((method, path))
        return {'running': False, 'counts': {}, 'engine_status': {'status': 'usage_limited'}}
    result = monitor.monitor_pass(api, {})
    assert [path for method, path in calls if method == 'POST'] == ['/retry-engine-limits']
    assert result['actions']['weekly_reset']['resumed']
    assert not result['running']


def test_monitor_does_not_retry_when_quota_is_still_exhausted(monkeypatch):
    monkeypatch.setattr(monitor, 'restore_weekly_capacity', lambda state: {'status': 'no_credit', 'resumed': False})
    calls = []
    def api(method, path, body=None):
        calls.append((method, path)); return {'running': False, 'counts': {}}
    result = monitor.monitor_pass(api, {})
    assert not any(method == 'POST' for method, path in calls)
    assert result['actions']['weekly_reset']['status'] == 'no_credit'


def test_quota_repair_recovery_is_bounded_and_preserves_verification(tmp_path):
    calls = []
    rows = [{'job_id': 1, 'message': 'Preparation reached its step limit', 'chat': {'busy': False}},
            {'job_id': 2, 'message': 'CAPTCHA verification', 'chat': {'busy': False}},
            {'job_id': 3, 'message': 'Sign-in did not complete', 'chat': {'busy': True}}]
    def api(method, route, body=None):
        calls.append((method, route))
        if route == '/help': return {'items': rows}
        return {'engine': 'codex', 'busy': False, 'messages': [{'role': 'error', 'text': 'Weekly usage limit reached', 'time': '2026-10-16T05:00Z'}]}
    state = {'running': True, 'counts': {'help': 3}}
    path = tmp_path / 'recovery.json'
    assert monitor.recover_quota_repairs(api, state, {'resumed': True}, path=path, maximum=2) == [1]
    assert monitor.recover_quota_repairs(api, state, {'resumed': True}, path=path, maximum=2) == []
    assert [route for method, route in calls if method == 'POST'] == ['/help/1/chat']
    assert monitor.recover_quota_repairs(api, {'running': False}, {'resumed': True}, path=path, maximum=2) == []


def test_quota_recovery_includes_approval_agents_and_respects_shared_capacity(tmp_path):
    calls = []
    active = {'active': 1, 'agents': [{'job_id': 8}]}
    def api(method, route, body=None):
        calls.append((method, route))
        if route == '/help': return {'items': []}
        if route == '/approvals': return {'approvals': [{'job_id': 9, 'status': 'needs_approval', 'message': 'New questions'}]}
        if route == '/background-agents': return active
        return {'engine': 'codex', 'busy': False, 'messages': [{'role': 'error', 'text': 'Weekly usage limit reached', 'time': '2026-10-16T05:00Z'}]}
    state = {'running': True, 'counts': {'approvals': 1, 'help': 0}}
    path = tmp_path / 'recovery.json'
    assert monitor.recover_quota_repairs(api, state, {'resumed': True}, path=path, maximum=1) == []
    assert monitor.recover_quota_repairs(api, state, {'resumed': True}, path=path, maximum=2) == [9]
    assert [route for method, route in calls if method == 'POST'] == ['/help/9/chat']
