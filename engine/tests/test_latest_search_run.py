from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from jobagent.db.models import Base, SearchRun
from jobagent.db.repository import JobRepository


def test_one_source_imports_do_not_hide_the_latest_full_scan():
    engine = create_engine('sqlite:///:memory:'); Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    repo = JobRepository(session)
    assert repo.get_latest_search_run() is None
    session.add(SearchRun(sources_checked=1)); session.commit()
    assert repo.get_latest_search_run().sources_checked == 1  # nothing better yet
    session.add(SearchRun(sources_checked=170)); session.add(SearchRun(sources_checked=1)); session.add(SearchRun(sources_checked=1)); session.commit()
    assert repo.get_latest_search_run().sources_checked == 170


def test_applied_tab_filters_by_how_recently_he_applied():
    from datetime import datetime, timedelta, timezone
    from jobagent.db.models import Job, Application, JobStatus, EligibilityStatus
    from jobagent.ui.dashboard import jobs_query
    engine = create_engine('sqlite:///:memory:'); Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    now = datetime.now(timezone.utc)
    for i, days in [(1, 0.5), (2, 5), (3, 20), (4, 60)]:
        session.add(Job(id=i, company_name='Co', title=f'T{i}', normalized_title=f't{i}', description='d', canonical_url=f'https://x/{i}',
                        application_url=f'https://x/{i}', source_ats='direct', status=JobStatus.APPLIED, eligibility=EligibilityStatus.ELIGIBLE))
        session.add(Application(job_id=i, applied_date=now - timedelta(days=days)))
    session.commit()
    ids = lambda d: sorted(j.id for j in jobs_query(session, 'applied', now=now, applied_days=d).all())
    assert ids(1) == [1] and ids(7) == [1, 2] and ids(30) == [1, 2, 3] and ids(None) == [1, 2, 3, 4]
