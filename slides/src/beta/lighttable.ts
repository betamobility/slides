// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Beta build: the light table (2026-10-13-2236 plan, U14, KTD12). The slide
// list, laid over the canvas as a wrapping grid, for arranging many slides at
// once.
//
// It is NOT a second slide list. The thumbnails, the selection (Shift and
// Cmd/Ctrl click), the drag payload and the move itself are upstream's
// (editor.ts makeThumb / wireThumbDrag / dropSlides, editor/slidesel.ts). This
// file adds what a grid needs and a column does not:
//   - geometry: which gap a pointer is over when thumbnails sit in rows, and
//     where to draw the bar that shows it (pure, scripts/test-beta-lighttable.ts);
//   - the DOM around it: a class on `.ed-sidebar`, a drop bar, double-click to
//     open a slide, Escape back to the list, arrows across the grid and
//     Alt+arrow to move the selection one gap.
// editor.ts hands over what it owns through LightTableHost and calls in from
// marked hooks; nothing here reaches into the editor.
//
// THE UNIT IS A PARENT WITH ITS STATES, as in slidesel.ts: a gap is a place
// before a parent slide, or the end. There is no gap between a parent and its
// states, so nothing can be dropped there.

import { expand, moveBlock, parentOf, parents, type SlideLike } from '../editor/slidesel.ts'

// ---- pure parts (scripts/test-beta-lighttable.ts) ----------------------------

export interface Box { left: number; top: number; right: number; bottom: number }

/** Thumbnail width in the grid. One size: the grid is for seeing many at once. */
export const GRID_THUMB = 208

/** Thumbnail width: the grid's own, or the list's, which follows the panel. */
export const thumbBase = (panelLeft: number, grid: boolean): number =>
  grid ? GRID_THUMB : Math.max(96, panelLeft - 52)

/** Thumbnail indices grouped into rows, top to bottom, in the order given. A
 *  box starts a new row when it begins below the middle of the row so far. */
export function rows(rects: Box[]): number[][] {
  const out: number[][] = []
  let mid = 0
  rects.forEach((r, i) => {
    const row = out[out.length - 1]
    if (!row || r.top >= mid) {
      out.push([i])
      mid = (r.top + r.bottom) / 2
    } else row.push(i)
  })
  return out
}

/** A slide that heads a unit: a parent, or a state whose parent is gone (slidesel.ts treats that as its own unit). */
const heads = (slides: SlideLike[], i: number): boolean => parentOf(slides, i) === i

/** Every legal drop index: before each unit, and the end. */
export function gaps(slides: SlideLike[]): number[] {
  const out: number[] = []
  slides.forEach((_, i) => { if (heads(slides, i)) out.push(i) })
  out.push(slides.length)
  return out
}

/** The first legal gap at or after `i` (a place inside a unit becomes the end of the unit). */
function legal(slides: SlideLike[], i: number): number {
  let g = Math.max(0, Math.min(slides.length, i))
  while (g < slides.length && !heads(slides, g)) g++
  return g
}

/** The row a y coordinate belongs to: the one it is inside, else the nearest. */
function rowAt(rects: Box[], grouped: number[][], y: number): number {
  let best = 0, bestD = Infinity
  grouped.forEach((row, k) => {
    const top = Math.min(...row.map((i) => rects[i].top)), bottom = Math.max(...row.map((i) => rects[i].bottom))
    const d = y < top ? top - y : y > bottom ? y - bottom : 0
    if (d < bestD) { bestD = d; best = k }
  })
  return best
}

/**
 * The drop index for a pointer at (x, y): `moveBlock`'s "insert before this
 * slide", or `slides.length` for the end. Found over all thumbnails by row,
 * so the space past the end of one row and the space before the start of the
 * next are the same gap. `rtl`: thumbnails run right to left.
 */
export function gapAt(rects: Box[], slides: SlideLike[], x: number, y: number, rtl = false): number {
  const n = Math.min(rects.length, slides.length)
  if (!n) return 0
  const grouped = rows(rects.slice(0, n))
  // below every row is the end, wherever the pointer is across
  if (y > Math.max(...grouped[grouped.length - 1].map((i) => rects[i].bottom))) return slides.length
  const row = grouped[rowAt(rects, grouped, Number.isFinite(y) ? y : 0)]
  // the first thumbnail in the row whose middle the pointer has not passed
  const hit = row.find((i) => {
    const mid = (rects[i].left + rects[i].right) / 2
    return rtl ? x > mid : x < mid
  })
  return legal(slides, hit ?? row[row.length - 1] + 1)
}

/**
 * Where to draw the bar for `gap`: its x (the middle of the space), the top
 * and the height of the thumbnail it stands beside. `y` is the pointer's, and
 * decides which side of a row break the bar is drawn on. Null when there is
 * nothing to stand beside.
 */
export function barFor(rects: Box[], slides: SlideLike[], gap: number, y: number, rtl = false): { x: number; top: number; height: number } | null {
  const n = Math.min(rects.length, slides.length)
  if (!n) return null
  const grouped = rows(rects.slice(0, n))
  const row = grouped[gap >= slides.length ? grouped.length - 1 : rowAt(rects, grouped, Number.isFinite(y) ? y : 0)]
  const SPACE = 9 // half the space between two thumbnails
  const before = (i: number) => ({ x: rtl ? rects[i].right + SPACE : rects[i].left - SPACE, top: rects[i].top, height: rects[i].bottom - rects[i].top })
  const after = (i: number) => ({ x: rtl ? rects[i].left - SPACE : rects[i].right + SPACE, top: rects[i].top, height: rects[i].bottom - rects[i].top })
  // beside a thumbnail on the pointer's own row when the gap touches that row
  if (gap < n && row.includes(gap)) return before(gap)
  const last = row[row.length - 1]
  // (only for a plain row break. When the unit under the pointer runs on into the next
  // row, the slides land after its last state there, and that is where the bar goes.)
  if (gap === last + 1) return after(last)
  return gap < n ? before(gap) : after(n - 1)
}

export type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'

/** The thumbnail an arrow key moves to from `from`; `from` itself at an edge. */
export function neighbour(rects: Box[], from: number, key: ArrowKey, rtl = false): number {
  if (!Number.isInteger(from) || from < 0 || from >= rects.length) return from
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const step = (key === 'ArrowRight') !== rtl ? 1 : -1
    return Math.max(0, Math.min(rects.length - 1, from + step))
  }
  const grouped = rows(rects)
  const k = grouped.findIndex((row) => row.includes(from))
  const to = grouped[k + (key === 'ArrowDown' ? 1 : -1)]
  if (!to) return from
  const mid = (rects[from].left + rects[from].right) / 2
  return to.reduce((best, i) => (Math.abs((rects[i].left + rects[i].right) / 2 - mid) < Math.abs((rects[best].left + rects[best].right) / 2 - mid) ? i : best), to[0])
}

/**
 * The drop index that moves the selection one gap later (`dir` 1) or earlier
 * (-1) as a block: past the next unit that is not selected, or before the
 * previous one. A split selection gathers on the way. Null when the move
 * would change nothing.
 */
export function keyMove(slides: SlideLike[], selected: Iterable<number>, dir: -1 | 1): number | null {
  const sel = [...selected]
  const moving = new Set(expand(slides, sel))
  if (!moving.size) return null
  const free = parents(slides, slides.map((_, i) => i)).filter((p) => !moving.has(p))
  let drop: number
  if (dir > 0) {
    // The end of the selection is where its last unit ends IN PLACE: the parent
    // and the states right behind it. A state that drifted further down the
    // deck is carried along, but it is not where the block stands.
    const max = Math.max(...parents(slides, moving).map((p) => {
      let e = p
      while (e + 1 < slides.length && slides[e + 1].stateOf === slides[p].id) e++
      return e
    }))
    const k = free.findIndex((p) => p > max)
    // past that unit: before the free parent after it, or the end
    drop = k < 0 ? slides.length : free[k + 1] ?? slides.length
  } else {
    const min = Math.min(...parents(slides, moving))
    const before = free.filter((p) => p < min)
    drop = before.length ? before[before.length - 1] : free[0] ?? slides.length
  }
  // asked with the selection as the caller holds it: that is what the drop is made with
  return moveBlock(slides, sel, drop) === slides ? null : drop
}

// ---- the DOM half (editor.ts) ------------------------------------------------

const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="7" height="6" rx="1.5"/><rect x="14" y="4" width="7" height="6" rx="1.5"/><rect x="3" y="14" width="7" height="6" rx="1.5"/><rect x="14" y="14" width="7" height="6" rx="1.5"/></svg>'
const PAYLOAD = 'text/bento-slide'

/** What the editor hands over. Everything the grid does goes through these. */
export interface LightTableHost {
  sidebar: HTMLElement
  slides(): SlideLike[]
  current(): number
  /** The multi-selection (parent indices), possibly empty. */
  selection(): number[]
  goTo(index: number): void
  /** Upstream's drop: move the payload's units to sit before `index`, as one commit. */
  drop(payload: string, index: number): void
  /** Render the thumbnails again (their width follows the mode), and anything that shows the list's state. */
  rebuild(): void
  /** Drop the canvas selection: the canvas is covered, and keys must not act on what cannot be seen. */
  deselect(): void
  /** False where the slide list is a drawer (a phone): the grid is not offered there. */
  allowed(): boolean
  rtl(): boolean
  /** The label and tooltip, translated by the caller at build time. */
  label: string
}

export class LightTable {
  /** In memory for the session, like the drawer state; never stored. */
  on: boolean
  readonly button: HTMLButtonElement
  private readonly host: LightTableHost
  private bar: HTMLElement | null = null
  /** Whether the list was collapsed when the grid was turned on; put back on leaving. */
  private wasCollapsed = false
  /** The last two presses on the grid: which slide, and whether on a thumbnail's own tools. */
  private presses: { id: string | null; tool: boolean }[] = []
  /** The active thumbnail the list last scrolled to. */
  private shown = -1

  constructor(host: LightTableHost, on = false, signal?: AbortSignal) {
    this.host = host
    this.on = on && host.allowed()
    const b = document.createElement('button')
    b.className = 'ed-btn ed-lt-toggle'
    b.type = 'button'
    // Icon only, like undo and redo beside it: a label would cost the bar its
    // other labels sooner. Folded into a menu, the bar borrows the tooltip.
    b.innerHTML = ICON
    b.title = host.label
    b.setAttribute('aria-label', host.label)
    b.addEventListener('click', () => {
      // pressed from inside a folded menu: close it, or its open state would hold Escape
      b.closest('.ed-dropdown')?.classList.remove('open')
      this.toggle()
    })
    this.button = b
    const sb = host.sidebar
    // Capture phase: upstream's per-thumbnail handlers mean "insert before
    // this thumbnail" and paint the thumbnail; in the grid the gap decides.
    // Only a slide drag is taken. A file dragged in is left alone, so the
    // document-level handler still opens it as a deck.
    sb.addEventListener('dragover', (ev) => this.dragOver(ev), { capture: true, signal })
    sb.addEventListener('drop', (ev) => this.dropped(ev), { capture: true, signal })
    sb.addEventListener('dragleave', (ev) => { if (!sb.contains(ev.relatedTarget as Node | null)) this.clearBar() }, { signal })
    sb.addEventListener('dragend', () => this.clearBar(), { signal })
    sb.addEventListener('mousedown', (ev) => this.pressed(ev), { capture: true, signal })
    sb.addEventListener('dblclick', (ev) => this.opened(ev), { signal })
    // a window made narrow enough for the list to become a drawer leaves the grid
    window.addEventListener('resize', () => { if (this.on && !host.allowed()) this.leave() }, { signal })
    this.paint()
  }

  private paint(): void {
    this.host.sidebar.classList.toggle('ed-lighttable', this.on)
    this.button.setAttribute('aria-pressed', String(this.on))
    this.button.classList.toggle('active', this.on)
  }

  toggle(): void {
    if (this.on) this.leave()
    else this.enter()
  }

  enter(): void {
    if (this.on || !this.host.allowed()) return
    this.on = true
    this.shown = -1
    this.presses = []
    // the list may be collapsed; the grid is the list, so it has to show
    this.wasCollapsed = this.host.sidebar.classList.contains('ed-collapsed')
    this.host.sidebar.classList.remove('ed-collapsed')
    this.host.deselect()
    this.paint()
    this.host.rebuild()
  }

  /** Back to the list, on slide `at` when one is named. The selection is kept. */
  leave(at?: number): void {
    if (!this.on) return
    this.on = false
    this.clearBar()
    this.host.sidebar.classList.toggle('ed-collapsed', this.wasCollapsed)
    this.wasCollapsed = false
    this.paint()
    this.host.rebuild()
    if (at != null && at >= 0) this.host.goTo(at)
  }

  private thumbs(): HTMLElement[] {
    return [...this.host.sidebar.querySelectorAll<HTMLElement>('.ed-thumb')]
  }

  /** Thumbnail boxes in the sidebar's own scrolled coordinates. */
  private boxes(): Box[] {
    const sb = this.host.sidebar
    const o = sb.getBoundingClientRect()
    return this.thumbs().map((n) => {
      const r = n.getBoundingClientRect()
      return { left: r.left - o.left + sb.scrollLeft, top: r.top - o.top + sb.scrollTop, right: r.right - o.left + sb.scrollLeft, bottom: r.bottom - o.top + sb.scrollTop }
    })
  }

  private point(ev: MouseEvent): { x: number; y: number } {
    const sb = this.host.sidebar
    const o = sb.getBoundingClientRect()
    return { x: ev.clientX - o.left + sb.scrollLeft, y: ev.clientY - o.top + sb.scrollTop }
  }

  private isSlideDrag(ev: DragEvent): boolean {
    return this.on && !!ev.dataTransfer && [...ev.dataTransfer.types].includes(PAYLOAD)
  }

  private dragOver(ev: DragEvent): void {
    if (!this.isSlideDrag(ev)) return
    ev.preventDefault()
    ev.stopPropagation()
    ev.dataTransfer!.dropEffect = 'move'
    const boxes = this.boxes(), slides = this.host.slides(), p = this.point(ev)
    const gap = gapAt(boxes, slides, p.x, p.y, this.host.rtl())
    const at = barFor(boxes, slides, gap, p.y, this.host.rtl())
    if (!at) return this.clearBar()
    if (!this.bar || !this.bar.isConnected) {
      this.bar = document.createElement('div')
      this.bar.className = 'ed-lt-bar'
      this.host.sidebar.appendChild(this.bar)
    }
    this.bar.dataset.gap = String(gap)
    this.bar.style.left = `${Math.round(at.x) - 2}px`
    this.bar.style.top = `${Math.round(at.top)}px`
    this.bar.style.height = `${Math.round(at.height)}px`
  }

  private dropped(ev: DragEvent): void {
    if (!this.isSlideDrag(ev)) return
    ev.preventDefault()
    ev.stopPropagation()
    const p = this.point(ev)
    const gap = gapAt(this.boxes(), this.host.slides(), p.x, p.y, this.host.rtl())
    this.clearBar()
    this.host.drop(ev.dataTransfer!.getData(PAYLOAD), gap)
  }

  private clearBar(): void {
    this.bar?.remove()
    this.bar = null
    for (const n of this.thumbs()) n.classList.remove('drop', 'dragging')
  }

  /**
   * Upstream scrolls the active thumbnail into view every time the selection
   * repaints. In a column that is harmless; in a scrolled grid a press on a
   * thumbnail far from the active one made the grid jump under the pointer,
   * and the second click of a double-click opened another slide. True when
   * the scroll should be skipped: the grid is on and the active slide is the
   * one already scrolled to.
   */
  holdsScroll(active: number): boolean {
    if (!this.on) return false
    if (active === this.shown) return true
    this.shown = active
    return false
  }

  private slideIdAt(target: EventTarget | null): string | null {
    const thumb = target instanceof Element ? target.closest<HTMLElement>('.ed-thumb') : null
    return thumb ? this.host.slides()[Number(thumb.dataset.index)]?.id ?? null : null
  }

  private pressed(ev: MouseEvent): void {
    if (!this.on) return
    this.presses = [...this.presses.slice(-1), { id: this.slideIdAt(ev.target), tool: ev.target instanceof Element && !!ev.target.closest('.ed-thumb-tools') }]
  }

  private opened(ev: MouseEvent): void {
    if (!this.on) return
    const thumb = ev.target instanceof Element ? ev.target.closest<HTMLElement>('.ed-thumb') : null
    if (!thumb) return
    // Both clicks have to be on this slide's thumbnail, and neither on its
    // tools: a double-click on Duplicate or Delete rebuilds the grid between
    // the clicks, and whatever thumbnail lands under the pointer is not one
    // anybody asked to open.
    const id = this.host.slides()[Number(thumb.dataset.index)]?.id
    if (this.presses.length < 2 || this.presses.some((p) => p.tool || p.id !== id)) return
    this.leave(Number(thumb.dataset.index))
  }

  /**
   * A key press while the grid is on. True when it was taken.
   * Escape leaves, on the first selected slide when there is a selection;
   * an arrow walks the grid; Alt+arrow moves the selection (or the current
   * slide) one gap, as one undoable change.
   */
  key(ev: KeyboardEvent): boolean {
    if (!this.on) return false
    if (ev.key === 'Escape') {
      const sel = this.host.selection()
      this.leave(sel.length ? Math.min(...sel) : undefined)
      return true
    }
    if (!ev.key.startsWith('Arrow') || ev.metaKey || ev.ctrlKey || ev.shiftKey) return false
    ev.preventDefault()
    const key = ev.key as ArrowKey
    const cur = this.host.current()
    if (ev.altKey) {
      const dir = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : (key === 'ArrowRight') !== this.host.rtl() ? 1 : -1
      // the painted selection moves; with none, the slide the grid is on
      const sel = this.host.selection().length ? this.host.selection() : [cur]
      const drop = keyMove(this.host.slides(), sel, dir)
      if (drop !== null) this.host.drop(JSON.stringify(sel), drop)
      return true
    }
    const to = neighbour(this.boxes(), cur, key, this.host.rtl())
    if (to !== cur) this.host.goTo(to)
    return true
  }
}
