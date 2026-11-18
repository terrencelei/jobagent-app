import { applicationChromium } from '../src/captcha-vendor.mjs';
const chromium = await applicationChromium();  // the CAPTCHA package's stealth.js launch
import { readFile } from 'node:fs/promises';
const [key, url] = process.argv.slice(2);
const creds = JSON.parse(await readFile('private/credentials.json', 'utf8'))[key];
const browser = await chromium.launch({headless: process.env.APPLICATION_AGENT_HEADED !== '1'});
const page = await browser.newPage(); page.setDefaultTimeout(30000);
try {
  await page.goto(url, {waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(5000);
  await page.locator('[data-automation-id="email"], input[type="email"]').first().fill(creds.email);
  await page.locator('[data-automation-id="password"], input[type="password"]').first().fill(creds.password);
  // As on every other Workday button, the click lands on the overlay, not the button.
  const filter = page.locator('div[data-automation-id="click_filter"][aria-label="Sign In"]').first();
  if (await filter.count()) await filter.click();
  else await page.locator('[data-automation-id="signInSubmitButton"]').first().click({force: true});
  await page.waitForTimeout(10000);
  console.log('url:', page.url());
  console.log((await page.locator('body').innerText()).replace(/\n{2,}/g, '\n').slice(0, 800));
  await page.screenshot({path: 'artifacts/workday-signin.png', fullPage: true});
} finally { await browser.close(); }
