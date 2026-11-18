"""Test configuration and fixtures for JobAgent."""

import os
import tempfile
from pathlib import Path as _Path

# Tests read a made-up student's configuration and write to a throwaway data folder, never a real install.
os.environ['JOBAGENT_CONFIG_DIR'] = str(_Path(__file__).parent / 'fixtures' / 'config')
os.environ['JOBAGENT_DATA_DIR'] = tempfile.mkdtemp(prefix='jobagent-test-data-')
os.environ.setdefault('JOBAGENT_APPLICATION_AGENT_DIR', tempfile.mkdtemp(prefix='jobagent-test-agent-'))
os.environ.pop('JOBAGENT_HOME', None)

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from jobagent.db.models import Base
from jobagent.db.repository import init_db


@pytest.fixture
def in_memory_db():
    """Create a fresh in-memory SQLite database for testing."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()

    # Seed initial test facts & companies
    init_db(db_url="sqlite:///:memory:")

    yield session
    session.close()


@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    """Tests never read or write his real settings, active track or rule-tuning state."""
    from jobagent import settings
    from jobagent.processing import tracks
    from jobagent.services import rule_tuner
    state = tmp_path / '.jobagent-state'
    state.mkdir()
    monkeypatch.setattr(settings, 'settings_path', lambda: state / 'settings.json')
    settings._cache.update(stamp=None, overrides={})
    monkeypatch.setattr(tracks, '_state_path', lambda: state / 'active-track.json')
    monkeypatch.setattr(rule_tuner, '_data_dir', lambda: state)
    from jobagent.discovery import email_alerts
    monkeypatch.setattr(email_alerts, '_state_path', lambda: state / 'email-alerts.json')
    from jobagent.discovery import indeed
    monkeypatch.setattr(indeed, '_state_path', lambda: state / 'indeed.json')
    from jobagent.discovery import linkedin
    monkeypatch.setattr(linkedin, '_state_path', lambda: state / 'linkedin.json')
    from jobagent.discovery import handshake
    monkeypatch.setattr(handshake, '_data_dir', lambda: state)
    from jobagent.processing import application_caps
    monkeypatch.setattr(application_caps, '_path', lambda: state / 'application-caps.json')
    # The dashboard's /api/status and /api/jobs reach the runner singleton, whose loop saves his live
    # data/application-runner/queue.json. Tests that need a runner pass their own.
    from jobagent.services import application_runner
    from jobagent.ui import application_routes
    def no_live_runner():
        raise RuntimeError('tests use their own ApplicationRunner, never the live queue')
    monkeypatch.setattr(application_runner, 'get_runner', no_live_runner)
    monkeypatch.setattr(application_routes, 'get_runner', no_live_runner)
    # Secrets go to a file in the test's folder, never the machine's credential store.
    from jobagent import vault
    monkeypatch.setattr(vault, '_keyring', lambda: None)
    monkeypatch.setattr(vault, '_fallback_path', lambda: state / 'secrets.json')
    # Tests run against a set-up install unless a test removes the record (tests/test_setup.py).
    from jobagent.ui import setup_routes
    monkeypatch.setattr(setup_routes, '_marker_path', lambda: state / 'setup.json')
    (state / 'setup.json').write_text('{"completed_at": "2026-01-01T00:00:00+00:00", "version": 1}')
    # The resume check and learned drafts call the claude CLI; tests that need them opt in.
    (state / 'settings.json').write_text('{"overrides": {"workers.resume_tailoring": false, "workers.learned_drafts": false}}')
    yield
