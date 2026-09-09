// Capture byvisning (city view) of København on staging, tilted and zoomed past
// the `detail-buildings` fill-extrusion minzoom of 15, so the extruded massing
// is the subject.
//
// Standalone rather than through the Playwright MCP: byvisning animates vehicles
// on a 30ms loop, so the accessibility snapshot the MCP takes after each action
// waits minutes on a page that is never quiescent.
//
// The camera is driven through the map OBJECT, not synthetic input. Three runs
// with wheel + right-drag never cleared zoom 15 and twice hit the 85° pitch
// clamp, and the reason they were hard to correct is that input gives no
// read-back: you cannot tell a zoom that did not apply from one that did. The
// map lives in a React ref (`mapRef` in detail-map.tsx), so it is reachable by
// walking the fiber HOOK chain — an earlier walk over `memoizedProps` drowned in
// the props graph and hit its depth cap. With the handle, zoom and pitch are set
// exactly and asserted before the shutter.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const PAGE_URL = 'https://staging.mobilitetsatlas.dk/en/kommune/koebenhavn';
const OUT = fileURLToPath(new URL('./view-byvisning.jpeg', import.meta.url));

/** Runs in the page: find the mapbox Map by walking fibers' hook chains. */
const FIND_MAP = `() => {
  const isMap = (v) => v && typeof v === 'object'
    && typeof v.getZoom === 'function' && typeof v.easeTo === 'function'
    && typeof v.getStyle === 'function';
  const roots = [];
  for (const el of document.querySelectorAll('div')) {
    const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
    if (k) { roots.push(el[k]); break; }
  }
  if (!roots.length) return null;
  let f = roots[0];
  while (f.return) f = f.return;            // climb to the fiber root
  const queue = [f];
  const seen = new Set();
  while (queue.length) {
    const node = queue.shift();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    // every hook on this fiber: useRef stores the ref object in memoizedState
    let hook = node.memoizedState;
    let guard = 0;
    while (hook && guard++ < 200) {
      const s = hook.memoizedState;
      if (isMap(s)) { window.__bentoMap = s; return 'hook'; }
      if (s && typeof s === 'object' && isMap(s.current)) { window.__bentoMap = s.current; return 'ref'; }
      hook = hook.next;
    }
    if (isMap(node.stateNode)) { window.__bentoMap = node.stateNode; return 'stateNode'; }
    if (node.child) queue.push(node.child);
    if (node.sibling) queue.push(node.sibling);
  }
  return null;
}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1088, height: 560 }, deviceScaleFactor: 2 });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERROR', m.text().slice(0, 160)); });

await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
const decline = page.getByRole('button', { name: /Decline|Afvis/ });
if (await decline.count()) await decline.first().click().catch(() => {});
await page.waitForSelector('canvas', { timeout: 60_000 });
await page.waitForTimeout(5000);

await page.getByRole('button', { name: 'Byvisning' }).click();
console.log('byvisning on');
await page.waitForTimeout(10_000);

let how = null;
try { how = await page.evaluate(FIND_MAP); } catch (e) { console.log('fiber walk threw', e.message.slice(0, 120)); }
console.log('map handle via', how);

if (!how) {
  // No handle. Fall back to mapbox's KEYBOARD handler, which is the one input
  // path with defined step sizes: '=' zooms in exactly 1 level per press and
  // Shift+ArrowUp pitches in fixed increments. Wheel and right-drag were tried
  // three times and are unusable here — their gain is unknown and nothing reads
  // back, so a frame that missed zoom 15 looks identical to one that did not.
  const canvas = page.locator('canvas').first();
  await canvas.focus();
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Equal'); await page.waitForTimeout(1400); }
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Shift+ArrowUp'); await page.waitForTimeout(900); }
  await page.waitForTimeout(6000);
  console.log('camera driven by keyboard (5 zoom-in, 3 pitch-up steps)');
}

// Indre By, tilted, comfortably past the extrusion minzoom. maxBounds is set to
// the city extent in byvisning, so this centre has to sit inside it.
const cam = how ? await page.evaluate(async () => {
  const map = window.__bentoMap;
  map.jumpTo({ center: [12.5750, 55.6810], zoom: 16.2, pitch: 60, bearing: -22 });
  await new Promise((r) => setTimeout(r, 8000));
  const layer = map.getStyle().layers.find((l) => l.id === 'detail-buildings');
  return {
    zoom: +map.getZoom().toFixed(2), pitch: +map.getPitch().toFixed(1),
    bearing: +map.getBearing().toFixed(1),
    buildingsLayer: layer ? layer.type : null,
    buildingsVisible: layer ? map.getLayoutProperty('detail-buildings', 'visibility') ?? 'visible' : null,
    renderedBuildings: map.queryRenderedFeatures({ layers: ['detail-buildings'] }).length,
  };
}) : null;
console.log('camera', cam);
if (cam) {
  if (cam.zoom < 15.05) { await browser.close(); throw new Error(`zoom ${cam.zoom} is below the extrusion minzoom`); }
  if (!cam.renderedBuildings) console.log('WARNING: no building features rendered at this camera');
}

await page.evaluate(() => { const h = document.querySelector('header'); if (h) h.style.display = 'none'; });
const box = await page.locator('canvas').first().boundingBox();
await page.evaluate((top) => scrollBy(0, top - 2), box.y);
await page.waitForTimeout(1200);

const decline2 = page.getByRole('button', { name: /Decline|Afvis/ });
if (await decline2.count()) await decline2.first().click().catch(() => {});
await page.waitForTimeout(2500);

await page.screenshot({ path: OUT, type: 'jpeg', quality: 88 });
console.log('wrote', OUT);
await browser.close();
