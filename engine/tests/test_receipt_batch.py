import json
from test_application_runner import runner, FakeProcess  # noqa: F401
from jobagent.services.application_runner import atomic


def test_pending_receipts_share_one_bounded_process_and_keep_submission_guards(runner):
    runner.queue([1, 2, 3])
    script = runner.agent_dir / 'tools/verify-receipts-batch.mjs'
    script.parent.mkdir();script.touch()
    runner.data['running'] = True
    first, second, active = runner.data['jobs']
    for item in runner.data['jobs']:
        item.update(status='submission_unknown', submission_attempted=True)
        atomic(runner.directory / item['id'] / 'request.json', {})
    runner.processes[active['id']] = FakeProcess()
    calls = []
    runner.popen = lambda args, **kwargs: calls.append(args) or FakeProcess()
    runner._check_receipts()
    assert len(calls) == 1 and calls[0][1] == str(script)
    manifest = json.loads((runner.directory / 'receipt-batch-request.json').read_text())
    assert manifest['runs'] == [str(runner.directory / item['id']) for item in [first, second]]
    assert first['receipt_checked_at'] and second['receipt_checked_at']
    assert 'receipt_checked_at' not in active
    assert all(item['status'] == 'submission_unknown' and item['submission_attempted'] for item in runner.data['jobs'])
    runner.receipt_processes.clear();runner._check_receipts()
    assert len(calls) == 1  # The entire batch shares the existing cooldown.


def test_paused_queue_never_starts_a_mailbox_agent(runner):
    runner.queue([1])
    script = runner.agent_dir / 'tools/verify-receipts-batch.mjs'
    script.parent.mkdir();script.touch()
    item = runner.data['jobs'][0];item.update(status='submission_unknown', submission_attempted=True)
    atomic(runner.directory / item['id'] / 'request.json', {})
    runner.popen = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('Unexpected mailbox process'))
    runner._check_receipts()
    assert 'receipt_checked_at' not in item
