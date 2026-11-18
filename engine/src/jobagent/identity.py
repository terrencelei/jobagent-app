"""Who the candidate is and when they become available, read from config/profile.yaml.

Everything that used to name the owner directly (file names, messages, graduation-year rules)
asks this module instead, so a new user who runs Setup gets rules and wording for their own
profile. For the owner's profile the results are identical to the old fixed values.
"""
import calendar
import re
from dataclasses import dataclass
from datetime import date, datetime
from functools import lru_cache
from pathlib import Path
from typing import Optional, Tuple

import yaml

from .config import config_path

MONTHS = [m.lower() for m in calendar.month_name[1:]]


def _season(month: int) -> str:
    return {12: 'winter', 1: 'winter', 2: 'winter', 3: 'spring', 4: 'spring', 5: 'spring',
            6: 'summer', 7: 'summer', 8: 'summer'}.get(month, 'fall')


def _profile_path(config_dir: Optional[Path] = None) -> Path:
    return config_path('profile.yaml', config_dir)


@lru_cache(maxsize=8)
def _read(path: str, stamp: float) -> dict:
    try:
        return yaml.safe_load(Path(path).read_text(encoding='utf-8')) or {}
    except (OSError, yaml.YAMLError):
        return {}


def profile_data(config_dir: Optional[Path] = None) -> dict:
    path = _profile_path(config_dir)
    try:
        stamp = path.stat().st_mtime
    except OSError:
        return {}
    return _read(str(path), stamp)


def candidate_name(config_dir: Optional[Path] = None) -> str:
    return str((profile_data(config_dir).get('candidate') or {}).get('name') or '').strip() or 'Candidate'


def first_name(config_dir: Optional[Path] = None) -> str:
    return candidate_name(config_dir).split()[0]


def file_stem(config_dir: Optional[Path] = None) -> str:
    """The name part of document file names: "Alex Rivera" -> "Alex_Rivera"."""
    return re.sub(r'[^A-Za-z0-9]+', '_', candidate_name(config_dir)).strip('_') or 'Candidate'


def resume_filename(config_dir: Optional[Path] = None) -> str:
    return f'{file_stem(config_dir)}_Resume.pdf'


def cover_letter_filename(config_dir: Optional[Path] = None) -> str:
    return f'{file_stem(config_dir)}_Cover_Letter.pdf'


def school_short_name(institution: str) -> str:
    """"University of Texas at Austin (UT Austin)" -> "UT Austin"; otherwise the name itself."""
    m = re.search(r'\(([^)]+)\)\s*$', institution or '')
    return m.group(1) if m else (institution or 'school').strip()


@dataclass(frozen=True)
class GradTiming:
    """Graduation and availability, plus the words postings use for terms around them."""
    graduation: date
    available: date
    school: str

    @property
    def year(self) -> int:
        return self.graduation.year

    @property
    def prior_year(self) -> int:
        return self.graduation.year - 1

    @property
    def grad_month(self) -> str:
        return MONTHS[self.graduation.month - 1]

    @property
    def avail_season(self) -> str:
        return _season(self.available.month)

    @property
    def grad_label(self) -> str:
        """"June 2027"."""
        return f'{self.grad_month.title()} {self.year}'

    @property
    def avail_label(self) -> str:
        """"Summer 2027"."""
        return f'{self.avail_season.title()} {self.available.year}'

    @property
    def avail_day_label(self) -> str:
        """"June 16, 2027"."""
        return f'{calendar.month_name[self.available.month]} {self.available.day}, {self.available.year}'

    def school_terms(self) -> Tuple[str, ...]:
        """Academic terms in the nine months before graduation, e.g. fall 2026 .. spring 2027.

        December is written as winter of its own year ("winter 2026"), as postings do."""
        terms = []
        y, m = self.graduation.year, self.graduation.month
        for back in range(9, 0, -1):
            mm, yy = m - back, y
            while mm <= 0:
                mm += 12
                yy -= 1
            term = f'{_season(mm)} {yy}'
            if term not in terms:
                terms.append(term)
        return tuple(terms)

    def school_terms_pattern(self) -> str:
        return '|'.join(t.replace(' ', r'\s*') for t in self.school_terms())

    def months_before_graduation(self) -> Tuple[str, ...]:
        """Months of the graduation year before the graduation month (january..may for June)."""
        return tuple(MONTHS[: self.graduation.month - 1])

    def prior_cohort_pattern(self) -> str:
        """Graduate intakes that finish just before this graduation."""
        if 3 <= self.graduation.month <= 9:
            return rf'(?:december|fall)\s*{self.prior_year}'
        return rf'(?:may|june|spring|summer)\s*{self.year if self.graduation.month > 9 else self.prior_year}'


def _iso(value, fallback: date) -> date:
    try:
        return datetime.fromisoformat(str(value)).date()
    except (TypeError, ValueError):
        return fallback


def grad_timing(profile=None) -> GradTiming:
    """Timing from a loaded CandidateProfileConfig, or from profile.yaml when none is given."""
    if profile is not None:
        cand = profile.candidate if isinstance(profile.candidate, dict) else profile.candidate.__dict__
        education = profile.education
        grad_raw, institution = education.graduation_date, education.institution
    else:
        data = profile_data()
        cand = data.get('candidate') or {}
        education = data.get('education') or {}
        grad_raw, institution = education.get('graduation_date'), education.get('institution', '')
    today = date.today()
    graduation = _iso(grad_raw, date(today.year, 6, 15))
    available = _iso(cand.get('target_start_date'), graduation)
    return GradTiming(graduation=graduation, available=available, school=school_short_name(institution))


def primary_major(config_dir: Optional[Path] = None) -> str:
    majors = (profile_data(config_dir).get('education') or {}).get('majors') or []
    names = [m.get('name') for m in majors if isinstance(m, dict) and m.get('name')]
    return names[0] if names else 'engineering'


def personalize(text: str) -> str:
    """Model prompts name the user and their major through {name} and {major}; this fills them in from the profile."""
    return (text.replace('{major}', primary_major().lower())
                .replace('{name}', first_name()))
