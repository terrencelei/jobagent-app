"""Small, deterministic briefings; never interpret applicant facts or mutate runs."""
from pathlib import Path
import json


def run_summary(item, run_dir):
    """Read only public run metadata. Never load the request/profile/credentials."""
    path = Path(run_dir) / 'state.json'
    try:
        state = json.loads(path.read_text())
    except (OSError, ValueError):
        state = {}
    evidence = {key: str(Path(run_dir) / key) for key in
                ('state.json', 'request.json', 'worker.log', 'screenshot.jpg', 'decision-page.json')
                if (Path(run_dir) / key).is_file()}
    return {
        'job_id': item['job_id'], 'run_id': item['id'],
        'status': state.get('status', item.get('status')),
        'message': state.get('message', item.get('message')),
        'questions': item.get('questions') or state.get('questions') or [],
        'submission_attempted': bool(item.get('submission_attempted') or state.get('submission_attempted')),
        'submitted': bool(item.get('submitted') or state.get('submitted')),
        'recent_events': [{'time': e.get('time'), 'message': e.get('message')}
                          for e in state.get('events', [])[-6:]],
        'evidence': evidence,
    }


def briefing_update(item, run_dir):
    return ('Current posting update (existing session rules and submission guards still apply):\n'
            + json.dumps(run_summary(item, run_dir), ensure_ascii=False, separators=(',', ':')))


def coordination_summary(text, now):
    """Read the entire log in code; return active claims plus bounded recent context."""
    import re
    from datetime import datetime, timedelta
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
            claims.pop(job, None)
        elif action == 'HOLD' or now - at < timedelta(minutes=30):
            claims[job] = {'owner': owner, 'action': action, 'at': stamp, 'detail': line}
    entries = re.split(r'(?m)(?=^- \d{4}-)', log)
    recent = [' '.join(e.split()) for e in entries if e.strip()][-12:]
    return {'active_claims': claims, 'recent_entries': recent,
            'full_log_characters': len(text), 'full_log_available': True}
