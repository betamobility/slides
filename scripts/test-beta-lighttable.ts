#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Beta build: the light table, the slide list laid out as a grid
// (slides/src/beta/lighttable.ts).
//
//   node scripts/test-beta-lighttable.ts
//
// WHAT THIS PROVES (2026-10-13-2236 plan, U14, KTD12, AE9). The grid is the
// sidebar with another layout, so selection and the move itself are
// upstream's (slides/src/editor/slidesel.ts, scripts/test-slides-multiselect.ts).
// What the grid adds is geometry, and that is pure:
//   1. thumbnails are grouped into rows from their boxes alone;
//   2. a pointer between two thumbnails names the gap between them, also
//      between rows (past the end of one row is the start of the next), and
//      never a place between a parent and its states;
//   3. the drop bar is drawn where the pointer is, at the gap it names;
//   4. the arrows walk the grid by row and column;
//   5. the keyboard move takes the selection one gap earlier or later, as one
//      block, and the gap it names is one upstream's moveBlock accepts.
// The DOM half (toggle, drag, double-click, Escape) is
// scripts/test-beta-lighttable-browser.mjs.

import { moveBlock } from '../slides/src/editor/slidesel.ts'
import * as lt from '../slides/src/beta/lighttable.ts'

let failures = 0, checks = 0
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }

type S = { id: string; stateOf?: string }
const plain = (n: number): S[] => Array.from({ length: n }, (_, i) => ({ id: String(i + 1) }))
const ids = (s: S[]) => s.map((x) => x.id).join(',')
/** `n` boxes of w×h in rows of `cols`, 20px apart, left to right (or right to left). */
const grid = (n: number, cols: number, o: { w?: number; h?: number; rtl?: boolean; small?: number[] } = {}): lt.Box[] => {
  const w = o.w ?? 200, h = o.h ?? 120
  return Array.from({ length: n }, (_, i) => {
    const col = i % cols, row = Math.floor(i / cols)
    const x = o.rtl ? (cols - 1 - col) * (w + 20) : col * (w + 20)
    const k = o.small?.includes(i) ? 0.84 : 1 // a state renders smaller, top-aligned
    const left = o.rtl ? x + w * (1 - k) : x
    return { left, top: row * (h + 20), right: left + w * k, bottom: row * (h + 20) + h * k }
  })
}

console.log('\nthumbnail width')
{
  ok(lt.thumbBase(188, false) === 136 && lt.thumbBase(110, false) === 96, 'in the list it follows the panel, as upstream computes it (188 → 136, floor 96)')
  ok(lt.thumbBase(188, true) === lt.thumbBase(400, true) && lt.thumbBase(188, true) >= 160, `in the grid it is one fixed width, whatever the panel (${lt.thumbBase(188, true)})`)
}

console.log('\nrows')
{
  ok(JSON.stringify(lt.rows(grid(8, 4))) === '[[0,1,2,3],[4,5,6,7]]', 'eight boxes four across are two rows')
  ok(JSON.stringify(lt.rows(grid(5, 4))) === '[[0,1,2,3],[4]]', 'a short last row')
  ok(JSON.stringify(lt.rows(grid(3, 1))) === '[[0],[1],[2]]', 'one column is one row each')
  ok(JSON.stringify(lt.rows(grid(8, 4, { small: [2, 6] }))) === '[[0,1,2,3],[4,5,6,7]]', 'a smaller, top-aligned state box stays in its row')
  ok(JSON.stringify(lt.rows([])) === '[]', 'no boxes, no rows')
}

console.log('\nthe gap under the pointer')
{
  const s = plain(8), r = grid(8, 4)
  // AE9: slides 2 and 5 dragged between 7 and 8
  const g = lt.gapAt(r, s, (r[6].right + r[7].left) / 2, 200)
  ok(g === 7, `between the seventh and eighth thumbnails is gap 7 (${g})`)
  ok(ids(moveBlock(s, [1, 4], g)) === '1,3,4,6,7,2,5,8', `and slides 2 and 5 dropped there give 1,3,4,6,7,2,5,8 (${ids(moveBlock(s, [1, 4], g))})`)
  ok(lt.gapAt(r, s, r[0].left - 5, 10) === 0, 'left of the first thumbnail is gap 0')
  ok(lt.gapAt(r, s, r[2].left + 10, 10) === 2 && lt.gapAt(r, s, r[2].right - 10, 10) === 3, 'the left half of a thumbnail is the gap before it, the right half the gap after')
  const endOfRow = lt.gapAt(r, s, r[3].right + 15, 10), startOfNext = lt.gapAt(r, s, r[4].left - 5, 200)
  ok(endOfRow === 4 && startOfNext === 4, `past the end of a row and before the start of the next are the same gap (${endOfRow}, ${startOfNext})`)
  ok(lt.gapAt(r, s, r[7].right + 30, 200) === 8 && lt.gapAt(r, s, 400, 900) === 8, 'past the last thumbnail, or below every row, is the end')
  ok(lt.gapAt(r, s, 400, -50) === lt.gapAt(r, s, 400, 10), 'above the first row counts as the first row')
  ok(lt.gapAt(r, s, 100, 130) === lt.gapAt(r, s, 100, 110), 'in the space between two rows the nearer row decides')
  ok(lt.gapAt(grid(1, 4), plain(1), 50, 10) === 0 && lt.gapAt(grid(1, 4), plain(1), 150, 10) === 1, 'a one-slide deck has a gap either side')
  ok(lt.gapAt([], [], 10, 10) === 0, 'an empty grid has gap 0')
  ok(lt.gaps(s).includes(lt.gapAt(r, s, Number.NaN, 10)) && lt.gaps(s).includes(lt.gapAt(r, s, 10, Number.NaN)), 'a pointer that is not a number still names a legal gap')
  // right to left: the same boxes mirrored, the same gaps
  const rr = grid(8, 4, { rtl: true })
  ok(lt.gapAt(rr, s, (rr[6].left + rr[7].right) / 2, 200, true) === 7, 'right to left: between the seventh and eighth is still gap 7')
  ok(lt.gapAt(rr, s, rr[0].right + 5, 10, true) === 0 && lt.gapAt(rr, s, rr[3].left - 15, 10, true) === 4, 'right to left: before the first is gap 0, past the row is gap 4')
}

console.log('\nstates stay with their parent')
{
  // 1, 2, 3 (with states 3a 3b), 4, 5
  const s: S[] = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '3a', stateOf: '3' }, { id: '3b', stateOf: '3' }, { id: '4' }, { id: '5' }]
  const r = grid(7, 4, { small: [3, 4] })
  ok(JSON.stringify(lt.gaps(s)) === '[0,1,2,5,6,7]', `the legal gaps skip the places inside a unit (${lt.gaps(s)})`)
  const overState = [r[3].left + 5, (r[3].left + r[3].right) / 2 + 5, r[4].left + 5].map((x, i) => lt.gapAt(r, s, x, i < 2 ? 10 : 200))
  ok(overState.every((g) => g === 5 || g === 2), `a pointer over a state never names a gap inside the unit (${overState})`)
  ok(lt.gapAt(r, s, (r[2].right + r[3].left) / 2, 10) !== 3, 'between a parent and its first state is not a gap')
  for (let x = -20; x <= 900; x += 7) for (const y of [10, 200]) {
    const g = lt.gapAt(r, s, x, y)
    if (!lt.gaps(s).includes(g)) { ok(false, `every pointer names a legal gap (x=${x}, y=${y} → ${g})`); break }
  }
  ok(true, 'every pointer over this grid names a legal gap')
  // a multi-drag: 2 and the parent 3, dropped at the end
  const moved = moveBlock(s, [1, 2], lt.gapAt(r, s, r[6].right + 30, 200))
  ok(ids(moved) === '1,4,5,2,3,3a,3b', `2 and 3 dropped at the end: the states follow their parent (${ids(moved)})`)
  // dropping something else onto the unit never splits it
  const into = moveBlock(s, [0], lt.gapAt(r, s, r[3].left + 5, 10))
  ok(/3,3a,3b/.test(ids(into)), `a slide dropped over a state lands outside the unit (${ids(into)})`)
}

console.log('\nthe drop bar')
{
  const s = plain(8), r = grid(8, 4)
  const b = lt.barFor(r, s, 7, 200)
  ok(!!b && b.x > r[6].right && b.x < r[7].left && b.top === r[7].top && b.height === 120, `gap 7 draws between the seventh and eighth, as tall as the row (${JSON.stringify(b)})`)
  const atEnd = lt.barFor(r, s, 4, 10), atStart = lt.barFor(r, s, 4, 200)
  ok(!!atEnd && atEnd.x > r[3].right && atEnd.top === r[3].top, 'gap 4 with the pointer on the first row draws after the row\'s last thumbnail')
  ok(!!atStart && atStart.x < r[4].left && atStart.top === r[4].top, 'gap 4 with the pointer on the second row draws before the row\'s first')
  const last = lt.barFor(r, s, 8, 200)
  ok(!!last && last.x > r[7].right, 'the end draws after the last thumbnail')
  ok(lt.barFor([], [], 0, 0) === null, 'an empty grid draws no bar')
  const rr = grid(8, 4, { rtl: true })
  const br = lt.barFor(rr, s, 7, 200, true)
  ok(!!br && br.x < rr[6].left && br.x > rr[7].right, 'right to left: gap 7 draws between the seventh and eighth')
}

console.log('\nthe arrows')
{
  const r = grid(10, 4)
  ok(lt.neighbour(r, 1, 'ArrowRight') === 2 && lt.neighbour(r, 1, 'ArrowLeft') === 0, 'left and right step through the grid')
  ok(lt.neighbour(r, 3, 'ArrowRight') === 4 && lt.neighbour(r, 4, 'ArrowLeft') === 3, 'and wrap across rows in reading order')
  ok(lt.neighbour(r, 1, 'ArrowDown') === 5 && lt.neighbour(r, 5, 'ArrowUp') === 1, 'up and down keep the column')
  ok(lt.neighbour(r, 7, 'ArrowDown') === 9, 'down into a short row lands on its nearest thumbnail')
  ok(lt.neighbour(r, 0, 'ArrowLeft') === 0 && lt.neighbour(r, 0, 'ArrowUp') === 0 && lt.neighbour(r, 9, 'ArrowRight') === 9 && lt.neighbour(r, 9, 'ArrowDown') === 9, 'the edges hold')
  ok(lt.neighbour(grid(10, 4, { rtl: true }), 1, 'ArrowLeft', true) === 2 && lt.neighbour(grid(10, 4, { rtl: true }), 1, 'ArrowRight', true) === 0, 'right to left: the left arrow goes on, the right arrow back')
  ok(lt.neighbour(r, 42, 'ArrowRight') === 42 && lt.neighbour([], 0, 'ArrowRight') === 0, 'a thumbnail that is not there stays put')
}

console.log('\nthe keyboard move')
{
  const s = plain(8)
  const later = lt.keyMove(s, [1, 4], 1)
  ok(later !== null && ids(moveBlock(s, [1, 4], later!)) === '1,3,4,6,2,5,7,8', `two selected slides one gap later: as a block, after the next slide (${later === null ? 'null' : ids(moveBlock(s, [1, 4], later))})`)
  const earlier = lt.keyMove(s, [1, 4], -1)
  ok(earlier !== null && ids(moveBlock(s, [1, 4], earlier!)) === '2,5,1,3,4,6,7,8', `one gap earlier: before the previous slide (${earlier === null ? 'null' : ids(moveBlock(s, [1, 4], earlier))})`)
  const one = lt.keyMove(s, [2], 1)
  ok(one !== null && ids(moveBlock(s, [2], one!)) === '1,2,4,3,5,6,7,8', 'one slide later swaps it with the next')
  ok(lt.keyMove(s, [7], 1) === null && lt.keyMove(s, [0], -1) === null, 'the last slide cannot go later, the first cannot go earlier')
  const gather = lt.keyMove(s, [5, 7], 1)
  ok(gather !== null && ids(moveBlock(s, [5, 7], gather!)) === '1,2,3,4,5,7,6,8', `a split selection at the end still gathers (${gather === null ? 'null' : ids(moveBlock(s, [5, 7], gather))})`)
  ok(lt.keyMove(s, [], 1) === null && lt.keyMove([], [0], 1) === null, 'nothing selected, nothing to move')
  // units: a parent with states moves past a whole unit, and is passed as one
  const u: S[] = [{ id: '1' }, { id: '2' }, { id: '2a', stateOf: '2' }, { id: '3' }, { id: '3a', stateOf: '3' }, { id: '4' }]
  const past = lt.keyMove(u, [1], 1)
  ok(past !== null && ids(moveBlock(u, [1], past!)) === '1,3,3a,2,2a,4', `a parent goes past the next parent AND its states (${past === null ? 'null' : ids(moveBlock(u, [1], past))})`)
  const back = lt.keyMove(u, [5], -1)
  ok(back !== null && ids(moveBlock(u, [5], back!)) === '1,2,2a,4,3,3a', `and earlier, before a whole unit (${back === null ? 'null' : ids(moveBlock(u, [5], back))})`)
  const viaState = lt.keyMove(u, [2], 1)
  ok(viaState !== null && ids(moveBlock(u, [2], viaState!)) === '1,3,3a,2,2a,4', 'a selection that names a state moves its parent\'s unit')
  for (const sel of [[0], [1], [3], [5], [0, 3], [1, 5]]) for (const dir of [-1, 1] as const) {
    const g = lt.keyMove(u, sel, dir)
    if (g !== null && !lt.gaps(u).includes(g)) ok(false, `keyMove names a legal gap (${sel} ${dir} → ${g})`)
  }
  ok(true, 'every keyboard move names a legal gap')
  // a state whose parent is gone heads its own unit (slidesel.ts parentOf), so the place before it is a gap
  const orphan: S[] = [{ id: 'x', stateOf: 'gone' }, { id: '1' }, { id: '2' }]
  ok(JSON.stringify(lt.gaps(orphan)) === '[0,1,2,3]', `an orphaned state is a unit of its own (${lt.gaps(orphan)})`)
  const g0 = lt.keyMove(orphan, [1], -1)
  ok(g0 === 0 && lt.gaps(orphan).includes(g0) && ids(moveBlock(orphan, [1], g0)) === '1,x,2', 'and a slide can be moved before it')
}

console.log('\nindependent adversarial cases (U14, R16, AE9)')
{
  // A legal unit can wrap over a row boundary. A marker after the first row
  // must not advertise an insertion inside that unit, even if its data-gap
  // correctly names the place after the last state on the following row.
  // This also tests RTL without assuming that "after" means screen-right.
  const s: S[] = [
    { id: '1' }, { id: '2' }, { id: 'P' },
    { id: 'P1', stateOf: 'P' }, { id: 'P2', stateOf: 'P' }, { id: '6' },
  ]
  const observations = [false, true].map((rtl) => {
    const r = grid(s.length, 4, { rtl, small: [3, 4] })
    const x = rtl ? r[3].left - 10 : r[3].right + 10
    const gap = lt.gapAt(r, s, x, 30, rtl)
    const bar = lt.barFor(r, s, gap, 30, rtl)
    // Gap 5 is on row two, between P2 and 6. It does not touch row one.
    const left = Math.min(r[4].right, r[5].right)
    const right = Math.max(r[4].left, r[5].left)
    return { rtl, gap, bar, correct: gap === 5 && !!bar &&
      bar.top === r[5].top && bar.x > left && bar.x < right }
  })
  ok(observations.every((o) => o.correct),
    `ADVERSARIAL wrapped-state drop bar marks the actual legal boundary: ${JSON.stringify(observations)}`)
}
{
  // slidesel explicitly supports states that have drifted from their parent.
  // Selecting two parents must gather each parent's states behind THAT parent,
  // not just gather every selected index in its old document order.
  const s: S[] = [
    { id: 'A' }, { id: 'B' }, { id: 'C' },
    { id: 'A1', stateOf: 'A' }, { id: 'D' }, { id: 'E' },
  ]
  const r = grid(s.length, 3, { small: [3] })
  const gap = lt.gapAt(r, s, 900, 900)
  const before = JSON.stringify(s)
  const moved = moveBlock(s, [0, 1], gap)
  ok(gap === s.length && ids(moved) === 'C,D,E,A,A1,B' && JSON.stringify(s) === before,
    `ADVERSARIAL multi-drag gathers a drifted state directly after its parent: expected C,D,E,A,A1,B, got ${ids(moved)}`)

  // Independently of moveBlock's ordering, the target must be before D:
  // A and B move past the next unselected PARENT C, not past both C and D.
  // A1's old index must not make D look like the next unit after A/B.
  const later = lt.keyMove(s, [0, 1], 1)
  ok(later === 4,
    `ADVERSARIAL keyboard move counts parents rather than a drifted state's index: expected gap 4 (before D), got ${later}`)
}
{
  // AE9 in both directions and at every possible wrapping width, including
  // the 7/8 gap at a row break. Assert order and identity preservation, not
  // merely membership in gaps(). No product state is changed by this rig.
  const s = plain(8)
  const attempts: string[] = []
  for (const rtl of [false, true]) for (let cols = 1; cols <= 8; cols++) {
    const r = grid(s.length, cols, { rtl })
    const x = rtl ? r[7].right + 5 : r[7].left - 5
    const gap = lt.gapAt(r, s, x, r[7].top + 20, rtl)
    const moved = moveBlock(s, [1, 4], gap)
    if (gap !== 7 || ids(moved) !== '1,3,4,6,7,2,5,8' ||
      moved.some((slide) => !s.includes(slide))) attempts.push(`${rtl}/${cols}: gap ${gap}, ${ids(moved)}`)
  }
  ok(!attempts.length, `ADVERSARIAL AE9 is invariant across one-to-eight columns and RTL: ${attempts.join('; ') || '16 layouts agree'}`)
}
{
  const s: S[] = [{ id: 'A' }, { id: 'A1', stateOf: 'A' }, { id: 'B' }, { id: 'B1', stateOf: 'B' }]
  const before = JSON.stringify(s)
  const all = [0, 1, 2, 3]
  ok(lt.keyMove(s, all, -1) === null && lt.keyMove(s, all, 1) === null &&
    lt.keyMove(s, [0], -1) === null && lt.keyMove(s, [2], 1) === null && JSON.stringify(s) === before,
    'ADVERSARIAL all-selected and end-unit keyboard moves are no-ops without mutating the deck')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
