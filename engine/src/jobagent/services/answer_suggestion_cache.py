"""Invalidate scripted answer suggestions whenever their source evidence changes."""
from copy import deepcopy
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json


def suggestion_key(payload, agent_dir, directory, now=None):
    agent_dir, directory = Path(agent_dir), Path(directory)
    paths = [agent_dir / 'private/profile.json', agent_dir / 'tools/answer-memory.mjs',
             *sorted((agent_dir / 'private/companies').glob('*.json')),
             *sorted((agent_dir / 'src').glob('*.mjs'))]
    items = []
    for item in payload.get('items', []):
        # Browser events, token counters and heartbeat times cannot change the
        # evidence available to the answer-memory script.
        items.append({k: v for k, v in item.items() if k not in
                      {'events', 'usage', 'updated_at', 'background_triage', 'internal_repair', 'screenshot_url'}})
        paths.append(directory / str(item.get('id', '')) / 'request.json')
    signatures = []
    for path in paths:
        try:
            stat = path.stat()
            signatures.append((str(path), stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size, stat.st_ino))
        except FileNotFoundError:
            signatures.append((str(path), None))
    stamp = now or datetime.now().astimezone()
    # Some confirmed rules derive the current date or relative availability.
    # Match both the worker's local calendar and UTC; never cache yesterday's answer.
    data = {'items': items, 'sources': signatures,
            'calendar_day': [stamp.date().isoformat(), stamp.astimezone(timezone.utc).date().isoformat()]}
    return hashlib.sha256(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()


class AnswerSuggestionCache:
    """Only one immutable result per runner; learning/writes are never cached."""
    def __init__(self):
        self.key = None
        self.result = None

    def get(self, key):
        return deepcopy(self.result) if self.key == key else None

    def put(self, key, result):
        self.key, self.result = key, deepcopy(result)
