import json

import pytest
from fastapi import HTTPException

from jobagent.services import resume_doc
from jobagent.ui import profile_routes as routes

RESUME = {'name': 'SAM RIVERA', 'contact': ['Somewhere, CA', 'sam@example.com', '+1 (555) 010-2030', 'linkedin.com/in/samr', 'samrivera.github.io'],
          'sections': [{'title': 'EDUCATION', 'kind': 'entries', 'style': 'education', 'entries': [{'org': 'State University', 'dates': 'August 2023 - June 2027', 'role': 'B.S. Mechanical Engineering', 'location': 'Somewhere, CA', 'bullets': []}]},
                       {'title': 'PROFESSIONAL EXPERIENCE', 'kind': 'entries', 'style': 'experience', 'entries': [{'org': 'Acme Robotics', 'dates': 'June 2026 - September 2026', 'role': 'Mechanical Intern', 'location': 'Old Town, CA', 'bullets': ['Built a fixture.']}]},
                       {'title': 'SKILLS', 'kind': 'skills', 'lines': [{'label': 'CAD', 'text': 'SolidWorks'}]}]}
PROFILE = {'resumePath': 'private/Resume.pdf', 'answers': {'fullName': 'Sam Rivera', 'email': 'sam@example.com', 'phone': '555-010-2030', 'github': 'https://github.com/samr', 'onsiteOk': True, 'gpaNumber': 3.5},
           'education': [{'school': 'State University', 'degree': 'B.S.', 'field': 'Mechanical Engineering', 'from': ['8', '2023'], 'to': ['6', '2027']}],
           'workHistory': [{'title': 'Mechanical Design Intern', 'company': 'Acme Robotics', 'location': 'New City, CA', 'from': ['6', '2026'], 'to': ['10', '2026'], 'description': 'x'}]}


@pytest.fixture
def agent(tmp_path, monkeypatch):
    (tmp_path / 'private/resumes').mkdir(parents=True)
    (tmp_path / 'private/profile.json').write_text(json.dumps(PROFILE))
    (tmp_path / 'private/Resume.pdf').write_bytes(resume_doc.render_pdf(resume_doc.normalize(RESUME)))
    monkeypatch.setattr(routes, 'AGENT_DIR', tmp_path)
    return tmp_path


def test_sync_changes_facts_but_not_formatting():
    synced, changes = routes.apply_profile(resume_doc.normalize(RESUME), PROFILE)
    entry = synced['sections'][1]['entries'][0]
    assert (entry['role'], entry['location'], entry['dates']) == ('Mechanical Design Intern', 'New City, CA', 'June 2026 - October 2026')
    # Same name, phone number and portfolio written differently are left exactly as the resume has them.
    assert synced['name'] == 'SAM RIVERA' and synced['contact'] == resume_doc.normalize(RESUME)['contact']
    assert len(changes) == 3 and entry['bullets'] == ['Built a fixture.']


def test_save_backs_up_profile_and_archives_resume(agent):
    before = (agent / 'private/Resume.pdf').read_bytes()
    result = routes.update_profile(routes.ProfileUpdate(answers={'onsiteOk': False}))
    assert result['saved'] and result['resume_updated'] and len(result['resume_changes']) == 3
    assert json.loads((agent / 'private/profile.json').read_text())['answers']['onsiteOk'] is False
    assert len(list((agent / 'private/profile-backups').glob('profile-*.json'))) == 1
    archived = list((agent / 'private/resumes/archive').glob('Resume-*.pdf'))
    assert len(archived) == 1 and archived[0].read_bytes() == before and (agent / 'private/Resume.pdf').read_bytes() != before
    assert 'Mechanical Design Intern' in resume_doc.plain_text(resume_doc.parse_pdf((agent / 'private/Resume.pdf').read_bytes()))
    assert routes.view(routes.load_profile())['resume']['pending'] == []


def test_rejects_unknown_keys_changed_types_and_overlong_resumes(agent):
    with pytest.raises(HTTPException):
        routes.update_profile(routes.ProfileUpdate(answers={'notSaved': 'x'}))
    with pytest.raises(HTTPException):
        routes.update_profile(routes.ProfileUpdate(answers={'onsiteOk': 'yes'}))
    long = json.loads(json.dumps(RESUME))
    long['sections'][1]['entries'][0]['bullets'] = ['A long bullet about building fixtures. ' * 4] * 60
    with pytest.raises(HTTPException) as error:
        routes.update_profile(routes.ProfileUpdate(resume=long))
    assert 'one page' in error.value.detail and not (agent / 'private/resumes/archive').exists()


def test_same_question_saved_under_several_names_is_one_field(agent):
    profile = json.loads((agent / 'private/profile.json').read_text())
    profile['answers'].update({'sponsorship': 'No', 'requiresSponsorship': False, 'andurilSponsorship': 'No', 'jumioSponsorship': 'Yes', 'veteranStatus': 'Not a veteran', 'eeoVeteran': 'Not a veteran'})
    (agent / 'private/profile.json').write_text(json.dumps(profile))
    fields = {f['key']: f for g in routes.view(routes.load_profile())['groups'] for f in g['fields']}
    topic = fields['topic:sponsorship']
    assert topic['kind'] == 'yesno' and topic['value'] is False and not topic['conflict'] and 'Anduril' in topic['note']
    assert 'sponsorship' not in fields and fields['jumioSponsorship']['conflict'] and fields['topic:veteran-wording']['value'] == 'Not a veteran'
    assert routes.label_of('andurilHeard') == 'Anduril: How you heard about the role' and routes.label_of('rlSpring2027').startswith('Rocket Lab:')
    routes.update_profile(routes.ProfileUpdate(answers={'topic:sponsorship': True, 'topic:veteran-wording': 'Protected veteran'}, sync_resume=False))
    saved = json.loads((agent / 'private/profile.json').read_text())['answers']
    assert (saved['sponsorship'], saved['requiresSponsorship'], saved['andurilSponsorship'], saved['jumioSponsorship']) == ('Yes', True, 'Yes', 'Yes')
    assert saved['veteranStatus'] == saved['eeoVeteran'] == 'Protected veteran'
