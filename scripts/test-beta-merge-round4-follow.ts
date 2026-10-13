#!/usr/bin/env node
// BETA FORK: a following audience against a runtime scene's whole life (v1.2.7 merge, break round 4). Actual navigation, slidechanged and initialization bodies;
// only DOM/Reveal/animation edges are doubled. No routing copied into the rig.
// slides/node_modules/.bin/esbuild scripts/test-beta-merge-round4-follow.ts --bundle --platform=node --format=esm --outfile=/tmp/beta-merge-round4-follow.mjs
// node /tmp/beta-merge-round4-follow.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { newDoc, inLinearFlow } from '../slides/src/model.ts'
import { steppedElements } from '../slides/src/runtime.ts'
import { createRuntimeShow } from '../slides/src/runtime-present.ts'
import { StepState } from '../slides/src/steps.ts'
import { FollowState } from '../slides/src/follow.ts'
const ts = createRequire(process.cwd() + '/slides/package.json')('typescript')
const src = readFileSync('slides/src/present.ts', 'utf8')
const ast = ts.createSourceFile('present.ts', src, ts.ScriptTarget.Latest, true)
const names = ['goNext', 'goPrev', 'sendNav', 'followStep', 'goTo', 'isState', 'anchorOf']
const decls = new Map<string, string>()
let changed = '', initialized = '', railClick = ''
function unwrap(n: any): any { return ts.isParenthesizedExpression(n) || ts.isAsExpression(n) ? unwrap(n.expression) : n }
function walk(n: any) {
  if (ts.isVariableDeclaration(n) && names.includes(n.name.getText(ast))) decls.set(n.name.getText(ast), n.getText(ast))
  if (ts.isCallExpression(n) && n.expression.getText(ast) === 'deck.on' && n.arguments[0]?.text === 'slidechanged') changed = unwrap(n.arguments[1]).getText(ast)
  if (ts.isCallExpression(n) && n.expression.getText(ast) === 'deck.initialize().then') initialized = n.arguments[0].getText(ast)
  if (ts.isArrowFunction(n) && n.parameters.length === 0 && /^\{\s*const replay = idx === deck\.getIndices\(\)\.h\s*runtimeShow\.jump\(idx\);/.test(n.body.getText(ast))) railClick = n.getText(ast)
  ts.forEachChild(n, walk)
}
walk(ast)
assert.equal(decls.size, names.length); assert(changed); assert(initialized); assert(railClick)
const listeners = new Set<any>()
;(globalThis as any).window = { addEventListener(t: string, fn: any) { if (t === 'message') listeners.add(fn) }, removeEventListener(_: any, fn: any) { listeners.delete(fn) }, setTimeout: () => 0, focus() {} }
const noop = () => {}
function fixture(start = 0, readyDeck = true, reduce = false, lock = false, mutant = false, beforeReadURL = false) {
  const doc = newDoc()
  const slide = { ...doc.slides[0], elements: [], transition: 'none' as const }
  doc.slides = [
    { ...structuredClone(slide), id: 'scene', runtime: { src: 'asset:scene', steps: 3, props: [] } },
    { ...structuredClone(slide), id: 'hidden', hidden: true },
    { ...structuredClone(slide), id: 'state', stateOf: 'scene' },
    { ...structuredClone(slide), id: 'end' },
  ]
  doc.assets = { scene: 'data:text/html;base64,' + Buffer.from('<p>scene</p>').toString('base64') }
  const frames: any[] = [], wire: any[] = []
  const surface = { appendChild: noop }
  const sections = doc.slides.map(() => ({ querySelector: () => surface, querySelectorAll: () => [] }))
  let index: number | undefined = beforeReadURL ? undefined : start, change: any
  const deck = { getIndices: () => ({ h: index }), slide(i: number) { if (i === index) return; const previousSlide = sections[index]; index = i; change({ previousSlide, currentSlide: sections[i] }) } }
  const activateDOM = () => {
    ;(globalThis as any).document = { createElement: () => {
      const frame = { style: {}, setAttribute: noop, removeAttribute: noop, addEventListener: noop, remove: noop, messages: [] as any[], contentWindow: { postMessage(m: any) { frame.messages.push(m) } } }
      frames.push(frame); return frame
    } }
  }
  activateDOM()
  const steps = new StepState()
  const runtimeShow = createRuntimeShow(doc, { children: sections } as any, null, { goNext: () => nav.goNext(), goPrev: () => nav.goPrev(), exit: noop, reduceMotion: () => reduce })
  const deps: any = { runtimeShow, steps, doc, deck, steppedElements, inLinearFlow,
    showOn: true, showLock: lock, reduceMotion: reduce, startIndex: start, slidesEl: { children: sections },
    bc: { presenter: { verbs: () => ({ nav: (p: any) => wire.push(p) }) } },
    visibleIndex: (i: number) => doc.slides.slice(0, i + 1).filter(inLinearFlow).length,
    currentSection: () => sections[index], anim: { killTweensOf: noop }, opts: {},
    setTimeout: noop,
  }
  for (const n of ['revealStep', 'hideStep', 'updateSpeakerControls', 'sweepSymbolSpans', 'applyElementFrame', 'resetXform', 'applyRevealSet', 'applyStep', 'runMorph', 'runMorphArrivalCountUps', 'runEnterFx', 'runAmbientFx', 'restartSvgAnimations', 'wireHoverFocus', 'disposeLiveCharts', 'mountLiveCharts', 'pauseMediaIn', 'startMediaIn', 'cacheSlideSymbols', 'updateSpeaker', 'onResize', 'buildSection']) deps[n] = noop
  let body = [...decls.values()].map(d => 'const ' + d + ';').join('\n')
  // Failing-first control: remove just the round-3 prerequisite, the follower hook.
  if (mutant) body = body.replace('if (runtimeShow.follow(index, step)) return', 'if (false) return')
  const js = ts.transpile(`let pendingStep = null, pendingIndex = null, deckReady = ${readyDeck};\n${body}\nconst change = ${changed}; const initialize = ${initialized};`, { target: ts.ScriptTarget.ES2022 })
  const nav = new Function(...Object.keys(deps), js + '; return {goNext, goPrev, sendNav, followStep, goTo, change, initialize}')(...Object.values(deps))
  change = nav.change
  const ready = () => { const f = frames.at(-1); assert(f, 'scene mounted'); for (const listener of listeners) listener({ source: f.contentWindow, data: { type: 'bento:ready' } }); return f.messages.at(-1) }
  return { doc, nav, runtimeShow, wire, frames, ready, activateDOM, index: () => index, primeOpening: () => { index = start }, dispose: () => runtimeShow.dispose() }
}
let failures = 0
function check(name: string, fn: () => void) { try { fn(); console.log('PASSED: ' + name) } catch (e) { failures++; console.error('FOUND A BUG: ' + name + '\n' + (e as Error).message) } }
check('same opening scene retains the newest nav received before Reveal is ready', () => {
  const mismatches: string[] = []
  // Reveal initially has no index. readURL() sets it to zero without emitting
  // slidechanged, then its ready event is deferred by a timer. Probe both sides
  // of readURL (reveal.js/js/reveal.js start(), slide(), getIndices()).
  for (const beforeReadURL of [false, true]) for (const reduce of [false, true]) for (const lock of [false, true]) {
    const f = fixture(0, false, reduce, lock, false, beforeReadURL)
    try {
      f.nav.followStep(0, 1); f.nav.goTo(0)
      f.nav.followStep(0, 2); f.nav.goTo(0)
      f.primeOpening()
      f.nav.initialize()
      assert.equal(f.index(), 0)
      const actual = f.ready().step
      if (actual !== 2) mismatches.push(`beforeReadURL=${beforeReadURL}, reduce=${reduce}, lock=${lock}: got ${actual}, expected 2`)
    } finally { f.dispose() }
  }
  assert.deepEqual(mismatches, [], 'opening scene must use latest followed step, not reset to zero')
})
check('latest pre-ready nav back to opening scene supersedes a queued different scene', () => {
  const f = fixture(0, false)
  try {
    f.doc.slides[3].runtime = { src: 'asset:scene', steps: 4, props: [] }
    f.nav.followStep(3, 3); f.nav.goTo(3)
    f.nav.followStep(0, 1); f.nav.goTo(0)
    f.nav.initialize()
    assert.equal(f.index(), 0)
    assert.equal(f.ready().step, 1, 'latest nav wins even when it targets the initial slide')
  } finally { f.dispose() }
})
check('different-scene pre-ready nav and delayed readiness retain the newest step', () => {
  const f = fixture(0, false)
  try {
    f.doc.slides[3].runtime = { src: 'asset:scene', steps: 4, props: [] }
    f.nav.followStep(3, 1); f.nav.goTo(3)
    f.nav.followStep(3, 3); f.nav.goTo(3)
    f.nav.initialize()
    assert.equal(f.index(), 3)
    assert.equal(f.runtimeShow.step(), 3)
    assert.equal(f.ready().step, 3)
    f.nav.followStep(3, 0)
    assert.equal(f.frames.at(-1).messages.at(-1).index, 0)
  } finally { f.dispose() }
})
process.exitCode = failures ? 1 : 0
