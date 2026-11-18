"""Each parked application receives safe, deduplicated background review."""
import json
from types import SimpleNamespace
import threading
import pytest
from jobagent.services.attention_triage import classify_attention, triage_prompt
from jobagent.services import application_runner as module


def approval(job_id=1, **changes):
    return {'id':f'run-{job_id}', 'job_id':job_id, 'company':f'Employer {job_id}',
            'status':'needs_approval', 'questions':[{'label':'What school will you attend after the internship?', 'type':'textarea'}], **changes}


def test_personal_facts_and_ready_writing_get_one_initial_review_without_becoming_answers():
    personal=classify_attention(approval())
    assert personal['state']=='needs_user' and personal['dispatch']
    ready=classify_attention(approval(questions=[{'label':'Why this company?', 'type':'textarea', 'draft':'A review draft.'}]))
    assert ready['state']=='review_ready' and not ready['dispatch']
    missing=classify_attention(approval(questions=[{'label':'Describe your project.', 'type':'textarea'}]))
    assert missing['state']=='draft_needed'
    assert 'answer-drafts' in triage_prompt(approval(),personal)
    assert 'Do not approve prose' in triage_prompt(approval(),personal)


def test_ambiguous_labels_and_unrecognized_preparation_errors_are_technical():
    assert classify_attention(approval(questions=[{'label':'Pick date...', 'type':'text'}]))['state']=='technical'
    assert classify_attention(approval(status='failed', message='An unfamiliar form renderer stopped.'))['dispatch']
    assert classify_attention(approval(status='blocked', message='Required fields still need answers: Explain why you want to work here'))['state']=='needs_user'


@pytest.mark.parametrize('changes,durable',[
    ({'submission_attempted':True},{}), ({},{'status':'submission_unknown'}),
    ({'status':'needs_human','message':'CAPTCHA still open'},{}),
    ({'status':'blocked','message':'No saved password'},{}),
    ({'status':'failed','message':'Unknown personal information'},{}),
    ({'status':'failed','message':'site unavailable: 429'},{}),
])
def test_verification_and_human_boundaries_never_dispatch(changes,durable):
    assert not classify_attention(approval(**changes),durable)['dispatch']


def test_fingerprint_changes_only_when_questions_or_drafts_change():
    item=approval(); first=classify_attention(item)['fingerprint']
    assert classify_attention({**item,'updated_at':'later','message':'different count'})['fingerprint']==first
    assert classify_attention(approval(questions=[{'label':'What school will you attend after the internship?','type':'textarea','draft':'A saved draft'}]))['fingerprint']!=first


@pytest.fixture
def runner(tmp_path,monkeypatch):
    r=module.ApplicationRunner.__new__(module.ApplicationRunner)
    r.directory=tmp_path/'runs';r.directory.mkdir();r.agent_dir=tmp_path/'agent'
    (r.agent_dir/'private').mkdir(parents=True);(r.agent_dir/'state').mkdir()
    r.data={'jobs':[], 'engine':'claude'};r.processes={};r._cooling=lambda item:False
    r._repair_desk=SimpleNamespace(processes={},calls=[],lock=threading.RLock())
    def send(job_id,text,engine=None,internal=False,**_):
        r._repair_desk.calls.append((job_id,engine,internal,text));r._repair_desk.processes[job_id]=object()
    r._repair_desk.send=send
    monkeypatch.setattr(module,'setting',lambda key:2)
    return r


def test_approval_reviews_share_help_budget_and_deduplicate_after_completion(runner):
    runner.data['jobs']=[approval(1),approval(2,questions=[{'label':'Why this company?','type':'textarea','draft':'Ready for review.'}]),approval(3)]
    runner._repair_technical_failures()
    assert [(j,e,i)for j,e,i,_ in runner._repair_desk.calls]==[(1,'claude',False),(3,'claude',False)]  # Claude (Opus 5.5) by default
    assert runner.data['jobs'][1]['background_triage']['state']=='review_ready'
    runner._repair_desk.processes.clear();runner._repair_technical_failures()
    assert [c[0]for c in runner._repair_desk.calls]==[1,3]
    assert runner.data['jobs'][0]['background_triage']['state']=='needs_user'
    assert runner.data['jobs'][1]['background_triage']['state']=='review_ready'
    runner._repair_desk.processes.clear();runner._repair_technical_failures()
    assert len(runner._repair_desk.calls)==2
    runner.data['jobs'][0]['questions'].append({'label':'Describe a project.', 'type':'textarea'})
    runner._repair_technical_failures();assert len(runner._repair_desk.calls)==3
    assert runner.data['jobs'][0]['status']=='needs_approval'


def test_public_chats_and_employer_claims_block_new_approval_triage(runner):
    runner.data['jobs']=[approval(1),approval(2,company='Employer 1'),approval(3)]
    runner._repair_desk.processes[1]=object();runner._repair_technical_failures()
    assert [c[0]for c in runner._repair_desk.calls]==[3]
    assert runner.data['jobs'][1]['background_triage']['state']=='queued'


def test_saved_draft_changes_trigger_one_new_review_and_uncertain_jobs_stay_protected(runner):
    runner.data['jobs']=[approval(1),approval(2,submission_attempted=True)]
    runner._repair_technical_failures();runner._repair_desk.processes.clear()
    (runner.directory/'answer-drafts.json').write_text(json.dumps({'1':{runner.data['jobs'][0]['questions'][0]['label']:'User-edited fact draft'}}))
    runner._repair_technical_failures()
    assert [c[0]for c in runner._repair_desk.calls]==[1,1]
    assert runner.data['jobs'][1]['background_triage']['state']=='protected'


def test_whitespace_reformatting_does_not_buy_another_agent_review():
    a=approval(questions=[{'label':'Why this company?', 'type':'textarea', 'draft':'A ready draft.'}])
    b=approval(questions=[{'label':'Why  this company? ', 'type':'textarea', 'draft':'A ready\n draft.'}])
    assert classify_attention(a)['fingerprint']==classify_attention(b)['fingerprint']


def test_an_idle_claude_session_is_preserved_when_a_new_codex_triage_is_requested(runner):
    log={'engine':'claude','session':'old-fixture-session','messages':[{'role':'assistant','text':'Earlier diagnosis.'}]}
    runner._repair_desk.chat=lambda job_id:log
    runner._repair_desk._save=lambda updated:log.update(updated)
    runner.data['jobs']=[approval(1,agent_engine='codex')]  # he pinned this posting to Codex
    runner._repair_technical_failures()
    assert log['engine']=='codex' and log['session'] is None
    assert log['prior_sessions']==[{'engine':'claude','model':None,'session':'old-fixture-session'}]
    assert log['messages']==[{'role':'assistant','text':'Earlier diagnosis.'}]
    assert runner._repair_desk.calls[0][1]=='codex'
