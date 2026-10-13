#!/usr/bin/env node
// Round 5: overlap autosave, a manual save and another edit around a store 412.
// slides/node_modules/.bin/esbuild scripts/test-beta-merge-round5-save-burst.ts --bundle --platform=node --format=esm --outfile=/tmp/beta-merge-round5-save-burst.mjs
// node /tmp/beta-merge-round5-save-burst.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { configureApp } from '../kernel/src/app.ts'
import { capturePristine, hasFileHandle, writeUpdatedFile } from '../kernel/src/save.ts'
import { serializeAuto, saveFile } from '../slides/src/save.ts'
import { newDoc } from '../slides/src/model.ts'
import { createSaveQueue, saveRevision } from '../slides/src/saving.ts'
import { installStoreHost, StoreConflictError, StoreSignedOutError, markStoreConflict, hasStoreConflict, clearStoreConflict, recoveryChoice } from '../slides/src/beta/store.ts'
import { gateRestored } from '../slides/src/restoregate.ts'
import { docContentKey } from '../slides/src/autosave.ts'
const ts = createRequire(process.cwd() + '/slides/package.json')('typescript')
const ast = ts.createSourceFile('editor.ts', readFileSync('slides/src/editor/editor.ts', 'utf8'), ts.ScriptTarget.Latest, true)
const cls = ast.statements.find((n: any) => ts.isClassDeclaration(n) && n.name.text === 'Editor')
function method(name: string, args: string, deps: any, mutation = (s: string) => s) {
  const body = cls.members.find((n: any) => n.name?.getText(ast) === name).body.getText(ast)
  return new Function(...Object.keys(deps), ts.transpile(`async function f(${args}) ${mutation(body)}`, { target: ts.ScriptTarget.ES2022 }) + ';return f')(...Object.values(deps))
}
class Shell {
  block = { textContent: '' }; title = { textContent: '' }
  cloneNode() { return new Shell() }
  querySelectorAll(s: string) { return s === 'script' ? [this.block] : [] }
  getElementById(id: string) { return id === 'bento-doc' ? this.block : null }
  querySelector(s: string) { return s === 'title' ? this.title : null }
  get documentElement() { return { outerHTML: `<html><title>${this.title.textContent}</title><script id="bento-doc">${this.block.textContent}</script></html>` } }
}
const g: any = globalThis, origin = 'https://slides.betamobility.ai'
g.document = new Shell(); g.location = { origin, protocol: 'https:', pathname: '/d/BurstR5', href: origin + '/d/BurstR5' }
g.window = { location: g.location }; g.window.top = g.window; g.self = g.window
const storage = new Map<string, string>()
g.localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) }
configureApp({ appId: 'beta-slides', appName: 'beta/slides', manifestUrl: origin + '/manifest', storeHost: origin })
let release!: () => void, entered!: () => void, puts = 0, serializations = 0
const pending = new Promise<void>(r => { release = r }), firstPut = new Promise<void>(r => { entered = r })
g.fetch = async (_url: string, init: any) => {
  if (init.method === 'HEAD') return new Response(null, { headers: { etag: 'old', 'x-bento-service-gen': '1' } })
  assert.equal(init.method, 'PUT'); puts++; entered(); await pending
  return new Response(JSON.stringify({ writer: 'service' }), { status: 412, headers: { etag: 'replacement', 'x-bento-service-gen': '2', 'content-type': 'application/json' } })
}
capturePristine(); assert(installStoreHost())
const store: any = { doc: newDoc(), revision: 1, dirty: true, setDirty(v: boolean) { this.dirty = v } }
store.doc.title = 'first edit'
let snapshot: any, banner = '', recovered: any
const deps: any = { hasFileHandle, writeUpdatedFile, saveRevision, saveFile, serializeAuto: async (d: any) => { serializations++; return serializeAuto(d) }, isEncryptionActive: () => false,
  putRecovery: async (d: any) => { snapshot = { at: Date.now(), json: JSON.stringify(d) }; return true }, addVersion: async () => {}, markFileSaved() {}, StoreConflictError, StoreSignedOutError, t: (s: string) => s, console: { error() {} } }
const ctx: any = { store, saveQueue: createSaveQueue(store), lastVersionAt: Date.now(), storeConflict: false, flashSaved() {}, refreshDirtyHint() {}, toast() {}, canvas: { commitTextEdit() {} }, storeConflictMessage: () => 'conflict' }
ctx.noteStoreConflict = method('noteStoreConflict', 'err, always = false', { markStoreConflict }).bind(ctx)
const auto = method('runAutosave', '', deps).bind(ctx), manual = method('save', 'forcePicker', deps).bind(ctx)
const a = auto(); await firstPut
store.doc.title = 'second edit during in-flight save'; store.revision++
const b = manual(false), c = auto()
release(); await Promise.all([a, b, c])
assert.equal(puts, 1, 'already queued jobs must be stopped by the store transport latch')
assert(store.dirty); assert(ctx.storeConflict); assert(hasStoreConflict(store.doc.docId))
store.doc.title = 'third edit after refusal'; store.revision++
const before = serializations
await auto()
const noSerializeOracle = () => assert.equal(serializations, before, 'latched editor backs up without serializing another network write')
noSerializeOracle(); assert.equal(JSON.parse(snapshot.json).title, store.doc.title)
// Failing-first control: remove only the editor latch; lower transport still refuses,
// but the unnecessary serializer call is detected by the oracle.
await method('runAutosave', '', deps, s => s.replace(' && !this.storeConflict', '')).call(ctx)
assert.throws(noSerializeOracle)
// Simulated reload from the store replacement, with the real persisted conflict marker.
const replaced = structuredClone(store.doc); replaced.title = 'service replacement'; store.doc = replaced
ctx.showConflictRecoveryBanner = (_snap: any, d: any) => { banner = 'new-deck'; recovered = d }
ctx.showRecoveryBanner = () => { banner = 'restore' }
await method('checkRecovery', '', { getRecovery: async () => snapshot, gateRestored, docContentKey, hasStoreConflict, clearStoreConflict, recoveryChoice, isStoreOrigin: () => true }).call(ctx)
assert.equal(banner, 'new-deck'); assert.equal(recovered.title, 'third edit after refusal')
assert.equal(store.doc.title, 'service replacement')
console.log('PASSED: overlapping autosave/manual writes latch on one 412, keep newest recovery and offer it as a new deck after reload')
