// The scene gallery in the packaged editor (2026-10-13-2236 plan, U11): the
// dialog's states, both inserts, and the button at phone width.
//
//   npm run build:single --prefix slides && node scripts/test-beta-gallery-browser.mjs [--shots <dir>]
//
// The store is played by Playwright routes on the real store origin, so the
// shell decides "store origin" exactly as it does in production: the deck is
// served at <store>/d/test and the manifest at /library/library.json is the
// one scripts/build-beta-library.mjs builds from beta/library. A lapsed
// session is a 302 to the Access login, as Access sends it.
// PLAYWRIGHT_MODULE and CHROME_PATH as in the other browser rigs.

import { readFileSync } from 'node:fs'
import { buildManifest, serialize } from './lib/beta-library.mjs'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null

const STORE = 'https://slides.betamobility.ai'
const shellPath = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url)
const SHELL = readFileSync(shellPath, 'utf8')
const MANIFEST = serialize(buildManifest('beta/library'))
const EMPTY = serialize({ format: 'beta/library', v: 1, scenes: [] })

let library = 'ok' // ok | empty | fail | login
const libraryHits = []
const errors = []

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })

async function storePage(viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport })
  await ctx.route('**/*', (r) => {
    const u = new URL(r.request().url())
    if (/^(about|data|blob):/.test(u.protocol)) return r.continue()
    if (u.origin !== STORE) return r.abort()
    if (u.pathname === '/d/test') return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { etag: '"v1"' }, body: SHELL })
    if (u.pathname === '/library/library.json') {
      libraryHits.push(u.href)
      if (library === 'login') return r.fulfill({ status: 302, headers: { location: 'https://beta.cloudflareaccess.com/cdn-cgi/access/login/slides.betamobility.ai' }, body: '' })
      if (library === 'fail') return r.fulfill({ status: 500, contentType: 'text/plain', body: 'no' })
      return r.fulfill({ status: 200, contentType: 'application/json', body: library === 'empty' ? EMPTY : MANIFEST })
    }
    return r.fulfill({ status: 404, contentType: 'text/plain', body: '' })
  })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(e.message))
  p.on('dialog', (d) => { void d.dismiss() })
  await p.goto(`${STORE}/d/test`)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale') && !document.getElementById('bento-splash')) // the splash holds ~1.3 s over the editor
  return { ctx, p }
}

const state = (p) => p.evaluate(() => document.querySelector('.ed-gallery [data-gallery-state]')?.dataset.galleryState ?? null)
const waitState = (p, want) => p.waitForFunction((w) => document.querySelector('.ed-gallery [data-gallery-state]')?.dataset.galleryState === w, want, { timeout: 5000 }).then(() => true, () => false)

console.log('\non the store origin')
{
  const { ctx, p } = await storePage()
  const gallery = p.locator('.ed-btn-gallery')
  ok(await gallery.isVisible(), 'the topbar has a Scenes button')
  await gallery.click()
  ok(await waitState(p, 'shelf'), 'the dialog opens on the shelf')
  ok(libraryHits.length === 1, 'the manifest is read once, from the login route')
  const cards = await p.locator('.ed-gallery-card').evaluateAll((els) => els.map((e) => [e.dataset.sceneId, e.querySelector('b')?.textContent, !!e.querySelector('img.ed-gallery-still')?.getAttribute('src')?.startsWith('data:image/svg+xml')]))
  ok(JSON.stringify(cards) === JSON.stringify([['counter', 'Counter', true], ['map', 'Map', true]]), `a card per scene with its still and name (${JSON.stringify(cards)})`)
  if (shots) await p.locator('.ed-gallery').screenshot({ path: `${shots}/u11-shelf.png` })

  await p.locator('.ed-gallery-card[data-scene-id="map"]').click()
  const preset = p.locator('.ed-gallery select[data-gallery-preset]')
  ok(await preset.inputValue() === 'Oslo', 'the detail step opens on the first preset')
  await preset.selectOption('Copenhagen')
  if (shots) await p.locator('.ed-gallery').screenshot({ path: `${shots}/u11-detail.png` })
  const before = await p.evaluate(() => ({ n: window.bento.doc.slides.length, cur: document.querySelector('.ed-sidebar .ed-thumb.active, .ed-sidebar .ed-thumb.is-current')?.dataset.index }))
  await p.locator('.ed-gallery [data-gallery-insert]').click()
  ok(await p.locator('.ed-gallery-overlay').count() === 0, 'Insert closes the dialog')
  const after = await p.evaluate(() => {
    const d = window.bento.doc
    const i = d.slides.findIndex((s) => s.runtime?.library?.id === 'map')
    const s = d.slides[i]
    return { n: d.slides.length, i, lib: s?.runtime?.library, place: s?.runtime?.values?.place, still: s?.elements?.[0]?.type, stillRef: s?.elements?.[0]?.src === s?.runtime?.still }
  })
  ok(after.n === before.n + 1 && after.i === 1 && after.lib?.version >= 1 && after.place === 'Copenhagen' && after.still === 'image' && after.stillRef,
    `a runtime scene is a new slide after the current one, with the marker, the preset's values and its still (${JSON.stringify(after)})`)
  await p.waitForTimeout(400)
  ok(await p.evaluate(() => !!document.querySelector('.ed-sidebar .ed-thumb[data-index="1"] img, .ed-sidebar .ed-thumb[data-index="1"] image')),
    'its sidebar thumbnail paints the still')
  ok(await p.locator('.ed-props [data-scene-preset]').count() === 1, "the settings panel now offers the library's presets (U10)")
  ok(await p.locator('.ed-props [data-scene-preset]').inputValue() === 'Copenhagen', 'and names the preset in force')
  await p.evaluate(() => window.bento.undo())
  ok(await p.evaluate(() => window.bento.doc.slides.length) === before.n, 'one undo removes it')

  await p.keyboard.press('Escape')
  await gallery.click()
  await waitState(p, 'shelf')
  await p.keyboard.press('Escape')
  ok(await p.locator('.ed-gallery-overlay').count() === 0, 'Escape closes the dialog')
  await ctx.close()
}

console.log('\nkeys inside the dialog stay in the dialog (Codex U11 round 5)')
{
  const { ctx, p } = await storePage()
  // a slide with an element, the element selected, as a person would leave it
  const id = await p.evaluate(() => {
    const i = window.bento.doc.slides.findIndex((s) => !s.runtime && s.elements.length)
    document.querySelector(`.ed-sidebar .ed-thumb[data-index="${i}"]`).click()
    return { i, id: window.bento.doc.slides[i].elements[0].id }
  })
  await p.evaluate((el) => window.bento.store?.select?.([el]) ?? null, id.id)
  await p.locator(`.ed-stage-scale [data-el-id="${id.id}"]`).first().click({ force: true }).catch(() => {})
  const before = await p.evaluate(() => JSON.stringify(window.bento.doc.slides))
  await p.locator('.ed-btn-gallery').click()
  await waitState(p, 'shelf')
  await p.locator('.ed-gallery-card').first().focus()
  for (const key of ['Delete', 'Backspace', 'ArrowRight', 'ArrowDown', 'Shift+ArrowLeft']) await p.keyboard.press(key)
  await p.locator('.ed-gallery-card').first().click()
  await p.locator('.ed-gallery select[data-gallery-preset]').focus()
  await p.keyboard.press('Delete')
  await p.keyboard.press('Escape')
  await p.waitForTimeout(300)
  const after = await p.evaluate(() => JSON.stringify(window.bento.doc.slides))
  ok(after === before, 'Delete, Backspace and the arrows pressed in the open gallery leave the deck untouched')
  await ctx.close()
}

console.log('\nthe states')
{
  for (const [mode, want, retry] of [['empty', 'empty', false], ['fail', 'failed', true], ['login', 'signed-out', true]]) {
    library = mode
    const { ctx, p } = await storePage()
    await p.locator('.ed-btn-gallery').click()
    ok(await waitState(p, want), `${mode}: the dialog says ${want}`)
    ok((await p.locator('.ed-gallery [data-gallery-retry]').count() > 0) === retry, `${mode}: ${retry ? 'with' : 'without'} Retry`)
    if (retry) {
      library = 'ok'
      await p.locator('.ed-gallery [data-gallery-retry]').click()
      ok(await waitState(p, 'shelf'), `${mode}: Retry reads it again and shows the shelf`)
    }
    if (shots && mode === 'login') await p.locator('.ed-gallery').screenshot({ path: `${shots}/u11-signed-out.png` })
    await ctx.close()
  }
  library = 'ok'
}

console.log('\noff the store origin')
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const requests = []
  await ctx.route(/^https?:/, (r) => { requests.push(r.request().url()); return r.abort() })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(shellPath.href)
  await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale') && !document.getElementById('bento-splash')) // the splash holds ~1.3 s over the editor
  await p.locator('.ed-btn-gallery').click()
  ok(await waitState(p, 'not-store'), 'on file:// the dialog says the library is in the store')
  ok(await p.locator('.ed-gallery a.ed-gallery-link').getAttribute('href') === `${STORE}/`, 'and links to the store')
  ok(!requests.some((u) => u.includes('/library/')), 'and makes no fetch for it')
  if (shots) await p.locator('.ed-gallery').screenshot({ path: `${shots}/u11-not-store.png` })
  await ctx.close()
}

console.log('\nat phone width')
{
  const { ctx, p } = await storePage({ width: 320, height: 640 })
  await p.waitForTimeout(400)
  const more = p.locator('.ed-dropdown.ed-phone-only').filter({ has: p.locator('.ed-menu') }).last()
  await more.locator(':scope > button').first().click()
  const inMenu = p.locator('.ed-menu .ed-btn-gallery')
  ok(await inMenu.isVisible(), 'at 320px the Scenes button is in the ⋯ menu, visible')
  const box = await inMenu.boundingBox()
  ok(box && box.x >= 0 && box.x + box.width <= 320, `and inside the screen (${JSON.stringify(box)})`)
  await inMenu.click()
  ok(await waitState(p, 'shelf'), 'and opens the gallery')
  const dlg = await p.locator('.ed-gallery').boundingBox()
  ok(dlg && dlg.x >= 0 && dlg.x + dlg.width <= 320, `the dialog fits the screen (${JSON.stringify(dlg)})`)
  if (shots) await p.screenshot({ path: `${shots}/u11-phone.png` })
  await ctx.close()
}

await browser.close()
ok(errors.length === 0, `no page error (${errors.join(' | ')})`)
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
