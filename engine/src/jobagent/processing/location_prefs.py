"""Where the student wants to work, as entered in Setup, and how a posting's location fits it.

Preferences are free text such as "Seattle, WA", "Texas", "NY" or "Remote", saved in profile.yaml as
candidate.target_locations. A city matches by name, a state by full name or postal code, "Remote" by a
remote posting. With no preferences every U.S. location fits equally.
"""
import re
from typing import Iterable, Optional, Tuple

from .us_locations import STATE_CODES, STATE_NAMES

_CODES = set(STATE_CODES.split('|'))
_NAME_TO_CODE = dict(zip([n.lower() for n in STATE_NAMES.split('|')],
                         'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY '
                         'NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split()))
_CODE_TO_NAME = {c: n for n, c in _NAME_TO_CODE.items()}
_REMOTE = re.compile(r'\bremote\b|\banywhere\b|work from home', re.I)


def _state_of(text: str) -> Optional[str]:
    t = text.strip()
    if t.upper() in _CODES:
        return t.upper()
    return _NAME_TO_CODE.get(t.lower())


def _mentions_state(loc: str, code: str) -> bool:
    return bool(re.search(rf'(?<![A-Za-z]){code}(?![A-Za-z])', loc)
                or re.search(rf'\b{re.escape(_CODE_TO_NAME[code])}\b', loc, re.I))


def location_matches(location: str, preference: str) -> bool:
    loc = (location or '').strip()
    pref = (preference or '').strip()
    if not loc or not pref:
        return False
    if _REMOTE.search(pref):
        return bool(_REMOTE.search(loc))
    parts = [p.strip() for p in pref.split(',') if p.strip()]
    state = _state_of(parts[-1]) if parts else None
    if len(parts) == 1 and state:
        return _mentions_state(loc, state)
    if not re.search(rf'\b{re.escape(parts[0])}\b', loc, re.I):
        return False
    if state and len(parts) > 1:
        # "Portland, OR" must not match "Portland, ME"; a posting that names no state is accepted.
        named = [c for c in _CODES if _mentions_state(loc, c)]
        if named and state not in named:
            return False
    return True


def location_fit(location: str, preferences: Iterable[str], remote_ok: bool = True) -> Tuple[float, bool]:
    """(score out of 5, matched) for the ranking's location-preference component."""
    prefs = [p for p in (preferences or []) if str(p).strip()]
    loc = location or ''
    if not prefs:
        return (4.5 if _REMOTE.search(loc) and remote_ok else 3.5), True
    if any(location_matches(loc, p) for p in prefs):
        return 5.0, True
    if remote_ok and _REMOTE.search(loc):
        return 4.5, True
    return 1.0, False
