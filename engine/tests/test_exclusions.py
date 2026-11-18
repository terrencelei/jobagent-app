"""A dismissal must outlive the posting it was made against."""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from jobagent.db.models import Base, Job, JobExclusion, JobStatus
from jobagent.tracking.exclusions import add_exclusion, dismiss_job, load_exclusions, matches


@pytest.fixture
def session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def _job(session, **kw):
    j = Job(company_name=kw.get("company", "Mach Industries"),
            title=kw.get("title", "May 2027 New Graduate Engineer, Software"),
            canonical_url=kw.get("url", "https://job-boards.greenhouse.io/mach/jobs/1"),
            application_url=kw.get("url", "https://job-boards.greenhouse.io/mach/jobs/1"),
            source_ats="greenhouse", status=JobStatus.ACTIVE,
            description="", description_hash=kw.get("h", "h1"))
    session.add(j); session.commit()
    return j


def test_dismissed_job_leaves_the_dashboard(session):
    j = _job(session)
    dismiss_job(session, j, "Software track, not his discipline")
    session.commit()
    assert j.status == JobStatus.IGNORED
    assert "not his discipline" in j.eligibility_reasons


def test_the_same_req_is_blocked_at_a_new_url(session):
    """Rediscovery is the whole point: the URL changes, the judgement should not."""
    j = _job(session)
    dismiss_job(session, j, "Software track")
    session.commit()
    hit = matches(load_exclusions(session),
                  title="May 2027 New Graduate Engineer, Software",
                  company="Mach Industries",
                  url="https://job-boards.greenhouse.io/mach/jobs/9999")
    assert hit is not None


def test_an_unrelated_role_at_the_same_employer_is_untouched(session):
    j = _job(session)
    dismiss_job(session, j, "Software track")
    session.commit()
    assert matches(load_exclusions(session),
                   title="May 2027 New Graduate Engineer, Mechanical",
                   company="Mach Industries", url="") is None


def test_a_title_pattern_can_cover_a_category(session):
    add_exclusion(session, reason="Not his discipline", scope="title_pattern",
                  value=r"\bRF\b|\bradio frequency\b")
    session.commit()
    ex = load_exclusions(session)
    assert matches(ex, title="RF Systems Engineer I", company="Rocket Lab", url="") is not None
    assert matches(ex, title="Mechanical Engineer I", company="Rocket Lab", url="") is None


def test_a_pattern_can_be_limited_to_one_employer(session):
    add_exclusion(session, reason="Only at this employer", scope="title_pattern",
                  value=r"Systems Engineer", company_name="Rocket Lab")
    session.commit()
    ex = load_exclusions(session)
    assert matches(ex, title="Systems Engineer", company="Rocket Lab", url="") is not None
    assert matches(ex, title="Systems Engineer", company="Anduril", url="") is None


def test_a_broken_pattern_is_refused_when_recorded(session):
    with pytest.raises(Exception):
        add_exclusion(session, reason="bad", scope="title_pattern", value="[unclosed")
