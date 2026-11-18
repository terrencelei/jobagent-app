"""Schedule read-only mailbox work once for up to ten pending applications."""
from datetime import datetime, timezone
import os


def schedule_receipt_batch(runner, eligible):
    script = runner.agent_dir / 'tools/verify-receipts-batch.mjs'
    if not script.is_file():
        return False  # Older Application Agent installs keep their existing checker.
    from .application_runner import atomic, now
    def checked_at(item):
        try:
            return datetime.fromisoformat(item['receipt_checked_at']).timestamp()
        except (KeyError, ValueError, TypeError, OverflowError):
            return float('-inf')
    candidates = []
    for item in sorted(runner.data['jobs'], key=checked_at):
        if item['id'] in runner.processes or not eligible(item):
            continue
        runner._refresh(item)
        if not eligible(item):
            continue
        if datetime.now(timezone.utc).timestamp() - checked_at(item) < 300:
            continue
        if (runner.directory / item['id'] / 'request.json').is_file():
            candidates.append(item)
    if not candidates or not runner.data['running'] or runner.receipt_processes:
        return True
    batch = candidates[:10]
    manifest = runner.directory / 'receipt-batch-request.json'
    atomic(manifest, {'runs': [str(runner.directory / item['id']) for item in batch]})
    try:
        with open(runner.directory / 'receipt-batch.log', 'ab') as log:
            os.chmod(log.name, 0o600)
            process = runner.popen([runner._node() or 'node', str(script), str(manifest)],
                                   cwd=runner.agent_dir, stdout=log, stderr=log, start_new_session=True)
        runner.receipt_processes[batch[0]['id']] = process
        for item in batch:
            item['receipt_checked_at'] = now()
    except OSError as exc:
        for item in batch:
            item['receipt_error'] = str(exc)
    return True
