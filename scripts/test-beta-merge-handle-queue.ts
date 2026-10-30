#!/usr/bin/env node
// Round 2: actual merged save queue -> save facade -> kernel -> store polyfill.
// slides/node_modules/.bin/esbuild scripts/test-beta-merge-handle-queue.ts --bundle --platform=node --format=esm --outfile=/tmp/beta-merge-handle-queue.mjs
// node /tmp/beta-merge-handle-queue.mjs
import assert from 'node:assert/strict'
import { configureApp } from '../kernel/src/app.ts'
import { capturePristine, currentFileName, writeUpdatedFile } from '../kernel/src/save.ts'
import { saveFile } from '../slides/src/save.ts'
import { newDoc } from '../slides/src/model.ts'
import { createSaveQueue, saveRevision } from '../slides/src/saving.ts'
import { installStoreHost, newDeckHandle, StoreSignedOutError } from '../slides/src/beta/store.ts'
class Shell {
  block = { textContent: '' }; title = { textContent: '' }
  cloneNode() { return new Shell() }
  querySelectorAll(s: string) { return s === 'script' ? [this.block] : [] }
  getElementById(id: string) { return id === 'bento-doc' ? this.block : null }
  querySelector(s: string) { return s === 'title' ? this.title : null }
  get documentElement() { return { outerHTML: `<html><title>${this.title.textContent}</title><script id="bento-doc">${this.block.textContent}</script></html>` } }
}
const g: any = globalThis
g.document = new Shell()
g.location = { origin: 'https://slides.betamobility.ai', protocol: 'https:', pathname: '/d/QueueDeck1', href: 'https://slides.betamobility.ai/d/QueueDeck1', assign() { throw new Error('failed copy must not navigate') } }
g.window = { location: g.location }; g.window.top = g.window; g.self = g.window
const storage = new Map<string, string>()
g.localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) }
configureApp({ appId: 'beta-slides', appName: 'beta/slides', manifestUrl: 'https://invalid.example/manifest', storeHost: g.location.origin })
const calls: any[] = []
let releasePost!: () => void
const postPending = new Promise<void>(r => { releasePost = r })
g.fetch = async (url: any, init: any) => {
  calls.push({ url, ...init })
  if (init.method === 'HEAD') return new Response(null, { headers: { etag: 'v1', 'x-bento-service-gen': '0' } })
  if (init.method === 'POST') { await postPending; return new Response(null, { status: 401 }) }
  return new Response(null, { headers: { etag: 'v2', 'x-bento-service-gen': '0' } })
}
capturePristine()
assert(installStoreHost())
const store: any = { doc: newDoc(), revision: 0, dirty: true, setDirty(v: boolean) { this.dirty = v } }
const queue = createSaveQueue(store)
const copy = saveRevision(store, queue, snapshot => saveFile(snapshot, true))
// Let the POST reach its deliberately suspended response.
for (let i = 0; i < 30 && !calls.some(c => c.method === 'POST'); i++) await new Promise(r => setTimeout(r, 0))
assert(calls.some(c => c.method === 'POST'))
const auto = saveRevision(store, queue, async snapshot => { await writeUpdatedFile(JSON.stringify(snapshot)); return 'saved' })
assert.equal(calls.filter(c => c.method === 'PUT').length, 0, 'autosave waits behind copy')
releasePost()
const failed = await copy
assert.equal(failed.kind, 'failed')
assert(failed.kind === 'failed' && failed.error instanceof StoreSignedOutError)
const saved = await auto
assert.equal(saved.kind, 'written')
assert.equal(currentFileName(), 'QueueDeck1.bento.html')
assert.equal(calls.filter(c => c.method === 'POST').length, 1, 'autosave must not mint another copy')
const put = calls.find(c => c.method === 'PUT')
assert(put.url.endsWith('/api/decks/QueueDeck1'))
assert.equal(put.headers['if-match'], 'v1')
assert.equal(store.dirty, false)
// Failing-first control: remove only the store picker's settlement hook.
// Kernel adopts the one-shot POST handle, and the next autosave must now fail
// our destination oracle by trying to mint another object.
const picker = g.window.showSaveFilePicker
g.window.showSaveFilePicker = (opts: any) => opts.id === 'bento-copy'
  ? Promise.resolve(newDeckHandle(opts.suggestedName)) : picker(opts)
const before = calls.length
await saveRevision(store, queue, snapshot => saveFile(snapshot, true))
await saveRevision(store, queue, async () => { await writeUpdatedFile('negative control'); return 'saved' })
const escaped = calls.slice(before)
// Since upstream 1.2.10 (#713, "Save a copy keeps you on the original") the
// kernel never adopts a copy's handle, so even WITHOUT the fork's settlement
// hook the next autosave goes back to the deck (PUT), not to a second POST.
// The hook is now a second line of defence; this pins that upstream's own
// guarantee holds, so a regression there fails here.
assert.equal(escaped.filter(c => c.method === 'POST').length, 1, 'only the copy itself POSTs, even without the hook (upstream #713)')
assert.equal(escaped.at(-1).method, 'PUT', 'the autosave after a copy writes the open deck')
console.log('PASSED: refused Save a copy restores the store handle before queued autosave; no duplicate POST or navigation; upstream keeps the original after a copy')
