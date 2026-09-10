// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// BETA FORK (plan 2026-09-08-002, U8, KTD10): the deck store, seen from the
// editor. slides.betamobility.ai keeps decks behind Cloudflare Access and
// serves them unchanged; this module is the only code that knows it exists.
// (It moved there from decks.betamobility.ai on 2026-09-10; that host answers
// 301 for a grace period, except /new — see below.)
//
// TWO SITUATIONS, ONE MODULE.
//
// · ON THE STORE ORIGIN (a deck opened from https://slides…/d/<id>) the store
//   is a HOST in the kernel's sense — the same extension point home/ios and
//   home/webext use. `installStoreHost()` announces `window.__bentoHost`,
//   polyfills `showSaveFilePicker` by picker id, and adopts a store-backed
//   file handle for the open id. From then on ⌘S, the autosave write-back,
//   "Save a copy", "Save as new deck", the rollback copy an update leaves and
//   `applyUpdateInPlace` all reach the store through kernel paths that do
//   not know who is behind the handle. The handle serializes whatever the
//   kernel hands it, so an encrypted deck is stored encrypted.
//
// · ON file:// (a null origin, which can carry no Access cookie) the deck
//   cannot call the store at all. `handoffToStore()` opens <storeHost>/new
//   in a tab and posts the serialized document to it once the page says it
//   is ready; the PERSON clicks Save there; the page posts the link back.
//   Origin checks on both ends: the deck accepts messages only from the
//   store origin and only from the tab it opened (the page's `ready` must go
//   to "*" because our origin is null), and posts the document to the store
//   origin only. server/deck-store/src/pages.js is the other half.
//
//   THIS IS WHY THE OLD HOST STILL SERVES /new. A shell already on someone's
//   disk opens the host IT was built naming, and rejects any reply from a
//   different origin — so a blanket redirect on the old host would break the
//   handoff twice over, and the person would watch a stray deck appear while
//   the document they were publishing was discarded. The old host keeps /new
//   (and the POST that page makes); everything else there redirects. The new
//   host's /new answers this same protocol, so a shell built from here needs
//   no second URL.
//
// SIGNED OUT. When the Access session has lapsed, Access answers a fetch with
// a redirect to the team login page, not a 401. Requests are sent with
// `redirect: 'manual'`, so that arrives as an `opaqueredirect`; a rejected
// fetch or a login page served as a body mean the same thing. Every such case
// rejects with StoreSignedOutError, so the kernel's failure path fires (the
// editor toasts, autosave keeps the deck dirty) instead of a false "Saved".
//
// Every request goes through kernel net.ts — scripts/test-offline.ts refuses
// a `fetch(` anywhere else, and the offline switch must cover the store too.

import { appConfig } from '../../../kernel/src/app.ts'
import { netFetch, offlineEnabled, OfflineError } from '../../../kernel/src/net.ts'
import { adoptFileHandle, downloadFile } from '../../../kernel/src/save.ts'
import { t } from '../../../kernel/src/i18n.ts'

/** Rejection for every "the store did not accept this" that a sign-in fixes. */
export class StoreSignedOutError extends Error {
  constructor(message?: string) {
    super(message ?? t('Signed out of Beta — sign in again at {host}, then save again', { host: storeHostName() }))
    this.name = 'StoreSignedOutError'
  }
}

/** The configured store origin, or null when this app has none. */
export function storeHost(): string | null {
  try {
    const h = appConfig().storeHost
    return h ? h.replace(/\/+$/, '') : null
  } catch {
    return null // before configureApp(), or an app without a store
  }
}

const storeHostName = () => {
  try { return new URL(storeHost() ?? '').host } catch { return 'the deck store' }
}

/** Is this document being served BY the store (as opposed to a file)? */
export function isStoreOrigin(): boolean {
  const host = storeHost()
  if (!host) return false
  try {
    return location.origin === host
  } catch {
    return false
  }
}

/** The deck id when the page is <storeHost>/d/<id>; null anywhere else. */
export function storeIdFromLocation(): string | null {
  try {
    const m = /^\/d\/([A-Za-z0-9]+)\/?$/.exec(location.pathname)
    return m ? m[1] : null
  } catch {
    return null
  }
}

// --- requests -----------------------------------------------------------------

const headers = { 'content-type': 'text/html; charset=utf-8' }

/** Did the store answer, or did Access answer for it? */
function signedOut(res: Response): boolean {
  if (res.type === 'opaqueredirect' || res.status === 0 || res.status === 401) return true
  // Access serves its login page with a 200 in some flows; the store never
  // answers a write with HTML.
  return /text\/html/i.test(res.headers?.get('content-type') ?? '')
}

async function storeRequest(path: string, init: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await netFetch(`${storeHost()}${path}`, { ...init, credentials: 'same-origin', redirect: 'manual' })
  } catch (err) {
    if (err instanceof OfflineError) throw err
    throw new StoreSignedOutError() // a followed cross-origin redirect, or no network
  }
  if (signedOut(res)) throw new StoreSignedOutError()
  if (!res.ok) {
    const why = await res.text().catch(() => '')
    throw new Error(t('The store refused the deck ({status}{why})', { status: String(res.status), why: why ? `: ${why}` : '' }))
  }
  return res
}

/** Replace the deck stored under `id`. The worker answers 200 with no body. */
export async function putDeck(id: string, html: string): Promise<void> {
  await storeRequest(`/api/decks/${encodeURIComponent(id)}`, { method: 'PUT', body: html, headers })
}

/** Store a NEW deck; the worker answers 201 {id, url}. */
export async function postDeck(html: string): Promise<{ id: string; url: string }> {
  const res = await storeRequest('/api/decks', { method: 'POST', body: html, headers })
  let out: any
  try {
    out = await res.json()
  } catch {
    throw new StoreSignedOutError() // a login page, not the store's JSON
  }
  if (!out || typeof out.url !== 'string' || typeof out.id !== 'string') throw new StoreSignedOutError()
  return { id: out.id, url: out.url }
}

// --- the handle -----------------------------------------------------------------

/** The kernel's handle shape (save.ts FsFileHandle, plus what a host adds). */
export interface StoreHandle {
  name: string
  kind: 'file'
  createWritable(): Promise<{ write(data: Blob | string): Promise<void>; close(): Promise<void> }>
  queryPermission(): Promise<'granted'>
  requestPermission(): Promise<'granted'>
  isSameEntry(): Promise<boolean>
}

/** A handle whose close() hands the collected bytes to `sink`. */
function handleOver(name: string, sink: (html: string) => Promise<void>): StoreHandle {
  return {
    name,
    kind: 'file',
    createWritable: async () => {
      const chunks: Array<Blob | string> = []
      return {
        async write(data) { chunks.push(data) },
        async close() {
          const text = await new Blob(chunks).text()
          await sink(text)
        },
      }
    },
    // The kernel re-queries permission on a retained handle; a store handle
    // is good for as long as the Access session is, which the write reports.
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    isSameEntry: async () => false,
  }
}

/** ⌘S target: PUT to the open id. */
export const storeHandle = (id: string): StoreHandle =>
  handleOver(`${id}.bento.html`, (html) => putDeck(id, html))

/**
 * "Save a copy" / "Save as new deck" / a share export: POST a new object,
 * then navigate to it. Deferred a tick so the kernel's caller has cleared the
 * dirty flag before the editor's beforeunload guard sees the navigation.
 *
 * `settled` runs after the POST, success or failure. The kernel's saveFile()
 * ADOPTS the picked handle before writing through it, so without this a
 * signed-out "Save as new deck" would leave THIS handle as the ⌘S target and
 * every later save (autosave included) would mint another new deck.
 */
export const newDeckHandle = (name: string, settled: () => void = () => {}, open: 'here' | 'tab' = 'here'): StoreHandle =>
  handleOver(name, async (html) => {
    let url: string
    try {
      url = (await postDeck(html)).url
    } finally {
      settled()
    }
    if (open === 'tab') {
      // A share export (view-only, present-only, template) is a DERIVED file;
      // the author stays on the deck they are editing and the export opens
      // beside it. The POST is quick enough to sit inside the click's
      // transient activation, so the popup is allowed; if a browser blocks it
      // anyway, fall back to navigating rather than losing the object.
      const tab = window.open(url, '_blank', 'noopener')
      if (tab) return
    }
    setTimeout(() => location.assign(url), 0)
  })

/** The rollback copy an update leaves behind: a download, never a store write. */
export const backupHandle = (name: string): StoreHandle =>
  handleOver(name, async (html) => { downloadFile(html, name) })

/** The real `showSaveFilePicker`, captured before the host replaces it. */
let nativePicker: ((opts: any) => Promise<any>) | undefined

/**
 * Write the open deck to the PERSON'S OWN disk: a Drive folder, the desktop,
 * anywhere. The one save on the store origin that deliberately misses the
 * store.
 *
 * WHY THIS EXISTS. `installStoreHost` polyfills the picker, so every kernel
 * save purpose — ⌘S, "Save a copy", every share export — resolves to a store
 * object. That is correct for all of them and it left the store with no way
 * out: a deck made at slides.betamobility.ai could not be put in a project
 * folder on Drive, which is the other half of how Beta keeps decks
 * (docs/beta-drive-workflow.md). This is that door.
 *
 * IT DOES NOT ADOPT THE HANDLE. The kernel's `saveFile` adopts what a picker
 * returns and writes ⌘S through it from then on; going through it here would
 * quietly move the deck OFF the store, so this writes the handle directly and
 * leaves the ⌘S target alone. Same reason `writeUpdatedFileAs` grew
 * `keepHandle` (AGENTS.md, share exports): a copy is not a relocation.
 *
 * The file keeps its `collab`, so it is the SAME deck, live-synced with the
 * one in the store, and not a fork. "Duplicate as new deck…" is the fork.
 *
 * Without the File System Access API (Safari) there is no picker to offer and
 * this is a download, which lands in the browser's download folder rather than
 * one the person chose. Still the file, still theirs.
 */
export async function saveToDisk(html: string, name: string): Promise<'picked' | 'downloaded' | 'cancelled'> {
  if (nativePicker) {
    let handle: any
    try {
      handle = await nativePicker({
        suggestedName: name,
        // Its own picker id, so the browser remembers THIS folder: a person
        // who keeps decks in a Drive folder lands back there next time,
        // rather than wherever an unrelated export last went.
        id: 'bento-disk',
        types: [{ description: appConfig().appName, accept: { 'text/html': ['.bento.html'] } }],
      })
    } catch (err: any) {
      // Cancelling is a decision, not a failure: write nothing, anywhere.
      if (err?.name === 'AbortError') return 'cancelled'
      handle = null
    }
    if (handle) {
      const writable = await handle.createWritable()
      await writable.write(new Blob([html], { type: 'text/html' }))
      await writable.close()
      return 'picked'
    }
  }
  downloadFile(html, name)
  return 'downloaded'
}

/**
 * Become the kernel's host for the open deck. Call at boot, on the store
 * origin, BEFORE the editor builds (it reads hasFileHandle() at construction).
 * Returns false — and installs nothing — when the page carries no deck id.
 */
export function installStoreHost(): boolean {
  const id = storeIdFromLocation()
  if (!id) return false
  const w = window as any
  const native: ((opts: any) => Promise<any>) | undefined =
    typeof w.showSaveFilePicker === 'function' ? w.showSaveFilePicker.bind(window) : undefined
  // The browser's own picker, kept for `saveToDisk` below. Once this function
  // returns, `window.showSaveFilePicker` is OURS, and every kernel save path
  // reaches the store through it — which is the whole point, and also why the
  // one save that must NOT reach the store needs the real one held aside.
  nativePicker = native

  w.__bentoHost = Object.freeze({ name: 'beta/store', ops: Object.freeze(['write', 'backup']) })
  w.showSaveFilePicker = async (opts: any = {}) => {
    const name = typeof opts.suggestedName === 'string' && opts.suggestedName ? opts.suggestedName : `${id}.bento.html`
    switch (opts.id) {
      case 'bento-doc': return storeHandle(id)
      case 'bento-copy': return newDeckHandle(name, () => adoptFileHandle(storeHandle(id)))
      case 'bento-share': return newDeckHandle(name, () => adoptFileHandle(storeHandle(id)), 'tab')
      case 'bento-backup': return backupHandle(name)
    }
    // Not a save we understand. `startIn` may be one of OUR handles (the
    // kernel passes the adopted one back), which a native picker rejects.
    if (native) {
      const { startIn, ...rest } = opts
      const real = typeof (globalThis as any).FileSystemHandle !== 'undefined' && startIn instanceof (globalThis as any).FileSystemHandle
      return native(real ? opts : rest)
    }
    throw new DOMException('No file picker available', 'AbortError')
  }
  adoptFileHandle(storeHandle(id))
  return true
}

// --- file:// → store tab ---------------------------------------------------------

export interface HandoffOpts {
  /** Whole-flow budget: sign-in, the person's click, the upload. */
  timeoutMs?: number
  /** How often to notice the tab was closed. */
  pollMs?: number
}

/**
 * Hand the serialized document to <storeHost>/new and resolve its stored url.
 *
 * Call it synchronously from the click that asked for it: `window.open` needs
 * the user gesture, and the serialization (PBKDF2 for an encrypted deck) can
 * outlive Chrome's activation window — so the tab is opened FIRST, and the
 * html may be a promise.
 */
export function handoffToStore(html: string | Promise<string>, title = '', opts: HandoffOpts = {}): Promise<string> {
  const host = storeHost()
  if (!host) return Promise.reject(new Error('this app has no deck store'))
  if (offlineEnabled()) return Promise.reject(new OfflineError(host))
  const tab = window.open(`${host}/new`, '_blank')
  if (!tab) return Promise.reject(new Error(t('Couldn’t open the store tab — allow pop-ups for this file, then try again.')))

  const timeoutMs = opts.timeoutMs ?? 10 * 60_000
  const pollMs = opts.pollMs ?? 1000
  return new Promise<string>((resolve, reject) => {
    let sent = false
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
      clearInterval(poll)
      fn()
    }
    const onMessage = (ev: { data?: any; origin: string; source: unknown }) => {
      if (ev.origin !== host || ev.source !== tab) return
      const d = ev.data
      if (!d || typeof d !== 'object') return
      if (d.type === 'bento-store-ready' && !sent) {
        sent = true
        const post = (text: string) => { if (!done) tab.postMessage({ type: 'bento-store-save', html: text, title }, host) }
        if (typeof html === 'string') post(html)
        else html.then(post, (err) => finish(() => reject(err)))
        return
      }
      if (d.type === 'bento-store-saved' && typeof d.url === 'string' && d.url.startsWith(`${host}/`)) {
        finish(() => resolve(d.url))
      }
    }
    const timer = setTimeout(() => finish(() => reject(new Error(t('The store tab gave no answer — timed out')))), timeoutMs)
    const poll = setInterval(() => {
      if (tab.closed) finish(() => reject(new Error(t('The store tab was closed before the deck was saved'))))
    }, pollMs)
    window.addEventListener('message', onMessage)
  })
}
