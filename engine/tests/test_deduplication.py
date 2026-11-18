"""Tests for multi-vector deduplication and entity resolution."""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from jobagent.db.models import Base, Job, JobStatus
from jobagent.db.repository import JobRepository
from jobagent.processing.deduplicate import Deduplicator


@pytest.fixture
def session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    sess = Session()
    yield sess
    sess.close()


def test_deduplication_by_canonical_url(session):
    repo = JobRepository(session)
    job_data_1 = {
        "external_req_id": "REQ-100",
        "company_name": "Freeform",
        "title": "Mechanical Engineer",
        "normalized_title": "Mechanical Engineer",
        "location": "Los Angeles, California, United States",
        "description": "Design 3D printing mechanisms and hardware.",
        "description_hash": "hash_111",
        "canonical_url": "https://boards.greenhouse.io/freeform/jobs/100",
        "application_url": "https://boards.greenhouse.io/freeform/jobs/100",
        "source_ats": "greenhouse",
    }
    job1, is_new, is_updated = repo.upsert_job(job_data_1)
    session.commit()
    assert is_new is True

    # Incoming observation with tracking URL that normalizes to same canonical URL
    dedup = Deduplicator(session)
    incoming = {
        "canonical_url": "https://boards.greenhouse.io/freeform/jobs/100?utm_source=linkedin",
        "company_name": "Freeform",
        "title": "Mechanical Engineer",
    }
    match, reason = dedup.resolve_job(incoming)
    assert match is not None
    assert match.id == job1.id
    assert reason == "canonical_url_match"


def test_deduplication_by_req_id(session):
    repo = JobRepository(session)
    job_data = {
        "external_req_id": "REQ-2027-ME",
        "company_name": "SpaceX",
        "title": "Starlink Mechanical Engineer",
        "normalized_title": "Starlink Mechanical Engineer",
        "location": "Hawthorne, California, United States",
        "description": "Develop satellite structural packaging.",
        "description_hash": "hash_222",
        "canonical_url": "https://spacex.com/careers/req-2027",
        "application_url": "https://spacex.com/careers/req-2027",
        "source_ats": "greenhouse",
    }
    job1, is_new, _ = repo.upsert_job(job_data)
    session.commit()

    dedup = Deduplicator(session)
    # Re-posting from different URL but matching req ID and company
    incoming = {
        "canonical_url": "https://boards.greenhouse.io/spacex/jobs/9999",
        "external_req_id": "REQ-2027-ME",
        "company_name": "SpaceX",
    }
    match, reason = dedup.resolve_job(incoming)
    assert match is not None
    assert match.id == job1.id
    assert reason == "req_id_match"


def test_distinct_req_ids_not_merged(session):
    repo = JobRepository(session)
    job1_data = {
        "external_req_id": "REQ-001",
        "company_name": "Apple",
        "title": "Product Design Engineer",
        "normalized_title": "Product Design Engineer",
        "location": "Cupertino, California, United States",
        "description": "Enclosure architecture and DFM.",
        "description_hash": "hash_apple_1",
        "canonical_url": "https://jobs.apple.com/en-us/details/001",
        "application_url": "https://jobs.apple.com/en-us/details/001",
        "source_ats": "direct",
    }
    repo.upsert_job(job1_data)
    session.commit()

    dedup = Deduplicator(session)
    # Similar title, same company, but genuinely different requisition ID
    incoming = {
        "external_req_id": "REQ-002",
        "company_name": "Apple",
        "title": "Product Design Engineer",
        "canonical_url": "https://jobs.apple.com/en-us/details/002",
        "description": "iPhone display mechanism architecture.",
        "description_hash": "hash_apple_2",
    }
    match, reason = dedup.resolve_job(incoming)
    assert match is None


def test_greenhouse_host_alias_preserves_applied_job(session):
    repo=JobRepository(session)
    raw=dict(company_name='Test',title='Mechanical Engineer',location='San Francisco, California, United States',description='Mechanical design.',canonical_url='https://boards.greenhouse.io/test/jobs/1234',application_url='https://boards.greenhouse.io/test/jobs/1234',source_ats='greenhouse')
    job,_,_=repo.upsert_job(raw)
    repo.record_application(job.id)
    session.commit()
    raw['canonical_url']='https://job-boards.greenhouse.io/test/jobs/1234'
    raw['description']='Updated mechanical design.'
    again,is_new,_=repo.upsert_job(raw)
    assert again.id==job.id and not is_new
    assert again.status==JobStatus.APPLIED
