// Create a candidate account on a Workday tenant. Workday will not take an application without
// one, and the account is per employer, so this runs once per tenant and then stays out of the way.
import { applicationChromium } from '../src/captcha-vendor.mjs';
const chromium = await applicationChromium();  // the CAPTCHA package's stealth.js launch
import { readFile } from 'node:fs/promises';

const [key, applyUrl] = process.argv.slice(2);
if (!key || !applyUrl) throw new Error('Usage: workday-account.mjs CREDENTIAL_KEY APPLY_URL');
const creds = JSON.parse(await readFile('private/credentials.json', 'utf8'))[key];
if (!creds) throw new Error(`No credential named ${key}`);

const browser = await chromium.launch({headless: process.env.APPLICATION_AGENT_HEADED !== '1'});
const page = await browser.newPage();
page.setDefaultTimeout(30000);
try {
  await page.goto(applyUrl, {waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(5000);
  const body = () => page.locator('body').innerText().catch(() => '');
  if (/Sign In to Apply|Already have an account/i.test(await body()) === false && !/Create Account/i.test(await body()))
    throw new Error('This page is not the Workday create-account step');

  await page.locator('[data-automation-id="email"], input[type="email"]').first().fill(creds.email);
  const pw = page.locator('[data-automation-id="password"], input[type="password"]');
  await pw.nth(0).fill(creds.password);
  if (await pw.count() > 1) await pw.nth(1).fill(creds.password);
  const ack = page.locator('[data-automation-id="createAccountCheckbox"], input[type="checkbox"]').first();
  if (await ack.count()) await ack.check({force: true}).catch(() => {});
  await page.screenshot({path: 'artifacts/workday-account-before.png', fullPage: true});
  // Workday lays a transparent div over each button and takes the click there, so the button
  // itself is never the thing that gets pressed.
  const press = async (label) => {
    const filter = page.locator(`div[data-automation-id="click_filter"][aria-label="${label}"]`).first();
    if (await filter.count()) return filter.click();
    return page.locator(`button:has-text("${label}")`).first().click();
  };
  page.on('request', r => { if (r.method() === 'POST') console.log('POST', r.url().slice(0, 110)); });
  const stillHere = async () => /Please create an account to apply/i.test(await body());
  await press('Create Account');
  await page.waitForTimeout(8000);
  if (await stillHere()) {
    console.log('still on create account; pressing the button itself');
    await page.locator('[data-automation-id="createAccountSubmitButton"]').first().click({force: true}).catch(e => console.log(' ', e.message.split('\n')[0]));
    await page.waitForTimeout(8000);
  }
  if (await stillHere()) {
    console.log('still on create account; submitting from the password field');
    await page.locator('[data-automation-id="verifyPassword"], input[type="password"]').last().press('Enter').catch(() => {});
    await page.waitForTimeout(8000);
  }
  const text = await body();
  await page.screenshot({path: 'artifacts/workday-account-after.png', fullPage: true});
  console.log('url:', page.url());
  console.log(text.replace(/\n{2,}/g, '\n').slice(0, 900));
} finally { await browser.close(); }
