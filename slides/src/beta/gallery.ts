// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Beta build: the scene gallery (2026-10-13-2236 plan, U11, KTD8, KTD10).
// A person inserts a scene from Beta's library.
//
// The manifest comes from the store (beta/store.ts fetchLibrary); this file
// is the one place that decides what in it to trust. A scene that does not
// read cleanly is left off the shelf, never repaired, so what a card shows is
// exactly what Insert writes.
//
// Two kinds of scene, two inserts, no new element type:
//   - a RUNTIME scene becomes a new slide after the current one: its HTML
//     and still interned as assets, the still as the full-bleed image element
//     (the shape the splice tool's applyScene writes), its settings copied and
//     its values from the chosen preset;
//   - a WEB scene becomes an embed element centred on the current slide, live,
//     with the library's still as its view, the preset's values in its address
//     (KTD10) and the library marker plus settings in its `doc`.
// Both pass the untrusted gate's own checks before they are written, so an
// insert can never put into a deck what a reload would drop.
//
// The pure parts (readManifest, runtimeSlide, webEmbed) run in node:
// scripts/test-beta-gallery.ts. The dialog is below them.

import type { BentoDoc, EmbedElement } from '../model.ts'
import { uid } from '../model.ts'
import { isRuntimeSlide } from '../runtime.ts'
import type { Store } from '../store.ts'
import { sanitizeElement } from '../untrusted.ts'
import { t } from '../i18n.ts'
import { webSceneOf, writeQueryAll, type Preset } from './scenesettings.ts'
// the library's reading and the runtime insert: one pure module, also bundled into the splice tool
import { readManifest, runtimeSlide, svgDataUri, valuesFor, type LibraryScene } from './libraryread.ts'
export { readManifest, runtimeSlide, runtimeSlideWith, svgDataUri, valueRefusal, valuesFor, type LibraryScene } from './libraryread.ts'

/** A web scene's size on the slide: the manifest declares none, so 62.5% of the slide's width at 16:9, centred. */
const WEB_WIDTH = 0.625

/**
 * A web scene as an embed element, centred on a slide of the deck's size,
 * live, its address carrying the preset's values. An error to show instead
 * when the address would be refused.
 */
export function webEmbed(doc: BentoDoc, scene: LibraryScene, preset?: Preset): { element: EmbedElement } | { error: string } {
  if (scene.kind !== 'web' || !scene.url) return { error: 'Not a web address' }
  const address = writeQueryAll(scene.url, valuesFor(scene, preset))
  if ('error' in address) return { error: address.error }
  const size = doc.size ?? { width: 1280, height: 720 }
  const w = Math.round(size.width * WEB_WIDTH), h = Math.round(w * 9 / 16)
  const el: EmbedElement = {
    id: uid('emb'), type: 'embed', app: 'web',
    x: Math.round((size.width - w) / 2), y: Math.round((size.height - h) / 2), w, h,
    rotation: 0, opacity: 1,
    view: scene.still, url: address.url, live: true,
    doc: { library: { id: scene.id, version: scene.version }, props: scene.props },
  }
  // the gate's own reading: what a reload would keep
  const kept = sanitizeElement(JSON.parse(JSON.stringify(el))) as EmbedElement | null
  if (!kept || kept.url !== el.url || kept.view !== el.view || kept.live !== true || !webSceneOf(kept.doc)) return { error: 'Not a web address' }
  return { element: kept }
}

/**
 * Insert a scene into the deck the editor holds, as one undoable edit: a
 * runtime scene as a new slide after the current one (and after its states),
 * shown; a web scene on the current slide, selected. A refusal to show, or
 * null when it went in.
 */
export function insertScene(store: Store, scene: LibraryScene, preset?: Preset): string | null {
  if (store.readOnly) return 'Read-only — viewing this live session. You can watch and present, but not edit.'
  const doc = store.doc
  if (scene.kind === 'runtime') {
    // a dry run on a scratch asset table: refuse before the commit, so a
    // refusal leaves no empty undo step and no stray asset
    if (!runtimeSlide({ ...doc, assets: {} }, scene, preset)) return 'The scene library could not be read.'
    const cur = store.slide
    const parent = cur?.stateOf ?? cur?.id
    let at = store.currentIndex + 1
    while (at < doc.slides.length && parent && doc.slides[at].stateOf === parent) at++
    store.commit(() => {
      const slide = runtimeSlide(store.doc, scene, preset)
      if (slide) store.doc.slides.splice(at, 0, slide)
    }, 'slides')
    store.goTo(at)
    return null
  }
  if (isRuntimeSlide(store.slide)) return 'Live scene slides cannot hold other elements'
  const r = webEmbed(doc, scene, preset)
  if ('error' in r) return r.error
  store.commit(() => { store.slide.elements.push(r.element) })
  store.select([r.element.id])
  return null
}

// ---- the dialog --------------------------------------------------------------

export type GalleryAvailability = 'ok' | 'not-store' | 'offline'

export interface GalleryHost {
  /** Decided before any fetch: off the store origin or offline, the dialog says why and fetches nothing. */
  availability(): GalleryAvailability
  /** The store to open, off its origin. null when this build has none. */
  storeLink: string | null
  /** The manifest JSON; rejects with a signed-out or offline error the host can name. */
  load(): Promise<unknown>
  /** Is this rejection a lapsed sign-in? */
  signedOut(err: unknown): boolean
  /** Is this rejection offline mode? */
  offline(err: unknown): boolean
  /** Insert; a refusal to show, or null when it went in. */
  insert(scene: LibraryScene, preset: Preset | undefined): string | null
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

/** A still as a picture: an <img> of a data URI, so its markup can never run or reach the page. */
const stillImg = (scene: LibraryScene, cls: string): HTMLImageElement => {
  const img = el('img', cls)
  img.src = svgDataUri(scene.still)
  img.alt = ''
  return img
}

/** Open the gallery. Closes on Escape, a click outside, or an insert. */
export function openGallery(host: GalleryHost): HTMLElement {
  document.querySelector('.ed-about-overlay')?.remove()
  const overlay = el('div', 'ed-about-overlay ed-gallery-overlay')
  const box = el('div', 'ed-about ed-gallery')
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  box.setAttribute('aria-label', t('Scene library'))
  overlay.appendChild(box)
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
  // Every key pressed while the dialog is open is the dialog's: the editor's
  // own keydown (on the document, bubbling) would otherwise delete or nudge
  // the selection behind it on Delete or an arrow. Stopped in the capture
  // phase, so it never reaches that listener; the browser's own handling
  // (Tab, Enter on a button, a select's arrows) is untouched.
  const onKey = (ev: KeyboardEvent) => {
    // removed by something else (another dialog removes .ed-about-overlay as
    // it opens): stand down, or every editor key would be swallowed from now on
    if (!overlay.isConnected) { document.removeEventListener('keydown', onKey, true); return }
    ev.stopPropagation()
    if (ev.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey, true)
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close() })
  document.body.appendChild(overlay)

  const head = (title: string, back?: () => void) => {
    box.replaceChildren()
    const h = el('div', 'ed-gallery-head')
    if (back) {
      const b = el('button', 'ed-gallery-back', '‹')
      b.type = 'button'
      b.title = t('Back')
      b.setAttribute('aria-label', t('Back'))
      b.addEventListener('click', back)
      h.appendChild(b)
    }
    h.appendChild(el('h2', '', title))
    const x = el('button', 'ed-gallery-close', '×')
    x.type = 'button'
    x.title = t('Close')
    x.setAttribute('aria-label', t('Close'))
    x.addEventListener('click', close)
    h.appendChild(x)
    box.appendChild(h)
  }
  const message = (text: string, state: string, action?: HTMLElement) => {
    head(t('Scene library'))
    const p = el('p', 'ed-gallery-state', text)
    p.dataset.galleryState = state
    box.appendChild(p)
    if (action) box.appendChild(action)
  }

  const shelf = (scenes: LibraryScene[]) => {
    head(t('Scene library'))
    const grid = el('div', 'ed-gallery-grid')
    grid.dataset.galleryState = 'shelf'
    for (const scene of scenes) {
      const card = el('button', 'ed-gallery-card')
      card.type = 'button'
      card.dataset.sceneId = scene.id
      card.append(stillImg(scene, 'ed-gallery-still'), el('b', '', scene.name),
        el('span', 'ed-gallery-kind', scene.kind === 'web' ? t('Web page') : t('Live scene')))
      if (scene.description) card.appendChild(el('span', 'ed-gallery-desc', scene.description))
      card.addEventListener('click', () => detail(scenes, scene))
      grid.appendChild(card)
    }
    box.appendChild(grid)
    ;(grid.querySelector('button') as HTMLButtonElement | null)?.focus()
  }

  const detail = (scenes: LibraryScene[], scene: LibraryScene) => {
    head(scene.name, () => shelf(scenes))
    box.dataset.sceneId = scene.id
    box.appendChild(stillImg(scene, 'ed-gallery-still ed-gallery-big'))
    const meta = el('p', 'ed-gallery-desc', scene.description)
    if (scene.description) box.appendChild(meta)
    let preset: Preset | undefined = scene.presets[0]
    if (scene.presets.length) {
      const sel = el('select')
      sel.dataset.galleryPreset = '1'
      for (const p of scene.presets) {
        const o = el('option', '', p.name) // the scene author's words
        o.value = p.name
        sel.appendChild(o)
      }
      sel.addEventListener('change', () => { preset = scene.presets.find((p) => p.name === sel.value) })
      const r = el('label', 'ed-row')
      r.append(el('span', '', t('Preset')), sel)
      box.appendChild(r)
    }
    const refusal = el('p', 'ed-hint ed-scene-note')
    refusal.hidden = true
    const actions = el('div', 'ed-dialog-actions')
    const ins = el('button', 'ed-primary', t('Insert'))
    ins.type = 'button'
    ins.dataset.galleryInsert = '1'
    ins.addEventListener('click', () => {
      const refused = host.insert(scene, preset)
      if (!refused) { close(); return }
      refusal.textContent = t(refused)
      refusal.hidden = false
    })
    actions.appendChild(ins)
    box.append(refusal, actions)
    ins.focus()
  }

  const load = () => {
    const avail = host.availability()
    if (avail !== 'ok') {
      let link: HTMLElement | undefined
      if (avail === 'not-store' && host.storeLink) {
        const a = el('a', 'ed-gallery-link', t('Open the deck store'))
        a.href = host.storeLink
        a.target = '_blank'
        a.rel = 'noopener'
        link = a
      }
      message(avail === 'offline'
        ? t('You are offline. The scene library is read from the deck store.')
        : t('The scene library is available in a deck opened from the deck store.'), avail, link)
      return
    }
    message(t('Loading the scene library…'), 'loading')
    host.load().then((json) => {
      if (!overlay.isConnected) return
      const scenes = readManifest(json)
      if (!scenes) throw new Error('not a library manifest')
      if (!scenes.length) message(t('The scene library has no scenes yet.'), 'empty')
      else shelf(scenes)
    }).catch((err) => {
      if (!overlay.isConnected) return
      if (host.offline(err)) { message(t('You are offline. The scene library is read from the deck store.'), 'offline'); return }
      if (host.signedOut(err)) { message(t('Sign in to the deck store to see the scene library, then try again.'), 'signed-out', retry()); return }
      message(t('The scene library could not be read.'), 'failed', retry())
    })
  }
  const retry = () => {
    const b = el('button', '', t('Retry'))
    b.type = 'button'
    b.dataset.galleryRetry = '1'
    b.addEventListener('click', load)
    const wrap = el('div', 'ed-dialog-actions')
    wrap.appendChild(b)
    return wrap
  }
  load()
  return overlay
}
