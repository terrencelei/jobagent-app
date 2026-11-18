"""Decide which parked applications get one bounded background Codex review.

This module never approves an answer, starts a browser, or alters queue evidence.
"""
import hashlib
import json
import re

UNCERTAIN = {'submitted', 'submitted_pending_receipt', 'submitting', 'submission_unknown',
             'needs_human_verification', 'awaiting_verification_code', 'awaiting_human_submit'}
PROTECTED = re.compile(r'captcha|recaptcha|verify you are human|verification code|security code|'
                       r'no saved password|different password|missing credentials|unknown personal|'
                       r'rate.limit|site unavailable:|unusual traffic|\b429\b|usage limit|weekly limit|quota', re.I)
AMBIGUOUS = re.compile(r'^(?:pick (?:a )?date|select(?: one)?|choose(?: one)?|yes|no|other|loading|question)[.\s…*]*$', re.I)
WRITING = re.compile(r'\bwhy\b.*\b(?:you|us|here|join|work|interested|apply|company|role|fit)\b|'
                     r'^why\s+[\w& .\'-]{2,80}[?!]?$|\b(?:motivat\w*|achievements?|accomplishments?|'
                     r'proudest|proud of|challenges?|obstacles?|setbacks?|exceptional ability)\b|'
                     r'\b(?:describe|explain|tell|share|discuss)\b.*\b(?:projects?|contributions?|strengths?|'
                     r'experience|problems?|yourself|background)\b|\bwhat\b.*\binterested\b.*\bapply\b', re.I)
FACTUAL = re.compile(r'\b(?:enroll\w*|school|university|college|availability|dates?|salary|compensation|'
                     r'citizenship|visa|sponsorship|clearance|pronouns?|consent|relatives?|commitments?)\b', re.I)


def _text(value):
    return ' '.join(str(value or '').split())


def classify_attention(item, durable=None, cooling=False):
    durable = durable or {}
    questions = item.get('questions') or []
    canonical = []
    for question in questions:
        row = {key: _text(question[key]) for key in ('label', 'type', 'draft', 'note') if key in question}
        if 'required' in question:
            row['required'] = bool(question['required'])
        if 'options' in question:
            row['options'] = [_text(option) for option in question['options']]
        canonical.append(row)
    payload = {'status': item.get('status'), 'questions': canonical}
    if item.get('status') != 'needs_approval':
        payload['message'] = _text(item.get('message'))
    fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    def decision(state, reason, dispatch=False):
        return {'state': state, 'reason': reason, 'dispatch': dispatch,
                'fingerprint': fingerprint, 'questions': [q.get('label', '') for q in questions]}

    if (item.get('submitted') or item.get('submission_attempted') or item.get('submissionAttempted')
            or durable.get('submitted') or durable.get('submission_attempted') or durable.get('submissionAttempted')
            or item.get('status') in UNCERTAIN or durable.get('status') in UNCERTAIN):
        return decision('protected', 'Submission or verification evidence must be resolved before any preparation retry.')
    if cooling or PROTECTED.search(item.get('message') or ''):
        return decision('protected', 'Verification, credentials, a usage limit, or employer cooldown needs its existing recovery path.')
    if item.get('status') == 'needs_approval':
        if not questions or any(AMBIGUOUS.fullmatch(_text(q.get('label'))) for q in questions):
            return decision('technical', 'A missing or ambiguous control label needs technical inspection.', True)
        if any(re.search(r'no confirmed answer matches|dropdown|control|locator', q.get('note') or '', re.I) for q in questions):
            return decision('technical', 'A saved-answer or control mapping needs inspection.', True)
        writing = [q for q in questions if q.get('type') in {'text', 'textarea'}
                   and not q.get('options') and WRITING.search(q.get('label') or '')
                   and not FACTUAL.search(q.get('label') or '')]
        if any(not _text(q.get('draft')) for q in writing):
            return decision('draft_needed', 'Prepare factual, employer-specific writing for applicant review only.', True)
        if len(writing) == len(questions):
            return decision('review_ready', 'Proposed writing is ready for applicant approval; do not submit it automatically.')
        return decision('needs_user', 'Check saved facts once; remaining personal facts or decisions require the applicant.', True)
    if re.search(r'required fields still need answers', item.get('message') or '', re.I) and WRITING.search(item.get('message') or ''):
        return decision('needs_user', 'Missing application writing needs applicant review, not a technical retry.')
    if item.get('status') in {'failed', 'blocked', 'needs_human', 'interrupted'}:
        return decision('technical', 'Diagnose the preparation failure, including failures without a recognized error string.', True)
    return decision('ignored', 'This application is not waiting for background attention.')


def triage_prompt(item, decision):
    job_id = item['job_id']
    if item.get('status') != 'needs_approval':
        return ("This is an authorized bounded technical diagnosis. Inspect this job's saved artifacts and implementation. "
                "Preserve other agents' claims. Diagnose even if the failure text is unfamiliar. Make only a verified "
                "general repair with a regression test, then use retry-parked only when there is no attempted or uncertain "
                "submission evidence. Do not bypass CAPTCHA, invent facts, edit queue.json, or submit an application. "
                "If credentials, a personal fact, verification, or employer throttling is the actual cause, record that "
                "boundary and stop. You have ten minutes; finish with cause, tests and queue result.\nFailure: "
                + (item.get('message') or 'No failure message'))
    return (f"Perform one background Codex triage of approval job {job_id}. This is already authorized. "
            "Read the current approval API, saved profile and answer banks before asking for any fact again. "
            "Resolve only facts explicitly supported by those records through the normal resolve-facts API. "
            "Employer writing may be drafted using confirmed resume/project facts; save proposals ONLY through "
            f"POST /api/applications/jobs/{job_id}/answer-drafts with an answers mapping. A cover letter follows "
            "~/application-agent/docs/cover-letter-template.md, starting from private/cover-letter-base.md. All writing follows "
            "~/application-agent/private/writing-style.md (learned from his edits) and his recent edits in private/writing-feedback.jsonl. Do not approve prose, "
            "invent achievements, turn possible graduate study into enrollment, infer exact internship end dates, "
            "or use approve-answers for a new decision. Keep unknown facts as questions on the approval card. "
            "Existing good drafts need no duplicate rewrite. For ambiguous labels, inspect saved artifacts and repair "
            "the control mapping using a local regression; never guess what the field means. Do not directly submit, "
            "run a competing application, edit queue.json, or retry an uncertain attempt. This review is deduplicated "
            "until the questions or saved drafts meaningfully change. You have ten minutes. Finish with what was "
            "resolved, what draft is ready, and exactly which facts still need the applicant.\nClassification: "
            + decision['reason'])
