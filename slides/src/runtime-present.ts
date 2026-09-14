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
// Content is set on slide ENTER and cleared on exit, never at render time,
// because Reveal keeps neighbouring sections mounted (viewDistance 2) and a
// frame there would run a scene nobody is looking at.
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

import type { BentoDoc, RuntimeSlide } from './model.ts'
import { netFetch, offlineEnabled } from '../../kernel/src/net.ts'
import { ASSET_NAME, isRuntimeSlide, runtimeSource } from './runtime.ts'

/** A frame that has not fired `load` by then is removed; the still stays. */
const LOAD_TIMEOUT_MS = 10_000
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
 * Holds the channel shut until bento:ready. Before it, step, motion and
 * props changes are dropped (init is built at ready time, so it carries their
 * current values) and fetched assets are held; at ready, init goes first and
 * the held assets follow. A second ready (the scene reloaded itself) replays
 * the same pair.
 */
export class SceneChannel {
  private open = false
  private held: Record<string, Blob> | null = null
  private readonly post: (m: ShellMessage) => void
  private readonly init: () => InitMessage
  constructor(post: (m: ShellMessage) => void, init: () => InitMessage) {
    this.post = post
    this.init = init
  }
  get live(): boolean { return this.open }
  ready(): void {
    this.open = true
    this.post(this.init())
    if (this.held) this.post({ type: 'bento:assets', assets: this.held })
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
  /** Slide `idx` became current. Idempotent for the slide already mounted. */
  enter(idx: number, forward: boolean): void
  /** Slide `idx` stopped being current: clear and remove its frame. */
  leave(idx: number): void
  /** An arrow press: true when it moved a step and the slide must stay. */
  next(): boolean
  prev(): boolean
  canNext(): boolean
  canPrev(): boolean
  /** A rail/grid jump to `idx`: that slide starts on step 0, even when already showing. */
  jump(idx: number): void
  setReduceMotion(reduce: boolean): void
  dispose(): void
}

interface Live {
  idx: number
  frame: HTMLIFrameElement
  channel: SceneChannel
  steps: number
  step: number
  timer: number
}

export function createRuntimeShow(
  doc: BentoDoc,
  slidesEl: HTMLElement,
  storeId: string | null,
  hooks: { goNext(): void; goPrev(): void; exit(): void; reduceMotion(): boolean },
): RuntimeShow {
  let live: Live | null = null
  /** The slide a rail/grid click targeted; its next entry lands on step 0. */
  let jumpTo = -1

  const teardown = () => {
    if (!live) return
    clearTimeout(live.timer)
    live.frame.removeAttribute('srcdoc')
    live.frame.removeAttribute('src')
    live.frame.remove()
    live = null
  }

  const onMessage = (ev: MessageEvent) => {
    if (!live || !fromFrame(ev, live.frame.contentWindow)) return
    const msg = parseSceneMessage(ev.data)
    if (!msg) return
    if (msg.type === 'bento:ready') { live.channel.ready(); return }
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

  const enter = (idx: number, forward: boolean) => {
    if (live?.idx === idx) return
    teardown()
    const slide = doc.slides[idx]
    const startAtZero = jumpTo === idx
    jumpTo = -1
    if (!slide || !isRuntimeSlide(slide)) return
    const rt = slide.runtime!
    const source = runtimeSource(slide, doc)
    const surface = slidesEl.children[idx]?.querySelector<HTMLElement>('.bento-slide')
    if (!source || !surface) return
    if (!frameAllowed(source, {
      offline: offlineEnabled(),
      online: typeof navigator === 'undefined' || navigator.onLine !== false,
    })) return

    const frame = document.createElement('iframe')
    frame.className = 'bento-runtime-frame'
    frame.setAttribute('sandbox', 'allow-scripts allow-forms')
    frame.referrerPolicy = 'no-referrer'
    frame.title = slide.name || slide.id
    const steps = rt.steps
    const cur: Live = {
      idx,
      frame,
      steps,
      step: startAtZero ? 0 : enterStep(steps, forward),
      timer: 0,
      channel: new SceneChannel(
        (m) => frame.contentWindow?.postMessage(m, '*'),
        () => ({ type: 'bento:init', step: cur.step, steps, props: sceneProps(rt), reduceMotion: hooks.reduceMotion() }),
      ),
    }
    // A failed or hung load leaves the still, never an empty box: the frame
    // stays invisible (it still loads and runs) until 'load', so a slow or
    // hanging page shows the still rather than a blank rectangle.
    //
    // A hosted page that REFUSES framing (X-Frame-Options, CSP
    // frame-ancestors) still fires 'load', with the browser's error document
    // inside, and a cross-origin frame gives the shell no reliable way to tell
    // that apart from a real page. That case is caught at authoring time: the
    // splice tool checks a URL override's framing headers before it writes the
    // slide. Do not wait for bento:ready here instead; hosted pages never send it.
    const fail = () => { if (live === cur) teardown() }
    cur.timer = window.setTimeout(fail, LOAD_TIMEOUT_MS)
    frame.style.visibility = 'hidden'
    frame.addEventListener('load', () => { clearTimeout(cur.timer); frame.style.visibility = '' }, { once: true })
    frame.addEventListener('error', fail, { once: true })
    // content before insertion, so the frame navigates once, straight to the scene
    if (source.html != null) frame.srcdoc = source.html
    else frame.src = source.url!
    surface.appendChild(frame)
    live = cur

    if (storeId && rt.assets?.length && sceneGetsAssets(source)) {
      void fetchAssets(storeId, rt.assets).then((got) => {
        if (live === cur && Object.keys(got).length) cur.channel.assets(got)
      })
    }
  }

  const move = (dir: StepDir, commit: boolean): boolean => {
    if (!live || !live.channel.live) return false
    const to = moveStep(live.steps, live.step, dir)
    if (to === null) return false
    if (commit) { live.step = to; live.channel.step(to) }
    return true
  }

  return {
    enter,
    leave: (idx) => { if (live?.idx === idx) teardown() },
    next: () => move('next', true),
    prev: () => move('prev', true),
    canNext: () => move('next', false),
    canPrev: () => move('prev', false),
    jump: (idx) => {
      // Reveal fires no slidechanged for the slide already showing, so a
      // click on it resets here; any other target resets on its entry.
      if (live?.idx === idx) { live.step = 0; live.channel.step(0) }
      else jumpTo = idx
    },
    setReduceMotion: (reduce) => live?.channel.motion(reduce),
    dispose: () => {
      teardown()
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
