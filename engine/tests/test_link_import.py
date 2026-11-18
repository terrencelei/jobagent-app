"""A posting he pastes as a link is read, stored, labelled Good fit and queued."""
import json
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from jobagent.db.models import Base, Job, JobStatus
from jobagent.discovery import link_import as li
from jobagent.ui import application_routes

BODY = ("Acme Robotics\nMechanical Engineer, Actuators\nSanta Clara, CA\nApply now\n" +
        "Design and test actuators for our robots. " * 30 + "\nRequired: Bachelor's degree in Mechanical Engineering.")
LD = json.dumps({'@context': 'https://schema.org', '@type': 'JobPosting', 'title': 'Mechanical Engineer, Actuators',
                 'hiringOrganization': {'@type': 'Organization', 'name': 'Acme Robotics'}, 'employmentType': 'FULL_TIME',
                 'datePosted': '2026-10-01', 'jobLocation': [{'@type': 'Place', 'address': {'addressLocality': 'Santa Clara', 'addressRegion': 'CA', 'addressCountry': 'US'}}]})


def page(url, text=BODY, title='Mechanical Engineer, Actuators - Acme Robotics', h1=('Mechanical Engineer, Actuators',), ld=(LD,), **extra):
    return {'url': url, 'text': text, 'title': title, 'h1': list(h1), 'og_title': '', 'og_site': '', 'ld_json': list(ld), **extra}


class FakeReader:
    pages = {}
    def __enter__(self): return self
    def __exit__(self, *a): pass
    def read(self, url): return self.pages.get(url, {'url': url, 'text': '', 'title': '', 'h1': [], 'og_title': '', 'og_site': '', 'ld_json': []})


class FakeRunner:
    def __init__(self): self.calls = []
    def queue(self, ids, position='end', allow_other_roles=False, mark_fit=False):
        self.calls.append((ids, position, allow_other_roles, mark_fit)); return {'added': len(ids), 'duplicate': 0, 'labeled': []}


@pytest.fixture
def sessions(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 't.db'), connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    @contextmanager
    def scope():
        with Session(engine) as session:
            yield session
    return scope


@pytest.fixture
def no_lock(monkeypatch):
    monkeypatch.setattr(li, '_claim_pipeline', lambda *a, **k: (lambda: None))
    monkeypatch.setattr('jobagent.processing.track_eval.runner_job_ids', lambda *a, **k: set())


def test_the_page_json_ld_names_company_title_and_location():
    found = li.guess(page('https://careers.acme.com/jobs/12345'))
    assert (found['company'], found['title'], found['location'], found['employment_type']) == ('Acme Robotics', 'Mechanical Engineer, Actuators', 'Santa Clara, CA, US', 'Full-time')
    assert found['from_ld']


def test_without_json_ld_the_heading_title_and_ats_address_are_used():
    found = li.guess(page('https://job-boards.greenhouse.io/archer56/jobs/7985643003', ld=(), h1=(), title='Flight Test Engineer | Archer Aviation'))
    assert found == {'company': 'Archer', 'title': 'Flight Test Engineer', 'location': 'Santa Clara, CA', 'employment_type': None, 'posted': None, 'from_ld': False}
    found = li.guess(page('https://example.com/x', ld=(), h1=('Careers',), title='Careers - Example'))
    assert found['title'] == 'Example' or found['title'] == ''  # nothing usable reads as a posting title


def test_ats_company_names_are_cleaned_up():
    assert li.company_from_url('https://job-boards.greenhouse.io/skildai-careers/jobs/5454688008') == 'Skildai'
    assert li.company_from_url('https://nvidia.wd5.myworkdayjobs.com/nvidiaexternalcareersite/job/x') == 'Nvidia'
    assert li.company_name('2100 NVIDIA USA') == 'NVIDIA' and li.company_name({'name': 'Formlabs Inc.'}) == 'Formlabs'


def test_an_application_form_link_is_completed_from_the_posting_page_behind_it():
    class Reader(FakeReader):
        pages = {'https://jobs.lever.co/humble/abc/apply': page('https://jobs.lever.co/humble/abc/apply', text='Apply for this job\nName\nEmail\nSubmit ' * 8, ld=(), h1=('Hardware Integration Engineer',)),
                 'https://jobs.lever.co/humble/abc': page('https://jobs.lever.co/humble/abc', ld=())}
    read = li.read_posting_page('https://jobs.lever.co/humble/abc/apply', Reader())
    assert read['url'] == 'https://jobs.lever.co/humble/abc/apply' and read['text'] == BODY
    assert li.guess(read)['location'] == 'Santa Clara, CA'


def test_a_posting_rejected_by_every_track_is_still_stored_labelled_and_queued(sessions, no_lock):
    FakeReader.pages = {'https://careers.acme.com/jobs/12345': page('https://careers.acme.com/jobs/12345', text=BODY.replace('Mechanical Engineer', 'Patent Attorney'), title='Patent Attorney', h1=('Patent Attorney',), ld=(LD.replace('Mechanical Engineer, Actuators', 'Patent Attorney'),))}
    runner = FakeRunner()
    result = li.import_posting('https://careers.acme.com/jobs/12345', {}, True, 'next', reader_factory=FakeReader, sessions=sessions, runner=runner)
    assert result['new'] and result['queued'] and result['labeled'] and result['company'] == 'Acme Robotics'
    with sessions() as session:
        job = session.get(Job, result['job_id'])
        assert job.raw_source_data['source'] == 'link' and job.application_url == 'https://careers.acme.com/jobs/12345'
        assert any(v.get('fit') is True for v in (job.user_fit_label or {}).values()) or (job.user_fit_label or {}).get('fit') is True
    assert runner.calls == [([result['job_id']], 'next', True, True)]


def test_his_stated_details_replace_the_page_and_a_non_us_location_is_refused(sessions, no_lock):
    FakeReader.pages = {'https://careers.acme.com/jobs/1': page('https://careers.acme.com/jobs/1', ld=(), h1=(), title='', text='Apply\n' + 'Design things. ' * 40)}
    with pytest.raises(ValueError, match='company and title'):
        li.import_posting('https://careers.acme.com/jobs/1', {}, False, 'end', reader_factory=FakeReader, sessions=sessions, runner=FakeRunner())
    with pytest.raises(ValueError, match='U.S. work location'):
        li.import_posting('https://careers.acme.com/jobs/1', {'company': 'Acme', 'title': 'Mechanical Engineer', 'location': 'Toronto, Canada'}, False, 'end', reader_factory=FakeReader, sessions=sessions, runner=FakeRunner())
    runner = FakeRunner()
    result = li.import_posting('https://careers.acme.com/jobs/1', {'company': 'Acme', 'title': 'Mechanical Engineer', 'location': 'Austin, TX'}, False, 'end', reader_factory=FakeReader, sessions=sessions, runner=runner)
    assert result['stated'] == ['company', 'title', 'location'] and result['location'] == 'Austin, TX' and not result['queued'] and not runner.calls


def test_an_ignored_posting_is_reopened_and_an_applied_one_is_not_requeued(sessions, no_lock):
    FakeReader.pages = {'https://careers.acme.com/jobs/12345': page('https://careers.acme.com/jobs/12345')}
    with sessions() as session:
        session.add(Job(id=7, company_name='Acme Robotics', title='Mechanical Engineer, Actuators', description='d', location='Santa Clara, CA',
                        canonical_url='https://careers.acme.com/jobs/12345', application_url='https://careers.acme.com/jobs/12345', source_ats='direct',
                        role_type='FULL_TIME', status=JobStatus.IGNORED))
        session.commit()
    result = li.import_posting('https://careers.acme.com/jobs/12345', {}, True, 'end', reader_factory=FakeReader, sessions=sessions, runner=FakeRunner())
    assert result['job_id'] == 7 and not result['new'] and result['previous_status'] == 'IGNORED' and result['status'] == 'NEW'

    class Refusing(FakeRunner):
        def queue(self, *a, **k): raise ValueError('Job 7 must be an eligible, unapplied full-time or internship role')
    with sessions() as session:
        session.get(Job, 7).status = JobStatus.APPLIED; session.commit()
    result = li.import_posting('https://careers.acme.com/jobs/12345', {}, True, 'end', reader_factory=FakeReader, sessions=sessions, runner=Refusing())
    assert result['status'] == 'APPLIED' and not result['queued'] and 'unapplied' in result['queue_error']


def test_unreadable_pages_and_sign_in_walls_are_explained(sessions, no_lock):
    FakeReader.pages = {'https://www.linkedin.com/jobs/view/1': page('https://www.linkedin.com/jobs/view/1', text='Sign in to view this job. ' * 20, ld=())}
    with pytest.raises(ValueError, match="Couldn't read"):
        li.import_posting('https://careers.acme.com/none', {}, True, 'end', reader_factory=FakeReader, sessions=sessions, runner=FakeRunner())
    with pytest.raises(ValueError, match='sign-in or bot check.*company and title'):
        li.import_posting('https://www.linkedin.com/jobs/view/1', {}, True, 'end', reader_factory=FakeReader, sessions=sessions, runner=FakeRunner())
    with pytest.raises(ValueError, match='http'):
        li.import_posting('careers.acme.com/jobs/1', {}, True, 'end', reader_factory=FakeReader, sessions=sessions, runner=FakeRunner())


def test_the_pipeline_lock_is_waited_for_then_given_up():
    import threading
    from jobagent.tracking.lifecycle import PIPELINE_LOCK
    held, done = threading.Event(), threading.Event()
    def scan_storing():
        with PIPELINE_LOCK:
            held.set(); done.wait(5)
    thread = threading.Thread(target=scan_storing); thread.start(); held.wait(5)
    try:
        with pytest.raises(ValueError, match='source scan'):
            li._claim_pipeline(wait=0.01)
    finally:
        done.set(); thread.join()
    li._claim_pipeline(wait=0.01)()


def test_a_scan_still_fetching_sources_does_not_block_a_link(monkeypatch):
    # Regression guard (a16e6ed): add-by-link used to be refused whenever a scan was running. Only the pipeline's
    # write lock (held while a scan stores postings) may block it, so the scan-in-progress flag must not.
    from jobagent.services import scheduler
    monkeypatch.setattr(scheduler, '_is_scanning', True)
    li._claim_pipeline(wait=0.01)()


def test_career_site_names_become_the_company():
    assert li.company_name({'name': 'Ford Global Career Site'}) == 'Ford'
    assert li.site_company('Acme Careers') == 'Acme' and li.site_company('Careers') == '' and li.site_company('SpaceX') == 'SpaceX'


def test_import_route_passes_the_link_and_his_details(monkeypatch):
    seen = {}
    def fake(url, overrides, queue, position):
        seen.update(url=url, overrides=overrides, queue=queue, position=position); return {'job_id': 1, 'queued': queue}
    monkeypatch.setattr('jobagent.discovery.link_import.import_posting', fake)
    app = FastAPI(); app.include_router(application_routes.router); client = TestClient(app)
    headers = {'X-JobAgent-Application': '1'}
    assert client.post('/api/applications/import', json={'url': 'https://careers.acme.com/jobs/1'}).status_code == 403
    response = client.post('/api/applications/import', json={'url': 'https://careers.acme.com/jobs/1', 'location': 'Austin, TX', 'position': 'next'}, headers=headers)
    assert response.status_code == 200 and response.json()['queued'] is True
    assert seen == {'url': 'https://careers.acme.com/jobs/1', 'overrides': {'company': '', 'title': '', 'location': 'Austin, TX'}, 'queue': True, 'position': 'next'}
    assert client.post('/api/applications/import', json={'url': 'https://x.y/1', 'queue': 'yes'}, headers=headers).status_code == 422
    monkeypatch.setattr('jobagent.discovery.link_import.import_posting', lambda *a: (_ for _ in ()).throw(ValueError('No confirmed U.S. work location')))
    assert client.post('/api/applications/import', json={'url': 'https://x.y/1'}, headers=headers).status_code == 409


def test_the_panel_offers_the_link_box_and_sends_the_import():
    from pathlib import Path
    js = Path('src/jobagent/ui/applications.js').read_text()
    assert 'id="appImportForm"' in js and "request('/import',body,180000)" in js and '<option value="only">Save only</option>' in js


def test_a_blocked_job_board_link_is_found_on_the_employer_site_from_his_company_and_title(sessions, no_lock, monkeypatch):
    board = 'https://www.indeed.com/viewjob?jk=6b05719457db22c4'
    official = 'https://boards.greenhouse.io/acme/jobs/555001'
    FakeReader.pages = {
        board: page(board, text='Additional Verification Required. Your Ray ID for this request is 1', title='Just a moment...', h1=('Additional Verification Required',), ld=()),
        official: page(official, text='Acme Robotics\nMechanical Engineer\nSan Francisco, CA\n' + 'Design mechanisms. ' * 40, title='Mechanical Engineer at Acme Robotics', h1=('Mechanical Engineer',), ld=()),
    }
    searched = []
    monkeypatch.setattr(li, '_search_official', lambda posting: searched.append(posting) or ['https://www.linkedin.com/jobs/view/9', official])
    with pytest.raises(ValueError, match='company and title'):
        li.import_posting(board, {}, False, 'end', reader_factory=FakeReader, sessions=sessions, runner=FakeRunner())
    assert not searched
    result = li.import_posting(board, {'company': 'Acme Robotics', 'title': 'Mechanical Engineer', 'location': 'San Francisco, CA'}, False, 'end',
                               reader_factory=FakeReader, sessions=sessions, runner=FakeRunner())
    assert result['company'] == 'Acme Robotics' and result['url'] == official and searched[0]['company'] == 'Acme Robotics'
    from jobagent.db.models import Job
    with sessions() as session:
        assert session.get(Job, result['job_id']).raw_source_data['board_url'] == board


def test_no_matching_employer_posting_is_explained(sessions, no_lock, monkeypatch):
    board = 'https://www.indeed.com/viewjob?jk=1'
    FakeReader.pages = {board: page(board, text='Request Blocked', title='Blocked - Indeed.com', ld=())}
    monkeypatch.setattr(li, '_search_official', lambda posting: [])
    with pytest.raises(ValueError, match="Couldn't find Acme's own posting"):
        li.import_posting(board, {'company': 'Acme', 'title': 'Mechanical Engineer'}, False, 'end', reader_factory=FakeReader, sessions=sessions, runner=FakeRunner())


def test_a_mygreenhouse_candidate_link_is_read_from_the_public_board(sessions, no_lock):
    pasted = 'https://my.greenhouse.io/jobs/freeformfuturecorp/7895758003?query=manufacturing+engineer'
    public = 'https://job-boards.greenhouse.io/freeformfuturecorp/jobs/7895758003'
    FakeReader.pages = {public: page(public, text='Freeform\nManufacturing Engineer\nLos Angeles, CA (On-site)\n' + 'Scale metal 3D printing production. ' * 30,
                                     title='Job Application for Manufacturing Engineer at Freeform', h1=('Manufacturing Engineer',), ld=())}
    result = li.import_posting(pasted, {}, False, 'end', reader_factory=FakeReader, sessions=sessions, runner=FakeRunner())
    assert (result['company'], result['title'], result['url']) == ('Freeformfuturecorp', 'Manufacturing Engineer', public)
    with sessions() as session:
        job = session.get(Job, result['job_id'])
        assert job.canonical_url == public and job.raw_source_data['pasted_url'] == pasted


def test_a_link_that_lands_on_a_sign_in_page_is_refused_even_with_enough_text(sessions, no_lock):
    # Freeform 13281: the MyGreenhouse login page's own text (413 characters) was stored as the posting.
    login = ('Apply for\nwhat’s next.\nSearch smarter, apply faster and take control of your job search with MyGreenhouse.\n'
             'Send security code\nOr continue with\n\nBy continuing, you agree to the Greenhouse Privacy Policy and MyGreenhouse User Agreement.\n\n'
             "Looking for your organization's Greenhouse account? Sign in\n\nThis site uses cookies\n"
             'By continuing to use this site, you are agreeing to our use of cookies. See Privacy Policy\nOk')
    FakeReader.pages = {'https://careers.acme.com/jobs/77': page('https://my.greenhouse.io/users/sign_in', text=login, title='MyGreenhouse', h1=("Apply for what's next.",), ld=())}
    with pytest.raises(ValueError, match=r'sign-in page \(my\.greenhouse\.io/users/sign_in\).*job-boards\.greenhouse\.io'):
        li.import_posting('https://careers.acme.com/jobs/77', {'company': 'Freeform', 'title': 'Manufacturing Engineer', 'location': 'Los Angeles'}, True, 'end',
                          reader_factory=FakeReader, sessions=sessions, runner=FakeRunner())
    assert li.public_posting_url('https://job-boards.greenhouse.io/acme/jobs/1') == 'https://job-boards.greenhouse.io/acme/jobs/1'


def test_a_pasted_posting_bypasses_the_experience_limit_as_his_good_fit_call(sessions, no_lock, monkeypatch):
    # His rule of 2026-10-26: pasting a U.S. posting is an explicit Good-fit decision over the scoring and years filters.
    from jobagent import settings
    real = settings.setting
    monkeypatch.setattr(settings, 'setting', lambda key: 3 if key == 'profile.max_required_experience_years' else real(key))
    senior = BODY.replace("Required: Bachelor's degree", "Required: 6+ years of experience in closures design and a Bachelor's degree")
    FakeReader.pages = {'https://careers.acme.com/jobs/12345': page('https://careers.acme.com/jobs/12345', text=senior)}
    runner = FakeRunner()
    result = li.import_posting('https://careers.acme.com/jobs/12345', {}, True, 'next', reader_factory=FakeReader, sessions=sessions, runner=runner)
    assert result['new'] and result['labeled'] and not result.get('warning')
    assert len(runner.calls) == 1
    with sessions() as session:
        job = session.get(Job, result['job_id'])
        assert job.experience_required_years == 6 and job.user_fit_label['mechanical']['fit'] is True
