#!/usr/bin/env node
// BETA FORK: U1 composition of the actual merged navigation closures with
// the real runtime controller and upstream StepState. No duplicated routing.
// slides/node_modules/.bin/esbuild scripts/test-beta-merge-steps.ts --bundle --platform=node --format=esm --outfile=/tmp/beta-merge-steps.mjs
// node /tmp/beta-merge-steps.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { newDoc, defaultImage, defaultText } from '../slides/src/model.ts'
import { runtimePaint, steppedElements } from '../slides/src/runtime.ts'
import { StepState } from '../slides/src/steps.ts'
import { createRuntimeShow } from '../slides/src/runtime-present.ts'
const require = createRequire(process.cwd() + '/slides/package.json')
const ts = require('typescript')
const src = readFileSync('slides/src/present.ts', 'utf8')
const ast = ts.createSourceFile('present.ts', src, ts.ScriptTarget.Latest, true)
const names = ['goNext', 'goPrev', 'hasNext', 'hasPrev']
const declarations = new Map<string, string>()
function walk(n: any) {
  if (ts.isVariableDeclaration(n) && names.includes(n.name.getText(ast))) declarations.set(n.name.getText(ast), n.getText(ast))
  ts.forEachChild(n, walk)
}
walk(ast)
assert.equal(declarations.size, 4)
const messages: any[] = []
let listener: any, frame: any
;(globalThis as any).window = { addEventListener: (_: any, fn: any) => { listener = fn }, removeEventListener() {}, setTimeout: () => 0, focus() {} }
;(globalThis as any).document = { createElement: () => (frame = { isConnected: true, style: {}, setAttribute() {}, removeAttribute() {}, addEventListener() {}, remove() {}, contentWindow: { postMessage: (m: any) => messages.push(m) } }) }
const doc = newDoc()
doc.assets = { scene: 'data:text/html;base64,' + Buffer.from('<p>scene</p>').toString('base64') }
doc.slides[0].runtime = { src: 'asset:scene', steps: 2, props: [] }
const still = defaultImage('data:image/png;base64,AAAA')
still.fx = { step: 1 }
doc.slides[0].elements = [still]
doc.slides.push({ ...structuredClone(doc.slides[0]), id: 'next-slide', runtime: undefined, elements: [] })
const steps = new StepState()
steps.enter(doc.slides[0].elements, true)
let slideIndex = 0
const runtimeShow = createRuntimeShow(doc, { children: [{ querySelector: () => ({ appendChild() {} }) }] } as any, null, { goNext() {}, goPrev() {}, exit() {}, reduceMotion: () => false })
runtimeShow.enter(0, true)
listener({ source: frame.contentWindow, data: { type: 'bento:ready' } })
const deps = { runtimeShow, steps, doc, deck: { getIndices: () => ({ h: slideIndex }), slide: (i: number) => { slideIndex = i } }, isState: () => false, anchorOf: (i: number) => i, revealStep() {}, hideStep() {}, sendNav() {} }
const js = ts.transpile([...declarations.values()].map(d => 'const ' + d + ';').join('\n'), { target: ts.ScriptTarget.ES2022 })
const nav = new Function(...Object.keys(deps), js + '; return {goNext,goPrev,hasNext,hasPrev}')(...Object.values(deps))
let failures = 0
function check(name: string, fn: () => void) { try { fn(); console.log('PASSED: ' + name) } catch (e) { failures++; console.error('FOUND A BUG: ' + name + '\n' + (e as Error).message) } }
check('runtime step is consumed before slide navigation', () => {
  assert(nav.hasNext()); assert(!nav.hasPrev()); nav.goNext()
  assert.equal(messages.at(-1).index, 1); assert.equal(steps.step, 0); assert.equal(slideIndex, 0)
})
// A runtime slide has no reveal steps (runtime.ts steppedElements): its scene
// owns the arrows, and only the still is painted. present.ts enters every
// slide through steppedElements, so that is how this rig enters it too.
check('a step on the still of a runtime slide is not a reveal step', () => {
  assert.equal(still.fx?.step, 1)
  steps.enter(steppedElements(doc.slides[0]), true)
  assert(!steps.hasNext(), 'the still is not something to reveal')
  nav.goNext() // the runtime is on its last step: this leaves the slide
  assert.equal(slideIndex, 1)
})
slideIndex = 0
runtimeShow.dispose()
// A failed/not-ready scene must not trap arrows in hidden native elements.
delete still.fx
const hidden = defaultText({ id: 'not-painted', html: 'Old slide content', fx: { step: 1 } })
doc.slides[0].elements.push(hidden)
assert(!runtimePaint(doc.slides[0], doc)!.some(el => el.id === hidden.id), 'renderer does not paint this stepped element')
steps.enter(steppedElements(doc.slides[0]), true)
check('failed scene navigation skips invisible native reveal steps', () => {
  nav.goNext()
  assert.equal(slideIndex, 1, 'expected next slide, observed an invisible reveal step on the failed runtime slide')
})
check('a native slide still reveals step by step', () => {
  const native = { ...structuredClone(doc.slides[1]), elements: [defaultText({ id: 'r1', html: 'one', fx: { step: 1 } })] }
  steps.enter(steppedElements(native as any), true)
  assert(steps.hasNext())
})
const present = readFileSync('slides/src/present.ts', 'utf8')
check('present.ts enters every slide through steppedElements', () => {
  assert.equal((present.match(/steps\.enter\(/g) || []).length, (present.match(/steps\.enter\(steppedElements\(/g) || []).length)
  assert(/for \(const el of steppedElements\(slide\)\)/.test(present))
})
process.exitCode = failures ? 1 : 0
