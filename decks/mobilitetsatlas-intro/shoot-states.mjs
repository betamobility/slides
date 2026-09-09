// The linear walk skips state slides by design, so they never got a full-size
// render. Click their sidebar thumbnails and capture each one.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DECK = join(HERE, 'Mobilitetsatlas-introduktion.bento.html');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto('file://' + DECK, { waitUntil: 'load', timeout: 90_000 });
await page.waitForFunction(() => !!window.bento?.doc, { timeout: 60_000 });
await page.waitForTimeout(3000);

const ids = await page.evaluate(() => window.bento.doc.slides.map((s) => s.id));
for (const id of ['state-limits', 'state-how-to-read', 'state-explore', 'improve']) {
  const i = ids.indexOf(id);
  const thumb = page.locator('.ed-sidebar [data-slide-id], .ed-thumb, [data-slide-index]').nth(i);
  try {
    await thumb.scrollIntoViewIfNeeded({ timeout: 4000 });
    await thumb.click({ timeout: 4000 });
  } catch {
    await page.evaluate((n) => {
      const t = document.querySelectorAll('.ed-sidebar li, .ed-sidebar [role="option"], .ed-thumb');
      t[n]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      t[n]?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      t[n]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, i);
  }
  await page.waitForTimeout(2200);
  await page.screenshot({ path: join(HERE, 'shots', `state-${id}.png`) });
  console.log('shot', id);
}
await browser.close();
