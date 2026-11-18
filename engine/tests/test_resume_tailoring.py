"""Tailored resumes: drafted in his exact layout, edited on Approvals or in Word, approved before submission."""
import base64
import copy
import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobagent.db.models import EligibilityStatus, Job
from jobagent.services import resume_doc, resume_review

RESUME = {'name': 'ALEX RIVERA', 'contact': ['+1 (555) 555-0100', 'applicant@example.test', 'Springfield, CA, USA'], 'sections': [
    {'title': 'EDUCATION', 'kind': 'entries', 'style': 'education', 'entries': [
        {'org': 'University of California - Santa Barbara', 'dates': 'August 2023 - June 2027', 'role': 'Bachelor of Science (BS), Mechanical Engineering',
         'location': '', 'bullets': ['Specialization in Dynamic Systems, Control, and Robotics']}]},
    {'title': 'PROFESSIONAL EXPERIENCE', 'kind': 'entries', 'style': 'experience', 'entries': [
        {'org': 'Northrop Grumman', 'dates': 'June 2025 - August 2025', 'role': 'Mechanical Engineering Intern', 'location': 'Goleta, CA, USA',
         'bullets': ['Worked on tolerance analysis for legacy flight components and released new 2D GD&T drawings',
                     'Designed and conducted component and process experiments for assembly failure analysis, using regression and classification methods to identify the root causes and reduce production times and material costs']}]},
    {'title': 'SKILLS', 'kind': 'skills', 'lines': [{'label': 'Technical', 'text': 'SolidWorks, NX, GD&T, MSC Adams'}]}]}


def pdf(resume=RESUME):
    return resume_doc.render_pdf(resume)


def test_the_layout_matches_his_resume():
    plan = resume_doc.layout(RESUME)
    runs = {r[4]: r for r in plan['runs']}
    name = runs['ALEX RIVERA']
    assert name[:2] == ('Times-Bold', 30) and abs(name[2] + resume_doc.width('ALEX RIVERA', 'Times-Bold', 30) / 2 - 306) < 0.01
    dates = runs['June 2025 - August 2025']
    assert abs(dates[2] + resume_doc.width(dates[4], 'Times-Bold', 9) - 572) < 0.01 and runs['Northrop Grumman'][2] == 40
    assert runs['EDUCATION'][:4] == ('Times-Bold', 11, 40, 84.1 + 22.6) and plan['rules'][0] == pytest.approx((110.0, 111.0))
    assert runs['Mechanical Engineering Intern'][0] == 'Times-Italic'
    # Two-line bullets wrap inside the 40 pt right margin.
    body = [r for r in plan['runs'] if r[0] == 'Times-Roman' and r[2] == 55.65]
    assert len(body) == 3 and all(r[2] + resume_doc.width(r[4], 'Times-Roman', 9) <= 572 for r in body)


def test_contact_items_are_linked_like_his_builder_does():
    from pypdf import PdfReader
    resume = {**RESUME, 'contact': RESUME['contact'] + ['linkedin.com/in/applicant', 'applicant.github.io']}
    links = [(a.get_object()['/A']['/URI'], [round(float(v), 1) for v in a.get_object()['/Rect']])
             for a in PdfReader(io.BytesIO(pdf(resume))).pages[0]['/Annots']]
    assert [u for u, _ in links] == ['tel:+15555550100', 'mailto:applicant@example.test',
                                     'https://linkedin.com/in/applicant', 'https://applicant.github.io']
    assert all(rect[1] == 705.9 and rect[3] == 716.7 for _, rect in links)  # the box his 2026-10-19 PDF uses
    assert resume_doc.contact_uri('Springfield, CA, USA') is None


def test_pdf_and_word_round_trip_the_text():
    assert resume_doc.parse_pdf(pdf()) == resume_doc.normalize(RESUME)
    assert resume_doc.from_docx(resume_doc.to_docx(RESUME), template=RESUME) == resume_doc.normalize(RESUME)


def test_word_edits_come_back_as_structure():
    from docx import Document
    doc = Document(io.BytesIO(resume_doc.to_docx(RESUME)))
    bullet = next(p for p in doc.paragraphs if p.style.name == 'Resume Bullet' and 'tolerance' in p.text)
    bullet.text = '• Performed tolerance stack-up analysis on legacy flight components'
    bullet._element.addnext(copy.deepcopy(bullet._element))  # he pressed Enter for a new bullet
    out = io.BytesIO(); doc.save(out)
    edited = resume_doc.from_docx(out.getvalue(), template=RESUME)
    assert edited['sections'][1]['entries'][0]['bullets'][:2] == ['Performed tolerance stack-up analysis on legacy flight components'] * 2


def test_overflow_is_measured():
    long = copy.deepcopy(RESUME)
    long['sections'][1]['entries'][0]['bullets'] *= 40
    fitted = resume_doc.fit(long)
    assert not fitted['fits'] and fitted['lines_over'] > 10 and resume_doc.fit(RESUME)['fits']


@pytest.fixture
def runner(tmp_path):
    from contextlib import contextmanager
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from jobagent.db.models import Base
    from jobagent.services.application_runner import ApplicationRunner
    engine = create_engine('sqlite://'); Base.metadata.create_all(engine)
    @contextmanager
    def sessions():
        with Session(engine) as session:
            yield session
    with sessions() as session:
        for i, company in [(1, 'DoorDash'), (2, 'Zoox')]:
            session.add(Job(id=i, fit_review={'fit': True, 'hash': None}, company_name=company, title='Mechanical Engineer, Chassis',
                            description='suspension and prototyping', location='San Francisco, California, United States',
                            canonical_url=f'https://x/{i}', application_url=f'https://x/{i}', source_ats='direct', role_type='FULL_TIME',
                            eligibility=EligibilityStatus.STRONG_MATCH, best_career_cluster='PRODUCT / MECHANICAL DESIGN', priority_score=90 - i))
        session.commit()
    agent = tmp_path / 'agent'; (agent / 'private').mkdir(parents=True); (agent / 'src').mkdir(); (agent / 'src/dashboard-worker.mjs').touch()
    (agent / 'private/Alex_Rivera_Resume.pdf').write_bytes(pdf())
    (agent / 'private/profile.json').write_text('{}')
    from jobagent import settings
    settings.settings_path().write_text(json.dumps({'overrides': {'workers.resume_tailoring_approval': True}}))
    settings._cache.update(stamp=None, overrides={})
    r = ApplicationRunner(tmp_path / 'runs', agent, sessions)
    r._cli = lambda engine: f'/fixture/bin/{engine}'
    started = []
    r.resume_reviewer.start = lambda job_id, inputs: started.append((job_id, inputs)) or True
    r.started = started
    return r


def queued(runner, job_id):
    return next(j for j in runner.data['jobs'] if j['job_id'] == job_id)


def drafted():
    tailored = copy.deepcopy(RESUME)
    tailored['sections'][1]['entries'][0]['bullets'][0] = 'Performed tolerance stack-up analysis and released 2D GD&T drawings for legacy flight components'
    return {'verdict': 'tailor', 'focus': 'Suspension & prototyping', 'summary': 'Weights chassis work.', 'keywords': ['GD&T', 'tolerance stack-up', 'DVP&R'],
            'verify': ['"tolerance stack-up"'], 'base_coverage': {'found': ['GD&T'], 'missing': [], 'total': 3}, 'draft': resume_doc.normalize(tailored)}


def park(runner, job_id=1):
    runner.queue([job_id])
    item = queued(runner, job_id)
    assert runner._resume_gate(item) and item['status'] == 'queued'  # waiting on the draft
    runner._store_resume_review(job_id, drafted())
    assert runner._resume_gate(item) and item['status'] == 'needs_resume'
    return item


def test_review_inputs_read_his_standing_resume(runner):
    park(runner)
    job, base, variants, older, experience, kept = runner.started[0][1]()
    assert base == resume_doc.normalize(RESUME) and job['company'] == 'DoorDash' and variants == [] and kept == []


def test_a_draft_parks_with_preview_coverage_and_checks(runner):
    park(runner)
    card = runner.approvals()[0]
    assert card['resume_review']['verify'] == ['"tolerance stack-up"']
    assert card['resume_draft']['fit']['fits'] and card['resume_draft']['coverage']['found'] == ['GD&T', 'tolerance stack-up']
    assert runner.resume_draft_file(1, 'pdf').startswith(b'%PDF') and runner.resume_draft_file(1, 'docx')[:2] == b'PK'


def test_edits_here_or_in_word_then_approval_uploads_exactly_that(runner):
    park(runner)
    edited = runner.resume_draft(1)['resume']
    edited['sections'][1]['entries'][0]['bullets'].append('Built DVP&R test plans for flight hardware')
    assert 'DVP&R' in runner.save_resume_draft(1, edited)['coverage']['found']
    runner.import_resume_docx(1, 'data:;base64,' + base64.b64encode(resume_doc.to_docx(edited)).decode())
    runner.decide_resume(1, 'approve', label='Chassis')
    item = queued(runner, 1)
    path = runner.agent_dir / 'private/resumes/chassis/Alex_Rivera_Resume.pdf'
    assert item['status'] == 'queued' and not runner._resume_gate(item) and runner._resume_for(item) == path
    assert resume_doc.parse_pdf(path.read_bytes()) == edited
    assert json.loads((path.parent / 'resume.json').read_text()) == edited
    # A resumed run (after answering questions) keeps the approved copy.
    item.update(status='needs_approval')
    assert runner._resume_for(runner._resume_from(1, {'needs_approval'})) == path


def test_a_draft_past_one_page_cannot_be_approved(runner):
    park(runner)
    long = runner.resume_draft(1)['resume']
    long['sections'][1]['entries'][0]['bullets'] *= 40
    assert not runner.save_resume_draft(1, long)['fit']['fits']
    with pytest.raises(ValueError, match='past one page'):
        runner.decide_resume(1, 'approve')


def test_keeping_the_standing_resume_is_remembered(runner):
    park(runner)
    runner.decide_resume(1, 'current')
    item = queued(runner, 1)
    assert not runner._resume_gate(item) and runner._resume_for(item) == runner._resume()
    assert [k['focus'] for k in runner.resume_library.kept()] == ['Suspension & prototyping']


def test_an_approved_copy_the_reviewer_picks_is_used_without_asking(runner):
    variant = runner.resume_library.add('Chassis', 'chassis', pdf(), structure=resume_doc.normalize(RESUME))
    runner.queue([1])
    runner._store_resume_review(1, {'verdict': 'variant', 'variant_id': variant})
    item = queued(runner, 1)
    assert not runner._resume_gate(item) and runner._resume_for(item).parent.name == variant


def test_a_standing_verdict_or_failed_check_never_blocks(runner):
    runner.queue([1, 2])
    runner._store_resume_review(1, {'verdict': 'base'})
    runner._store_resume_review(2, {'verdict': 'base', 'error': 'claude CLI not found'})
    for job_id in (1, 2):
        item = queued(runner, job_id)
        assert not runner._resume_gate(item) and runner._resume_for(item) == runner._resume()


def test_review_holds_drafts_to_his_facts_and_to_one_page(monkeypatch):
    monkeypatch.setattr(resume_review, '_cli', lambda name: '/bin/claude')
    base = resume_doc.normalize(RESUME)
    invented = copy.deepcopy(base)
    invented['name'] = 'A. RIVERA'
    invented['sections'][0]['entries'][0]['dates'] = 'August 2022 - June 2026'
    invented['sections'][1]['entries'].append({'org': 'Tesla', 'dates': '2024', 'role': 'Intern', 'location': '', 'bullets': ['x']})
    too_long = copy.deepcopy(invented)
    too_long['sections'][1]['entries'][0]['bullets'] *= 40
    with_fmea = copy.deepcopy(invented)
    with_fmea['sections'][1]['entries'][0]['bullets'][1] = 'Ran process FMEA on assembly failures'
    answers = iter([too_long, invented, with_fmea])
    prompts = []

    def run(args, input, **kw):
        if args[1] in ('exec', 'run'):  # the reword pass is tested on its own
            return SimpleNamespace(returncode=1, stdout='', stderr='off')
        prompts.append(input)
        sections = next(answers)['sections']
        for s in sections:
            s.setdefault('entries', []); s.setdefault('lines', [])
        out = {'verdict': 'tailor', 'variant_id': '', 'focus': 'chassis', 'summary': 's', 'keywords': ['GD&T', 'FMEA'], 'verify': [], 'sections': sections}
        return SimpleNamespace(returncode=0, stdout=json.dumps({'structured_output': out}), stderr='')
    result = resume_review.review({'company': 'X', 'title': 'ME', 'description': 'd'}, base, [], [], {}, run=run)
    assert 'past the one page' in prompts[1] and 'still missing: ["FMEA"]' in prompts[2] and len(prompts) == 3
    draft = result['draft']
    assert draft['name'] == 'ALEX RIVERA' and draft['sections'][0]['entries'][0]['dates'] == 'August 2023 - June 2027'
    assert any('Tesla' in v for v in result['verify']) and result['fit']['fits']
    assert result['coverage']['found'] == ['GD&T', 'FMEA'] and result['base_coverage']['missing'] == ['FMEA']


def test_keyword_matching_is_ats_lenient():
    text = 'Designed sealing systems and part & assembly drawings; proof-of-concept prototype; C/C++'
    cov = resume_review.coverage(['sealing system', 'part and assembly drawings', 'proof of concept prototypes', 'C++', 'CAE'], text)
    assert cov['missing'] == ['CAE'] and len(cov['found']) == 4


def test_an_approved_cover_letter_becomes_a_one_page_pdf_for_the_upload(runner):
    runner.queue([1])
    item = queued(runner, 1)
    item.update(status='needs_approval', questions=[{'label': 'Cover Letter* (Attach)', 'type': 'textarea', 'required': True,
                                                      'approvalReason': 'Required upload with no approved document: give the text to enter'}])
    assert runner.approvals()[0]['questions'][0]['cover_letter']
    letter = 'Dear Varda Hiring Team,\n\nI build flight hardware.\n\nSincerely,\nAlex Rivera'
    runner._answer_memory = lambda payload: None
    runner.approve_answers(1, {'Cover Letter* (Attach)': letter})
    fresh = queued(runner, 1)
    path = runner.agent_dir / 'private/cover-letters/1/Alex_Rivera_Cover_Letter.pdf'
    assert fresh['documents'] == {'coverLetter': str(path)} and path.read_bytes().startswith(b'%PDF')
    text = [r[4] for r in resume_doc._runs(path.read_bytes())]
    assert text[0] == 'ALEX RIVERA' and 'I build flight hardware.' in text and text[-1] == 'Alex Rivera'
    with pytest.raises(ValueError, match='past one page'):
        runner.cover_letter_pdf('word ' * 2000)


def test_a_letter_approved_before_letters_became_files_is_printed_at_launch(runner):
    runner.queue([1])
    item = queued(runner, 1)
    item['approved_answers'] = [{'question': 'Cover Letter* (Attach)', 'answer': 'Dear Team,\n\nHello.\n\nSincerely,\nAlex Rivera'}]
    runner.popen = lambda *a, **k: SimpleNamespace(pid=1, poll=lambda: None)
    runner._node = lambda: '/usr/bin/node'
    runner._launch(item)
    request = json.loads((runner.directory / item['id'] / 'request.json').read_text())
    assert request['documents']['coverLetter'].endswith('cover-letters/1/Alex_Rivera_Cover_Letter.pdf')


def test_a_long_focus_name_is_accepted_and_shortened(runner):
    from jobagent.ui.application_routes import ResumeDecision
    name = 'mechanical hardware test, aerospace structures, test fixtures, and more words past eighty characters'
    assert ResumeDecision(choice='approve', label=name).label == name  # Shield AI's 61-character focus used to be a 422
    park(runner)
    runner.decide_resume(1, 'approve', label=name)
    label = runner.resume_library.variants()[0]['label']
    assert len(label) <= 80 and label.startswith('mechanical hardware test')


def test_without_review_a_fitting_draft_is_used_and_the_sent_resume_kept_with_the_posting(runner):
    from jobagent import settings
    from jobagent.db.models import Application
    settings.settings_path().write_text(json.dumps({'overrides': {'workers.resume_tailoring_approval': False}}))
    settings._cache.update(stamp=None, overrides={})
    runner.queue([1])
    item = queued(runner, 1)
    runner._store_resume_review(1, drafted())
    assert not runner._resume_gate(item) and item['status'] == 'queued'  # no parking
    variant = runner.resume_library.variants()[0]
    assert variant['label'] == 'Suspension & prototyping' and runner._resume_for(item).parent.name == variant['id']
    runner.popen = lambda *a, **k: SimpleNamespace(pid=1, poll=lambda: None)
    runner._node = lambda: '/usr/bin/node'
    runner._launch(item)
    sent = runner.agent_dir / 'private/applications/1'
    assert (sent / 'Alex_Rivera_Resume.pdf').read_bytes() == runner._resume_for(item).read_bytes()
    assert json.loads((sent / 'sent.json').read_text())['resume_label'] == 'Tailored: Suspension & prototyping'
    item.update(status='submitted_pending_receipt')
    runner._record_sent_documents()
    assert not item.get('sent_recorded')  # no application row yet: tried again later
    with runner.sessions() as session:
        session.add(Application(job_id=1)); session.commit()
    runner._record_sent_documents()
    with runner.sessions() as session:
        app = session.query(Application).filter_by(job_id=1).one()
        assert app.resume_path == str(sent / 'Alex_Rivera_Resume.pdf') and app.resume_version == 'Tailored: Suspension & prototyping'
    assert runner.sent_resume(1) == sent / 'Alex_Rivera_Resume.pdf'


def test_without_review_an_overflowing_draft_falls_back_to_the_standing_resume(runner):
    from jobagent import settings
    settings.settings_path().write_text(json.dumps({'overrides': {'workers.resume_tailoring_approval': False}}))
    settings._cache.update(stamp=None, overrides={})
    runner.queue([1])
    item = queued(runner, 1)
    long = drafted()
    long['draft']['sections'][1]['entries'][0]['bullets'] *= 40
    runner._store_resume_review(1, long)
    assert not runner._resume_gate(item) and runner._resume_for(item) == runner._resume() and runner.resume_library.variants() == []


def _reword_review(monkeypatch, codex, opencode=None):
    """One fitting Claude draft, then the reword engines answer with codex(draft) / opencode(draft) sections."""
    monkeypatch.setattr(resume_review, '_cli', lambda name: f'/bin/{name}')
    base = resume_doc.normalize(RESUME)
    calls = []

    def run(args, input, **kw):
        calls.append(args[1] if args[1] in ('exec', 'run') else 'claude')
        if args[1] == 'exec':
            sections = codex(copy.deepcopy(base))
            if sections is None:
                return SimpleNamespace(returncode=1, stdout='', stderr='usage limit')
            Path(args[args.index('-o') + 1]).write_text(json.dumps({'verify': ['"led"'], 'sections': sections}))
            return SimpleNamespace(returncode=0, stdout='', stderr='')
        if args[1] == 'run':
            text = json.dumps({'verify': [], 'sections': opencode(copy.deepcopy(base))})
            return SimpleNamespace(returncode=0, stdout=json.dumps({'type': 'text', 'part': {'text': text}}), stderr='')
        out = {'verdict': 'tailor', 'variant_id': '', 'focus': 'chassis', 'summary': 's', 'keywords': ['GD&T'], 'verify': ['"a"'], 'sections': base['sections']}
        return SimpleNamespace(returncode=0, stdout=json.dumps({'structured_output': out}), stderr='')
    result = resume_review.review({'company': 'X', 'title': 'ME', 'description': 'd'}, base, [], [], {}, run=run)
    return result, calls


def reworded(d):
    d['sections'][1]['entries'][0]['bullets'][0] = 'Released GD&T drawings for flight components'
    return d['sections']


def test_a_second_model_rewords_the_draft(monkeypatch):
    result, calls = _reword_review(monkeypatch, reworded)
    assert calls == ['claude', 'exec'] and result['reworded_by'] == 'codex'
    assert result['draft']['sections'][1]['entries'][0]['bullets'][0] == 'Released GD&T drawings for flight components'
    assert result['verify'][:2] == ['"a"', '"led"'] and 'reword_errors' not in result


def test_opencode_rewords_when_codex_fails(monkeypatch):
    result, calls = _reword_review(monkeypatch, lambda d: None, reworded)
    assert calls == ['claude', 'exec', 'run'] and result['reworded_by'] == 'opencode'
    assert result['reword_errors'][0].startswith('codex:')


def test_a_reword_that_drops_a_keyword_or_an_entry_is_not_used(monkeypatch):
    def drops(d):
        for s in d['sections']:
            for e in s.get('entries', []):
                e['bullets'] = [b.replace('GD&T', 'drawing') for b in e['bullets']]
            for line in s.get('lines', []):
                line['text'] = line['text'].replace('GD&T', 'drawing')
        return d['sections']
    result, _ = _reword_review(monkeypatch, drops, lambda d: d['sections'][:-1])
    assert 'reworded_by' not in result and 'GD&T' in result['coverage']['found']
    assert result['reword_errors'] == ['codex: dropped posting keywords', 'opencode: changed the entries']


def test_reword_can_be_turned_off(monkeypatch):
    from jobagent import settings
    monkeypatch.setattr(settings, 'overrides', lambda: {'workers.resume_reword_engine': 'off'})
    result, calls = _reword_review(monkeypatch, reworded)
    assert calls == ['claude'] and 'reworded_by' not in result


def test_transcript_courses_drop_grades_and_mark_in_progress(tmp_path, monkeypatch):
    text = ('Perm Number: A1  PSTAT 126 -REGRESSION\nANALYSIS B 43364 4.0 4.0 4.0 12.00  ME 11 -INTRO CONCEPTS MEP 34777 1.0 1.0 0.0 0.00 '
            'PSTAT 131 -STAT MACHINE\nLEARN 42853 4.0 0.0 0.0 0.00')
    import pypdf
    monkeypatch.setattr(pypdf, 'PdfReader', lambda path: SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda: text)]))
    (tmp_path / 't.pdf').write_bytes(b'%PDF')
    courses = resume_review.profile_experience({'documents': {'transcript': str(tmp_path / 't.pdf')}})['transcriptCourses']
    assert courses == [{'code': 'PSTAT 126', 'title': 'REGRESSION ANALYSIS', 'status': 'completed'},
                       {'code': 'ME 11', 'title': 'INTRO CONCEPTS MEP', 'status': 'completed'},
                       {'code': 'PSTAT 131', 'title': 'STAT MACHINE LEARN', 'status': 'in progress'}]
    assert 'Courses on his transcript' in resume_review.review_prompt({'company': 'G', 'title': 'MLE'}, {}, [], [], {'transcriptCourses': courses})


def test_a_saved_copy_missing_most_keywords_gets_its_own_draft(monkeypatch):
    from jobagent import settings
    monkeypatch.setattr(settings, 'overrides', lambda: {'workers.resume_reword_engine': 'off'})
    monkeypatch.setattr(resume_review, '_cli', lambda name: '/bin/claude')
    base = resume_doc.normalize(RESUME)
    asks = []

    def run(args, input, **kw):
        asks.append(input)
        verdict = 'variant' if len(asks) == 1 else 'tailor'
        out = {'verdict': verdict, 'variant_id': 'saved', 'focus': 'f', 'summary': 's', 'keywords': ['GD&T', 'world models', 'transformers'],
               'verify': [], 'sections': base['sections'] if verdict == 'tailor' else []}
        return SimpleNamespace(returncode=0, stdout=json.dumps({'structured_output': out}), stderr='')
    saved = [{'id': 'saved', 'label': 'l', 'focus': 'f', 'resume': base}]
    result = resume_review.review({'company': 'X', 'title': 'ME', 'description': 'd'}, base, saved, [], {}, run=run)
    assert result['verdict'] == 'tailor' and result['draft'] and 'Return verdict "tailor"' in asks[1]
