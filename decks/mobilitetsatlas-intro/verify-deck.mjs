// Open the built deck, run window.bento.validate(), then render EVERY slide —
// linear and state — to a PNG. The guide is explicit that a deck nobody looked
// at is not finished, and none of the failures that matter (text overflowing a
// box, two elements colliding, a chart legend silently dropped) are visible in
// the JSON.
//
// Slides are rendered through the deck's own renderSlide via present mode: the
// show is started, then each slide is stepped to and captured.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DECK = join(HERE, 'Mobilitetsatlas-introduktion.bento.html');
const SHOTS = join(HERE, 'shots');
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));

await page.goto('file://' + DECK, { waitUntil: 'load', timeout: 90_000 });
await page.waitForFunction(() => !!window.bento?.validate, { timeout: 60_000 });
await page.waitForTimeout(3000);

const report = await page.evaluate(() => {
  const { ok, counts, findings } = window.bento.validate();
  return { ok, counts, findings: findings.map((f) => ({
    code: f.code, severity: f.severity, slide: f.slide, element: f.element,
    path: f.path, message: f.message.slice(0, 220),
  })) };
});
console.log('validate ok:', report.ok, 'counts:', JSON.stringify(report.counts));
const bySeverity = {};
for (const f of report.findings) (bySeverity[f.severity] ??= []).push(f);
for (const sev of ['error', 'warning', 'info']) {
  const list = bySeverity[sev] ?? [];
  console.log(`\n--- ${sev} (${list.length}) ---`);
  for (const f of list) console.log(`  [${f.code}] ${f.slide ?? ''}/${f.element ?? ''} ${f.path ?? ''} :: ${f.message}`);
}
writeFileSync(join(HERE, 'validate.json'), JSON.stringify(report, null, 1));

// --- render every slide ------------------------------------------------------
const ids = await page.evaluate(() => window.bento.doc.slides.map((s) => s.id));
console.log('\nslides:', ids.join(', '));

await page.evaluate(() => window.bento.editor?.present?.(true, false));
await page.waitForTimeout(3500);

for (let i = 0; i < ids.length; i++) {
  const id = ids[i];
  const jumped = await page.evaluate((sid) => {
    const deck = window.Reveal || window.bento?.reveal;
    const idx = window.bento.doc.slides.findIndex((s) => s.id === sid);
    if (deck?.slide) { deck.slide(idx, 0); return true; }
    return false;
  }, id);
  if (!jumped && i > 0) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(2600);
  await page.screenshot({ path: join(SHOTS, `${String(i).padStart(2, '0')}-${id}.png`) });
}

console.log('\nconsole errors:', errors.length);
for (const e of [...new Set(errors)].slice(0, 12)) console.log('  ', e);
await browser.close();
