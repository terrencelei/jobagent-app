import { applicationChromium } from '../src/captcha-vendor.mjs';
const chromium = await applicationChromium();  // the CAPTCHA package's stealth.js launch
import { readFile, writeFile } from 'node:fs/promises';
const [url, outDir, ...ids] = process.argv.slice(2);
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  await page.goto(url, {waitUntil:'networkidle'});
  let targets = ids;
  if (!targets.length) {
    const fields = JSON.parse(await readFile(`${outDir}/fields.json`,'utf8'));
    targets = fields.filter(f => f.role === 'combobox' || (f.tag === 'INPUT' && f.type === 'text' && f.id)).map(f => f.id).filter(Boolean);
  }
  const out = {};
  for (const id of targets) {
    try {
      await page.keyboard.press('Escape');
      await page.locator(`[id="${id}"]`).click();
      await page.waitForTimeout(350);
      const opts = await page.getByRole('option').allTextContents();
      if (opts.length) out[id] = opts;
      await page.keyboard.press('Escape');
    } catch { /* not a menu */ }
  }
  await writeFile(`${outDir}/options.json`, JSON.stringify(out,null,2), {mode:0o600});
  for (const [k,v] of Object.entries(out)) console.log(`${k}: ${v.length > 14 ? v.slice(0,14).join(' | ') + ' ...' : v.join(' | ')}`);
} finally { await browser.close(); }
