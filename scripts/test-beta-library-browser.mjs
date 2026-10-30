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
import { captureStill, capturedScenes } from './lib/beta-library-still.mjs'
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

// ---- the R8 scenes (kpi-row, timeline, before-after, annotated-bars) ----
// They draw into <svg id="scene"> by arithmetic, and their still is that
// drawing of their defaults, captured (scripts/build-beta-library-stills.mjs).
const captured = capturedScenes(join(root, 'beta/library'))

/** What the drawing says, read off the svg. */
const reading = (p) => p.evaluate(() => {
  const svg = document.getElementById('scene')
  const texts = [...svg.querySelectorAll('text')]
  const w = window.innerWidth, h = window.innerHeight
  return {
    nodes: svg.querySelectorAll('*').length, label: svg.getAttribute('aria-label') ?? '', viewBox: svg.getAttribute('viewBox'),
    words: texts.map((t) => t.textContent).join(' | '), fonts: texts.every((t) => t.hasAttribute('font-family') || !!t.closest('[font-family]')),
    off: texts.filter((t) => { const b = t.getBoundingClientRect(); return b.width > 0 && (b.left < -1 || b.right > w + 1 || b.top < -1 || b.bottom > h + 1) }).map((t) => t.textContent),
    attrs: [...svg.querySelectorAll('*')].flatMap((n) => [...n.attributes].map((a) => a.value)).join(' '),
    markup: document.querySelectorAll('img, image, iframe, foreignObject, script:not(:first-of-type)').length,
  }
})

console.log('\nthe R8 scenes: captured stills, every preset and step, settings as data')
ok(['annotated-bars', 'before-after', 'kpi-row', 'timeline'].every((id) => captured.includes(id)), `the four R8 scenes are captured scenes (${captured.join(', ')})`)
for (const id of captured) {
  const s = scene(id)
  // the committed still is the scene's own drawing of its defaults
  const cp = await ctx.newPage()
  const fresh = await captureStill(cp, s.html)
  await cp.close()
  ok(fresh === readFileSync(join(root, 'beta/library', id, 'still.svg'), 'utf8'), `${id}: still.svg is what the page draws with its defaults (else run node scripts/build-beta-library-stills.mjs ${id})`)

  const { p, errors, say, init } = await open(s)
  let r = await reading(p)
  ok(r.nodes > 5 && r.fonts && r.label.includes(defaults(s).title), `${id}: before it is told anything it draws its defaults, every text naming its font (${r.nodes} nodes)`)
  for (const preset of s.presets) for (let step = 0; step < Math.max(1, s.steps); step++) {
    for (const size of [{ width: 1280, height: 720 }, { width: 1024, height: 768 }]) {
      await p.setViewportSize(size)
      await init(preset.values, { step })
      r = await reading(p)
      ok(r.nodes > 5 && !/NaN|undefined|Infinity|null/.test(r.words + r.attrs) && r.off.length === 0,
        `${id}: preset "${preset.name}", step ${step}, ${size.width}x${size.height}: draws, and no text leaves the picture (${r.off.join(' / ') || r.nodes + ' nodes'})`)
    }
  }
  await p.setViewportSize({ width: 1280, height: 720 })
  // a setting changed while it shows
  await init()
  await say({ type: 'bento:props', values: { title: 'A title set in the panel' } })
  r = await reading(p)
  ok(r.words.includes('A title set in the panel') && !r.words.includes(defaults(s).title), `${id}: bento:props redraws with the new value`)
  // settings are data: every free text setting carries markup, every colour a URL
  const hostile = Object.fromEntries(s.props.map((q) => [q.key, q.kind === 'text' && !q.format ? '<img src=x onerror="document.title=\'pwn\'"><b>b</b>' : q.kind === 'color' ? 'url(https://evil.test/a.png)' : q.default]))
  await init(hostile)
  await p.waitForTimeout(100)
  r = await reading(p)
  ok(r.markup === 0 && await p.evaluate(() => document.title !== 'pwn') && r.words.includes('<img'), `${id}: markup in a setting is shown as text, not built`)
  ok(!/url\s*\(/i.test(r.attrs), `${id}: a colour that names a URL is not used`)
  // garbage in every setting still draws
  await init(Object.fromEntries(s.props.map((q) => [q.key, q.kind === 'number' ? Number.NaN : q.kind === 'color' ? '' : 'x'.repeat(4000)])))
  r = await reading(p)
  ok(r.nodes > 3 && !/NaN|Infinity/.test(r.attrs) && r.off.length === 0, `${id}: settings that are not numbers, or 4000 characters long, still draw inside the picture (${r.off.map((t) => t.slice(0, 30)).join(" / ") || "none"} off)`)
  // with motion the entrance runs (on arrival, or for a scene that steps, on
  // the step forward) and lands on the same drawing as without
  const last = Math.max(0, s.steps - 1)
  await init({}, { step: last })
  const settled = (await reading(p)).attrs
  const arrive = async () => {
    if (s.steps > 1 && id === 'before-after') { await init({}, { step: last - 1, reduceMotion: false }); await say({ type: 'bento:step', index: last }) } else await init({}, { step: last, reduceMotion: false })
    await p.waitForTimeout(80)
  }
  await arrive()
  const moving = (await reading(p)).attrs
  await p.waitForTimeout(2000)
  ok(moving !== settled && (await reading(p)).attrs === settled, `${id}: with motion an entrance plays, and lands where the reduced drawing is`)
  await arrive()
  await say({ type: 'bento:motion', reduce: true })
  ok((await reading(p)).attrs === settled, `${id}: motion switched off mid-entrance lands at once`)
  ok(errors.length === 0, `${id}: no error (${errors.join(' | ')})`)
  await p.close()
}

{
  const s = scene('kpi-row')
  const { p, init } = await open(s)
  const rules = () => p.evaluate(() => document.querySelectorAll('#scene line[stroke-width="4"]').length)
  await init({ count: 4 }); const four = await rules()
  await init({ count: 2 }); const two = await rules()
  ok(four === 4 && two === 2, `kpi-row: the count sets how many figures (${four}, ${two})`)
  const tone = async (delta, trend) => { await init({ count: 2, k1Delta: delta, k1Trend: trend }); return p.evaluate(() => document.querySelector('#scene g text[font-size="30"][font-family*="DM Mono"]')?.getAttribute('fill')) }
  const tones = [await tone('+5 %', 'up is good'), await tone('+5 %', 'down is good'), await tone('−5 %', 'down is good'), await tone('-5 %', 'up is good'), await tone('+5 %', 'neutral'), await tone('5 %', 'up is good')]
  ok(tones.join() === '#1F7A1F,#B42318,#1F7A1F,#B42318,#666666,#666666',
    `kpi-row: a change is --color-positive the good way, --color-negative the other, --beta-muted when neutral or unsigned (${tones})`)
  await init({ k1Delta: '', k2Delta: '', k3Delta: '' })
  ok(await p.evaluate(() => document.querySelectorAll('#scene path').length) === 0 && !(await reading(p)).words.includes('vs. the year before'), 'kpi-row: with no change there is no arrow and no note')
  await p.close()
}
{
  const s = scene('timeline')
  const { p, init } = await open(s)
  const xs = () => p.evaluate(() => [...document.querySelectorAll('#scene circle[r="11"]')].map((c) => Number(c.getAttribute('cx'))))
  await init()
  let x = await xs()
  ok(x.length === 5 && (await reading(p)).words.includes('Today'), `timeline: five milestones and the today marker by default (${x.length})`)
  // 2025-01, 2025-06, 2025-11, 2026-04, 2027-01: five months apart, then nine
  ok(Math.abs((x[1] - x[0]) / (x[2] - x[1]) - 1) < 0.05 && Math.abs((x[4] - x[3]) / (x[3] - x[2]) - 1.8) < 0.1, `timeline: dates are placed in proportion to time (${x.join(', ')})`)
  const filled = await p.evaluate(() => [...document.querySelectorAll('#scene circle[r="11"]')].map((c) => c.getAttribute('fill') !== '#FFFFFF'))
  ok(filled.join() === 'true,true,true,false,false', `timeline: milestones up to today are filled, later ones hollow (${filled})`)
  await init(s.presets.find((q) => q.name.startsWith('Phases')).values)
  x = await xs()
  const gaps = x.slice(1).map((v, i) => Math.round(v - x[i]))
  ok(new Set(gaps).size === 1 && !(await reading(p)).words.includes('Today'), `timeline: phase names space the milestones evenly and leave the marker out (${gaps})`)
  await init({ m1Date: '2027', m2Date: '2025-03', m3Date: 'Q3 2025', m4Date: '2026 Q1', m5Date: '2025-03-15' })
  x = await xs()
  const order = await p.evaluate(() => [...document.querySelectorAll('#scene text[font-size="24"]')].map((t) => t.textContent).filter((t) => /\d/.test(t)))
  ok(x.every((v, i) => i === 0 || v > x[i - 1]) && order.join() === '2025-03,2025-03-15,Q3 2025,2026 Q1,2027', `timeline: every date form reads, in time order whatever order they are written in (${order})`)
  await init({ m6Date: '2027-06', m6Label: 'Six', today: '' })
  ok((await xs()).length === 6 && !(await reading(p)).words.includes('Today'), 'timeline: a sixth milestone shows, and an empty today removes the marker')
  await p.close()
}
{
  const s = scene('before-after')
  const { p, say, init } = await open(s)
  await init({}, { step: 0 })
  let w = (await reading(p)).words
  ok(w.includes('38 min') && !w.includes('24 min') && !w.includes('37'), 'before-after: step 0 shows the before figure, not the after one or the change')
  await say({ type: 'bento:step', index: 1 })
  await p.waitForTimeout(50)
  w = (await reading(p)).words
  ok(w.includes('24 min') && w.includes('−37 %'), 'before-after: step 1 brings in the after figure and the change')
  await say({ type: 'bento:step', index: 0 })
  ok(!(await reading(p)).words.includes('24 min'), 'before-after: stepping back hides them again')
  const bars = () => p.evaluate(() => [...document.querySelectorAll('#scene rect[height="28"]')].map((r) => Number(r.getAttribute('width'))))
  await init({}, { step: 1 })
  const b = await bars()
  ok(b.length === 2 && Math.abs(b[1] / b[0] - 24 / 38) < 0.01, `before-after: the two bars share one scale (${b})`)
  await init({ beforeAmount: 0 }, { step: 1 })
  ok((await bars()).length === 0, 'before-after: an amount of 0 leaves the bars out')
  await init({ changeTone: 'bad' }, { step: 1 })
  ok(await p.evaluate(() => [...document.querySelectorAll('#scene text')].find((t) => t.textContent === '−37 %')?.getAttribute('fill')) === '#B42318', 'before-after: a bad change is drawn in --color-negative')
  await p.close()
}
{
  const s = scene('annotated-bars')
  const { p, say, init } = await open(s)
  const bars = () => p.evaluate(() => [...document.querySelectorAll('#scene rect')].slice(1).map((r) => ({ h: Number(r.getAttribute('height')), y: Number(r.getAttribute('y')), fill: r.getAttribute('fill') })))
  await init({}, { step: 0 })
  let b = await bars()
  ok(b.length === 7 && b.every((x) => x.fill === '#0F2A4A') && !(await reading(p)).words.includes('Pandemic'), 'annotated-bars: step 0 draws the seven bars, none picked out, and no callout')
  await say({ type: 'bento:step', index: 1 })
  await p.waitForTimeout(50)
  b = await bars()
  ok(b[1].fill === '#E4572E' && b[6].fill === '#E4572E' && b.filter((x) => x.fill === '#E4572E').length === 2 && (await reading(p)).words.includes('Pandemic'), 'annotated-bars: step 1 picks out the two bars the callouts name, and shows the callouts')
  await init({ values: '12,5; 12.5; 25', labels: 'a; b; c', note1Bar: 0, note2Bar: 0 }, { step: 1 })
  b = await bars()
  ok(b.length === 3 && b[0].h === b[1].h && Math.abs(b[2].h / b[0].h - 2) < 0.01, `annotated-bars: "12,5" and "12.5" read as the same number, on one scale (${b.map((x) => x.h)})`)
  await init({ values: '10; -5; 20', labels: 'a; b; c', note1Bar: 2, note2Bar: 9 }, { step: 1 })
  b = await bars()
  const words = (await reading(p)).words
  ok(b.length === 3 && b[1].y >= b[0].y + b[0].h - 1 && words.includes('Pandemic') && !words.includes('New timetable'), 'annotated-bars: a negative value hangs below zero, and a callout naming a bar that is not there is left out')
  await init({ values: Array.from({ length: 20 }, (_, i) => i + 1).join('; ') }, { step: 1 })
  ok((await bars()).length === 12, 'annotated-bars: at most twelve bars')
  await p.close()
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
  const word = { counter: 'trips this year', map: 'Oslo' }[s.id] ?? defaults(s).title
  ok(info.words.includes(word), `${s.id}: the still shows what the scene shows by default ("${word}")`)
  await p.close()
}

ok(requests.length === 0, `no scene made a request to anywhere (${requests.slice(0, 3).join(', ')})`)
await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
