// What does the Aarhus detail map actually fetch, and with what token? Needed
// to rebuild that map as a standalone page with no site chrome around it.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const seen = new Set();
page.on('request', (r) => {
  const u = r.url();
  if (/\.(geojson|json)(\?|$)/.test(u) || /mapbox/.test(u)) {
    const key = u.split('?')[0];
    if (!seen.has(key)) { seen.add(key); console.log(r.method(), u.slice(0, 190)); }
  }
});
await page.goto('https://mobilitetsatlas.dk/en/kommune/aarhus', { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForTimeout(14_000);

const tok = await page.evaluate(() => {
  const hit = performance.getEntriesByType('resource')
    .map((e) => e.name).find((n) => n.includes('access_token='));
  return hit ? hit.split('access_token=')[1].split('&')[0].slice(0, 12) + '…' : null;
});
console.log('\nmapbox token present:', !!tok, tok || '');
await browser.close();
