import pytest

from jobagent.db.models import Application, EligibilityStatus, Job
from jobagent.processing import application_caps as caps

SENTENCES = [
    ('We love your interest in working for Airbus but we do ask that you make only one application to the Airbus Global Graduate Programme.', (1, None)),
    ('Candidates may apply to up to 10 positions in a 30-day period.', (10, 30)),
    ('You can submit a maximum of 3 applications per 6 months.', (3, 180)),
    ('Applicants are limited to five applications within a rolling 12-month period.', (5, 360)),
    ('You may submit up to 3 applications per calendar year.', (3, 365)),
    ('Please apply to no more than two roles at a time.', (2, None)),
    ('We are hiring up to 3 engineers for this team.', None),
    ('Up to 10% travel required.', None),
    ('You will manage up to 5 open requisitions with vendors.', None),
    ('Requires 3 years of experience.', None),
]


@pytest.mark.parametrize('text,expected', SENTENCES)
def test_stated_limits_are_found_and_duties_are_not(text, expected):
    found = caps.detect('Intro line.\n' + text + ' Closing line.')
    assert (found and (found['max'], found['days'])) == (expected or None)


def test_a_limit_waits_for_him_and_his_decision_sticks():
    caps.record('SpaceX', {'quote': 'q', 'max': 10, 'days': 30}, 'job posting')
    assert caps.status('spacex') == 'pending'
    caps.decide('SpaceX', True)
    caps.record('SpaceX', {'quote': 'another', 'max': 5, 'days': 7}, 'application page')
    assert caps.status('SpaceX') == 'approved' and caps.approved_limits() == {'SpaceX': {'max': 10, 'days': 30}}


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
        for i, company in [(1, 'Capped Co'), (2, 'Capped Co'), (3, 'Free Co')]:
            session.add(Job(id=i, fit_review={'fit': True, 'hash': None}, company_name=company, title=f'Mechanical Engineer {chr(64+i)}', description='d', location='San Francisco, California, United States',
                            canonical_url=f'https://x/{i}', application_url=f'https://x/{i}', source_ats='direct', role_type='FULL_TIME',
                            eligibility=EligibilityStatus.STRONG_MATCH, best_career_cluster='PRODUCT / MECHANICAL DESIGN', priority_score=90 - i))
        session.commit()
    agent = tmp_path / 'agent'; (agent / 'private').mkdir(parents=True); (agent / 'src').mkdir(); (agent / 'src/dashboard-worker.mjs').touch()
    r = ApplicationRunner(tmp_path / 'runs', agent, sessions)
    r._cli = lambda engine: f'/fixture/bin/{engine}'
    return r


def test_autoplay_and_launch_hold_an_undecided_limit(runner):
    caps.record('Capped Co', {'quote': 'Apply to up to 1 role per 30 days.', 'max': 1, 'days': 30}, 'job posting')
    assert [p['company'] for p in runner.up_next()] == ['Free Co']
    runner.queue([1])
    item = next(j for j in runner.data['jobs'] if j['job_id'] == 1)
    assert runner._limit_gate(item) and item['status'] == 'needs_cap_approval'
    assert runner.approvals()[0]['job_id'] == 1


def test_declining_dismisses_and_allowing_resumes(runner):
    caps.record('Capped Co', {'quote': 'q', 'max': 1, 'days': 30}, 'job posting')
    runner.queue([1])
    item = next(j for j in runner.data['jobs'] if j['job_id'] == 1)
    runner._limit_gate(item)
    runner.decide_cap('Capped Co', True)
    assert next(j for j in runner.data['jobs'] if j['job_id'] == 1)['status'] == 'queued'
    caps.decide('Capped Co', False)
    assert runner._limit_gate(next(j for j in runner.data['jobs'] if j['job_id'] == 1))
    assert 'Capped Co' not in [p['company'] for p in runner.up_next()]


def test_an_allowed_limit_is_enforced(runner):
    caps.decide('Capped Co', True, 1, 30)
    with runner.sessions() as session:
        session.add(Application(job_id=2)); session.commit()
    runner.queue([1])
    item = next(j for j in runner.data['jobs'] if j['job_id'] == 1)
    assert runner.applications_within('Capped Co', 30) == 1
    assert runner._limit_gate(item) and 'used up' in item['message'] and item['status'] == 'queued'
