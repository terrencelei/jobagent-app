"""Setup (/setup) for any student: their roles, industries and places become the search, their profile
drives every rule, and secrets go to the credential store."""
import io
import json
from datetime import date
from pathlib import Path

import httpx
import pytest
import yaml

from jobagent import search_profile, vault
from jobagent.config import DEFAULT_CONFIG_DIR, CandidateProfileConfig
from jobagent.identity import GradTiming, grad_timing
from jobagent.processing.eligibility import EligibilityEngine
from jobagent.processing.location_prefs import location_fit, location_matches
from jobagent.ui import setup_routes
from jobagent.ui.setup_routes import AccountForm, SetupForm, read_resume, save_setup


def form(**over):
    data = {
        'about': {'name': 'Jordan Patel', 'email': 'jordan@example.edu', 'phone': '555-010-0199', 'location': 'Chicago, IL',
                  'linkedin': 'https://linkedin.com/in/jordanp', 'website': ''},
        'education': {'institution': 'Example State University (ESU)', 'degree': 'bachelor', 'majors': ['Economics'],
                      'minors': ['Statistics'], 'graduation': '2026-12', 'gpa': '3.7', 'coursework': ['Econometrics'], 'started': '2022-08'},
        'experience': [{'company': 'Lakeside Capital', 'title': 'Summer Analyst', 'location': 'Chicago, IL', 'start': '2025-06',
                        'end': '2025-08', 'summary': 'Built a three-statement model for two deals.', 'skills': ['Excel', 'Valuation'],
                        'caution': 'Did not lead client calls.'}],
        'projects': [{'name': 'Investment Club', 'role': 'Sector lead', 'summary': 'Pitched four stocks.', 'skills': ['Equity research']}],
        'skills': {'technical': ['Excel', 'Python', 'SQL'], 'other': ['Financial modeling']},
        'search': {'roles': ['Financial Analyst', 'Investment Banking Analyst'], 'industries': ['Finance & banking', 'Consulting'],
                   'dream_companies': ['Northwind Partners'], 'role_type': 'full-time', 'start_date': '2027-01-15',
                   'available_during_school_year': False, 'locations': ['New York, NY', 'Chicago, IL'], 'location_strict': True,
                   'relocation': True, 'remote_ok': False, 'min_salary': 85000, 'max_required_years': 2, 'degree_fields': []},
        'eligibility': {'work_authorization': 'permanent_resident', 'clearance_eligible': False},
        'sources': {'indeed': True, 'linkedin': False, 'email': True, 'handshake': True, 'handshake_school': 'esu'},
    }
    for k, v in over.items():
        data[k].update(v)
    return SetupForm(**data)


@pytest.fixture
def install(tmp_path, monkeypatch):
    """A fresh install: an empty config folder (shipped defaults apply), an empty data dir and agent."""
    cfg, data, agent = tmp_path / 'config', tmp_path / 'data', tmp_path / 'agent'
    for d in (cfg, data, agent):
        d.mkdir()
    monkeypatch.setattr(setup_routes, '_config_dir', lambda: cfg)
    monkeypatch.setattr(setup_routes, '_data_dir', lambda: data)
    monkeypatch.setattr(setup_routes, '_agent_dir', lambda: agent)
    monkeypatch.setattr(setup_routes, '_marker_path', lambda: data / 'setup.json')
    monkeypatch.setattr(setup_routes, 'setup_needed', lambda: not (data / 'setup.json').exists())
    monkeypatch.setattr(setup_routes, 'file_stem', lambda: 'Jordan_Patel')
    return cfg, data, agent


# ------------------------------------------------------------ timing from the profile

def test_june_graduate_timing():
    t = GradTiming(graduation=date(2027, 6, 15), available=date(2027, 6, 16), school='UT Austin')
    assert t.school_terms() == ('fall 2026', 'winter 2026', 'winter 2027', 'spring 2027')
    assert t.months_before_graduation() == ('january', 'february', 'march', 'april', 'may')
    assert (t.grad_label, t.avail_label, t.avail_day_label) == ('June 2027', 'Summer 2027', 'June 16, 2027')


def test_a_december_graduate_gets_their_own_cohort_rules():
    profile = yaml.safe_load((DEFAULT_CONFIG_DIR / 'profile.yaml').read_text())
    profile['education']['graduation_date'] = '2026-12-15'
    profile['candidate']['target_start_date'] = '2027-01-15'
    engine = EligibilityEngine(profile_config=CandidateProfileConfig(**profile))
    assert grad_timing(engine.profile).school_terms() == ('spring 2026', 'summer 2026', 'fall 2026')
    _, _, stated, conflict = engine.evaluate('Manufacturing Engineer (Class of 2026)', 'Build things.')
    assert not conflict and stated == 'Class Of 2026'
    _, reasons, _, conflict = engine.evaluate('Manufacturing Engineer, 2025 New Grad', 'Build things.')
    assert conflict and any('Winter 2027 (December 2026 graduation)' in r for r in reasons)


# ------------------------------------------------------------ places

@pytest.mark.parametrize('loc,pref,ok', [
    ('New York, NY', 'New York, NY', True), ('Brooklyn, New York, United States', 'NY', True),
    ('Austin, Texas', 'TX', True), ('Portland, ME', 'Portland, OR', False), ('Portland', 'Portland, OR', True),
    ('Remote - US', 'Remote', True), ('Seattle, WA', 'Remote', False), ('Chicago, IL', 'Texas', False)])
def test_location_preferences_match_cities_states_and_remote(loc, pref, ok):
    assert location_matches(loc, pref) is ok


def test_location_fit_scores_chosen_places_first():
    assert location_fit('Chicago, IL', ['Chicago, IL'])[0] == 5.0
    assert location_fit('Remote', ['Chicago, IL'], remote_ok=True)[0] == 4.5
    assert location_fit('Denver, CO', ['Chicago, IL']) == (1.0, False)
    assert location_fit('Denver, CO', []) == (3.5, True)


def test_strict_places_make_other_locations_ineligible():
    profile = yaml.safe_load((DEFAULT_CONFIG_DIR / 'profile.yaml').read_text())
    profile['candidate'].update(target_locations=['Chicago, IL'], location_strict=True, remote_ok=False)
    engine = EligibilityEngine(profile_config=CandidateProfileConfig(**profile))
    _, reasons, _, _ = engine.evaluate('Mechanical Engineer', 'BS Mechanical Engineering', location='Denver, CO')
    assert any('outside the places you chose' in r for r in reasons)
    _, reasons, _, _ = engine.evaluate('Mechanical Engineer', 'BS Mechanical Engineering', location='Chicago, IL')
    assert not any('outside the places you chose' in r for r in reasons)


# ------------------------------------------------------------ the generated search

def test_any_major_becomes_a_search_track_clusters_and_queries():
    tracks = search_profile.build_tracks(['Financial Analyst', 'Investment Banking Analyst'], ['Economics'], ['Finance & banking'])
    spec = tracks['tracks']['primary']
    assert spec['major'] == 'Economics' and spec['preferred_title_terms'][0] == 'financial analyst'
    assert 'finance' in spec['industries'] and spec['degree_override'] == ['economics']
    from jobagent.processing.tracks import build_track
    track = build_track('primary', spec)
    import re
    assert re.search(track.discovery_titles, 'Financial Analyst, Corporate FP&A', re.I)
    ranking = search_profile.build_ranking(['Financial Analyst'], ['Excel'], ['Finance & banking'], ['Northwind Partners'])
    assert ranking['career_clusters'][0]['name'] == 'FINANCIAL ANALYST' and 'excel' in ranking['career_clusters'][0]['keywords']
    assert ranking['company_preference']['sectors']['dream_companies']['companies'] == ['northwind partners']
    search = search_profile.build_search(['Financial Analyst'], ['New York, NY'], ['Finance & banking'], 'both', 'esu')
    assert any('"Financial Analyst"' in q and 'new grad' in q for q in search['indeed']['queries'])
    assert any('internship' in q for q in search['indeed']['queries'])
    assert search['indeed']['location'] == 'New York, NY' and search['handshake']['school'] == 'esu'
    assert search['target_companies'] == {}  # no shipped employer pack for finance yet; the boards do the finding
    assert any('Internships' in g['repository'] for g in search['github_sources'])


def test_engineering_industries_bring_the_shipped_employer_pack():
    search = search_profile.build_search(['Mechanical Engineer'], [], ['Hardware & robotics'], 'full-time')
    assert sum(len(v) for v in search['target_companies'].values()) > 50


# ------------------------------------------------------------ saving

def test_setup_writes_a_clean_search_for_a_new_student(install):
    cfg, data, agent = install
    result = save_setup(form(), run_after=False)
    assert result['fresh'] and result['ok']
    profile = yaml.safe_load((cfg / 'profile.yaml').read_text())
    CandidateProfileConfig(**profile)
    cand = profile['candidate']
    assert cand['name'] == 'Jordan Patel' and cand['citizenship'] == 'U.S. Permanent Resident'
    assert cand['target_locations'] == ['New York, NY', 'Chicago, IL'] and cand['location_strict'] is True
    assert cand['search_preferences']['roles'] == ['Financial Analyst', 'Investment Banking Analyst']
    assert cand['acceptable_degree_fields'] == ['economics']
    assert profile['experience'][0]['caution'] == 'Did not lead client calls.'
    assert yaml.safe_load((cfg / 'tracks.yaml').read_text())['tracks']['primary']['major'] == 'Economics'
    assert yaml.safe_load((cfg / 'ranking.yaml').read_text())['career_clusters'][1]['name'] == 'INVESTMENT BANKING ANALYST'
    search = yaml.safe_load((cfg / 'search.yaml').read_text())
    assert search['handshake']['school'] == 'esu' and search['locations']['preferred_locations'] == ['New York, NY', 'Chicago, IL']
    agent_profile = json.loads((agent / 'private/profile.json').read_text())
    assert agent_profile['answers']['firstName'] == 'Jordan' and agent_profile['answers']['addressState'] == 'IL'
    assert agent_profile['workHistory'][0]['from'] == ['6', '2025'] and agent_profile['projects'][0]['name'] == 'Investment Club'
    from jobagent.settings import setting
    assert setting('linkedin.enabled') is False and setting('handshake.enabled') is True
    assert json.loads((data / 'setup.json').read_text())['version'] == 2


def test_rerunning_setup_keeps_what_the_form_does_not_cover(install):
    cfg, data, agent = install
    save_setup(form(), run_after=False)
    profile = yaml.safe_load((cfg / 'profile.yaml').read_text())
    profile['experience'][0]['weight_multiplier'] = 1.6
    (cfg / 'profile.yaml').write_text(yaml.safe_dump(profile))
    result = save_setup(form(about={'phone': '555-010-0123'}), run_after=False)
    assert not result['fresh'] and Path(result['backup']).is_dir()
    profile = yaml.safe_load((cfg / 'profile.yaml').read_text())
    assert profile['experience'][0]['weight_multiplier'] == 1.6 and profile['candidate']['phone'] == '555-010-0123'


def test_handshake_needs_a_school(install):
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        save_setup(form(sources={'handshake': True, 'handshake_school': ''}), run_after=False)


def test_a_role_is_required():
    with pytest.raises(Exception):
        form(search={'roles': []})


# ------------------------------------------------------------ account, Gmail, secrets

def test_account_sign_in_stores_the_token_and_points_the_ai_at_the_gateway(monkeypatch):
    monkeypatch.setenv('JOBAGENT_BACKEND_URL', 'https://backend.example')
    seen = {}

    def handler(request):
        seen['url'] = str(request.url)
        return httpx.Response(200, json={'token': 'ja_device_token'})
    state = setup_routes.connect_account(AccountForm(email='jordan@example.edu', password='hunter22!x', mode='signup'),
                                         client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert seen['url'] == 'https://backend.example/auth/signup' and state['connected'] and state['email'] == 'jordan@example.edu'
    vault.put(vault.SITE_PASSWORD, 'employer-site-pass')
    env = vault.model_env({'PATH': '/bin', 'ANTHROPIC_API_KEY': 'someone-elses'})
    assert env['ANTHROPIC_BASE_URL'] == 'https://backend.example/llm' and env['ANTHROPIC_AUTH_TOKEN'] == 'ja_device_token'
    assert 'ANTHROPIC_API_KEY' not in env and env['WORKDAY_PASSWORD'] == 'employer-site-pass'


def test_a_failed_sign_in_reports_the_backend_message():
    from fastapi import HTTPException
    client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(401, json={'detail': 'Wrong email or password'})))
    with pytest.raises(HTTPException) as err:
        setup_routes.connect_account(AccountForm(email='a@b.co', password='12345678'), client=client)
    assert 'Wrong email or password' in str(err.value.detail) and not vault.get(vault.ACCOUNT_TOKEN)


def test_gmail_connection_uses_pkce_and_keeps_the_refresh_token(install, monkeypatch):
    cfg, data, agent = install
    monkeypatch.setenv('JOBAGENT_GOOGLE_CLIENT_ID', 'cid.apps.googleusercontent.com')
    url = setup_routes.gmail_auth_url('http://127.0.0.1:8000/api/setup/gmail/callback')
    assert 'code_challenge_method=S256' in url and 'gmail.readonly' in url
    state = url.split('state=')[1]

    def handler(request):
        if request.url.host == 'oauth2.googleapis.com':
            assert b'code_verifier=' in request.content
            return httpx.Response(200, json={'refresh_token': 'rt', 'access_token': 'at', 'scope': setup_routes.GMAIL_SCOPE})
        return httpx.Response(200, json={'emailAddress': 'jordan@gmail.example'})
    address = setup_routes.finish_gmail('code', state, client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert address == 'jordan@gmail.example' and vault.get(vault.GMAIL_REFRESH) == 'rt'
    token = json.loads((agent / 'private/gmail-token.json').read_text())
    assert token['refresh_token'] == 'rt'
    import os
    if os.name != 'nt':
        assert oct((agent / 'private/gmail-token.json').stat().st_mode)[-3:] == '600'
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        setup_routes.finish_gmail('code', state)  # a state is used once


def test_resume_contact_details_are_read():
    from reportlab.pdfgen.canvas import Canvas
    buf = io.BytesIO()
    c = Canvas(buf)
    for y, line in [(800, 'JORDAN PATEL'), (780, 'jordan@example.edu | (555) 010-0199 | linkedin.com/in/jordanp')]:
        c.drawString(72, y, line)
    c.save()
    found = read_resume(buf.getvalue())
    assert found['name'] == 'Jordan Patel' and found['email'] == 'jordan@example.edu'


def test_fresh_install_opens_setup_first(monkeypatch):
    from fastapi.testclient import TestClient
    from jobagent.ui import server
    monkeypatch.setattr(server, 'setup_needed', lambda: True)
    client = TestClient(server.app)
    res = client.get('/', follow_redirects=False)
    assert res.status_code == 307 and res.headers['location'] == '/setup'
    monkeypatch.setattr(server, 'setup_needed', lambda: False)
    assert client.get('/', follow_redirects=False).status_code == 200


def test_setup_state_api(install):
    from fastapi.testclient import TestClient
    from jobagent.ui import server
    body = TestClient(server.app).get('/api/setup').json()
    assert body['needed'] is True and body['draft']['search']['roles'] == []
    assert 'Finance & banking' in body['catalog']['industries'] and body['account']['connected'] is False
