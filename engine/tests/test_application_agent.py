"""ApplicationAgent loads verified candidate facts (used for the dashboard's cover-letter drafts)."""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from jobagent.agents.application_agent import ApplicationAgent
from jobagent.db.models import Base
from jobagent.db.repository import init_db


@pytest.fixture
def session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    sess = Session()
    # Initialize DB facts
    init_db(session=sess)
    yield sess
    sess.close()


def test_facts_authoritative_provenance(session):
    agent = ApplicationAgent(session)
    # Check that key candidate facts exist and are loaded
    assert agent.facts.get("citizenship") == "U.S. Citizen"
    assert agent.facts.get("gpa") in ("3.50", "3.5 / 4.0")
    assert agent.facts.get("expected_graduation") == "June 2027"
