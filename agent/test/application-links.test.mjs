import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { normalizeApplicationLink, normalizeExistingLinks } from '../src/application-links.mjs';

test('web links use HTTPS and canonical LinkedIn without changing identity or prose', () => {
  for (const input of ['linkedin.com/in/example', 'http://linkedin.com/in/example', 'https://linkedin.com/in/example', '//www.linkedin.com/in/example'])
    assert.equal(normalizeApplicationLink(input), 'https://www.linkedin.com/in/example');
  assert.equal(normalizeApplicationLink(' github.com/example/project?tab=readme#section '), 'https://github.com/example/project?tab=readme#section');
  for (const value of ['candidate@example.com', 'See example.com for my work', 'N/A', '', 'ftp://example.com/file', 'https://user:secret@example.com', 'https://www.linkedin.com/in/example'])
    assert.equal(normalizeApplicationLink(value), value);
  assert.equal(normalizeApplicationLink('http://portfolio.example.org/CaseSensitive/'), 'https://portfolio.example.org/CaseSensitive/');
});

test('resume-prefilled links are corrected and strict LinkedIn validation clears', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    await page.setContent(`<input type="text" id="social" value="https://linkedin.com/in/example" pattern="https://www\\.linkedin\\.com/in/.+"><input type="url" id="portfolio" value="portfolio.example.org"><input type="text" id="email" value="candidate@example.com"><input type="password" value="example.com">`);
    assert.equal(await page.locator('#social').evaluate(e => e.checkValidity()), false);
    await normalizeExistingLinks(page);
    assert.equal(await page.locator('#social').evaluate(e => e.checkValidity()), true);
    assert.equal(await page.locator('#portfolio').inputValue(), 'https://portfolio.example.org');
    assert.equal(await page.locator('#email').inputValue(), 'candidate@example.com');
    assert.equal(await page.locator('[type=password]').inputValue(), 'example.com');
  } finally { await browser.close(); }
});
