import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from jobagent.db.models import Application, Base, EligibilityStatus, Job, JobStatus
from jobagent.processing import track_eval, tracks


@pytest.fixture
def session(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    sess = sessionmaker(bind=engine)()
    monkeypatch.setattr(track_eval, 'runner_job_ids', lambda data_dir=None: {5})
    yield sess
    sess.close()


def rejected():
    r = {'eligibility': 'INELIGIBLE', 'reasons': [], 'stated_start_date': None, 'start_conflict': False}
    return {'mechanical': r, 'data': {**r, 'eligibility': 'LIKELY_INELIGIBLE'}}


def add(session, i, **kw):
    job = Job(id=i, company_name='Co', title=f'T{i}', description='d', canonical_url=f'https://x/{i}', application_url=f'https://x/{i}',
              source_ats='direct', eligibility=EligibilityStatus.INELIGIBLE, track_results=kw.pop('results', rejected()), **kw)
    session.add(job)
    return job


def test_prune_keeps_everything_he_acted_on(session, tmp_path):
    add(session, 1)                                                     # rejected everywhere: deleted
    add(session, 2, status=JobStatus.APPLIED)                           # his history
    add(session, 3, user_fit_label={'mechanical': {'fit': True}})       # he labelled it
    add(session, 4, results={**rejected(), 'data': {'eligibility': 'ELIGIBLE'}})  # the data track wants it
    add(session, 5)                                                     # in the runner queue
    add(session, 6)
    session.add(Application(job_id=6))                                  # an application record
    (tmp_path / 'state').mkdir()
    add(session, 7); (tmp_path / 'state' / 'jobagent-7.json').write_text('{}')  # application-agent state
    session.commit()
    assert track_eval.prune_rejected(session, agent_dir=tmp_path) == 1
    assert sorted(j.id for j in session.query(Job)) == [2, 3, 4, 5, 6, 7]


def test_labels_and_reviews_are_kept_per_track():
    legacy = {'fit': False, 'note': 'x'}
    assert tracks.per_track(legacy, 'mechanical') == legacy and tracks.per_track(legacy, 'data') is None
    both = tracks.with_track(legacy, 'data', {'fit': True})
    assert both == {'mechanical': legacy, 'data': {'fit': True}}
    assert tracks.with_track(both, 'mechanical', None) == {'data': {'fit': True}}


def test_switching_track_shows_that_tracks_verdicts(session, tmp_path, monkeypatch):
    from jobagent.tracking import reclassify
    monkeypatch.setattr(tracks, '_state_path', lambda: tmp_path / 'active-track.json')
    job = add(session, 9, results={k: {'eligibility': e, 'reasons': [k], 'stated_start_date': None, 'start_conflict': False,
                                       'best_career_cluster': c, 'cluster_scores': {}, 'relevance_score': s, 'urgency_score': 50.0,
                                       'priority_score': s, 'early_career_boost': False,
                                       'breakdown': {b: ([] if b in ('matching_skills', 'missing_skills', 'matching_experience') else '' if b == 'explanation' else 0.0) for b in track_eval.BREAKDOWN_KEYS}}
                                   for k, e, c, s in [('mechanical', 'INELIGIBLE', 'OTHER', 10.0), ('data', 'STRONG_MATCH', 'DATA SCIENCE / MACHINE LEARNING', 80.0)]})
    session.commit()
    reclassify.show_track(session, 'data')
    assert tracks.active_track() == 'data'
    assert job.eligibility == EligibilityStatus.STRONG_MATCH and job.best_career_cluster == 'DATA SCIENCE / MACHINE LEARNING' and job.priority_score == 80.0
    reclassify.show_track(session, 'mechanical')
    assert job.eligibility == EligibilityStatus.INELIGIBLE and job.eligibility_reasons == ['mechanical']


def test_prunable_checks_the_runner_queue_when_no_ids_are_given(session, tmp_path):
    # Rediscovery called prunable() without queued_ids and deleted parked Anduril job 11909.
    add(session, 5); add(session, 8); session.commit()
    assert track_eval.prunable(session, session.get(Job, 5), agent_dir=tmp_path) is False
    assert track_eval.prunable(session, session.get(Job, 8), agent_dir=tmp_path) is True
