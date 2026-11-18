"""Export the same dashboard and queue definitions used by the live API."""

import hashlib
import json
import os
import tempfile
from pathlib import Path
from sqlalchemy import case

from ..agents.application_agent import ApplicationAgent
from ..config import get_settings
from ..db.models import Job, utc_now
from .dashboard import dashboard_counts, job_payload, tab_filters, source_counts


def _atomic_write(path, content):
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=path.name + '.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def dashboard_template():
    root = Path(__file__).parent
    template = (root / 'templates' / 'index.html').read_text(encoding='utf-8')
    for asset in ('feedback.js', 'dashboard.js', 'applications.js', 'applications.css'):
        version = hashlib.sha256((root / asset).read_bytes()).hexdigest()[:12]
        template = template.replace(f'"{asset}"', f'"{asset}?v={version}"')
    return template


def export_static_dashboard(session, output_dir=None):
    out_dir = output_dir or get_settings().root_dir / 'docs'
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    session.flush()
    now = utc_now()
    filters = tab_filters(now)
    agent = ApplicationAgent(session)
    jobs = []
    for row in session.query(Job, *(case((f, True), else_=False).label(tab) for tab, f in filters.items())).order_by(Job.priority_score.desc(), Job.id.desc()):
        job = row[0]
        payload = job_payload(job, now, detail=True)
        payload['tabs'] = [tab for tab, included in zip(filters, row[1:]) if included]
        payload['cover_letter_draft'] = agent.generate_cover_letter(job)
        jobs.append(payload)
    snapshot = {'stats': {'counts': dashboard_counts(session, now), 'source_counts': source_counts(session, now), 'last_updated': now.isoformat(), 'total_opportunities': len(jobs)}, 'jobs': jobs}
    _atomic_write(out_dir / 'data.js', 'window.JOBAGENT_STATIC_DATA = ' + json.dumps(snapshot, ensure_ascii=True) + ';\n')
    template = dashboard_template()
    for asset in ('feedback.js', 'dashboard.js', 'applications.js', 'applications.css'):
        _atomic_write(out_dir / asset, (Path(__file__).parent / asset).read_text())
    _atomic_write(out_dir / 'index.html', template.replace('<!-- STATIC_DATA -->', '<script src="data.js"></script>'))
    return out_dir
