// Probe: find the mapbox instance in byvisning and report camera + whether the
// style has any fill-extrusion (i.e. whether "buildings showing" means extruded
// 3D massing or flat footprints).
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const PAGE_URL = 'https://staging.mobilitetsatlas.dk/en/kommune/koebenhavn';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1088, height: 560 }, deviceScaleFactor: 2 });
await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
const decline = page.getByRole('button', { name: /Decline|Afvis/ });
if (await decline.count()) await decline.first().click().catch(() => {});
await page.waitForSelector('canvas', { timeout: 60_000 });
await page.waitForTimeout(5000);
await page.getByRole('button', { name: 'Byvisning' }).click();
await page.waitForTimeout(12_000);

const info = await page.evaluate(() => {
  // React fiber walk: the map instance is held in a ref inside the component
  // tree under the map container.
  const el = document.querySelector('.mapboxgl-map') || document.querySelector('canvas')?.parentElement;
  if (!el) return { err: 'no container' };
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  const seen = new Set();
  let found = null;
  const looksLikeMap = (v) => v && typeof v === 'object' && typeof v.easeTo === 'function' && typeof v.getStyle === 'function';
  const walk = (node, depth) => {
    if (!node || found || depth > 40 || seen.has(node)) return;
    seen.add(node);
    for (const prop of ['stateNode', 'memoizedState', 'memoizedProps', 'current', 'next', 'child', 'return', 'sibling']) {
      const v = node[prop];
      if (looksLikeMap(v)) { found = v; return; }
      if (v && typeof v === 'object') walk(v, depth + 1);
      if (found) return;
    }
  };
  if (key) walk(el[key], 0);
  if (!found) return { err: 'map not found via fiber', hadKey: !!key };
  const layers = found.getStyle().layers;
  return {
    ok: true,
    zoom: found.getZoom(), pitch: found.getPitch(), bearing: found.getBearing(),
    center: found.getCenter(),
    extrusions: layers.filter((l) => l.type === 'fill-extrusion').map((l) => l.id),
    layerCount: layers.length,
    sampleLayers: layers.map((l) => `${l.id}:${l.type}`).filter((s) => /build|extru|3d/i.test(s)).slice(0, 20),
  };
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
