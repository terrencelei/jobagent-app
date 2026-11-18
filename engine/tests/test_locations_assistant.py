from jobagent.ui import assistant_routes
from jobagent.ui.locations import state_of


def test_state_is_read_from_the_ways_postings_write_places():
    cases = {'Cupertino, CA': 'CA', 'Costa Mesa, California, United States': 'CA', 'US, Oregon, Hillsboro': 'OR', 'San Francisco': 'CA',
             'Washington, DC': 'DC', 'Kirkland, Washington, USA': 'WA', 'USA - Ridley Park, PA': 'PA', 'Remote in USA': 'REMOTE',
             'Toronto, ON, Canada': None, 'Seremban, Negeri Sembilan, Malaysia': None, 'United States': None, '': None}
    for place, expected in cases.items():
        assert state_of(place) == expected, place


class FakeProcess:
    def __init__(self, lines):
        import io
        self.stdin, self.stdout, self.stderr, self.returncode, self.pid = io.StringIO(), iter(lines), io.StringIO(''), 0, 1
        self.stdin.close = lambda: None

    def wait(self, timeout=None):
        return 0


def desk(tmp_path, replies, seen):
    import json
    from jobagent.services.dashboard_assistant import DashboardAssistant

    def popen(args, **kwargs):
        seen.append(args)
        return FakeProcess([json.dumps({'type': 'assistant', 'message': {'content': [block]}}) for block in replies.pop(0)])

    return DashboardAssistant(tmp_path, assistant_routes.ACTIONS, lambda: {'today': ['x']}, lambda: 'sonnet', popen=popen,
                              cli=lambda name: '/bin/claude', sandbox='/bin/sh')


def wait(assistant):
    import time
    for _ in range(200):
        if not assistant.chat()['busy']:
            return assistant.chat()
        time.sleep(0.01)
    raise AssertionError('the assistant never finished')


def test_assistant_acts_with_tools_inside_the_sandbox_and_remembers(tmp_path):
    seen = []
    replies = [[{'type': 'tool_use', 'name': 'Bash', 'input': {'command': 'curl -s http://127.0.0.1:8000/api/applications'}},
                {'type': 'text', 'text': 'Two roles are queued.\nACTIONS: [{"type": "open_approvals"}, {"type": "delete_everything"}, {"type": "sort_roles", "sort": "salary", "label": "Sort by pay"}]'}],
               [{'type': 'text', 'text': 'Done.'}]]
    assistant = desk(tmp_path, replies, seen)
    assistant.send('what is queued?')
    log = wait(assistant)
    assert [m['role'] for m in log['messages']] == ['user', 'activity', 'agent'], log['messages']
    reply = log['messages'][-1]
    assert reply['text'] == 'Two roles are queued.'
    assert [a['type'] for a in reply['actions']] == ['open_approvals', 'sort_roles'] and reply['actions'][0]['label'] == 'Open Approvals'
    # The CLI runs under the sandbox with every tool and no permission prompts.
    first = seen[0]
    assert first[:2] == ['/bin/sh', '-p'] and first[3] == '/bin/claude' and 'bypassPermissions' in first and '--session-id' in first
    assistant.send('and now?')
    wait(assistant)
    assert '--resume' in seen[1] and seen[1][seen[1].index('--resume') + 1] == first[first.index('--session-id') + 1]
    assert assistant.reset()['messages'] == []


def test_sandbox_keeps_the_product_read_only():
    from jobagent.services.dashboard_assistant import AGENT, JOBAGENT, sandbox_profile
    profile = sandbox_profile()
    for path in (JOBAGENT / 'src', JOBAGENT / 'tests', JOBAGENT / '.venv', AGENT / 'src', AGENT / 'tools', AGENT / 'node_modules', AGENT / 'CLAUDE.md'):
        assert f'(deny file-write* (subpath "{path}"))' in profile
    # His data stays writable: nothing above these folders is denied.
    for path in (JOBAGENT / 'data', JOBAGENT / 'config', AGENT / 'private', AGENT / 'state'):
        assert f'"{path}"' not in profile and f'(subpath "{path.parent}")' not in profile


def test_assistant_refuses_to_run_without_the_sandbox(tmp_path):
    import pytest
    assistant = desk(tmp_path, [], [])
    assistant.sandbox = '/nonexistent/sandbox-exec'
    with pytest.raises(ValueError, match='sandbox'):
        assistant.send('hello')
