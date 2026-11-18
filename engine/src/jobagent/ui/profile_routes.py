"""His profile page and the results view.

The profile page shows and edits what the application agents know about him (application-agent
private/profile.json) and his baseline resume. Saving the profile or the resume re-prints the baseline PDF in his
exact layout (services/resume_doc.py), with name, contact details, schools and employers taken from the profile.
Every save first copies the previous profile and resume aside, so nothing he had is lost.
"""
import json
import os
import re
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

from ..db.models import Application, JobStatus
from ..db.repository import get_db_session
from ..services import resume_doc
from .. import identity

router = APIRouter()
_lock = threading.Lock()
from ..config import AGENT_DIR  # noqa: E402

# Saved answers are shown in these sections. A key lands in the first section whose pattern it matches.
GROUPS = [
    ('about', 'About you', r'^(firstName|lastName|fullName|preferredName|email|phone|phoneCountry|address\w*|city|citySearch|country|linkedin|github|dateOfBirth|pronouns\w*|leverLocation|applicationLocationRule|validDriversLicense)$'),
    ('education', 'Education', r'^(school\w*|degree\w*|major|discipline|grad\w*|gpa\w*|eduStart\w*|highestCompletedEducation|bachelors\w*|satScore|actScore|greScore|leverOrg|futureEducation\w*|rocketClub)$'),
    ('authorization', 'Work authorization, citizenship and clearance', r'(workAuth|sponsor|citizenship|clearance|Clearance|itar|export|Export|usPerson|f1Opt|rightToWork|workRights|visa)'),
    ('availability', 'Availability, location and pay', r'(startDate|salary|Salary|relocat|Relocat|onsite|internship|willingTo|schedule|Schedule|officeCommit|Transportation)'),
    ('history', 'Employment history and conflicts', r'(Employment|employedBy|Contractor|contractor|PreviouslyWorked|History|Connections|Relative|conflictOfInterest|Terminated|Restrictive|layoffRecall|BoardM|BoardP|government|Government|GovEmployment|mayContact|noCurrentEmployer|confirmedEmployment|InternshipAt|lucidInternships)'),
    ('demographics', 'Voluntary self-identification', r'(eeo|gender|Gender|race|Race|ethnicity|Ethnicity|veteran|Veteran|disab|Disab|hispanic|ageBracket|ageRange|selfId|militarySpouse|armedForces|ServiceMember|Discharged|MilitaryJob|Selected$|fieldaiAdult)'),
    ('experience', 'Experience and skills answers', r'(Experience|esTool|technicalWork|mechanicalSpecialization)'),
    ('consent', 'Consents and how you heard', r'(Consent|heard|hearAbout|Heard|routineSourceChoice|PleaseSpecify|Certify|LegalName)'),
]

# Employer prefixes used by the application agent (src/dashboard-worker.mjs EMPLOYER_FACTS) and by saved answers.
EMPLOYERS = [('anduril', 'Anduril'), ('fieldai', 'FieldAI'), ('hermeus', 'Hermeus'), ('lucid', 'Lucid Motors'), ('jumio', 'Jumio'),
             ('oneX', '1X'), ('graphcore', 'Graphcore'), ('vast', 'Vast'), ('cobot', 'Collaborative Robotics'), ('merck', 'Merck'),
             ('boozAllen', 'Booz Allen'), ('hpe', 'HPE'), ('ey', 'EY'), ('spacex', 'SpaceX'), ('acs', 'ACS'), ('gmr', 'General Matter'),
             ('rel', 'Relativity Space'), ('rl', 'Rocket Lab'), ('sa', 'Shield AI'), ('es', 'Eight Sleep')]
SUFFIX_EMPLOYERS = {'SpaceX': 'SpaceX', 'Jumio': 'Jumio', 'Graphcore': 'Graphcore', 'Anduril': 'Anduril'}

# Questions that different employers ask in their own words, saved under several names. Each is shown once; saving
# writes every saved copy in its own form (Yes/No text or a checkbox). Membership was checked against his saved
# values on 2026-11-13: every copy held the same answer. A copy that ever disagrees is shown as a conflict, not merged.
TOPICS = [
    ('authorization', 'work-authorized', 'Are you legally authorized to work in the United States?',
     ['workAuthorized', 'workAuthYesNo', 'acsWorkAuth', 'andurilWorkAuth', 'fieldaiWorkAuth', 'hermeusWorkAuth', 'lucidWorkAuth', 'oneXWorkAuth', 'saWorkAuth', 'graphcoreRightToWork', 'graphcoreWorkRights']),
    ('authorization', 'sponsorship', 'Will you now or in the future need visa sponsorship?',
     ['sponsorship', 'sponsorshipYesNo', 'requiresSponsorship', 'andurilSponsorship', 'fieldaiSponsorship', 'hermeusSponsorship', 'lucidSponsorship', 'oneXSponsorship', 'saSponsorship']),
    ('authorization', 'clearance-eligible', 'Are you eligible for a U.S. security clearance?', ['clearanceEligibleYesNo', 'gmrClearanceEligible']),
    ('authorization', 'clearance-held', 'Do you hold, or have you ever held, a security clearance?', ['currentSecurityClearance', 'heldSecurityClearance']),
    ('authorization', 'us-person', 'Are you a U.S. person for export control (ITAR/EAR)?', ['itarEligible', 'usPersonEligible']),
    ('history', 'worked-here', 'Have you worked for the employer before (employee, intern or contractor)?',
     ['employerEmploymentDefault', 'employedByAnduril', 'lucidCurrentContractor', 'lucidInternshipAtLucid', 'vastContractor']),
    ('history', 'know-someone', 'Do you have relatives or personal connections at the employer?',
     ['employerConnectionsDefault', 'boozAllenPersonalConnections', 'hpePersonalConnections', 'eyEmployeeRelative']),
    ('history', 'government-work', 'Have you worked for the government?', ['governmentEmployment', 'rlGovEmployment']),
    ('demographics', 'military-service', 'Have you served in the armed forces?', ['armedForcesService', 'saServiceMember']),
    ('demographics', 'disability-yes-no', 'Do you have a disability?', ['selfIdDisability', 'selfIdPhysicalDisability']),
    ('demographics', 'veteran-wording', 'Veteran status', ['veteranStatus', 'eeoVeteran', 'veteranStatusGraphcore']),
    ('demographics', 'disability-wording', 'Disability status', ['disabilityStatus', 'eeoDisability']),
    ('demographics', 'gender', 'Gender', ['gender', 'eeoGender', 'selfIdGenderJumio']),
    ('demographics', 'ethnicity', 'Ethnicity', ['ethnicitySelfId', 'selfIdEthnicityJumio']),
    ('demographics', 'age', 'Age range', ['ageBracket', 'ageRange']),
    ('about', 'portfolio', 'Portfolio website', ['portfolio', 'website']),
    ('experience', 'eight-sleep-tools', 'Eight Sleep: every tool on its checklist ticked', [f'esTool{n}' for n in range(12)]),
]

LABELS = {
    'actScore': 'ACT score', 'satScore': 'SAT score (range)', 'satSpaceX': 'SAT score (exact, SpaceX)', 'greScore': 'GRE score',
    'applicationLocationRule': 'Home address to use, by region (rule)', 'city': 'City, state and country', 'citySearch': 'City (as typed into search boxes)',
    'bachelorsDegreeYesNo': "Do you have a bachelor's degree in mechanical engineering or a related field?", 'bachelorsDegreeYesNoNote': "Note on the bachelor's degree answer",
    'degree': 'Degree level', 'degreeBachelors': "Bachelor's degree (checkbox)", 'discipline': 'Discipline', 'eduStartMonth': 'Started university (month)', 'eduStartYear': 'Started university (year)',
    'gradMonth': 'Graduation month', 'gradYear': 'Graduation year', 'graduationDate': 'Graduation date', 'rlGraduation': 'Graduation term', 'rlSpring2027': 'Graduating by spring 2027?',
    'gpaExact': 'GPA (two decimals)', 'gpaNumber': 'GPA (number)', 'gpaBracket': 'GPA (out of 4.0 wording)', 'relGpa': 'GPA (degree and number)', 'gpaGraduate': 'Graduate GPA', 'gpaDoctorate': 'Doctorate GPA',
    'highestCompletedEducation': 'Highest education completed so far', 'leverOrg': 'School (as Lever forms list it)', 'leverLocation': 'Location (as Lever forms list it)',
    'schoolSearch': 'School (as typed into search boxes)', 
    'citizenshipCountries': 'Countries of citizenship', 'workAuthorizationCountries': 'Countries you may work in', 'citizenshipStatus': 'Citizenship status (form wording)',
    'rlCitizenship': 'Citizenship status (form wording)', 'rlCitizenshipOther': 'Other citizenship', 'everDualCitizenship': 'Have you ever held dual citizenship?',
    'clearanceEligibility': 'Clearance eligibility (form wording)', 'pastClearance': 'Past clearance (form wording)', 'securityClearance': 'Clearance held (form wording)', 'rlClearanceNA': 'Clearance: "not applicable" box',
    'exportControlPerson': 'Export-control status (long wording)', 'exportControlStatus': 'Export-control status (short wording)', 'andurilExport': 'Export-control status (form wording)',
    'hermeusExport': 'Export-control status (form wording)', 'relExportCompliance': 'Export-control status (form wording)', 'saExportStatus': 'Export-control status (form wording)', 'vastItar': 'ITAR/EAR status (form wording)',
    'f1OptStatus': 'F-1 / OPT status', 'workAuthSpaceX': 'Work authorization (form wording)', 'jumioSponsorship': 'Sponsorship answer saved for Jumio',
    'earliestStartDate': 'Earliest start date', 'minimumAnnualSalary': 'Minimum annual salary (USD)', 'salaryExpectationRule': 'Salary expectation (rule)',
    'relocationAssistanceRequired': 'Do you need relocation assistance?', 'willingToRelocate': 'Willing to relocate?', 'onsiteAlwaysOk': 'Fine with fully on-site work?',
    'officeCommitSF': 'Can you work from a San Francisco office?', 'internshipAvailabilityStart': 'Internship: earliest start', 'internshipDurationPreferenceMonths': 'Internship: preferred length (months)',
    'internshipFormatPreference': 'Internship: format', 'cobotReliableTransportation': 'Reliable transportation to work?', 'cobotSantaClaraFullTimeSchedule': 'Full-time on site in Santa Clara?',
    'cobotSeattleSchedule': 'Shift preference', 'saOfficeBoston': 'Office choice: Boston', 'saOfficeDallas': 'Office choice: Dallas', 'saOfficeSanDiego': 'Office choice: San Diego', 'saOfficeWashington': 'Office choice: Washington',
    'confirmedEmploymentCompanies': 'Employers you have confirmed working for', 'conflictOfInterest': 'Any conflict of interest?', 'employmentRestrictiveAgreements': 'Bound by a non-compete or similar agreement?',
    'everTerminatedOrAskedToResign': 'Ever terminated or asked to resign?', 'layoffRecall': 'Subject to a layoff recall?', 'forProfitBoardMember': 'On a for-profit board?', 'forProfitBoardPlans': 'Plans to join a for-profit board?',
    'governmentContractorExperience': 'Worked for a government contractor?', 'governmentEthicsOpinionStatus': 'Government ethics opinion', 'governmentPersonalConnections': 'Personal connections in government?',
    'mayContactCurrentEmployer': 'May the employer contact your current employer?', 'noCurrentEmployer': 'No current employer (checkbox)', 'lucidInternships': 'Have you completed internships?',
    'lucidPreviouslyWorked': 'Prior work for the employer (form wording)', 'spacexHistory': 'Prior work for the employer (form wording)',
    'eeoRace': 'Race (EEO wording)', 'race': 'Race (detailed)', 'hispanicEthnicity': 'Hispanic or Latino?', 'genderIdentity': 'Gender identity', 'eeoSignature': 'Self-identification signature', 'eeoSignatureDate': 'Self-identification signature date',
    'selfIdVeteran': 'Veteran status (short wording)', 'everDischarged': 'Ever discharged from the military?', 'usMilitaryJobTraining': 'U.S. military job training?', 'militarySpouse': 'Military spouse?',
    'gmrAsianSelected': 'Race box ticked: Asian', 'gmrMaleSelected': 'Gender box ticked: Male', 'gmrNotVeteranSelected': 'Veteran box ticked: not a veteran', 'fieldaiAdult': 'Are you 18 or older?',
    'handsOnHardwareExperience': 'Hands-on hardware experience?', 'mechanicalCadExperience': 'Mechanical CAD experience?', 'structuralAnalysisExperience': 'Structural analysis experience?',
    'mechanicalSpecialization': 'Mechanical specialization', 'solidworksExperience': 'SolidWorks experience level', 'revitBimExperience': 'Revit / BIM experience level', 'technicalWork3mo': 'Technical work in the last three months?',
    'hearAbout': 'How you heard about the role (default)', 'heardJobBoard': 'Heard through a job board (checkbox)', 'andurilHeard': 'How you heard about the role', 'jumioHeard': 'How you heard about the role',
    'vastHeardVia': 'How you heard about the role', 'vastHeardGoogle': 'Heard through Google (checkbox)', 'rlPleaseSpecify': 'How you heard (please specify)', 'relHeard0': 'How-you-heard box 1', 'relHeard1': 'How-you-heard box 2',
    'relHeardWebsite': 'Heard through the website (checkbox)', 'routineSourceChoiceAllowed': 'Agent may pick a routine "how did you hear" option', 'fieldaiCertify': 'Certification checkbox', 'saLegalName': 'Legal name as signed',
    'recruitmentEmailConsent': 'Recruiting emails allowed?', 'recruitmentMessageConsent': 'Recruiting messages allowed?', 'recruitmentSmsConsent': 'Recruiting text messages allowed?',
    'merckAIAssessmentConsent': 'Consent to AI assessment?', 'merckAIFutureMatchingConsent': 'Consent to AI matching for future roles?', 'merckMarketingConsent': 'Marketing emails allowed?',
    'phoneCountry': 'Phone country code', 'pronounsPlain': 'Pronouns', 'validDriversLicense': "Valid driver's license?", 'dateOfBirth': 'Date of birth',
}
YES, NO = {'yes', 'true'}, {'no', 'false'}


def employer_of(key: str) -> str | None:
    for suffix, name in SUFFIX_EMPLOYERS.items():
        if key.endswith(suffix) and key != suffix:
            return name
    return next((name for prefix, name in EMPLOYERS if re.match(prefix + r'(?=[A-Z0-9])', key)), None)


def as_bool(value):
    text = str(value).strip().casefold()
    return True if text in YES else False if text in NO else None


def topic_view(question: str, keys: list, answers: dict) -> dict | None:
    """One consolidated field for the saved copies of a question, or None when fewer than two copies exist."""
    present = [k for k in keys if k in answers]
    if len(present) < 2:
        return None
    values = [answers[k] for k in present]
    flags = [as_bool(v) for v in values]
    used = sorted({employer_of(k) or 'every employer' for k in present}, key=lambda n: (n != 'every employer', n))
    note = f"Saved {len(present)} times; used for {', '.join(used)}."
    if all(f is not None for f in flags):
        return {'kind': 'yesno', 'value': flags[0] if len(set(flags)) == 1 else None, 'conflict': len(set(flags)) > 1, 'keys': present, 'note': note}
    if all(isinstance(v, str) for v in values):
        same = len({v.strip() for v in values}) == 1
        return {'kind': 'text', 'value': values[0] if same else None, 'conflict': not same, 'keys': present, 'note': note}
    return None


def expand_topics(answers: dict, changes: dict) -> dict:
    """Turn a saved consolidated answer ("topic:<id>") into a value for each copy, in that copy's own form."""
    out = {}
    for key, value in changes.items():
        if not key.startswith('topic:'):
            out[key] = value
            continue
        topic = next((t for t in TOPICS if t[1] == key[6:]), None)
        seen = topic and topic_view(topic[2], topic[3], answers)
        if not seen:
            raise HTTPException(422, 'That combined answer no longer exists; reload the page.')
        for member in seen['keys']:
            if seen['kind'] == 'yesno':
                if not isinstance(value, bool):
                    raise HTTPException(422, f'"{topic[2]}" takes Yes or No.')
                out[member] = value if isinstance(answers[member], bool) else ('Yes' if value else 'No')
            else:
                out[member] = str(value)
    return out


def local_only(request: Request):
    from urllib.parse import urlparse
    origin = request.headers.get('origin')
    if origin and origin != 'null' and urlparse(origin).hostname not in ('localhost', '127.0.0.1'):
        raise HTTPException(403, 'The profile can only be changed from the local dashboard.')


def profile_path() -> Path:
    return AGENT_DIR / 'private/profile.json'


def load_profile() -> dict:
    try:
        return json.loads(profile_path().read_text())
    except (OSError, ValueError) as exc:
        raise HTTPException(503, f'The profile could not be read: {exc}')


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')


def save_profile(profile: dict):
    path = profile_path()
    backups = path.parent / 'profile-backups'
    backups.mkdir(exist_ok=True)
    os.chmod(backups, 0o700)
    if path.is_file():
        shutil.copy2(path, backups / f'profile-{_stamp()}.json')
    temporary = path.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(profile, indent=2, ensure_ascii=False) + '\n')
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def group_of(key: str) -> str:
    return next((gid for gid, _title, pattern in GROUPS if re.search(pattern, key, re.I)), 'other')


def label_of(key: str) -> str:
    employer = employer_of(key)
    if key in LABELS:
        return f'{employer}: {LABELS[key]}' if employer and not LABELS[key].startswith(employer) else LABELS[key]
    rest = key
    for prefix, name in EMPLOYERS:
        if name == employer and re.match(prefix + r'(?=[A-Z0-9])', key):
            rest = key[len(prefix):]
    words = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', rest).replace('_', ' ').strip()
    words = words[:1].upper() + words[1:].lower()
    return f'{employer}: {words}' if employer else words


def resume_path(profile: dict) -> Path:
    return AGENT_DIR / profile.get('resumePath', f'private/{identity.resume_filename()}')


def resume_structure(profile: dict) -> dict:
    path = resume_path(profile)
    saved = AGENT_DIR / 'private/resumes/baseline.json'
    try:
        if saved.is_file() and saved.stat().st_mtime >= path.stat().st_mtime:
            return json.loads(saved.read_text())
        return resume_doc.parse_pdf(path.read_bytes())
    except Exception as exc:
        raise HTTPException(503, f'The baseline resume could not be read: {exc}')


MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']


def month_year(pair) -> str:
    try:
        return f'{MONTHS[int(pair[0]) - 1]} {int(pair[1])}'
    except (TypeError, ValueError, IndexError):
        return ''


def _same(a: str, b: str) -> bool:
    flat = lambda s: re.sub(r'[^a-z0-9]+', ' ', (s or '').casefold()).strip()
    a, b = flat(a), flat(b)
    return bool(a and b) and (a in b or b in a)


def apply_profile(resume: dict, profile: dict) -> tuple[dict, list]:
    """The resume with the profile's facts written into it: name, contact details, and each school's and
    employer's title, place and (when the resume already prints dates in that style) dates. Bullets and skills
    are the resume's own text and are never rewritten here. Returns the resume and what changed."""
    answers, changes = profile.get('answers') or {}, []
    out = json.loads(json.dumps(resume))

    def put(holder, field, value, what):
        if value and holder.get(field) != value:
            changes.append(f'{what}: "{holder.get(field, "")}" → "{value}"')
            holder[field] = value

    # The resume keeps its own formatting (capitals, phone punctuation, bare web addresses): a detail is replaced
    # only when the profile's value is a different name, number or address, not a different way of writing it.
    digits = lambda text: re.sub(r'\D', '', str(text or ''))[-10:]
    bare = lambda text: re.sub(r'^https?://(www\.)?', '', str(text or '').strip()).rstrip('/').casefold()
    if answers.get('fullName') and str(answers['fullName']).casefold() != str(out.get('name', '')).casefold():
        put(out, 'name', str(answers['fullName']).upper() if str(out.get('name', '')).isupper() else answers['fullName'], 'Name')
    contact = list(out.get('contact') or [])
    for index, item in enumerate(contact):
        low, value = item.casefold(), None
        if '@' in item:
            value = answers.get('email') if str(answers.get('email') or '').casefold() != low else None
        elif 'linkedin.com' in low:
            value = bare(answers.get('linkedin')) if answers.get('linkedin') and bare(answers['linkedin']) != bare(item) else None
        elif 'github.com' in low:
            value = bare(answers.get('github')) if answers.get('github') and bare(answers['github']) != bare(item) else None
        elif re.fullmatch(r'[\d\s().+-]{7,}', item):
            value = answers.get('phone') if digits(answers.get('phone')) and digits(answers.get('phone')) != digits(item) else None
        if value:
            changes.append(f'Contact: "{item}" → "{value}"')
            contact[index] = str(value)
    out['contact'] = contact
    for section in out.get('sections') or []:
        for entry in section.get('entries') or []:
            for school in profile.get('education') or []:
                if section.get('style') == 'education' and _same(entry.get('org'), school.get('school')):
                    put(entry, 'org', school.get('school'), 'School')
            for job in profile.get('workHistory') or []:
                if section.get('style') != 'education' and _same(entry.get('org'), job.get('company')):
                    put(entry, 'role', job.get('title'), f"{job.get('company')} title")
                    put(entry, 'location', job.get('location'), f"{job.get('company')} location")
                    start, end = month_year(job.get('from')), month_year(job.get('to')) or 'Present'
                    if start and re.search(r'[A-Z][a-z]+ \d{4}\s*[–-]\s*([A-Z][a-z]+ \d{4}|Present)', entry.get('dates') or ''):
                        dash = '–' if '–' in entry['dates'] else '-'
                        spaced = f' {dash} ' if f' {dash} ' in entry['dates'] else dash
                        short = len(entry['dates'].split()[0]) == 3
                        text = spaced.join((d[:3] + d[d.index(' '):]) if short and ' ' in d else d for d in (start, end))
                        if text.casefold() != entry['dates'].casefold():
                            put(entry, 'dates', text, f"{job.get('company')} dates")
    return resume_doc.normalize(out), changes


def write_resume(profile: dict, resume: dict) -> dict:
    """Print the baseline resume and keep the copy it replaces in the resume archive."""
    resume = resume_doc.normalize(resume)
    fit = resume_doc.fit(resume)
    if not fit['fits']:
        raise HTTPException(422, f"The resume no longer fits on one page: it is {fit['lines_over']} line(s) too long. Shorten it and save again.")
    pdf = resume_doc.render_pdf(resume)
    path = resume_path(profile)
    archive = AGENT_DIR / 'private/resumes/archive'
    archive.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        shutil.copy2(path, archive / f'{path.stem}-{_stamp()}.pdf')
    temporary = path.with_suffix('.pdf.tmp')
    temporary.write_bytes(pdf)
    temporary.replace(path)
    saved = AGENT_DIR / 'private/resumes/baseline.json'
    saved.write_text(json.dumps(resume, indent=1, ensure_ascii=False))
    os.chmod(saved, 0o600)
    return fit


def view(profile: dict) -> dict:
    answers = profile.get('answers') or {}
    groups = {gid: {'id': gid, 'title': title, 'fields': []} for gid, title, _ in GROUPS}
    groups['other'] = {'id': 'other', 'title': 'Other saved answers', 'fields': []}
    merged = set()
    for gid, tid, question, keys in TOPICS:
        topic = topic_view(question, keys, answers)
        if not topic:
            continue
        merged.update(topic['keys'])
        groups[gid]['fields'].append({'key': f'topic:{tid}', 'label': question, **topic})
    for key in sorted(answers, key=lambda k: label_of(k).casefold()):
        if key in merged:
            continue
        value = answers[key]
        kind = 'bool' if isinstance(value, bool) else 'number' if isinstance(value, (int, float)) else 'text' if isinstance(value, str) or value is None else 'json'
        if kind == 'text' and as_bool(value) is not None:
            kind = 'yesno-text'
        field = {'key': key, 'label': label_of(key), 'kind': kind, 'value': value}
        if key == 'jumioSponsorship' and as_bool(value) is True and as_bool(answers.get('sponsorship')) is False:
            field['note'] = 'This says Yes while your other sponsorship answers say No. Check which is right.'
            field['conflict'] = True
        groups[group_of(key)]['fields'].append(field)
    resume = resume_structure(profile)
    synced, pending = apply_profile(resume, profile)
    return {'groups': [g for g in groups.values() if g['fields']], 'workHistory': profile.get('workHistory') or [],
            'education': profile.get('education') or [], 'skills': (profile.get('resumeSkills') or {}).get('list') or [],
            'resume': {'structure': resume, 'file': resume_path(profile).name, 'fit': resume_doc.fit(resume), 'pending': pending,
                       'updated': datetime.fromtimestamp(resume_path(profile).stat().st_mtime, timezone.utc).isoformat() if resume_path(profile).is_file() else None}}


class ProfileUpdate(BaseModel):
    answers: dict | None = None
    workHistory: list | None = None
    education: list | None = None
    resume: dict | None = None
    sync_resume: bool = True


@router.get('/api/profile')
def get_profile():
    return view(load_profile())


@router.post('/api/profile', dependencies=[Depends(local_only)])
def update_profile(body: ProfileUpdate):
    """Save edited facts and/or resume text; the baseline resume is re-printed with the profile's facts."""
    with _lock:
        profile = load_profile()
        changed = False
        if body.answers is not None:
            known = profile.setdefault('answers', {})
            for key, value in expand_topics(known, body.answers).items():
                if key not in known:
                    raise HTTPException(422, f'"{key}" is not a saved answer; new answers are added by the application agent or on Approvals.')
                if type(known[key]) is not type(value) and known[key] is not None and not (isinstance(known[key], (int, float)) and isinstance(value, (int, float)) and not isinstance(value, bool)):
                    raise HTTPException(422, f'"{label_of(key)}" must stay the same kind of value ({type(known[key]).__name__}).')
                changed |= known[key] != value
                known[key] = value
        for name, required in (('workHistory', ('title', 'company')), ('education', ('school', 'degree'))):
            rows = getattr(body, name)
            if rows is None:
                continue
            if not all(isinstance(r, dict) and all(str(r.get(k) or '').strip() for k in required) for r in rows):
                raise HTTPException(422, f'Every {name} entry needs {" and ".join(required)}.')
            changed |= profile.get(name) != rows
            profile[name] = rows
        resume = body.resume if body.resume is not None else resume_structure(profile)
        try:
            resume = resume_doc.normalize(resume)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        changes = []
        if body.sync_resume:
            resume, changes = apply_profile(resume, profile)
        resume_changed = body.resume is not None or bool(changes)
        fit = write_resume(profile, resume) if resume_changed else resume_doc.fit(resume)
        if changed:
            save_profile(profile)
        return {'saved': changed, 'resume_updated': resume_changed, 'resume_changes': changes, 'fit': fit, **view(load_profile())}


@router.post('/api/profile/resume/preview.png', dependencies=[Depends(local_only)])
def preview_resume(body: ProfileUpdate):
    """What the baseline resume would look like with these edits, without saving anything."""
    profile = load_profile()
    try:
        resume = resume_doc.normalize(body.resume if body.resume is not None else resume_structure(profile))
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    if body.sync_resume:
        resume, _ = apply_profile(resume, profile)
    return Response(resume_doc.render_png(resume, dpi=220), media_type='image/png', headers={'Cache-Control': 'no-store'})


@router.get('/api/profile/resume.png')
def resume_png():
    return Response(resume_doc.render_png(resume_structure(load_profile()), dpi=220), media_type='image/png', headers={'Cache-Control': 'no-store'})


@router.get('/api/profile/resume.pdf')
def resume_pdf():
    path = resume_path(load_profile())
    if not path.is_file():
        raise HTTPException(404, 'No baseline resume file was found.')
    return Response(path.read_bytes(), media_type='application/pdf', headers={'Cache-Control': 'no-store', 'Content-Disposition': f'inline; filename="{path.name}"'})


@router.get('/api/results')
def results():
    """Where every application stands, as flows for the results chart. Each count is a row in the applications
    table. A role counts as interviewed when its record says so, or when it stands at interview or offer."""
    with get_db_session() as session:
        rows = [(row.status.value if hasattr(row.status, 'value') else str(row.status), bool(row.interviewed)) for row in session.query(Application).all()]
    interviewed = lambda status, flag: flag or status in ('INTERVIEW', 'OFFER')
    count = lambda test: sum(1 for status, flag in rows if test(status, flag))
    stages = [('Applications', 'No answer yet', count(lambda s, f: s == 'APPLIED' and not f)),
              ('Applications', 'Rejected', count(lambda s, f: s == 'REJECTED' and not f)),
              ('Applications', 'Withdrawn by me', count(lambda s, f: s == 'WITHDRAWN' and not f)),
              ('Applications', 'Interviewed', count(interviewed)),
              ('Interviewed', 'Interviewing', count(lambda s, f: s == 'INTERVIEW' or (s == 'APPLIED' and f))),
              ('Interviewed', 'Rejected after interview', count(lambda s, f: s == 'REJECTED' and f)),
              ('Interviewed', 'Withdrawn after interview', count(lambda s, f: s == 'WITHDRAWN' and f)),
              ('Interviewed', 'Offer received', count(lambda s, f: s == 'OFFER'))]
    total = sum(value for source, _, value in stages if source == 'Applications')
    return {'total': total, 'links': [{'from': a, 'to': b, 'value': v} for a, b, v in stages if v]}
