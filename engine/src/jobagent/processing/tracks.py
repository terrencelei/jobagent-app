"""Job-search tracks: the mechanical and the statistics/data-science search, judged the same way.

config/tracks.yaml is the hand-written baseline; config/learned_rules.yaml holds the rule tuner's
revisions of the tunable keys and wins over the baseline. The active track (the dashboard toggle)
lives in the data directory.
"""
import json
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import yaml

from ..config import config_path, get_settings

TUNABLE = ('on_titles', 'off_titles', 'degree_override')
# The first track in tracks.yaml is the default one (Setup writes the student's own tracks).
DEFAULT_TRACK = 'mechanical'


@dataclass(frozen=True)
class Track:
    key: str
    label: str
    major: str
    degree_override: Tuple[str, ...]
    on_titles: Tuple[str, ...]
    off_titles: Tuple[Tuple[str, str], ...]  # (label, pattern)
    clusters: Tuple[str, ...]
    target_roles: Tuple[str, ...]
    preferred_title_terms: Tuple[str, ...]
    industries: Tuple[str, ...]
    reviewer_fits: str
    reviewer_other: str
    discovery_titles: str
    _compiled: Dict[str, object] = field(default_factory=dict, compare=False, hash=False, repr=False)

    def _re(self, name, pattern):
        if name not in self._compiled:
            self._compiled[name] = re.compile(pattern, re.I)
        return self._compiled[name]

    def degree_names_major(self, description: str) -> bool:
        """Whether a degree line, required or preferred, names this track's major."""
        if not self.degree_override:
            return False
        fields = self._re('override', '|'.join(self.degree_override))
        degree = self._re('degree', r"\b(?:bachelor|master|b\.?s\.?|m\.?s\.?|bsme|degree|major|graduat)")
        clauses = re.split(r"\n|;|(?<=[.!?])\s+(?=[A-Z])", description or "")
        # A learned exclusion for electrical-only jobs must not reject an explicit
        # Mechanical Engineering degree alternative on a hardware posting.
        mechanical_alternative = r'\b(?:or|/)\s*mechanical\s+engineering\b|\bmechanical\s+engineering\s*(?:or|/)\s*electrical\b'
        return any(degree.search(c) and (fields.search(c) or self.key == 'mechanical' and re.search(mechanical_alternative, c, re.I)) for c in clauses)

    def off_discipline(self, title: str, description: str = "") -> Optional[str]:
        """The other discipline a title belongs to, or None when it can be this track's.

        A title can just reflect the industry, so degree lines naming the track's major win.
        """
        if (self.on_titles and self._re('on', '|'.join(self.on_titles)).search(title)) or self.degree_names_major(description):
            return None
        for n, (label, pattern) in enumerate(self.off_titles):
            if self._re(f'off{n}', pattern).search(title):
                return label
        return None


def _config_dir(config_dir=None):
    return Path(config_dir) if config_dir else get_settings().config_dir


def build_track(key, spec) -> Track:
    return Track(key=key, label=spec['label'], major=spec['major'],
                 degree_override=tuple(spec.get('degree_override') or ()), on_titles=tuple(spec.get('on_titles') or ()),
                 off_titles=tuple((o['label'], o['pattern']) for o in spec.get('off_titles') or ()),
                 clusters=tuple(spec['clusters']), target_roles=tuple(spec.get('target_roles') or ()),
                 preferred_title_terms=tuple(spec.get('preferred_title_terms') or ()), industries=tuple(spec.get('industries') or ()),
                 reviewer_fits=spec.get('reviewer_fits', ''), reviewer_other=spec.get('reviewer_other', ''),
                 discovery_titles=spec.get('discovery_titles', ''))


def track_specs(config_dir=None, learned=True) -> Dict[str, dict]:
    root = _config_dir(config_dir)
    specs = yaml.safe_load(config_path('tracks.yaml', root).read_text())['tracks']
    overlay = root / 'learned_rules.yaml'
    if learned and overlay.exists():
        for key, tuned in ((yaml.safe_load(overlay.read_text()) or {}).get('tracks') or {}).items():
            if key in specs:
                specs[key].update({k: v for k, v in tuned.items() if k in TUNABLE})
    return specs


@lru_cache(maxsize=4)
def _load(config_dir: str, stamp: float) -> Dict[str, Track]:
    return {k: build_track(k, v) for k, v in track_specs(config_dir).items()}


def load_tracks(config_dir=None) -> Dict[str, Track]:
    root = _config_dir(config_dir)
    overlay = root / 'learned_rules.yaml'
    # The overlay's mtime is part of the cache key, so a tuner revision is picked up at once.
    stamp = max(config_path('tracks.yaml', root).stat().st_mtime, overlay.stat().st_mtime if overlay.exists() else 0)
    return _load(str(root), stamp)


def get_track(key=None, config_dir=None) -> Track:
    tracks = load_tracks(config_dir)
    return tracks.get(key or active_track()) or tracks.get(DEFAULT_TRACK) or next(iter(tracks.values()))


def _state_path():
    return get_settings().data_dir / 'active-track.json'


def active_track() -> str:
    try:
        key = json.loads(_state_path().read_text()).get('track')
    except (OSError, ValueError):
        key = None
    tracks = load_tracks()
    return key if key in tracks else (DEFAULT_TRACK if DEFAULT_TRACK in tracks else next(iter(tracks)))


def set_active_track(key: str, config_dir=None):
    if key not in load_tracks(config_dir):
        raise ValueError(f'Unknown track: {key}')
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({'track': key}))


def discovery_title_pattern() -> str:
    """Titles worth fetching for any track; each track judges them separately afterwards."""
    return '|'.join(f'(?:{t.discovery_titles})' for t in load_tracks().values() if t.discovery_titles)


def per_track(value, key):
    """A per-track JSON value; a flat legacy value (from before tracks) belongs to the mechanical track."""
    if not value:
        return None
    if isinstance(value, dict) and 'fit' in value:
        return value if key == DEFAULT_TRACK else None
    return (value or {}).get(key)


def with_track(value, key, item):
    """The per-track JSON value with this track's entry replaced (None removes it)."""
    if isinstance(value, dict) and 'fit' in value:
        value = {DEFAULT_TRACK: value}
    value = dict(value or {})
    if item is None:
        value.pop(key, None)
    else:
        value[key] = item
    return value or None
