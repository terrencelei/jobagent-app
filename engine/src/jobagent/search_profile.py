"""Turns what a student enters in Setup into the search configuration the engine runs on.

Any major, any roles, any industries, any places: Setup collects them and this module writes
- tracks.yaml: one search track for the student's roles (titles to fetch, degree fields, reviewer brief);
- ranking.yaml: the shipped weights plus one career cluster per target role and a boost for dream companies;
- search.yaml: job-board queries for each role, the student's locations, and the employer career sites
  of every company pack whose industries the student picked.
Nothing here is specific to one field; the shipped company packs are only a head start for some industries.
"""
import copy
import re
from typing import Dict, Iterable, List

import yaml

from .config import SHIPPED_DEFAULTS

# Industries offered in Setup, with words that show up in postings from that industry (used for scoring).
INDUSTRIES: Dict[str, List[str]] = {
    'Technology & software': ['software', 'saas', 'cloud', 'platform', 'technology', 'internet', 'app'],
    'Hardware & robotics': ['hardware', 'robotics', 'robot', 'devices', 'electronics', 'automation'],
    'Aerospace & defense': ['aerospace', 'aircraft', 'space', 'satellite', 'defense', 'launch'],
    'Automotive & EV': ['automotive', 'vehicle', 'ev', 'electric vehicle', 'mobility', 'autonomous'],
    'Semiconductors': ['semiconductor', 'chip', 'silicon', 'wafer', 'fab'],
    'Manufacturing': ['manufacturing', 'production', 'factory', 'industrial', 'supply chain'],
    'Energy & climate': ['energy', 'climate', 'solar', 'battery', 'grid', 'renewable', 'sustainability'],
    'Healthcare & biotech': ['healthcare', 'health', 'biotech', 'pharmaceutical', 'clinical', 'hospital', 'life sciences'],
    'Medical devices': ['medical device', 'medtech', 'fda', 'surgical', 'diagnostics'],
    'Finance & banking': ['finance', 'financial', 'bank', 'investment', 'trading', 'fintech', 'asset management'],
    'Consulting': ['consulting', 'consultant', 'advisory', 'clients', 'strategy'],
    'Consumer goods & retail': ['consumer', 'retail', 'brand', 'e-commerce', 'cpg', 'merchandising'],
    'Media & entertainment': ['media', 'entertainment', 'content', 'gaming', 'film', 'music', 'publishing'],
    'Marketing & advertising': ['marketing', 'advertising', 'brand', 'campaign', 'agency'],
    'Government & public sector': ['government', 'public sector', 'federal', 'state', 'policy', 'agency'],
    'Education & nonprofit': ['education', 'nonprofit', 'school', 'university', 'mission-driven'],
    'Construction & real estate': ['construction', 'real estate', 'building', 'infrastructure', 'architecture'],
    'Transportation & logistics': ['logistics', 'transportation', 'shipping', 'freight', 'supply chain'],
    'Telecommunications': ['telecommunications', 'wireless', 'network', '5g', 'telecom'],
    'Food & agriculture': ['food', 'agriculture', 'agtech', 'beverage', 'farm'],
    'Hospitality & travel': ['hospitality', 'travel', 'hotel', 'restaurant', 'tourism'],
    'Law': ['legal', 'law firm', 'litigation', 'compliance'],
}

_GENERIC_WORDS = {'senior', 'junior', 'associate', 'entry', 'level', 'new', 'grad', 'graduate', 'intern', 'internship',
                  'the', 'and', 'of', 'for', 'i', 'ii', 'iii', 'role', 'position', 'specialist', 'manager', 'engineer',
                  'analyst', 'coordinator', 'assistant', 'representative', 'developer', 'consultant', 'scientist',
                  'designer', 'technician', 'officer', 'lead', 'program', 'programs'}


def _phrase_pattern(phrase: str) -> str:
    return r'\s+'.join(re.escape(w) for w in phrase.lower().split())


def _words(phrases: Iterable[str]) -> List[str]:
    out = []
    for p in phrases:
        for w in re.findall(r"[a-z][a-z&+.'-]*", p.lower()):
            if len(w) > 2 and w not in _GENERIC_WORDS and w not in out:
                out.append(w)
    return out


def _clean(items: Iterable[str]) -> List[str]:
    seen, out = set(), []
    for i in items or []:
        v = str(i).strip()
        if v and v.lower() not in seen:
            seen.add(v.lower())
            out.append(v)
    return out


def _slug(text: str) -> str:
    return re.sub(r'[^a-z0-9]+', '_', text.lower()).strip('_') or 'role'


def industry_keywords(industries: Iterable[str]) -> List[str]:
    words = []
    for name in industries:
        for w in INDUSTRIES.get(name) or [name.lower()]:
            if w not in words:
                words.append(w)
    return words


def build_tracks(roles, majors, industries) -> dict:
    roles, majors = _clean(roles), _clean(majors)
    major = majors[0] if majors else ''
    title_patterns = [_phrase_pattern(r) for r in roles]
    qualifiers = _words(roles)
    label = ' & '.join(roles[:2]) + (' +' if len(roles) > 2 else '') if roles else 'All roles'
    spec = {
        'label': label,
        'major': major,
        'degree_override': [re.escape(w) for w in _words(majors)],
        'on_titles': title_patterns,
        'off_titles': [],
        'clusters': [r.upper() for r in roles] or ['GENERAL'],
        'target_roles': [r.lower() for r in roles] + qualifiers,
        'preferred_title_terms': [r.lower() for r in roles],
        'industries': industry_keywords(industries),
        'reviewer_fits': ', '.join(roles) + (f' roles (the student studies {", ".join(majors)})' if majors else ' roles'),
        'reviewer_other': 'roles in other functions or disciplines than ' + (', '.join(roles) or 'the ones chosen'),
        'discovery_titles': '|'.join(title_patterns + [re.escape(w) for w in qualifiers]),
    }
    return {'tracks': {'primary': spec}}


def build_ranking(roles, skills, industries, dream_companies) -> dict:
    ranking = yaml.safe_load((SHIPPED_DEFAULTS / 'ranking.yaml').read_text())
    skill_words = [s.lower() for s in _clean(skills)]
    ind = industry_keywords(industries)
    ranking['career_clusters'] = [
        {'id': _slug(r).upper(), 'name': r.upper(),
         'keywords': _clean([r.lower(), *_words([r]), *skill_words[:25], *ind[:10]])}
        for r in _clean(roles)] or [{'id': 'GENERAL', 'name': 'GENERAL', 'keywords': []}]
    dream = [c.lower() for c in _clean(dream_companies)]
    ranking['company_preference'] = {'default_points': 3.0, 'sectors': (
        {'dream_companies': {'points': 5.0, 'priority_boost': 10.0, 'companies': dream}} if dream else {})}
    return ranking


def company_packs() -> dict:
    data = yaml.safe_load((SHIPPED_DEFAULTS / 'company_packs.yaml').read_text()) or {}
    return data.get('packs') or {}


def packs_for(industries) -> List[str]:
    chosen = set(industries or [])
    return [key for key, pack in company_packs().items() if chosen & set(pack.get('industries') or [])]


def build_search(roles, locations, industries, role_type: str, handshake_school: str = '',
                 remote_ok: bool = True, relocation: bool = True) -> dict:
    search = yaml.safe_load((SHIPPED_DEFAULTS / 'search.yaml').read_text())
    roles = _clean(roles)
    early = '("new grad" OR "new graduate" OR "entry level" OR "early career" OR junior OR associate)'
    indeed, linkedin = [], []
    for r in roles:
        if role_type in ('full-time', 'both'):
            indeed.append(f'"{r}" {early} -senior -principal -staff -lead')
            linkedin.append(f'"{r}" "entry level" OR "new grad"')
        if role_type in ('internships', 'both'):
            indeed.append(f'"{r}" (intern OR internship OR co-op)')
            linkedin.append(f'"{r}" internship')
    search['query_templates']['role_titles'] = roles
    search['indeed']['queries'] = indeed
    search['linkedin']['queries'] = linkedin
    search['handshake'] = {'school': (handshake_school or '').strip().lower(), 'queries': roles}
    places = _clean(locations)
    first_place = next((p for p in places if not re.search(r'\bremote\b', p, re.I)), '')
    search['indeed']['location'] = search['linkedin']['location'] = first_place or 'United States'
    search['locations'].update(preferred_locations=places, remote_allowed=bool(remote_ok), relocation_allowed=bool(relocation))
    if role_type in ('internships', 'both'):
        from datetime import date
        today = date.today()
        season = today.year + 1 if today.month >= 8 else today.year  # internship cycles open the autumn before
        search['github_sources'].append({'repository': f'SimplifyJobs/Summer{season}-Internships', 'ref': 'dev',
                                         'path': '.github/scripts/listings.json', 'format': 'simplify_json', 'max_jobs': 1000})
    merged: Dict[str, list] = {}
    packs = company_packs()
    for key in packs_for(industries):
        for ats, companies in (packs[key].get('target_companies') or {}).items():
            have = {c.get('name') for c in merged.setdefault(ats, [])}
            merged[ats].extend(copy.deepcopy(c) for c in companies or [] if c.get('name') not in have)
    search['target_companies'] = merged
    return search


def dump(data: dict, header: str) -> str:
    return f'# {header}\n' + yaml.safe_dump(data, sort_keys=False, allow_unicode=True, width=110)
