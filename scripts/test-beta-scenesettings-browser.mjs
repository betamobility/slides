// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Beta build: a scene's settings form, in the packaged editor.
//
//   npm run build:single --prefix slides && node scripts/test-beta-scenesettings-browser.mjs [--shots <dir>]
//
// WHAT THIS PROVES (2026-10-13-2236 plan, U10, R13). The rules are pinned in
// scripts/test-beta-scenesettings.ts; here the form is used as a person uses
// it, in the built editor, on a runtime library slide and on a library web
// scene:
//   1. the hint picks the control (a dropdown, a toggle, a slider with a number
//      field, two number fields for a position);
//   2. changing one value is one undoable edit, and nothing but the setting
//      changes (no geometry, no other setting);
//   3. a value past its range is held there and the form says so; a refused
//      one is not written and the form says why;
//   4. on a web scene only the address's query string changes: origin, path
//      and fragment stay, and a change that would make the address longer
//      than the shell keeps is refused in the form.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null

const props = [
  { key: 'place', label: 'Place', kind: 'text', default: 'Oslo' },
  { key: 'position', label: 'Position', kind: 'text', default: '59.9139, 10.7522', format: 'latlon' },
  { key: 'mode', label: 'Mode', kind: 'text', default: 'wide', format: 'select:wide|near' },
  { key: 'zoom', label: 'Zoom', kind: 'number', default: 5, format: 'range:2:9:1' },
  { key: 'grid', label: 'Grid', kind: 'number', default: 1, format: 'bool' },
]
const URL0 = 'https://slides.betamobility.ai/scenes/map/?zoom=4&theme=dark#top'
const view = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9" fill="#e6eef7"/></svg>'

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
const p = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
p.on('pageerror', (e) => errors.push(e.message))
p.on('dialog', (d) => { void d.accept() })
await p.goto(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href)
await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale'))
await p.evaluate(([props, URL0, view]) => {
  const d = JSON.parse(JSON.stringify(window.bento.doc))
  d.assets = { scene: '<!doctype html><p>scene</p><script>addEventListener("message",function(){});parent.postMessage({type:"bento:ready"},"*")</' + 'script>', still: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9" fill="#f5f3ee"/></svg>') }
  d.slides = [
    { id: 'rt', background: '#ffffff', elements: [{ id: 'still', type: 'image', x: 0, y: 0, w: 1280, h: 720, rotation: 0, opacity: 1, src: 'asset:still', fit: 'cover', radius: 0 }],
      runtime: { src: 'asset:scene', still: 'asset:still', steps: 2, props, values: { zoom: 6 }, library: { id: 'map', version: 1 } } },
    { id: 'web', background: '#ffffff', elements: [{ id: 'emb', type: 'embed', app: 'web', x: 240, y: 120, w: 800, h: 450, rotation: 0, opacity: 1, url: URL0, view, doc: { library: { id: 'map-web', version: 1 }, props } }] },
  ]
  window.bento.loadDoc(JSON.stringify(d))
}, [props, URL0, view])
await p.waitForTimeout(500)

const PANEL = '.ed-props'
const setting = (key) => p.locator(`${PANEL} [data-scene-setting="${key}"]`)
const rt = () => p.evaluate(() => window.bento.doc.slides[0].runtime)
const geometry = () => p.evaluate(() => JSON.stringify(window.bento.doc.slides.map((s) => s.elements.map((e) => [e.x, e.y, e.w, e.h]))))
// The panel redraws after a write, and again a moment later (measured: about
// 2.5 s on, with the autosave pass). A control touched in between belongs to a
// panel about to be replaced, so every step waits until the panel has been
// quiet for a while.
const settle = () => p.evaluate((panel) => new Promise((done) => {
  const root = document.querySelector(panel)
  let timer = setTimeout(finish, 900)
  const stop = setTimeout(finish, 6000)
  const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, 900) })
  mo.observe(root, { childList: true, subtree: true })
  function finish() { mo.disconnect(); clearTimeout(timer); clearTimeout(stop); done() }
}), PANEL)
const note = (key) => p.evaluate(([panel, key]) => {
  const c = document.querySelector(`${panel} [data-scene-setting="${key}"]`)
  const n = c?.closest('.ed-row')?.nextElementSibling
  return n && !n.hidden ? n.textContent : ''
}, [PANEL, key])
// Typed and left with Tab, as a person does: the browser then fires one change.
// (A synthetic change after fill() leaves the field "dirty", so the browser
// fires a second, real one at the next click: two writes, two undo steps.)
const type = async (loc, text) => { await loc.fill(text); await loc.press('Tab'); await settle() }
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const undo = async () => { await p.locator('.ed-stage-scale').click({ position: { x: 5, y: 5 } }).catch(() => {}); await p.keyboard.press('Escape'); await p.evaluate(() => window.bento.undo()); await settle() }

console.log('\nthe form on a runtime library slide')
await p.locator('.ed-sidebar .ed-thumb[data-index="0"]').click(); await settle()
ok(await p.locator(`${PANEL} .ed-scene-settings`).count() === 1, 'the panel shows the scene\'s settings form')
ok(await p.evaluate((panel) => {
  const tag = (k) => document.querySelector(`${panel} [data-scene-setting="${k}"]`)
  return tag('mode')?.tagName === 'SELECT' && tag('grid')?.type === 'checkbox' && tag('zoom')?.querySelector('input[type=range]') && tag('zoom')?.querySelector('input[type=number]') && tag('position')?.querySelectorAll('input[type=number]').length === 2 && tag('place')?.type === 'text'
}, PANEL), 'the hint picks the control: a dropdown, a toggle, a slider with a number, two numbers for a position, a text field')
ok(await p.evaluate((panel) => document.querySelector(`${panel} [data-scene-setting="zoom"] input[type=number]`).value, PANEL) === '6', 'it shows the chosen value, not the default')
if (shots) await p.locator(PANEL).screenshot({ path: `${shots}/u10-runtime-panel.png` })

const geo0 = await geometry()
await setting('mode').selectOption('near'); await settle()
let r = await rt()
ok(r.values.mode === 'near' && r.values.zoom === 6 && Object.keys(r.values).sort().join() === 'mode,zoom', `changing one value writes that value and nothing else (${JSON.stringify(r.values)})`)
ok((await geometry()) === geo0, 'and moves nothing')
await undo()
r = await rt()
ok(r.values.mode === undefined && r.values.zoom === 6, `one undo puts it back (${JSON.stringify(r.values)})`)

await p.locator('.ed-sidebar .ed-thumb[data-index="0"]').click(); await settle()
const zoomNum = setting('zoom').locator('input[type=number]')
await type(zoomNum, '12'); await settle()
r = await rt()
ok(r.values.zoom === 9, `a zoom past its range is held at the top (${r.values.zoom})`)
const held = await note('zoom')
ok(/9/.test(held) && /2/.test(held), `and the form says so ("${held}")`)

const lat = setting('position').locator('input').first()
await type(lat, '95'); await settle()
r = await rt()
ok(r.values.position === '90, 10.7522' && /90/.test(await note('position')), `a latitude off the globe is held at 90 and said (${r.values.position})`)

await setting('grid').uncheck(); await settle()
ok((await rt()).values.grid === 0, 'the toggle writes 0')

const place = setting('place')
await type(place, 'Bergen'); await settle()
ok((await rt()).values.place === 'Bergen', 'text is written')
await undo()
ok((await rt()).values.place === undefined, 'and a typed burst is one undo step')

console.log('\nthe form on a library web scene')
await p.locator('.ed-sidebar .ed-thumb[data-index="1"]').click(); await settle()
await p.locator('.ed-stage-scale [data-el-id="emb"]').click(); await settle()
ok(await p.locator(`${PANEL} .ed-scene-settings`).count() === 1, 'a selected library web scene shows its settings form')
ok(await p.evaluate((panel) => document.querySelector(`${panel} [data-scene-setting="zoom"] input[type=number]`)?.value, PANEL) === '4', 'its values come from the page address')
if (shots) await p.locator(PANEL).screenshot({ path: `${shots}/u10-web-panel.png` })
const url = () => p.evaluate(() => window.bento.doc.slides[1].elements[0].url)
const wzoom = setting('zoom').locator('input[type=number]')
await type(wzoom, '7'); await settle()
const u = new URL(await url()), b = new URL(URL0)
ok(u.searchParams.get('zoom') === '7' && u.searchParams.get('theme') === 'dark' && u.origin === b.origin && u.pathname === b.pathname && u.hash === b.hash, `only the query string changed (${await url()})`)
ok((await p.evaluate(() => JSON.stringify(window.bento.doc.slides[1].elements[0].doc))) === JSON.stringify({ library: { id: 'map-web', version: 1 }, props }), 'the scene\'s record is untouched')
await undo()
ok((await url()) === URL0, 'one undo puts the address back')
await p.locator('.ed-stage-scale [data-el-id="emb"]').click(); await settle()
const wplace = setting('place')
await type(wplace, 'x'.repeat(2100)); await settle()
ok((await url()) === URL0 && /too long/i.test(await note('place')), `a value that would make the address too long is refused in the form (${(await note('place')).slice(0, 60)})`)

ok(errors.length === 0, `no page error (${errors.join(' | ')})`)
await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
