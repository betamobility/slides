#!/usr/bin/env node
// BETA FORK: a following audience against a runtime scene's whole life (v1.2.7 merge, break round 3). Actual navigation, slidechanged and initialization bodies;
// only DOM/Reveal/animation edges are doubled. No routing copied into the rig.
// slides/node_modules/.bin/esbuild scripts/test-beta-merge-follow-lifecycle.ts --bundle --platform=node --format=esm --outfile=/tmp/beta-merge-follow-lifecycle.mjs
// node /tmp/beta-merge-follow-lifecycle.mjs
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
function fixture(start = 0, readyDeck = true, reduce = false, lock = false, mutant = false) {
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
  let index = start, change: any
  const deck = { getIndices: () => ({ h: index }), slide(i: number) { if (i === index) return; const previousSlide = sections[index]; index = i; change({ previousSlide, currentSlide: sections[i] }) } }
  const activateDOM = () => {
    ;(globalThis as any).document = { createElement: () => {
      const frame = { isConnected: true, style: {}, setAttribute: noop, removeAttribute: noop, addEventListener: noop, remove: noop, messages: [] as any[], contentWindow: { postMessage(m: any) { frame.messages.push(m) } } }
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
  return { doc, nav, runtimeShow, wire, frames, ready, activateDOM, index: () => index, dispose: () => runtimeShow.dispose() }
}
let failures = 0
function check(name: string, fn: () => void) { try { fn(); console.log('PASSED: ' + name) } catch (e) { failures++; console.error('FOUND A BUG: ' + name + '\n' + (e as Error).message) } }
check('loading follower retains latest step; locks and reduced motion preserve it', () => {
  for (const lock of [false, true]) for (const reduce of [false, true]) {
    const f = fixture(3, true, reduce, lock)
    try {
      const follow = new FollowState(true)
      const jump = follow.nav(f.doc.slides, { id: 'scene', lock })!
      f.nav.followStep(jump, 1); f.nav.goTo(jump)
      f.nav.followStep(jump, 2) // newer nav while the scene is still loading
      assert.equal(f.frames.at(-1).messages.length, 0)
      const init = f.ready()
      assert.equal(init.step, 2); assert.equal(init.reduceMotion, reduce)
      assert.equal(follow.locked, lock)
    } finally { f.dispose() }
  }
  const bad = fixture(0, true, false, false, true)
  try { bad.runtimeShow.enter(0, true); bad.nav.followStep(0, 2); assert.throws(() => assert.equal(bad.ready().step, 2)) } finally { bad.dispose() }
})
check('out-of-range followed step clamps and next skips hidden/state slides', () => {
  const f = fixture()
  try {
    f.runtimeShow.enter(0, true); f.nav.followStep(0, 900); assert.equal(f.ready().step, 2)
    f.nav.goNext(); assert.equal(f.index(), 3)
    f.nav.goPrev(); f.ready(); f.nav.followStep(0, -10)
    assert.equal(f.runtimeShow.step(), 0)
    f.nav.followStep(0, 1.9); assert.equal(f.runtimeShow.step(), 1)
  } finally { f.dispose() }
})
check('backward runtime entry broadcasts the last scene step before readiness', () => {
  const mismatches: string[] = []
  for (const lock of [false, true]) for (const reduce of [false, true]) {
    const p = fixture(3, true, reduce, lock), a = fixture(3, true, reduce, lock)
    try {
      p.activateDOM(); p.nav.goPrev() // actual slidechanged callback broadcasts before ready
      const payload = p.wire.at(-1)
      assert.equal(payload.id, 'scene'); assert.equal(payload.lock, lock)
      a.activateDOM(); a.nav.followStep(0, payload.step); a.nav.goTo(0)
      const presenter = p.ready(), audience = a.ready()
      assert.equal(presenter.step, 2, 'backward presenter enters at its last scene step')
      if (audience.step !== presenter.step) mismatches.push(`lock=${lock}, reduce=${reduce}: audience=${audience.step}, presenter=${presenter.step}, wire=${payload.step}`)
    } finally { p.dispose(); a.dispose() }
  }
  assert.deepEqual(mismatches, [], 'every backward-entry variant must initialize the audience at the presenter step')
})
check('nav received before Reveal initialization keeps the active runtime frame', () => {
  const f = fixture(0, false)
  try {
    // Begin on the opening scene, but receive a presenter nav to another scene
    // while Reveal.initialize() is pending, as the upstream pendingIndex supports.
    f.doc.slides[3].runtime = { src: 'asset:scene', steps: 4, props: [] }
    f.nav.followStep(3, 2); f.nav.goTo(3); f.nav.initialize()
    assert.equal(f.index(), 3)
    assert.equal(f.frames.at(-1).title, 'end', 'the mounted scene must be the current slide, not startIndex')
    assert.equal(f.ready().step, 2)
  } finally { f.dispose() }
})
check('clicking the current runtime thumbnail broadcasts its reset', () => {
  const p = fixture(), a = fixture()
  try {
    p.activateDOM(); p.runtimeShow.enter(0, true); p.ready()
    a.activateDOM(); a.runtimeShow.enter(0, true); a.ready()
    p.nav.goNext(); p.nav.goNext()
    a.nav.followStep(0, p.wire.at(-1).step)
    assert.equal(a.runtimeShow.step(), 2)
    const sent = p.wire.length
    const click = new Function('runtimeShow', 'deck', 'idx', 'toggleGrid', 'sendNav',
      ts.transpile('const click = ' + railClick, { target: ts.ScriptTarget.ES2022 }) + '; return click')(
        p.runtimeShow, { slide: p.nav.goTo, getIndices: () => ({ h: p.index() }) }, 0, noop, p.nav.sendNav)
    click()
    assert.equal(p.runtimeShow.step(), 0, 'positive control: the current scene resets')
    for (const payload of p.wire.slice(sent)) a.nav.followStep(0, payload.step)
    assert.equal(a.runtimeShow.step(), 0, 'the following audience must see the replay from step zero')
  } finally { p.dispose(); a.dispose() }
})
process.exitCode = failures ? 1 : 0
