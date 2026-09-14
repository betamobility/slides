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
//      `asset:` refs, and a source above RUNTIME_SRC_BUDGET is refused.
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

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
