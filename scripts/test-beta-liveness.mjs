// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Beta build: only the slide showing and its neighbours hold a live frame.
//
//   npm run build:single --prefix slides && node scripts/test-beta-liveness.mjs
//
// WHAT THIS PROVES, in the packaged document, in a real show (2026-10-13-2236
// plan, U13, KTD11). slides/src/runtime-present.ts owns every live frame: a
// runtime slide's scene and a web embed's page. The arithmetic and the channel
// gate are pinned without a browser in scripts/test-beta-runtime.ts; what only
// a browser can say is checked here:
//   1. six scenes, show on the third: slides two, three and four hold a frame,
//      nothing else does;
//   2. a frame that left the window is detached with `src` and `srcdoc` cleared;
//   3. a scene mounted ahead of the show hears NOTHING until the show enters
//      it, and then bento:init is the first thing it hears;
//   4. bento:navigate from a neighbour's scene is ignored; the same message
//      from the scene showing changes slide;
//   5. a web embed gets a frame and no channel: no bento:init, bento:props or
//      bento:assets, and what its page posts moves nothing;
//   6. a web embed that never loads is removed after the owner's timeout and
//      its view stays;
//   7. the speaker view and the grid stay stills (no frame outside the show).
// It also prints how long a scene takes to hear bento:init after the slide
// change, entered cold (mounted on entry, as before the window) and warm
// (mounted ahead as a neighbour).
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const shell = readFileSync(new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url), 'utf8')
const open = '<script type="application/bento+json" id="bento-doc">'
const close = '</' + 'script>'
const at = shell.indexOf(open) + open.length

// A scene that says ready, echoes everything the shell tells it, and forwards
// a navigate when the rig asks. `echo` is not a scene message, so the shell
// ignores it; the rig's own listener records it with the scene's name.
const scene = (name) => '<!doctype html><body style="margin:0;background:#123"><script>'
  + `var N=${JSON.stringify(name)};`
  + 'addEventListener("message",function(e){var d=e.data||{};'
  + 'if(d.type==="rig:nav"){parent.postMessage({type:"bento:navigate",dir:"next"},"*");return}'
  + 'if(typeof d==="string")return;'
  + 'parent.postMessage({type:"echo",name:N,got:d.type,step:d.type==="bento:init"?d.step:d.index},"*")});'
  + 'parent.postMessage({type:"bento:ready"},"*")'
  + '</' + 'script></body>'
// A hosted page that tries everything a scene may say, and echoes like one.
const PAGE = '<!doctype html><body><script>'
  + 'addEventListener("message",function(e){parent.postMessage({type:"echo",name:"page",got:typeof e.data==="string"?e.data:(e.data||{}).type},"*")});'
  + 'parent.postMessage({type:"bento:ready"},"*");parent.postMessage({type:"bento:navigate",dir:"next"},"*");'
  + 'parent.postMessage({type:"bento:navigate",dir:"exit"},"*")'
  + '</' + 'script>page</body>'

const NAMES = ['A', 'B', 'C', 'D', 'E', 'F']
const embed = (id, url) => ({ type: 'embed', id, x: 0, y: 0, w: 1280, h: 720, rotation: 0, app: 'web', url, live: true })
const doc = {
  format: 'bento/slides', title: 'liveness', docId: 'liveness-rig',
  size: { width: 1280, height: 720 },
  assets: Object.fromEntries(NAMES.concat('Z').map((n) => ['sc' + n, scene(n)])),
  slides: [
    ...NAMES.map((n) => ({ id: 's' + n, elements: [], transition: 'none', runtime: { src: 'asset:sc' + n, steps: 2, props: [] } })),
    { id: 'sOk', transition: 'none', elements: [embed('eOk', 'https://embed.test/ok')] },
    { id: 'sHang', transition: 'none', elements: [embed('eHang', 'https://hang.test/never')] },
    { id: 'sPlain', transition: 'none', elements: [{ type: 'shape', shape: 'rect', id: 'jump', x: 200, y: 200, w: 400, h: 200, rotation: 0, opacity: 1, fill: '#F7A600', stroke: 'transparent', strokeWidth: 0, radius: 0, link: 'sC' }] },
    { id: 'sZ', transition: 'none', elements: [], runtime: { src: 'asset:scZ', steps: 2, props: [] } },
  ],
}
const dir = mkdtempSync(join(tmpdir(), 'bento-liveness-'))
const file = join(dir, 'liveness.bento.html')
writeFileSync(file, shell.slice(0, at) + JSON.stringify(doc).replace(/</g, '\\u003c') + shell.slice(shell.indexOf(close, at)))

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
await ctx.route('https://embed.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: PAGE }))
await ctx.route('https://hang.test/**', () => { /* never answered */ })
const p = await ctx.newPage()
const errors = []
p.on('pageerror', (e) => errors.push(String(e)))
await p.addInitScript(() => {
  window.__log = []
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'echo') window.__log.push({ name: e.data.name, got: e.data.got, step: e.data.step, t: performance.now() })
  })
})
await p.goto(pathToFileURL(file).href + '#present')
await p.waitForFunction(() => document.querySelector('.bento-present-overlay .reveal .slides > section.present'), null, { timeout: 30_000 })

const SECTIONS = '.bento-present-overlay .reveal .slides > section'
const at_ = () => p.evaluate((sel) => [...document.querySelectorAll(sel)].findIndex((s) => s.classList.contains('present')), SECTIONS)
const held = () => p.evaluate((sel) => [...document.querySelectorAll(sel)].map((s, i) => (s.querySelector('iframe') ? i : -1)).filter((i) => i >= 0), SECTIONS)
const log = (name) => p.evaluate((n) => window.__log.filter((m) => m.name === n), name)
const heard = (name, type) => p.waitForFunction(([n, ty]) => window.__log.some((m) => m.name === n && m.got === ty), [name, type], { timeout: 15_000 })
const settle = () => p.waitForTimeout(350)
const press = async (key) => { await p.keyboard.press(key); await p.waitForTimeout(120) }
/** Arrow off the slide showing: each scene has two steps, so two presses. */
const walk = async (key) => { const from = await at_(); for (let i = 0; i < 3 && (await at_()) === from; i++) await press(key) }
const nav = (idx) => p.evaluate(([sel, i]) => document.querySelectorAll(sel)[i].querySelector('iframe').contentWindow.postMessage({ type: 'rig:nav' }, '*'), [SECTIONS, idx])

console.log('\nthe show opens on slide one')
await heard('A', 'bento:init')
await settle()
ok(JSON.stringify(await held()) === '[0,1]', `slides one and two hold a frame (${await held()})`)
ok((await log('B')).length === 0, `the neighbour, mounted ahead of the show, has heard nothing (${JSON.stringify(await log('B'))})`)
const cold0 = (await log('A'))[0]
ok(cold0?.got === 'bento:init' && cold0.step === 0, 'the scene showing heard bento:init first, on step 0')
await p.evaluate((sel) => { window.__first = document.querySelectorAll(sel)[0].querySelector('iframe') }, SECTIONS)

console.log('\nsix scenes, the show on the third')
await press('ArrowRight') // the scene's own second step; the next press leaves the slide
let t0 = await p.evaluate(() => performance.now())
await p.keyboard.press('ArrowRight')
await heard('B', 'bento:init')
const warm = (await log('B'))[0].t - t0
ok((await log('B'))[0].got === 'bento:init' && (await log('B'))[0].step === 0, 'entering the pre-mounted neighbour: bento:init is the first thing it hears, step 0')
await walk('ArrowRight')
await heard('C', 'bento:init')
await settle()
ok((await at_()) === 2, `the show is on slide three (${(await at_()) + 1})`)
ok(JSON.stringify(await held()) === '[1,2,3]', `exactly slides two, three and four hold a frame (${(await held()).map((i) => i + 1)})`)
ok(await p.evaluate(() => document.querySelectorAll('.bento-present-overlay iframe').length) === 3, 'three frames in the whole show')
ok(await p.evaluate(() => { const f = window.__first; return !f.isConnected && !f.hasAttribute('src') && !f.hasAttribute('srcdoc') }),
  'the frame that left the window is detached, with src and srcdoc cleared')
ok((await log('D')).length === 0 && (await log('E')).length === 0, 'the next neighbour has heard nothing, and slide five was never mounted')
ok(await p.evaluate((sel) => document.querySelectorAll(sel)[2].querySelector('iframe').style.visibility === '', SECTIONS), 'the scene showing is uncovered')
// the scene that was left is a FRESH frame: mounted again, told nothing
const before = (await log('B')).length
ok((await held()).includes(1) && (await log('B')).length === before, 'the scene the show left is mounted afresh and silent')

console.log('\nwho may move the show')
await nav(3)
await settle()
ok((await at_()) === 2, 'bento:navigate from a neighbour\'s scene is ignored')
// a forwarded key is an arrow press: the scene's own step first, then the slide
await nav(2)
await heard('C', 'bento:step')
ok((await at_()) === 2 && (await log('C')).some((m) => m.got === 'bento:step' && m.step === 1), 'from the scene showing it is an arrow press: the scene steps first')
await nav(2)
await p.waitForFunction((sel) => [...document.querySelectorAll(sel)].findIndex((s) => s.classList.contains('present')) === 3, SECTIONS, { timeout: 5000 }).catch(() => {})
ok((await at_()) === 3, `the same message from the scene showing changes slide (now on ${(await at_()) + 1})`)
await heard('D', 'bento:init')

console.log('\nbackward entry, and a jump')
const cBefore = (await log('C')).length
await press('ArrowLeft')
await p.waitForFunction(([n, k]) => window.__log.filter((m) => m.name === n).length > k, ['C', cBefore], { timeout: 5000 }).catch(() => {})
const cBack = (await log('C'))[cBefore]
ok((await at_()) === 2 && cBack?.got === 'bento:init' && cBack.step === 1, `entered backward, the scene opens on its last step (${JSON.stringify(cBack)})`)

console.log('\na web embed')
for (let i = 0; i < 3; i++) await walk('ArrowRight')
await settle()
ok((await at_()) === 5, `the show is on slide six (${(await at_()) + 1})`)
ok((await held()).includes(6), 'the embed on the next slide is mounted ahead of the show')
await settle()
ok((await at_()) === 5, 'what the embedded page posts (ready, navigate next, navigate exit) moves nothing')
await walk('ArrowRight')
await settle()
ok((await at_()) === 6, 'the show is on the embed slide')
const frameOk = await p.evaluate((sel) => {
  const f = document.querySelectorAll(sel)[6].querySelector('[data-el-id="eOk"] iframe')
  return f ? { sandbox: f.getAttribute('sandbox'), ref: f.referrerPolicy, vis: f.style.visibility, src: f.getAttribute('src') } : null
}, SECTIONS)
ok(frameOk?.sandbox === 'allow-scripts allow-forms' && frameOk.ref === 'no-referrer', `the embed frame is sandboxed without same-origin (${JSON.stringify(frameOk)})`)
ok(frameOk?.vis === '' && frameOk.src === 'https://embed.test/ok', 'it is uncovered once it has loaded')
// (Reveal posts the string 'slide:start' into any frame on the slide showing; that is upstream's, and not ours to send)
ok(!(await log('page')).some((m) => String(m.got).startsWith('bento:')), `a web embed hears no bento:init, bento:props or bento:assets (${JSON.stringify((await log('page')).map((m) => m.got))})`)
ok(await p.evaluate(() => !!document.querySelector('.bento-present-overlay')), 'and the show is still running (its navigate:exit was not read)')

console.log('\na web embed that never loads')
ok((await held()).includes(7), 'the hanging embed is mounted, covered')
ok(await p.evaluate((sel) => document.querySelectorAll(sel)[7].querySelector('iframe')?.style.visibility === 'hidden', SECTIONS), 'it stays covered while it has not loaded')
await p.waitForFunction((sel) => !document.querySelectorAll(sel)[7].querySelector('iframe'), SECTIONS, { timeout: 15_000 }).catch(() => {})
ok(!(await held()).includes(7), 'after the timeout its frame is removed')
ok(await p.evaluate((sel) => document.querySelectorAll(sel)[7].querySelector('[data-el-id="eHang"]')?.children.length === 1, SECTIONS), 'its view stays')
// (that it is not mounted again on every slide change while it stays in the
// window is pinned with a fake clock in scripts/test-beta-runtime.ts)
await press('ArrowLeft'); await settle(); await walk('ArrowRight'); await settle()
ok((await at_()) === 6 && (await held()).includes(7), 'once it has left the window and come back it gets one more try')

console.log('\ncold entry, for the measurement')
// a link jumps the show to a slide whose scene was never in the window: it is
// mounted on entry, which is how every scene was entered before the window
while ((await at_()) < 8) await walk('ArrowRight')
await settle()
ok((await at_()) === 8 && !(await held()).includes(2), 'on the plain slide; slide three holds no frame')
const cCount = (await log('C')).length
t0 = await p.evaluate(() => performance.now())
await p.locator(`${SECTIONS}.present [data-el-id="jump"]`).click()
await p.waitForFunction(([n, k]) => window.__log.filter((m) => m.name === n).length > k, ['C', cCount], { timeout: 15_000 })
const cold = (await log('C'))[cCount].t - t0
ok((await at_()) === 2 && (await log('C'))[cCount].got === 'bento:init', 'a jump to a slide outside the window mounts its scene on entry')
ok(JSON.stringify(await held()) === '[1,2,3]', `and the window follows the jump (${(await held()).map((i) => i + 1)})`)

console.log('\nthe speaker view and the grid are stills')
ok(await p.evaluate(() => document.querySelectorAll('iframe').length === document.querySelectorAll('.bento-present-overlay .reveal .slides iframe').length),
  'no frame exists outside the show\'s own sections')

console.log('\nleaving the show')
await p.keyboard.press('Escape')
await p.waitForFunction(() => !document.querySelector('.bento-present-overlay'), null, { timeout: 5000 }).catch(() => {})
ok(await p.evaluate(() => document.querySelectorAll('iframe').length) === 0, 'no frame outlives the show')
ok(errors.length === 0, `no page error (${errors.join(' | ')})`)

console.log(`\n  bento:init after the slide change, on this machine:`)
console.log(`    cold (mounted on entry, as before the window): ${cold.toFixed(1)} ms after the click`)
console.log(`    warm (mounted ahead as a neighbour):           ${warm.toFixed(1)} ms after the key press`)
console.log('    (one input each, timed in the page from just before the input to the scene echoing its bento:init)')

await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
