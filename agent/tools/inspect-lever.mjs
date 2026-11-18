// Read a Lever application form.
//
// Lever addresses fields by name rather than id, and groups custom questions into "cards"
// whose wording lives in the surrounding markup rather than on a label. This pairs each
// question with the fields that answer it, which is what a plan needs.
import { applicationChromium } from '../src/captcha-vendor.mjs';
const chromium = await applicationChromium();  // the CAPTCHA package's stealth.js launch
import { mkdir, writeFile } from 'node:fs/promises';

const [url, outDir] = process.argv.slice(2);
if (!url || !outDir) throw new Error('Usage: inspect-lever.mjs APPLY_URL OUT_DIR');
await mkdir(outDir, {recursive: true, mode: 0o700});
const browser = await chromium.launch({headless: true});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);
  await page.goto(url, {waitUntil: 'domcontentloaded'});
  await page.waitForLoadState('networkidle', {timeout: 8000}).catch(() => {});
  await page.waitForTimeout(2000);

  const form = await page.evaluate(() => {
    const clean = t => (t || '').replace(/\s+/g, ' ').trim();
    const base = [...document.querySelectorAll('input,textarea,select')]
      .filter(e => e.name && e.type !== 'hidden' && !e.name.startsWith('cards['))
      .map(e => ({name: e.name, type: e.type || e.tagName.toLowerCase(),
                  required: e.required, label: clean(e.closest('li,div')?.querySelector('.application-label, label')?.innerText)}));
    // Each custom question sits in its own container; the wording is its heading.
    const cards = [];
    document.querySelectorAll('[class*="application-question"], li.application-question, .card').forEach(box => {
      const inputs = [...box.querySelectorAll('input,textarea,select')].filter(e => e.name && e.type !== 'hidden');
      if (!inputs.length) return;
      const heading = clean(box.querySelector('.application-label, .text, label, h4, h3')?.innerText)
        || clean(box.innerText).slice(0, 160);
      const byField = {};
      for (const e of inputs) {
        (byField[e.name] ||= {name: e.name, type: e.type || e.tagName.toLowerCase(),
                              required: e.required, options: []});
        if (e.type === 'radio' || e.type === 'checkbox') {
          byField[e.name].options.push(clean(e.parentElement?.innerText) || e.value);
          byField[e.name].values ||= [];
          byField[e.name].values.push(e.value);
        }
      }
      cards.push({question: heading, fields: Object.values(byField)});
    });
    return {base, cards};
  });
  await writeFile(`${outDir}/lever.json`, JSON.stringify(form, null, 2), {mode: 0o600});
  await writeFile(`${outDir}/page.txt`, await page.locator('body').innerText(), {mode: 0o600});
  console.log(`base fields: ${form.base.length}, question cards: ${form.cards.length} -> ${outDir}/lever.json`);
  for (const b of form.base) console.log(`  ${b.required ? '*' : ' '} ${b.type.padEnd(9)} ${b.name}`);
  for (const c of form.cards) {
    console.log(`\n  Q: ${c.question.slice(0, 110)}`);
    for (const f of c.fields) console.log(`     ${f.required ? '*' : ' '} ${f.type.padEnd(8)} ${f.name.slice(-16)}  ${(f.options || []).slice(0, 4).join(' | ').slice(0, 90)}`);
  }
} finally { await browser.close(); }
