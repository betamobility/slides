// Does Mapbox GL run inside Bento's sandbox flags? The embed route renders its
// React tree there (the legend is present) but zero <canvas> appeared, which
// points at the GL worker rather than the page. Mapbox GL starts its worker
// from a blob: URL, and a document with an OPAQUE origin (sandbox without
// allow-same-origin) cannot create one.
//
// Test the same URL under three flag sets and count canvases. If only the
// allow-same-origin variants paint, the sandbox is the blocker and no amount of
// work on the page can fix it.
import { chromium } from 'playwright';

const BASE = 'http://localhost:3411';
const URL_ = BASE + '/embed/kommune/aarhus';

const CASES = [
  ['bento today          ', 'allow-scripts allow-forms'],
  ['+ allow-same-origin  ', 'allow-scripts allow-forms allow-same-origin'],
  ['no sandbox attribute ', null],
];

const browser = await chromium.launch();
for (const [label, flags] of CASES) {
  const page = await browser.newPage({ viewport: { width: 1160, height: 520 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 110)));
  const attr = flags === null ? '' : `sandbox="${flags}"`;
  await page.setContent(
    `<body style="margin:0"><iframe ${attr} style="width:1088px;height:424px;border:0" src="${URL_}"></iframe></body>`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForTimeout(16_000);

  let canvases = -1;
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try { canvases = await f.evaluate(() => document.querySelectorAll('canvas').length); }
    catch { canvases = -1; } // opaque origin: unreadable from the parent
  }
  // Count canvases from the frame's own side when the parent cannot read it.
  console.log(`${label} canvases=${canvases === -1 ? 'unreadable (opaque origin)' : canvases}` +
    `  pageerrors=${errs.length ? errs.join(' | ') : 'none'}`);
  await page.screenshot({ path: `shots/sandbox-${flags === null ? 'none' : (flags.includes('same-origin') ? 'same-origin' : 'bento')}.png` });
  await page.close();
}
await browser.close();
