#!/usr/bin/env node
// U1/R23: pre-merge serializer -> restored runtime/layout -> collision paste
// -> encrypted save -> decrypt/reopen -> plain save, including blob pruning.
// slides/node_modules/.bin/esbuild scripts/test-beta-merge-round6-encrypted.ts --bundle --platform=node --format=esm --outfile=/tmp/beta-r6-encrypted.mjs
// node /tmp/beta-r6-encrypted.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { configureApp } from '../kernel/src/app.ts'
import { capturePristine, serializeAuto, setEncryptionPassword, parseEnvelope, decryptEnvelope, registerPreview } from '../slides/src/save.ts'
import { newDoc, parseDoc } from '../slides/src/model.ts'
import { gateRestored } from '../slides/src/restoregate.ts'
import { serializeSlides, parseClip, insertSlides } from '../slides/src/editor/clipboard.ts'
const ts = createRequire(process.cwd() + '/slides/package.json')('typescript')
// DOM-boundary double, with an old plaintext preview actually removed from output.
class Shell {
  block = { textContent: '' }; title = { textContent: '' }; stale = true
  cloneNode() { const s = new Shell(); s.stale = this.stale; return s }
  querySelectorAll(selector: string) {
    if (selector === 'script') return [this.block]
    if (selector === '[data-bento-preview]' && this.stale) return [{ remove: () => { this.stale = false } }]
    return []
  }
  getElementById(id: string) { return id === 'bento-doc' ? this.block : null }
  querySelector(s: string) { return s === 'title' ? this.title : null }
  get documentElement() { return { outerHTML: `<html><title>${this.title.textContent}</title>${this.stale ? '<div data-bento-preview>PRIVATE OLD PREVIEW</div>' : ''}<script id="bento-doc">${this.block.textContent}</script></html>` } }
}
configureApp({ appId: 'beta-slides', appName: 'beta/slides', manifestUrl: 'https://example.invalid/manifest' })
const ast = ts.createSourceFile('legacy.ts', readFileSync('scripts/fixtures/beta-kernel-save-pre-v1.2.7.ts.txt', 'utf8'), ts.ScriptTarget.Latest, true)
const fn = ast.statements.find((n: any) => ts.isFunctionDeclaration(n) && n.name?.text === 'serializeBody')
assert(fn)
const legacySave = new Function('TRANSIENT_SELECTOR', 'shellBlocks', 'managedTypes', 'DATA_BLOCK_ID', 'writePreview', 'appConfig', 'SCRIPT_CLOSE', ts.transpile(fn.getText(ast), { target: ts.ScriptTarget.ES2022 }) + ';return serializeBody')('[data-bento-transient]', () => [], [], 'bento-doc', () => {}, () => ({ appName: 'beta/slides' }), '</script>')
const bodyOf = (html: string) => html.match(/id="bento-doc">([\s\S]*?)<\/script>/)![1]
const source = newDoc(); source.docId = 'round6-stable'
source.assets = {
  scene: 'data:text/html;base64,' + Buffer.from('<p>PRIVATE SCENE æøå</p>').toString('base64'),
  still: 'data:image/png;base64,AAAA',
  orphan: 'data:image/png;base64,BBBB',
}
source.slides[0].elements = []
source.slides[0].runtime = { src: 'asset:scene', still: 'asset:still', steps: 3, props: [{ key: 'city', label: 'City', kind: 'text', default: 'Oslo' }], values: { city: 'Bergen' } }
source.layouts = [{ ...structuredClone(source.slides[0]), id: 'private-layout' }]
const legacy = parseDoc(bodyOf(legacySave(new Shell(), JSON.stringify(source), source)))!
const live = newDoc(); live.docId = source.docId
// Model the store-origin recovery gate: content belongs to the snapshot, identity to live.
const gated = gateRestored(JSON.stringify(legacy), live)!
assert(gated); const doc = gated.doc
const different = structuredClone(source); different.assets!.scene = 'data:text/html;base64,PHAgLz4='
const pasted = insertSlides(parseClip(serializeSlides(different.slides, different))!, doc, 1)[0]
assert.notEqual(pasted.runtime!.src, 'asset:scene')
doc.blobs = Object.fromEntries(Object.keys(doc.assets!).map(key => [key, { key: `blob-${key}`, mime: 'application/octet-stream', size: 4 }]))
const before = JSON.stringify(doc)
function oracle(saved: any) {
  assert.equal(Object.keys(saved)[0], '$schema')
  assert.equal(saved.docId, 'round6-stable')
  assert.deepEqual(saved.slides, doc.slides); assert.deepEqual(saved.layouts, doc.layouts)
  for (const slide of [...saved.slides, ...saved.layouts]) {
    for (const ref of [slide.runtime.src, slide.runtime.still]) {
      const key = ref.slice(6)
      assert.equal(saved.assets[key], doc.assets![key], `runtime asset ${key}`)
      assert.deepEqual(saved.blobs[key], doc.blobs![key])
    }
  }
  assert(!saved.assets.orphan); assert(!saved.blobs.orphan)
}
// Failure first: a save that prunes the scene behind an apparently valid envelope fails.
const broken = { $schema: 'test', ...structuredClone(doc) }; delete broken.assets!.scene
assert.throws(() => oracle(broken))
;(globalThis as any).document = new Shell(); capturePristine()
let previewCalls = 0
registerPreview(() => { previewCalls++; return null })
try {
  setEncryptionPassword('round6 test password')
  const html = await serializeAuto(doc), env = parseEnvelope(bodyOf(html))
  assert(env); assert(!html.includes('PRIVATE OLD PREVIEW')); assert(!html.includes('data-bento-preview'))
  assert(!html.includes(source.assets.scene)); assert.equal(previewCalls, 0)
  assert.equal(await decryptEnvelope(env, 'wrong password'), null)
  const json = await decryptEnvelope(env, 'round6 test password'); assert(json)
  oracle(JSON.parse(json))
  assert.equal(JSON.stringify(doc), before, 'encryption/pruning leaves recovery source intact')
  const reopened = parseDoc(json)!; assert(reopened)
  setEncryptionPassword(null)
  oracle(JSON.parse(bodyOf(await serializeAuto(reopened))))
  assert.equal(previewCalls, 1, 'plaintext save reaches provider again')
  console.log('PASSED: pre-merge runtime recovery/paste survives encrypted and plain saves; schema first, blobs/assets pruned correctly, old preview stripped and wrong password refused')
} finally { setEncryptionPassword(null) }
