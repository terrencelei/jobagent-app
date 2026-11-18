#!/usr/bin/env python3
"""Print one bounded application diagnosis plus current collaboration ownership."""
from datetime import datetime, timezone
from pathlib import Path
import argparse
import json
import sys
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from jobagent.services.assistance_context import run_summary, coordination_summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('job_id', type=int)
    args = parser.parse_args()
    directory = ROOT / 'data/application-runner'
    queue = json.loads((directory / 'queue.json').read_text())
    item = next((row for row in queue['jobs'] if row['job_id'] == args.job_id), None)
    if item is None:
        parser.error('Job is not in the application queue; inspect its database history instead.')
    coordination = ROOT.parent / 'application-agent/private/agent-coordination.md'
    result = run_summary(item, directory / item['id'])
    # The same validated script used by the Approvals page supplies targeted
    # facts/draft proposals. No model call and no bulk answer-bank dump.
    memory = ROOT.parent / 'application-agent/tools/answer-memory.mjs'
    node = shutil.which('node')
    if node and memory.is_file() and item.get('questions'):
        payload = {'action': 'suggest', 'items': [item], 'runDirectory': str(directory),
                   'profilePath': str(memory.parent.parent / 'private/profile.json'),
                   'bankDir': str(memory.parent.parent / 'private/companies')}
        try:
            process = subprocess.run([node, str(memory)], input=json.dumps(payload), text=True,
                                     capture_output=True, timeout=25)
            if process.returncode == 0:
                result['scripted_suggestions'] = json.loads(process.stdout)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            result['scripted_suggestions_unavailable'] = True
    if coordination.is_file():
        result['coordination'] = coordination_summary(coordination.read_text(), datetime.now(timezone.utc))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
