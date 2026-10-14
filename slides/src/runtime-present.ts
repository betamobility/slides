// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Beta build: runtime slides in present mode (docs/plans/2026-09-14-001, U4).
// Everywhere else a runtime slide is its still; here the scene runs live in a
// sandboxed frame laid over that still. present.ts owns none of this: it
// calls the controller below from the places it already starts and stops
// media, and asks it first whenever an arrow key would change slide (fork
// rule 2, one call per upstream surface).
//
// THE FRAME. `sandbox="allow-scripts allow-forms"` with no same-origin: every
// deck is untrusted input, so a scene gets a screen and never this document.
//
// THE LIVE WINDOW (2026-10-13-2236 plan, U13). This file owns EVERY live frame
// in a show: a runtime slide's scene and a web embed's page. render.ts is told
// not to add embed frames here (`ownedFrames`), because frames added at render
// time load every page in the deck when the show starts. Instead the slide
// showing and its linear neighbours hold frames and every other slide is its
// still; a frame that leaves the window has `src` and `srcdoc` cleared.
// A neighbour's scene is mounted ahead of the show but told NOTHING: no
// bento:init until the show enters it, and the scene contract makes a scene
// wait for bento:init before it trusts any state. When the show leaves a
// scene its frame is replaced by a fresh one, so exactly one scene has ever
// been initialised, none keeps running behind the slide showing, and every
// entry starts the scene from the top, as it did before the window existed.
// A web embed gets a frame and no channel at all.
//
// THE CHANNEL (KTD3). Keys pressed inside a sandboxed frame never reach this
// window, and an opaque-origin frame cannot see the overlay's classes or
// localStorage, so everything crosses by postMessage:
//   shell → scene  bento:init {step, steps, props, reduceMotion}
//                  bento:step {index} · bento:props {values}
//                  bento:motion {reduce} · bento:assets {assets: {name: Blob}}
//   scene → shell  bento:ready · bento:navigate {dir: 'next'|'prev'|'exit'}
// Posts use targetOrigin '*' (the frame's origin is opaque, so nothing else
// matches it) and a message is accepted only when its `source` is the frame's
// own window. `ev.origin` is not filtered: it arrives as 'null' for every
// sandboxed frame, so it tells one scene from another page not at all.
// A message posted before the scene's script runs is simply lost, which is
// why nothing is sent until the scene says bento:ready.
//
// STEPS (KTD4) are counted from the declaration, and only while a scene is
// actually listening: a frame that never loaded, a URL page that does not
// speak the protocol, or a scene offline behind its still has no visible
// steps to walk, and arrows there must change slide or the show gets stuck.

import type { BentoDoc, EmbedElement, RuntimeSlide, Slide } from './model.ts'
import { inLinearFlow } from './model.ts'
import { netFetch, offlineEnabled } from '../../kernel/src/net.ts'
import { liveFrameAllowed } from './render.ts'
import { ASSET_NAME, isRuntimeSlide, runtimeSource } from './runtime.ts'

/** A frame that has reported nothing by then is removed; the still stays. */
const LOAD_TIMEOUT_MS = 10_000
/** Slides either side of the one showing that hold live frames. */
export const LIVE_WINDOW = 1
const HTTPS = /^https:\/\//i
const STORE_ID = /^[A-Za-z0-9]+$/

// ---- pure parts (scripts/test-beta-runtime.ts) -------------------------------

export type StepDir = 'next' | 'prev'

/** Forward entry lands on the first step, backward entry on the last. */
export const enterStep = (steps: number, forward: boolean): number => (!forward && steps > 0 ? steps - 1 : 0)

/** The step after a press, or null when the press leaves the slide. */
export function moveStep(steps: number, index: number, dir: StepDir): number | null {
  const to = dir === 'next' ? index + 1 : index - 1
  return to >= 0 && to < steps ? to : null
}

/**
 * The slide indices that hold live frames while `cur` shows: `cur`, and up to
 * `span` slides either side over the LINEAR flow (a state slide is nobody's
 * neighbour: the arrows skip it). A neighbour also has to be a section Reveal
 * lays out, which is index distance < viewDistance; past that the section is
 * `display:none` and a scene mounted there would measure a 0×0 screen.
 */
export function liveWindow(flow: boolean[], cur: number, viewDistance: number, span = LIVE_WINDOW): number[] {
  if (!Number.isInteger(cur) || cur < 0 || cur >= flow.length) return []
  const out = [cur]
  for (const dir of [-1, 1]) {
    let found = 0
    for (let i = cur + dir; i >= 0 && i < flow.length && found < span && Math.abs(i - cur) < viewDistance; i += dir) {
      if (flow[i]) { out.push(i); found++ }
    }
  }
  return out.sort((a, b) => a - b)
}

/** Reveal lays out a section while its distance is < viewDistance, so the window must be smaller. */
export const windowFits = (viewDistance: number): boolean => LIVE_WINDOW < viewDistance

/**
 * What lifts a frame's cover. A scene by bento:ready, or by `load` for a page
 * that never says it (a hosted page, a scene with no script). A web embed has
 * no channel, so only `load`.
 */
export const uncovers = (kind: 'scene' | 'embed', signal: 'ready' | 'load'): boolean =>
  signal === 'load' || kind === 'scene'

/** Declared defaults overlaid with what a presenter set. */
export function sceneProps(rt: RuntimeSlide): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const p of rt.props) {
    out[p.key] = rt.values && Object.prototype.hasOwnProperty.call(rt.values, p.key) ? rt.values[p.key] : p.default
  }
  return out
}

export interface InitMessage {
  type: 'bento:init'
  step: number
  steps: number
  props: Record<string, string | number>
  reduceMotion: boolean
}
export type ShellMessage =
  | InitMessage
  | { type: 'bento:step'; index: number }
  | { type: 'bento:props'; values: Record<string, string | number> }
  | { type: 'bento:motion'; reduce: boolean }
  | { type: 'bento:assets'; assets: Record<string, Blob> }
export type SceneMessage = { type: 'bento:ready' } | { type: 'bento:navigate'; dir: StepDir | 'exit' }

/** What a scene may say. Anything else, including our own types echoed back, is null. */
export function parseSceneMessage(data: unknown): SceneMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.type === 'bento:ready') return { type: 'bento:ready' }
  if (d.type === 'bento:navigate' && (d.dir === 'next' || d.dir === 'prev' || d.dir === 'exit')) return { type: 'bento:navigate', dir: d.dir }
  return null
}

/** A message counts only when it came from this frame's window. */
export const fromFrame = (ev: Pick<MessageEvent, 'source'>, win: Window | null | undefined): boolean =>
  !!win && ev.source === win

/**
 * Holds the channel shut until the scene has said bento:ready AND the show
 * has entered its slide. Before both, step, motion and props changes are
 * dropped (init is built when it is sent, so it carries their current values)
 * and fetched assets are held; then init goes first and the held assets
 * follow. A second ready (the scene reloaded itself) replays the same pair.
 * `entered` is false for a scene mounted ahead of the show.
 */
export class SceneChannel {
  private isReady = false
  private isIn: boolean
  private held: Record<string, Blob> | null = null
  private readonly post: (m: ShellMessage) => void
  private readonly init: () => InitMessage
  constructor(post: (m: ShellMessage) => void, init: () => InitMessage, entered = true) {
    this.post = post
    this.init = init
    this.isIn = entered
  }
  private get open(): boolean { return this.isReady && this.isIn }
  private hello(): void {
    this.post(this.init())
    if (this.held) this.post({ type: 'bento:assets', assets: this.held })
  }
  get live(): boolean { return this.open }
  ready(): void {
    this.isReady = true
    if (this.open) this.hello()
  }
  /** The show reached this scene's slide. Idempotent. */
  enter(): void {
    if (this.isIn) return
    this.isIn = true
    if (this.open) this.hello()
  }
  step(index: number): void { if (this.open) this.post({ type: 'bento:step', index }) }
  motion(reduce: boolean): void { if (this.open) this.post({ type: 'bento:motion', reduce }) }
  props(values: Record<string, string | number>): void { if (this.open) this.post({ type: 'bento:props', values }) }
  assets(assets: Record<string, Blob>): void {
    this.held = { ...(this.held ?? {}), ...assets }
    if (this.open) this.post({ type: 'bento:assets', assets })
  }
}

/**
 * The same-origin asset route for a deck opened from the store, or null. No
 * deck id means a file on disk, a Drive copy or a download: no Access cookie
 * to carry, so no request is made and the scene runs without its assets.
 */
export function assetUrl(storeId: string | null, name: string): string | null {
  if (!storeId || !STORE_ID.test(storeId) || !ASSET_NAME.test(name)) return null
  return `/d/${storeId}/assets/${name}`
}

/** R7: a URL override loads only over https and online (the offline switch is frameAllowed's). */
export const urlFrameAllowed = (url: string, env: { online: boolean }): boolean =>
  HTTPS.test(url) && env.online

/**
 * Whether any frame mounts. The offline switch refuses inline scenes too: the
 * sandbox stops a scene reaching this document, not the network, and a scene
 * is free to fetch, open a socket or send a beacon of its own (kernel net.ts
 * promises every network touch is blocked). No frame means the still stays
 * and no steps are counted, as for a frame that never loaded.
 */
export function frameAllowed(source: { html?: string; url?: string }, env: { offline: boolean; online: boolean }): boolean {
  if (env.offline) return false
  if (source.html != null) return true
  return typeof source.url === 'string' && urlFrameAllowed(source.url, { online: env.online })
}

/**
 * Only an inline (srcdoc) scene, which travelled inside the deck, is handed the
 * deck's Access-gated asset Blobs. A URL override is someone else's page: it,
 * or anything it navigates to, could say bento:ready and walk off with them.
 */
export const sceneGetsAssets = (source: { html?: string; url?: string }): boolean => source.html != null

// ---- the controller (present.ts) ---------------------------------------------

export interface RuntimeShow {
  /** Slide `idx` became current: its frames and its neighbours' are mounted,
   *  every other slide's are cleared. Idempotent for the slide already showing. */
  enter(idx: number, forward: boolean, named?: number | null): void
  /** Slide `idx` stopped being current: its scene is cleared, so it starts over next time. */
  leave(idx: number): void
  /** The sections were rebuilt under the show (a remote edit) with slide `idx`
   *  showing: mount again whatever the rebuild dropped, on the step it was on. */
  refresh(idx: number): void
  /** A section is being rebuilt: refresh once the caller has finished replacing
   *  nodes (a microtask on), however many sections it rebuilds in one go. */
  rebuilt(at: () => number): void
  /** An arrow press: true when it moved a step and the slide must stay. */
  next(): boolean
  prev(): boolean
  canNext(): boolean
  canPrev(): boolean
  /** A rail/grid jump to `idx`: that slide starts on step 0, even when already showing. */
  jump(idx: number): void
  /** The scene's step on the slide showing (the one it will open on, while it
   *  loads), or null when that slide mounted no scene. */
  step(): number | null
  /** An audience following a presenter: put the scene on slide `idx` at `step`
   *  (clamped). True when a scene on that slide took it, live or still loading. */
  follow(idx: number, step: number): boolean
  setReduceMotion(reduce: boolean): void
  dispose(): void
}

/** One live frame. A scene has a channel; a web embed has none. */
interface Held {
  key: string
  slideId: string
  frame: HTMLIFrameElement
  timer: number
  /** Give up on this frame: remove it and remember that it failed. */
  fail: () => void
  /** What the frame was built from. A remote edit that changes it makes the frame stale. */
  made: string
  scene: { channel: SceneChannel; steps: number; rt: RuntimeSlide; inline: boolean; fetched: boolean } | null
}

const SEP = '\u001f'
const DUP = '\u001e'

export function createRuntimeShow(
  doc: BentoDoc,
  slidesEl: HTMLElement,
  storeId: string | null,
  hooks: {
    goNext(): void; goPrev(): void; exit(): void; reduceMotion(): boolean
    /** Reveal's view distance, asked on every slide change. Absent: Reveal's default, 2. */
    viewDistance?(): number
  },
): RuntimeShow {
  const frames = new Map<string, Held>()
  /** Frames that reported nothing in time. Not mounted again until their slide
   *  leaves the window or the show enters it; else every slide change would retry. */
  const failed = new Set<string>()
  let current = -1
  /** The id of the slide at `current`. A remote edit can move a slide to another
   *  index under the show; it is still the same slide, on the same step. */
  let currentId: string | null = null
  /** The current slide's scene step: the one it is on, or will open on. */
  let stepNow = 0
  /** The slide a rail/grid click targeted; its next entry lands on step 0. */
  let jumpTo = -1
  let checked = false
  let pendingRefresh = false
  let disposed = false

  /**
   * A slide's key in the frame map: its id, which survives a move to another
   * index. A hand-written deck can repeat an id; the second and later copies
   * are told apart by their count, so each still gets its own frame.
   */
  const sid = (i: number): string | null => {
    const slide = doc.slides[i]
    if (!slide) return null
    let n = 0
    for (let k = 0; k < i; k++) if (doc.slides[k].id === slide.id) n++
    return n ? slide.id + DUP + n : slide.id
  }

  const drop = (h: Held) => {
    clearTimeout(h.timer)
    h.frame.removeAttribute('srcdoc')
    h.frame.removeAttribute('src')
    h.frame.remove()
    if (frames.get(h.key) === h) frames.delete(h.key)
  }

  /** The scene on the slide showing, or null (a detached frame is no scene). */
  const scene = (): Held | null => {
    // by id, not by index: a slide inserted before this one by a remote edit
    // moves it, and it is still the scene showing
    const h = currentId !== null ? frames.get(currentId) : undefined
    return h && h.scene && h.frame.isConnected ? h : null
  }

  const uncover = (h: Held) => { clearTimeout(h.timer); h.frame.style.visibility = '' }

  const onMessage = (ev: MessageEvent) => {
    let from: Held | null = null
    // a web embed has no channel: whatever its page posts is never read
    for (const h of frames.values()) if (h.scene && fromFrame(ev, h.frame.contentWindow)) { from = h; break }
    if (!from) return
    const msg = parseSceneMessage(ev.data)
    if (!msg) return
    if (msg.type === 'bento:ready') {
      if (uncovers('scene', 'ready')) uncover(from)
      from.scene!.channel.ready()
      return
    }
    // only the scene on the slide showing may move the show
    if (from !== scene()) return
    // The scene forwarded a key it does not use. Focus is inside the frame,
    // so the NEXT key would go there too; take it back first. window.focus()
    // alone does not move focus off a focused iframe element.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    window.focus()
    if (msg.dir === 'next') hooks.goNext()
    else if (msg.dir === 'prev') hooks.goPrev()
    else hooks.exit()
  }
  window.addEventListener('message', onMessage)

  /** Put `frame` on `host`, covered until it reports, removed if it never does. */
  const hold = (part: Omit<Held, 'fail'>, host: HTMLElement) => {
    const fail = () => { if (frames.get(h.key) === h) { drop(h); failed.add(h.key) } }
    const h: Held = Object.assign(part, { fail })
    h.timer = window.setTimeout(fail, LOAD_TIMEOUT_MS)
    h.frame.style.visibility = 'hidden'
    h.frame.addEventListener('load', () => uncover(h), { once: true })
    h.frame.addEventListener('error', fail, { once: true })
    frames.set(h.key, h)
    host.appendChild(h.frame)
  }

  const blank = (title: string): HTMLIFrameElement => {
    const frame = document.createElement('iframe')
    frame.className = 'bento-runtime-frame'
    frame.setAttribute('sandbox', 'allow-scripts allow-forms')
    frame.referrerPolicy = 'no-referrer'
    frame.title = title
    return frame
  }

  const mountScene = (slide: Slide, key: string, surface: HTMLElement) => {
    const rt = slide.runtime!
    const source = runtimeSource(slide, doc)
    // A frame mounted ahead of the show can be overtaken by a remote edit to
    // its slide (only the section SHOWING is rebuilt): what it was built from
    // is compared on every sync, and a stale frame is replaced.
    // Asked on every sync, not only at mount: the offline switch or the network
    // can change while a frame waits ahead of the show, and a frame the switch
    // would refuse now must not be the one the show enters.
    const allowed = !!source && frameAllowed(source, {
      offline: offlineEnabled(),
      online: typeof navigator === 'undefined' || navigator.onLine !== false,
    })
    const made = allowed ? JSON.stringify([source, rt.steps, rt.props, rt.values ?? null, rt.assets ?? null]) : ''
    const old = frames.get(key)
    if (old && old.made !== made) { drop(old); failed.delete(key) }
    if (frames.has(key) || failed.has(key)) return
    if (!allowed || !source) return
    const frame = blank(slide.name || slide.id)
    const steps = rt.steps
    const h: Omit<Held, 'fail'> = {
      key, slideId: key, frame, timer: 0, made,
      scene: {
        steps, rt, inline: sceneGetsAssets(source), fetched: false,
        // Not entered: a scene mounted ahead of the show hears nothing. Init
        // is built when it is sent, which is only ever while this slide shows,
        // so `stepNow` is this scene's step.
        channel: new SceneChannel(
          (m) => frame.contentWindow?.postMessage(m, '*'),
          () => ({ type: 'bento:init', step: stepNow, steps, props: sceneProps(rt), reduceMotion: hooks.reduceMotion() }),
          false,
        ),
      },
    }
    // A failed or hung load leaves the still, never an empty box: the frame
    // stays invisible (it still loads and runs) until it reports, so a slow or
    // hanging page shows the still rather than a blank rectangle.
    //
    // A hosted page that REFUSES framing (X-Frame-Options, CSP
    // frame-ancestors) still fires 'load', with the browser's error document
    // inside, and a cross-origin frame gives the shell no reliable way to tell
    // that apart from a real page. That case is caught at authoring time: the
    // splice tool checks a URL override's framing headers before it writes the
    // slide. Do not wait for bento:ready ALONE here; hosted pages never send it.
    //
    // content before insertion, so the frame navigates once, straight to the scene
    if (source.html != null) frame.srcdoc = source.html
    else frame.src = source.url!
    hold(h, surface)
  }

  const mountEmbeds = (slide: Slide, slideKey: string, surface: HTMLElement) => {
    for (const el of slide.elements ?? []) {
      if (el.type !== 'embed') continue
      const key = slideKey + SEP + el.id
      const allowed = liveFrameAllowed(el as EmbedElement)
      const made = allowed ? (el as EmbedElement).url!.trim() : ''
      const old = frames.get(key)
      if (old && old.made !== made) { drop(old); failed.delete(key) }
      if (frames.has(key) || failed.has(key)) continue
      if (!allowed) continue
      // scoped to this section: the grid and the speaker view repeat the ids
      const host = surface.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
      if (!host) continue
      const frame = blank((el as EmbedElement).url ?? '')
      frame.src = made
      hold({ key, slideId: slideKey, frame, timer: 0, made, scene: null }, host)
    }
  }

  /** Make the frames match the window around `current`. */
  const sync = () => {
    const vd = hooks.viewDistance?.() ?? 2
    if (!checked) {
      checked = true
      if (!windowFits(vd)) console.warn(`bento: LIVE_WINDOW (${LIVE_WINDOW}) must be below Reveal's viewDistance (${vd}); neighbours stay stills`)
    }
    const win = liveWindow(doc.slides.map(inLinearFlow), current, vd)
    const ids = new Set(win.map((i) => sid(i)!))
    for (const h of [...frames.values()]) if (!ids.has(h.slideId) || !h.frame.isConnected) drop(h)
    for (const key of [...failed]) if (!ids.has(key.split(SEP)[0])) failed.delete(key)
    for (const i of win) {
      const slide = doc.slides[i]
      const key = sid(i)!
      const surface = slidesEl.children[i]?.querySelector<HTMLElement>('.bento-slide')
      if (!surface) continue
      const scene = isRuntimeSlide(slide)
      // a frame of the other kind, or for an element that is gone, has nothing to stand on
      for (const h of [...frames.values()]) {
        if (h.slideId !== key) continue
        const elId = h.scene ? null : h.key.slice(key.length + SEP.length)
        if (scene ? !h.scene : !!h.scene || !(slide.elements ?? []).some((el) => el.type === 'embed' && el.id === elId)) drop(h)
      }
      if (scene) mountScene(slide, key, surface)
      else mountEmbeds(slide, key, surface)
    }
  }

  /** Tell the scene on the slide showing that the show is on it. */
  const arrive = () => {
    const h = scene()
    if (!h) return
    const sc = h.scene!
    // a rebuilt scene may declare fewer steps than the one the audience was on
    stepNow = clamp(sc.steps, stepNow)
    sc.channel.enter()
    // Assets go only to the scene showing, and only once it shows: a scene
    // mounted ahead of the show makes no request the viewer did not walk into.
    if (!sc.fetched && storeId && sc.rt.assets?.length && sc.inline) {
      sc.fetched = true
      void fetchAssets(storeId, sc.rt.assets).then((got) => {
        if (frames.get(h.key) === h && Object.keys(got).length) sc.channel.assets(got)
      })
    }
  }

  /** A scene that was shown is not kept: replaced by a fresh, silent one on the next sync. */
  const retire = () => {
    const h = currentId !== null ? frames.get(currentId) : undefined
    if (h?.scene) drop(h)
  }

  const clamp = (steps: number, step: number): number =>
    Number.isFinite(step) ? Math.max(0, Math.min(Math.max(0, steps - 1), Math.floor(step))) : 0

  const enter = (idx: number, forward: boolean, named?: number | null) => {
    if (disposed) return // a show that ended mounts nothing, whoever still holds it
    const slide = doc.slides[idx]
    const key = sid(idx)
    if (key !== null && key === currentId) current = idx // the same slide, moved
    else if (current !== idx || currentId !== key) {
      retire()
      const startAtZero = jumpTo === idx
      jumpTo = -1
      current = idx
      currentId = key
      stepNow = slide && isRuntimeSlide(slide) && !startAtZero ? enterStep(slide.runtime!.steps, forward) : 0
      // A presenter named the step: the scene opens ON it. Set before the
      // scene is told anything, or a scene mounted ahead of the show would
      // open on the entry step and then be corrected in front of the audience.
      if (named != null && slide && isRuntimeSlide(slide)) stepNow = clamp(slide.runtime!.steps, named)
      // The ten seconds count from when the audience looks, not from when a
      // frame was mounted ahead of them: whatever on this slide is still
      // covered gets its full time again. Once per entry; a refresh of the
      // slide showing must not keep a hung frame alive.
      for (const f of frames.values()) {
        if (f.slideId === key && f.frame.style.visibility === 'hidden') { clearTimeout(f.timer); f.timer = window.setTimeout(f.fail, LOAD_TIMEOUT_MS) }
      }
      // walking onto a slide is one more try for a frame that gave up
      if (key !== null) for (const k of [...failed]) if (k.split(SEP)[0] === key) failed.delete(k)
    }
    sync()
    arrive()
  }

  const move = (dir: StepDir, commit: boolean): boolean => {
    const h = scene()
    if (!h || !h.scene!.channel.live) return false
    const to = moveStep(h.scene!.steps, stepNow, dir)
    if (to === null) return false
    if (commit) { stepNow = to; h.scene!.channel.step(to) }
    return true
  }

  return {
    enter,
    leave: (idx) => {
      if (current !== idx) return
      retire()
      current = -1
      currentId = null
    },
    // enter() keeps the step when it is still the same slide, so a rebuilt
    // scene opens where the audience was
    refresh: (idx) => enter(idx, true),
    rebuilt: (at) => {
      if (pendingRefresh) return
      pendingRefresh = true
      queueMicrotask(() => { pendingRefresh = false; if (!disposed) enter(at(), true) })
    },
    next: () => move('next', true),
    prev: () => move('prev', true),
    canNext: () => move('next', false),
    canPrev: () => move('prev', false),
    // The step the scene is ON, or will open on: a scene still loading already
    // has one (its bento:init carries it), and the audience must hear that one.
    step: () => (scene() ? stepNow : null),
    follow: (idx, step) => {
      const h = scene()
      if (!h || sid(idx) !== currentId) return false
      const to = clamp(h.scene!.steps, step)
      if (to === stepNow) return true
      stepNow = to
      // a scene still loading reads stepNow in its bento:init; a live one is told
      h.scene!.channel.step(to)
      return true
    },
    jump: (idx) => {
      // Reveal fires no slidechanged for the slide already showing, so a
      // click on it resets here; any other target resets on its entry.
      const h = scene()
      if (currentId !== null && sid(idx) === currentId) { if (h) { stepNow = 0; h.scene!.channel.step(0) } }
      else jumpTo = idx
    },
    setReduceMotion: (reduce) => scene()?.scene!.channel.motion(reduce),
    dispose: () => {
      disposed = true
      for (const h of [...frames.values()]) drop(h)
      failed.clear()
      current = -1
      currentId = null
      window.removeEventListener('message', onMessage)
    },
  }
}

/**
 * Fetch declared assets from the store with the viewer's Access cookie. A
 * name that fails (missing, signed out, offline) is skipped: the scene gets
 * what arrived and decides how to look without the rest. `redirect: manual`
 * because a signed-out request is redirected to Access's login page, which
 * must not come back as an asset. `cache: no-cache` revalidates every time
 * (the store answers 304 on an unchanged ETag), so an asset re-uploaded
 * against the same name is not served stale from the HTTP cache.
 * `fetcher` exists for the rig.
 */
export async function fetchAssets(
  storeId: string,
  names: string[],
  fetcher: (url: string, init: RequestInit) => Promise<Response> = netFetch,
): Promise<Record<string, Blob>> {
  const out: Record<string, Blob> = {}
  await Promise.all(names.map(async (name) => {
    const url = assetUrl(storeId, name)
    if (!url) return
    try {
      const res = await fetcher(url, { credentials: 'same-origin', redirect: 'manual', cache: 'no-cache' })
      if (!res.ok || /text\/html/i.test(res.headers.get('content-type') ?? '')) return
      out[name] = await res.blob()
    } catch { /* offline switch, network, or Access: the scene runs without it */ }
  }))
  return out
}
