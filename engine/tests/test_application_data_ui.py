from contextlib import contextmanager
from pathlib import Path
import threading

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from test_application_export import session, add  # noqa: F401
from jobagent.ui import application_export, application_routes

ROOT = Path(__file__).resolve().parents[1]


def test_csv_button_downloads_the_recorded_history(session, monkeypatch, tmp_path):
    add(session)
    @contextmanager
    def sessions():
        yield session
    monkeypatch.setattr(application_export, 'get_db_session', sessions)
    app = FastAPI(); app.include_router(application_export.router)
    from fastapi.responses import HTMLResponse, FileResponse
    import socket
    import time
    import uvicorn
    @app.get('/')
    def index(): return HTMLResponse((ROOT / 'src/jobagent/ui/templates/index.html').read_text())
    @app.get('/{asset}')
    def asset(asset: str):
        path = ROOT / 'src/jobagent/ui' / asset
        return FileResponse(path) if path.is_file() else HTMLResponse('', status_code=404)
    listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen()
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level='error', lifespan='off'))
    thread = threading.Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True); thread.start()
    deadline = time.monotonic() + 5
    while not server.started and time.monotonic() < deadline: time.sleep(.01)
    assert server.started
    pw = pytest.importorskip('playwright.sync_api')
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(accept_downloads=True)
            page.route('https://**', lambda r: r.abort())
            page.goto(f'http://127.0.0.1:{port}/')
            with page.expect_download() as event:
                page.locator('#exportApplicationsBtn').click()
            download = event.value
            assert download.suggested_filename == 'jobagent-application-history.csv'
            data = Path(download.path()).read_bytes()
            assert data.startswith(b'\xef\xbb\xbf') and b'APPLIED' in data
            browser.close()
    finally:
        server.should_exit = True; thread.join(timeout=5); listener.close()


def test_background_agent_api_lists_real_processes_including_approval_work(monkeypatch):
    class Runner:
        lock = threading.RLock()
        data = {'jobs': [{'job_id': 1, 'company': 'One', 'title': 'Mechanical Engineer', 'url': 'https://one.example/jobs/1', 'status': 'needs_human'},
                         {'job_id': 2, 'company': 'Two', 'title': 'Intern', 'status': 'needs_approval'},
                         {'job_id': 3, 'company': 'Three', 'status': 'needs_approval', 'background_triage': {'state': 'needs_user'}}]}
    class Desk:
        lock = threading.RLock()
        processes = {1: object(), 2: object()}
        def chat(self, job_id): return {'engine': 'codex'}
    monkeypatch.setattr(application_routes, 'get_runner', lambda: Runner())
    monkeypatch.setattr(application_routes, 'get_desk', lambda: Desk())
    app = FastAPI(); app.include_router(application_routes.router)
    response = TestClient(app).get('/api/applications/background-agents')
    assert response.status_code == 200
    body = response.json()
    assert body['active'] == 2
    assert [a['category'] for a in body['agents']] == ['help', 'approval']
    assert body['waiting'][0]['state'] == 'needs_user'
    # Every list on the panel links the posting itself, so the agents and the waiting roles carry its address.
    assert body['agents'][0]['url'] == 'https://one.example/jobs/1' and body['waiting'][0]['url'] == ''


def test_background_agent_cards_show_each_codex_assignment():
    pw = pytest.importorskip('playwright.sync_api')
    status = {'running': True, 'configured': True, 'parallelism': 20, 'max_parallelism': 20,
              'engine': 'codex', 'counts': {}, 'workers': [], 'slots': [], 'queue': [], 'up_next': []}
    agents = {'active': 2, 'limit': 6, 'agents': [
        {'job_id': 1, 'company': 'One', 'title': 'Mechanical Engineer', 'engine': 'codex', 'category': 'help'},
        {'job_id': 2, 'company': 'Two', 'title': 'Intern', 'engine': 'codex', 'category': 'approval'}]}
    with pw.sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        def route(r):
            if r.request.url.endswith('/background-agents'):
                r.fulfill(json=agents)
            elif '/api/applications' in r.request.url:
                r.fulfill(json=status)
            else:
                r.fulfill(body='<div id="applicationPanel"></div>', content_type='text/html')
        page.route('http://127.0.0.1:8123/**', route)
        page.goto('http://127.0.0.1:8123/')
        page.add_script_tag(path=str(ROOT / 'src/jobagent/ui/applications.js'))
        page.evaluate('openApplications()')
        pw.expect(page.locator('#appBackgroundAgents')).to_contain_text('2 working')
        pw.expect(page.locator('#appBackgroundAgents')).to_contain_text('Help repair')
        pw.expect(page.locator('#appBackgroundAgents')).to_contain_text('Approval preparation')
        assert page.locator('#appBackgroundAgents a[href="/help?job=1"]').count() == 1
        browser.close()
