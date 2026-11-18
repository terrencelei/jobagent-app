"""Submitted applications leave Needs help; 'Finish in my Chrome' hands a filled form to him."""
import json
from types import SimpleNamespace

import pytest

from jobagent.db.models import Application, EligibilityStatus, Job, JobStatus


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
        for i in (1, 2, 3):
            session.add(Job(id=i, fit_review={'fit': True, 'hash': None}, company_name=f'Co{i}', title='Mechanical Engineer', description='d',
                            location='San Francisco, California, United States', canonical_url=f'https://jobs.lever.co/x/{i}', application_url=f'https://jobs.lever.co/x/{i}',
                            source_ats='lever', role_type='FULL_TIME', eligibility=EligibilityStatus.STRONG_MATCH, best_career_cluster='PRODUCT / MECHANICAL DESIGN', priority_score=90))
        session.commit()
    agent = tmp_path / 'agent'; (agent / 'private').mkdir(parents=True); (agent / 'src').mkdir(); (agent / 'state').mkdir()
    (agent / 'src/dashboard-worker.mjs').touch(); (agent / 'private/profile.json').write_text('{}'); (agent / 'private/Alex_Rivera_Resume.pdf').write_bytes(b'%PDF')
    r = ApplicationRunner(tmp_path / 'runs', agent, sessions)
    r._cli = lambda engine: f'/fixture/bin/{engine}'
    r._node = lambda: '/usr/bin/node'
    r.popen = lambda *a, **k: SimpleNamespace(pid=1, poll=lambda: None)
    return r


def parked(runner, job_id, **extra):
    runner.queue([job_id])
    item = next(j for j in runner.data['jobs'] if j['job_id'] == job_id)
    item.update(status='needs_human', **extra)
    return item


def test_submitted_applications_leave_needs_help(runner):
    by_him, confirmed, open_ = parked(runner, 1), parked(runner, 2), parked(runner, 3)
    with runner.sessions() as session:
        session.get(Job, 1).status = JobStatus.APPLIED; session.add(Application(job_id=1)); session.commit()
    (runner.agent_dir / 'state/jobagent-2.json').write_text(json.dumps({'status': 'submitted'}))
    runner._retire_submitted_help()
    assert by_him['status'] == 'completed' and confirmed['status'] == 'completed' and open_['status'] == 'needs_human'
    assert [h['job_id'] for h in runner.help_items()] == [3]


def test_finish_in_my_chrome_relaunches_for_him_even_while_awaiting_his_submit(runner):
    parked(runner, 1, approved_answers=[{'question': 'Why?', 'answer': 'Because.'}])
    (runner.agent_dir / 'state/jobagent-1.json').write_text(json.dumps({'status': 'awaiting_human_submit'}))
    runner.finish_myself(1)
    item = next(j for j in runner.data['jobs'] if j['job_id'] == 1)
    request = json.loads((runner.directory / item['id'] / 'request.json').read_text())
    assert request['humanFinish'] is True and item['approved_answers'][0]['answer'] == 'Because.' and item['id'] in runner.processes


def test_finish_in_my_chrome_refuses_a_recorded_submission(runner):
    parked(runner, 1)
    (runner.agent_dir / 'state/jobagent-1.json').write_text(json.dumps({'status': 'submission_unknown'}))
    with pytest.raises(ValueError, match='submission on record'):
        runner.finish_myself(1)
