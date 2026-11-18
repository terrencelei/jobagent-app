"""Durable source configuration shared by discovery, the dashboard and source agents."""
from ..filelock import lock_exclusive
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlparse

import yaml

from ..config import get_settings, load_search_config
from ..db.models import Company, SourceRecord
from ..scrapers.workday import WorkdayScraper

# Discovery channels that span many employers: not companies, so never watched or researched as boards.
CHANNELS = ('github', 'indeed', 'linkedin', 'handshake')


def source_target(name, ats, token=None, url=None):
    target = {'name': name, 'ats_type': ats, 'career_url': url, 'board_token': token, 'company_slug': token}
    parsed = urlparse(url or '')
    parts = [p for p in parsed.path.split('/') if p]
    if ats in ('greenhouse', 'lever', 'ashby'):
        if parts and parsed.hostname in ('jobs.lever.co', 'jobs.ashbyhq.com', 'boards.greenhouse.io', 'job-boards.greenhouse.io'):
            token = parts[0]
        target['board_token'] = target['company_slug'] = token
        hosts = {'greenhouse':'https://job-boards.greenhouse.io/', 'lever':'https://jobs.lever.co/', 'ashby':'https://jobs.ashbyhq.com/'}
        target['career_url'] = hosts[ats] + token if token else url
    elif ats == 'breezy':
        if parsed.hostname and parsed.hostname.endswith('.breezy.hr'):
            token = parsed.hostname.split('.')[0]
        target['board_token'] = target['company_slug'] = token
        target['career_url'] = f'https://{token}.breezy.hr' if token else url
    elif ats == 'workday' and url:
        try:
            origin, site, _ = WorkdayScraper.board(url)
            target['career_url'] = f'{origin}/{site}'
        except ValueError:
            pass
    elif ats == 'oracle' and '/sites/' in parsed.path:
        prefix, _, remainder = parsed.path.partition('/sites/')
        site = remainder.split('/')[0]
        target['career_url'] = f'{parsed.scheme}://{parsed.netloc}{prefix}/sites/{site}/jobs'
    return target


def source_key(ats, target):
    locator = target.get('career_url') or target.get('board_token') or target.get('name')
    if ats == 'github':
        locator = [target['repository'], target.get('ref','main'), target.get('path','README.md')]
    return hashlib.sha256(json.dumps([ats, locator], sort_keys=True).encode()).hexdigest()


def read_overrides():
    path = get_settings().config_dir / 'source_overrides.yaml'
    return yaml.safe_load(path.read_text()) if path.exists() else {'added': [], 'disabled': []}


def update_overrides(*, added=None, disabled=(), enabled=()):
    """Atomic configuration edit; the agent changes data, never executes website instructions."""
    root = get_settings().config_dir
    root.mkdir(parents=True, exist_ok=True)
    with (root / '.sources.lock').open('a') as lock:
        lock_exclusive(lock)
        data = read_overrides() or {}
        entries = {e['key']:e for e in data.get('added', [])}
        if added:
            entries[added['key']] = added
        blocked = (set(data.get('disabled', [])) | set(disabled)) - set(enabled)
        content = yaml.safe_dump({'added':list(entries.values()), 'disabled':sorted(blocked)}, sort_keys=False)
        path = root / 'source_overrides.yaml'
        temporary = path.with_suffix('.tmp')
        temporary.write_text(content)
        os.replace(temporary, path)


def seed_sources(session, config=None):
    config = config or load_search_config(get_settings().config_dir)
    overrides = read_overrides() or {}
    candidates = []
    for group, entries in config.target_companies.items():
        for entry in entries:
            ats = entry.get('ats_type') or group
            target = source_target(entry['name'], ats, entry.get('board_token') or entry.get('company_slug'), entry.get('career_url'))
            candidates.append((ats, target, 'config'))
    for company in session.query(Company).filter(Company.is_active.is_(True)).all():
        candidates.append((company.ats_type or 'direct', source_target(company.name, company.ats_type or 'direct',
                           company.board_token or company.slug, company.career_url), 'catalog'))
    for source in config.github_sources:
        if source.enabled:
            candidates.append(('github', source.model_dump(), 'config'))
    if getattr(getattr(config, 'indeed', None), 'queries', None):
        from .indeed import source_target as indeed_target
        candidates.append(('indeed', indeed_target(), 'config'))
    if getattr(getattr(config, 'linkedin', None), 'queries', None):
        from .linkedin import source_target as linkedin_target
        candidates.append(('linkedin', linkedin_target(), 'config'))
    if getattr(getattr(config, 'handshake', None), 'queries', None):
        from .handshake import source_target as handshake_target
        candidates.append(('handshake', handshake_target(), 'config'))
    for entry in overrides.get('added', []):
        candidates.append((entry['ats_type'], entry['target'], 'dashboard'))
    known = {s.key:s for s in session.query(SourceRecord).all()}
    for ats, target, origin in candidates:
        key = source_key(ats,target)
        if key not in known:
            source = SourceRecord(key=key,company_name=target.get('name') or target.get('repository'),
                                  ats_type=ats,target=target,origin=origin,enabled=key not in overrides.get('disabled',[]))
            session.add(source); known[key]=source
        elif key in overrides.get('disabled',[]):
            known[key].enabled=False
        if origin in ('config', 'dashboard'):
            known[key].target = target
    session.flush()
    return list(known.values())


def serialize_source(source):
    return {'id':source.id, 'company':source.company_name, 'ats':source.ats_type,
            'url':source.target.get('career_url') or ('https://github.com/'+source.target.get('repository','')),
            'enabled':source.enabled, 'health':source.health, 'detail':source.detail,
            'checked_at':source.checked_at.isoformat().replace('+00:00','')+'Z' if source.checked_at else None, 'jobs_found':source.jobs_found}
