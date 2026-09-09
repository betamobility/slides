// Why does the atlas crash inside the sandboxed embed frame? Two candidate
// causes: (a) the sandbox has no allow-same-origin, so the framed page has an
// opaque origin and localStorage throws — the atlas touches it in its theme
// pre-paint script; (b) something about the file:// parent. (b) is testable by
// serving the same frame from http, and the console text settles (a).
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
const msgs = [];
page.on('console', (m) => msgs.push(`[${m.type()}] ${m.text().slice(0, 220)}`));
page.on('pageerror', (e) => msgs.push(`[pageerror] ${e.message.slice(0, 220)}`));

// An https parent, framing exactly as the shell does.
await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  const f = document.createElement('iframe');
  f.sandbox = 'allow-scripts allow-forms';
  f.src = 'https://mobilitetsatlas.dk/en/kommune/aarhus';
  f.style.cssText = 'width:1100px;height:600px;border:0';
  document.body.innerHTML = '';
  document.body.appendChild(f);
});
await page.waitForTimeout(15_000);

const inner = await page.evaluate(() => {
  const f = document.querySelector('iframe');
  return { w: f.getBoundingClientRect().width };
});
console.log('parent https, sandbox without allow-same-origin →', JSON.stringify(inner));
for (const m of [...new Set(msgs)].slice(0, 25)) console.log(' ', m);

// And with allow-same-origin, to isolate the variable.
msgs.length = 0;
await page.evaluate(() => {
  const f = document.querySelector('iframe');
  f.sandbox = 'allow-scripts allow-forms allow-same-origin';
  f.src = f.src;
});
await page.waitForTimeout(15_000);
console.log('\nwith allow-same-origin:');
for (const m of [...new Set(msgs)].slice(0, 15)) console.log(' ', m);
await page.screenshot({ path: new URL('./shots/embed-same-origin.png', import.meta.url).pathname.replace(/%20/g, ' ') });
await browser.close();
