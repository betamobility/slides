#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Beta deck-store CLIENT rig (plan 2026-09-08-002, U8, KTD10 + KTD11): the
// editor side of slides.betamobility.ai, in node, against a fake browser.
//
//   node scripts/test-beta-store-client.ts
//
// WHAT THIS PROVES. `slides/src/beta/store.ts` is the only code that knows
// the store exists; the kernel's save paths reach it through a polyfilled
// `showSaveFilePicker` and an adopted file handle (KTD10). So the things
// worth pinning are the contract edges, not the editor:
//
//   1. THE HANDLE. What the kernel writes into the store-backed handle is
//      PUT, byte for byte, to /api/decks/<id> on the store origin, with
//      `redirect: 'manual'` and same-origin credentials. An `opaqueredirect`
//      (an expired Access session), a rejected fetch and a bare 401 each
//      reject with the signed-out error, so the kernel's failure path fires
//      instead of a silent "Saved".
//   2. THE PICKER IDS. `bento-doc` writes the open id in place; `bento-copy`
//      and `bento-share` POST a new object and navigate to its url — and a
//      non-JSON body there (the Access login page) is signed-out; `bento-
//      backup` becomes a download; anything else falls through to the
//      browser's own picker.
//   3. THE HANDOFF. On file:// the deck opens <storeHost>/new, accepts a
//      `ready` only from that origin AND that tab, posts the document to
//      storeHost only (never "*"), resolves the url from a `saved` message
//      with the same checks, and times out rather than hanging.
//
// The wire shape is the one server/deck-store/src/pages.js speaks:
// {type:'bento-store-ready'} → {type:'bento-store-save', html, title} →
// {type:'bento-store-saved', url}. Change both sides or neither.
//
// Bundles itself with esbuild from slides/node_modules (store.ts reaches the
// kernel, whose imports are extensionful, and i18n, whose are not).

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

if (import.meta.url.endsWith('.ts')) {
  const self = fileURLToPath(import.meta.url)
  const root = resolve(self, '../..')

  console.log('§1 static')
  const storePath = join(root, 'slides/src/beta/store.ts')
  ok(existsSync(storePath), 'slides/src/beta/store.ts exists')
  const editor = readFileSync(join(root, 'slides/src/editor/editor.ts'), 'utf8')
  ok(/Save to Beta…/.test(editor), 'editor.ts offers "Save to Beta…"')
  ok(/handoffToStore\(/.test(editor), 'editor.ts routes it through handoffToStore()')
  ok(/isStoreOrigin\(\)/.test(editor), 'editor.ts branches on isStoreOrigin()')
  const main = readFileSync(join(root, 'slides/src/main.ts'), 'utf8')
  ok(/installStoreHost\(\)/.test(main), 'main.ts installs the store host at boot')
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
  ok(ci.includes('scripts/test-beta-store-client.ts'), 'ci.yml runs this rig')
  const pages = readFileSync(join(root, 'server/deck-store/src/pages.js'), 'utf8')
  for (const type of ['bento-store-ready', 'bento-store-save', 'bento-store-saved']) {
    ok(pages.includes(`'${type}'`), `pages.js speaks '${type}'`)
  }

  if (!existsSync(storePath)) {
    console.log(`\n§1: ${checks} checks, ${failures} failed — store module missing, module checks skipped`)
    process.exit(1)
  }
  const esbuild = join(root, 'slides/node_modules/.bin/esbuild')
  if (!existsSync(esbuild)) { console.log(`  FAIL  ${esbuild} is missing: run "npm ci" in slides/ first`); process.exit(1) }
  const dir = join(tmpdir(), `beta-store-client-rig-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const bundle = join(dir, 'test-beta-store-client.mjs')
  execFileSync(esbuild, [self, '--bundle', '--platform=node', '--format=esm', '--log-level=warning', `--outfile=${bundle}`], { stdio: 'inherit' })
  const r = spawnSync(process.execPath, ['--no-warnings', bundle], { stdio: 'inherit' })
  rmSync(dir, { recursive: true, force: true })
  console.log(`\n§1: ${checks} checks, ${failures} failed`)
  process.exit(failures || (r.status ?? 1) ? 1 : 0)
}

// ---- §2 module: a fake browser ---------------------------------------------------
const STORE = 'https://slides.betamobility.ai'
const g = globalThis as any

// localStorage: net.ts reads the offline switch, save.ts nothing at import
const ls = new Map<string, string>()
g.localStorage = {
  getItem: (k: string) => ls.get(k) ?? null,
  setItem: (k: string, v: string) => { ls.set(k, String(v)) },
  removeItem: (k: string) => { ls.delete(k) },
}

/** A window that is a plain listener registry — message events are dispatched
 *  as {data, origin, source} objects, which is all store.ts reads. */
type Listener = (ev: any) => void
const listeners = new Map<string, Set<Listener>>()
const fakeWindow: any = {
  addEventListener(type: string, fn: Listener) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn) },
  removeEventListener(type: string, fn: Listener) { listeners.get(type)?.delete(fn) },
  emit(type: string, ev: any) { for (const fn of [...(listeners.get(type) ?? [])]) fn(ev) },
  listenerCount(type: string) { return listeners.get(type)?.size ?? 0 },
  open: (_url: string, _target?: string) => null as any,
  setTimeout, clearTimeout,
}
g.window = fakeWindow
g.location = { origin: STORE, href: `${STORE}/d/abc123XYZ0`, pathname: '/d/abc123XYZ0', protocol: 'https:', assign: (_u: string) => {} }

// fetch: records every call; the response is whatever the test queued
type Call = { url: string; init: RequestInit; body: string }
const calls: Call[] = []
let nextResponse: (() => Promise<Response>) | null = null
g.fetch = async (input: any, init: RequestInit = {}) => {
  const body = typeof init.body === 'string' ? init.body : init.body instanceof Blob ? await (init.body as Blob).text() : String(init.body ?? '')
  calls.push({ url: String(input), init, body })
  if (!nextResponse) throw new TypeError('no response queued')
  return nextResponse()
}
const respond = (fn: () => Promise<Response>) => { nextResponse = fn }
const last = () => calls[calls.length - 1]

// document + URL: the kernel's downloadFile needs an anchor it can click
const downloads: Array<{ href: string; download: string }> = []
g.document = {
  createElement: (_tag: string) => {
    const a: any = { href: '', download: '' }
    a.click = () => downloads.push({ href: a.href, download: a.download })
    return a
  },
}
const blobs = new Map<string, Blob>()
;(URL as any).createObjectURL = (b: Blob) => { const u = `blob:rig/${blobs.size}`; blobs.set(u, b); return u }
;(URL as any).revokeObjectURL = (_u: string) => {}

const { configureApp } = await import('../kernel/src/app.ts')
const save = await import('../kernel/src/save.ts')
const store = await import('../slides/src/beta/store.ts')

// ---- origin + id ----------------------------------------------------------------
console.log('§2 origin and id')
ok(store.isStoreOrigin() === false, 'before configureApp(): isStoreOrigin() is false, no throw')
configureApp({ appId: 'beta-slides', appName: 'beta/slides', manifestUrl: 'https://example.test/m.json', storeHost: STORE })
ok(store.isStoreOrigin() === true, `location.origin === storeHost → isStoreOrigin()`)
ok(store.storeIdFromLocation() === 'abc123XYZ0', 'storeIdFromLocation() reads /d/<id>')
{
  const saved = g.location
  g.location = { ...saved, origin: 'null', href: 'file:///Users/x/deck.bento.html', pathname: '/Users/x/deck.bento.html', protocol: 'file:' }
  ok(store.isStoreOrigin() === false, 'file:// is not the store origin')
  ok(store.storeIdFromLocation() === null, 'no /d/<id> → null')
  g.location = { ...saved, pathname: '/new' }
  ok(store.storeIdFromLocation() === null, '/new carries no deck id')
  g.location = saved
}

// ---- the handle -----------------------------------------------------------------
console.log('\n§3 the store-backed handle')
const html = '<!DOCTYPE html><html><head><script id="bento-doc" type="application/bento+json">{"format":"bento/slides"}<\/script></head></html>'
async function writeThrough(handle: any, text: string) {
  const w = await handle.createWritable()
  await w.write(new Blob([text], { type: 'text/html' }))
  await w.close()
}
{
  const h = store.storeHandle('abc123XYZ0')
  ok(typeof h.name === 'string' && h.name.endsWith('.bento.html'), `handle has a .bento.html name (${h.name})`)
  respond(async () => new Response(null, { status: 200 }))
  await writeThrough(h, html)
  const c = last()
  ok(c.url === `${STORE}/api/decks/abc123XYZ0`, `PUT goes to ${STORE}/api/decks/<id> (${c.url})`)
  ok(c.init.method === 'PUT', 'method is PUT')
  ok(c.init.redirect === 'manual', "redirect: 'manual' (an Access login hop must not be followed)")
  ok(c.init.credentials === 'same-origin', "credentials: 'same-origin' (the Access cookie)")
  ok(c.body === html, 'the body is exactly the bytes the kernel wrote')
  ok(/text\/html/.test(String((c.init.headers as any)?.['content-type'] ?? '')), 'content-type is text/html')

  // written in two chunks, still one body
  respond(async () => new Response(null, { status: 200 }))
  const w = await h.createWritable(); await w.write('ab'); await w.write(new Blob(['cd'])); await w.close()
  ok(last().body === 'abcd', 'chunks written separately arrive as one body')
}
async function rejects(fn: () => Promise<unknown>): Promise<any> {
  try { await fn(); return null } catch (e) { return e }
}
{
  const h = store.storeHandle('abc123XYZ0')
  respond(async () => ({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers(), text: async () => '', json: async () => { throw new Error('x') } } as any))
  let e = await rejects(() => writeThrough(h, html))
  ok(e instanceof store.StoreSignedOutError, `opaqueredirect → StoreSignedOutError (${e?.name})`)
  ok(/sign in/i.test(String(e?.message)), `…whose message tells the author to sign in: "${e?.message}"`)
  respond(async () => { throw new TypeError('Failed to fetch') })
  e = await rejects(() => writeThrough(h, html))
  ok(e instanceof store.StoreSignedOutError, 'a rejected fetch → StoreSignedOutError')
  respond(async () => new Response(null, { status: 401 }))
  e = await rejects(() => writeThrough(h, html))
  ok(e instanceof store.StoreSignedOutError, 'a bare 401 → StoreSignedOutError')
  respond(async () => new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
  e = await rejects(() => writeThrough(h, html))
  ok(e instanceof store.StoreSignedOutError, 'a 200 that is an HTML page (a login page) → StoreSignedOutError')
  respond(async () => new Response('size', { status: 400 }))
  e = await rejects(() => writeThrough(h, html))
  ok(e && !(e instanceof store.StoreSignedOutError) && /400/.test(String(e.message)), `a 400 rejects with the status, NOT as signed-out: "${e?.message}"`)
  ls.set('bento-offline', 'on')
  e = await rejects(() => writeThrough(h, html))
  ok(e?.name === 'OfflineError', `offline mode refuses the PUT (${e?.name}) — the store goes through net.ts`)
  ls.delete('bento-offline')
}

// ---- the host -------------------------------------------------------------------
console.log('\n§4 installStoreHost(): picker ids')
{
  ok(store.installStoreHost() === true, 'installStoreHost() on /d/<id> installs (returns true)')
  ok(save.hostCan('write') && save.hostCan('backup'), "hostCan('write') and hostCan('backup')")
  ok(!save.hostCan('claim'), 'no capability it does not have')
  ok(save.hasFileHandle(), 'the open id is adopted: hasFileHandle() is true, so ⌘S/autosave/update write in place')
  ok(save.canWriteInPlace(), 'canWriteInPlace() (no "cannot rewrite" notice on the store)')
  ok(save.openedFileName() === 'abc123XYZ0.bento.html', `openedFileName() is the id (${save.openedFileName()})`)

  // bento-doc: PUT the same id
  respond(async () => new Response(null, { status: 200 }))
  const doc = await fakeWindow.showSaveFilePicker({ id: 'bento-doc', suggestedName: 'whatever.bento.html', startIn: {} })
  await writeThrough(doc, html)
  ok(last().init.method === 'PUT' && last().url.endsWith('/api/decks/abc123XYZ0'), 'bento-doc → PUT /api/decks/<same id>')

  // bento-copy: POST new, navigate
  let navigated = ''
  g.location.assign = (u: string) => { navigated = u }
  respond(async () => new Response(JSON.stringify({ id: 'newID12345', url: `${STORE}/d/newID12345` }), { status: 201, headers: { 'content-type': 'application/json' } }))
  const putsBefore = calls.filter((c) => c.init.method === 'PUT').length
  const copy = await fakeWindow.showSaveFilePicker({ id: 'bento-copy', suggestedName: 'x.bento.html' })
  await writeThrough(copy, html)
  ok(last().init.method === 'POST' && last().url === `${STORE}/api/decks`, 'bento-copy → POST /api/decks')
  ok(last().init.redirect === 'manual' && last().init.credentials === 'same-origin', '…with manual redirect + same-origin credentials')
  await new Promise((r) => setTimeout(r, 5))
  ok(navigated === `${STORE}/d/newID12345`, `…then navigates to the returned url (${navigated})`)
  ok(calls.filter((c) => c.init.method === 'PUT').length === putsBefore, 'the original id was not written by the copy (no PUT)')

  // bento-share: same route, but a share export is a DERIVED file — it opens
  // in a new tab and the author stays on the deck being edited
  navigated = ''
  let openedShare = ''
  fakeWindow.open = (u: string) => { openedShare = u; return {} as any }
  respond(async () => new Response(JSON.stringify({ id: 'shareID123', url: `${STORE}/d/shareID123` }), { status: 201, headers: { 'content-type': 'application/json' } }))
  const share = await fakeWindow.showSaveFilePicker({ id: 'bento-share', suggestedName: 'x-invite.bento.html' })
  await writeThrough(share, html)
  await new Promise((r) => setTimeout(r, 5))
  ok(last().init.method === 'POST' && openedShare === `${STORE}/d/shareID123` && navigated === '', 'bento-share → POST /api/decks, opens the export in a new tab, does not navigate')
  // …and when the browser blocks the popup, the object is not lost: navigate instead
  fakeWindow.open = () => null
  respond(async () => new Response(JSON.stringify({ id: 'shareID456', url: `${STORE}/d/shareID456` }), { status: 201, headers: { 'content-type': 'application/json' } }))
  const share2 = await fakeWindow.showSaveFilePicker({ id: 'bento-share', suggestedName: 'y-viewonly.bento.html' })
  await writeThrough(share2, html)
  await new Promise((r) => setTimeout(r, 5))
  ok(navigated === `${STORE}/d/shareID456`, 'bento-share with the popup blocked falls back to navigating')
  fakeWindow.open = (_url: string, _target?: string) => null as any

  // POST with a non-JSON body = the login page = signed out
  respond(async () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
  const e = await rejects(() => writeThrough(store.newDeckHandle('x.bento.html'), html))
  ok(e instanceof store.StoreSignedOutError, 'POST answered with a non-JSON body → StoreSignedOutError')

  // a FAILED copy must not leave the create handle as the ⌘S target: the
  // kernel adopts the picked handle before writing through it
  respond(async () => new Response(null, { status: 401 }))
  const failedCopy = await fakeWindow.showSaveFilePicker({ id: 'bento-copy', suggestedName: 'x.bento.html' })
  save.adoptFileHandle(failedCopy) // what saveFile(doc, true) does before the write
  const ef = await rejects(() => writeThrough(failedCopy, html))
  ok(ef instanceof store.StoreSignedOutError, 'a signed-out bento-copy write rejects')
  respond(async () => new Response(null, { status: 200 }))
  await save.writeUpdatedFile(html)
  ok(last().init.method === 'PUT' && last().url.endsWith('/api/decks/abc123XYZ0'), '…and the next in-place write still PUTs the ORIGINAL id (the handle was re-adopted, no duplicate deck)')

  // bento-backup: a download, no request
  const before = calls.length
  const backup = await fakeWindow.showSaveFilePicker({ id: 'bento-backup', suggestedName: 'abc.v2026.9.1-backup.bento.html' })
  await writeThrough(backup, html)
  ok(calls.length === before, 'bento-backup makes no request')
  ok(downloads.length === 1 && downloads[0].download === 'abc.v2026.9.1-backup.bento.html', `bento-backup downloads under the suggested name (${downloads[0]?.download})`)
  ok(await blobs.get(downloads[0]?.href)?.text() === html, '…with the bytes the kernel wrote')

  // unknown id: not ours
  const eu = await rejects(() => fakeWindow.showSaveFilePicker({ id: 'something-else' }))
  ok(eu?.name === 'AbortError', `an unknown picker id is declined with AbortError when there is no native picker (${eu?.name})`)
}

// ---- the handoff ----------------------------------------------------------------
console.log('\n§5 handoffToStore(): the /new tab protocol')
{
  const saved = g.location
  g.location = { origin: 'null', href: 'file:///Users/x/deck.bento.html', pathname: '/Users/x/deck.bento.html', protocol: 'file:', assign: () => {} }
  const posted: Array<{ data: any; origin: string }> = []
  const tab: any = { closed: false, postMessage: (data: any, origin: string) => posted.push({ data, origin }) }
  let opened = ''
  fakeWindow.open = (url: string, target?: string) => { opened = url; void target; return tab }

  // happy path
  let p = store.handoffToStore(html, 'Q3 board', { timeoutMs: 2000 })
  ok(opened === `${STORE}/new`, `opens ${STORE}/new (${opened})`)
  ok(fakeWindow.listenerCount('message') === 1, 'one message listener while waiting')
  // ready from the wrong origin: ignored
  fakeWindow.emit('message', { data: { type: 'bento-store-ready' }, origin: 'https://evil.example', source: tab })
  ok(posted.length === 0, 'a ready from another origin is ignored (nothing posted)')
  // ready from the right origin but another window: ignored
  fakeWindow.emit('message', { data: { type: 'bento-store-ready' }, origin: STORE, source: {} })
  ok(posted.length === 0, 'a ready from another window on the store origin is ignored')
  // the real ready
  fakeWindow.emit('message', { data: { type: 'bento-store-ready' }, origin: STORE, source: tab })
  ok(posted.length === 1, 'the tab\'s own ready is answered once')
  ok(posted[0]?.data?.type === 'bento-store-save' && posted[0]?.data?.html === html, 'with {type: bento-store-save, html}')
  ok(posted[0]?.data?.title === 'Q3 board', 'and the title, for the page to show before Save')
  ok(posted[0]?.origin === STORE, `posted with targetOrigin storeHost, never "*" (${posted[0]?.origin})`)
  // a second ready must not re-send the document
  fakeWindow.emit('message', { data: { type: 'bento-store-ready' }, origin: STORE, source: tab })
  ok(posted.length === 1, 'a second ready does not re-send the document')
  // saved from the wrong origin / source: ignored
  fakeWindow.emit('message', { data: { type: 'bento-store-saved', url: 'https://evil.example/d/x' }, origin: 'https://evil.example', source: tab })
  fakeWindow.emit('message', { data: { type: 'bento-store-saved', url: `${STORE}/d/x` }, origin: STORE, source: {} })
  let settled = false
  void p.then(() => { settled = true }, () => { settled = true })
  await new Promise((r) => setTimeout(r, 5))
  ok(!settled, 'a saved message from another origin or window does not resolve')
  fakeWindow.emit('message', { data: { type: 'bento-store-saved', url: `${STORE}/d/newID12345` }, origin: STORE, source: tab })
  ok(await p === `${STORE}/d/newID12345`, 'the tab\'s own saved message resolves the url')
  ok(fakeWindow.listenerCount('message') === 0, 'the listener is removed on settle')

  // a saved url must be on the store origin
  posted.length = 0
  p = store.handoffToStore(html, 'x', { timeoutMs: 2000 })
  fakeWindow.emit('message', { data: { type: 'bento-store-ready' }, origin: STORE, source: tab })
  fakeWindow.emit('message', { data: { type: 'bento-store-saved', url: 'https://evil.example/d/x' }, origin: STORE, source: tab })
  fakeWindow.emit('message', { data: { type: 'bento-store-saved', url: `${STORE}/d/ok1234567` }, origin: STORE, source: tab })
  ok(await p === `${STORE}/d/ok1234567`, 'a saved url off the store origin is ignored; the next valid one resolves')

  // timeout
  posted.length = 0
  const t0 = Date.now()
  const e = await rejects(() => store.handoffToStore(html, 'x', { timeoutMs: 60 }))
  ok(!!e && /timed out|no answer/i.test(String(e?.message)) && Date.now() - t0 < 1500, `rejects after the timeout ("${e?.message}")`)
  ok(fakeWindow.listenerCount('message') === 0, 'the listener is removed on timeout')

  // tab closed before ready
  const closedTab: any = { closed: true, postMessage: () => {} }
  fakeWindow.open = () => closedTab
  const ec = await rejects(() => store.handoffToStore(html, 'x', { timeoutMs: 2000, pollMs: 10 }))
  ok(!!ec && /closed/i.test(String(ec?.message)), `a closed tab rejects promptly ("${ec?.message}")`)

  // popup blocked
  fakeWindow.open = () => null
  const eb = await rejects(() => store.handoffToStore(html, 'x', { timeoutMs: 2000 }))
  ok(!!eb && /pop-?ups?/i.test(String(eb?.message)), `a blocked popup rejects with advice ("${eb?.message}")`)

  // offline
  fakeWindow.open = () => tab
  ls.set('bento-offline', 'on')
  const eo = await rejects(() => store.handoffToStore(html, 'x', { timeoutMs: 2000 }))
  ok(eo?.name === 'OfflineError', `offline mode refuses the handoff (${eo?.name})`)
  ls.delete('bento-offline')
  g.location = saved
}

console.log(`\n§2–5: ${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
