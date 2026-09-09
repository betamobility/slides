// Does the live embed actually boot in present mode, or does the deck fall back
// to the static view? The Bento shell layers a SANDBOXED iframe (no
// allow-same-origin) over the view, which gives the framed page an opaque
// origin — and the atlas touches localStorage in its theme pre-paint script and
// in mapbox. If that throws, the frame dies and the view shows. Either outcome
// is fine for the deck; what is not fine is calling a screenshot "interactive"
// without checking.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DECK = join(HERE, 'Mobilitetsatlas-introduktion.bento.html');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.goto('file://' + DECK + '#present', { waitUntil: 'load', timeout: 90_000 });
await page.waitForTimeout(6000);

// Walk to the aarhus-live slide (index among non-state slides).
const idx = await page.evaluate(() =>
  window.bento.doc.slides.filter((s) => !s.stateOf).findIndex((s) => s.id === 'aarhus-page'));
await page.mouse.click(640, 700);
for (let i = 0; i < idx; i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(900); }
await page.waitForTimeout(12_000);

const state = await page.evaluate(() => {
  const frames = [...document.querySelectorAll('iframe')];
  return {
    frames: frames.length,
    detail: frames.map((f) => ({
      src: (f.src || '').slice(0, 80),
      sandbox: f.getAttribute('sandbox'),
      w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height,
    })),
    views: document.querySelectorAll('.bento-el-embed').length,
  };
});
console.log(JSON.stringify(state, null, 1));

// Did anything actually paint inside the frame?
for (const f of page.frames()) {
  if (f === page.mainFrame()) continue;
  try {
    const t = await f.evaluate(() => ({ url: location.href.slice(0, 70), title: document.title.slice(0, 60), nodes: document.querySelectorAll('*').length }));
    console.log('FRAME', JSON.stringify(t));
  } catch (e) { console.log('FRAME unreadable (cross-origin, which is expected):', e.message.slice(0, 80)); }
}

await page.screenshot({ path: join(HERE, 'shots', 'present-aarhus-live.png') });
await browser.close();
