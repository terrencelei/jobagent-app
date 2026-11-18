import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {closedTabFailure} from '../src/browser-identity.mjs';

// Tesla 11930 (lesson 462): the run's tab in his visible Chrome was closed mid-fill.
test('a tab closed outside the worker before submission is reported plainly', async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.setContent('<form><input id="f0c17"></form>');
    let tabClosed = false; page.on('close', () => { tabClosed = true; });
    await page.close();
    const error = await page.locator('#f0c17').count().then(() => null, e => e);
    assert.ok(error, 'locator on a closed tab throws');
    assert.match(closedTabFailure(error, {tabClosed}), /tab in your Chrome was closed.*nothing was submitted/);
    assert.equal(closedTabFailure(error, {tabClosed, submitted: true}), null);
    assert.equal(closedTabFailure(error, {tabClosed: false}), null);
    assert.equal(closedTabFailure(new Error('locator.click: Timeout 10000ms exceeded'), {tabClosed}), null);
  } finally { await browser.close(); }
});
