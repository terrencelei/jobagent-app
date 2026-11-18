#!/usr/bin/env python3
"""One bounded monitoring pass, intended for a 20-second launchd interval.

Use queue-owned reconciliation only. Never approve prose, force application retries, start a
paused runner, or modify submission evidence directly. The runner owns receipt
checks, technical retries, browser workers and final submission.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / 'data/application-runner/attention-monitor.json'
BASE = 'http://127.0.0.1:8000/api/applications'
COORDINATION = ROOT.parent / 'application-agent/private/agent-coordination.md'


def api(method, path, body=None):
    request = Request(BASE + path, method=method,
                      data=json.dumps(body or {}).encode() if method == 'POST' else None,
                      headers={'Content-Type': 'application/json', 'X-JobAgent-Application': '1'})
    with urlopen(request, timeout=90) as response:
        return json.load(response)


def active_claims(text, now=None):
    now = now or datetime.now(timezone.utc)
    claims = {}
    log = text.partition('## Log')[2]
    for line in log.splitlines():
        match = re.match(r'- (\S+) (Claude|Codex): (CLAIM|HOLD|DONE) (\d+)\b', line)
        if not match:
            continue
        stamp, owner, action, job = match.groups()
        try:
            at = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
            if at.tzinfo is None:
                continue
        except ValueError:
            continue
        if action == 'DONE':
            claims.pop(int(job), None)  # Either collaborating owner can close a handoff.
        elif action == 'HOLD' or now - at < timedelta(minutes=30):
            # A future-stamped claim is held conservatively, never silently stolen.
            claims[int(job)] = {'owner': owner, 'claimed_at': stamp, 'hold': action == 'HOLD'}
    return claims


def restore_weekly_capacity(snapshot):
    # Also works while an old backend is waiting for its reported reset time.
    # Clearing a recovered limit never starts a manually paused runner here.
    if snapshot.get('engine') != 'codex' or not (snapshot.get('running') or snapshot.get('engine_status', {}).get('status') == 'usage_limited'):
        return None
    sys.path.insert(0, str(ROOT / 'src'))
    from jobagent.services.codex_usage import try_weekly_reset
    command = shutil.which('codex') or str(Path.home() / '.local/bin/codex')
    result = try_weekly_reset(STATE.parent, command)
    return {key: result[key] for key in ('status', 'resumed', 'available_count', 'error') if key in result}


def recover_quota_repairs(call, snapshot, reset, *, path=None, maximum=None, claims=None):
    """Continue existing technical chats interrupted by quota, never applications."""
    if not snapshot.get('running') or not reset or not reset.get('resumed') or not (snapshot.get('counts', {}).get('help') or snapshot.get('counts', {}).get('approvals')):
        return []
    path = path or STATE.parent / 'quota-repair-recovery.json'
    if maximum is None:
        from jobagent.settings import setting
        maximum = setting('workers.max_repair_agents')
    try:
        ledger = json.loads(path.read_text()) if path.exists() else {}
    except (ValueError, OSError):
        return []  # Preserve an unreadable attempt ledger instead of retrying.
    try:
        epoch = json.loads((STATE.parent / 'codex-earned-resets.json').read_text()).get('last_success', {}).get('at', 0)
    except (ValueError, OSError):
        epoch = 0
    rows = call('GET', '/help').get('items', [])
    approvals = call('GET', '/approvals').get('approvals', [])
    rows = list({row['job_id']: row for row in [*rows, *approvals]}.values())
    try:
        background = call('GET', '/background-agents')
        active_ids = {agent['job_id'] for agent in background.get('agents', [])}
        active_count = background.get('active', sum(bool(row.get('chat', {}).get('busy')) for row in rows))
    except Exception:
        active_ids = set()
        active_count = sum(bool(row.get('chat', {}).get('busy')) for row in rows)
    free = max(0, maximum - active_count)
    resumed = []
    for row in rows:
        if not free:
            break
        if row.get('held_for_user') or row['job_id'] in active_ids or row.get('chat', {}).get('busy') or row.get('submitted') or row.get('submission_attempted') or row.get('status') == 'submission_unknown' or re.search(r'captcha|verification|unknown personal|no saved password', row.get('message', ''), re.I):
            continue
        job_id = row['job_id']
        chat = call('GET', f'/help/{job_id}/chat')
        if chat.get('busy') or chat.get('engine') != 'codex':
            continue
        messages = chat.get('messages', [])
        last_user = max((i for i, m in enumerate(messages) if m.get('role') == 'user'), default=-1)
        turn = messages[last_user + 1:]
        errors = [m for m in turn if m.get('role') == 'error' and re.search(r'usage limit|weekly limit|quota|limit reached', m.get('text', ''), re.I)]
        if not errors or any(m.get('role') == 'agent' for m in turn[turn.index(errors[-1]) + 1:]):
            continue
        failure = errors[-1].get('time')
        if not failure:
            continue
        claim = (claims or {}).get(job_id)
        if claim:
            try:
                if datetime.fromisoformat(claim['claimed_at'].replace('Z', '+00:00')) > datetime.fromisoformat(failure.replace('Z', '+00:00')):
                    continue  # A person took over after the interrupted chat.
            except (ValueError, KeyError):
                continue
        entry = ledger.get(str(job_id), {})
        if entry.get('epoch') == epoch and (entry.get('failure') == failure or entry.get('attempts', 0) >= 3):
            continue
        ledger[str(job_id)] = {'epoch': epoch, 'failure': failure, 'attempts': entry.get('attempts', 0) + 1 if entry.get('epoch') == epoch else 1}
        temporary = path.with_suffix('.tmp')
        with open(temporary, 'w') as output:
            os.chmod(temporary, 0o600); json.dump(ledger, output)
        temporary.replace(path)
        call('POST', f'/help/{job_id}/chat', {'text': 'AI capacity is restored after the usage limit. Continue your existing technical diagnosis from its saved work. Preserve all employer submission evidence, other file claims and the required approval of unknown facts or writing. Do not resubmit an uncertain application. Finish your job claim when done.'})
        resumed.append(job_id); free -= 1
    return resumed


def monitor_pass(call=api, claims=None):
    before = call('GET', '')
    actions, errors, held = {}, [], []
    reset = None
    try:
        reset = restore_weekly_capacity(before)
        if reset is not None:
            actions['weekly_reset'] = reset
            if reset.get('resumed') and before.get('engine_status', {}).get('status') == 'usage_limited':
                call('POST', '/retry-engine-limits', {})
                before = call('GET', '')
    except Exception as exc:
        errors.append({'step': 'weekly-reset', 'error': type(exc).__name__})
    if claims is None:
        try:
            claims = active_claims(COORDINATION.read_text())
        except FileNotFoundError:
            claims = {}
    # A manual stop remains a stop. Observe paused queues without resuming them.
    if before['running']:
        for count, path in [('approvals', '/approvals/resolve-known'), ('help', '/help/reconcile')]:
            if before['counts'].get(count, 0):
                try:
                    # Select unclaimed postings so one manual investigation cannot
                    # block repairs for the rest of a large worker pool.
                    listing = call('GET', '/approvals' if count == 'approvals' else '/help')
                    rows = listing.get('approvals' if count == 'approvals' else 'items', [])
                    claimed = [row['job_id'] for row in rows if row['job_id'] in claims]
                    if claimed:
                        held.append({'category': count, 'job_ids': claimed})
                    available = [row['job_id'] for row in rows if row['job_id'] not in claims]
                    if claimed and not available:
                        continue
                    actions[count] = call('POST', path, {'job_ids': available})
                except Exception as exc:
                    errors.append({'step': count, 'error': str(exc)[:500]})
    try:
        restored = recover_quota_repairs(call, before, reset, claims=claims)
        if restored:
            actions['quota_repairs_resumed'] = restored
    except Exception as exc:
        errors.append({'step': 'quota-repairs', 'error': type(exc).__name__})
    after = call('GET', '')
    pending = []
    for count, path, key in [('help', '/help', 'items'), ('approvals', '/approvals', 'approvals')]:
        if not after['counts'].get(count, 0):
            continue
        try:
            for item in call('GET', path).get(key, []):
                pending.append({k: item.get(k) for k in ('job_id', 'company', 'status', 'message')})
        except Exception as exc:
            errors.append({'step': count + '-read', 'error': str(exc)[:500]})
    return {'checked_at': datetime.now(timezone.utc).isoformat(), 'interval_seconds': 20,
            'running': after['running'], 'counts': after['counts'],
            'actions': actions, 'pending': pending, 'held_for_partner': held, 'errors': errors}


def main():
    STATE.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE.with_suffix('.lock'), 'a') as lock:
        os.chmod(lock.name, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        try:
            result = monitor_pass()
        except Exception as exc:
            result = {'checked_at': datetime.now(timezone.utc).isoformat(),
                      'interval_seconds': 20, 'errors': [{'step': 'monitor', 'error': str(exc)[:500]}]}
        temporary = STATE.with_suffix('.tmp')
        with open(temporary, 'w') as output:
            os.chmod(temporary, 0o600)
            json.dump(result, output, indent=2)
        temporary.replace(STATE)


if __name__ == '__main__':
    main()
