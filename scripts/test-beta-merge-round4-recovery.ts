#!/usr/bin/env node
// Round 4: exercise the real conflict recovery click handler through failure/retry.
// slides/node_modules/.bin/esbuild scripts/test-beta-merge-round4-recovery.ts --bundle --platform=node --format=esm --outfile=/tmp/beta-merge-round4-recovery.mjs
// node /tmp/beta-merge-round4-recovery.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { newDoc } from '../slides/src/model.ts'
import { gateRestored } from '../slides/src/restoregate.ts'
import { StoreSignedOutError } from '../slides/src/beta/store.ts'
const ts = createRequire(process.cwd() + '/slides/package.json')('typescript')
const ast = ts.createSourceFile('editor.ts', readFileSync('slides/src/editor/editor.ts', 'utf8'), ts.ScriptTarget.Latest, true)
const cls = ast.statements.find((n: any) => ts.isClassDeclaration(n) && n.name.text === 'Editor')
const body = cls.members.find((n: any) => n.name?.getText(ast) === 'showConflictRecoveryBanner').body.getText(ast)
class Node {
  textContent = ''; className = ''; disabled = false; removed = false; children: Node[] = []; listeners: Record<string, any> = {}
  append(...nodes: Node[]) { this.children.push(...nodes) }
  appendChild(n: Node) { this.append(n) }
  addEventListener(t: string, f: any) { this.listeners[t] = f }
  remove() { this.removed = true }
}
async function probe(negative: boolean) {
  const live = newDoc(); live.docId = 'live-id'; live.title = 'service replacement'
  const old = structuredClone(live); old.title = 'local edits'; old.docId = 'untrusted-id'
  old.slides[0].runtime = { src: 'asset:scene', still: 'asset:still', steps: 3, props: [] }
  old.assets = { scene: 'data:text/html;base64,PHAvPg==', still: 'data:image/png;base64,AAAA' }
  const recovered = gateRestored(JSON.stringify(old), live)!.doc
  const savedLive = JSON.stringify(live), savedRecovered = JSON.stringify(recovered)
  const root = new Node(), sent: any[] = [], clears: string[] = [], moves: string[] = [], toasts: string[] = []
  let denied = true
  const deps = {
    document: { querySelector: () => null, createElement: () => new Node(), body: root },
    div: () => new Node(), t: (s: string) => s, newDocId: () => 'fresh-id',
    mintCollab: async () => ({ room: 'new-room', key: 'new-key' }),
    serializeAuto: async (d: any) => JSON.stringify(d),
    postDeck: async (html: string) => { sent.push(JSON.parse(html)); if (denied) throw new StoreSignedOutError('Sign in again'); return { url: 'https://slides.betamobility.ai/d/new' } },
    clearRecovery: async (id: string) => { clears.push('snapshot:' + id) },
    clearStoreConflict: (id: string) => clears.push('marker:' + id),
    location: { assign: (url: string) => moves.push(url) }, StoreSignedOutError, console: { error() {} },
  }
  const source = negative ? body.replace('JSON.stringify(recovered)', 'JSON.stringify(this.store.doc)') : body
  assert(!negative || source !== body)
  const js = ts.transpile('function banner(snap, recovered) ' + source, { target: ts.ScriptTarget.ES2022 })
  const banner = new Function(...Object.keys(deps), js + '; return banner')(...Object.values(deps))
  banner.call({ store: { doc: live }, toast: (s: string) => toasts.push(s) }, { at: Date.now() }, recovered)
  const bar = root.children[0], keep = bar.children[1]
  await keep.listeners.click()
  assert.equal(keep.disabled, false); assert.equal(bar.removed, false)
  assert.deepEqual(clears, []); assert.deepEqual(moves, []); assert.equal(toasts.at(-1), 'Sign in again')
  denied = false
  await keep.listeners.click()
  assert.equal(sent.length, 2)
  const oracle = () => {
    for (const d of sent) {
      assert.equal(d.title, 'local edits', 'the new deck must contain the snapshot, not the store replacement')
      assert.deepEqual(d.slides[0].runtime, old.slides[0].runtime)
      assert.equal(d.docId, 'fresh-id'); assert.equal(d.collab.room, 'new-room')
    }
    assert.equal(JSON.stringify(live), savedLive); assert.equal(JSON.stringify(recovered), savedRecovered)
    assert.deepEqual(clears, ['snapshot:live-id', 'marker:live-id']); assert.equal(moves.length, 1)
    assert.equal(bar.removed, true)
  }
  if (negative) assert.throws(oracle, 'oracle rejects saving the wrong version')
  else oracle()
}
await probe(true) // failing-first control, no product file mutation
await probe(false)
console.log('PASSED: conflict recovery preserves snapshot on signed-out failure and retries as a new deck without touching the live deck')
