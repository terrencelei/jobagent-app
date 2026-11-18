"""Snapshot history stays small and the SQLite file gets compacted."""
from datetime import timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from jobagent.db.models import Base, EligibilityStatus, Job, JobSnapshot, JobStatus, utc_now
from jobagent.db.repository import JobRepository
from jobagent.services import maintenance


def _db(tmp_path):
    path = tmp_path / 'm.db'
    engine = create_engine('sqlite:///' + str(path), connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    return path, engine


def _job(session, n):
    job = Job(company_name='Acme', title=f'Engineer {n}', normalized_title=f'engineer {n}', description='x', canonical_url=f'https://example.com/{n}',
              application_url=f'https://example.com/{n}', source_ats='direct', status=JobStatus.NEW, eligibility=EligibilityStatus.ELIGIBLE, role_type='FULL_TIME')
    session.add(job); session.flush()
    return job


def test_prune_keeps_only_the_newest_snapshots_per_job(tmp_path):
    path, engine = _db(tmp_path)
    with Session(engine) as session:
        a, b = _job(session, 1), _job(session, 2)
        now = utc_now()
        for job, count in ((a, 10), (b, 2)):
            for i in range(count):
                session.add(JobSnapshot(job_id=job.id, snapshot_date=now - timedelta(days=count - i), status=job.status, description_hash=str(i), raw_data={'i': i}))
        session.commit()
        assert maintenance.prune_snapshots(session, keep=3) == 7
        session.commit()
        kept = session.query(JobSnapshot).filter_by(job_id=a.id).order_by(JobSnapshot.snapshot_date).all()
        assert [s.raw_data['i'] for s in kept] == [7, 8, 9]  # the newest three
        assert session.query(JobSnapshot).filter_by(job_id=b.id).count() == 2
        assert maintenance.prune_snapshots(session, keep=3, job_id=a.id) == 0


def test_updating_a_posting_caps_its_snapshot_history(tmp_path, monkeypatch):
    monkeypatch.setattr(maintenance, 'snapshots_per_job', lambda: 2)
    path, engine = _db(tmp_path)
    with Session(engine) as session:
        repo = JobRepository(session)
        base = dict(company_name='Acme', title='Engineer', normalized_title='engineer', location='Santa Clara, CA, United States', canonical_url='https://example.com/1',
                    application_url='https://example.com/1', source_ats='direct', status=JobStatus.NEW, eligibility=EligibilityStatus.ELIGIBLE, role_type='FULL_TIME')
        job, created, _ = repo.upsert_job({**base, 'description': 'v0', 'description_hash': 'h0', 'raw_source_data': {'v': 0}})
        assert created
        for v in range(1, 6):
            repo.upsert_job({**base, 'description': f'v{v}', 'description_hash': f'h{v}', 'raw_source_data': {'v': v}})
        session.commit()
        kept = session.query(JobSnapshot).filter_by(job_id=job.id).order_by(JobSnapshot.id).all()
        assert len(kept) == 2 and kept[-1].raw_data == {'v': 5}


def test_compact_returns_free_space_to_the_filesystem(tmp_path):
    path, engine = _db(tmp_path)
    with Session(engine) as session:
        job = _job(session, 1)
        for i in range(400):
            session.add(JobSnapshot(job_id=job.id, snapshot_date=utc_now(), status=job.status, description_hash=str(i), raw_data={'blob': 'x' * 4000}))
        session.commit()
        session.query(JobSnapshot).delete(); session.commit()
    engine.dispose()
    before = maintenance.file_stats(path)
    assert before['free_share'] > 0.5
    result = maintenance.compact(path)
    assert result['after']['bytes'] < before['bytes'] and result['after']['free_bytes'] == 0
