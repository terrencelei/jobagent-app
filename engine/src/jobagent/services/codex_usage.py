"""Use earned Codex resets only after a live quota window is exhausted.

Protocol: https://learn.chatgpt.com/docs/app-server . No paid credits, account
changes or model requests are involved. The redemption UUID is persisted before
sending it so a timeout and concurrent workers cannot spend multiple resets.
"""
from contextlib import AbstractContextManager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time
import uuid


class CodexRPC(AbstractContextManager):
    def __init__(self, command, timeout=20):
        self.timeout = timeout
        self.sequence = 0
        self.responses = queue.Queue()
        env = {k:v for k,v in os.environ.items() if k not in {
            'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY'}}
        self.process = subprocess.Popen([str(command), 'app-server', '--listen', 'stdio://'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1, cwd=tempfile.gettempdir(), env=env, start_new_session=True)
        threading.Thread(target=self._read, daemon=True).start()
        try:
            self.request('initialize', {'clientInfo':{'name':'jobagent_usage','version':'1.0'},
                                       'capabilities':{'experimentalApi':True}})
            self._send({'method':'initialized'})
        except Exception:
            self.__exit__(None, None, None)
            raise

    def _read(self):
        for line in self.process.stdout:
            try:
                self.responses.put(json.loads(line))
            except ValueError:
                pass
        self.responses.put(None)

    def _send(self, value):
        self.process.stdin.write(json.dumps(value)+'\n')
        self.process.stdin.flush()

    def request(self, method, params=None):
        self.sequence += 1
        self._send({'id':self.sequence, 'method':method,
                    **({'params':params} if params is not None else {})})
        deadline = time.monotonic()+self.timeout
        while True:
            try:
                message = self.responses.get(timeout=max(0,deadline-time.monotonic()))
            except queue.Empty:
                raise TimeoutError('Codex account request timed out') from None
            if message is None:
                raise RuntimeError('Codex account connection closed')
            if message.get('id') != self.sequence:
                continue
            if 'error' in message:
                error = message['error']
                raise RuntimeError(f"Codex account request failed ({error.get('code','unknown')})")
            return message.get('result', {})

    def __exit__(self, *args):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        for stream in (self.process.stdin, self.process.stdout):
            if stream:
                stream.close()
        return False


def read_rate_limits(command, *, rpc_factory=CodexRPC):
    """Read account quotas without consuming credits or generating model tokens."""
    with rpc_factory(command) as rpc:
        return rpc.request('account/rateLimits/read')


def _quota_windows(limits):
    buckets = limits.get('rateLimitsByLimitId') or {}
    if not buckets and limits.get('rateLimits'):
        bucket = limits['rateLimits']
        buckets = {bucket.get('limitId') or 'codex':bucket}
    return [(str(bucket_id), key, window) for bucket_id,bucket in buckets.items()
            for key in ('primary','secondary')
            if isinstance(window := bucket.get(key), dict)
            and isinstance(window.get('windowDurationMins'), (int,float))
            and window['windowDurationMins'] > 0]


def _limits_available(limits):
    if not _quota_windows(limits) or limits.get('ordinaryUsageAllowed') is False:
        return False
    buckets = list((limits.get('rateLimitsByLimitId') or {}).values()) or [limits.get('rateLimits') or {}]
    for bucket in buckets:
        if bucket.get('spendControlReached') or bucket.get('rateLimitReachedType'):
            return False
        for key in ('primary','secondary'):
            window = bucket.get(key)
            if window is not None and (not isinstance(window.get('usedPercent'),(int,float)) or window['usedPercent'] >= 100):
                return False
    return True


def _save(path, data):
    temporary = path.with_suffix('.tmp')
    fd = os.open(temporary, os.O_CREAT|os.O_TRUNC|os.O_WRONLY, 0o600)
    with os.fdopen(fd,'w') as stream:
        json.dump(data,stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary,path)
    directory_fd = os.open(path.parent,os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def try_weekly_reset(state_dir, command, *, rpc_factory=CodexRPC):
    """Return status/resumed/limits; consume only a confirmed exhausted quota.

    The historical function name is retained for existing callers. Both short
    and weekly windows qualify; the provider decides reset eligibility.
    The local cross-process lock
    covers read + durable UUID reservation + consume + reread. Transport failures
    retain that UUID for retry; one successful redemption per observed quota window.
    """
    directory = Path(state_dir)
    directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    path = directory/'codex-earned-resets.json'
    lock_fd = os.open(directory/'codex-earned-resets.lock',os.O_CREAT|os.O_RDWR,0o600)
    with os.fdopen(lock_fd,'a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        try:
            try:
                ledger = json.loads(path.read_text())
            except FileNotFoundError:
                ledger = {'attempts':{}}
            with rpc_factory(command) as rpc:
                limits = rpc.request('account/rateLimits/read')
                windows_now = _quota_windows(limits)
                exhausted = [(bucket,key,window) for bucket,key,window in windows_now
                             if isinstance(window.get('usedPercent'),(int,float)) and window['usedPercent']>=100]
                account = hashlib.sha256(str(limits.get('accountId') or 'local-account').encode()).hexdigest()
                previous = ledger.get('last_success') or {}
                available_count = (limits.get('rateLimitResetCredits') or {}).get('availableCount')
                if not exhausted:
                    recent = previous.get('account')==account and time.time()-previous.get('at',0)<600
                    return {'status':'already_available' if recent else 'not_exhausted',
                            'resumed':_limits_available(limits), 'limits':limits,'available_count':available_count}
                # A burst of delayed worker errors must not spend a second credit
                # while the service propagates the first reset to all quota views.
                if previous.get('account')==account and time.time()-previous.get('at',0)<300:
                    return {'status':'reset_propagating','resumed':False,'limits':limits,'available_count':available_count}
                earned = limits.get('rateLimitResetCredits') or {}
                count = earned.get('availableCount')
                if not isinstance(count,(int,float)) or count<=0:
                    return {'status':'no_credit','resumed':False,'limits':limits,'available_count':count}
                windows = sorted((bucket,key,window.get('resetsAt')) for bucket,key,window in exhausted)
                fingerprint = hashlib.sha256(json.dumps([account,windows],sort_keys=True).encode()).hexdigest()
                entry = ledger.setdefault('attempts',{}).get(fingerprint)
                if entry is None:
                    entry = {'idempotency_key':str(uuid.uuid4()),'windows':windows,'started_at':time.time(),'status':'pending'}
                    ledger['attempts'][fingerprint] = entry
                # Reserve the logical attempt BEFORE sending a mutation remotely.
                _save(path,ledger)
                result = rpc.request('account/rateLimitResetCredit/consume',{'idempotencyKey':entry['idempotency_key']})
                outcome = result.get('outcome')
                entry.update(status=outcome or 'unknown',checked_at=time.time())
                if outcome in {'reset','alreadyRedeemed'}:
                    ledger['last_success'] = {'account':account,'at':time.time(),'fingerprint':fingerprint}
                _save(path,ledger)
                refreshed = rpc.request('account/rateLimits/read')
                clear = _limits_available(refreshed)
                return {'status':outcome or 'unknown','resumed':outcome in {'reset','alreadyRedeemed'} and clear,
                        'limits':refreshed,'available_count':(refreshed.get('rateLimitResetCredits') or {}).get('availableCount')}
        except Exception as exc:
            # Never expose protocol bodies, authentication tokens or CLI output.
            return {'status':'unavailable','resumed':False,'error':type(exc).__name__}
