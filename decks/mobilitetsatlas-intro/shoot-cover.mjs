// Cover artwork: the national Danmarkskort from /en/start, on the grade beat
// (slide 3 of the intro scroll) so the A–G choropleth is what the map paints.
// The story is scroll-driven, so the beat is reached by scrolling, not a URL.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./view-cover.jpeg', import.meta.url));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 560 }, deviceScaleFactor: 2 });
await page.goto('https://mobilitetsatlas.dk/en/start', { waitUntil: 'domcontentloaded', timeout: 90_000 });
const decline = page.getByRole('button', { name: /Decline|Afvis/ });
if (await decline.count()) await decline.first().click().catch(() => {});
await page.waitForSelector('canvas', { timeout: 60_000 });
await page.waitForTimeout(8000);

// Walk into the mærke beat: three viewport-heights of scroll, settling between
// so each beat's camera and paint finish before the next nudge.
for (let i = 0; i < 3; i++) {
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(1800);
}
await page.waitForTimeout(9000);

await page.screenshot({ path: OUT, type: 'jpeg', quality: 88 });
console.log('wrote', OUT);
await browser.close();
