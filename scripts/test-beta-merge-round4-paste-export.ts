#!/usr/bin/env node
// Round 4: multi-slide clipboard collisions, save/reopen and actual PPTX bytes.
// slides/node_modules/.bin/esbuild scripts/test-beta-merge-round4-paste-export.ts --bundle --platform=node --format=esm --outfile=/tmp/beta-merge-round4-paste-export.mjs
// node /tmp/beta-merge-round4-paste-export.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { newDoc, defaultImage, parseDoc } from '../slides/src/model.ts'
import { serializeSlides, parseClip, insertSlides } from '../slides/src/editor/clipboard.ts'
import { sanitizeDoc } from '../slides/src/restoregate.ts'
import { validateDoc } from '../slides/src/validate.ts'
import { capturePristine, serializeFile } from '../slides/src/save.ts'
import { configureApp } from '../kernel/src/app.ts'
import { mapDeck } from '../slides/src/export/pptx.ts'
const require = createRequire(process.cwd() + '/slides/package.json')
const JSZip = require('jszip')
const ts = require('typescript')
class Shell {
  block = { textContent: '' }; title = { textContent: '' }
  cloneNode() { return new Shell() }
  querySelectorAll(s: string) { return s === 'script' ? [this.block] : [] }
  getElementById(id: string) { return id === 'bento-doc' ? this.block : null }
  querySelector(s: string) { return s === 'title' ? this.title : null }
  get documentElement() { return { outerHTML: `<html><title>${this.title.textContent}</title><script id="bento-doc">${this.block.textContent}</script></html>` } }
}
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const scene = 'data:text/html;base64,' + Buffer.from('<p>scene-only-sentinel æøå</p>').toString('base64')
const source = newDoc()
source.assets = { scene, still: png }
source.slides[0].runtime = { src: 'asset:scene', still: 'asset:still', steps: 4, props: [{ key: 'city', label: 'City', kind: 'text', default: 'Oslo' }], values: { city: 'Bergen' } }
source.slides[0].elements = [defaultImage('asset:still')]
source.slides.push({ ...structuredClone(source.slides[0]), id: 'state-scene', stateOf: source.slides[0].id })
const target = newDoc()
target.slides[0].runtime = { steps: 0, props: [] }
target.assets = { scene: 'data:text/html;base64,PHAvPg==', still: 'data:image/png;base64,AAAA', orphan: 'data:image/png;base64,BBBB' }
const ast = ts.createSourceFile('editor.ts', readFileSync('slides/src/editor/editor.ts', 'utf8'), ts.ScriptTarget.Latest, true)
const cls = ast.statements.find((n: any) => ts.isClassDeclaration(n) && n.name.text === 'Editor')
const pasteBody = cls.members.find((n: any) => n.name?.getText(ast) === 'pasteFromText').body.getText(ast)
let at = 0
const ctx = { store: { doc: target, currentIndex: 0, get slide() { return target.slides[at] }, commit: (f: any) => f(), goTo: (i: number) => { at = i } }, rebuildSidebar() {}, toast() {}, refuseOnRuntimeSlide() { throw new Error('whole slides must paste beside a scene') } }
const deps = { parseClip, insertSlides, t: (s: string) => s }
const paste = new Function(...Object.keys(deps), ts.transpile('function paste(text) ' + pasteBody, { target: ts.ScriptTarget.ES2022 }) + '; return paste')(...Object.values(deps))
assert.equal(paste.call(ctx, serializeSlides(source.slides, source)), true)
assert.equal(target.slides.length, 3); assert.equal(at, 1)
const pasted = target.slides.slice(1)
assert.equal(new Set(pasted.map(s => s.id)).size, 2)
for (const s of pasted) {
  assert.equal(s.stateOf, undefined)
  assert.notEqual(s.runtime!.src, 'asset:scene'); assert.notEqual(s.runtime!.still, 'asset:still')
  assert.equal(target.assets[s.runtime!.src!.slice(6)], scene)
  assert.equal(target.assets[s.runtime!.still!.slice(6)], png)
  assert.equal((s.elements[0] as any).src, s.runtime!.still)
}
target.layouts = [{ ...structuredClone(pasted[0]), id: 'scene-layout', elements: [] }]
const assetOracle = (d: any) => {
  for (const s of [...d.slides.slice(1), ...d.layouts]) {
    assert.equal(d.assets[s.runtime.src.slice(6)], scene)
    assert.equal(d.assets[s.runtime.still.slice(6)], png)
  }
}
const broken = structuredClone(target)
delete broken.assets![pasted[0].runtime!.src!.slice(6)]
assert.throws(() => assetOracle(broken), 'failing-first control loses source bytes')
configureApp({ appId: 'beta-slides', appName: 'beta/slides', manifestUrl: 'https://invalid.example/manifest' })
;(globalThis as any).document = new Shell()
capturePristine()
const saved = JSON.parse(serializeFile(target).match(/id="bento-doc">([\s\S]*?)<\/script>/)![1])
assert.equal(Object.keys(saved)[0], '$schema')
assetOracle(saved); assert(!saved.assets.orphan); assert(target.assets.orphan)
const reopened = sanitizeDoc(parseDoc(JSON.stringify(saved))!)!.doc
assetOracle(reopened)
const advice = validateDoc(reopened, { measure: false }).findings
assert(!advice.some(f => f.code === 'runtime-dangling-ref'))
assert(advice.some(f => f.code === 'runtime-no-still' && f.slide === target.slides[0].id))
// Export just the pasted runtime slides: a picture each, no scene code or capabilities.
const exportDoc = { ...reopened, slides: reopened.slides.slice(1), collab: { room: 'SECRET-ROOM', key: 'SECRET-KEY' } } as any
const { pptx, report } = await mapDeck(exportDoc)
assert.equal(report.filter(r => r.reason === 'runtime').length, 2)
const zip = await JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }))
const slideNames = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
assert.equal(slideNames.length, 2)
for (const name of slideNames) assert.match(await zip.file(name).async('string'), /<p:pic>/)
for (const name of Object.keys(zip.files).filter(n => n.endsWith('.xml'))) {
  const xml = await zip.file(name).async('string')
  assert(!xml.includes('SECRET-')); assert(!xml.includes('scene-only-sentinel'))
}
assert.equal(exportDoc.collab.key, 'SECRET-KEY', 'export must not mutate caller')
console.log('PASSED: multi-runtime editor paste, collision remap, layout/save/reopen, schema first, validation advice and still-only PPTX bytes')
