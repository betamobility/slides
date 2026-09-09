// The real check: in PRESENT mode, does each live slide paint a running map
// inside its frame? Counting canvases from inside the frame, because a frame
// that loaded and a frame that rendered are different things — the earlier
// failure looked identical from outside.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DECK = join(HERE, '..', 'decks', 'mobilitetsatlas-intro', 'Mobilitetsatlas-introduktion.bento.html');
const TARGETS = ['aarhus-live', 'byvisning'];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('file://' + DECK + '#present', { waitUntil: 'load', timeout: 90_000 });
await page.waitForTimeout(6000);
await page.mouse.click(640, 700);

const order = await page.evaluate(() => window.bento.doc.slides.filter((s) => !s.stateOf).map((s) => s.id));
let at = 0;
for (const id of TARGETS) {
  const want = order.indexOf(id);
  while (at < want) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(900); at++; }
  await page.waitForTimeout(id === 'byvisning' ? 30_000 : 20_000);

  let painted = null;
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      const r = await f.evaluate(() => ({
        url: location.pathname,
        canvases: document.querySelectorAll('canvas').length,
        glSize: (() => { const c = document.querySelector('canvas'); return c ? `${c.width}x${c.height}` : null; })(),
      }));
      if (r.canvases) painted = r;
    } catch { /* opaque origin */ }
  }
  console.log(`${id.padEnd(14)} ${painted ? `MAP RUNNING  ${painted.url}  canvas ${painted.glSize}` : 'no canvas in any frame'}`);
  await page.screenshot({ path: join(HERE, 'shots', `live-${id}.png`) });
}
await browser.close();
