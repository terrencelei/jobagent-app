"""Same-origin local API for private application screens and answers."""
from urllib.parse import urlsplit
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
import asyncio
import base64
import json
from pydantic import BaseModel, Field
from typing import Literal, Any
from ..services.application_runner import get_runner
from ..services.assist import get_desk
from ..settings import setting
from .. import identity


def local_application_request(request: Request):
    host = request.url.hostname
    if host not in {'localhost', '127.0.0.1', '::1', 'testserver'}:
        raise HTTPException(403, 'Application controls require the local dashboard')
    if request.client and request.client.host not in {'127.0.0.1', '::1', 'testclient'}:
        raise HTTPException(403, 'Application controls are local only')
    origin = request.headers.get('origin')
    if origin:
        parsed = urlsplit(origin)
        if origin == 'null' or parsed.scheme != request.url.scheme or parsed.netloc != request.url.netloc:
            raise HTTPException(403, 'Open the local dashboard to view or control applications')
    if request.headers.get('sec-fetch-site') == 'cross-site':
        raise HTTPException(403, 'Cross-site application requests are blocked')
    if request.method != 'GET' and request.headers.get('x-jobagent-application') != '1':
        raise HTTPException(403, 'Application request header is required')


router = APIRouter(prefix='/api/applications', dependencies=[Depends(local_application_request)])


class QueueRequest(BaseModel):
    job_ids: list[int] = Field(min_length=1, max_length=100)
    position: Literal['end', 'next'] = 'end'
    allow_other_roles: bool = Field(default=False, strict=True)
    mark_fit: bool = Field(default=False, strict=True)  # his Good-fit label for roles the rules rated below eligible


class ImportRequest(BaseModel):
    """A posting he pastes as a link; company, title and location override what the page says."""
    url: str = Field(min_length=10, max_length=2048)
    company: str | None = Field(default=None, max_length=255)
    title: str | None = Field(default=None, max_length=512)
    location: str | None = Field(default=None, max_length=512)
    queue: bool = Field(default=True, strict=True)
    position: Literal['end', 'next'] = 'end'


class MoveRequest(BaseModel):
    index: int = Field(ge=0, le=1000)


class AutoplayRequest(BaseModel):
    enabled: bool | None = None
    disciplines: list[str] | None = Field(default=None, max_length=20)
    include_eligible: bool | None = None


class CompanyFilterRequest(BaseModel):
    companies: list[str] = Field(default_factory=list, max_length=500)


class AutoStopRequest(BaseModel):
    approvals: int = Field(ge=0, le=10000, strict=True)
    help: int = Field(ge=0, le=10000, strict=True)
    usage: int | None = Field(default=None, ge=0, le=100, strict=True)


class SubmissionPolicyRequest(BaseModel):
    require_approval: bool = Field(strict=True)


class ControlRequest(BaseModel):
    action: Literal['start', 'stop', 'configure']
    parallelism: int | None = Field(default=None, ge=1, le=50)  # the runner enforces his workers.max_parallelism setting
    engine: Literal['claude', 'codex'] | None = None


class CommandRequest(BaseModel):
    action: Literal['answer', 'approve', 'stop', 'open_browser', 'resume', 'retry']
    answers: dict[str, Any] | None = None
    review_id: str | None = Field(default=None, max_length=200)


def invoke(method, *args):
    try:
        return method(*args)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get('')
def application_status():
    return get_runner().snapshot()


@router.get('/manual-selection')
def manual_selection_options():
    return get_runner().manual_selection_options()


@router.get('/company-filter')
def company_filter():
    return get_runner().company_filter_view()


@router.post('/company-filter')
def set_company_filter(body: CompanyFilterRequest):
    return invoke(get_runner().configure_company_filter, body.companies)


@router.get('/costs')
def application_costs():
    return get_runner().cost_report()


@router.post('/queue')
def queue_applications(body: QueueRequest, request: Request):
    result = invoke(get_runner().queue, body.job_ids, body.position, body.allow_other_roles, body.mark_fit, from_dashboard(request))
    if result.get('labeled'):
        # A new label is evidence for the rule tuner, as it is from the fit-label route.
        from .server import tune_later
        from ..processing.tracks import active_track
        tune_later(active_track())
    return result


@router.post('/import')
def import_posting(body: ImportRequest):
    """Read the posting at a link, store it in JobAgent and (by default) queue it for application."""
    from ..discovery.link_import import import_posting as run_import
    overrides = {k: v or '' for k, v in (('company', body.company), ('title', body.title), ('location', body.location))}
    return invoke(run_import, body.url, overrides, body.queue, body.position)


@router.post('/jobs/{job_id}/move')
def move_application(job_id: int, body: MoveRequest):
    return invoke(get_runner().move, job_id, body.index)


@router.post('/jobs/{job_id}/skip')
def skip_application(job_id: int):
    return invoke(get_runner().skip, job_id)


@router.post('/jobs/{job_id}/remove')
def remove_application_from_list(job_id: int):
    return invoke(get_runner().remove_from_list, job_id)


class ApprovalAnswers(BaseModel):
    answers: dict[str, str] = Field(max_length=200)


class VerifyRequest(BaseModel):
    link: str = Field(min_length=10, max_length=4000)


@router.get('/approvals')
def list_approvals():
    return {'approvals': get_runner().approvals()}


class RecheckRequest(BaseModel):
    job_ids: list[int] | None = Field(default=None, max_length=200)


@router.post('/approvals/recheck')
def recheck_approvals(body: RecheckRequest | None = None):
    return get_runner().recheck_approvals(body.job_ids if body else None)


@router.post('/approvals/resolve-known')
def resolve_known_approvals(body: RecheckRequest | None = None):
    return invoke(get_runner().resolve_known_approvals, body.job_ids) if body is not None else invoke(get_runner().resolve_known_approvals)


@router.post('/jobs/{job_id}/approve-answers')
def approve_answers(job_id: int, body: ApprovalAnswers):
    return invoke(get_runner().approve_answers, job_id, body.answers)


@router.post('/jobs/{job_id}/answer-drafts')
def save_answer_drafts(job_id: int, body: ApprovalAnswers):
    return invoke(get_runner().save_answer_drafts, job_id, body.answers)


@router.post('/jobs/{job_id}/resolve-facts')
def resolve_facts(job_id: int, body: ApprovalAnswers):
    return invoke(get_runner().resolve_facts, job_id, body.answers)


class SubmitApproval(BaseModel):
    review_id: str | None = Field(default=None, max_length=200)


@router.post('/jobs/{job_id}/approve-submit')
def approve_submit(job_id: int, body: SubmitApproval | None = None):
    return invoke(get_runner().approve_submit, job_id, body.review_id if body else None)


class CapDecision(BaseModel):
    company: str = Field(min_length=1, max_length=255)
    allow: bool
    max: int | None = Field(default=None, ge=1, le=1000)
    days: int | None = Field(default=None, ge=1, le=36500)


@router.get('/caps')
def list_caps():
    runner = get_runner()
    with runner.lock:
        return {'caps': runner._caps_view()}


@router.post('/caps')
def decide_cap(body: CapDecision):
    """His decision on an employer's stated limit on applications (or one he adds himself)."""
    return invoke(get_runner().decide_cap, body.company, body.allow, body.max, body.days)


class ResumeDecision(BaseModel):
    choice: Literal['approve', 'current', 'variant', 'upload']
    variant_id: str | None = Field(default=None, max_length=80)
    label: str | None = Field(default=None, max_length=500)  # prefilled from the draft's focus; shortened when saved
    focus: str | None = Field(default=None, max_length=500)
    data: str | None = Field(default=None, max_length=15_000_000)  # base64 PDF


@router.post('/jobs/{job_id}/resume')
def decide_resume(job_id: int, body: ResumeDecision):
    """His resume for a role waiting on a tailored draft: approve the draft, upload his own PDF, pick a saved copy, or keep the standing one."""
    return invoke(get_runner().decide_resume, job_id, body.choice, body.variant_id, body.label, body.focus, body.data)


class ResumeDraft(BaseModel):
    resume: dict


class ResumeUpload(BaseModel):
    data: str = Field(min_length=10, max_length=15_000_000)  # base64 .docx


class LetterPreview(BaseModel):
    text: str = Field(min_length=1, max_length=20000)


@router.post('/cover-letter/preview')
def cover_letter_preview(body: LetterPreview):
    """The PDF a cover-letter answer becomes when approved: his resume's letterhead, Times 11 pt, one page."""
    return Response(invoke(get_runner().cover_letter_pdf, body.text), media_type='application/pdf', headers={'Cache-Control': 'no-store'})


@router.get('/jobs/{job_id}/resume/draft')
def resume_draft(job_id: int):
    return invoke(get_runner().resume_draft, job_id)


@router.post('/jobs/{job_id}/resume/draft')
def save_resume_draft(job_id: int, body: ResumeDraft):
    """His edits from the Approvals editor; the draft is re-checked for one page and keyword coverage, not approved."""
    return invoke(get_runner().save_resume_draft, job_id, body.resume)


@router.post('/jobs/{job_id}/resume/docx')
def import_resume_docx(job_id: int, body: ResumeUpload):
    """An edited Word copy of the draft; its text replaces the draft and is printed in the exact resume layout."""
    return invoke(get_runner().import_resume_docx, job_id, body.data)


@router.get('/jobs/{job_id}/resume/draft.pdf')
def resume_draft_pdf(job_id: int):
    return Response(invoke(get_runner().resume_draft_file, job_id, 'pdf'), media_type='application/pdf',
                    headers={'Content-Disposition': f'inline; filename="{identity.resume_filename()}"', 'Cache-Control': 'no-store'})


@router.get('/jobs/{job_id}/sent-resume.pdf')
def sent_resume(job_id: int):
    """The exact resume the application to this posting uploaded."""
    return FileResponse(invoke(get_runner().sent_resume, job_id), media_type='application/pdf',
                        headers={'Content-Disposition': f'inline; filename="{identity.resume_filename()}"', 'Cache-Control': 'no-store'})


@router.get('/jobs/{job_id}/resume/draft.png')
def resume_draft_png(job_id: int):
    return Response(invoke(get_runner().resume_draft_file, job_id, 'png'), media_type='image/png', headers={'Cache-Control': 'no-store'})


@router.get('/jobs/{job_id}/resume/draft.docx')
def resume_draft_docx(job_id: int):
    return Response(invoke(get_runner().resume_draft_file, job_id, 'docx'),
                    media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    headers={'Content-Disposition': f'attachment; filename="{identity.file_stem()}_Resume_{job_id}.docx"', 'Cache-Control': 'no-store'})


@router.post('/jobs/{job_id}/verify')
def verify_account(job_id: int, body: VerifyRequest):
    return invoke(get_runner().verify, job_id, body.link)


class HoldRequest(BaseModel):
    message: str = Field(min_length=1, max_length=600)


@router.post('/jobs/{job_id}/hold')
def hold_for_user(job_id: int, body: HoldRequest):
    return invoke(get_runner().hold_for_user, job_id, body.message)


@router.post('/jobs/{job_id}/finish-myself')
def finish_myself(job_id: int):
    """Fill the application in a plain Chrome window; he solves any CAPTCHA and presses Submit himself."""
    return invoke(get_runner().finish_myself, job_id)


@router.post('/jobs/{job_id}/mark-submitted')
def mark_submitted(job_id: int):
    """Record that the user submitted this posting and remove it from Needs help."""
    return invoke(get_runner().mark_submitted, job_id)


def from_dashboard(request: Request):
    """A click in his browser (fetch sends Sec-Fetch-Site), not an agent's curl."""
    return request.headers.get('sec-fetch-site') == 'same-origin' or request.headers.get('x-jobagent-user') == '1'


@router.post('/jobs/{job_id}/retry-parked')
def retry_parked(job_id: int, request: Request):
    # His Try again starts the runs-without-progress count over; a repair agent's retry does not.
    return invoke(get_runner().retry_parked, job_id, from_dashboard(request))


@router.get('/apply-yourself')
def apply_yourself():
    """Postings on sites that refuse the worker's browser, with the resume tailored for each."""
    return get_runner().apply_yourself()


@router.get('/apply-yourself/{job_id}/resume.pdf')
def apply_yourself_resume(job_id: int):
    return Response(invoke(get_runner().apply_yourself_resume, job_id), media_type='application/pdf',
                    headers={'Content-Disposition': f'inline; filename="{identity.resume_filename()}"', 'Cache-Control': 'no-store'})


@router.post('/apply-yourself/{job_id}/fill')
def fill_apply_yourself(job_id: int):
    """Fill this posting in his visible Chrome; he finishes and submits."""
    return invoke(get_runner().apply_yourself_fill, job_id)


@router.post('/apply-yourself/{job_id}/remove')
def remove_apply_yourself(job_id: int):
    return invoke(get_runner().remove_apply_yourself, job_id)


@router.get('/platform-yield')
def platform_yield():
    """Each hiring platform's recent automatic-submit rate and whether autoplay holds it."""
    return get_runner().platform_yields()


@router.post('/jobs/{job_id}/dismiss')
def dismiss_approval(job_id: int):
    return invoke(get_runner().dismiss, job_id)


class ChatMessage(BaseModel):
    text: str = Field(min_length=1, max_length=8000)


@router.get('/background-agents')
def background_agents():
    from ..settings import setting
    runner = get_runner()
    desk = get_desk()
    with runner.lock:
        jobs = {j['job_id']: dict(j) for j in runner.data['jobs']}
    with desk.lock:
        active_ids = list(desk.processes)
        logs = {job_id: desk.chat(job_id) for job_id in active_ids}
    agents = []
    for job_id in active_ids:
        item = jobs.get(job_id, {})
        log = logs[job_id]
        category = 'approval' if item.get('status') in {'needs_approval', 'needs_verification', 'needs_cap_approval', 'needs_resume'} else 'help'
        agents.append({'job_id': job_id, 'company': item.get('company', ''), 'title': item.get('title', ''), 'url': item.get('url', ''),
                       'engine': log.get('engine') or 'codex', 'category': category, 'status': 'working'})
    waiting = [{'job_id': item['job_id'], 'company': item.get('company', ''), 'title': item.get('title', ''), 'url': item.get('url', ''),
                'state': (item.get('background_triage') or {}).get('state', 'queued')}
               for item in jobs.values() if item.get('status') == 'needs_approval' and item['job_id'] not in active_ids]
    return {'active': len(agents), 'limit': setting('workers.max_repair_agents'), 'agents': agents, 'waiting': waiting}


@router.get('/help/{job_id}/resume.pdf')
def help_resume(job_id: int):
    """The resume a Needs help posting uploaded, or the tailored copy it will upload."""
    return Response(invoke(get_runner().help_resume, job_id), media_type='application/pdf',
                    headers={'Content-Disposition': f'inline; filename="{identity.resume_filename()}"', 'Cache-Control': 'no-store'})


@router.get('/help')
def help_items():
    desk = get_desk()
    items = get_runner().help_items()
    for item in items:
        chat = desk.chat(item['job_id'])
        item['chat'] = {'busy': chat['busy'], 'messages': len(chat['messages']), 'engine': chat['engine']}
    return {'items': items, 'auto_repair_enabled': get_runner().data.get('auto_repair_enabled', True)}


class AutoRepairRequest(BaseModel):
    enabled: bool = Field(strict=True)


class BreakerRequest(BaseModel):
    signature: str = Field(min_length=1, max_length=200)


class AgentSettingsRequest(BaseModel):
    engine: Literal['claude', 'codex', 'opencode']
    model: str = Field(min_length=1, max_length=180)
    parallelism: int = Field(ge=1, le=50, strict=True)
    usage: int = Field(ge=0, le=100, strict=True)


@router.get('/models')
def available_application_models():
    runner = get_runner()
    return {'models': runner.model_options(), 'engine': runner.data['engine'],
            'model': runner.data.get('model'), 'parallelism': runner.data['parallelism'],
            'max_parallelism': int(setting('workers.max_parallelism')),
            'usage_pause_percent': setting('workers.usage_pause_percent'),
            'claude_usage': runner.data.get('claude_usage')}


@router.post('/agent-settings')
def save_agent_settings(body: AgentSettingsRequest):
    return invoke(get_runner().configure_agent, body.engine, body.model, body.parallelism, body.usage)


@router.post('/breakers/clear')
def clear_breaker(body: BreakerRequest):
    """Resume a site held after repeated identical failures."""
    return invoke(get_runner().clear_breaker, body.signature)


@router.post('/help/auto-repair')
def configure_help_auto_repair(body: AutoRepairRequest):
    return get_runner().configure_auto_repair(body.enabled)


@router.post('/help/{job_id}/repair')
def start_help_repair(job_id: int):
    return invoke(get_runner().start_repair, job_id)


@router.get('/performance')
def automatic_application_performance():
    return get_runner().automatic_performance()


@router.get('/help/{job_id}/chat')
def help_chat(job_id: int):
    return get_desk().chat(job_id)


@router.post('/help/{job_id}/chat')
def help_send(job_id: int, body: ChatMessage):
    invoke(get_runner().mark_human_intervention, job_id)
    return invoke(get_desk().send, job_id, body.text)


class AgentEngine(BaseModel):
    engine: str = Field(pattern='^(claude|codex)$')
    model: str | None = Field(default=None, max_length=60)


@router.post('/help/{job_id}/engine')
def help_engine(job_id: int, body: AgentEngine):
    """Pin this posting's Help agent and its next application runs to Claude or Codex."""
    result = invoke(get_runner().set_agent_engine, job_id, body.engine, body.model)  # Validates the posting first.
    invoke(get_desk().switch_engine, job_id, body.engine, body.model)
    return result


@router.post('/help/{job_id}/chat/stop')
def help_stop(job_id: int):
    return invoke(get_desk().stop, job_id)


@router.post('/autoplay')
def configure_autoplay(body: AutoplayRequest):
    return invoke(get_runner().configure_autoplay, body.enabled, body.disciplines, body.include_eligible)


@router.post('/auto-stop')
def configure_auto_stop(body: AutoStopRequest):
    return invoke(get_runner().configure_auto_stop, body.approvals, body.help, body.usage)


@router.post('/submission-policy')
def configure_submission(body: SubmissionPolicyRequest):
    return invoke(get_runner().configure_submission, body.require_approval)


@router.post('/control')
def control_applications(body: ControlRequest):
    return invoke(get_runner().control, body.action, body.parallelism, body.engine)


@router.post('/jobs/{job_id}/command')
def command_application(job_id: int, body: CommandRequest):
    return invoke(get_runner().command, job_id, body.action, body.answers, body.review_id)


@router.get('/workers/{worker_id}/screenshot')
def application_screenshot(worker_id: str):
    path = invoke(get_runner().screenshot, worker_id)
    if not path.is_file():
        raise HTTPException(404, 'No screen is available yet')
    return FileResponse(path, media_type='image/jpeg', headers={'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin'})


@router.get('/live')
async def live_previews(request: Request):
    """One event stream carries every running worker's newest frame as it changes.

    A single connection keeps the panel within the browser's six-connections-per-host limit no
    matter how many workers run.
    """
    runner = get_runner()

    async def frames():
        sent, ticks = {}, 0
        yield 'retry: 2000\n\n'
        while not await request.is_disconnected():
            for worker_id, path in runner.live_frames():
                try:
                    stamp = path.stat().st_mtime_ns
                    if sent.get(worker_id) == stamp:
                        continue
                    data = path.read_bytes()
                except OSError:
                    continue
                sent[worker_id] = stamp
                yield f"event: frame\ndata: {json.dumps({'id': worker_id, 'jpeg': base64.b64encode(data).decode()})}\n\n"
            ticks += 1
            if ticks % 150 == 0:
                yield ': keepalive\n\n'
            await asyncio.sleep(0.1)

    return StreamingResponse(frames(), media_type='text/event-stream',
                             headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'})


class SlotRequest(BaseModel):
    engine: Literal['claude', 'codex']


@router.post('/slots/{index}')
def set_slot_engine(index: int, body: SlotRequest):
    return invoke(get_runner().set_slot_engine, index, body.engine)


@router.post('/check-engine')
def check_application_engine():
    runner = get_runner()
    for engine in runner.engines_in_use():
        runner.check_engine(engine)
    return runner.engine_status()


@router.post('/retry-engine-limits')
def retry_engine_limits():
    return get_runner().retry_engine_limits()


class ClearAttentionRequest(BaseModel):
    ids: list[str] = Field(max_length=10000)


class CooldownRequest(BaseModel):
    company: str = Field(min_length=1, max_length=200)


@router.post('/cooldowns/clear')
def clear_cooldown(body: CooldownRequest):
    """End one company's site cooldown now."""
    return invoke(get_runner().clear_cooldown, body.company)


@router.post('/recent/clear')
def clear_recent():
    """Empty the Recent list (the runs and their evidence stay)."""
    return invoke(get_runner().dismiss_recent)


@router.post('/recent/{job_id}/dismiss')
def dismiss_recent(job_id: int):
    return invoke(get_runner().dismiss_recent, job_id)


@router.post('/{category}/clear')
def clear_attention(category: Literal['approvals', 'help'], body: ClearAttentionRequest):
    runner = get_runner()
    if category == 'help':
        for item in runner.help_items():
            if item['id'] in body.ids:
                try:
                    get_desk().stop(item['job_id'])
                except ValueError:
                    pass
    return invoke(runner.clear_attention, category, body.ids)


@router.post('/restore-cleared')
def restore_cleared():
    return get_runner().restore_cleared()


@router.post('/restore-dismissed')
def restore_dismissed():
    return get_runner().restore_dismissed()


@router.post('/help/reconcile')
def reconcile_help(body: RecheckRequest | None = None):
    return invoke(get_runner().reconcile_help, body.job_ids) if body is not None else invoke(get_runner().reconcile_help)
