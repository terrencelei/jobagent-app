"""Worker capacity remains consistent across settings, API and the live picker."""
from pathlib import Path
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from jobagent import settings
from jobagent.ui import application_routes


def test_worker_ceiling_supports_twenty_and_larger_user_selected_limits():
    spec = settings.BY_KEY['workers.max_parallelism']
    assert settings.default(spec.key) == 20
    for value in (1, 20, 35, 50):
        assert settings.coerce(spec, value) == value
    for value in (0, 51):
        with pytest.raises(ValueError):
            settings.coerce(spec, value)


def test_control_api_accepts_larger_capacities_and_rejects_out_of_range(monkeypatch):
    calls = []
    class Runner:
        def control(self, action, parallelism, engine):
            calls.append((action, parallelism, engine))
            return {'parallelism': parallelism}
    monkeypatch.setattr(application_routes, 'get_runner', lambda: Runner())
    app = FastAPI()
    app.include_router(application_routes.router)
    client = TestClient(app)
    headers = {'X-JobAgent-Application':'1'}
    for value in (20, 50):
        response = client.post('/api/applications/control', headers=headers,
                               json={'action':'configure', 'parallelism':value})
        assert response.status_code == 200
        assert response.json()['parallelism'] == value
    for value in (0, 51):
        assert client.post('/api/applications/control', headers=headers,
                           json={'action':'configure', 'parallelism':value}).status_code == 422
    assert len(calls) == 2
