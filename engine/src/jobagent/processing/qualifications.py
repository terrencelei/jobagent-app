"""Shared, conservative qualification signals for eligibility and ranking."""

import re


EARLY_CAREER_PATTERN = r"(?i)\b(?:new[ -]grad(?:uate)?|university (?:grad(?:uate)?|hire)|entry[ -]level|early[ -]career|associate|junior|(?:engineer|analyst|scientist) (?:i|1)|level[ -]1)\b"
SENIOR_PATTERN = r"(?i)\b(?:senior|sr\.?|staff|principal|lead(?:er)?|director|vp|head of)\b|\bengineer\s+(?:ii|iii|iv|[2-9])\b"


def off_discipline_title(title: str, description: str = "", track=None):
    """The other discipline a title belongs to under a search track (config/tracks.yaml), or None."""
    from .tracks import get_track
    return (track or get_track()).off_discipline(title, description)


def is_early_career(title: str) -> bool:
    return bool(re.search(EARLY_CAREER_PATTERN, title)) and not bool(re.search(SENIOR_PATTERN, title))


def experience_years(description: str):
    """(required, preferred) years of experience a posting states; None where it states none."""
    from .eligibility import split_required_and_preferred
    required_text, preferred_text = split_required_and_preferred(description or "")
    return required_experience_years(required_text), required_experience_years(preferred_text, optional=True)


def required_experience_years(required_text: str, optional: bool = False):
    """Take the strongest independent requirement, but the lowest accepted alternative.

    The caller removes preferred sections first. A shorter Master's/PhD track is
    not a Bachelor's alternative. Missing experience is unknown, not zero.
    """
    pattern = re.compile(
        r"(?<![\d-])(\d{1,2})(?!\d)\s*(?:\(\d+\))?\s*\+?"
        r"(?:\s*(?:-|–|to)\s*\d{1,2}\s*\+?)?\s*years?\b[’']?"
        r"(?:\s+(?:of|in))?\s*(?:[\w/&,()+-]+\s+){0,18}?"
        r"(?:experience|designing|design|developing|development|building|working|leading|manufacturing|testing|engineering|professional|industry|hands-on|relevant)", re.I)
    # HTML list boundaries often separate a degree from its OR-experience alternative.
    required_text = re.sub(r"\n\s*OR\s+", " OR ", required_text)
    requirements = []
    for clause in re.split(r"\n|;|(?<=[.!?])\s+(?=[A-Z0-9])", required_text):
        clause = clause.lower().replace("’", "'")
        for word, number in {"zero":0,"one":1,"two":2,"three":3,"four":4,"five":5,"six":6,"seven":7,"eight":8,"nine":9,"ten":10}.items():
            clause = re.sub(rf"\b{word}(?=\s*(?:\(\d+\))?\s*(?:\+|years?))", str(number), clause)
        # Preferred-qualification clauses are skipped when reading requirements, and read when asked
        # for the preferred years; "combined/collective" years are never a single bar.
        if re.search(r"\b(?:combined|collective)\b|not required", clause) or (
                not optional and re.search(r"\b(?:preferred|desired|bonus)\b|nice to have|is a plus", clause)):
            continue
        # Upper bounds are not minimum requirements (e.g. Lucid's "2 years or less").
        clause = re.sub(r"\b\d+\s+years?\s+or\s+(?:less|fewer)\b", "0 years", clause)
        clause = re.sub(r"\b(?:up to|at most|no more than)\s+\d+\s+years?\b", "0 years", clause)
        # Comma-separated degree choices share the trailing experience requirement:
        # "BS, MS, or PhD + 10 years" does not offer a zero-experience BS path.
        clause = re.sub(r"(\b(?:bs|b\.s\.|ms|m\.s\.)\s*),\s*or\s+(?=(?:master|ms|m\.s\.|ph\.?d)\b)", r"\1, ", clause)
        # A completed bachelor's by the start date satisfies a degree-or-experience path.
        # Degree discipline and explicit completion deadlines are screened separately.
        if "in lieu of a degree" in clause or "in lieu of the degree" in clause:
            continue
        bachelor = r"bachelor|\bbs\b|\bb\.s\."
        branches = re.split(r"\s+or\s+(?=(?:(?:a|an)\s+)?(?:bachelor|degree\b|bs\b|b\.s\.|master|ms\b|m\.s\.|ph\.?d|high school|\d+\s*\+?\s*years?))", clause)
        if len(branches) > 1:
            degree_only = any(re.search(bachelor + r"|^(?:a |an )?degree\b", branch) and not re.search(r"\d+\s*\+?\s*years?", branch) for branch in branches)
            if degree_only:
                continue
            bachelor_branches = [branch for branch in branches if re.search(bachelor, branch)]
            if bachelor_branches:
                branches = bachelor_branches
        bars = [int(m.group(1)) for branch in branches for m in pattern.finditer(branch)]
        # Alternatives such as "BS + 5 years OR MS + 2 years" may omit the second
        # occurrence of 'experience', but only the bachelor's branch is applicable.
        if len(branches) != 1 or (re.search(bachelor, clause) and re.search(r"master|ph\.?d|\bms\b", clause)):
            bars = [int(m.group(1)) for branch in branches for m in re.finditer(r"(?<![\d-])(\d{1,2})(?!\d)\s*\+?\s*years?\b", branch)] or bars
        if bars:
            requirements.append(min(bars) if len(branches) > 1 else max(bars))
    return max(requirements) if requirements else None


def degree_requirements(required_text: str, acceptable_fields):
    """Inspect degree clauses, never company prose or the job title."""
    degree = r"\b(?:bachelor(?:'s|s)?|master(?:'s|s)?|ph\.?d\.?|b\.?s\.?|m\.?s\.?|degree|major)\b"
    clauses = [c.lower().replace('’', "'") for c in re.split(r"\n|;|(?<=[.!?])\s+(?=[A-Z])", required_text)]
    clauses = [c for c in clauses if re.search(degree, c) and not re.search(r"preferred|desired|bonus|is a plus|not required", c)]
    relevant, unrelated, masters, phd = False, False, False, False
    for clause in clauses:
        bachelor = bool(re.search(r"bachelor|\bb\.?s\.?\b|undergrad", clause))
        has_master = bool(re.search(r"master|\bm\.?s\.?\b", clause))
        has_phd = bool(re.search(r"ph\.?d", clause))
        # Junior/senior OR master's describes alternative student cohorts, not
        # a mandatory graduate degree. A separate hard degree clause still applies.
        cohort_choice = bool(re.search(r"\b(?:freshman|sophomore|junior|senior)\b[^.;\n]{0,80}\bor\s+(?:(?:a|their)\s+)?(?:master|ph\.?d)\b", clause))
        # A degree clause is a requirement unless explicitly marked optional/preferred.
        masters |= has_master and not bachelor and not cohort_choice
        phd |= has_phd and not bachelor and not cohort_choice
        # "Bachelor's degree (or equivalent) in", "degree or equivalent in" and similar asides.
        clause = re.sub(r"\s*\((?:or\s+)?(?:equivalent|similar|comparable)[^)]*\)|\s+or\s+(?:equivalent|comparable)(?=\s+in\b)", "", clause)
        field_match = re.search(rf"(?:{degree})\s*(?:degree\s*)?(?:program\s*)?(?:in|of science in)\s+(.+)", clause)
        if not field_match:
            if re.search(r"\b(?:bsme|engineering degree|degree in engineering)\b", clause):
                relevant = True
            continue
        fields = re.split(r"\brequired\b|\bwith\b|\band \d|[.;]", field_match.group(1))[0]
        # "Graduating with a bachelor's, master's or PhD in 2027" states a cohort year, not a
        # discipline. Reading 2027 as the required field made a mechanical engineering role
        # ineligible for a mechanical engineer.
        if re.match(r"\s*(?:19|20)\d{2}\b", fields):
            continue
        broad = bool(re.search(r"\b(?:(?:related|relevant)\s+(?:technical|engineering)|stem|quantitative)\s+(?:field|discipline|degree|major)\b", fields))
        # "an engineering discipline", "any engineering field": the discipline is engineering at
        # large, which is exactly what a generic engineering degree satisfies.
        broad |= bool(re.search(r"\bengineering\s+(?:discipline|field|major)\b", fields))
        matched = broad
        for field in acceptable_fields:
            if field == 'engineering':
                # Generic engineering is accepted, not every discipline ending in engineering.
                matched |= bool(re.search(r"(?:^|[,/]\s*|\bor\s+|\b(?:an?|any)\s+)engineering\b", fields))
            else:
                matched |= bool(re.search(rf"\b{re.escape(field)}\b", fields))
        relevant |= matched
        unrelated |= not matched
    # Degree alternatives may be separate list items.
    if any(re.search(r"bachelor|\bb\.?s\.?\b", c) for c in clauses) and any(re.search(r"\bor\b", c) for c in clauses):
        masters = phd = False
    return relevant, unrelated, masters, phd


def documented_experience_years(profile, today=None):
    """Upper bound from dated work history; overlaps and future time count once/never.

    This is deliberately an upper bound, not a claim that every month qualifies
    in every discipline. Undated projects cannot establish a numeric requirement.
    """
    from datetime import date
    today = today or date.today()
    intervals = []
    for role in profile.experience:
        start = date.fromisoformat(role.start_date)
        end = min(date.fromisoformat(role.end_date), today) if role.end_date else today
        if start < end:
            intervals.append((start, end))
    days = 0
    finish = None
    for start, end in sorted(intervals):
        start = max(start, finish) if finish else start
        days += max(0, (end - start).days)
        finish = max(finish, end) if finish else end
    return days / 365.25


def unsupported_specialist_requirements(required_text, profile):
    """Explicit specialist requirements discovered during review, checked against facts."""
    background = ' '.join([r.summary + ' ' + ' '.join(r.signals) for r in profile.experience]
                          + [p.summary + ' ' + ' '.join(p.signals) for p in profile.projects]).lower()
    gaps = []
    rules = [
        (r"experience\s+(?:in|with)\s+full[ -]stack\s+(?:development|software)",
         r"full[ -]stack|front[ -]?end.*back[ -]?end|back[ -]?end.*front[ -]?end", "full-stack development"),
        (r"experience\s+designing\s+and\s+implementing\s+security\s+solutions",
         r"security solutions|cybersecurity|security engineering|information security", "designing and implementing security solutions"),
    ]
    for requirement, evidence, label in rules:
        if re.search(requirement, required_text, re.I) and not re.search(evidence, background, re.I):
            gaps.append(f"Not selected: required {label} experience is not documented in the candidate's work or projects.")
    return gaps
