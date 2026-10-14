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

// Exercise the actual panel and Store in an isolated browser page. U11 has
// not shipped yet, so the packaged editor has no way to populate the library
// cache. Bundle the source modules in memory to call rememberPresets, without
// adding a testing API to the product or replacing any production callback.
const { build } = await import('../slides/node_modules/esbuild/lib/main.js')
const { fileURLToPath } = await import('node:url')
const harness = await build({
  stdin: {
    contents: `export { PropsPanel } from './slides/src/editor/panels.ts';
      export { Store } from './slides/src/store.ts';
      export { newDoc } from './slides/src/model.ts';
      export { rememberPresets } from './slides/src/beta/scenesettings.ts';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
  },
  bundle: true, platform: 'browser', format: 'iife', globalName: 'U10', write: false,
})
const probe = await browser.newPage()
probe.on('pageerror', (e) => errors.push(e.message))
await probe.setContent('<div class="ed-props"></div><button id="outside">Outside</button>')
await probe.addScriptTag({ content: harness.outputFiles[0].text })
const mount = async (kind, testProps, values, presets, address = URL0) => {
  await probe.evaluate(({ kind, props, values, presets, address }) => {
    const doc = U10.newDoc()
    const slide = doc.slides[0]
    slide.id = 'independent-' + kind
    const library = { id: 'independent-' + kind, version: 1 }
    if (kind === 'runtime') {
      slide.runtime = { steps: 0, props, values, library }
    } else {
      slide.elements = [{ id: 'independent-embed', type: 'embed', app: 'web', live: true,
        x: 40, y: 50, w: 640, h: 360, opacity: 1, rotation: 0,
        url: address, doc: { library, props }, view: '<svg xmlns="http://www.w3.org/2000/svg"/>' }]
    }
    U10.rememberPresets({ scenes: [{ id: library.id, presets }] })
    const host = document.createElement('div')
    host.className = 'ed-props'
    document.querySelector('.ed-props').replaceWith(host)
    const store = new U10.Store(doc)
    if (kind === 'web') store.selection = ['independent-embed']
    window.independent = { store, panel: new U10.PropsPanel(host, store) }
  }, { kind, props: testProps, values, presets, address })
}
const probeSetting = (key) => probe.locator(`[data-scene-setting="${key}"]`)
const probePreset = () => probe.locator('[data-scene-preset]')
const probeSnapshot = () => probe.evaluate(() => JSON.parse(JSON.stringify(independent.store.doc.slides[0])))
const probeType = async (field, value) => {
  await field.fill(value)
  await field.press('Tab')
  await probe.waitForTimeout(50) // focusout's deferred panel rebuild
}

console.log('\nU10 independent adversarial browser regressions')
await mount('runtime', props, { zoom: 6 }, [{ name: 'Bergen', values: { place: 'Bergen', zoom: 8, extra: 'discard' } }])
const beforePreset = await probeSnapshot()
await probePreset().selectOption('Bergen')
const afterPreset = await probeSnapshot()
await probe.evaluate(() => independent.store.undo())
const undonePreset = await probeSnapshot()
await probe.evaluate(() => independent.store.redo())
const redonePreset = await probeSnapshot()
ok(JSON.stringify(afterPreset.runtime.values) === JSON.stringify({ place: 'Bergen', position: '59.9139, 10.7522', mode: 'wide', zoom: 8, grid: 1 })
  && JSON.stringify(afterPreset.elements) === JSON.stringify(beforePreset.elements)
  && JSON.stringify(undonePreset) === JSON.stringify(beforePreset)
  && JSON.stringify(redonePreset) === JSON.stringify(afterPreset),
  'U10 independent: preset sets exactly declared keys, leaves geometry, and is one undo/redo step')

await mount('web', props, {}, [], URL0)
await probeSetting('place').fill('Bergen')
const remoteUrl = 'https://slides.betamobility.ai/scenes/revised/?zoom=8&place=Remote&theme=light#remote'
await probe.evaluate((url) => {
  independent.store.slide.elements[0].url = url
  independent.store.emit('doc') // remote mutation: no local undo checkpoint
}, remoteUrl)
await probeSetting('place').press('Tab')
await probe.waitForTimeout(50)
const afterRemote = await probeSnapshot()
await probe.evaluate(() => independent.store.undo())
const undoRemote = await probeSnapshot()
await probe.evaluate(() => independent.store.redo())
const redoRemote = await probeSnapshot()
const remoteWritten = new URL(afterRemote.elements[0].url), remoteBase = new URL(remoteUrl)
ok(remoteWritten.pathname === remoteBase.pathname && remoteWritten.origin === remoteBase.origin
  && remoteWritten.hash === remoteBase.hash && remoteWritten.searchParams.get('zoom') === '8'
  && remoteWritten.searchParams.get('theme') === 'light' && remoteWritten.searchParams.get('place') === 'Bergen'
  && undoRemote.elements[0].url === remoteUrl && redoRemote.elements[0].url === afterRemote.elements[0].url,
  'U10 independent: focused web edit retains remote address and siblings through one undo/redo')

const textProps = [
  { key: 'a', label: 'A', kind: 'text', default: '' },
  { key: 'b', label: 'B', kind: 'text', default: '' },
]
await mount('web', textProps, {}, [{ name: 'Oversized', values: { a: 'x'.repeat(2100) } }])
await probePreset().selectOption('Oversized')
const refusedPreset = await probeSnapshot()
const refusal = await probe.locator('.ed-scene-settings').innerText()
ok(refusedPreset.elements[0].url === URL0 && /too long/i.test(refusal)
  && await probePreset().inputValue() !== 'Oversized',
  `U10 independent: oversized web preset refuses visibly and does not claim it is active (message=${JSON.stringify(refusal)})`)

// Final URL is well below 2048. Only the transient combination (new a + old
// b) exceeds it. A preset is one atomic edit, so intermediate order must not
// decide whether it can be applied.
const longOld = 'https://slides.betamobility.ai/scenes/map/?a=&b=' + 'y'.repeat(1200)
await mount('web', textProps, {}, [{ name: 'Swap', values: { a: 'x'.repeat(1200), b: '' } }], longOld)
await probePreset().selectOption('Swap')
const swapped = new URL((await probeSnapshot()).elements[0].url)
ok(swapped.href.length < 2048 && swapped.searchParams.get('a') === 'x'.repeat(1200) && swapped.searchParams.get('b') === '',
  `U10 independent: web preset checks final URL size, not temporary key order (a=${swapped.searchParams.get('a')?.length}, b=${swapped.searchParams.get('b')?.length})`)

await mount('runtime', [{ key: 'n', label: 'N', kind: 'number', default: 0, format: 'range:0:10:3' }], {}, [])
await probeType(probeSetting('n').locator('input[type=number]'), '10.1')
const clamped = (await probeSnapshot()).runtime.values.n
const shown = await probeSetting('n').locator('input[type=number]').inputValue()
ok(clamped === 10 && shown === '10' && /Held at 10/.test(await probe.locator('.ed-scene-settings').innerText()),
  `U10 independent: uneven-step upper clamp is stored and shown (stored=${clamped}, shown=${shown})`)
// Round 3: the picker callback must use the actual value returned on
// refusal. A successful colour change is covered separately, including undo.
const colorProps = [{ key: 'accent', label: 'Accent', kind: 'color', default: '#ff0000' }]
await mount('runtime', colorProps, { accent: '#ff0000' }, [])
const beforeColor = await probeSnapshot()
await probeSetting('accent').focus()
await probeSetting('accent').evaluate((el) => {
  el.value = '#00ff00'
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
})
const afterColor = await probeSnapshot()
await probe.evaluate(() => independent.store.undo())
const undoColor = await probeSnapshot()
await probe.evaluate(() => independent.store.redo())
const redoColor = await probeSnapshot()
ok(afterColor.runtime.values.accent === '#00ff00'
  && JSON.stringify(afterColor.elements) === JSON.stringify(beforeColor.elements)
  && JSON.stringify(undoColor) === JSON.stringify(beforeColor)
  && JSON.stringify(redoColor) === JSON.stringify(afterColor),
  'U10 round 3: colour picker input/change is one undoable edit and preserves geometry')

const colorPrefix = 'https://example.test/?accent=%23f00&pad='
const fullColorUrl = colorPrefix + 'x'.repeat(2048 - colorPrefix.length)
await mount('web', colorProps, {}, [], fullColorUrl)
await probeSetting('accent').focus()
await probeSetting('accent').evaluate((el) => {
  el.value = '#00ff00'
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
})
const colorRefused = await probeSnapshot()
const colorShown = await probeSetting('accent').inputValue()
ok(colorRefused.elements[0].url === fullColorUrl && colorShown === '#ff0000'
  && /too long/i.test(await probe.locator('.ed-scene-settings').innerText()),
  `U10 round 3: refused colour restores the stored swatch (shown=${colorShown}, expected #ff0000)`)

// Round 4: preset coercion must report the same clamp as a manual edit.
await mount('runtime', [{ key: 'n', label: 'N', kind: 'number', default: 0, format: 'range:0:10:1' }], {},
  [{ name: 'Beyond limit', values: { n: 12 } }])
await probePreset().selectOption('Beyond limit')
const presetClamp = await probeSnapshot()
const presetClampText = await probe.locator('.ed-scene-settings').innerText()
ok(presetClamp.runtime.values.n === 10 && /Held at 10/.test(presetClampText),
  `U10 round 4: preset clamping is stored and explained inline (stored=${presetClamp.runtime.values.n}, text=${JSON.stringify(presetClampText)})`)

// A hand-edited value is valid text to the gate. A position control must
// disclose that it cannot interpret it rather than showing a fabricated 0,0.
await mount('runtime', [{ key: 'position', label: 'Position', kind: 'text', default: '59, 10', format: 'latlon' }],
  { position: 'unknown' }, [])
const invalidPositionText = await probe.locator('.ed-scene-settings').innerText()
const invalidPositionInputs = await probeSetting('position').locator('input').evaluateAll((els) => els.map((el) => el.value))
ok(/unknown|Not a position/.test(invalidPositionText) || invalidPositionInputs.includes('unknown'),
  `U10 round 4: unparseable stored position is disclosed instead of fabricated coordinates (inputs=${JSON.stringify(invalidPositionInputs)}, text=${JSON.stringify(invalidPositionText)})`)

await probe.close()

ok(errors.length === 0, `no page error (${errors.join(' | ')})`)
await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
