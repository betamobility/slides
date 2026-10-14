#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Beta build: the runtime slide record (`slide.runtime`).
//
//   slides/node_modules/.bin/esbuild scripts/test-beta-runtime.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-beta-runtime.mjs" \
//     && node --no-warnings "$TMPDIR/test-beta-runtime.mjs"
//
// (Bundled, not run directly: clipboard.ts and untrusted.ts import './model'
// extensionless, the same reason test-clipboard.ts is bundled in CI.)
//
// WHAT THIS PROVES. A runtime slide is one live scene plus a still, and the
// still is an ordinary full-bleed image element so an older shell paints it
// with no code at all (docs/plans/2026-09-14-001, KTD1). The record itself is
// only worth shipping if the three untrusted intakes and the one advisory
// pass all understand it:
//
//   1. THE FORMAT KNOWS IT. `runtime` is in MODEL_KEYS.slide, so validate()
//      does not flag it and a paste does not drop it.
//   2. THE SANITISER HOLDS ITS SHAPE. Unknown prop kinds go, `steps` is a
//      non-negative integer, `url` is https only, `src` and `still` are
//      `asset:` refs, and a source above RUNTIME_SRC_BUDGET or a still above
//      RUNTIME_STILL_BUDGET is refused.
//      A placeholder (`{}` or `{steps:0, props:[]}`) survives, because the
//      splice tool recognises a slide it may fill by that record (KTD11).
//   3. PASTE CARRIES ITS BYTES. The scene source is not referenced by any
//      element, so the clipboard must collect it and remap it on a key
//      collision along with the still.
//   4. VALIDATE ADVISES, NEVER REFUSES. A runtime slide with no image element
//      or a dangling still ref is a warning: the deck still opens.

import { insertSlides, parseClip, serializeSlides } from '../slides/src/editor/clipboard.ts'
import type { BentoDoc, Slide } from '../slides/src/model.ts'
import { defaultImage, defaultText, newDoc } from '../slides/src/model.ts'
import * as model from '../slides/src/model.ts'
import { MODEL_KEYS } from '../slides/src/modelkeys.generated.ts'
import { sanitizeSlide } from '../slides/src/untrusted.ts'
import { validateDoc } from '../slides/src/validate.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// Loaded dynamically so a build without the module still reports every other
// check instead of failing at bundle time.
type RuntimeModule = typeof import('../slides/src/runtime.ts')
let rt: Partial<RuntimeModule> = {}
try { rt = await import('../slides/src/runtime.ts') } catch (e) { console.log(`  (runtime.ts not loadable: ${(e as Error).message})`) }

const STILL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const SCENE = '<!doctype html><title>scene</title><p>hello æøå</p>'
const sceneAsset = 'data:text/html;base64,' + Buffer.from(SCENE, 'utf8').toString('base64')

function runtimeDeck(): BentoDoc {
  const doc = newDoc()
  doc.assets = { 'still-map': STILL_PNG, 'scene-map': sceneAsset }
  const slide = doc.slides[0]
  slide.elements = [defaultImage('asset:still-map', { id: 'still', x: 0, y: 0, w: 1280, h: 720, fit: 'cover' })]
  slide.runtime = {
    src: 'asset:scene-map',
    still: 'asset:still-map',
    steps: 3,
    props: [
      { key: 'title', label: 'Title', kind: 'text', default: 'Oslo' },
      { key: 'count', label: 'Count', kind: 'number', default: 5 },
      { key: 'accent', label: 'Accent', kind: 'color', default: '#1A1A1A' },
    ],
    values: { title: 'Bergen' },
  }
  return doc
}

const findings = (doc: BentoDoc, code?: string) =>
  validateDoc(doc, { measure: false }).findings.filter((f) => !code || f.code === code)

// ------------------------------------------------------------ 1. the format
console.log('\nthe format knows the record')

ok((MODEL_KEYS.slide as readonly string[]).includes('runtime'), 'MODEL_KEYS.slide carries `runtime`')
ok((model as Record<string, unknown>).RUNTIME_SRC_BUDGET === 256 * 1024, 'RUNTIME_SRC_BUDGET is 256 KB')
ok((model as Record<string, unknown>).RUNTIME_STILL_BUDGET === 200 * 1024, 'RUNTIME_STILL_BUDGET is 200 KB')
ok((model as Record<string, unknown>).RUNTIME_ASSET_BUDGET === 16 * 1024 * 1024, 'RUNTIME_ASSET_BUDGET is 16 MB')

{
  const doc = runtimeDeck()
  const all = validateDoc(doc, { measure: false })
  ok(all.findings.filter((f) => f.slide === doc.slides[0].id && f.severity !== 'info').length === 0,
    `a well-formed runtime slide validates without warnings (${all.findings.map((f) => f.code).join(', ') || 'none'})`)
}

// ----------------------------------------------------------- 2. the helpers
console.log('\nhelpers')
{
  const doc = runtimeDeck()
  const slide = doc.slides[0]
  ok(rt.isRuntimeSlide?.(slide) === true, 'isRuntimeSlide is true for a slide with a runtime record')
  ok(rt.isRuntimeSlide?.(newDoc().slides[0]) === false, 'isRuntimeSlide is false for a native slide')
  const still = rt.runtimeStill?.(slide, doc)
  ok(typeof still === 'object' && still !== null && still.id === 'still', 'runtimeStill finds the image element carrying the still ref')
  ok(rt.runtimeSource?.(slide, doc)?.html === SCENE, 'runtimeSource decodes the scene asset to its HTML (utf-8 intact)')
  const withUrl = runtimeDeck()
  withUrl.slides[0].runtime = { ...withUrl.slides[0].runtime!, src: undefined, url: 'https://example.com/scene' }
  ok(rt.runtimeSource?.(withUrl.slides[0], withUrl)?.url === 'https://example.com/scene', 'runtimeSource returns the url override')
  const placeholder = newDoc()
  placeholder.slides[0].elements = [defaultImage(STILL_PNG, { id: 'ph' })]
  placeholder.slides[0].runtime = { steps: 0, props: [] }
  const phStill = rt.runtimeStill?.(placeholder.slides[0], placeholder)
  ok(typeof phStill === 'object' && phStill !== null && phStill.id === 'ph', 'a placeholder with no still ref falls back to its image element')
}

// --------------------------------------------------------- 3. the sanitiser
console.log('\nsanitiser')
{
  const doc = runtimeDeck()
  const clean = sanitizeSlide(JSON.parse(JSON.stringify(doc.slides[0])))
  ok(JSON.stringify(clean?.runtime) === JSON.stringify(doc.slides[0].runtime), 'a well-formed runtime survives sanitizeSlide intact')

  const hostile = sanitizeSlide({
    id: 's1', background: '#fff', transition: 'none', notes: '', elements: [],
    runtime: {
      src: 'https://evil.example/scene.html', still: 'javascript:alert(1)',
      url: 'javascript:alert(1)', steps: -1, evil: true,
      props: [
        { key: 'ok', label: 'OK', kind: 'text', default: 'x' },
        { key: 'bad', label: 'Bad', kind: 'script', default: 'x' },
        { key: 'num', label: 'Num', kind: 'number', default: 'NaN?' },
        { key: 'col', label: 'Col', kind: 'color', default: 'red) url(https://evil/f.svg#f' },
      ],
      // parsed, not a literal: JSON.parse makes `__proto__` an OWN key, as a clipboard payload would
      values: JSON.parse('{"ok":"y","num":4,"nope":"z","col":{"a":1},"__proto__":{"polluted":true}}'),
    },
  })
  const r = hostile?.runtime as unknown as Record<string, unknown> | undefined
  ok(!!r, 'a hostile runtime is rebuilt, not dropped wholesale')
  ok(r?.steps === 0, '`steps: -1` is coerced to 0')
  ok(r !== undefined && !('url' in r), '`url: javascript:` is stripped')
  ok(r !== undefined && !('src' in r), 'a non-asset `src` is stripped')
  ok(r !== undefined && !('still' in r), 'a non-asset `still` is stripped')
  ok(r !== undefined && !('evil' in r), 'unknown keys are dropped')
  const props = (r?.props ?? []) as Array<Record<string, unknown>>
  ok(props.map((p) => p.key).join(',') === 'ok,num,col', `the unknown prop kind is dropped, the rest kept (${props.map((p) => p.key).join(',')})`)
  ok(props.find((p) => p.key === 'num')?.default === 0, 'a number prop with a non-numeric default falls back to 0')
  ok(props.find((p) => p.key === 'col')?.default === '#000000', 'a colour prop with an unsafe default falls back to #000000')
  ok(JSON.stringify(r?.values) === JSON.stringify({ ok: 'y', num: 4 }), `values keep only declared keys with scalar values (${JSON.stringify(r?.values)})`)
  ok(({} as Record<string, unknown>).polluted === undefined, 'no prototype pollution through values')

  ok(sanitizeSlide({ id: 's2', elements: [], runtime: { steps: 2.5, props: [] } })?.runtime?.steps === 0, 'a fractional `steps` is coerced to 0')
  ok(sanitizeSlide({ id: 's3', elements: [], runtime: 'yes' })?.runtime === undefined, 'a non-object runtime is dropped')
  const empty = sanitizeSlide({ id: 's4', elements: [], runtime: {} })
  ok(JSON.stringify(empty?.runtime) === JSON.stringify({ steps: 0, props: [] }), 'the `{}` placeholder survives as `{steps:0, props:[]}`')
  const ph = sanitizeSlide({ id: 's5', elements: [], runtime: { steps: 0, props: [] } })
  ok(JSON.stringify(ph?.runtime) === JSON.stringify({ steps: 0, props: [] }), 'the KTD11 placeholder survives unchanged')
  ok(sanitizeSlide({ id: 's6', elements: [], runtime: { url: 'http://example.com/x', steps: 0, props: [] } })?.runtime?.url === undefined,
    'a plain http url is stripped (https only)')
  ok(sanitizeSlide({ id: 's7', elements: [], runtime: { url: 'https://example.com/x?a=1', steps: 1, props: [] } })?.runtime?.url === 'https://example.com/x?a=1',
    'an https url is kept')
}

// ---------------------------------------------------------- 4. paste budget
console.log('\npaste budget')
{
  const doc = runtimeDeck()
  const big = 'data:text/html;base64,' + 'A'.repeat(400 * 1024)
  doc.assets!['scene-map'] = big
  const clip = parseClip(serializeSlides([doc.slides[0]], doc))
  const pasted = clip?.slides?.[0]
  ok(!!pasted?.runtime, 'the slide still pastes as a runtime slide')
  ok(pasted?.runtime?.src === undefined, 'a `src` whose asset is above RUNTIME_SRC_BUDGET is refused on paste')
  ok(pasted?.runtime?.still === 'asset:still-map', 'the still ref survives when only the source is over budget')
  ok(rt.checkRuntime?.({ src: 'asset:scene-map', steps: 0, props: [] }, { 'scene-map': big })?.src === undefined,
    'checkRuntime with the asset table refuses the oversize source directly')
  ok(rt.checkRuntime?.({ src: 'asset:scene-map', steps: 0, props: [] }, { 'scene-map': sceneAsset })?.src === 'asset:scene-map',
    'checkRuntime keeps a source within budget')
  // the still mirrors the source gate, against its own budget
  const bigStill = 'data:image/png;base64,' + 'A'.repeat(300 * 1024)
  ok(rt.checkRuntime?.({ still: 'asset:still-map', steps: 0, props: [] }, { 'still-map': bigStill })?.still === undefined,
    'checkRuntime with the asset table refuses a still above RUNTIME_STILL_BUDGET')
  ok(rt.checkRuntime?.({ still: 'asset:still-map', steps: 0, props: [] }, { 'still-map': STILL_PNG })?.still === 'asset:still-map',
    'checkRuntime keeps a still within budget')
  ok(rt.checkRuntime?.({ still: 'asset:still-map', steps: 0, props: [] })?.still === 'asset:still-map',
    'without an asset table the still ref is kept (SLIDE_CHECKS sees no bytes)')
  const heavy = runtimeDeck()
  heavy.assets!['still-map'] = bigStill
  const heavyPaste = parseClip(serializeSlides([heavy.slides[0]], heavy))?.slides?.[0]
  ok(heavyPaste?.runtime?.still === undefined && heavyPaste?.runtime?.src === 'asset:scene-map',
    'on paste an oversize still ref is refused and the in-budget source kept')
}

// ----------------------------------------------------- 5. clipboard transport
console.log('\nclipboard round-trip')
{
  const source = runtimeDeck()
  const clipText = serializeSlides([source.slides[0]], source)
  const clip = parseClip(clipText)
  ok(!!clip?.assets?.['scene-map'], 'the scene source asset travels in the payload (no element references it)')
  ok(!!clip?.assets?.['still-map'], 'the still asset travels in the payload')

  // same keys, different bytes in the target: both must be remapped, and the
  // image element and runtime.still must land on the SAME fresh key
  const target = newDoc()
  target.assets = { 'still-map': 'data:image/png;base64,T1RIRVI=', 'scene-map': 'data:text/html;base64,T1RIRVI=' }
  const [pasted] = insertSlides(clip!, target, 1)
  const img = pasted.elements.find((e) => e.type === 'image')
  const imgKey = img && img.type === 'image' ? img.src.slice(6) : ''
  ok(imgKey !== 'still-map' && target.assets[imgKey] === STILL_PNG, 'the still image element is remapped to the pasted bytes')
  ok(pasted.runtime?.still === 'asset:' + imgKey, `runtime.still follows the element onto the same fresh key (${pasted.runtime?.still})`)
  const srcKey = pasted.runtime?.src?.slice(6) ?? ''
  ok(srcKey !== 'scene-map' && target.assets[srcKey] === sceneAsset, `runtime.src is remapped to the pasted scene bytes (${pasted.runtime?.src})`)
  ok(target.assets['scene-map'] === 'data:text/html;base64,T1RIRVI=', 'the target deck\'s own asset under the colliding key is untouched')
  ok(pasted.runtime?.steps === 3 && pasted.runtime?.props.length === 3 && pasted.runtime?.values?.title === 'Bergen',
    'steps, props and values survive the paste')
  ok(findings(target).filter((f) => f.slide === pasted.id && f.severity !== 'info').length === 0,
    'the pasted runtime slide validates clean in the target deck')
}

// ---------------------------------------------------------- 6. validate
console.log('\nvalidate advises')
{
  const noImage = runtimeDeck()
  noImage.slides[0].elements = [defaultText({ id: 't', html: 'x' })]
  const f1 = findings(noImage, 'runtime-no-still')
  ok(f1.length === 1 && f1[0].severity === 'warning', 'a runtime slide with no image element is a warning')
  ok(validateDoc(noImage, { measure: false }).ok, 'and the document is still ok (no error)')

  const dangling = runtimeDeck()
  dangling.slides[0].runtime!.still = 'asset:gone'
  const f2 = findings(dangling, 'runtime-dangling-ref')
  ok(f2.length === 1 && f2[0].severity === 'warning' && f2[0].path === 'runtime.still', 'a dangling still ref is a warning on runtime.still')
  ok(validateDoc(dangling, { measure: false }).ok, 'and the document is still ok (no error)')

  const native = newDoc()
  ok(findings(native).every((f) => !f.code.startsWith('runtime-')), 'a native slide gets no runtime findings')
}

// ---------------------------------------------- 7. declared scene assets
console.log('\ndeclared scene assets')
{
  const kept = rt.checkRuntime?.({ steps: 0, props: [], assets: ['map.svg', 'data.json', 'map.svg', '../etc/passwd', 'a b', '', 7, '.hidden'] })
  ok(JSON.stringify(kept?.assets) === JSON.stringify(['map.svg', 'data.json']),
    `assets keep only store-legal names, deduped (${JSON.stringify(kept?.assets)})`)
  ok(rt.checkRuntime?.({ steps: 0, props: [], assets: 'map.svg' })?.assets === undefined, 'a non-array `assets` is dropped')
  ok(rt.checkRuntime?.({ steps: 0, props: [], assets: [] })?.assets === undefined, 'an empty `assets` list is omitted')
  const many = Array.from({ length: 200 }, (_, i) => `a${i}.png`)
  ok((rt.checkRuntime?.({ steps: 0, props: [], assets: many })?.assets?.length ?? 0) === 64, 'the asset list is capped at 64')
  const doc = runtimeDeck()
  doc.slides[0].runtime!.assets = ['map.svg']
  const clean = sanitizeSlide(JSON.parse(JSON.stringify(doc.slides[0])))
  ok(JSON.stringify(clean?.runtime) === JSON.stringify(doc.slides[0].runtime), 'a runtime with assets survives sanitizeSlide byte-identical')
}

// ------------------------------------------------ 8. present: steps & frame
// The live half (docs/plans/2026-09-14-001, U4, KTD3/KTD4). What the browser
// check cannot pin down cheaply lives here as pure functions: the step walk,
// which messages are accepted, that nothing is posted before the scene says
// it is ready, and that no asset URL exists without a store deck id.
console.log('\npresent: steps, messages, readiness, asset urls')
type PresentModule = typeof import('../slides/src/runtime-present.ts')
let rp: Partial<PresentModule> = {}
try { rp = await import('../slides/src/runtime-present.ts') } catch (e) { console.log(`  (runtime-present.ts not loadable: ${(e as Error).message})`) }
{
  // step reducer: `steps: 5` is indices 0..4
  ok(rp.enterStep?.(5, true) === 0, 'forward entry on a 5-step scene lands on step 0')
  ok(rp.enterStep?.(5, false) === 4, 'backward entry lands on the last step (4)')
  ok(rp.enterStep?.(0, false) === 0, 'backward entry on a scene without steps is 0')
  const walk: Array<number | null | undefined> = []
  let i: number | null | undefined = 0
  for (let n = 0; n < 5 && typeof i === 'number'; n++) { i = rp.moveStep?.(5, i, 'next'); walk.push(i) }
  ok(JSON.stringify(walk) === JSON.stringify([1, 2, 3, 4, null]), `next walks 0→4, then signals leave (${JSON.stringify(walk)})`)
  ok(rp.moveStep?.(5, 4, 'prev') === 3, 'prev from 4 steps back to 3')
  ok(rp.moveStep?.(5, 0, 'prev') === null, 'prev on step 0 signals leave')
  ok(rp.moveStep?.(0, 0, 'next') === null && rp.moveStep?.(0, 0, 'prev') === null, '`steps: 0` leaves at once both ways, like a native slide')
  ok(rp.moveStep?.(1, 0, 'next') === null, 'a single step leaves on next')

  // props: declared defaults overlaid with presenter values
  const deck = runtimeDeck()
  const props = rp.sceneProps?.(deck.slides[0].runtime!)
  ok(JSON.stringify(props) === JSON.stringify({ title: 'Bergen', count: 5, accent: '#1A1A1A' }),
    `sceneProps overlays values on declared defaults (${JSON.stringify(props)})`)

  // inbound messages
  ok(rp.parseSceneMessage?.({ type: 'bento:ready' })?.type === 'bento:ready', 'bento:ready parses')
  ok(rp.parseSceneMessage?.({ type: 'bento:navigate', dir: 'next' })?.type === 'bento:navigate', 'bento:navigate {dir:next} parses')
  ok(rp.parseSceneMessage?.({ type: 'bento:navigate', dir: 'exit' })?.type === 'bento:navigate', 'bento:navigate {dir:exit} parses')
  ok(rp.parseSceneMessage?.({ type: 'bento:navigate', dir: 'sideways' }) === null, 'an unknown navigate dir is refused')
  ok(rp.parseSceneMessage?.('bento:ready') === null && rp.parseSceneMessage?.(null) === null, 'non-object data is refused')
  ok(rp.parseSceneMessage?.({ type: 'bento:init' }) === null, 'a shell-to-scene type coming back is refused')
  const frameWin = {} as Window
  ok(rp.fromFrame?.({ source: frameWin } as unknown as MessageEvent, frameWin) === true, 'a message whose source is the frame window is accepted')
  ok(rp.fromFrame?.({ source: {} } as unknown as MessageEvent, frameWin) === false, 'a message from any other window is ignored')
  ok(rp.fromFrame?.({ source: null } as unknown as MessageEvent, null) === false, 'no frame window, nothing accepted (null === null is not a match)')

  // ready gating
  if (rp.SceneChannel) {
    const posted: Array<Record<string, unknown>> = []
    let step = 0
    const ch = new rp.SceneChannel((m) => posted.push(m as unknown as Record<string, unknown>),
      () => ({ type: 'bento:init', step, steps: 5, props: {}, reduceMotion: false }))
    ch.step(2)
    ch.motion(true)
    ch.props({ title: 'Oslo' })
    ch.assets({ 'map.svg': new Blob(['<svg/>'], { type: 'image/svg+xml' }) })
    ok(posted.length === 0, 'nothing is posted before bento:ready')
    step = 2
    ch.ready()
    ok(posted.map((m) => m.type).join(',') === 'bento:init,bento:assets', `on ready: init first, then held assets (${posted.map((m) => m.type).join(',')})`)
    ok(posted[0]?.step === 2, 'init carries the step current at ready time')
    ok(posted[1]?.assets instanceof Object && (posted[1].assets as Record<string, unknown>)['map.svg'] instanceof Blob, 'bento:assets carries {name: Blob}')
    ch.step(3)
    ch.motion(false)
    ch.props({ title: 'Oslo' })
    ok(posted.slice(2).map((m) => `${m.type}`).join(',') === 'bento:step,bento:motion,bento:props', 'after ready, step/motion/props post straight away')
    ok(posted[2]?.index === 3 && posted[3]?.reduce === false, 'with their payloads ({index}, {reduce})')
    const late = new rp.SceneChannel((m) => posted.push(m as unknown as Record<string, unknown>),
      () => ({ type: 'bento:init', step: 0, steps: 0, props: {}, reduceMotion: false }))
    const before = posted.length
    late.ready()
    ok(posted.length === before + 1, 'with no assets held, ready posts init only')
  } else ok(false, 'SceneChannel is exported')

  // asset urls
  ok(rp.assetUrl?.(null, 'map.svg') === null, 'no store deck id, no asset url (a file:// or downloaded copy)')
  ok(rp.assetUrl?.('abc123', 'map.svg') === '/d/abc123/assets/map.svg', `a store deck id gives the same-origin asset route (${rp.assetUrl?.('abc123', 'map.svg')})`)
  ok(rp.assetUrl?.('abc123', '../x') === null, 'an illegal asset name gives no url')

  // url-override gating (R7, AE7)
  ok(rp.urlFrameAllowed?.('https://example.com/x', { online: true }) === true, 'an https url loads when online')
  ok(rp.urlFrameAllowed?.('https://example.com/x', { online: false }) === false, 'navigator offline: no frame, the still stays')
  ok(rp.urlFrameAllowed?.('http://example.com/x', { online: true }) === false, 'plain http never loads')

  // the offline switch gates EVERY frame (an inline scene can fetch on its own)
  const inline = { html: SCENE }
  const hosted = { url: 'https://example.com/x' }
  ok(rp.frameAllowed?.(inline, { offline: false, online: true }) === true, 'inline scene, online: frame')
  ok(rp.frameAllowed?.(inline, { offline: false, online: false }) === true, 'inline scene, navigator offline but switch off: frame (nothing to load)')
  ok(rp.frameAllowed?.(inline, { offline: true, online: true }) === false, 'inline scene, offline switch on: no frame, the still stays')
  ok(rp.frameAllowed?.(hosted, { offline: true, online: true }) === false, 'url scene, offline switch on: no frame')
  ok(rp.frameAllowed?.(hosted, { offline: false, online: true }) === true, 'url scene, online: frame')
  ok(rp.frameAllowed?.({ url: 'http://example.com/x' }, { offline: false, online: true }) === false, 'url scene over plain http: no frame')

  // Access-gated asset Blobs go to inline scenes only, never to a hosted page
  ok(rp.sceneGetsAssets?.(inline) === true, 'an inline (srcdoc) scene receives bento:assets')
  ok(rp.sceneGetsAssets?.(hosted) === false, 'a url-override scene never receives bento:assets')

  // fetchAssets asks the store to revalidate, so a re-uploaded asset is not an hour stale
  if (rp.fetchAssets) {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const fake = async (url: string | URL, init: RequestInit = {}) => {
      seen.push({ url: String(url), init })
      return new Response(new Blob(['<svg/>']), { status: 200, headers: { 'content-type': 'image/svg+xml' } })
    }
    const got = await rp.fetchAssets('abc123', ['map.svg', '../bad'], fake)
    ok(seen.length === 1 && seen[0].url === '/d/abc123/assets/map.svg', `only legal names are requested (${seen.map((r) => r.url).join(',')})`)
    ok(seen[0]?.init.cache === 'no-cache', `the request revalidates (cache: ${seen[0]?.init.cache})`)
    ok(seen[0]?.init.credentials === 'same-origin' && seen[0]?.init.redirect === 'manual', 'same-origin credentials, manual redirect')
    ok(got['map.svg'] instanceof Blob, 'the fetched asset comes back as a Blob')
  } else ok(false, 'fetchAssets is exported')
}

// ------------------------------------------------ 9. present: the live window
// One owner holds every live frame in a show (2026-10-13-2236 plan, U13,
// KTD11). Which slides may hold one, what uncovers a frame, and that a scene
// mounted ahead of the show is told nothing until the show enters it, are pure
// and pinned here; the frame count itself is scripts/test-beta-liveness.mjs.
console.log('\npresent: the live window')
{
  const rp: Partial<PresentModule> = await import('../slides/src/runtime-present.ts')
  const same = (a: number[] | undefined, b: number[]) => !!a && a.length === b.length && a.every((v, i) => v === b[i])
  const all = (n: number) => Array.from({ length: n }, () => true)
  ok(rp.LIVE_WINDOW === 1, `the window is one slide either side (${rp.LIVE_WINDOW})`)
  if (rp.liveWindow) {
    const w = rp.liveWindow
    ok(same(w(all(6), 2, 2), [1, 2, 3]), `six scenes, on the third: slides two, three and four are live (${w(all(6), 2, 2)})`)
    ok(same(w(all(6), 0, 2), [0, 1]), 'on the first slide: it and the second')
    ok(same(w(all(6), 5, 2), [4, 5]), 'on the last slide: it and the one before')
    ok(same(w(all(1), 0, 2), [0]), 'a one-slide deck: that slide')
    // a state slide is skipped by the arrows, so it is nobody's neighbour
    const withState = [true, true, false, true]
    ok(same(w(withState, 3, 2), [3]), `the linear neighbour behind a state slide is two sections away, which Reveal does not lay out (${w(withState, 3, 2)})`)
    ok(same(w(withState, 3, 3), [1, 3]), 'a wider view distance reaches it, and still skips the state slide')
    ok(same(w(withState, 1, 2), [0, 1]), 'forward over a state slide: the next linear slide is out of reach at view distance 2')
    ok(same(w(withState, 2, 2), [1, 2, 3]), 'standing ON a state slide: it is live, with the linear slides either side')
    ok(same(w(all(6), 2, 1), [2]), 'view distance 1 lays out no neighbour: only the current slide')
    ok(same(w(all(6), 2, 9), [1, 2, 3]), 'a large view distance does not widen the window past LIVE_WINDOW')
    ok(same(w(all(6), 2, 9, 2), [0, 1, 2, 3, 4]), 'the span is a parameter (a rig can ask for two)')
    ok(same(w(all(6), -1, 2), []) && same(w(all(6), 6, 2), []) && same(w(all(6), 1.5, 2), []), 'no current slide, no window')
    ok(same(w([], 0, 2), []), 'an empty deck has no window')
  } else ok(false, 'liveWindow is exported')
  ok(rp.windowFits?.(2) === true && rp.windowFits?.(1) === false && rp.windowFits?.(Number.NaN) === false,
    'LIVE_WINDOW must stay below Reveal\'s viewDistance')
  ok(rp.uncovers?.('scene', 'ready') === true && rp.uncovers?.('scene', 'load') === true,
    'a scene is uncovered by bento:ready, or by load for a page that never says it')
  ok(rp.uncovers?.('embed', 'load') === true && rp.uncovers?.('embed', 'ready') === false,
    'a web embed is uncovered by load alone: it has no channel to say ready on')

  if (rp.SceneChannel) {
    const init = { type: 'bento:init' as const, step: 2, steps: 4, props: {}, reduceMotion: false }
    const blob = new Blob(['x'])
    // mounted ahead of the show: ready first, entry later
    let sent: unknown[] = []
    let ch = new rp.SceneChannel((m) => sent.push(m), () => init, false)
    ch.ready()
    ch.step(1); ch.props({ a: 1 }); ch.motion(true); ch.assets({ 'a.svg': blob })
    ok(sent.length === 0 && ch.live === false, `a scene mounted ahead of the show is told nothing, even after it says ready (${sent.length} messages)`)
    ch.enter()
    ok(sent.length === 2 && (sent[0] as { type: string }).type === 'bento:init' && (sent[1] as { type: string }).type === 'bento:assets' && ch.live === true,
      `entry sends init first, then the assets that were held (${sent.map((m) => (m as { type: string }).type).join(',')})`)
    ch.enter()
    ok(sent.length === 2, 'entering twice sends nothing twice')
    ch.step(3)
    ok(sent.length === 3 && (sent[2] as { type: string }).type === 'bento:step', 'once entered and ready, steps go through')
    // entered before the scene has loaded: init waits for ready
    sent = []
    ch = new rp.SceneChannel((m) => sent.push(m), () => init, false)
    ch.enter()
    ok(sent.length === 0 && ch.live === false, 'entered but not ready: nothing is posted into a frame that is not listening')
    ch.ready()
    ok(sent.length === 1 && (sent[0] as { type: string }).type === 'bento:init' && ch.live === true, 'ready after entry: init goes then')
    ch.ready()
    ok(sent.length === 2 && (sent[1] as { type: string }).type === 'bento:init', 'a second ready (the scene reloaded itself) replays init')
    // the default is the show's own slide: entered from the start
    sent = []
    ch = new rp.SceneChannel((m) => sent.push(m), () => init)
    ch.ready()
    ok(sent.length === 1, 'without the flag a channel is entered from the start, as before')
  } else ok(false, 'SceneChannel is exported')
}

// ------------------------------------------------ 10. present: the frame owner
// createRuntimeShow against a stand-in DOM and a clock the rig turns by hand.
// The browser rig counts real frames; what it cannot do cheaply is wait out a
// timeout twice, rebuild a section under the show, or move a slide to another
// index, so those are pinned here.
console.log('\npresent: the frame owner')
{
  const rp: Partial<PresentModule> = await import('../slides/src/runtime-present.ts')
  type Listener = (ev: unknown) => void
  interface FakeFrame {
    tag: string; className: string; title: string; referrerPolicy: string; style: Record<string, string>
    attrs: Record<string, string>; isConnected: boolean; parent: FakeHost | null; contentWindow: { posted: unknown[]; postMessage(m: unknown): void }
    on: Record<string, Listener[]>
    setAttribute(k: string, v: string): void; getAttribute(k: string): string | null; removeAttribute(k: string): void
    addEventListener(t: string, fn: Listener): void; remove(): void; fire(t: string): void
    srcdoc: string; src: string
  }
  interface FakeHost { frames: FakeFrame[]; appendChild(f: FakeFrame): void; hosts: Record<string, FakeHost>; querySelector(sel: string): FakeHost | null }
  const made: FakeFrame[] = []
  const mkFrame = (): FakeFrame => {
    const f: FakeFrame = {
      tag: 'iframe', className: '', title: '', referrerPolicy: '', style: {}, attrs: {}, isConnected: false, parent: null, on: {},
      contentWindow: { posted: [], postMessage(m) { this.posted.push(m) } },
      setAttribute(k, v) { this.attrs[k] = v }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }, removeAttribute(k) { delete this.attrs[k] },
      addEventListener(t, fn) { (this.on[t] ??= []).push(fn) },
      remove() { if (this.parent) this.parent.frames = this.parent.frames.filter((x) => x !== this); this.parent = null; this.isConnected = false },
      fire(t) { for (const fn of this.on[t] ?? []) fn({}) },
      get srcdoc() { return this.attrs.srcdoc ?? '' }, set srcdoc(v: string) { this.attrs.srcdoc = v },
      get src() { return this.attrs.src ?? '' }, set src(v: string) { this.attrs.src = v },
    }
    made.push(f)
    return f
  }
  const mkHost = (): FakeHost => ({
    frames: [], hosts: {},
    appendChild(f) { f.parent = this; f.isConnected = true; this.frames.push(f) },
    querySelector(sel) { const m = /data-el-id="([^"]+)"/.exec(sel); return m ? this.hosts[m[1]] ?? null : null },
  })
  // a clock turned by hand
  let now = 0
  let timers: { id: number; at: number; fn: () => void }[] = []
  let nextId = 1
  const tick = (ms: number) => {
    now += ms
    for (const t of timers.filter((x) => x.at <= now)) { timers = timers.filter((x) => x !== t); t.fn() }
  }
  let onMessage: Listener | null = null
  const g = globalThis as Record<string, unknown>
  const saved = { window: g.window, document: g.document, CSS: g.CSS }
  g.window = {
    addEventListener: (t: string, fn: Listener) => { if (t === 'message') onMessage = fn },
    removeEventListener: (t: string) => { if (t === 'message') onMessage = null },
    setTimeout: (fn: () => void, ms: number) => { const id = nextId++; timers.push({ id, at: now + ms, fn }); return id },
    focus: () => {},
  }
  g.clearTimeout = ((id: number) => { timers = timers.filter((t) => t.id !== id) }) as unknown
  g.document = { createElement: () => mkFrame(), activeElement: null }
  g.CSS = { escape: (v: string) => v }

  const sceneSlide = (id: string, steps = 3): Slide => ({ id, elements: [], runtime: { src: 'asset:sc', steps, props: [] } } as unknown as Slide)
  const embedSlide = (id: string, ...els: string[]): Slide => ({
    id, elements: els.map((e) => ({ type: 'embed', id: e, x: 0, y: 0, w: 10, h: 10, rotation: 0, app: 'web', url: 'https://example.com/' + e, live: true })),
  } as unknown as Slide)
  const build = (slides: Slide[]) => {
    const doc = newDoc()
    doc.assets = { sc: '<p>scene</p>' }
    doc.slides = slides
    const surfaces: FakeHost[] = []
    const section = (slide: Slide) => {
      const surface = mkHost()
      for (const el of slide.elements ?? []) surface.hosts[el.id] = mkHost()
      surfaces.push(surface)
      return { surface, querySelector: () => surface }
    }
    const slidesEl = { children: slides.map(section) }
    const moved: string[] = []
    const show = rp.createRuntimeShow!(doc, slidesEl as unknown as HTMLElement, null, {
      goNext: () => moved.push('next'), goPrev: () => moved.push('prev'), exit: () => moved.push('exit'),
      reduceMotion: () => false, viewDistance: () => 2,
    })
    const framesOn = (i: number): FakeFrame[] => {
      const s = (slidesEl.children[i] as { surface: FakeHost }).surface
      return [...s.frames, ...Object.values(s.hosts).flatMap((h) => h.frames)]
    }
    const live = () => slidesEl.children.map((_, i) => framesOn(i).length)
    const say = (f: FakeFrame, data: unknown) => onMessage?.({ source: f.contentWindow, data })
    const types = (f: FakeFrame) => f.contentWindow.posted.map((m) => (m as { type: string }).type)
    const rebuild = (i: number) => { for (const f of framesOn(i)) { f.isConnected = false; f.parent = null }; slidesEl.children[i] = section(doc.slides[i]) }
    return { doc, show, slidesEl, framesOn, live, say, types, moved, rebuild, section }
  }

  if (rp.createRuntimeShow) {
    // --- the window follows the show
    {
      const t = build(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => sceneSlide(id)))
      t.show.enter(2, true)
      ok(t.live().join('') === '011100', `on the third of six scenes, slides two to four hold one frame each (${t.live().join('')})`)
      const [b] = t.framesOn(1); const [c] = t.framesOn(2); const [d] = t.framesOn(3)
      ok(c.attrs.sandbox === 'allow-scripts allow-forms' && c.referrerPolicy === 'no-referrer' && c.attrs.srcdoc === '<p>scene</p>', 'a scene frame is sandboxed without same-origin and carries the scene')
      ok(c.style.visibility === 'hidden', 'covered until it reports')
      t.say(b, { type: 'bento:ready' }); t.say(c, { type: 'bento:ready' })
      ok(t.types(b).length === 0 && b.style.visibility === '', 'a neighbour that says ready is uncovered and told nothing')
      ok(t.types(c).join() === 'bento:init' && (c.contentWindow.posted[0] as { step: number }).step === 0, 'the scene showing gets bento:init, step 0')
      t.say(b, { type: 'bento:navigate', dir: 'next' }); t.say(d, { type: 'bento:navigate', dir: 'exit' })
      ok(t.moved.length === 0, 'navigate from either neighbour moves nothing')
      t.say(c, { type: 'bento:navigate', dir: 'next' })
      ok(t.moved.join() === 'next', 'navigate from the scene showing moves the show')
      onMessage?.({ source: {}, data: { type: 'bento:navigate', dir: 'exit' } })
      ok(t.moved.join() === 'next', 'a message from no frame of ours is ignored')
      ok(t.show.next() === true && t.show.step() === 1 && t.types(c).join() === 'bento:init,bento:step', 'an arrow walks the scene showing')
      // present.ts calls leave(from) then enter(to)
      t.show.leave(2); t.show.enter(3, true)
      ok(t.live().join('') === '001110', `one slide on, the window moves with it (${t.live().join('')})`)
      ok(!b.isConnected && !('srcdoc' in b.attrs) && !('src' in b.attrs), 'the frame that left the window is detached with src and srcdoc cleared')
      ok(!c.isConnected && t.framesOn(2)[0] !== c && t.types(t.framesOn(2)[0]).length === 0, 'the scene the show left is replaced by a fresh, silent frame')
      ok(t.framesOn(3)[0] === d, 'the neighbour the show entered keeps the frame that was mounted ahead')
      t.say(d, { type: 'bento:ready' })
      ok(t.types(d).join() === 'bento:init', 'and hears bento:init now')
      t.say(c, { type: 'bento:ready' }); t.say(c, { type: 'bento:navigate', dir: 'next' })
      ok(t.moved.join() === 'next', 'a frame that was dropped cannot move the show')
      // backward, without a leave() first (the show's first slide, a presenter's early nav)
      t.show.enter(2, false)
      const c2 = t.framesOn(2)[0]
      t.say(c2, { type: 'bento:ready' })
      ok((c2.contentWindow.posted[0] as { step: number }).step === 2, 'entered backward, the scene opens on its last step')
      ok(t.framesOn(3)[0] !== d, 'enter() alone retires the scene that was showing')
      t.show.jump(4); t.show.enter(4, false)
      t.say(t.framesOn(4)[0], { type: 'bento:ready' })
      ok((t.framesOn(4)[0].contentWindow.posted[0] as { step: number }).step === 0, 'a rail jump opens on step 0 whatever the direction')
      ok(t.show.follow(4, 9) === true && t.show.step() === 2 && t.show.follow(3, 1) === false, 'follow clamps to the scene showing and refuses another slide')
      t.show.dispose()
      ok(t.live().join('') === '000000' && onMessage === null, 'dispose clears every frame and stops listening')
    }
    // --- a frame that never reports
    {
      const t = build([sceneSlide('a'), sceneSlide('b'), sceneSlide('c'), sceneSlide('d')])
      t.show.enter(0, true)
      const b = t.framesOn(1)[0]
      t.framesOn(0)[0].fire('load')
      tick(10_001)
      ok(t.live().join('') === '1000' && !b.isConnected, 'a frame that reported nothing in time is removed; one that loaded stays')
      t.show.enter(0, true)
      ok(t.live().join('') === '1000', 'it is not mounted again while its slide stays in the window')
      t.show.leave(0); t.show.enter(1, true)
      ok(t.live().join('') === '1110', 'walking onto its slide is one more try')
      const b2 = t.framesOn(1)[0]
      tick(10_001)
      ok(t.live().join('') === '0000' && t.show.step() === null && t.show.next() === false, 'a scene that never loads is its still: no step to walk, arrows change slide')
      t.show.leave(1); t.show.enter(3, true); t.show.leave(3); t.show.enter(2, true)
      ok(t.live()[1] === 1 && t.framesOn(1)[0] !== b2, 'having left the window and come back, it is tried again')
      t.show.dispose()
    }
    // --- web embeds: a frame, no channel
    {
      const t = build([embedSlide('p', 'e1', 'e2'), embedSlide('q', 'e3'), sceneSlide('r')])
      t.show.enter(0, true)
      ok(t.live().join('') === '210', `each embed in the window gets its own frame (${t.live().join('')})`)
      const [e1, e2] = t.framesOn(0)
      ok(e1.attrs.src === 'https://example.com/e1' && e1.attrs.sandbox === 'allow-scripts allow-forms' && e1.style.visibility === 'hidden', 'sandboxed, covered until load')
      t.say(e1, { type: 'bento:ready' })
      ok(e1.style.visibility === 'hidden' && e1.contentWindow.posted.length === 0, 'bento:ready from an embedded page uncovers nothing and is answered with nothing')
      t.say(e1, { type: 'bento:navigate', dir: 'exit' })
      ok(t.moved.length === 0, 'bento:navigate from an embedded page on the slide showing moves nothing')
      e1.fire('load')
      ok(e1.style.visibility === '', 'load uncovers it')
      tick(10_001)
      ok(e1.isConnected && !e2.isConnected, 'the embed that never loaded is removed; its neighbour on the same slide stays')
      t.show.setReduceMotion(true); t.show.jump(0)
      ok(t.show.step() === null && t.show.next() === false && e1.contentWindow.posted.length === 0, 'an embed slide has no steps and its frame is never posted to')
      t.show.leave(0); t.show.enter(1, true); t.show.leave(1); t.show.enter(0, false)
      ok(t.framesOn(0)[0] === e1, 'an embed keeps its frame while it stays in the window (it is not a scene to restart)')
      t.show.dispose()
      ok(!e1.isConnected && !('src' in e1.attrs), 'dispose clears embeds too')
    }
    // --- state slides, and a section rebuilt under the show
    {
      const state = { ...sceneSlide('b1'), stateOf: 'b' } as unknown as Slide
      const t = build([sceneSlide('a'), sceneSlide('b'), state, sceneSlide('c')])
      t.show.enter(1, true)
      ok(t.live().join('') === '1100', `a state slide is nobody's neighbour, and the slide past it is not laid out (${t.live().join('')})`)
      t.say(t.framesOn(1)[0], { type: 'bento:ready' })
      t.show.next(); t.show.next()
      ok(t.show.step() === 2, 'the scene is on its third step')
      t.rebuild(1)
      ok(t.show.step() === null, 'a rebuilt section has lost its frame: no scene to step')
      t.show.refresh(1)
      const b2 = t.framesOn(1)[0]
      ok(!!b2 && t.live().join('') === '1100', 'refresh mounts it again')
      t.say(b2, { type: 'bento:ready' })
      ok((b2.contentWindow.posted[0] as { type: string; step: number }).type === 'bento:init' && (b2.contentWindow.posted[0] as { step: number }).step === 2,
        'and the new scene opens on the step the audience was on')
      // an insert before it moved the slide to another index: still the same slide
      t.doc.slides.unshift(sceneSlide('new'))
      for (let i = 0; i < t.slidesEl.children.length; i++) for (const f of t.framesOn(i)) { f.isConnected = false; f.parent = null } // replaceChildren detaches them
      t.slidesEl.children = t.doc.slides.map(t.section)
      t.show.refresh(2)
      const b3 = t.framesOn(2)[0]
      t.say(b3, { type: 'bento:ready' })
      ok((b3?.contentWindow.posted[0] as { step: number } | undefined)?.step === 2, 'moved to another index by an insert before it, it is the same slide on the same step')
      ok(t.live().join('') === '01100', `and the window is counted from where it is now (${t.live().join('')})`)
      // rebuilt(): many sections in one go, one refresh, after the caller is done
      let asked = 0
      t.rebuild(2)
      t.show.rebuilt(() => { asked++; return 2 }); t.show.rebuilt(() => { asked++; return 2 })
      ok(t.live()[2] === 0 && asked === 0, 'rebuilt() does nothing while the caller is still replacing nodes')
      await new Promise<void>((r) => queueMicrotask(r))
      ok(t.live()[2] === 1 && asked === 1, 'a microtask on, one refresh puts the frame back')
      t.show.rebuilt(() => 2); t.show.dispose()
      await new Promise<void>((r) => queueMicrotask(r))
      ok(t.live().join('') === '00000', 'a refresh queued before the show ended mounts nothing after it')
    }
    // Walk every boundary in both directions, not just the third slide.
    {
      const t = build(['walk-a', 'walk-b', 'walk-c', 'walk-d', 'walk-e', 'walk-f'].map((id) => sceneSlide(id)))
      let previous = -1
      const faults: string[] = []
      for (const index of [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0]) {
        if (previous >= 0) t.show.leave(previous)
        t.show.enter(index, index > previous)
        const expected = t.doc.slides.map((_, i) => Math.abs(i - index) <= 1 ? 1 : 0).join('')
        if (t.live().join('') !== expected) faults.push(`${index}: ${t.live().join('')} != ${expected}`)
        for (let i = 0; i < t.doc.slides.length; i++) {
          for (const f of t.framesOn(i)) t.say(f, { type: 'bento:ready' })
        }
        const f = t.framesOn(index)[0]
        const init = f.contentWindow.posted[0] as { step: number }
        if (init.step !== (index > previous ? 0 : 2)) faults.push(`${index}: wrong entry step ${init.step}`)
        previous = index
      }
      t.show.dispose(); tick(10_001)
      ok(faults.length === 0 && t.live().every((n) => n === 0),
        `U13 adversarial: six-scene forward/back walk counts every window and entry step (${faults.join('; ')})`)
    }
    {
      const t = build([sceneSlide('loading-a'), sceneSlide('loading-b')])
      t.show.enter(0, false)
      const f = t.framesOn(0)[0]
      const loading = t.show.step() === 2 && t.show.follow(0, 1) && t.show.step() === 1
        && !t.show.next() && !t.show.prev() && t.types(f).length === 0
      t.show.jump(0); t.say(f, { type: 'bento:ready' })
      const reset = (f.contentWindow.posted[0] as { step: number }).step === 0
      t.show.leave(0)
      t.say(f, { type: 'bento:navigate', dir: 'next' })
      ok(loading && reset && t.show.step() === null && !t.show.follow(0, 1)
        && !t.show.next() && !t.show.prev() && t.moved.length === 0,
        'U13 adversarial: loading follow/jump state survives ready; leave shuts navigation')
      t.show.dispose()
    }
    // Independent U13 adversarial regressions. Assertions describe the contract,
    // not the current implementation; leave failures visible until fixed.
    // --- failure path: error event, late signals, and retry on actual entry
    {
      const t = build([sceneSlide('error-a'), sceneSlide('error-b')])
      t.show.enter(0, true)
      const old = t.framesOn(1)[0]
      old.fire('error')
      t.say(old, { type: 'bento:ready' })
      t.say(old, { type: 'bento:navigate', dir: 'exit' })
      t.show.refresh(0)
      const suppressed = t.framesOn(1).length === 0 && t.moved.length === 0
        && !old.isConnected && !('src' in old.attrs) && !('srcdoc' in old.attrs)
      t.show.leave(0); t.show.enter(1, true)
      const fresh = t.framesOn(1)[0]
      t.say(fresh, { type: 'bento:ready' })
      ok(suppressed && fresh !== old && t.types(fresh).join() === 'bento:init',
        'U13 adversarial: error removes frame, ignores late messages, retries only on entry')
      t.show.dispose()
    }
    // --- failure path: an embed times out, refresh must not create a retry loop
    {
      const t = build([embedSlide('timeout', 'hung')])
      t.show.enter(0, true)
      const old = t.framesOn(0)[0]
      tick(10_001)
      old.fire('load')
      t.show.refresh(0); t.show.refresh(0)
      const quiet = t.framesOn(0).length === 0 && t.show.step() === null
        && !t.show.follow(0, 2) && !t.show.next() && !t.show.prev()
      t.show.leave(0); t.show.enter(0, true)
      ok(quiet && t.framesOn(0).length === 1 && t.framesOn(0)[0] !== old,
        'U13 adversarial: timed-out single embed ignores late load and waits for re-entry')
      t.show.dispose()
    }
    // --- failure path: source refused, distinct from a mounted frame timing out
    {
      const t = build([{ ...sceneSlide('missing'), runtime: { src: 'asset:absent', steps: 4, props: [] } } as Slide])
      t.show.enter(0, false)
      ok(t.framesOn(0).length === 0 && t.show.step() === null && !t.show.follow(0, 3)
        && !t.show.canNext() && !t.show.canPrev(),
        'U13 adversarial: missing source leaves a still with no phantom steps')
      t.show.dispose()
    }
    // A hosted scene can load without ever speaking the scene protocol.
    {
      const t = build([sceneSlide('load-only')])
      t.show.enter(0, true)
      const f = t.framesOn(0)[0]
      f.fire('load'); tick(10_001)
      ok(f.isConnected && f.style.visibility === '' && t.types(f).length === 0
        && !t.show.next() && !t.show.prev(),
        'U13 adversarial: load without ready stays visible and does not trap arrows')
      t.show.dispose()
    }
    // main.ts rebuilds only the current section for a same-length remote edit.
    // The neighbour is already mounted, so entering it must reconcile its source.
    {
      const t = build([sceneSlide('edit-a'), sceneSlide('edit-b')])
      t.show.enter(0, true)
      const old = t.framesOn(1)[0]
      t.say(old, { type: 'bento:ready' })
      t.doc.assets.sc2 = '<p>updated scene</p>'
      t.doc.slides[1].runtime = { src: 'asset:sc2', steps: 1, props: [] }
      t.rebuild(0); t.show.rebuilt(() => 0)
      await new Promise<void>((r) => queueMicrotask(r))
      t.show.leave(0); t.show.enter(1, true)
      const f = t.framesOn(1)[0]
      t.say(f, { type: 'bento:ready' })
      const init = f.contentWindow.posted.find((m) => (m as { type: string }).type === 'bento:init') as { steps: number } | undefined
      ok(f.srcdoc === '<p>updated scene</p>' && init?.steps === 1,
        `U13 adversarial: edited pre-mounted neighbour enters with current content (srcdoc=${f.srcdoc}, steps=${init?.steps})`)
      t.show.dispose()
    }
    // Rebuild keeps the step only while that step still exists in the new scene.
    {
      const t = build([sceneSlide('shrink', 4)])
      t.show.enter(0, true); t.say(t.framesOn(0)[0], { type: 'bento:ready' })
      t.show.follow(0, 3)
      t.doc.slides[0].runtime = { src: 'asset:sc', steps: 1, props: [] }
      t.rebuild(0); t.show.rebuilt(() => 0)
      await new Promise<void>((r) => queueMicrotask(r))
      const f = t.framesOn(0)[0]
      t.say(f, { type: 'bento:ready' })
      const init = f.contentWindow.posted[0] as { step: number; steps: number }
      ok(init.step === 0 && init.steps === 1 && t.show.step() === 0,
        `U13 adversarial: rebuilt scene clamps removed step (init=${JSON.stringify(init)})`)
      t.show.dispose()
    }
    // A delayed caller must not revive the owner after dispose (e.g. the
    // presentation's outstanding initialize().then callback after an early exit).
    {
      const t = build([sceneSlide('disposed')])
      t.show.enter(0, true)
      t.show.rebuilt(() => 0)
      t.show.dispose()
      await new Promise<void>((r) => queueMicrotask(r))
      t.show.refresh(0); t.show.enter(0, true)
      ok(t.framesOn(0).length === 0 && t.show.step() === null && timers.length === 0,
        `U13 adversarial: disposed owner cannot be revived by late refresh or enter (frames=${t.framesOn(0).length}, timers=${timers.length})`)
      t.show.dispose()
    }
    // --- the switches that refuse a frame still refuse it
    {
      const hosted = { id: 'h', elements: [], runtime: { url: 'http://example.com/x', steps: 1, props: [] } } as unknown as Slide
      const dead = { id: 'x', elements: [{ type: 'embed', id: 'e', x: 0, y: 0, w: 1, h: 1, rotation: 0, app: 'web', url: 'https://example.com/', live: false }] } as unknown as Slide
      const t = build([hosted, dead, sceneSlide('z')])
      t.show.enter(1, true)
      ok(t.live().join('') === '001', `a plain-http scene and an embed that is not live get no frame (${t.live().join('')})`)
      t.show.dispose()
    }
    // --- found in review (a correctness read of the first commit)
    {
      const t = build(['a', 'b', 'c'].map((id) => sceneSlide(id, 4)))
      t.show.enter(0, true)
      const b = t.framesOn(1)[0]
      t.say(b, { type: 'bento:ready' }) // mounted ahead and already ready
      t.show.leave(0); t.show.enter(1, true, 2); t.show.follow(1, 2)
      ok(t.types(b).join() === 'bento:init' && (b.contentWindow.posted[0] as { step: number }).step === 2,
        `a step the presenter named is the one a pre-mounted scene opens on, in one message (${JSON.stringify(b.contentWindow.posted)})`)
      ok(t.show.follow(1, Number.NaN) === true && t.show.step() === 0, 'a step that is not a number is step 0, never NaN')
      // a slide inserted before the one showing, with no rebuild (the presenter's own show)
      t.show.follow(1, 1)
      t.doc.slides.unshift(sceneSlide('new'))
      ok(t.show.step() === 1 && t.show.next() === true, 'a slide inserted before it does not take the scene showing away from the arrows')
      t.say(b, { type: 'bento:navigate', dir: 'next' })
      ok(t.moved.join() === 'next', 'and its bento:navigate is still read')
      t.show.dispose()
    }
    {
      // a hand-written deck that repeats a slide id
      const t = build([sceneSlide('same'), sceneSlide('same'), sceneSlide('z')])
      t.show.enter(1, true)
      ok(t.live().join('') === '111', `two slides sharing an id each hold their own frame (${t.live().join('')})`)
      const second = t.framesOn(1)[0]
      t.say(t.framesOn(0)[0], { type: 'bento:ready' }); t.say(second, { type: 'bento:ready' })
      ok(t.types(second).join() === 'bento:init' && t.types(t.framesOn(0)[0]).length === 0, 'and the one showing is the one that is told')
      t.show.dispose()
    }
    {
      // the ten seconds count from entry for a frame mounted ahead of the show
      const t = build([sceneSlide('a'), embedSlide('p', 'e1')])
      t.show.enter(0, true)
      const e1 = t.framesOn(1)[0]
      tick(9_000)
      t.show.leave(0); t.show.enter(1, true)
      tick(9_000)
      ok(e1.isConnected, 'a covered frame gets its full time again when the show reaches its slide')
      tick(1_001)
      ok(!e1.isConnected, 'and is removed when that runs out')
      t.show.dispose()
    }
    // Round 2: assertions written against the contract before running the
    // implementation. Keep failures visible; this review changes no product code.
    {
      const t = build([embedSlide('deadline', 'hung')])
      t.show.enter(0, true)
      const f = t.framesOn(0)[0]
      tick(6_000)
      t.show.refresh(0) // same connected frame, not a new arrival
      tick(4_001)
      ok(!f.isConnected && t.framesOn(0).length === 0,
        `U13 round2: refresh preserves the deadline of a hung embed (connected at 10001ms=${f.isConnected})`)
      t.show.dispose()
    }
    {
      const { setOffline } = await import('../kernel/src/net.ts')
      setOffline(false)
      const t = build([sceneSlide('online'), sceneSlide('premounted')])
      try {
        t.show.enter(0, true)
        const f = t.framesOn(1)[0]
        t.say(f, { type: 'bento:ready' })
        // The switch can change in another tab while this show is open.
        setOffline(true)
        t.show.leave(0); t.show.enter(1, true)
        ok(!f.isConnected && t.live().every((n) => n === 0)
          && t.show.step() === null && t.types(f).length === 0,
          `U13 round2: offline switch refuses an already pre-mounted scene on entry (frames=${t.live()}, messages=${t.types(f)}, step=${t.show.step()})`)
      } finally { t.show.dispose(); setOffline(false) }
    }
    {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
      const hosted = { ...sceneSlide('hosted'), runtime: { url: 'https://example.com/scene', steps: 2, props: [] } } as Slide
      const t = build([sceneSlide('local'), hosted])
      try {
        t.show.enter(0, true)
        const f = t.framesOn(1)[0]
        f.fire('load')
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } })
        t.show.leave(0); t.show.enter(1, true)
        ok(!f.isConnected && t.framesOn(1).length === 0 && t.show.step() === null,
          `U13 round2: loss of network refuses a pre-mounted hosted scene on entry (connected=${f.isConnected}, step=${t.show.step()})`)
      } finally {
        t.show.dispose()
        if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor)
        else delete g.navigator
      }
    }
    {
      const t = build([sceneSlide('error-current'), sceneSlide('survivor')])
      t.show.enter(0, true)
      const f = t.framesOn(0)[0]
      f.fire('error')
      t.rebuild(0); t.show.rebuilt(() => 0)
      await new Promise<void>((r) => queueMicrotask(r))
      t.say(f, { type: 'bento:ready' }); t.say(f, { type: 'bento:navigate', dir: 'exit' })
      const quiet = t.framesOn(0).length === 0 && t.show.step() === null
        && !t.show.follow(0, 2) && !t.show.next() && !t.show.prev() && t.moved.length === 0
      t.show.leave(0); t.show.enter(1, true)
      t.show.leave(1); t.show.enter(0, true)
      const fresh = t.framesOn(0)[0]
      t.say(fresh, { type: 'bento:ready' })
      ok(quiet && fresh !== f && t.types(fresh).join() === 'bento:init',
        'U13 round2: rebuild after current-scene error stays failed until re-entry')
      t.show.dispose()
    }
    // Round 3: expectations written before running these probes. No product
    // fixes here. Mirror main.ts's same-length audience edit: replace ONLY
    // the current section, then let rebuilt() reconcile the live window.
    {
      const t = build([sceneSlide('reorder-a'), sceneSlide('reorder-b'), sceneSlide('reorder-c')])
      t.show.enter(1, true)
      const oldA = t.framesOn(0)[0]
      t.say(oldA, { type: 'bento:ready' })
      ;[t.doc.slides[0], t.doc.slides[1]] = [t.doc.slides[1], t.doc.slides[0]]
      t.rebuild(1); t.show.rebuilt(() => 1)
      await new Promise<void>((r) => queueMicrotask(r))
      const counts = t.live().join(',')
      // A frame still connected to the old section is not the scene showing.
      t.say(oldA, { type: 'bento:navigate', dir: 'exit' })
      const active = t.framesOn(1)[0]
      if (active) t.say(active, { type: 'bento:ready' })
      ok(counts === '1,1,1' && !!active && active.parent === t.slidesEl.children[1].surface
        && t.moved.length === 0 && t.types(oldA).length === 0,
        `U13 round3: reordered scene belongs to its rebuilt section (frames=${counts}, old-neighbour messages=${t.types(oldA)}, navigation=${t.moved})`)
      t.show.dispose()
    }
    {
      const t = build([embedSlide('reorder-page-a', 'page'), embedSlide('reorder-page-b', 'page'), sceneSlide('reorder-tail')])
      t.show.enter(1, true)
      const oldA = t.framesOn(0)[0]
      oldA.fire('load')
      ;[t.doc.slides[0], t.doc.slides[1]] = [t.doc.slides[1], t.doc.slides[0]]
      t.rebuild(1); t.show.rebuilt(() => 1)
      await new Promise<void>((r) => queueMicrotask(r))
      ok(t.live().join(',') === '1,1,1' && t.framesOn(1)[0]?.parent === t.slidesEl.children[1].surface.hosts.page,
        `U13 round3: reordered embed belongs to its rebuilt element (frames=${t.live()})`)
      t.show.dispose()
    }
    // Failure path: timeout. Hiding a neighbour removes it from the window;
    // restoring it must clear the failed tombstone and grant a fresh deadline.
    {
      const t = build([sceneSlide('timeout-anchor'), embedSlide('timeout-hidden', 'page')])
      t.show.enter(0, true)
      t.framesOn(0)[0].fire('load')
      const old = t.framesOn(1)[0]
      tick(10_001)
      t.doc.slides[1].hidden = true; t.show.refresh(0)
      t.doc.slides[1].hidden = false; t.show.refresh(0)
      const fresh = t.framesOn(1)[0]
      old.fire('load'); old.fire('error')
      tick(9_999)
      const survived = fresh?.isConnected && fresh !== old && fresh.style.visibility === 'hidden'
      tick(2)
      ok(!!survived && !fresh?.isConnected && t.framesOn(1).length === 0,
        'U13 round3: timeout retry after hidden-window departure has an independent deadline')
      t.show.dispose()
    }
    // Failure path: error. A second show must not inherit failed keys, queued
    // refreshes, timers, or messages from the disposed first show.
    {
      const first = build([sceneSlide('second-show')])
      first.show.enter(0, true)
      const old = first.framesOn(0)[0]
      old.fire('error'); first.show.rebuilt(() => 0); first.show.dispose()
      const second = build([sceneSlide('second-show')])
      second.show.enter(0, false)
      const fresh = second.framesOn(0)[0]
      await new Promise<void>((r) => queueMicrotask(r))
      second.say(old, { type: 'bento:ready' }); second.say(old, { type: 'bento:navigate', dir: 'exit' })
      old.fire('error'); old.fire('load')
      second.say(fresh, { type: 'bento:ready' })
      tick(10_001)
      ok(fresh.isConnected && second.moved.length === 0 && second.show.step() === 2
        && second.types(fresh).join() === 'bento:init' && timers.length === 0,
        'U13 round3: errored first show cannot interfere with the second show')
      second.show.dispose()
    }
    // Failure path: refused source. A missing asset may arrive in a remote
    // edit while the audience is still on that slide, including a followed step.
    {
      const t = build([sceneSlide('late-source')])
      delete t.doc.assets.sc
      t.show.enter(0, false)
      const refused = t.show.step() === null && !t.show.follow(0, 1) && !t.show.canPrev()
      t.doc.assets.sc = '<p>arrived later</p>'
      t.rebuild(0); t.show.rebuilt(() => 0)
      await new Promise<void>((r) => queueMicrotask(r))
      const f = t.framesOn(0)[0]
      const accepted = t.show.follow(0, 1)
      t.say(f, { type: 'bento:ready' })
      const init = f.contentWindow.posted[0] as { step: number }
      ok(refused && accepted && init.step === 1 && t.types(f).join() === 'bento:init'
        && f.srcdoc === '<p>arrived later</p>',
        'U13 round3: refused source recovers on rebuild and opens at the followed step')
      t.show.dispose()
    }
    // Round 4: new contract-first probes, written before execution. Product
    // code is deliberately untouched so a failing expectation stays visible.
    // Timeout: an unrelated remote edit rebuilds the current section, but a
    // hung neighbour has neither left the window nor been entered again.
    {
      const t = build([sceneSlide('r4-anchor'), embedSlide('r4-hung', 'page')])
      t.show.enter(0, true)
      t.framesOn(0)[0].fire('load')
      tick(6_000)
      t.rebuild(0); t.show.rebuilt(() => 0)
      await new Promise<void>((r) => queueMicrotask(r))
      t.framesOn(0)[0].fire('load')
      tick(4_001)
      const atDeadline = t.framesOn(1).length
      // Keep simulating document updates more often than LOAD_TIMEOUT_MS.
      for (let n = 0; n < 3; n++) {
        t.rebuild(0); t.show.rebuilt(() => 0)
        await new Promise<void>((r) => queueMicrotask(r))
        t.framesOn(0)[0].fire('load')
        tick(6_000)
      }
      ok(atDeadline === 0 && t.framesOn(1).length === 0,
        `U13 round4: audience rebuilds cannot renew a hung neighbour's deadline (frames at 10001ms=${atDeadline}, at 28001ms=${t.framesOn(1).length})`)
      t.show.dispose()
    }
    // Error: deleting the failed slide and shrinking the section list must
    // not poison the surviving scene or accept the failed frame's messages.
    {
      const t = build([sceneSlide('r4-delete'), sceneSlide('r4-survivor', 4)])
      t.show.enter(0, true)
      const old = t.framesOn(0)[0]
      old.fire('error')
      t.doc.slides.splice(0, 1)
      for (let i = 0; i < t.slidesEl.children.length; i++) {
        for (const f of t.framesOn(i)) f.remove()
      }
      t.slidesEl.children = t.doc.slides.map(t.section)
      t.show.rebuilt(() => 0)
      await new Promise<void>((r) => queueMicrotask(r))
      const f = t.framesOn(0)[0]
      const followed = t.show.follow(0, 3)
      t.say(old, { type: 'bento:ready' }); t.say(old, { type: 'bento:navigate', dir: 'exit' })
      if (f) t.say(f, { type: 'bento:ready' })
      ok(t.live().join() === '1' && followed && t.show.step() === 3
        && t.moved.length === 0 && t.types(old).length === 0
        && (f?.contentWindow.posted[0] as { step?: number } | undefined)?.step === 3,
        'U13 round4: deleting an errored current slide leaves the survivor followable')
      t.show.dispose()
    }
    // Refused source: a runtime record takes precedence over an old live
    // embed element. A missing scene must not accidentally run that page;
    // removing the runtime record makes it an ordinary embed slide again.
    {
      const mixed = embedSlide('r4-mixed', 'page')
      mixed.runtime = { src: 'asset:missing', steps: 3, props: [] }
      const t = build([mixed])
      t.show.enter(0, false)
      const refused = t.framesOn(0).length === 0 && t.show.step() === null
        && !t.show.follow(0, 2) && !t.show.next() && !t.show.prev()
      delete mixed.runtime
      t.rebuild(0); t.show.rebuilt(() => 0)
      await new Promise<void>((r) => queueMicrotask(r))
      const f = t.framesOn(0)[0]
      if (f) {
        t.say(f, { type: 'bento:ready' }); t.say(f, { type: 'bento:navigate', dir: 'exit' })
        f.fire('load')
      }
      tick(10_001)
      ok(refused && !!f?.isConnected && f.style.visibility === ''
        && t.types(f).length === 0 && t.moved.length === 0 && t.show.step() === null,
        'U13 round4: refused mixed scene becomes a channel-free embed after conversion')
      t.show.dispose()
    }
    // --- found by a local model-based hunt, after Codex round 4
    {
      // a collaborator typing: a doc event every 500 ms, each rebuilding the section showing
      const t = build([embedSlide('p', 'e1'), sceneSlide('b'), sceneSlide('c')])
      t.show.enter(0, true)
      const b = t.framesOn(1)[0]
      t.say(b, { type: 'bento:ready' })
      for (let i = 0; i < 30; i++) {
        tick(500)
        t.rebuild(0); t.show.rebuilt(() => 0)
        await new Promise<void>((r) => queueMicrotask(r))
      }
      ok(t.framesOn(1)[0] === b && b.isConnected && t.types(b).length === 0, 'fifteen seconds of typing leave a neighbour\'s frame alone: not reloaded, not timed out, still silent')
      ok(t.live()[0] === 1, 'and the page on the slide showing is mounted again after each rebuild, never marked failed')
      t.framesOn(0)[0].fire('load')
      ok(t.framesOn(0)[0].style.visibility === '', 'so it shows as soon as the typing stops and it loads')
      t.show.dispose()
    }
    {
      // what failed stays failed until it changes
      const t = build([sceneSlide('a'), embedSlide('p', 'e1')])
      t.show.enter(0, true)
      t.framesOn(0)[0].fire('load')
      tick(10_001)
      ok(t.live().join('') === '10', 'the embed that hung is removed')
      const g = globalThis as unknown as { navigator?: unknown }
      const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
      Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })
      t.show.refresh(0)
      Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
      t.show.refresh(0)
      if (nav) Object.defineProperty(globalThis, 'navigator', nav); else delete g.navigator
      ok(t.live().join('') === '10', 'the network going away and coming back is not a reason to try it again')
      ;(t.doc.slides[1].elements[0] as unknown as { url: string }).url = 'https://example.com/other'
      t.show.refresh(0)
      ok(t.live().join('') === '11' && t.framesOn(1)[0].attrs.src === 'https://example.com/other', 'its url changing is: the new page gets its try')
      tick(9_999)
      ok(t.live().join('') === '11', 'with its own ten seconds')
      t.show.dispose()
    }

    // Round 5: definition replacement, late signals and owner-key isolation.
    // Expectations are written before execution; product code stays untouched.
    // Timeout failure: a changed scene gets a new clock, but late signals from
    // the old frame must not uncover it or cancel that new clock.
    {
      const t = build([sceneSlide('r5-timeout-anchor'), sceneSlide('r5-timeout-neighbour')])
      t.show.enter(0, true)
      t.framesOn(0)[0].fire('load')
      const old = t.framesOn(1)[0]
      tick(10_001)
      t.doc.assets.replacement = '<p>replacement that also hangs</p>'
      t.doc.slides[1].runtime!.src = 'asset:replacement'
      t.show.refresh(0)
      const fresh = t.framesOn(1)[0]
      tick(6_000)
      old.fire('load'); old.fire('error'); t.say(old, { type: 'bento:ready' })
      const protectedUntilDeadline = fresh?.isConnected && fresh.style.visibility === 'hidden'
      t.show.refresh(0)
      tick(4_001)
      t.show.refresh(0)
      ok(!!protectedUntilDeadline && fresh !== old && !fresh?.isConnected
        && t.framesOn(1).length === 0 && t.moved.length === 0,
        'U13 round5: timed-out scene replacement owns its deadline despite stale signals')
      t.show.dispose()
    }
    // Error failure: replacing only the failed embed definition must neither
    // replace a healthy sibling nor give another hung sibling a fresh clock.
    {
      const t = build([embedSlide('r5-error', 'bad', 'healthy', 'hung')])
      t.show.enter(0, true)
      const [bad, healthy, hung] = t.framesOn(0)
      healthy.fire('load'); bad.fire('error')
      tick(6_000)
      ;(t.doc.slides[0].elements[0] as unknown as { url: string }).url = 'https://example.com/fixed'
      t.show.refresh(0)
      const replacement = t.framesOn(0).find((f) => f.src === 'https://example.com/fixed')
      bad.fire('load'); bad.fire('error'); t.say(bad, { type: 'bento:navigate', dir: 'exit' })
      tick(4_001)
      const siblings = healthy.isConnected && !hung.isConnected && replacement?.isConnected
      replacement?.fire('load')
      tick(10_001)
      ok(!!siblings && !!replacement?.isConnected && replacement.style.visibility === ''
        && t.types(replacement).length === 0 && t.moved.length === 0,
        'U13 round5: errored embed replacement preserves sibling identity and deadlines')
      t.show.dispose()
    }
    // Refused source: removing the referenced asset while a ready neighbour
    // waits must drop it; restoring the bytes gives a silent, fresh scene.
    {
      const t = build([sceneSlide('r5-source-anchor'), sceneSlide('r5-source-neighbour')])
      t.doc.assets.neighbour = '<p>neighbour</p>'
      t.doc.slides[1].runtime!.src = 'asset:neighbour'
      t.show.enter(0, true)
      const old = t.framesOn(1)[0]
      t.say(old, { type: 'bento:ready' })
      delete t.doc.assets.neighbour
      t.show.refresh(0)
      const refused = !old.isConnected && !old.srcdoc && t.framesOn(1).length === 0
      t.doc.assets.neighbour = '<p>restored</p>'
      t.show.refresh(0)
      const fresh = t.framesOn(1)[0]
      if (fresh) { t.say(fresh, { type: 'bento:ready' }); t.say(fresh, { type: 'bento:ready' }) }
      const silent = fresh && t.types(fresh).length === 0
      t.say(old, { type: 'bento:navigate', dir: 'exit' })
      t.show.leave(0); t.show.enter(1, false, 1)
      t.say(old, { type: 'bento:ready' })
      ok(!!refused && !!silent && fresh !== old && t.moved.length === 0
        && t.types(fresh).join() === 'bento:init'
        && (fresh.contentWindow.posted[0] as { step: number }).step === 1,
        'U13 round5: removed asset refuses a ready neighbour until a silent replacement can enter')
      t.show.dispose()
    }
    // IDs are untrusted CSS-safe strings, not restricted to an identifier
    // alphabet. Check the intake too so this is a reachable document shape.
    {
      const slide = sanitizeSlide(sceneSlide('r5\u001fvalid-id'))!
      const t = build([slide])
      t.show.enter(0, true)
      tick(10_001)
      const failedOnce = t.framesOn(0).length === 0
      t.show.refresh(0)
      ok(slide?.id === 'r5\u001fvalid-id' && failedOnce && t.framesOn(0).length === 0,
        `U13 round5: accepted separator in slide id cannot erase a timeout failure (frames after refresh=${t.framesOn(0).length})`)
      t.show.dispose()
    }
    {
      // The generated duplicate key for the second "same" equals the literal
      // id of the third slide. All three pass the real untrusted intake.
      const slides = [sceneSlide('r5-same'), sceneSlide('r5-same'), sceneSlide('r5-same\u001e1')]
        .map((s) => sanitizeSlide(s)!)
      const t = build(slides)
      t.show.enter(1, true)
      for (let i = 0; i < 3; i++) for (const f of t.framesOn(i)) t.say(f, { type: 'bento:ready' })
      const neighbour = t.framesOn(2)[0]
      if (neighbour) t.say(neighbour, { type: 'bento:navigate', dir: 'exit' })
      ok(t.live().join() === '1,1,1' && t.moved.length === 0
        && !!neighbour && t.types(neighbour).length === 0,
        `U13 round5: literal and generated slide keys cannot alias the current scene (frames=${t.live()}, navigation=${t.moved}, neighbour messages=${neighbour ? t.types(neighbour) : 'none'})`)
      t.show.dispose()
    }
    // Round 6: contract-first failure probes. These expectations are written
    // before running them; leave product code untouched if they expose a bug.
    // Timeout: the rail's same-slide replay must reset the pending step even
    // while the still is showing, so a repaired scene starts at the beginning.
    {
      const t = build([sceneSlide('r6-timeout-replay', 4)])
      t.show.enter(0, true)
      const old = t.framesOn(0)[0]
      const followed = t.show.follow(0, 3)
      tick(10_001)
      const failed = !old.isConnected && t.show.step() === null
      t.show.jump(0) // exactly the rail's call; Reveal emits no slidechanged here
      t.doc.assets.sc = '<p>repaired scene</p>'
      t.rebuild(0); t.show.rebuilt(() => 0)
      await new Promise<void>((r) => queueMicrotask(r))
      const fresh = t.framesOn(0)[0]
      if (fresh) t.say(fresh, { type: 'bento:ready' })
      const opening = (fresh?.contentWindow.posted[0] as { step?: number } | undefined)?.step
      ok(followed && failed && fresh !== old && opening === 0,
        `U13 round6: same-slide replay after timeout survives scene repair (opening step=${opening}, expected 0)`)
      t.show.dispose()
    }
    // Error: changing only a scene's configured values is a new definition,
    // even with identical HTML, steps, props and host. Retry it at the pending
    // step and read the new values; the failed frame's callbacks remain inert.
    {
      const slide = sceneSlide('r6-error-values', 4)
      slide.runtime!.props = [{ key: 'label', label: 'Label', kind: 'text', default: 'default' }]
      slide.runtime!.values = { label: 'old' }
      const t = build([slide])
      t.show.enter(0, true)
      const old = t.framesOn(0)[0]
      t.show.follow(0, 2)
      old.fire('error')
      t.show.refresh(0)
      const stayedFailed = t.framesOn(0).length === 0
      slide.runtime!.values = { label: 'corrected' }
      t.show.refresh(0)
      const fresh = t.framesOn(0)[0]
      tick(6_000)
      old.fire('load'); old.fire('error')
      t.say(old, { type: 'bento:ready' }); t.say(old, { type: 'bento:navigate', dir: 'exit' })
      const stillCovered = fresh?.isConnected && fresh.style.visibility === 'hidden'
      if (fresh) t.say(fresh, { type: 'bento:ready' })
      tick(4_001)
      const init = fresh?.contentWindow.posted[0] as { step?: number; props?: Record<string, unknown> } | undefined
      ok(stayedFailed && !!stillCovered && fresh !== old && fresh?.isConnected
        && init?.step === 2 && init?.props?.label === 'corrected'
        && t.moved.length === 0 && t.types(old).length === 0,
        'U13 round6: values-only repair retries an errored scene at the followed step')
      t.show.dispose()
    }
    // Refused source: the current hosted scene moves index while offline and
    // the deck shrinks. Restoring connectivity must use the surviving slide's
    // identity and followed step, without reviving the removed neighbour.
    {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
      const hosted = sceneSlide('r6-offline-move', 4)
      hosted.runtime = { url: 'https://example.com/scene', steps: 4, props: [] }
      const t = build([sceneSlide('r6-removed'), hosted])
      try {
        Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })
        t.show.enter(1, false)
        const refused = t.framesOn(1).length === 0 && t.show.step() === null
        for (let i = 0; i < t.slidesEl.children.length; i++) for (const f of t.framesOn(i)) f.remove()
        t.doc.slides.shift()
        t.slidesEl.children = t.doc.slides.map(t.section)
        t.show.rebuilt(() => 0)
        await new Promise<void>((r) => queueMicrotask(r))
        Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
        t.show.refresh(0)
        const fresh = t.framesOn(0)[0]
        const followed = t.show.follow(0, 2)
        if (fresh) { fresh.fire('load'); t.say(fresh, { type: 'bento:ready' }) }
        tick(10_001)
        ok(refused && followed && t.live().join() === '1' && fresh?.isConnected
          && fresh.src === 'https://example.com/scene' && t.show.step() === 2
          && (fresh.contentWindow.posted[0] as { step?: number } | undefined)?.step === 2,
          'U13 round6: offline scene survives index move and deck shrink before reconnecting')
      } finally {
        t.show.dispose()
        if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor)
        else delete g.navigator
      }
    }
  } else ok(false, 'createRuntimeShow is exported')
  g.window = saved.window; g.document = saved.document; g.CSS = saved.CSS
  ok(made.every((f) => !f.isConnected), `no stand-in frame is left mounted (${made.filter((f) => f.isConnected).length} of ${made.length})`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
