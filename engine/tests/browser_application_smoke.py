"""Run after browser_application_fixture.py to verify dashboard -> worker -> Approvals -> single submission.

Current flow (2026-10-23): roles are queued from listing cards, workers run headless and park unknown questions on
the Approvals page, an approved answer sends the role back through, and the standing auto-submit authorization
submits it exactly once. The second role is left waiting on Approvals, so exactly one submission must reach the
local test employer."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
with sync_playwright() as p:
 b=p.chromium.launch(headless=True)
 page=b.new_page(viewport={'width':1500,'height':1050});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('http://127.0.0.1:8877')
 queue=page.get_by_role('button',name='+ Add to queue',exact=True)
 queue.first.click();expect(page.locator('[data-queue-job][data-queue-position="end"]').first).to_have_text('Queued ✓')
 page.get_by_role('button',name='+ Add to queue',exact=True).first.click()
 page.locator('#applicationsBtn').click()
 expect(page.locator('#applicationPanel')).to_be_visible()
 expect(page.locator('#appQueue li.app-track:not(.auto)')).to_have_count(2)
 page.locator('#appParallel').select_option('2')
 page.wait_for_timeout(300)
 page.get_by_role('button',name='Start workers',exact=True).click()
 # Both workers fill the name, then park the free-text question on Approvals and move on.
 approvals=b.new_page(viewport={'width':1300,'height':1000});approvals.on('pageerror',lambda e:errors.append(str(e)))
 approvals.goto('http://127.0.0.1:8877/approvals')
 expect(approvals.locator('article[data-card] textarea')).to_have_count(2,timeout=60000)
 approvals.screenshot(path='/tmp/jobagent-application-approvals.png')
 card=approvals.locator('article[data-card]').first
 card.locator('textarea').fill('I designed mechanical assemblies and want to develop that experience.')
 card.get_by_role('button',name='Approve answers & continue').click()
 expect(approvals.locator('article[data-card] textarea')).to_have_count(1,timeout=15000)
 root=Path(Path('/tmp/application-e2e-path').read_text())
 page.wait_for_function("1",timeout=1000)
 for _ in range(120):
  receipts=json.loads((root/'submissions.json').read_text()) if (root/'submissions.json').exists() else []
  if receipts:break
  page.wait_for_timeout(500)
 assert len(receipts)==1,receipts
 page.set_viewport_size({'width':390,'height':844})
 assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
 page.get_by_role('button',name='Stop workers',exact=True).click()
 # Stop lets running postings finish first ('Finishing current postings'), then reports OFF.
 expect(page.locator('#appState')).to_contain_text('OFF',timeout=60000)
 page.wait_for_timeout(2500)
 receipts=json.loads((root/'submissions.json').read_text())
 assert len(receipts)==1,receipts
 assert not errors,errors
 print('PASS: queue from cards, two headless workers, questions parked on Approvals, one approval -> exactly one auto-submission, stop, mobile, no JS errors.')
 b.close()
