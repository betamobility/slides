#!/usr/bin/env node
// Round 5: signed update -> kernel splice -> adopted Beta store handle.
// slides/node_modules/.bin/esbuild scripts/test-beta-merge-round5-update.ts --bundle --platform=node --format=esm --outfile=/tmp/beta-merge-round5-update.mjs
// node /tmp/beta-merge-round5-update.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { configureApp } from '../kernel/src/app.ts'
import { capturePristine, currentFileName } from '../kernel/src/save.ts'
import { checkForUpdates, applyUpdateInPlace } from '../kernel/src/update.ts'
import { installStoreHost } from '../slides/src/beta/store.ts'
import { newDoc } from '../slides/src/model.ts'
import { serializeFile } from '../slides/src/save.ts'
import { createSaveQueue, saveRevision } from '../slides/src/saving.ts'
// DOM boundary only; crypto, queue, update, serializer and store transport are real.
class Shell {
  block = { textContent: '' }; title = { textContent: '' }
  constructor(public version = 'old-shell') {}
  cloneNode() { return new Shell(this.version) }
  querySelectorAll(s: string) { return s === 'script' ? [this.block] : [] }
  getElementById(id: string) { return id === 'bento-doc' ? this.block : null }
  querySelector(s: string) { return s === 'title' ? this.title : null }
  createElement() { return { href: '', download: '', click() { downloads++ } } }
  get documentElement() { return { outerHTML: `<html data-shell="${this.version}"><title>${this.title.textContent}</title><script id="bento-doc">${this.block.textContent}</script></html>` } }
}
let downloads = 0
const g: any = globalThis
const origin = 'https://slides.betamobility.ai'
g.location = { origin, protocol: 'https:', pathname: '/d/UpdateR5', href: origin + '/d/UpdateR5' }
g.window = { location: g.location }; g.window.top = g.window; g.self = g.window
g.document = new Shell()
g.DOMParser = class { parseFromString(s: string) { assert.equal(s, shell); return new Shell('new-shell') } }
const storage = new Map<string, string>()
g.localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) }
const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
configureApp({ appId: 'beta-slides', appName: 'beta/slides', manifestUrl: origin + '/manifest.json', storeHost: origin, publicKeyJwk: await crypto.subtle.exportKey('jwk', keys.publicKey) })
const shell = '<html data-shell="new-shell"><script id="bento-doc">{}</script></html>'
const release = { app: 'beta-slides', version: '9999.1', url: origin + '/shell.html', sha256: createHash('sha256').update(shell).digest('hex') }
const payload = JSON.stringify(release)
const sig = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(payload))).toString('base64')
let badManifest = true, badBytes = false
const writes: any[] = []
g.fetch = async (url: string, init: any = {}) => {
  if (init.method === 'HEAD') return new Response(null, { headers: { etag: 'before', 'x-bento-service-gen': '5' } })
  if (init.method === 'PUT') { writes.push({ url, ...init }); return new Response(null, { headers: { etag: 'after', 'x-bento-service-gen': '5' } }) }
  if (url.endsWith('/manifest.json')) return new Response(JSON.stringify({ payload: badManifest ? payload.replace('9999.1', '9999.2') : payload, sig }))
  assert.equal(url, release.url)
  return new Response(badBytes ? shell + 'tampered' : shell)
}
capturePristine(); assert(installStoreHost())
const doc = newDoc(); doc.docId = 'stable-update-id'
doc.slides[0].runtime = { src: 'asset:scene', still: 'asset:still', steps: 3, props: [] }
doc.assets = { scene: 'data:text/html;base64,PHAvPg==', still: 'data:image/png;base64,AAAA' }
const store: any = { doc, revision: 1, dirty: true, setDirty(v: boolean) { this.dirty = v } }
const queue = createSaveQueue(store)
// Failing-first controls: signed payload tampering and shell digest tampering.
assert.equal((await checkForUpdates()).status, 'error'); assert.equal(writes.length, 0)
badManifest = false
const checked = await checkForUpdates(); assert.equal(checked.status, 'update')
badBytes = true
const rejected = await saveRevision(store, queue, d => applyUpdateInPlace(release, d))
assert.equal(rejected.kind, 'failed'); assert.equal(writes.length, 0); assert.equal(downloads, 0); assert(store.dirty)
badBytes = false
const result = await saveRevision(store, queue, d => applyUpdateInPlace(release, d))
assert.equal(result.kind, 'written'); assert.equal(store.dirty, false)
assert.equal(writes.length, 1); assert.equal(downloads, 1)
assert.equal(writes[0].url, origin + '/api/decks/UpdateR5')
assert.equal(writes[0].headers['if-match'], 'before')
assert(writes[0].body.includes('data-shell="new-shell"'))
const saved = JSON.parse(writes[0].body.match(/id="bento-doc">([\s\S]*?)<\/script>/)[1])
assert.deepEqual(saved, doc, 'an accepted update must carry exactly the document, runtime assets included')
assert.equal(currentFileName(), 'UpdateR5.bento.html')
// Reloaded new shell: a subsequent ordinary save keeps the new carrier and schema first.
g.document = new Shell('new-shell'); capturePristine()
const after = serializeFile(saved)
assert(after.includes('data-shell="new-shell"'))
assert.equal(Object.keys(JSON.parse(after.match(/id="bento-doc">([\s\S]*?)<\/script>/)![1]))[0], '$schema')
console.log('PASSED: signed store update rejects tampering, downloads rollback, PUTs new shell with runtime data, and saves schema first after reload')
