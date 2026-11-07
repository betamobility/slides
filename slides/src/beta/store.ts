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
// `redirect: 'manual'`, so that arrives as an `opaqueredirect`, and that alone
// is a sign-out for certain. A rejected fetch, an HTML body (Access's login
// page, or Cloudflare's own error page for a 5xx or a 1102) are ambiguous, and
// for those the tab asks Access (`signedInState`) before saying anything: a
// signed-in tab gets StoreUnavailableError, which the editor retries, and only
// a confirmed sign-out gets StoreSignedOutError. Either way the kernel's
// failure path fires (autosave keeps the deck dirty) instead of a false
// "Saved". Before 2026-11-07 every ambiguous answer said "Signed out", and a
// signed-in person saving a large deck was told to sign in again.
//
// CHANGED IN THE STORE (plan 2026-09-14-001, U10, KTD12). Claude can replace a
// deck in the store while someone has it open, so a save must not silently
// overwrite that. The host learns the version it is showing from HEAD /d/<id>
// at boot, sends it as If-Match on every PUT, and adopts the ETag each 200
// returns. A 412 rejects with StoreConflictError, and from then on this tab
// sends no PUT at all: the edits stay dirty in the tab, "Save as new deck" and
// the disk save still work, and a reload shows the replacement. A worker that
// sends no ETag gets the unconditional save it always had.
//
// EXCEPT A PERSON'S SAVE IN A LIVE ROOM. Store decks are co-edited: two tabs
// on one /d/<id> converge through the sync relay and both autosave, so the
// second tab's save meets a 412 in the ordinary course. The 412 says who
// wrote the version that won. When it was a person and this tab is connected
// to its room, the tab adopts the 412's ETag and retries once; anything else
// (a service, not connected, a body it cannot read, a second 412) latches.
// "Who wrote the version that won" is only the LATEST writer, so Claude's
// replace followed by a person's save would read as a person. The worker
// counts service writes (x-bento-service-gen) beside every ETag; the retry
// also needs the 412's generation to equal the one this tab last saw, and a
// worker that sends none gets no retry.
//
// ONE PUT AT A TIME PER DECK. The autosave write-back and a ⌘S can overlap;
// sent together they carry the same If-Match and the tab 412s against itself.
// putDeck queues each PUT behind the previous one, so it goes out with the
// ETag that one returned. A failed PUT settles its slot and the queue moves on.
//
// AFTER A CONFLICT. The latch leaves a marker for the docId in localStorage.
// On the reload, the IndexedDB recovery snapshot is the tab's stale version,
// and a whole-document Restore followed by a save with the fresh ETag would
// overwrite the store change without a 412. `recoveryChoice` makes the editor
// offer that snapshot as a new deck instead.
//
// BEFORE A CONFLICT. A tab with nothing unsaved has no reason to wait for its
// next save to find out. `probeStore` asks with a HEAD whether the deck moved
// on, and `reloadChoice` says whether an idle tab may reload onto it. The
// editor owns the timer and decides what idle means; nothing here starts one.
//
// Every request goes through kernel net.ts — scripts/test-offline.ts refuses
// a `fetch(` anywhere else, and the offline switch must cover the store too.

import { appConfig } from '../../../kernel/src/app.ts'
import { netFetch, offlineEnabled, OfflineError } from '../../../kernel/src/net.ts'
import { adoptFileHandle, downloadFile } from '../../../kernel/src/save.ts'
import { t } from '../../../kernel/src/i18n.ts'
import { lsDel, lsGet, lsSet } from '../../../kernel/src/storage.ts'

/** Rejection for every "the store did not accept this" that a sign-in fixes. */
export class StoreSignedOutError extends Error {
  constructor(message?: string) {
    super(message ?? t('Signed out of Beta — sign in again at {host}, then save again', { host: storeHostName() }))
    this.name = 'StoreSignedOutError'
  }
}

/**
 * The store could not be reached, or answered with an error page, while the
 * person is (as far as Access says) still signed in: a dropped connection, a
 * Cloudflare 5xx or 1102 page, a timeout. Worth trying again; never a reason
 * to tell anyone to sign in. Until 2026-11-07 every one of these read as
 * StoreSignedOutError, so a signed-in person was told they were signed out.
 */
export class StoreUnavailableError extends Error {
  status: number | null
  constructor(status: number | null = null) {
    super(status
      ? t('The cloud could not save the deck just now (error {status}). Your changes are kept in this tab; saving tries again.', { status: String(status) })
      : t('Couldn’t reach the cloud to save the deck. Your changes are kept in this tab; saving tries again.'))
    this.name = 'StoreUnavailableError'
    this.status = status
  }
}

/** A save refused because the deck was replaced in the store since this tab
 *  loaded or last saved it. Terminal for the tab: reload to continue. */
export class StoreConflictError extends Error {
  /** From the worker's 412: who wrote the current version, its ETag, and its
   *  service generation (null when the worker sent none). */
  writer: 'person' | 'service' | null
  etag: string | null
  gen: number | null
  constructor(info: { writer?: 'person' | 'service' | null; etag?: string | null; gen?: number | null } = {}) {
    super(t('Someone saved a newer version of this deck in the cloud. Reload to get it before saving.'))
    this.name = 'StoreConflictError'
    this.writer = info.writer ?? null
    this.etag = info.etag ?? null
    this.gen = info.gen ?? null
  }
}

// --- after a conflict ---------------------------------------------------------------

const conflictKey = (docId: string) => `bento-store-conflict-${docId}`

/** The store refused a save of this document; remembered across the reload. */
export function markStoreConflict(docId: string): void {
  if (docId) lsSet(conflictKey(docId), String(Date.now()))
}
export function hasStoreConflict(docId: string): boolean {
  return !!docId && lsGet(conflictKey(docId)) !== null
}
export function clearStoreConflict(docId: string): void {
  if (docId) lsDel(conflictKey(docId))
}

/**
 * What the recovery banner may offer for a snapshot. `restore` replaces the
 * open document (today's banner); `new-deck` keeps the snapshot only as a new
 * deck, because on the store after a conflict the open document IS the store
 * change, and restoring over it then saving with the fresh ETag would erase it.
 */
export function recoveryChoice(o: { mismatch: boolean; storeOrigin: boolean; conflicted: boolean; moved?: boolean }): 'none' | 'restore' | 'new-deck' {
  if (!o.mismatch) return 'none'
  // `moved`: the store holds a version this browser never saved (see
  // storeMovedSinceSave). Restoring over it would erase that write.
  return o.storeOrigin && (o.conflicted || o.moved) ? 'new-deck' : 'restore'
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
  try { return new URL(storeHost() ?? '').host } catch { return 'the cloud' }
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

// --- who is signed in ---------------------------------------------------------
//
// Presence names a person by the `bento-author` value in this browser, which
// only the Share panel's name field ever wrote, so a team signed in through
// Access still saw each other as "Guest". On the store origin Access already
// knows who this is: `/cdn-cgi/access/get-identity` answers same-origin with
// the identity provider's display name (Google's full name for Beta). The
// store tab adopts it, and Access wins over a typed name there, because a
// signed-in person is identified and the field cannot stand in for that.
// Off the store origin nothing changes.

/** The localStorage key presence and comments read the display name from. */
export const AUTHOR_KEY = 'bento-author'

/** "johan.hal@x" → "Johan Hal": only when the identity carries no name. */
function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? ''
  return local.split(/[._-]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/** The display name Access holds for this tab, or null (not the store, signed
 *  out, offline, or an answer that is not an identity). Never throws. */
export async function accessName(): Promise<string | null> {
  if (!isStoreOrigin()) return null
  let res: Response
  try {
    res = await netFetch(`${storeHost()}/cdn-cgi/access/get-identity`, { credentials: 'same-origin', redirect: 'manual', cache: 'no-store' })
  } catch {
    return null
  }
  if (res.type === 'opaqueredirect' || !res.ok) return null
  try {
    const id = await res.json()
    const name = typeof id?.name === 'string' ? id.name.trim() : ''
    const email = typeof id?.email === 'string' ? id.email.trim() : ''
    const out = name || (email.includes('@') ? nameFromEmail(email) : '')
    return out ? out.slice(0, 80) : null
  } catch {
    return null // Access's login page, or anything else that is not JSON
  }
}

/** Write the Access name into `bento-author`. True when it changed, so the
 *  caller re-announces presence. */
export async function adoptAccessName(): Promise<boolean> {
  const name = await accessName()
  if (!name || lsGet(AUTHOR_KEY) === name) return false
  return lsSet(AUTHOR_KEY, name)
}

// --- requests -----------------------------------------------------------------

const headers = { 'content-type': 'text/html; charset=utf-8' }

/** Access redirected or refused: the one answer that is a sign-out for sure. */
function accessRefused(res: Response): boolean {
  return res.type === 'opaqueredirect' || res.status === 0 || res.status === 401
}

const isHtml = (res: Response) => /text\/html/i.test(res.headers?.get('content-type') ?? '')

/**
 * Is this tab signed in to Access right now? Asked only when an answer was
 * ambiguous, so "signed out" is never said on a guess. `unknown` when the
 * question itself could not be answered (no network).
 */
export async function signedInState(): Promise<'in' | 'out' | 'unknown'> {
  let res: Response
  try {
    res = await netFetch(`${storeHost()}/cdn-cgi/access/get-identity`, { credentials: 'same-origin', redirect: 'manual', cache: 'no-store' })
  } catch {
    return 'unknown'
  }
  if (accessRefused(res)) return 'out'
  if (!res.ok) return 'unknown'
  try {
    const id = await res.json()
    return id && typeof id === 'object' && (typeof id.email === 'string' || typeof id.name === 'string') ? 'in' : 'out'
  } catch {
    return 'out' // the login page, served as a 200
  }
}

/**
 * Turn "this request did not reach the store's own answer" into the error
 * that says what happened. Signed out only when Access says so; everything
 * else is the cloud being unavailable, which the editor retries.
 */
async function unreachable(status: number | null): Promise<Error> {
  return (await signedInState()) === 'out' ? new StoreSignedOutError() : new StoreUnavailableError(status)
}

async function storeRequest(path: string, init: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await netFetch(`${storeHost()}${path}`, { ...init, credentials: 'same-origin', redirect: 'manual' })
  } catch (err) {
    if (err instanceof OfflineError) throw err
    // No answer at all: the connection dropped, or the request never left.
    // With redirect: 'manual' an Access redirect is an opaqueredirect, never
    // a rejection, so this is not a sign-out unless Access says it is.
    throw await unreachable(null)
  }
  if (accessRefused(res)) throw new StoreSignedOutError()
  // The store answers every route with JSON, text/plain or no body; HTML is
  // somebody else answering for it. A 200 is Access's login page in some
  // flows; an error status is Cloudflare's own error page (5xx, 1102 "Worker
  // exceeded resource limits"), and the person is still signed in.
  if (isHtml(res)) throw await unreachable(res.ok ? null : res.status)
  if (res.status >= 500 || res.status === 429) throw new StoreUnavailableError(res.status)
  if (res.status === 412) {
    let writer: 'person' | 'service' | null = null
    try {
      const w = (await res.json())?.writer
      if (w === 'person' || w === 'service') writer = w
    } catch {} // unreadable: no writer, so the caller latches
    throw new StoreConflictError({ writer, etag: etagOf(res), gen: genOf(res) })
  }
  if (!res.ok) {
    const why = await res.text().catch(() => '')
    if (res.status === 413 || why.trim() === 'size') throw new Error(t('This deck is larger than the cloud accepts. Shrink or remove the largest images or videos, then save again.'))
    throw new Error(t('The cloud refused to save the deck ({status}{why})', { status: String(res.status), why: why ? `: ${why}` : '' }))
  }
  return res
}

// The version this tab last saw, per id. `versionCheck` is the boot HEAD still
// in flight: a save made before it answers waits for it, or the first ⌘S
// after opening would go out unconditional.
const versions = new Map<string, string>()
// The service generation that came with that version; absent when the worker
// sent none, which rules the live retry out.
const gens = new Map<string, number>()
// The tail of each deck's PUT queue. Always a settled-never-rejecting promise.
const queues = new Map<string, Promise<void>>()
let versionCheck: Promise<void> | null = null
let conflicted = false
let liveCheck: () => boolean = () => false

/** The editor says whether this tab is connected to its sync room right now. */
export function setLiveCheck(fn: () => boolean): void {
  liveCheck = fn
}

/**
 * Learn the ETag of the deck this page shows. Never rejects: an unreachable
 * store, a signed-out session or a worker without ETags all leave no version,
 * and saves stay unconditional. Not through storeRequest, because the answer
 * is the deck's own headers, and its text/html would read as a login page.
 */
function checkVersion(id: string): Promise<void> {
  versions.delete(id)
  gens.delete(id)
  return netFetch(`${storeHost()}/d/${encodeURIComponent(id)}`, { method: 'HEAD', credentials: 'same-origin', redirect: 'manual' })
    .then((res) => { if (res.status === 200) adoptVersion(id, res) })
    .catch(() => {})
}

/** The ETag a response carries. `x-bento-etag` first: Cloudflare drops a
 *  strong `etag` from compressed responses, and every deck response is HTML. */
function etagOf(res: Response): string | null {
  return res.headers?.get('x-bento-etag') || res.headers?.get('etag') || null
}

/** The x-bento-service-gen a response carries, or null. */
function genOf(res: Response): number | null {
  const raw = res.headers?.get('x-bento-service-gen')
  if (raw == null || !/^\d+$/.test(raw.trim())) return null
  return Number(raw)
}

/** Keep the ETag and generation a response names, forgetting what it lacks. */
function adoptVersion(id: string, res: Response): void {
  const etag = etagOf(res)
  if (etag) versions.set(id, etag)
  else versions.delete(id)
  const gen = etag ? genOf(res) : null
  if (gen !== null) gens.set(id, gen)
  else gens.delete(id)
}

/**
 * What a look at the store found, against the version this tab holds:
 * `same`; `service` (a service wrote since, which never travels through
 * sync); `changed` (the deck differs and no service write is known, so a
 * person saved it); `unknown` (no version to compare, a latched tab, signed
 * out, offline, or a worker without ETags).
 */
export type StoreProbe = 'same' | 'changed' | 'service' | 'unknown'

/**
 * Ask the store whether the open deck moved on. Never rejects and never
 * changes what this tab believes its version is: the caller reloads or does
 * nothing. Queued with the PUTs, because a HEAD that overlaps this tab's own
 * save reads the save's new ETag before putDeckNow has adopted it, and that
 * would look like someone else's change.
 */
export function probeStore(id: string): Promise<StoreProbe> {
  const run = (queues.get(id) ?? Promise.resolve()).then(() => probeNow(id))
  const tail = run.then(() => {}, () => {})
  queues.set(id, tail)
  void tail.then(() => { if (queues.get(id) === tail) queues.delete(id) })
  return run
}

async function probeNow(id: string): Promise<StoreProbe> {
  if (versionCheck) await versionCheck
  const held = versions.get(id)
  if (conflicted || !held) return 'unknown'
  let res: Response
  try {
    res = await netFetch(`${storeHost()}/d/${encodeURIComponent(id)}`, { method: 'HEAD', credentials: 'same-origin', redirect: 'manual' })
  } catch {
    return 'unknown'
  }
  const etag = res.status === 200 ? etagOf(res) : null
  if (!etag) return 'unknown'
  if (etag === held) return 'same'
  const heldGen = gens.get(id)
  const gen = genOf(res)
  return heldGen !== undefined && gen !== null && gen !== heldGen ? 'service' : 'changed'
}

/**
 * May an idle tab reload itself onto the store's version? A service write
 * always: nothing else will bring it to this tab. A person's save only when
 * this tab is not live in its room. A live tab already holds that save through
 * sync, and reloading on it would loop: every autosave of one collaborator
 * would reload the other.
 */
export function reloadChoice(o: { probe: StoreProbe; live: boolean }): boolean {
  if (o.probe === 'service') return true
  return o.probe === 'changed' && !o.live
}

/**
 * The scene library's manifest (2026-10-13-2236 plan, U11, KTD8), read from
 * the store's login route with the tab's Access cookie. Only on the store
 * origin; a lapsed session rejects with StoreSignedOutError, offline mode
 * with OfflineError, as every other request here does. The JSON is returned
 * unread: beta/gallery.ts is the one place that decides what in it to trust.
 */
export async function fetchLibrary(): Promise<unknown> {
  const res = await storeRequest('/library/library.json', { method: 'GET', headers: { accept: 'application/json' } })
  return res.json()
}

/** Replace the deck stored under `id`. The worker answers 200 with no body.
 *  Queued per id: each PUT starts after the previous one has settled. */
export function putDeck(id: string, html: string): Promise<void> {
  const run = (queues.get(id) ?? Promise.resolve()).then(() => putDeckNow(id, html))
  const tail = run.then(() => {}, () => {})
  queues.set(id, tail)
  void tail.then(() => { if (queues.get(id) === tail) queues.delete(id) })
  return run
}

async function putDeckNow(id: string, html: string): Promise<void> {
  if (versionCheck) await versionCheck
  if (conflicted) throw new StoreConflictError()
  const send = (etag: string | undefined) => storeRequest(`/api/decks/${encodeURIComponent(id)}`, {
    method: 'PUT', body: html, headers: etag ? { ...headers, 'if-match': etag } : headers,
  })
  let res: Response
  try {
    try {
      res = await send(versions.get(id))
    } catch (err) {
      // A live-connected tab already holds a person's edits through sync, so
      // its bytes are a superset of that save and may replace it. Claude's
      // store replace never travels through sync: overwriting it would lose
      // it, so a service writer always latches. One retry, no loop. A person
      // as the LATEST writer does not mean no service wrote since this tab's
      // version, so the generation must not have moved either.
      if (!(err instanceof StoreConflictError) || err.writer !== 'person' || !err.etag || !liveCheck()) throw err
      const held = gens.get(id)
      if (held === undefined || err.gen === null || err.gen !== held) throw err
      res = await send(err.etag)
    }
  } catch (err) {
    if (err instanceof StoreConflictError) conflicted = true
    throw err
  }
  adoptVersion(id, res)
  rememberSaved(id)
}

// --- what this browser last saved -------------------------------------------------
//
// THE STALE RECOVERY SNAPSHOT, CLOSED-TAB EDITION. The kernel writes a
// recovery snapshot on every autosave, before the write. A tab that saved and
// closed leaves one behind that equals what it saved. If anyone writes the
// deck after that (Claude, a colleague), the next boot in this browser finds
// snapshot ≠ store and offered "Unsaved changes from 11:03 were found.
// Restore / Discard"; Restore then saved the old copy over the newer one with
// a fresh ETag and no 412. The editor now clears the snapshot after a save
// that left nothing unsaved, and for one that is still there (the tab closed
// with work unsaved, or a save failed) this record says whether the store has
// moved on since this browser last saved: if it has, Restore is not offered.

const savedKey = (id: string) => `bento-store-saved-${id}`

function rememberSaved(id: string): void {
  const etag = versions.get(id)
  if (etag) lsSet(savedKey(id), etag)
  else lsDel(savedKey(id))
}

/** The version of the open deck this tab booted on (the boot HEAD), or null
 *  when it could not be learned. Waits for that HEAD. */
export async function bootVersion(id: string): Promise<string | null> {
  if (versionCheck) await versionCheck
  return versions.get(id) ?? null
}

/**
 * Has the store moved on since this browser last saved deck `id`? `true` when
 * it has, or when it cannot be told (nothing recorded, no version learned):
 * a snapshot is then never restored over the store, only kept as a new deck.
 */
export async function storeMovedSinceSave(id: string): Promise<boolean> {
  const now = await bootVersion(id)
  const saved = lsGet(savedKey(id))
  return !now || !saved || now !== saved
}

// --- version history in the cloud ---------------------------------------------
//
// The store keeps the version a write replaces whenever it is worth keeping
// (another writer's, an agent's, or one that stood ten minutes: worker.js,
// "deck history"). These two read that list and one version, for the editor's
// Version history. The browser's own timeline only holds what THIS browser
// saw; this one holds what everyone, Claude included, saved.

export interface CloudVersion {
  /** The version's name in the store; pass it back to readCloudVersion. */
  v: string
  /** When that version was written (ISO). */
  at: string
  /** Who wrote it: an email, `grant:<email>` for an agent acting for that
   *  person, or a service token's id. Null when the store did not record it. */
  writer: string | null
  title: string
  size: number
  deleted: boolean
}

/** The kept versions of deck `id`, newest first. Rejects as every store
 *  request does (signed out, unavailable, offline). */
export async function listCloudVersions(id: string): Promise<CloudVersion[]> {
  const res = await storeRequest(`/api/decks/${encodeURIComponent(id)}/history`, { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store' })
  let out: any
  try { out = await res.json() } catch { throw await unreachable(null) }
  const rows = Array.isArray(out?.versions) ? out.versions : []
  return rows.filter((r: any) => r && typeof r.v === 'string' && typeof r.at === 'string').map((r: any) => ({
    v: r.v, at: r.at, writer: typeof r.writer === 'string' && r.writer ? r.writer : null,
    title: typeof r.title === 'string' ? r.title : '', size: Number(r.size) || 0, deleted: !!r.deleted,
  }))
}

/** One kept version's bytes (the whole .bento.html). */
export async function readCloudVersion(id: string, v: string): Promise<string> {
  const res = await storeRequest(`/api/decks/${encodeURIComponent(id)}/history/${encodeURIComponent(v)}`, { method: 'GET', cache: 'no-store' })
  return res.text()
}

/** A writer as a person reads it: "Johan Hal", "Claude, for Johan Hal", or
 *  "An automated run". */
export function writerLabel(writer: string | null): string {
  if (!writer) return ''
  const grant = /^grant:(.+)$/.exec(writer)
  if (grant) return t('An agent, for {name}', { name: grant[1].includes('@') ? nameFromEmail(grant[1]) : grant[1] })
  return writer.includes('@') ? nameFromEmail(writer) : t('An automated run')
}

/** Store a NEW deck; the worker answers 201 {id, url}. */
export async function postDeck(html: string): Promise<{ id: string; url: string }> {
  const res = await storeRequest('/api/decks', { method: 'POST', body: html, headers })
  let out: any
  try {
    out = await res.json()
  } catch {
    throw await unreachable(null) // not the store's JSON: a login page, or an error page
  }
  if (!out || typeof out.url !== 'string' || typeof out.id !== 'string') throw await unreachable(null)
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
  conflicted = false // a boot is a fresh tab; only the rig boots twice
  versionCheck = checkVersion(id)
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
  if (!tab) return Promise.reject(new Error(t('Couldn’t open a tab to save to the cloud — allow pop-ups for this file, then try again.')))

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
    const timer = setTimeout(() => finish(() => reject(new Error(t('Saving to the cloud timed out — the tab gave no answer')))), timeoutMs)
    const poll = setInterval(() => {
      if (tab.closed) finish(() => reject(new Error(t('The tab was closed before the deck was saved to the cloud'))))
    }, pollMs)
    window.addEventListener('message', onMessage)
  })
}
