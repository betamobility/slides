#!/usr/bin/env node
// BETA FORK: a following audience hears a runtime scene's steps (v1.2.7 merge, break round 2).
// Real presentation closures + real scene controller, browser edges doubled.
// slides/node_modules/.bin/esbuild scripts/test-beta-merge-follow.ts --bundle --platform=node --format=esm --outfile=/tmp/beta-merge-follow.mjs
// node /tmp/beta-merge-follow.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { newDoc } from '../slides/src/model.ts'
import { steppedElements } from '../slides/src/runtime.ts'
import { createRuntimeShow } from '../slides/src/runtime-present.ts'
import { StepState } from '../slides/src/steps.ts'
const ts = createRequire(process.cwd() + '/slides/package.json')('typescript')
const src = readFileSync('slides/src/present.ts', 'utf8')
const ast = ts.createSourceFile('present.ts', src, ts.ScriptTarget.Latest, true)
const names = ['goNext', 'goPrev', 'sendNav', 'followStep']
const decls = new Map<string, string>()
function walk(n: any) {
  if (ts.isVariableDeclaration(n) && names.includes(n.name.getText(ast))) decls.set(n.name.getText(ast), n.getText(ast))
  ts.forEachChild(n, walk)
}
walk(ast)
assert.equal(decls.size, names.length)
let listener: any, frame: any
const messages: any[] = [], wire: any[] = []
;(globalThis as any).window = { addEventListener(_: any, fn: any) { listener = fn }, removeEventListener() {}, setTimeout: () => 0 }
;(globalThis as any).document = { createElement: () => (frame = { style: {}, setAttribute() {}, removeAttribute() {}, addEventListener() {}, remove() {}, contentWindow: { postMessage(m: any) { messages.push(m) } } }) }
const doc = newDoc()
doc.assets = { scene: 'data:text/html;base64,' + Buffer.from('<p>scene</p>').toString('base64') }
doc.slides[0].runtime = { src: 'asset:scene', steps: 3, props: [] }
const steps = new StepState()
steps.enter(steppedElements(doc.slides[0]), true)
const runtimeShow = createRuntimeShow(doc, { children: [{ querySelector: () => ({ appendChild() {} }) }] } as any, null, { goNext() {}, goPrev() {}, exit() {}, reduceMotion: () => false })
runtimeShow.enter(0, true)
listener({ source: frame.contentWindow, data: { type: 'bento:ready' } })
const deps = { runtimeShow, steps, doc, deck: { getIndices: () => ({ h: 0 }), slide() {} }, isState: () => false, anchorOf: (i: number) => i, revealStep() {}, hideStep() {}, showOn: true, bc: { presenter: { verbs: () => ({ nav: (p: any) => wire.push(p) }) } }, visibleIndex: () => 1, showLock: false, currentSection: () => ({}), updateSpeakerControls() {} }
const js = ts.transpile('let pendingStep = null, deckReady = true;\n' + [...decls.values()].map(d => 'const ' + d + ';').join('\n'), { target: ts.ScriptTarget.ES2022 })
const nav = new Function(...Object.keys(deps), js + '; return {goNext,goPrev,sendNav,followStep}')(...Object.values(deps))
let failures = 0
function check(name: string, fn: () => void) { try { fn(); console.log('PASSED: ' + name) } catch (e) { failures++; console.error('FOUND A BUG: ' + name + '\n' + (e as Error).message) } }
nav.sendNav(0)
assert.equal(wire.length, 1, 'positive control: a slide navigation really broadcasts')
nav.goNext()
assert.equal(messages.at(-1).index, 1, 'the presenter scene really advanced')
check('runtime advance broadcasts its new step to following audience', () => {
  assert.equal(wire.length, 2, 'expected a second nav; runtime goNext returned without sending one')
  assert.equal(wire.at(-1).step, 1)
})
// Even forcing a nav (e.g. turning Lock on) must carry the runtime position.
nav.sendNav(0)
check('nav payload reports runtime position rather than empty native StepState', () => assert.equal(wire.at(-1).step, 1))
runtimeShow.jump(0)
messages.length = 0
nav.followStep(0, 2)
check('following a runtime step updates the audience scene', () => assert(messages.some(m => m.type === 'bento:step' && m.index === 2), 'following step 2 sent no bento:step to the scene'))
runtimeShow.dispose()
process.exitCode = failures ? 1 : 0
