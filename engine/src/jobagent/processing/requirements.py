"""Tell what a posting requires apart from what it merely prefers.

A qualification listed under "Preferred" or "Nice to have" is not a barrier: it should
colour how well a job matches, never whether the candidate can apply. Postings rarely fill
the dedicated requirements fields, so the split has to come out of the description text.
"""

import re
from typing import List, Optional, Tuple

# Headings that open a preferred/bonus section. Everything from the first one onward is
# treated as optional, which is how these documents are laid out in practice.
_PREFERRED_HEADING = re.compile(
    r"(?:^|\n)\s*(?:[#*\-•]\s*)?(?:"
    r"preferred\s+(?:qualifications|skills|experience|requirements)|"
    r"nice[\s-]to[\s-]have|bonus\s+(?:points|qualifications|skills)|"
    r"desired\s+(?:qualifications|skills)|what\s+(?:would\s+)?set[s]?\s+you\s+apart|"
    r"you\s+might\s+also\s+have|additionally,?\s+it\s+would\s+be\s+great"
    r")\b[:\s]*",
    re.I,
)

# Wording that marks a single line as optional even outside a preferred section.
_INLINE_OPTIONAL = re.compile(
    r"\b(?:preferred|a\s+plus|bonus|nice\s+to\s+have|ideally|desirable|"
    r"not\s+required|would\s+be\s+great|we'?d\s+love)\b",
    re.I,
)

_YEARS = re.compile(
    r"(\d{1,2})\s*(?:\+|or\s+more|plus)?\s*(?:-|–|to)?\s*(\d{1,2})?\s*\+?\s*years?"
    r"(?:\s+of)?(?:\s+\w+){0,4}?\s*experience",
    re.I,
)

_GRAD_ONLY = re.compile(
    r"\b(?:ph\.?\s?d|doctorate|doctoral|master'?s?|m\.?s\.?c?|m\.?eng)\b[^.\n]{0,80}?"
    r"\b(?:is\s+)?(?:required|requirement|must\s+have|minimum)\b"
    r"|\b(?:required|minimum)\b[^.\n]{0,60}?\b(?:ph\.?\s?d|doctorate|master'?s?|m\.?s\.?c?|m\.?eng)\b",
    re.I,
)
_BACHELOR_OK = re.compile(r"\b(?:bachelor'?s?|b\.?s\.?c?|b\.?eng|b\.?a\.?|undergraduate\s+degree)\b", re.I)
_DEGREE_FIELD = re.compile(
    r"\b(?:bachelor'?s?|b\.?s\.?c?|b\.?eng|master'?s?|m\.?s\.?|ph\.?\s?d|degree)\b"
    r"[^.\n]{0,60}?\bin\s+([^.\n;]{3,90})",
    re.I,
)


def split_required_preferred(text: str) -> Tuple[str, str]:
    """Return (required_text, preferred_text). Everything is required when nothing says otherwise."""
    if not text:
        return "", ""
    m = _PREFERRED_HEADING.search(text)
    if not m:
        return text, ""
    return text[: m.start()], text[m.start():]


def _lines_that_are_required(required_text: str) -> List[str]:
    return [ln for ln in re.split(r"[\n.;]", required_text) if ln.strip() and not _INLINE_OPTIONAL.search(ln)]


def required_experience_years(text: str) -> Optional[int]:
    """The largest number of years the posting actually requires, ignoring preferred ones."""
    required_text, _ = split_required_preferred(text)
    best = None
    for line in _lines_that_are_required(required_text):
        for m in _YEARS.finditer(line):
            low = int(m.group(1))
            if best is None or low > best:
                best = low
    return best


def requires_graduate_degree(text: str) -> bool:
    """True when a master's or doctorate is required and no bachelor's alternative is offered."""
    required_text, _ = split_required_preferred(text)
    for line in _lines_that_are_required(required_text):
        if _GRAD_ONLY.search(line) and not _BACHELOR_OK.search(line):
            return True
    return False


def required_degree_fields(text: str) -> List[str]:
    """Degree fields the posting names as required, lowercased."""
    required_text, _ = split_required_preferred(text)
    out: List[str] = []
    for line in _lines_that_are_required(required_text):
        for m in _DEGREE_FIELD.finditer(line):
            out.append(m.group(1).strip().lower())
    return out


def degree_field_matches(text: str, acceptable: List[str]) -> Optional[bool]:
    """True/False when the posting names required fields, None when it names none."""
    fields = required_degree_fields(text)
    if not fields:
        return None
    joined = " ; ".join(fields)
    return any(a.lower() in joined for a in acceptable)


def is_internship(title: str, text: str = "") -> bool:
    return bool(re.search(r"\b(intern|internship|co-?op)\b", f"{title}", re.I))
