"""Tests for JobLifecyclePipeline, active verification, and application state preservation."""

from unittest.mock import MagicMock, patch
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from jobagent.db.models import Base, Job, JobStatus, ScoreBreakdown
from jobagent.db.repository import JobRepository
from jobagent.tracking.applications import ApplicationTracker
from jobagent.tracking.lifecycle import JobLifecyclePipeline


@pytest.fixture
def session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    sess = Session()
    yield sess
    sess.close()


def test_applied_job_never_resurrected_after_rediscovery(session):
    """
    CRITICAL TEST REQUIREMENT:
    A job previously marked APPLIED must never reappear after rediscovery.
    """
    pipeline = JobLifecyclePipeline(session)
    tracker = ApplicationTracker(session)
    repo = JobRepository(session)

    raw_job = {
        "external_req_id": "APPLIED-REQ-001",
        "company_name": "Zoox",
        "title": "Hardware Integration Engineer",
        "description": "Vehicle sensor suite and packaging. Requirements: BS Mechanical Engineering.",
        "location": "Foster City, CA",
        "canonical_url": "https://boards.greenhouse.io/zoox/jobs/112233",
        "source_ats": "greenhouse",
    }

    # First discovery
    pipeline.process_discovered_jobs([raw_job])
    job = repo.get_job_by_canonical_url("https://boards.greenhouse.io/zoox/jobs/112233")
    assert job is not None
    assert job.status == JobStatus.NEW

    # Candidate applies
    tracker.mark_applied(str(job.id), notes="Submitted via official portal")
    assert job.status == JobStatus.APPLIED

    # Pipeline runs again with same job rediscovered
    pipeline.process_discovered_jobs([raw_job])

    # Re-fetch from DB
    refreshed_job = repo.get_job_by_id(job.id)
    assert refreshed_job.status == JobStatus.APPLIED, "CRITICAL ERROR: APPLIED job was resurrected!"


def test_temporary_scraper_failure_does_not_mark_job_closed(session):
    """
    CRITICAL TEST REQUIREMENT:
    A temporary scraper failure must not mark a job CLOSED.
    Never mark a job CLOSED because of timeout, HTTP error, rate limiting, CAPTCHA, or temporary scraper failure.
    """
    repo = JobRepository(session)
    pipeline = JobLifecyclePipeline(session)

    job_data = {
        "external_req_id": "FAIL-TEST-001",
        "company_name": "Anduril",
        "title": "Mechanical Engineer, Hardware",
        "description": "Robotics and airborne systems.",
        "description_hash": "anduril_hash_1",
        "canonical_url": "https://boards.greenhouse.io/andurilindustries/jobs/554433",
        "application_url": "https://boards.greenhouse.io/andurilindustries/jobs/554433",
        "source_ats": "greenhouse",
        "status": JobStatus.ACTIVE,
        "location": "United States",
    }
    job, _, _ = repo.upsert_job(job_data)
    session.commit()

    # Mock scraper to simulate network timeout / 500 error / temporary exception
    with patch("jobagent.tracking.lifecycle.get_scraper_for_ats") as mock_factory:
        mock_scraper = MagicMock()
        # Returns active=True, None on temporary error as specified by BaseScraper contract
        mock_scraper.check_status.return_value = (True, None)
        mock_factory.return_value = mock_scraper

        closed_count = pipeline.verify_active_jobs(max_check=10)
        assert closed_count == 0

        # Verify job status is still ACTIVE
        refreshed = repo.get_job_by_id(job.id)
        assert refreshed.status == JobStatus.ACTIVE


def test_positive_closure_evidence_marks_job_closed(session):
    repo = JobRepository(session)
    pipeline = JobLifecyclePipeline(session)

    job_data = {
        "external_req_id": "CLOSE-TEST-001",
        "company_name": "Zipline",
        "title": "Flight Test Engineer",
        "description": "Autonomous drone testing.",
        "description_hash": "zipline_hash_1",
        "canonical_url": "https://boards.greenhouse.io/zipline/jobs/998811",
        "application_url": "https://boards.greenhouse.io/zipline/jobs/998811",
        "source_ats": "greenhouse",
        "status": JobStatus.ACTIVE,
        "location": "United States",
    }
    job, _, _ = repo.upsert_job(job_data)
    session.commit()

    # Mock scraper returning positive closure evidence (e.g. 404 Not Found)
    with patch("jobagent.tracking.lifecycle.get_scraper_for_ats") as mock_factory:
        mock_scraper = MagicMock()
        mock_scraper.check_status.return_value = (False, "HTTP 404 Not Found")
        mock_factory.return_value = mock_scraper

        # One sighting is not enough: a site flapping through maintenance once answered 404 for a live job.
        assert pipeline.verify_active_jobs(max_check=10) == 0
        assert repo.get_job_by_id(job.id).status == JobStatus.ACTIVE
        closed_count = pipeline.verify_active_jobs(max_check=10)
        assert closed_count == 1

        refreshed = repo.get_job_by_id(job.id)
        assert refreshed.status == JobStatus.CLOSED


def _open_job(repo, url, ats='direct'):
    name = url.rsplit('/', 1)[-1]  # distinct roles: same company, title and text would merge as duplicates
    job, _, _ = repo.upsert_job(dict(company_name='Test', title=f'Mechanical Engineer {name}', description=f'BS in Mechanical Engineering. {name}', external_req_id=name,
                                     canonical_url=url, application_url=url, source_ats=ats, location='United States', status=JobStatus.ACTIVE))
    return job


def test_a_live_answer_between_two_removals_keeps_the_posting(session):
    repo = JobRepository(session)
    job = _open_job(repo, 'https://example.com/flapping')
    session.commit()
    pipeline = JobLifecyclePipeline(session)
    with patch('jobagent.tracking.lifecycle.get_scraper_for_ats') as factory:
        factory.return_value.check_status.side_effect = [(False, 'HTTP 404 Not Found'), (True, None), (False, 'HTTP 404 Not Found')]
        for _ in range(3):
            assert pipeline.verify_active_jobs() == 0
    assert job.status == JobStatus.ACTIVE


def test_postings_the_scan_listed_are_not_checked_again(session):
    from datetime import timedelta
    from jobagent.db.models import utc_now
    repo = JobRepository(session)
    listed, unlisted = _open_job(repo, 'https://example.com/listed'), _open_job(repo, 'https://example.com/unlisted')
    scan_started = utc_now()
    unlisted.last_seen = scan_started - timedelta(days=2)
    listed.last_seen = scan_started + timedelta(minutes=5)
    session.commit()
    pipeline = JobLifecyclePipeline(session)
    with patch('jobagent.tracking.lifecycle.get_scraper_for_ats') as factory:
        factory.return_value.check_status.return_value = (True, None)
        pipeline.verify_active_jobs(seen_before=scan_started)
        assert [call.args[0] for call in factory.return_value.check_status.call_args_list] == ['https://example.com/unlisted']


def test_workday_board_stored_as_direct_is_checked_by_the_workday_api(session):
    repo = JobRepository(session)
    _open_job(repo, 'https://acme.wd5.myworkdayjobs.com/External/job/Austin-TX/Engineer_R1')
    session.commit()
    with patch('jobagent.tracking.lifecycle.get_scraper_for_ats') as factory:
        factory.return_value.check_status.return_value = (True, None)
        JobLifecyclePipeline(session).verify_active_jobs()
        factory.assert_called_once_with('workday')


@pytest.mark.parametrize('status,body,active', [
    (200, {'jobPostingInfo': {'title': 'Engineer', 'canApply': True}}, True),
    (404, {'errorCode': 'S21', 'httpStatus': 404}, False),
    (403, {'errorCode': 'S22', 'message': 'permission denied'}, False),
    (403, {'errorCode': 'S99'}, True),          # some other refusal is not evidence
    (503, {'message': 'unavailable'}, True),
    (200, {'jobPostingInfo': {'title': 'Engineer', 'canApply': False}}, False),
])
def test_workday_status_reads_the_posting_api(status, body, active):
    from jobagent.scrapers.workday import WorkdayScraper
    scraper = WorkdayScraper()
    response = MagicMock(status_code=status)
    response.json.return_value = body
    with patch.object(scraper, 'get_with_retry', return_value=response) as get:
        result = scraper.check_status('https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin-TX/Engineer_R1')
    assert get.call_args.args[0] == 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/job/Austin-TX/Engineer_R1'
    assert result[0] is active and (result[1] is None) is active


def test_unconfirmed_failures_never_close_listing(session):
    repo=JobRepository(session)
    job,_,_=repo.upsert_job(dict(company_name='Test',title='Mechanical Engineer',description='BS in Mechanical Engineering.',canonical_url='https://example.com/open',application_url='https://example.com/open',source_ats='direct',location='United States',status=JobStatus.ACTIVE))
    session.commit()
    pipeline=JobLifecyclePipeline(session)
    with patch('jobagent.tracking.lifecycle.get_scraper_for_ats') as factory:
        factory.return_value.check_status.return_value=(False,None)
        for _ in range(6):
            assert pipeline.verify_active_jobs()==0
    assert job.status==JobStatus.ACTIVE


def test_scraping_preserves_age_and_role_type_and_application(session):
    from datetime import timedelta
    from jobagent.db.models import utc_now
    repo=JobRepository(session)
    raw=dict(company_name='Test',title='Mechanical Engineer',description='BS in Mechanical Engineering.',canonical_url='https://example.com/role',application_url='https://example.com/role',source_ats='direct',location='United States')
    job,_,_=repo.upsert_job(raw)
    job.discovery_date=utc_now()-timedelta(days=60)
    repo.record_application(job.id,notes='receipt verified')
    session.commit()
    old_date=job.discovery_date
    raw['employment_type']='Intern'
    pipeline=JobLifecyclePipeline(session)
    pipeline.process_discovered_jobs([raw])
    assert job.status==JobStatus.APPLIED
    assert job.role_type=='INTERNSHIP'
    assert job.discovery_date==old_date
    assert job.urgency_score<50
    assert job.score_breakdown.priority==job.priority_score


def test_feed_cannot_replace_employer_description(session):
    repo=JobRepository(session)
    raw=dict(company_name='Test',title='Mechanical Engineer',description='Required: BS in Mechanical Engineering. 1 year experience.',canonical_url='https://example.com/role',application_url='https://example.com/role',source_ats='direct',location='United States')
    pipeline=JobLifecyclePipeline(session)
    pipeline.process_discovered_jobs([raw])
    job=repo.get_job_by_canonical_url(raw['canonical_url'])
    description=job.description
    raw['description']='Source: Early-Career & New Grad Network'
    pipeline.process_discovered_jobs([raw])
    assert job.description==description
    assert job.eligibility.value!='UNCERTAIN'


def test_postings_no_track_accepts_are_not_stored_or_are_removed(session):
    repo=JobRepository(session)
    pipeline=JobLifecyclePipeline(session)
    senior=dict(company_name='Test',title='Senior Mechanical Engineer',description='Required: BS in Mechanical Engineering. 8 years experience.',canonical_url='https://example.com/senior',application_url='https://example.com/senior',source_ats='direct',location='United States')
    pipeline.process_discovered_jobs([senior])
    assert repo.get_job_by_canonical_url(senior['canonical_url']) is None
    ok=dict(company_name='Test',title='Mechanical Engineer I',description='Required: BS in Mechanical Engineering.',canonical_url='https://example.com/ok',application_url='https://example.com/ok',source_ats='direct',location='United States')
    pipeline.process_discovered_jobs([ok])
    job=repo.get_job_by_canonical_url(ok['canonical_url'])
    assert set(job.track_results)=={'mechanical','data'} and job.track_results['data']['eligibility']=='INELIGIBLE'
    ok['description']='Required: BS in Mechanical Engineering. 8 years experience.'
    pipeline.process_discovered_jobs([ok])
    session.commit()
    assert repo.get_job_by_canonical_url(ok['canonical_url']) is None


def test_reclassification_recovers_lever_requirements_and_preserves_history(session):
    from jobagent.tracking.reclassify import reclassify_jobs
    from jobagent.db.models import EligibilityStatus, utc_now
    discovered = utc_now()
    job = Job(company_name="Example", title="Mechanical Engineer I", normalized_title="mechanical engineer i",
        description="Build great hardware.", location="California, USA",
        source_ats="lever", canonical_url="https://jobs.lever.co/example/1",
        application_url="https://jobs.lever.co/example/1",
        status=JobStatus.APPLIED, discovery_date=discovered,
        raw_source_data={"descriptionPlain":"Build great hardware.", "lists":[
            {"text":"Requirements", "content":"<li>Five years of mechanical engineering experience.</li>"}]})
    session.add(job)
    session.commit()
    original_date = job.discovery_date
    reclassify_jobs(session)
    assert job.eligibility == EligibilityStatus.LIKELY_INELIGIBLE
    assert "Five years" in job.description
    assert job.status == JobStatus.APPLIED
    assert job.discovery_date == original_date
