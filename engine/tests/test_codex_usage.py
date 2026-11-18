"""Earned reset redemption is conditional, durable and safe under worker bursts."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import pytest
from jobagent.services.codex_usage import try_weekly_reset, read_rate_limits


def snapshot(percent=100, duration=10080, credits=3):
    bucket = {'limitId':'codex','primary':{'usedPercent':percent,'windowDurationMins':duration,'resetsAt':1900000000}}
    return {'accountId':'fixture-account','rateLimits':bucket,'rateLimitsByLimitId':{'codex':bucket},
            'rateLimitResetCredits':{'availableCount':credits,'credits':[]}}


class FakeRPC:
    def __init__(self, service):
        self.service = service
    def __enter__(self): return self
    def __exit__(self,*args): return False
    def request(self, method, params=None):
        self.service['calls'].append((method,deepcopy(params)))
        if method == 'account/rateLimits/read':
            return deepcopy(self.service['snapshot'])
        assert method == 'account/rateLimitResetCredit/consume'
        key = params['idempotencyKey']
        self.service['keys'].append(key)
        assert params.keys() == {'idempotencyKey'}  # Earned-reset API only; never a paid action.
        if self.service.get('fail_once'):
            self.service['fail_once'] = False
            raise TimeoutError('uncertain network result')
        outcome = self.service.get('outcome','reset')
        if outcome in {'reset','alreadyRedeemed'}:
            self.service['snapshot'] = self.service.get('reset_snapshot', snapshot(percent=0,credits=2))
        return {'outcome':outcome}


def service(**kwargs):
    return {'snapshot':snapshot(), 'calls':[], 'keys':[], **kwargs}


def test_live_exhaustion_and_earned_balance_are_required(tmp_path):
    for limits in [snapshot(percent=99),snapshot(duration=0),snapshot(credits=0),
                   {'rateLimits':{},'rateLimitResetCredits':{'availableCount':3}}]:
        state = service(snapshot=limits)
        result = try_weekly_reset(tmp_path,'fixture',rpc_factory=lambda command:FakeRPC(state))
        assert result['resumed'] == (limits.get('rateLimits',{}).get('primary',{}).get('usedPercent') == 99)
        assert not state['keys']


def test_success_consumes_once_and_rereads_limits(tmp_path):
    state = service()
    result = try_weekly_reset(tmp_path,'fixture',rpc_factory=lambda command:FakeRPC(state))
    assert result['status'] == 'reset' and result['resumed']
    assert result['available_count'] == 2
    assert [method for method,_ in state['calls']] == ['account/rateLimits/read','account/rateLimitResetCredit/consume','account/rateLimits/read']
    stored = json.loads((tmp_path/'codex-earned-resets.json').read_text())
    assert len(stored['attempts']) == 1
    assert next(iter(stored['attempts'].values()))['idempotency_key'] == state['keys'][0]


def test_worker_burst_uses_one_earned_reset(tmp_path):
    state = service()
    factory = lambda command:FakeRPC(state)
    with ThreadPoolExecutor(max_workers=20) as pool:
        results = list(pool.map(lambda _:try_weekly_reset(tmp_path,'fixture',rpc_factory=factory), range(20)))
    assert len(state['keys']) == 1
    assert all(result['resumed'] for result in results)


def test_timeout_retry_reuses_the_persisted_redemption_key(tmp_path):
    state = service(fail_once=True)
    factory = lambda command:FakeRPC(state)
    first = try_weekly_reset(tmp_path,'fixture',rpc_factory=factory)
    assert first == {'status':'unavailable','resumed':False,'error':'TimeoutError'}
    second = try_weekly_reset(tmp_path,'fixture',rpc_factory=factory)
    assert second['resumed']
    assert len(state['keys']) == 2 and len(set(state['keys'])) == 1


@pytest.mark.parametrize('outcome', ['alreadyRedeemed','nothingToReset','noCredit'])
def test_provider_outcomes_do_not_infer_quota_relief(tmp_path,outcome):
    state = service(outcome=outcome)
    result = try_weekly_reset(tmp_path,'fixture',rpc_factory=lambda command:FakeRPC(state))
    assert result['status'] == outcome
    assert result['resumed'] == (outcome == 'alreadyRedeemed')


def test_successful_redemption_waits_for_propagation_instead_of_spending_again(tmp_path):
    state = service()
    factory = lambda command:FakeRPC(state)
    assert try_weekly_reset(tmp_path,'fixture',rpc_factory=factory)['resumed']
    state['snapshot'] = snapshot()  # A stale service quota view during propagation.
    assert try_weekly_reset(tmp_path,'fixture',rpc_factory=factory)['status'] == 'reset_propagating'
    assert len(state['keys']) == 1


def test_read_only_usage_probe_never_consumes(tmp_path):
    state = service()
    result = read_rate_limits('fixture',rpc_factory=lambda command:FakeRPC(state))
    assert result['rateLimitResetCredits']['availableCount'] == 3
    assert not state['keys']


def test_weekly_relief_does_not_override_an_exhausted_short_window(tmp_path):
    limited = snapshot(percent=0,credits=2)
    limited['rateLimits']['secondary'] = limited['rateLimits']['primary']
    limited['rateLimits']['primary'] = {'usedPercent':100,'windowDurationMins':300,'resetsAt':1900000001}
    state = service(reset_snapshot=limited)
    factory = lambda command:FakeRPC(state)
    assert not try_weekly_reset(tmp_path,'fixture',rpc_factory=factory)['resumed']
    again = try_weekly_reset(tmp_path,'fixture',rpc_factory=factory)
    assert again['status'] == 'reset_propagating' and not again['resumed']
    assert len(state['keys']) == 1


def test_exhausted_short_window_redeems_available_reset_with_weekly_quota_remaining(tmp_path):
    limits = snapshot(percent=100, duration=300)
    limits['rateLimits']['secondary'] = {'usedPercent': 40, 'windowDurationMins': 10080, 'resetsAt': 1900000001}
    state = service(snapshot=limits)
    result = try_weekly_reset(tmp_path, 'fixture', rpc_factory=lambda command: FakeRPC(state))
    assert result['resumed'] and result['status'] == 'reset'
    assert len(state['keys']) == 1


def test_provider_ineligible_short_window_is_not_treated_as_a_reset(tmp_path):
    state = service(snapshot=snapshot(duration=300), outcome='nothingToReset')
    result = try_weekly_reset(tmp_path, 'fixture', rpc_factory=lambda command: FakeRPC(state))
    assert result['status'] == 'nothingToReset' and not result['resumed']


def test_separate_processes_share_the_redemption_lock(tmp_path):
    import subprocess
    import sys
    service_path = tmp_path/'fake-service.json'
    service_path.write_text(json.dumps({'snapshot':snapshot(),'consumes':0}))
    code = '''
import json,sys
from pathlib import Path
from jobagent.services.codex_usage import try_weekly_reset
service_path=Path(sys.argv[2])
class RPC:
 def __init__(self,command): pass
 def __enter__(self): return self
 def __exit__(self,*args): return False
 def request(self,method,params=None):
  state=json.loads(service_path.read_text())
  if method=='account/rateLimits/read': return state['snapshot']
  assert method=='account/rateLimitResetCredit/consume'
  state['consumes']+=1
  state['snapshot']['rateLimits']['primary']['usedPercent']=0
  state['snapshot']['rateLimitsByLimitId']['codex']['primary']['usedPercent']=0
  service_path.write_text(json.dumps(state))
  return {'outcome':'reset'}
result=try_weekly_reset(sys.argv[1],'fixture',rpc_factory=RPC)
assert result['resumed'],result
'''
    processes = [subprocess.Popen([sys.executable,'-c',code,str(tmp_path),str(service_path)],
                                 stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(4)]
    for process in processes:
        stdout,stderr = process.communicate(timeout=10)
        assert process.returncode == 0, stderr+stdout
    assert json.loads(service_path.read_text())['consumes'] == 1


def test_fresh_available_quota_resumes_without_consuming_and_does_not_need_reset_history(tmp_path):
    state = service(snapshot=snapshot(percent=88))
    result = try_weekly_reset(tmp_path,'fixture',rpc_factory=lambda command:FakeRPC(state))
    assert result['status'] == 'not_exhausted' and result['resumed']
    assert result['available_count'] == 3
    assert not state['keys']


def test_corrupt_redemption_ledger_fails_closed_instead_of_losing_idempotency(tmp_path):
    (tmp_path/'codex-earned-resets.json').write_text('{broken')
    state = service()
    result = try_weekly_reset(tmp_path,'fixture',rpc_factory=lambda command:FakeRPC(state))
    assert result['status'] == 'unavailable' and not result['resumed']
    assert not state['keys']
