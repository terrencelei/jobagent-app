"""Match application receipt emails to jobs, so the queue reflects everything applied to.

Applications get submitted from many places - the runner, a careers site by hand, Handshake,
LinkedIn - and a job the candidate already applied to should never resurface as open work.
The employer's own acknowledgement is the one record that covers all of those routes.

This module never reads a mailbox. The caller supplies already-fetched receipts, so no mail
credential reaches this process.
"""

from dataclasses import dataclass
from difflib import SequenceMatcher
import re
from typing import Any, Dict, List, Optional

from ..db.models import Job, JobStatus

_NOISE = re.compile(
    r"\b(?:inc|llc|ltd|corp|corporation|company|co|technologies|technology|industries|"
    r"labs|systems|space|the|and)\b", re.I)
_NON_WORD = re.compile(r"[^a-z0-9 ]+")


def _norm(text: str) -> str:
    text = _NON_WORD.sub(" ", (text or "").lower())
    return " ".join(_NOISE.sub(" ", text).split())


def _similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


# Tokens that distinguish two otherwise near-identical postings. Plain string similarity is
# blind to them: "Mechanical Test Engineer I" and "... II" score 0.99, as do the 2026 and
# 2027 editions of one early-career req, and Mechanical against Electrical. Treating those
# as the same job would mark something applied that never was, and hide it from the queue.
_LEVELS = {"i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5}
_DISCIPLINES = {
    "mechanical", "electrical", "software", "firmware", "thermal", "structural", "structures",
    "manufacturing", "avionics", "propulsion", "civil", "chemical", "industrial", "systems",
    "quality", "materials", "optical", "controls", "robotics", "hardware", "aerodynamics",
}


def _years(text: str) -> set:
    return set(re.findall(r"\b(20\d{2})\b", text or ""))


def _level(text: str) -> Optional[int]:
    m = re.search(r"\b(i{1,3}|iv|v|[1-5])\b\s*$", (text or "").strip().lower())
    return _LEVELS.get(m.group(1)) if m else None


def _disciplines(text: str) -> set:
    words = set(re.findall(r"[a-z]+", (text or "").lower()))
    return words & _DISCIPLINES


def _conflicts(a: str, b: str) -> bool:
    """True when two titles disagree on something that makes them different postings."""
    ya, yb = _years(a), _years(b)
    if ya and yb and not (ya & yb):
        return True
    la, lb = _level(a), _level(b)
    if la is not None and lb is not None and la != lb:
        return True
    da, db = _disciplines(a), _disciplines(b)
    if da and db and not (da & db):
        return True
    return False


@dataclass
class Receipt:
    """One employer acknowledgement, as fetched from the candidate's mailbox."""
    company: str
    title: Optional[str] = None
    received_at: Optional[str] = None
    message_id: Optional[str] = None
    sender: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Receipt":
        return cls(company=d.get("company") or "", title=d.get("title"),
                   received_at=d.get("receivedAt") or d.get("received_at"),
                   message_id=d.get("messageId") or d.get("message_id"),
                   sender=d.get("sender"))


def match_receipt(receipt: Receipt, jobs: List[Job], title_floor: float = 0.70):
    """Best job for this receipt, or None.

    Deliberately conservative: marking the wrong job applied would hide a job the candidate
    still needs to apply to, which is worse than leaving a real one for a human to confirm.
    Two plausible candidates too close to separate are reported rather than guessed between.
    """
    r_company, r_title = _norm(receipt.company), _norm(receipt.title or "")
    scored = []
    for job in jobs:
        j_company = _norm(job.company_name or "")
        if not j_company or not r_company:
            continue
        company_score = _similar(r_company, j_company)
        if r_company in j_company or j_company in r_company:
            company_score = max(company_score, 0.92)
        if company_score < 0.80:
            continue
        # With no title to compare, a company match alone is too blunt to retire a job.
        if not r_title:
            continue
        # Reject before scoring when the titles disagree on a year, a level, or a discipline.
        if _conflicts(receipt.title or "", job.title or ""):
            continue
        title_score = _similar(r_title, _norm(job.title or ""))
        if title_score < title_floor:
            continue
        score = company_score * 0.35 + title_score * 0.65
        scored.append((score, job))
    if not scored:
        return (None, 0.0)
    scored.sort(key=lambda sj: sj[0], reverse=True)
    best_score, best = scored[0]
    if len(scored) > 1 and best_score - scored[1][0] < 0.05:
        return (None, 0.0)   # too close to call
    return (best, round(best_score, 3))


# Only a title that is all but identical retires a job automatically. Anything less is a
# suggestion for a human: "Mechanical Test Engineer I" against "Mechanical Engineer I" scores
# 0.93 and is a different posting, and wrongly retiring one hides a job still to apply to.
AUTO_APPLY_SCORE = 0.97


def reconcile(session, receipts: List[Dict[str, Any]], apply: bool = True) -> Dict[str, Any]:
    """Mark jobs a receipt clearly proves were applied to; return the rest for review."""
    open_jobs = session.query(Job).filter(
        Job.status.in_([JobStatus.NEW, JobStatus.ACTIVE, JobStatus.SAVED])).all()
    matched, review, unmatched = [], [], []
    for raw in receipts:
        receipt = Receipt.from_dict(raw)
        job, score = match_receipt(receipt, open_jobs)
        if not job:
            unmatched.append({"company": receipt.company, "title": receipt.title})
            continue
        if score < AUTO_APPLY_SCORE:
            review.append({"job_id": job.id, "company": job.company_name, "job_title": job.title,
                           "receipt_title": receipt.title, "score": score})
            continue
        matched.append({"job_id": job.id, "company": job.company_name,
                        "title": job.title, "score": score,
                        "receipt": receipt.received_at, "was": str(job.status)})
        if apply:
            job.status = JobStatus.APPLIED
            note = (f"Marked applied from an employer receipt "
                    f"({receipt.sender or 'email'}, {receipt.received_at or 'date unknown'}).")
            if isinstance(job.eligibility_reasons, list):
                job.eligibility_reasons = [*job.eligibility_reasons, note]
            elif isinstance(job.eligibility_reasons, str) and job.eligibility_reasons.strip():
                job.eligibility_reasons = [*job.eligibility_reasons.splitlines(), note]
            else:
                job.eligibility_reasons = [note]
            open_jobs.remove(job)
    if apply:
        session.commit()
    return {"matched": matched, "review": review, "unmatched": unmatched}
