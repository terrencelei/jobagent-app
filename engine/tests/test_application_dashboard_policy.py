"""Browser checks for application queue eligibility and submission chronology."""
from pathlib import Path

import pytest


def test_snapshot_applied_order_and_internship_queue_policy():
    playwright = pytest.importorskip('playwright.sync_api')
    source = (Path(__file__).parents[1] / 'src/jobagent/ui/dashboard.js').read_text()
    # Exercise the actual pure dashboard functions without CDN assets or a live API.
    functions = source[source.index('function snapshotRequest('):source.index('async function api(')]
    functions += source[source.index('function queueableRole('):source.index('function queueUnavailableReason(')]
    functions += source[source.index('function submittedLabel('):source.index('function createJobCard(')]
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            result = page.evaluate('''functions => {
              const snapshot = {jobs: [
                {id: 1, applied_date: '2026-10-16T05:20:00Z', priority_score: 1},
                {id: 2, applied_date: '2026-10-15T12:20:00Z', priority_score: 100},
                {id: 3, applied_date: null, priority_score: 1000},
                {id: 4, applied_date: null, priority_score: 1000}
              ].map(j => ({...j, tabs: ['applied']}))};
              let connected = true;
              const pipeline = new Set(['APPLIED']);
              let selectedCompanyFilter = [];
              eval(functions);
              const intern = {status: 'ACTIVE', role_type: 'INTERNSHIP', eligibility: 'ELIGIBLE', company_name: 'Acme'};
              return {
                order: snapshotRequest('/api/jobs?tab=applied').jobs.map(j => j.id),
                queue: canQueueApplication(intern),
                applied: canQueueApplication({...intern, status: 'APPLIED'}),
                other: canQueueApplication({...intern, role_type: 'OTHER'}),
                google: canQueueApplication({...intern, company_name: 'Google'}),
                likely: canQueueApplication({...intern, eligibility: 'LIKELY_ELIGIBLE'}),
                likelyMarks: queueMarksFit({...intern, eligibility: 'LIKELY_ELIGIBLE'}),
                uncertainMarks: queueMarksFit({...intern, eligibility: 'UNCERTAIN'}),
                labelled: canQueueApplication({...intern, eligibility: 'UNCERTAIN', user_fit_label: {fit: true}}),
                ineligibleMarks: queueMarksFit({...intern, eligibility: 'INELIGIBLE'}),
                notFitMarks: queueMarksFit({...intern, eligibility: 'LIKELY_ELIGIBLE', user_fit_label: {fit: false}}),
                eligibleMarks: queueMarksFit(intern),
                missingDate: submittedLabel({applied_date: null}),
                submittedDate: submittedLabel(snapshot.jobs[0])
              };
            }''', functions)
            assert result['order'] == [1, 2, 4, 3]
            assert result['queue']
            assert not any(result[k] for k in ('applied', 'other', 'google', 'likely'))
            # Likely eligible / uncertain roles queue with one click that also records his Good fit label.
            assert result['likelyMarks'] and result['uncertainMarks'] and result['labelled']
            assert not any(result[k] for k in ('ineligibleMarks', 'notFitMarks', 'eligibleMarks'))
            assert result['missingDate'] == 'Submission date unavailable'
            assert result['submittedDate'].startswith('Submitted ')
        finally:
            browser.close()
