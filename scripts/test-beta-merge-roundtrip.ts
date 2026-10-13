#!/usr/bin/env node
// BETA FORK: U1 regression. Run from repo root:
// slides/node_modules/.bin/esbuild scripts/test-beta-merge-roundtrip.ts --bundle --platform=node --format=esm --outfile=/tmp/beta-merge-roundtrip.mjs
// node /tmp/beta-merge-roundtrip.mjs
// Uses the pre-merge serializer (a fixture of kernel/src/save.ts at 5246e491), not a guessed JSON splice. The tiny
// Document double exercises serialization, not layout/preview (no provider).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { newDoc, defaultImage, parseDoc } from '../slides/src/model.ts'
import { guardOpenedDoc, sanitizeDoc } from '../slides/src/restoregate.ts'
import { serializeSlides, parseClip, insertSlides } from '../slides/src/editor/clipboard.ts'
import { serializeFile, capturePristine } from '../slides/src/save.ts'
import { configureApp } from '../kernel/src/app.ts'
import { pruneUnusedAssets } from '../slides/src/assets.ts'
const require = createRequire(process.cwd() + '/slides/package.json')
const ts = require('typescript')
class Shell {
  block = { textContent: '' }
  title = { textContent: '' }
  cloneNode() { return new Shell() }
  querySelectorAll(s: string) { return s === 'script' ? [this.block] : [] }
  getElementById(id: string) { return id === 'bento-doc' ? this.block : null }
  querySelector(s: string) { return s === 'title' ? this.title : null }
  get documentElement() { return { outerHTML: `<html><head><title>${this.title.textContent}</title></head><body><script type="application/bento+json" id="bento-doc">${this.block.textContent}</script></body></html>` } }
}
// kernel/src/save.ts as it was at 5246e491, the fork's head before the merge.
// A file, not `git show`: CI checks out one commit and has no history to ask.
const legacySource = readFileSync('scripts/fixtures/beta-kernel-save-pre-v1.2.7.ts.txt', 'utf8')
const ast = ts.createSourceFile('legacy.ts', legacySource, ts.ScriptTarget.Latest, true)
const legacyFn = ast.statements.find((n: any) => ts.isFunctionDeclaration(n) && n.name?.text === 'serializeBody')
assert(legacyFn, 'pre-merge serializer is available')
const js = ts.transpile(legacyFn.getText(ast), { target: ts.ScriptTarget.ES2022 })
const legacySave = new Function('TRANSIENT_SELECTOR', 'shellBlocks', 'managedTypes', 'DATA_BLOCK_ID', 'writePreview', 'appConfig', 'SCRIPT_CLOSE', js + '; return serializeBody')('[data-bento-transient]', () => [], [], 'bento-doc', () => {}, () => ({ appName: 'beta/slides' }), '</script>')
const doc = newDoc()
doc.docId = 'merge-regression-stable-id'
doc.assets = { scene: 'data:text/html;base64,' + Buffer.from('<p>æøå</p>').toString('base64'), still: 'data:image/png;base64,AAAA', orphan: 'data:image/png;base64,BBBB' }
doc.slides[0].runtime = { src: 'asset:scene', still: 'asset:still', steps: 3, props: [{ key: 'city', label: 'City', kind: 'text', default: 'Oslo' }], values: { city: 'Bergen' } }
doc.slides[0].elements = [defaultImage('asset:still')]
doc.slides.push({ ...structuredClone(doc.slides[0]), id: 'bare-scene', elements: [] })
doc.layouts = [{ ...structuredClone(doc.slides[0]), id: 'runtime-layout', elements: [] }]
const fromFile = (html: string) => JSON.parse(html.match(/id="bento-doc">([\s\S]*?)<\/script>/)![1])
const oldSaved = fromFile(legacySave(new Shell(), JSON.stringify(doc), doc))
const opened = parseDoc(JSON.stringify(oldSaved))!
guardOpenedDoc(opened)
const gated = sanitizeDoc(opened as any)!
assert(gated)
assert.deepEqual(gated.doc.slides.map(s => s.runtime), doc.slides.map(s => s.runtime))
assert.deepEqual(gated.doc.layouts![0].runtime, doc.layouts[0].runtime)
const target = gated.doc
// Force a collision: pasted scene bytes must acquire a new key and survive pruning.
const source = structuredClone(doc)
source.assets!.scene = 'data:text/html;base64,' + Buffer.from('<p>different scene</p>').toString('base64')
const pasted = insertSlides(parseClip(serializeSlides([source.slides[0]], source))!, target, target.slides.length)[0]
assert.notEqual(pasted.runtime!.src, 'asset:scene')
configureApp({ appId: 'beta-slides', appName: 'beta/slides', manifestUrl: 'https://invalid.example/manifest' })
;(globalThis as any).document = new Shell()
capturePristine()
const saved = fromFile(serializeFile(target))
assert.equal(Object.keys(saved)[0], '$schema')
assert.equal(saved.docId, doc.docId)
assert.deepEqual(saved.slides, target.slides)
assert.deepEqual(saved.layouts, target.layouts)
for (const s of [...saved.slides, ...saved.layouts]) for (const field of ['src', 'still']) {
  const key = s.runtime[field].slice(6)
  assert.equal(saved.assets[key], target.assets![key])
}
assert(!('orphan' in saved.assets))
assert('orphan' in target.assets!)
// Failing-first negative control: emulate losing the runtime walk at merge.
const missingHook = structuredClone(target)
for (const s of [...missingHook.slides, ...missingHook.layouts!]) delete s.runtime
assert(!pruneUnusedAssets(missingHook).assets!.scene, 'negative control really loses the scene')
console.log('PASSED: pre-merge serialization → merged gates → collision paste → real save facade; layouts, bare scenes, assets, stable identity, schema first')
