import { applicationChromium } from '../src/captcha-vendor.mjs';
const chromium = await applicationChromium();  // the CAPTCHA package's stealth.js launch
import { mkdir, writeFile } from 'node:fs/promises';
const [url, outDir] = process.argv.slice(2);
if (!url || !outDir) throw new Error('Usage: node private/inspect-form.mjs URL OUT_DIR');
await mkdir(outDir, {recursive: true, mode: 0o700});
const browser = await chromium.launch({headless: true});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  // Some boards hold a connection open, so networkidle never fires; settle on a best effort.
  await page.goto(url, {waitUntil: 'domcontentloaded'});
  await page.waitForLoadState('networkidle', {timeout: 8000}).catch(() => {});
  await page.waitForTimeout(2000);
  const fields = await page.locator('input,textarea,select,button').evaluateAll(els => els.map(e => ({
    tag: e.tagName, id: e.id, name: e.name, type: e.type, role: e.getAttribute('role'),
    ariaLabel: e.getAttribute('aria-label'),
    label: e.labels?.[0]?.innerText?.trim()?.slice(0, 300),
    text: e.tagName === 'BUTTON' ? e.innerText?.trim()?.slice(0, 40) : undefined,
    required: e.required || e.getAttribute('aria-required') === 'true',
    placeholder: e.placeholder,
    // A limit the employer enforces has to reach the person writing the answer, not
    // surface as a truncated submission.
    maxLength: e.maxLength > 0 && e.maxLength < 524288 ? e.maxLength : undefined,
    // Boards that address fields by name rather than id need the option value to target a radio.
    value: (e.type === 'radio' || e.type === 'checkbox') ? e.value : undefined,
    minLength: e.minLength > 0 ? e.minLength : undefined,
  })));
  await writeFile(`${outDir}/fields.json`, JSON.stringify(fields, null, 2), {mode: 0o600});
  await writeFile(`${outDir}/page.txt`, await page.locator('body').innerText(), {mode: 0o600});
  await writeFile(`${outDir}/page.html`, await page.content(), {mode: 0o600});
  await page.screenshot({path: `${outDir}/form.png`, fullPage: true});
  console.log(`url: ${page.url()}`);
  console.log(`${fields.length} controls captured -> ${outDir}`);
  for (const f of fields) {
    const name = f.label || f.ariaLabel || f.placeholder || f.text || f.name || f.id;
    const limit = f.maxLength ? `  [max ${f.maxLength} chars]` : '';
    if (name) console.log(`  ${f.tag}${f.required ? '*' : ' '} ${f.type ?? ''} ${f.id ? `#${f.id}` : ''} :: ${name}${limit}`);
  }
} finally { await browser.close(); }
