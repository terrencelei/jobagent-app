"""Keeps data/ small.

Every re-scan that changes a posting stored a full copy in job_snapshots (333,000 rows, 2.5 GB, up
to 810 per job by 2026-10-24) and nothing read them back; SQLite also never returns freed pages, so
the file had 4.4 GB of free space. Snapshots are now capped per job as they are written, and a
weekly job (scheduler, Sunday 04:00) prunes stragglers and compacts the file when nothing is
scanning or applying.
"""
import logging
import os
from pathlib import Path

from sqlalchemy import text

logger = logging.getLogger(__name__)

PRUNE_SQL = text("""
    DELETE FROM job_snapshots WHERE id IN (
        SELECT id FROM (
            SELECT id, row_number() OVER (PARTITION BY job_id ORDER BY snapshot_date DESC, id DESC) AS rn
            FROM job_snapshots
        ) WHERE rn > :keep)
""")


def snapshots_per_job():
    from ..settings import setting
    return int(setting('maintenance.snapshots_per_job') or 3)


def prune_snapshots(session, keep=None, job_id=None):
    """Delete each job's snapshots beyond its newest `keep`; returns how many rows went."""
    keep = snapshots_per_job() if keep is None else keep
    if job_id is not None:
        ids = [row[0] for row in session.execute(text(
            'SELECT id FROM job_snapshots WHERE job_id = :job_id ORDER BY snapshot_date DESC, id DESC LIMIT -1 OFFSET :keep'),
            {'job_id': job_id, 'keep': keep})]
        if ids:
            session.execute(text(f"DELETE FROM job_snapshots WHERE id IN ({','.join(str(int(i)) for i in ids)})"))
        return len(ids)
    return session.execute(PRUNE_SQL, {'keep': keep}).rowcount


def file_stats(db_path):
    import sqlite3
    with sqlite3.connect(f'file:{db_path}?mode=ro', uri=True) as conn:
        page_size, page_count, free = (conn.execute(f'PRAGMA {p}').fetchone()[0] for p in ('page_size', 'page_count', 'freelist_count'))
    return {'bytes': page_size * page_count, 'free_bytes': page_size * free, 'free_share': free / page_count if page_count else 0.0}


def compact(db_path):
    """VACUUM the SQLite file (and fold the WAL back in). Needs a quiet database: minutes on a large file."""
    import sqlite3
    before = file_stats(db_path)
    conn = sqlite3.connect(db_path, timeout=60, isolation_level=None)
    try:
        conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        conn.execute('VACUUM')
    finally:
        conn.close()
    return {'before': before, 'after': file_stats(db_path)}


def busy():
    """True while a scan or an application worker is using the database."""
    from .scheduler import is_discovery_active
    if is_discovery_active():
        return True
    try:
        from .application_runner import get_runner
        return bool(get_runner().processes)
    except Exception:
        return False


def run_maintenance(db_path=None, min_free_share=0.2):
    """Weekly: prune snapshot history, then compact the file if a fifth or more of it is free space."""
    from ..config import get_settings
    from ..db.repository import get_db_session
    db_path = db_path or Path(get_settings().db_url.replace('sqlite:///', ''))
    if busy():
        logger.info('Maintenance skipped: a scan or application worker is running')
        return {'skipped': 'busy'}
    with get_db_session() as session:
        pruned = prune_snapshots(session)
        session.commit()
    result = {'pruned_snapshots': pruned, 'compacted': False, **file_stats(db_path)}
    if result['free_share'] >= min_free_share:
        result.update(compact(db_path), compacted=True)
    logger.info('Maintenance: %s', result)
    return result
