// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Beta build: the library's seed scenes, run in a browser.
//
//   node scripts/test-beta-library-browser.mjs
//
// WHAT THIS PROVES (2026-10-13-2236 plan, U8). scripts/test-beta-library.ts
// checks what the build accepts; it cannot say that a scene WORKS. A scene is
// copied into decks, so a fault in one is a fault in every deck that took it.
// Each scene in beta/library/ is checked two ways:
//   in a sandboxed frame, as the shell mounts it (no same-origin): it says
//     bento:ready, forwards the arrow keys as bento:navigate, and reaches
//     nothing on the network;
//   as a page, so its drawing can be read: it draws its defaults before it is
//     told anything, takes bento:init, bento:props, bento:step and
//     bento:motion, draws every preset, and treats every setting as DATA: a
//     setting with markup in it shows as text, and a colour that names a URL
//     is not used.
// And each still is a picture that looks like its scene: every text in it
// names its font itself (a still is drawn as an image, where no stylesheet
// reaches it).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildManifest } from './lib/beta-library.mjs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = buildManifest(join(root, 'beta/library'))
const scene = (id) => manifest.scenes.find((s) => s.id === id)
const defaults = (s) => Object.fromEntries(s.props.map((p) => [p.key, p.default]))

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
// nothing a scene does may leave the page: every request that is not the page itself is recorded and refused
const requests = []
await ctx.route('**/*', (r) => { const u = r.request().url(); if (/^(about:|data:|blob:)/.test(u) || u.startsWith('http://scene.test/')) return r.fulfill({ status: 200, contentType: 'text/html', body: '' }); requests.push(u); return r.abort() })

/** The scene as a page of its own, with a way to say what the shell says. */
async function open(s, size = { width: 1280, height: 720 }) {
  const p = await ctx.newPage()
  await p.setViewportSize(size)
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await p.setContent(s.html, { waitUntil: 'load' })
  const say = (data) => p.evaluate((d) => window.dispatchEvent(new MessageEvent('message', { source: window.parent, data: d })), data)
  const init = (props = {}, extra = {}) => say({ type: 'bento:init', step: 0, steps: s.steps, props: { ...defaults(s), ...props }, reduceMotion: true, ...extra })
  return { p, errors, say, init }
}

console.log('\nin a sandboxed frame, as the shell mounts a scene')
for (const s of manifest.scenes) {
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.setContent('<!doctype html><body></body>')
  await p.evaluate((html) => {
    window.__got = []
    window.addEventListener('message', (e) => { if (e.source === document.querySelector('iframe')?.contentWindow) window.__got.push(e.data) })
    const f = document.createElement('iframe')
    f.setAttribute('sandbox', 'allow-scripts allow-forms')
    f.style.cssText = 'width:1280px;height:720px;border:0'
    f.srcdoc = html
    document.body.appendChild(f)
  }, s.html)
  await p.waitForFunction(() => window.__got.some((m) => m && m.type === 'bento:ready'), null, { timeout: 5000 }).catch(() => {})
  const got = await p.evaluate(() => window.__got)
  ok(got.length === 1 && got[0].type === 'bento:ready', `${s.id}: says bento:ready once, and nothing else unasked (${JSON.stringify(got)})`)
  await p.evaluate((props) => document.querySelector('iframe').contentWindow.postMessage({ type: 'bento:init', step: 0, steps: 2, props, reduceMotion: true }, '*'), defaults(s))
  await p.locator('iframe').click()
  for (const key of ['ArrowRight', 'ArrowLeft', 'Escape']) await p.keyboard.press(key)
  await p.waitForTimeout(150)
  const nav = (await p.evaluate(() => window.__got)).filter((m) => m.type === 'bento:navigate').map((m) => m.dir)
  ok(nav.join(',') === 'next,prev,exit', `${s.id}: keys pressed inside the frame are forwarded as bento:navigate (${nav})`)
  ok(errors.length === 0, `${s.id}: no error in the frame (${errors.join(' | ')})`)
  await p.close()
}

console.log('\nthe counter')
{
  const s = scene('counter')
  const { p, errors, say, init } = await open(s)
  const text = () => p.evaluate(() => document.getElementById('n').textContent.replace(/\u202f/g, ' '))
  ok((await text()) === '0', `before it is told anything it shows where it counts from (${await text()})`)
  await init()
  ok((await text()) === '1 250 000' && await p.evaluate(() => document.getElementById('l').textContent) === 'trips this year', `initialised with motion reduced it shows the number at once (${await text()})`)
  await init({}, { reduceMotion: false })
  await p.waitForTimeout(300)
  const mid = await text()
  await p.waitForTimeout(2300)
  ok(mid !== '1 250 000' && mid !== '0' && (await text()) === '1 250 000', `with motion it counts up and lands on the number (${mid} on the way)`)
  await init({}, { reduceMotion: false }); await p.waitForTimeout(200)
  const before = await text()
  await say({ type: 'bento:step', index: 0 }); await p.waitForTimeout(60)
  const after = await text()
  ok(Number(after.replace(/ /g, '')) >= Number(before.replace(/ /g, '')), `a bento:step does not restart a count under way (${before} then ${after})`)
  await say({ type: 'bento:motion', reduce: true })
  ok((await text()) === '1 250 000', 'motion switched off mid-count lands on the number')
  for (const preset of s.presets) {
    await init(preset.values)
    const t = await text()
    ok(t.length > 0 && !/NaN|undefined|null/.test(t), `preset "${preset.name}" draws (${t})`)
  }
  await init({ to: 87.5, unit: '%', decimals: 1 })
  ok((await text()) === '87,5 %', `a decimal and a unit (${await text()})`)
  await init({ from: 500, to: 20 })
  ok((await text()) === '20', 'counting down ends on the lower number')
  await init({ to: 1250000000000 })
  const fit = await p.evaluate(() => { const r = document.getElementById('n').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), window.innerWidth] })
  ok(fit[0] >= 0 && fit[1] <= fit[2], `thirteen digits are made smaller, not cut off (${fit[0]} to ${fit[1]} of ${fit[2]})`)
  for (const [props, what] of [[{ to: Number.NaN }, 'not a number'], [{ decimals: 99 }, 'too many decimals'], [{ decimals: -3 }, 'negative decimals'], [{ seconds: -1 }, 'negative seconds'], [{ to: 1e308 }, 'a huge number'], [{ grouped: 0 }, 'ungrouped']]) {
    await init(props)
    ok(!/NaN|undefined|Infinity/.test(await text()), `a setting that is ${what} still draws a number (${(await text()).slice(0, 24)})`)
  }
  // settings are data
  await init({ label: '<img src=x onerror="document.title=\'pwn\'"><b>bold</b>', unit: '<script>document.title="pwn"</' + 'script>', accent: 'url(https://evil.test/a.png)', background: 'red;background-image:url(https://evil.test/b.png)' })
  await p.waitForTimeout(150)
  ok(await p.evaluate(() => document.querySelectorAll('img, b, script:not(:first-of-type)').length === 0 && document.title !== 'pwn' && document.getElementById('l').textContent.includes('<img')), 'markup in a setting is shown as text, not built')
  ok(await p.evaluate(() => !/url/i.test(document.body.getAttribute('style') || '') && !/url/i.test(document.getElementById('n').getAttribute('style') || '')), 'a colour that names a URL is not used')
  ok(errors.length === 0, `no error (${errors.join(' | ')})`)
  await p.close()
}

console.log('\nthe map')
{
  const s = scene('map')
  const { p, errors, say, init } = await open(s)
  const read = () => p.evaluate(() => {
    const svg = document.getElementById('m')
    const texts = [...svg.querySelectorAll('text')]
    return { label: svg.getAttribute('aria-label'), nodes: svg.querySelectorAll('*').length, viewBox: svg.getAttribute('viewBox'), place: texts.at(-2)?.textContent, coords: texts.at(-1)?.textContent,
      lines: svg.querySelectorAll('line').length, fonts: texts.every((t) => !!t.closest('[font-family]')), marker: svg.querySelectorAll('circle')[1]?.getAttribute('fill') }
  })
  let r = await read()
  ok(r.place === 'Oslo' && /59\.91°N/.test(r.coords) && r.lines > 4, `before it is told anything it draws its defaults (${r.place}, ${r.coords}, ${r.lines} grid lines)`)
  ok(r.fonts, 'every text names its font itself: the still is this drawing, and an image has no stylesheet')
  await init()
  const wide = (await read()).lines
  await say({ type: 'bento:step', index: 1 })
  await p.waitForTimeout(80)
  const near = await p.evaluate(() => [...document.querySelectorAll('#m g text')].map((t) => t.textContent).join(' '))
  await say({ type: 'bento:step', index: 0 })
  const far = await p.evaluate(() => [...document.querySelectorAll('#m g text')].map((t) => t.textContent).join(' '))
  ok(near !== far && wide > 0, 'the step changes the view (with motion reduced, at once)')
  for (const preset of s.presets) {
    await init(preset.values)
    r = await read()
    ok(r.place === (preset.values.place ?? 'Oslo') && !/NaN/.test(r.coords), `preset "${preset.name}" draws (${r.place}, ${r.coords})`)
  }
  for (let zoom = 1; zoom <= 9; zoom++) for (const step of [0, 1]) {
    await init({ zoom }, { step })
    r = await read()
    if (r.nodes > 200 || !/^\d/.test(r.coords)) ok(false, `zoom ${zoom} step ${step}: ${r.nodes} nodes, ${r.coords}`)
  }
  ok(true, 'every zoom from 1 to 9, wide and stepped in, draws a bounded number of nodes')
  await init({ zoom: 1 }, { step: 0 }); const z0 = await p.evaluate(() => document.querySelectorAll('#m line').length)
  await init({ zoom: 1 }, { step: 1 }); const z1 = await p.evaluate(() => [...document.querySelectorAll('#m g text')].map((t) => t.textContent).join(' '))
  await init({ zoom: 1 }, { step: 0 }); const z2 = await p.evaluate(() => [...document.querySelectorAll('#m g text')].map((t) => t.textContent).join(' '))
  ok(z0 > 0 && z1 !== z2, 'a zoom below the range is held at 2, so the step is never a dead press')
  for (const [position, want] of [['59,9139, 10,7522', /59\.91°N\s+10\.75°E/], ['55.6761;12.5683', /55\.68°N\s+12\.57°E/], ['-33.87,151.21', /33\.87°S\s+151\.21°E/], ['abc', /0°\s+0°/], ['91, 181', /85°N\s+180°E/], ['1e9, -1e9', /85°N\s+180°W/], ['', /0°\s+0°/]]) {
    await init({ position })
    r = await read()
    ok(want.test(r.coords) && r.nodes < 200, `position ${JSON.stringify(position)} reads as ${r.coords}`)
  }
  await init({ position: '89.9, 179.9', zoom: 9 }); r = await read()
  ok(r.nodes < 200 && !/NaN/.test(r.coords), `at the pole and the antimeridian it still draws (${r.nodes} nodes)`)
  await init({ grid: 0 }); r = await read()
  ok(r.lines === 0 && r.place === 'Oslo', 'the grid can be switched off')
  // settings are data
  await init({ place: '<img src=x onerror="document.title=\'pwn\'">', accent: 'url(https://evil.test/a.png)', background: 'url(https://evil.test/b.png)', position: '<svg onload=alert(1)>' })
  await p.waitForTimeout(150)
  r = await read()
  ok(r.place.includes('<img') && await p.evaluate(() => document.querySelectorAll('img, image, script:not(:first-of-type)').length === 0 && document.title !== 'pwn'), 'markup in a setting is shown as text, not built')
  ok(r.marker === '#C2410C' && await p.evaluate(() => document.querySelector('#m rect').getAttribute('fill')) === '#F5F3EE', 'a colour that names a URL falls back to the scene\'s own')
  ok(errors.length === 0, `no error (${errors.join(' | ')})`)
  await p.close()

  // a 4:3 deck: the drawing follows the frame, and nothing is cut off
  const four = await open(s, { width: 1024, height: 768 })
  await four.init()
  const off = await four.p.evaluate(() => {
    const w = window.innerWidth, h = window.innerHeight
    return [...document.querySelectorAll('#m text')].filter((t) => { const b = t.getBoundingClientRect(); return b.right < 0 || b.left > w || b.bottom < 0 || b.top > h }).length
  })
  ok(off === 0 && (await four.p.evaluate(() => document.getElementById('m').getAttribute('viewBox'))) === '0 0 1600 1200', `in a 4:3 frame no label is off the picture (${off} off)`)
  await four.p.close()
}

console.log('\nthe stills')
for (const s of manifest.scenes) {
  const p = await ctx.newPage()
  await p.setContent(`<!doctype html><body style="margin:0"><img id="i" style="width:1280px;height:720px"></body>`)
  const still = readFileSync(join(root, 'beta/library', s.id, 'still.svg'), 'utf8')
  const info = await p.evaluate(async (svg) => {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const texts = [...doc.querySelectorAll('text')]
    const img = document.getElementById('i')
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    await img.decode().catch(() => {})
    return { parses: !doc.querySelector('parsererror'), texts: texts.length, fonts: texts.every((t) => !!t.closest('[font-family]')), drawn: img.naturalWidth > 0, words: texts.map((t) => t.textContent).join(' ') }
  }, still)
  ok(info.parses && info.drawn, `${s.id}: the still is well-formed and draws as an image`)
  ok(info.texts > 0 && info.fonts, `${s.id}: every text in the still names its font (${info.texts} texts)`)
  const word = s.id === 'map' ? 'Oslo' : 'trips this year'
  ok(info.words.includes(word), `${s.id}: the still shows what the scene shows by default ("${word}")`)
  await p.close()
}

ok(requests.length === 0, `no scene made a request to anywhere (${requests.slice(0, 3).join(', ')})`)
await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
