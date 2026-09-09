// Verify the new /embed surface two ways:
//   1. directly, so the map is real and chrome-free;
//   2. inside the EXACT sandbox Bento's embed uses (allow-scripts allow-forms,
//      no allow-same-origin) — the condition under which the ordinary kommune
//      page dies on document.cookie. This is the check the whole change exists
//      for, so it is not enough to see the page load on its own.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'shots');
const BASE = 'http://localhost:3411';

const browser = await chromium.launch();

async function direct(path, file, settle = 14_000) {
  const page = await browser.newPage({ viewport: { width: 1088, height: 424 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 140)));
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForTimeout(settle);
  await page.screenshot({ path: join(SHOTS, file) });
  console.log(`direct  ${path}\n  errors: ${errs.length ? errs.join(' | ') : 'none'}`);
  await page.close();
}

async function sandboxed(path, file, settle = 18_000) {
  const page = await browser.newPage({ viewport: { width: 1160, height: 500 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 140)));
  // The parent must NOT be a React page: a first attempt framed from the embed
  // route itself, and Next's hydration re-rendered document.body and wiped the
  // injected iframe — the screenshot showed the parent, and page.frames() found
  // nothing. A static parent via setContent has neither problem.
  await page.setContent(
    `<body style="margin:0;background:#F5F3EF">
       <iframe sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"
               style="width:1088px;height:424px;border:0;display:block;margin:38px"
               src="${BASE + path}"></iframe>
     </body>`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForTimeout(settle);
  await page.screenshot({ path: join(SHOTS, file) });

  let inner = 'no frame';
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      inner = await f.evaluate(() => ({
        title: document.title.slice(0, 50),
        canvases: document.querySelectorAll('canvas').length,
        nodes: document.querySelectorAll('*').length,
        text: (document.body.innerText || '').slice(0, 60).replace(/\s+/g, ' '),
      }));
    } catch (e) { inner = 'unreadable: ' + e.message.slice(0, 60); }
  }
  console.log(`sandbox ${path}\n  frame: ${JSON.stringify(inner)}\n  errors: ${errs.length ? errs.join(' | ') : 'none'}`);
  await page.close();
}

await direct('/embed/kommune/aarhus', 'embed-aarhus-direct.png');
await direct('/en/embed/kommune/koebenhavn?view=city', 'embed-koebenhavn-city.png', 26_000);
await sandboxed('/embed/kommune/aarhus', 'embed-aarhus-sandboxed.png');

await browser.close();
