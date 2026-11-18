"""Drafts learn from his edits: capture draft vs approved, a learned style guide, model drafts on Approvals."""
import json
from types import SimpleNamespace

import pytest

from jobagent.db.models import EligibilityStatus, Job
from jobagent.services import writing_learner
from jobagent.services.writing_learner import WritingLearner, is_writing

WHY = 'What excites you about the opportunity to work at Xaira?*'


def cli(outputs, prompts):
    def run(args, input, **kw):
        prompts.append((args, input))
        return SimpleNamespace(returncode=0, stdout=json.dumps({'structured_output': outputs.pop(0)}), stderr='')
    return run


def test_writing_questions_are_told_apart_from_facts():
    assert is_writing({'label': WHY}) and is_writing({'label': 'Cover Letter* (Attach)'})
    assert is_writing({'label': 'Please describe your most complex project.*', 'type': 'textarea'})
    assert not is_writing({'label': 'What is your desired salary?', 'type': 'textarea'})
    assert not is_writing({'label': 'Why are you leaving?', 'options': ['A', 'B']})


def test_edits_are_kept_and_teach_the_style_guide(tmp_path, monkeypatch):
    monkeypatch.setattr(writing_learner, '_cli', lambda name: '/bin/claude')
    prompts = []
    learner = WritingLearner(tmp_path, run=cli([{'guide': '- Cut filler openers. "I am excited to" -> "I want to"'}], prompts))
    learner.refresh_style_later = lambda: None
    job = {'job_id': 7, 'company': 'Xaira', 'title': 'Robotics Engineer'}
    kept = learner.record(job, [
        {'question': WHY, 'draft': 'I am excited to join Xaira because of its mission and innovation.', 'answer': 'I want to build the lab robots Xaira runs its experiments on.'},
        {'question': 'Phone*', 'answer': '555'},  # a fact: never logged
        {'question': 'Tell us about your proudest accomplishment*', 'draft': 'Same text as approved, at least eight words long.', 'answer': 'Same text as approved, at least eight words long.'}])
    assert [e['edited'] for e in kept] == [True, False]
    assert learner.refresh_style().startswith('- Cut filler')
    assert 'I am excited to join Xaira' in prompts[0][1] and 'I want to build' in prompts[0][1]
    assert (tmp_path / 'private/writing-style.md').read_text().count('Learned from 1 edited and 1 unedited') == 1


def test_drafts_use_the_guide_his_answers_and_his_edits(tmp_path, monkeypatch):
    monkeypatch.setattr(writing_learner, '_cli', lambda name: '/bin/claude')
    (tmp_path / 'private/companies').mkdir(parents=True)
    (tmp_path / 'private/companies/formlabs.json').write_text(json.dumps({'company': 'Formlabs', 'answers': {'q': {
        'question': 'Please describe your most complex project.*', 'answer': 'At Applied Materials I designed a patent-pending actuator mechanism.',
        'approvedAt': '2026-10-10T00:00:00Z', 'type': 'textarea'}}}))
    (tmp_path / 'private/writing-style.md').write_text('- Lead with the hardware.')
    prompts = []
    out = [{'drafts': [{'label': WHY, 'draft': 'I want to build lab automation at Xaira.', 'examples_used': ['Formlabs: most complex project'], 'notes': ''},
                       {'label': 'Not asked', 'draft': 'x', 'examples_used': [], 'notes': ''}]}]
    learner = WritingLearner(tmp_path, run=cli(out, prompts))
    drafts = learner.draft({'company': 'Xaira', 'title': 'Robotics Engineer', 'description': 'lab automation'}, [{'label': WHY}], {}, tmp_path / 'private/companies')
    assert list(drafts) == [WHY] and 'Formlabs' in drafts[WHY]['note']
    assert 'Lead with the hardware' in prompts[0][1] and 'patent-pending actuator' in prompts[0][1]


@pytest.fixture
def runner(tmp_path):
    from contextlib import contextmanager
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from jobagent.db.models import Base
    from jobagent.services.application_runner import ApplicationRunner
    engine = create_engine('sqlite://'); Base.metadata.create_all(engine)
    @contextmanager
    def sessions():
        with Session(engine) as session:
            yield session
    with sessions() as session:
        session.add(Job(id=1, fit_review={'fit': True, 'hash': None}, company_name='Xaira', title='Robotics Engineer', description='lab automation',
                        location='South San Francisco, California, United States', canonical_url='https://x/1', application_url='https://x/1',
                        source_ats='direct', role_type='FULL_TIME', eligibility=EligibilityStatus.STRONG_MATCH,
                        best_career_cluster='PRODUCT / MECHANICAL DESIGN', priority_score=90))
        session.commit()
    agent = tmp_path / 'agent'; (agent / 'private').mkdir(parents=True); (agent / 'src').mkdir(); (agent / 'src/dashboard-worker.mjs').touch()
    (agent / 'private/profile.json').write_text('{}')
    from jobagent import settings
    settings.settings_path().write_text(json.dumps({'overrides': {'workers.resume_tailoring': False}}))
    settings._cache.update(stamp=None, overrides={})
    r = ApplicationRunner(tmp_path / 'runs', agent, sessions)
    r._answer_memory = lambda payload: None
    return r


def test_runner_drafts_parked_writing_once_and_records_his_edit(runner):
    runner.queue([1])
    item = runner.data['jobs'][0]
    item.update(status='needs_approval', questions=[{'label': WHY, 'type': 'textarea', 'required': True}])
    runner.writing.draft = lambda job, questions, profile, bank, template: {WHY: {'draft': 'Drafted: I want to build lab automation at Xaira.', 'note': 'Drafted from your writing style guide.'}}
    threads = []
    runner._spawn = lambda target, *args: threads.append((target, args))
    runner._draft_writing()
    target, args = threads[0]
    target(*args)
    card = runner.approvals()[0]['questions'][0]
    assert card['draft'].startswith('Drafted:') and card['note'] == 'Drafted from your writing style guide.'
    runner._draft_writing()  # tried once: no second call
    assert len(threads) == 1
    runner.writing.refresh_style_later = lambda: None
    runner.approve_answers(1, {WHY: 'I want to build the lab robots Xaira runs its experiments on.'})
    entry = runner.writing.entries()[-1]
    assert entry['edited'] and entry['draft'].startswith('Drafted:') and entry['final'].startswith('I want to build the lab robots')
