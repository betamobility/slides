#!/usr/bin/env node
// BETA FORK: U1 editor integration, not just the pure store policy.
// slides/node_modules/.bin/esbuild scripts/test-beta-merge-store.ts --bundle --platform=node --format=esm --outfile=/tmp/beta-merge-store.mjs
// node /tmp/beta-merge-store.mjs
// Execute the actual editor method bodies, extracted with TS's parser. Stub
// browser/IDB edges only; saveRevision, its queue, gate and policy are real.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { newDoc } from '../slides/src/model.ts'
import { gateRestored } from '../slides/src/restoregate.ts'
import { docContentKey } from '../slides/src/autosave.ts'
import { createSaveQueue, saveRevision } from '../slides/src/saving.ts'
import { StoreConflictError, recoveryChoice } from '../slides/src/beta/store.ts'
const require = createRequire(process.cwd() + '/slides/package.json')
const ts = require('typescript')
const src = readFileSync('slides/src/editor/editor.ts', 'utf8')
const ast = ts.createSourceFile('editor.ts', src, ts.ScriptTarget.Latest, true)
const cls = ast.statements.find((n: any) => ts.isClassDeclaration(n) && n.name.text === 'Editor')
function method(name: string, deps: Record<string, any>, mutate = (s: string) => s) {
  const node = cls.members.find((n: any) => n.name?.getText(ast) === name)
  assert(node, name)
  const body = ts.transpile('async function test() ' + mutate(node.body.getText(ast)), { target: ts.ScriptTarget.ES2022 })
  return new Function(...Object.keys(deps), body + '; return test')(...Object.values(deps))
}
let writes = 0, backups = 0, marked = 0
const store: any = { doc: newDoc(), revision: 0, dirty: true, setDirty(v: boolean) { this.dirty = v } }
const ctx: any = { store, saveQueue: createSaveQueue(store), lastVersionAt: Date.now(), storeConflict: false, flashSaved() {}, refreshDirtyHint() {}, toast() {}, storeConflictMessage() { return 'conflict' } }
// noteStoreConflict is synchronous in production; extraction must preserve it.
const noteNode = cls.members.find((n: any) => n.name?.getText(ast) === 'noteStoreConflict')
ctx.noteStoreConflict = new Function('markStoreConflict', ts.transpile('function note(err, always = false) ' + noteNode.body.getText(ast), { target: ts.ScriptTarget.ES2022 }) + '; return note')(() => marked++).bind(ctx)
const deps = { isEncryptionActive: () => false, isBodySealed: () => false, putRecovery: async () => { backups++; return true }, addVersion: async () => {}, hasFileHandle: () => true, saveRevision, serializeAuto: async (d: any) => JSON.stringify(d), writeUpdatedFile: async () => { writes++; throw new StoreConflictError({ writer: 'service' }) }, markFileSaved() {}, StoreConflictError, t: (s: string) => s }
const run = method('runAutosave', deps).bind(ctx)
await run()
assert.equal(writes, 1)
assert.equal(ctx.storeConflict, true)
assert.equal(store.dirty, true)
assert.equal(marked, 1)
store.revision++
await run()
assert.equal(writes, 1, 'latched editor must never submit a subsequent autosave')
assert.equal(backups, 2, 'recovery continues after refused network save')
// Negative control removes only the merged latch guard: the next write escapes.
await method('runAutosave', deps, s => s.replace(' && !this.storeConflict', '')).call(ctx)
assert.equal(writes, 2, 'negative control exposes the missing latch')
console.log('PASSED: refused autosave latches editor and preserves dirty state/backups; missing-hook control fails')
// Upstream queue behavior still composes: an edit during a successful write is dirty.
ctx.storeConflict = false
const slow = method('runAutosave', { ...deps, writeUpdatedFile: async () => { store.revision++; store.doc.title = 'edit during save' } })
await slow.call(ctx)
assert.equal(store.dirty, true)
let snap: any, conflicted = true, origin = true, banner = '', recovered: any
const recover = method('checkRecovery', { isBodySealed: () => false, getRecovery: async () => snap, gateRestored, docContentKey, hasStoreConflict: () => conflicted, isStoreOrigin: () => origin, recoveryChoice, clearStoreConflict: () => { conflicted = false } })
ctx.showConflictRecoveryBanner = (_: any, doc: any) => { banner = 'new-deck'; recovered = doc }
ctx.showRecoveryBanner = () => { banner = 'restore' }
const older = structuredClone(store.doc)
older.title = 'unsaved local work'
older.docId = 'forged-id'
older.collab = { room: 'forged-room', key: 'forged-key' } as any
;(older.slides[0] as any).unexpected = 'junk'
older.slides[0].runtime = { steps: 2, props: [] }
snap = { at: Date.now(), json: JSON.stringify(older) }
await recover.call(ctx)
assert.equal(banner, 'new-deck')
assert.equal(recovered.docId, store.doc.docId)
assert.equal(recovered.collab, undefined)
assert(!('unexpected' in recovered.slides[0]))
assert.deepEqual(recovered.slides[0].runtime, older.slides[0].runtime)
assert.equal(store.doc.title, 'edit during save', 'recovery offer does not overwrite the open deck')
origin = false; banner = ''; await recover.call(ctx); assert.equal(banner, 'restore')
origin = true; conflicted = false; banner = ''; await recover.call(ctx); assert.equal(banner, 'restore')
for (const json of ['{broken', JSON.stringify(store.doc)]) {
  conflicted = true; banner = ''; snap = { json }; await recover.call(ctx)
  assert.equal(banner, '')
  assert.equal(conflicted, false)
}
assert.equal(recoveryChoice({ mismatch: true, storeOrigin: true, conflicted: true }), 'new-deck')
snap = { json: JSON.stringify(older) }; conflicted = true; banner = ''
await method('checkRecovery', { isBodySealed: () => false, getRecovery: async () => snap, gateRestored, docContentKey, hasStoreConflict: () => conflicted, isStoreOrigin: () => true, recoveryChoice: () => 'restore', clearStoreConflict() {} }).call(ctx)
assert.throws(() => assert.equal(banner, 'new-deck'), 'removing the conflict policy must fail the recovery oracle')
console.log('PASSED: store recovery chooses new deck only after conflict, gates content/credentials, and rejects malformed/equal snapshots')
