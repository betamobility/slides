// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Beta build: the light table in the packaged editor, with a real mouse.
//
//   npm run build:single --prefix slides && node scripts/test-beta-lighttable-browser.mjs
//
// WHAT THIS PROVES (2026-10-13-2236 plan, U14, KTD12, AE9). The geometry is
// pinned without a browser in scripts/test-beta-lighttable.ts and the move in
// upstream's scripts/test-slides-multiselect.ts. Here, in the built document:
//   1. the toggle lays the slide list over the canvas as a wrapping grid, says
//      so with aria-pressed, and hides the list's insert gaps;
//   2. AE9: slides 2 and 5 selected, dragged with the mouse between 7 and 8:
//      the drop bar shows at that gap, the order becomes 1,3,4,6,7,2,5,8 and
//      undo restores it;
//   3. Alt+arrow moves the selection one gap and undo restores it; a plain
//      arrow walks the grid;
//   4. double-click opens a slide and leaves the grid; Escape leaves it, on
//      the first selected slide when there is a selection;
//   5. a state follows its parent in a multi-drag and nothing lands between a
//      parent and its states; a hidden slide keeps its dimmed look;
//   6. a deck file dropped on the grid still opens;
//   7. the grid is not offered where the slide list is a drawer, and the top
//      bar does not overflow with the new button in it.
import { readFileSync } from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const shellUrl = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url)

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const p = await ctx.newPage()
const errors = []
p.on('pageerror', (e) => errors.push(e.message))
p.on('dialog', (d) => { void d.accept() })
await p.goto(shellUrl.href)
await p.waitForFunction(() => window.bento?.doc && document.querySelector('.ed-stage-scale'))

const load = async (slides) => {
  await p.evaluate((sl) => {
    const d = JSON.parse(JSON.stringify(window.bento.doc))
    d.slides = sl
    window.bento.loadDoc(JSON.stringify(d))
  }, slides)
  await p.waitForTimeout(400)
}
const label = (id) => ({ id: 't' + id, type: 'text', x: 96, y: 200, w: 1088, h: 200, rotation: 0, opacity: 1, html: 'Slide ' + id, fontSize: 160, color: '#1E2A3A' })
const plain = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), background: '#ffffff', elements: [label(String(i + 1))] }))
const order = () => p.evaluate(() => window.bento.doc.slides.map((s) => s.id).join(','))
const SB = '.ed-sidebar'
const thumb = (i) => p.locator(`${SB} .ed-thumb[data-index="${i}"]`)
const box = async (i) => thumb(i).boundingBox()
const isGrid = () => p.evaluate((sb) => document.querySelector(sb).classList.contains('ed-lighttable'), SB)
const current = () => p.evaluate((sb) => Number(document.querySelector(sb + ' .ed-thumb.active')?.dataset.index ?? -1), SB)
const selected = () => p.evaluate((sb) => [...document.querySelectorAll(sb + ' .ed-thumb.selected')].map((n) => Number(n.dataset.index)).join(','), SB)
const toggle = p.locator('.ed-lt-toggle')
const settle = () => p.waitForTimeout(250)
/** Press on thumbnail `from`, travel to (x, y) in steps so the browser starts a native drag, and release. */
const drag = async (from, x, y, during) => {
  const b = await box(from)
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await p.mouse.down()
  await p.mouse.move(b.x + b.width / 2 + 12, b.y + b.height / 2 + 6, { steps: 4 })
  await p.mouse.move(x, y, { steps: 12 })
  await p.waitForTimeout(120)
  const seen = during ? await during() : null
  await p.mouse.up()
  await settle()
  return seen
}

console.log('\nthe toggle')
await load(plain(8))
ok(await toggle.isVisible() && (await toggle.getAttribute('aria-pressed')) === 'false', 'the grid toggle is in the top bar, not pressed')
ok(await p.evaluate(() => { const b = document.querySelector('.ed-topbar'); return b.scrollWidth <= b.clientWidth + 1 }), 'the top bar does not overflow with it at 1440px')
const listWidth = (await box(0)).width
await toggle.click(); await settle()
ok(await isGrid() && (await toggle.getAttribute('aria-pressed')) === 'true', 'pressed: the slide list is the grid, and the toggle says so')
const b0 = await box(0), b1 = await box(1)
ok(Math.abs(b0.y - b1.y) < 2 && b1.x > b0.x + b0.width, `thumbnails sit side by side (${Math.round(b0.x)},${Math.round(b0.y)} and ${Math.round(b1.x)},${Math.round(b1.y)})`)
ok(b0.width > listWidth + 30, `at the grid's own width (${Math.round(b0.width)} against ${Math.round(listWidth)} in the list)`)
const cover = await p.evaluate((sb) => { const s = document.querySelector(sb).getBoundingClientRect(), m = document.querySelector('.ed-main').getBoundingClientRect(); return [s.width / m.width, s.height / m.height] }, SB)
ok(cover[0] > 0.99 && cover[1] > 0.99, 'the grid covers the whole work area')
ok(await p.evaluate((sb) => [...document.querySelectorAll(sb + ' .ed-insertgap, ' + sb + ' .ed-add-slide')].every((n) => getComputedStyle(n).display === 'none'), SB), 'the list\'s insert gaps and New-slide button are not shown')
ok(await p.evaluate((sb) => document.querySelectorAll(sb + ' .ed-thumb').length, SB) === 8, 'the same eight thumbnails, not a second list')

console.log('\nAE9: slides 2 and 5, dragged between 7 and 8')
await thumb(1).click()
await thumb(4).click({ modifiers: [MOD] })
ok((await selected()) === '1,4', `slides 2 and 5 are selected (${await selected()})`)
const b6 = await box(6), b7 = await box(7)
const sameRow = Math.abs(b6.y - b7.y) < 2
const tx = sameRow ? (b6.x + b6.width + b7.x) / 2 : b7.x - 6
const bar = await drag(1, tx, b7.y + b7.height / 2, () => p.evaluate(() => {
  const n = document.querySelector('.ed-lt-bar')
  if (!n) return null
  const r = n.getBoundingClientRect()
  return { gap: n.dataset.gap, x: r.x + r.width / 2, y: r.y, h: r.height }
}))
ok(!!bar && bar.gap === '7', `while dragging, the drop bar names gap 7 (${JSON.stringify(bar)})`)
ok(!!bar && bar.x < b7.x && (!sameRow || bar.x > b6.x + b6.width) && Math.abs(bar.y - b7.y) < 3 && bar.h > 60, 'and it is drawn between the seventh and eighth thumbnails, as tall as they are')
ok((await order()) === '1,3,4,6,7,2,5,8', `the order is 1,3,4,6,7,2,5,8 (${await order()})`)
ok(await p.evaluate(() => !document.querySelector('.ed-lt-bar')), 'the bar is gone after the drop')
ok((await selected()) === '5,6', `the selection followed the slides (${await selected()})`)
await p.keyboard.press(`${MOD}+z`); await settle()
ok((await order()) === '1,2,3,4,5,6,7,8', `undo restores the order in one step (${await order()})`)

console.log('\nthe keyboard')
await thumb(1).click()
await thumb(4).click({ modifiers: [MOD] })
await p.keyboard.press('Alt+ArrowRight'); await settle()
ok((await order()) === '1,3,4,6,2,5,7,8', `Alt+Right moves the two selected slides one gap later (${await order()})`)
await p.keyboard.press(`${MOD}+z`); await settle()
ok((await order()) === '1,2,3,4,5,6,7,8', 'and undo restores it')
await thumb(2).click()
await p.keyboard.press('ArrowRight'); await settle()
ok((await current()) === 3, `a plain arrow walks the grid (now on ${(await current()) + 1})`)
await p.keyboard.press('ArrowLeft'); await p.keyboard.press('ArrowLeft'); await settle()
ok((await current()) === 1 && (await isGrid()), 'and back, still in the grid')
ok((await order()) === '1,2,3,4,5,6,7,8', 'walking moves nothing')

console.log('\nleaving the grid')
await thumb(5).dblclick(); await settle()
ok(!(await isGrid()) && (await current()) === 5 && (await toggle.getAttribute('aria-pressed')) === 'false', `double-click opens that slide in the list (on ${(await current()) + 1})`)
ok(Math.abs((await box(0)).width - listWidth) < 2, 'the thumbnails are back at the list\'s width')
await toggle.click(); await settle()
await thumb(3).click()
await thumb(6).click({ modifiers: [MOD] })
await p.keyboard.press('Escape'); await settle()
ok(!(await isGrid()) && (await current()) === 3, `Escape with a selection leaves on the first selected slide (on ${(await current()) + 1})`)
await p.keyboard.press('Escape'); await settle()
await toggle.click(); await settle()
ok(await isGrid(), 'the toggle turns it on again')
await p.keyboard.press('Escape'); await settle()
ok(!(await isGrid()), 'Escape with nothing selected leaves it too')
await toggle.click(); await settle()
await p.keyboard.press('['); await settle()
ok(!(await isGrid()) && await p.evaluate((sb) => !document.querySelector(sb).classList.contains('ed-collapsed'), SB), 'the hide-list key in the grid goes back to the list instead of hiding it')

console.log('\nfound by a local hunt before the first Codex round')
// a scrolled grid: the press must not make it jump, or the double-click opens another slide
await p.setViewportSize({ width: 1440, height: 700 })
await load(plain(60))
await toggle.click(); await settle()
await p.evaluate((sb) => { document.querySelector(sb).scrollTop = 900 }, SB); await settle()
const visible = await p.evaluate((sb) => {
  const s = document.querySelector(sb).getBoundingClientRect()
  return [...document.querySelectorAll(sb + ' .ed-thumb')].filter((n) => { const r = n.getBoundingClientRect(); return r.top > s.top + 40 && r.bottom < s.bottom - 40 }).map((n) => Number(n.dataset.index))
}, SB)
const far = visible[Math.floor(visible.length / 2)]
const scrollBefore = await p.evaluate((sb) => document.querySelector(sb).scrollTop, SB)
await thumb(far).click(); await settle()
ok(await p.evaluate((sb) => document.querySelector(sb).scrollTop, SB) === scrollBefore, 'a click on a thumbnail far from the active one does not scroll the grid')
await p.evaluate((sb) => { document.querySelector(sb).scrollTop = 0 }, SB); await settle()
await thumb(0).click(); await settle()
await p.evaluate((sb) => { document.querySelector(sb).scrollTop = 900 }, SB); await settle()
await thumb(far).dblclick(); await settle()
ok(!(await isGrid()) && (await current()) === far, `double-click in a scrolled grid opens the slide under the pointer (${(await current()) + 1}, wanted ${far + 1})`)
await p.setViewportSize({ width: 1440, height: 900 })

// keys must not act on a canvas selection the grid covers
await load(plain(8))
await p.locator('.ed-stage-scale [data-el-id="t1"]').click(); await settle()
ok(await p.evaluate(() => document.querySelectorAll('.ed-stage-scale [data-el-id="t1"]').length) === 1, 'an element is selected on the canvas')
await toggle.click(); await settle()
await thumb(1).click()
await thumb(4).click({ modifiers: [MOD] })
await p.keyboard.press('Delete'); await settle()
ok((await order()) === '1,3,4,6,7,8' && await p.evaluate(() => window.bento.doc.slides[0].elements.length) === 1, `Delete removes the selected slides, not an element behind the grid (${await order()})`)
await p.keyboard.press(`${MOD}+z`); await settle()

// Alt+arrow moves what is painted as selected, wherever the arrows have walked to
await thumb(1).click()
await thumb(4).click({ modifiers: [MOD] })
await p.keyboard.press('ArrowRight'); await settle()
await p.keyboard.press('Alt+ArrowRight'); await settle()
ok((await order()) === '1,3,4,6,2,5,7,8', `after an arrow, Alt+Right still moves the two selected slides (${await order()})`)
await p.keyboard.press(`${MOD}+z`); await settle()
await p.keyboard.press('Escape'); await settle()
if (!(await isGrid())) { await toggle.click(); await settle() }

// a double-click on a thumbnail's own tool is that tool twice at most, never "open this slide"
await thumb(2).click(); await settle()
await thumb(2).hover()
const dup = thumb(2).locator('.ed-thumb-tools .ed-btn').first()
await dup.dblclick(); await settle()
ok(await isGrid(), 'a double-click on Duplicate stays in the grid')
ok(await p.evaluate(() => window.bento.doc.slides.length) > 8, 'and it duplicated')

// a list that was collapsed is collapsed again afterwards
await p.keyboard.press('Escape'); await settle()
await p.keyboard.press('Escape'); await settle()
ok(!(await isGrid()), 'out of the grid')
await p.keyboard.press('['); await settle()
ok(await p.evaluate((sb) => document.querySelector(sb).classList.contains('ed-collapsed'), SB), 'the list is collapsed')
await toggle.click(); await settle()
ok(await isGrid() && await p.evaluate((sb) => !document.querySelector(sb).classList.contains('ed-collapsed'), SB), 'the grid shows even so')
await p.keyboard.press('Escape'); await settle()
ok(await p.evaluate((sb) => document.querySelector(sb).classList.contains('ed-collapsed'), SB), 'and leaving it puts the list back as it was, collapsed')
await p.keyboard.press('['); await settle()

console.log('\nstates and hidden slides')
await load([
  { id: '1', background: '#ffffff', elements: [label('1')] },
  { id: '2', background: '#ffffff', elements: [label('2')] },
  { id: '3', background: '#ffffff', elements: [label('3')] },
  { id: '3a', stateOf: '3', background: '#ffffff', elements: [label('3a')] },
  { id: '3b', stateOf: '3', background: '#ffffff', elements: [label('3b')] },
  { id: '4', hidden: true, background: '#ffffff', elements: [label('4')] },
  { id: '5', background: '#ffffff', elements: [label('5')] },
  { id: '6', background: '#ffffff', elements: [label('6')] },
])
await toggle.click(); await settle()
ok(await p.evaluate((sb) => { const n = document.querySelector(sb + ' .ed-thumb[data-index="5"]'); return n.classList.contains('ed-thumb-hidden') && Number(getComputedStyle(n.querySelector('.bento-thumb-surface')).opacity) < 0.6 }, SB), 'a hidden slide keeps its dimmed look in the grid')
// 2 and the parent 3 (with its two states), dragged to the end
await thumb(1).click()
await thumb(2).click({ modifiers: [MOD] })
const last = await box(7)
await drag(1, last.x + last.width + 14, last.y + last.height / 2)
ok((await order()) === '1,4,5,6,2,3,3a,3b', `2 and 3 dragged to the end: the states follow their parent (${await order()})`)
await p.keyboard.press(`${MOD}+z`); await settle()
// slide 1 dropped over the first state: never between the parent and its states
await thumb(0).click()
const st = await box(3)
const over = await drag(0, st.x + 8, st.y + st.height / 2, () => p.evaluate(() => document.querySelector('.ed-lt-bar')?.dataset.gap ?? null))
ok(/3,3a,3b/.test(await order()), `a slide dropped over a state does not split the unit (${await order()}, bar at gap ${over})`)
ok(over === '5' || over === '2', 'the bar never names a gap inside the unit')
await p.keyboard.press(`${MOD}+z`); await settle()

console.log('\na file dropped on the grid')
const deck = (() => {
  const shell = readFileSync(shellUrl, 'utf8')
  const open = '<script type="application/bento+json" id="bento-doc">', close = '</' + 'script>'
  const at = shell.indexOf(open) + open.length
  const doc = { format: 'bento/slides', title: 'dropped deck', docId: 'lt-rig-dropped', size: { width: 1280, height: 720 }, slides: [{ id: 'only', elements: [] }] }
  return shell.slice(0, at) + JSON.stringify(doc) + shell.slice(shell.indexOf(close, at))
})()
ok(await isGrid(), 'the grid is on')
await p.evaluate(([html, sb]) => {
  const dt = new DataTransfer()
  dt.items.add(new File([html], 'dropped.bento.html', { type: 'text/html' }))
  const target = document.querySelector(sb + ' .ed-thumb[data-index="2"]')
  const r = target.getBoundingClientRect()
  for (const type of ['dragover', 'drop']) {
    target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + 20, clientY: r.y + 20 }))
  }
}, [deck, SB])
await p.waitForFunction(() => window.bento.doc.title === 'dropped deck', null, { timeout: 8000 }).catch(() => {})
ok(await p.evaluate(() => window.bento.doc.title) === 'dropped deck', 'the file opens as a deck, as it does on the list')
ok(await p.evaluate(() => !document.querySelector('.ed-lt-bar')), 'and the grid drew no drop bar for it')

console.log('\nwhere the slide list is a drawer')
await load(plain(4))
if (!(await isGrid())) { await toggle.click(); await settle() }
ok(await isGrid(), 'the grid is on at 1440px')
await p.setViewportSize({ width: 620, height: 900 }); await p.waitForTimeout(500)
ok(!(await isGrid()), 'a window narrowed to drawer width leaves the grid')
ok(!(await toggle.isVisible()), 'and the toggle is not offered there')
await p.setViewportSize({ width: 900, height: 800 }); await p.waitForTimeout(500)
ok(await p.evaluate(() => { const b = document.querySelector('.ed-topbar'); return b.scrollWidth <= b.clientWidth + 1 }), 'at 900px the top bar still fits (its fold tiers took the button)')
await p.setViewportSize({ width: 1440, height: 900 }); await p.waitForTimeout(500)
ok(await toggle.isVisible() && (await toggle.getAttribute('aria-pressed')) === 'false', 'back at 1440px the toggle is in the bar again, not pressed')

ok(errors.length === 0, `no page error (${errors.join(' | ')})`)
await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
