"""Eligibility Engine for candidate-job compatibility analysis."""

from datetime import datetime, timezone
import html
import re
from typing import Any, Dict, List, Optional, Tuple

from ..identity import grad_timing
from .location_prefs import location_fit
from ..config import CandidateProfileConfig, RankingConfig, load_profile_config, load_ranking_config
from ..db.models import EligibilityStatus
from .qualifications import SENIOR_PATTERN, off_discipline_title, is_early_career, required_experience_years, degree_requirements, documented_experience_years, unsupported_specialist_requirements


PREFERRED_HEADER_REGEX = re.compile(
    r"(?:\n|^)[#*_\s]*(?:"
    r"preferred\s*(?:qualifications?|requirements?|skills?|experience|background)?"
    r"|desired\s*(?:qualifications?|requirements?|skills?|experience|background)?"
    r"|nice\s*to\s*haves?"
    r"|bonus\s*(?:points?|qualifications?|skills?)?"
    r"|pluses?"
    r"|what\s*(?:will\s*make\s*you\s*stand\s*out|gives\s*you\s*an\s*edge)"
    r"|it(?:\x27s|\s+is)\s*a\s*plus\s*if\s*you\s*have"
    r"|what\s*sets\s*you\s*apart"
    r"|good\s*to\s*have"
    r")[#*_\s]*:?\s*(?:\n|$)",
    re.IGNORECASE | re.MULTILINE,
)

FOOTER_BOUNDARY_REGEX = re.compile(
    r"(?:\n|^)[#*_\s]*(?:"
    r"about\s+(?:us|the\s+company|our\s+team|[A-Za-z0-9\s]+)"
    r"|benefits(?:\s+and\s+perks|\s+overview)?"
    r"|compensation(?:\s+and\s+benefits)?(?:.*range)?"
    r"|(?:us\s*)?salary\s*(?:range)?"
    r"|perks"
    r"|what\s+we\s+offer"
    r"|total\s+rewards"
    r"|equal\s+(?:opportunity|employment)"
    r"|eeo"
    r"|diversity\s*(?:and\s*inclusion)?"
    r"|additional\s+information"
    r"|interview\s+process"
    r"|how\s+to\s+apply"
    r")[#*_\s]*:?\s*(?:\n|$)",
    re.IGNORECASE | re.MULTILINE,
)


def clean_html_text(text: Optional[str]) -> str:
    """Clean HTML entities and tags while preserving formatting structure."""
    if not text:
        return ""
    for _ in range(3):
        decoded = html.unescape(text)
        if decoded == text:
            break
        text = decoded
    # Replace block elements and linebreaks with newlines
    text = re.sub(r"</?(?:br|p|div|li|h\d|tr)\b[^>]*>", "\n", text, flags=re.IGNORECASE)
    # Strip remaining tags
    text = re.sub(r"<[^>]+>", " ", text)
    # Clean whitespace while preserving single newlines
    lines = [line.strip() for line in text.split("\n")]
    return "\n".join(line for line in lines if line)


def split_required_and_preferred(description: Optional[str]) -> Tuple[str, str]:
    """
    Split a job description into required/core text and preferred/bonus qualifications.
    Ensures that preferred qualifications do not disqualify candidates for baseline eligibility.
    """
    if not description:
        return "", ""
    cleaned = clean_html_text(description)
    required, preferred = [], []
    in_preferred = False
    # Recognise headers even when the first qualification follows a colon inline.
    headers = re.compile(
        r"(?im)(?:^|\n)\s*(?P<header>preferred (?:qualifications?|skills?(?: and experience)?|experience)|"
        r"desired (?:qualifications?|skills?|experience)|nice[- ]to[- ]haves?|bonus(?: points)?|"
        r"required qualifications?|basic qualifications?|minimum qualifications?|requirements?|"
        r"additional requirements?|what you(?:'ll| will) (?:need|bring)|"
        r"these qualifications would be nice to have|benefits|compensation(?: and benefits)?)\s*:?[ \t]*"
    )
    cleaned = headers.sub(lambda m: "\n@@" + m.group('header') + "@@\n", cleaned)
    for line in cleaned.splitlines():
        if line.startswith('@@'):
            header = line.strip('@').lower()
            in_preferred = any(x in header for x in ('preferred', 'desired', 'nice', 'bonus'))
            continue
        if PREFERRED_HEADER_REGEX.fullmatch(line):
            in_preferred = True
            continue
        if FOOTER_BOUNDARY_REGEX.fullmatch(line):
            in_preferred = False
        # Inline optional requirements also must not become mandatory gates.
        parts = re.split(r"(?<=[.!?;])\s+(?=[A-Z0-9])", line)
        for part in parts:
            optional = re.search(r"\b(?:preferred|desired)\b|bonus points|nice to have|is a plus|not required", part, re.I)
            (preferred if in_preferred or optional else required).append(part)
    return "\n".join(required), "\n".join(preferred)


def _plain_text(raw: str) -> str:
    """Readable text from a stored description.

    Descriptions arrive HTML-escaped, so the markup survives as literal &lt;p&gt; noise.
    Left as-is, every phrase pattern here reads tags as if they were prose and the
    requirement/preferred split lands in the wrong place.
    """
    if not raw:
        return ""
    text = html.unescape(html.unescape(raw))
    text = re.sub(r"<(?:br|/p|/div|/li|/h[1-6])\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"<li\b[^>]*>", "\n- ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    return re.sub(r"[ \t]{2,}", " ", text)


class EligibilityEngine:
    def __init__(
        self,
        profile_config: Optional[CandidateProfileConfig] = None,
        ranking_config: Optional[RankingConfig] = None,
        track=None,
    ):
        from .tracks import get_track
        self.profile = profile_config or load_profile_config()
        self.ranking = ranking_config or load_ranking_config()
        # Which search this engine judges for (config/tracks.yaml); the active one by default.
        self.track = track or get_track()

    # A fixed-term programme is an internship whatever it is called. Astranis lists twelve-week
    # "Associate" roles with no "intern" in the title; taking those at face value would send a
    # full-time candidate at a three-month placement.
    _FIXED_TERM = re.compile(
        r"(?:typically\s+)?last(?:s|ing)?\s+(?:for\s+)?(?:about\s+)?"
        r"(?:\d{1,2}|one|two|three|four|six|eight|ten|twelve|sixteen)[\s-]*(?:weeks|months)"
        r"|\b\d{1,2}[\s-]week\s+(?:program|programme|position|role|internship)"
        r"|\bfixed[\s-]term\b|\btemporary\s+(?:position|role|assignment)\b",
        re.I,
    )

    @classmethod
    def classify_role_type(cls, title: str, description: str = "", employment_type: str = "") -> str:
        """FULL_TIME or INTERNSHIP, from the title and any fixed-term wording in the body."""
        if re.search(r"\b(intern|internship|co[ -]?op)\b", f"{title} {employment_type or ''}", re.I):
            return "INTERNSHIP"
        if description and re.search(
            r"(?:associate(?: engineer)? (?:positions?|roles?)|(?:this|the) (?:position|role|program(?:me)?))[^.\n]{0,100}(?:last(?:s|ing)? (?:for )?(?:twelve|\d+) weeks|fixed[ -]term|temporary)",
            _plain_text(description), re.I,
        ):
            return "INTERNSHIP"
        if re.search(r"\b(contract|temporary|part[ -]?time)\b", f"{title} {employment_type or ''}", re.I):
            return "OTHER"
        return "FULL_TIME"

    def evaluate(
        self,
        title: str,
        description: str,
        location: Optional[str] = None,
        employment_type: Optional[str] = None,
        salary_min: Optional[float] = None,
    ) -> Tuple[EligibilityStatus, List[str], Optional[str], bool]:
        """
        Evaluate candidate eligibility for a job.
        Returns:
            (EligibilityStatus, reasons, stated_start_date, has_start_date_conflict)
        """
        reasons: List[str] = []
        description = _plain_text(description)
        required_text, preferred_text = split_required_and_preferred(description)
        required_corpus = f"{title}\n{required_text}".lower()
        full_corpus = f"{title}\n{clean_html_text(description)}".lower()
        title_lower = title.lower()

        # 0. Geographic Screening (US-only authorized candidate)
        is_outside_us = False
        if location:
            loc_lower = location.lower()
            non_us_markers = [
                "united kingdom", "london", "uk", "germany", "berlin", "munich",
                "canada", "toronto", "vancouver", "waterloo", "montreal", "quebec", "ottawa",
                "france", "paris", "india", "bengaluru", "bangalore", "hyderabad", "pune",
                "australia", "sydney", "melbourne", "singapore", "japan", "tokyo",
                "netherlands", "amsterdam", "switzerland", "zurich", "china", "taiwan",
                "mexico", "brazil", "ireland", "dublin", "israel", "tel aviv", "new zealand",
                "thailand", "bangkok", "vietnam", "argentina", "sweden", "stockholm", "poland", "warsaw", "italy", "spain", "south korea", "seoul"
            ]
            if any(re.search(rf"\b{re.escape(m)}\b", loc_lower) for m in non_us_markers):
                if not any(re.search(rf"\b{re.escape(u)}\b", loc_lower) for u in ["united states", "hybrid - us", "us only"]):
                    is_outside_us = True
                    reasons.append(f"Geographic ineligibility: Location '{location}' is outside the United States.")

        # The student can limit the search to the places they chose in Setup (candidate.location_strict).
        _cand = self.profile.candidate if isinstance(self.profile.candidate, dict) else {}
        if location and not is_outside_us and _cand.get("location_strict") and _cand.get("target_locations"):
            _, in_chosen_place = location_fit(location, _cand["target_locations"], bool(_cand.get("remote_ok", True)))
            if not in_chosen_place:
                is_outside_us = True
                reasons.append(f"Location '{location}' is outside the places you chose.")

        # An internship is the wrong shape of role for a candidate who will already have
        # graduated, however well its season matches.
        cand_dict = self.profile.candidate if isinstance(self.profile.candidate, dict) else self.profile.candidate.__dict__
        # Graduation year, availability and term names all come from the profile (identity.py).
        timing = grad_timing(self.profile)
        Y, P = timing.year, timing.prior_year
        grad_month, avail_season = timing.grad_month, timing.avail_season
        terms = timing.school_terms_pattern()
        seeking = cand_dict.get("seeking_role_type", "full-time")
        is_internship = bool(re.search(r"\b(intern|internship|co-?op)\b", title_lower))
        if is_internship and seeking == "full-time":
            reasons.append(f"Role type mismatch: '{title}' is an internship or co-op; candidate is seeking full-time work after graduating in {timing.grad_label}.")

        is_senior = bool(re.search(SENIOR_PATTERN, title_lower)) or bool(
            re.search(r"\bmanager\b", title_lower) and "program manager" not in title_lower
        )

        if is_senior:
            reasons.append(f"Seniority conflict: Title contains senior/lead designation ({title})")

        # 1. Start Date & Graduation Timing Analysis
        has_start_date_conflict = False
        stated_start_date: Optional[str] = None
        is_explicit_cohort_match = False

        # Strong matches, e.g. for a June 2027 graduate: Summer 2027, 2027 New Grad, Class of 2027, June 2027
        strong_timing_patterns = [
            rf"{avail_season}\s*{timing.available.year}",
            rf"{grad_month}\s*{Y}",
            rf"{Y}\s*(?:new\s*grad|university\s*grad|university\s*hire|campus\s*hire)",
            rf"class\s*of\s*(?:{P}\s*(?:or|and|/)\s*)?{Y}",
            rf"graduating\s*between\s*(?:december\s*{P}|fall\s*{P})\s*and\s*(?:{grad_month}\s*{Y}|{avail_season}\s*{Y})",
            rf"graduat(?:e|ing)\s*(?:in\s*)?{Y}",
        ]
        for pat in strong_timing_patterns:
            match = re.search(pat, full_corpus)
            if match:
                is_explicit_cohort_match = True
                stated_start_date = match.group(0).title()
                reasons.append(f"Target graduation/start match: explicitly welcomes '{stated_start_date}'")
                break

        # Check for academic schedule conflicts: the candidate is enrolled full-time until graduation
        available_school_year = cand_dict.get("available_during_school_year", False)
        if not available_school_year and terms:
            enrolled = f"candidate enrolled full-time at {timing.school} until {timing.grad_label}"
            school_year_intern_patterns = [
                (rf"\b(?:{terms})\b.*?\b(?:intern|internship|co-?op)\b", f"School-year internship ({enrolled})"),
                (rf"\b(?:intern|internship|co-?op)\b.*?\b(?:{terms})\b", f"School-year internship ({enrolled})"),
                (rf"\bco-?op\s*(?:in\s*)?(?:{terms})\b", f"School-year co-op ({enrolled})"),
            ]
            for s_pat, s_desc in school_year_intern_patterns:
                m = re.search(s_pat, full_corpus)
                if m:
                    has_start_date_conflict = True
                    stated_start_date = m.group(0).strip()
                    reasons.append(f"Availability conflict: '{stated_start_date}' conflicts with candidate's academic schedule (available from {timing.avail_day_label}).")
                    break

        # Check for immediate / early start date conflicts
        early_months = '|'.join(timing.months_before_graduation())
        prior_cohort = timing.prior_cohort_pattern()
        prior_label = f"December {P}" if 3 <= timing.graduation.month <= 9 else "An earlier"
        conflict_patterns = [
            (r"\bmust\s*be\s*available\s*to\s*start\s*immediately\b", "Immediate start required"),
            *([(rf"\bstart\s*date\s*:\s*(?:{early_months})\s*{Y}\b", "Explicit start date before graduation"),
               (rf"\bmust\s*begin\s*(?:{early_months})\s*{Y}\b", "Must begin before graduation")] if early_months else []),
            *([(rf"\bstart\s*(?:in\s*)?(?:{terms})\b", f"Start season precedes {timing.avail_label} graduation")] if terms else []),
            (rf"\bdegree\s*completed\s*by\s*(?:december\s*{P}|dec\s*{P})\b", f"Requires degree completion by December {P}"),
            # A graduate intake just before graduation (December 2026 for a June 2027 graduate)
            # wants someone who has already finished; this candidate cannot take that cohort.
            (rf"\b{prior_cohort}\s+new\s+grad(?:uate)?\b", f"{prior_label} graduate intake precedes {timing.grad_label} graduation"),
            (rf"\bnew\s+grad(?:uate)?\b[^.\n]{{0,30}}\b{prior_cohort}\b", f"{prior_label} graduate intake precedes {timing.grad_label} graduation"),
            # A cohort named for the prior year wants people who finish then. Where an employer also
            # runs a line for the graduation year, applying to the earlier one is the wrong intake.
            (rf"\b{P}\s+(?:early\s+career|new\s+grad(?:uate)?|university\s+(?:grad(?:uate)?|hire)|grad(?:uate)?s?)\b", f"{P} cohort precedes {timing.grad_label} graduation"),
            (rf"\b(?:grad(?:uate)?s?|class)\s+of\s+{P}\b", f"{P} cohort precedes {timing.grad_label} graduation"),
        ]

        if not has_start_date_conflict:
            for c_pat, c_desc in conflict_patterns:
                # The title carries this signal more reliably than the body.
                # An accepted graduation-year cohort must not be mistaken for a prior-year-only intake.
                timing_corpus = re.sub(rf"class\s+of\s+{P}\s*(?:or|and|/)\s*{Y}", f"class of {Y}", full_corpus)
                m = re.search(c_pat, timing_corpus) or re.search(c_pat, title_lower)
                if m:
                    has_start_date_conflict = True
                    stated_start_date = m.group(0).strip()
                    reasons.append(
                        f"Start date conflict: Posting explicitly requests '{stated_start_date}', "
                        f"while candidate becomes available {timing.avail_label} ({timing.grad_label} graduation)."
                    )
                    break

        # A cohort year elsewhere in the description must not override a degree deadline.
        graduation = datetime.fromisoformat(self.profile.education.graduation_date).date()
        available = datetime.fromisoformat(cand_dict.get("target_start_date", self.profile.education.graduation_date)).date()
        month_names = "january|february|march|april|may|june|july|august|september|october|november|december"
        deadline_pattern = rf"(?:degree[^.\n]{{0,100}}?(?:completed|completion|expected|earned)[^.\n]{{0,30}}?by|graduat(?:e|ed|ing|ion)[^.\n]{{0,35}}?by|start(?: date)?\s*(?::|in|by))\s+({month_names})\s+(?:(\d{{1,2}}),?\s+)?(20\d{{2}})"
        for match in re.finditer(deadline_pattern, required_text, re.I):
            month = datetime.strptime(match[1], "%B").month
            # Month-only degree deadlines allow any day that month.
            import calendar
            day = int(match[2]) if match[2] else calendar.monthrange(int(match[3]), month)[1]
            deadline = datetime(int(match[3]), month, day).date()
            target = available if match[0].lower().startswith('start') else graduation
            if deadline < target:
                has_start_date_conflict = True
                stated_start_date = match[0]
                reasons.append(f"Start date conflict: '{match[0]}' precedes candidate availability/graduation.")
                break

        if not is_explicit_cohort_match and not has_start_date_conflict:
            reasons.append("Start date not explicitly specified: treated as neutral/compatible for early-career recruiting pipeline.")

        # Degree fields come from degree requirements, not unrelated company prose.
        fields = cand_dict.get("acceptable_degree_fields", [m["name"].lower() for m in self.profile.education.majors])
        has_relevant_degree, unrelated_match, masters_only, phd_only = degree_requirements(required_text, fields)
        if has_relevant_degree:
            reasons.append("Degree requirement matched: BS in Mechanical Engineering / Stats & Data Science aligns with requested disciplines.")
        if unrelated_match:
            reasons.append("Ineligible degree discipline: required degree fields do not include the candidate's configured disciplines or a related-field alternative.")
        if masters_only:
            reasons.append("Ineligible degree requirement: Position strictly requires a Master's degree without a Bachelor's alternative.")
        if phd_only:
            reasons.append("Ineligible degree requirement: Position strictly requires a PhD without a Bachelor's alternative.")

        exp_min = required_experience_years(required_text)
        experience_limit = cand_dict.get("max_required_experience_years", 3)
        if exp_min is None:
            reasons.append("Required experience not specified: no years of experience inferred.")
        elif exp_min >= experience_limit:
            prefix = "High experience threshold" if exp_min >= 5 else "Ineligible experience requirement"
            reasons.append(f"{prefix}: requires {exp_min}+ years; policy excludes {experience_limit} or more required years.")
        elif exp_min >= 2 and exp_min > documented_experience_years(self.profile):
            reasons.append(f"Required experience ({exp_min}+ years) exceeds the relevant duration established by the dated candidate profile.")
        else:
            reasons.append("Early-career experience requirement (0-1 years).")

        # If preferred text mentions higher years or advanced degrees, note as non-disqualifying
        if preferred_text:
            p_low = preferred_text.lower()
            if re.search(r"\b(?:master|ph\.?d|years?)\b", p_low):
                reasons.append("Preferred qualifications noted: non-disqualifying preferred criteria reserved for fit/priority evaluation.")

        # 4. Salary Threshold Analysis
        has_salary_conflict = False
        target_salary = cand_dict.get("salary_threshold_annual", 90000) or 90000
        if salary_min is not None and isinstance(salary_min, (int, float)) and salary_min > 0:
            if salary_min < target_salary:
                has_salary_conflict = True
                reasons.append(f"Salary below policy threshold: Confirmed base salary ${salary_min:,.0f} is below candidate's ${target_salary:,.0f}/year minimum.")

        # 5. Citizenship & Work Authorization
        # Candidate is US Citizen, requires no sponsorship
        if "u.s. citizenship required" in full_corpus or "us citizen required" in full_corpus or "itar" in full_corpus:
            reasons.append("ITAR / Citizenship requirement satisfied: Candidate is a U.S. citizen.")

        # The title says what the job is; an electrical or software role does not fit his majors
        # however early-career it is.
        other_discipline = off_discipline_title(title, description, self.track)
        if other_discipline:
            reasons.append(f"Discipline mismatch: '{title}' is a {other_discipline} role, outside the {self.track.label} search.")

        # 6. Determine Overall Classification
        if is_outside_us or other_discipline:
            return (EligibilityStatus.INELIGIBLE, reasons, stated_start_date, has_start_date_conflict)

        if phd_only or masters_only:
            return (EligibilityStatus.INELIGIBLE, reasons, stated_start_date, has_start_date_conflict)

        if unrelated_match:
            return (EligibilityStatus.INELIGIBLE, reasons, stated_start_date, has_start_date_conflict)

        # An internship is filtered out of the full-time queue by role_type rather than
        # ruled out here, so these stay viewable on their own tab instead of being
        # buried among the roles the candidate genuinely cannot hold.

        # Policy: three or more REQUIRED years is out of reach for a graduating senior.
        if exp_min is not None and exp_min >= experience_limit:
            return (EligibilityStatus.LIKELY_INELIGIBLE, reasons, stated_start_date, has_start_date_conflict)

        if is_senior:
            return (EligibilityStatus.LIKELY_INELIGIBLE, reasons, stated_start_date, has_start_date_conflict)

        if has_start_date_conflict:
            return (EligibilityStatus.INELIGIBLE, reasons, stated_start_date, has_start_date_conflict)

        # Explicit new-grad wording cannot override a required experience gap.
        if exp_min is not None and exp_min >= 2 and exp_min > documented_experience_years(self.profile):
            reasons.append(f"Not selected: {exp_min}+ required years are not established by documented relevant experience. Undated projects and future employment are not counted as verified years.")
            return (EligibilityStatus.LIKELY_INELIGIBLE, reasons, stated_start_date, has_start_date_conflict)

        if not description.strip() or "Source: Early-Career & New Grad Network" in description or "Employer requirements not fetched." in description:
            # A degree tag can rule out an advanced-degree-only posting, but cannot
            # establish eligibility without the actual employer requirements.
            stub_degree = re.search(r"Target Degree Level:\s*([^\n]+)", description, re.I)
            if stub_degree:
                levels = stub_degree.group(1).strip()
                if not re.search(r"bachelor|b\.?s\.?|undergrad", levels, re.I):
                    reasons.append(f"Target degree level is {levels}, with no bachelor's option.")
                    return (EligibilityStatus.INELIGIBLE, reasons, stated_start_date, has_start_date_conflict)
                reasons.append(f"Target degree level is {levels}, but employer duties and requirements are not yet verified.")
            reasons.append("Insufficient source detail: employer requirements must be verified before applying.")
            return (EligibilityStatus.UNCERTAIN, reasons, stated_start_date, has_start_date_conflict)

        specialist_gaps = unsupported_specialist_requirements(required_text, self.profile)
        if specialist_gaps:
            reasons.extend(specialist_gaps)
            return (EligibilityStatus.LIKELY_INELIGIBLE, reasons, stated_start_date, has_start_date_conflict)

        if is_explicit_cohort_match or is_early_career(title):
            return (EligibilityStatus.STRONG_MATCH, reasons, stated_start_date, has_start_date_conflict)

        if has_relevant_degree:
            return (EligibilityStatus.ELIGIBLE, reasons, stated_start_date, has_start_date_conflict)

        return (EligibilityStatus.LIKELY_ELIGIBLE, reasons, stated_start_date, has_start_date_conflict)
