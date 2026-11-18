import json
from datetime import datetime, timezone
from jobagent.services.assistance_context import run_summary, coordination_summary, briefing_update
from jobagent.services.answer_suggestion_cache import AnswerSuggestionCache, suggestion_key


def test_dossier_reads_metadata_without_loading_credentials_or_full_events(tmp_path):
    (tmp_path / 'state.json').write_text(json.dumps({'status': 'blocked', 'message': 'A dropdown failed',
        'events': [{'time': str(i), 'message': 'step', 'password': 'secret'} for i in range(50)],
        'review': {'answers': [{'value': 'private answer'}]}, 'submission_attempted': True}))
    (tmp_path / 'request.json').write_text('not JSON; must not be opened')
    item = {'job_id': 1, 'id': 'run-1'}
    summary = run_summary(item, tmp_path)
    assert summary['submission_attempted'] is True
    assert len(summary['recent_events']) == 6
    assert 'request.json' in summary['evidence']
    assert 'secret' not in json.dumps(summary) and 'private answer' not in json.dumps(summary)
    assert 'submission guards still apply' in briefing_update(item, tmp_path)


def test_complete_historical_log_is_reduced_without_losing_old_holds_or_current_claims():
    text = '# Policy\n## Log\n- 2026-01-01T00:00:00Z Claude: HOLD 1 Awaiting user\n'
    text += '\n'.join(f'- 2026-10-17T10:00:00Z Codex: DONE {i} irrelevant old history' for i in range(2, 500))
    text += '\n- 2026-10-17T12:00:00Z Codex: CLAIM 999 active work\n'
    summary = coordination_summary(text, datetime(2026, 10, 17, 12, 1, tzinfo=timezone.utc))
    assert set(summary['active_claims']) == {'1', '999'}
    assert len(summary['recent_entries']) == 12
    assert len(json.dumps(summary)) < len(text) / 10


def test_scripted_suggestion_cache_invalidates_answers_sources_and_request_changes(tmp_path):
    agent = tmp_path / 'agent';runs = tmp_path / 'runs'
    (agent / 'private/companies').mkdir(parents=True);(agent / 'src').mkdir();(runs / 'a').mkdir(parents=True)
    profile = agent / 'private/profile.json';profile.write_text('{}')
    bank = agent / 'private/companies/fixture.json';bank.write_text('{}')
    request = runs / 'a/request.json';request.write_text('{}')
    payload = {'action': 'suggest', 'items': [{'id': 'a', 'job_id': 1, 'questions': [{'label': 'Why us?'}]}]}
    key = suggestion_key(payload, agent, runs)
    cache = AnswerSuggestionCache();cache.put(key, [{'facts': {'Name': 'Fixture'}}])
    result = cache.get(key);result[0]['facts']['Name'] = 'Changed'
    assert cache.get(key)[0]['facts']['Name'] == 'Fixture'
    for source in [profile, bank, request, agent / 'src/rules.mjs', agent / 'private/companies/new.json']:
        source.write_text('changed evidence')
        changed = suggestion_key(payload, agent, runs)
        assert changed != key and cache.get(changed) is None
        key = changed
    assert suggestion_key({'items': [{**payload['items'][0], 'updated_at': 'heartbeat', 'events': [1]}]}, agent, runs) == key
    payload['items'][0]['questions'][0]['label'] = 'New question'
    assert suggestion_key(payload, agent, runs) != key
    assert suggestion_key(payload, agent, runs, datetime(2026, 10, 17, tzinfo=timezone.utc)) != suggestion_key(payload, agent, runs, datetime(2026, 10, 18, tzinfo=timezone.utc))
