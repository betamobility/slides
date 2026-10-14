// The scene gallery (2026-10-13-2236 plan, U11): what in a library manifest
// is trusted, and what an insert writes into a deck.
//
//   node scripts/test-beta-gallery.ts
//
// The manifest is the real one, built from beta/library by the same code the
// upload uses. The browser half (the dialog's states, the button at 320px) is
// scripts/test-beta-gallery-browser.mjs.

import './lib/no-document.ts' // before anything that reaches i18n
import { buildManifest } from './lib/beta-library.mjs'
import type { BentoDoc, EmbedElement, Slide } from '../slides/src/model.ts'
import { checkRuntime, runtimeSource } from '../slides/src/runtime.ts'
import { sanitizeElement, sanitizeSlide } from '../slides/src/untrusted.ts'
import { Store } from '../slides/src/store.ts'
import { SyncState } from '../slides/src/sync/crdt.ts'
import * as g from '../slides/src/beta/gallery.ts'
import { presetsFor, webSceneOf } from '../slides/src/beta/scenesettings.ts'

let checks = 0
let failures = 0
function ok(cond: unknown, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

// from the repo root, as CI runs it (the rig is bundled to a temp dir, so not import.meta.url)
const manifest = buildManifest(process.env.BETA_LIBRARY_DIR ?? 'beta/library')
const deck = (): BentoDoc => clone({
  format: 'bento/slides', version: 1, title: 't', size: { width: 1280, height: 720 },
  theme: {}, slides: [
    { id: 'a', background: '#FFFFFF', transition: 'fade', notes: '', elements: [] },
    { id: 'a-state', stateOf: 'a', background: '#FFFFFF', transition: 'fade', notes: '', elements: [] },
    { id: 'b', background: '#FFFFFF', transition: 'fade', notes: '', elements: [] },
  ],
} as unknown as BentoDoc)
const web = (over: Record<string, unknown> = {}) => ({
  id: 'harbour', version: 2, name: 'Harbour', description: 'A page on a Beta host', kind: 'web', steps: 0,
  props: [{ key: 'mode', label: 'Mode', kind: 'text', default: 'wide', format: 'select:wide|near' }],
  presets: [{ name: 'Near', values: { mode: 'near' } }],
  url: 'https://slides.betamobility.ai/scenes/harbour/?theme=light#top',
  view: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9"/></svg>',
  ...over,
})
const withScenes = (...scenes: unknown[]) => ({ format: 'beta/library', v: 1, scenes })

console.log('\nwhat in a manifest is trusted')
{
  const scenes = g.readManifest(clone(manifest))!
  ok(scenes && scenes.map((s) => s.id).join() === 'counter,map', 'the real manifest reads: counter and map')
  ok(scenes.every((s) => s.kind === 'runtime' && s.html && s.still.startsWith('<svg')), 'both are runtime scenes with a page and a still')
  ok(presetsFor({ id: 'map' })?.map((p) => p.name).join() === 'Oslo,Copenhagen,Stockholm', 'reading it remembers the presets for the settings panel (U10)')
  for (const [bad, why] of [[null, 'null'], [{ format: 'beta/library', v: 2, scenes: [] }, 'another version'],
    [{ format: 'other', v: 1, scenes: [] }, 'another format'], [{ format: 'beta/library', v: 1, scenes: {} }, 'scenes not a list']] as const) {
    ok(g.readManifest(bad) === null, `not a library manifest: ${why}`)
  }
  ok(g.readManifest(withScenes())!.length === 0, 'an empty library reads as no scenes')

  const real = clone(manifest).scenes[0]
  const cases: Array<[string, Record<string, unknown>]> = [
    ['an id outside the folder rule', { ...real, id: 'Counter' }],
    ['a version that is not a whole number', { ...real, version: 1.5 }],
    ['a name with a line break', { ...real, name: 'Count\ner' }],
    ['a name with a direction override', { ...real, name: 'Count‮er' }],
    ['an unknown kind', { ...real, kind: 'video' }],
    ['a setting whose default is not of its kind', { ...real, props: [{ key: 'to', label: 'To', kind: 'number', default: 'many' }] }],
    ['a setting with a bad key', { ...real, props: [{ key: '__proto__', label: 'P', kind: 'text', default: '' }] }],
    ['no presets list', { ...real, presets: undefined }],
    ['two presets of one name', { ...real, presets: [{ name: 'A', values: {} }, { name: 'A', values: {} }] }],
    ['a still that is not svg', { ...real, still: '<img src=x onerror=alert(1)>' }],
    ['a page over the inline budget', { ...real, html: 'x'.repeat(256 * 1024 + 1) }],
    ['a runtime scene with no page', { ...real, html: undefined }],
  ]
  for (const [why, scene] of cases) {
    const read = g.readManifest(withScenes(scene, real))!
    ok(read.length === 1 && read[0].id === real.id && read[0] !== undefined && read.every((s) => s.name === real.name), `left off the shelf, the rest kept: ${why}`)
  }
  ok(g.readManifest(withScenes(real, { ...real, name: 'Second' }))!.map((s) => s.name).join() === real.name, 'a repeated id: the first is kept')
  ok(g.readManifest(withScenes(web({ url: 'http://slides.betamobility.ai/x' })))!.length === 0, 'a web scene on http is left off')
  ok(g.readManifest(withScenes(web({ url: 'javascript:alert(1)' })))!.length === 0, 'a web scene that is not a web address is left off')
  ok(g.readManifest(withScenes(web()))![0].url === web().url, 'a web scene on https reads, with its url')
}

console.log('\na runtime scene becomes a new slide')
{
  const scenes = g.readManifest(clone(manifest))!
  const map = scenes.find((s) => s.id === 'map')!
  const doc = deck()
  const copenhagen = map.presets.find((p) => p.name === 'Copenhagen')!
  const slide = g.runtimeSlide(doc, map, copenhagen)!
  const rt = slide.runtime!
  ok(rt.library?.id === 'map' && rt.library.version === map.version, 'it carries the library marker (id and version)')
  ok(rt.values?.position === '55.6761, 12.5683' && rt.values.place === 'Copenhagen' && rt.values.zoom === 5, "its values are the preset's, every other setting its default")
  ok(Object.keys(rt.values ?? {}).sort().join() === map.props.map((p) => p.key).sort().join(), 'values for every declared setting, and nothing else')
  ok(rt.props?.length === map.props.length && rt.props.find((p) => p.key === 'zoom')?.format === 'range:2:9:1', 'the settings are copied with their format hints')
  ok(rt.steps === map.steps, 'its steps are the scene\'s')
  const still = slide.elements[0]
  ok(slide.elements.length === 1 && still.type === 'image' && still.x === 0 && still.y === 0 && still.w === 1280 && still.h === 720 && (still as { src: string }).src === rt.still,
    'one element: the still, full-bleed, pointing at the runtime still')
  ok(runtimeSource(slide, doc)?.html === map.html, 'the scene HTML is inlined and decodes back byte for byte (UTF-8, base64)')
  ok(typeof doc.assets?.[rt.still!.slice(6)] === 'string' && doc.assets![rt.still!.slice(6)].startsWith('data:image/svg+xml;base64,'), 'the still is an interned svg data URI')
  const reread = sanitizeSlide(clone(slide))
  ok(reread && checkRuntime(clone(reread.runtime), doc.assets) && JSON.stringify(reread.runtime) === JSON.stringify(slide.runtime), 'the untrusted gate keeps the slide as written (a reload drops nothing)')
  const again = g.runtimeSlide(doc, map, copenhagen)!
  ok(again.runtime!.src === rt.src && Object.keys(doc.assets!).length === 2, 'inserting the same scene twice reuses its two assets')
  const noPreset = g.runtimeSlide(deck(), map)!
  ok(noPreset.runtime!.values!.place === 'Oslo', 'with no preset the defaults are used')
  // past the inline budget the gate drops the page: refused, not written without it
  const bad = { ...map, html: 'x'.repeat(256 * 1024 + 1) }
  const before = deck()
  ok(g.runtimeSlide(before, bad) === null && !before.assets, 'a record the gate would not keep is refused, and nothing is interned')
}

console.log('\na web scene becomes an embed on the current slide')
{
  const scene = g.readManifest(withScenes(web()))![0]
  const doc = deck()
  const r = g.webEmbed(doc, scene, scene.presets[0])
  const el = 'element' in r ? r.element : null
  ok(el && el.type === 'embed' && el.app === 'web' && el.live === true, 'an embed, app web, live')
  ok(el && el.view === scene.still, "its view is the library's still")
  const u = el ? new URL(el.url!) : null
  ok(u && u.origin === 'https://slides.betamobility.ai' && u.pathname === '/scenes/harbour/' && u.hash === '#top' && u.searchParams.get('theme') === 'light' && u.searchParams.get('mode') === 'near',
    "its address is the scene's, with the preset's value in the query and everything else kept")
  const sc = el ? webSceneOf(el.doc) : null
  ok(sc && sc.library.id === 'harbour' && sc.library.version === 2 && sc.props.length === 1, 'its doc carries the library marker and the settings')
  ok(el && el.w === 800 && el.h === 450 && el.x === 240 && el.y === 135, 'centred at 800 by 450 on a 1280 by 720 slide')
  ok(el && JSON.stringify(sanitizeElement(clone(el))) === JSON.stringify(el), 'the untrusted gate keeps the element as written')
  // an address that fits on its own (2045 characters) and not with the preset's &mode=near
  const head = 'https://slides.betamobility.ai/?p='
  const long = g.readManifest(withScenes(web({ url: head + 'x'.repeat(2045 - head.length) })))![0]
  ok(long && 'error' in g.webEmbed(doc, long, { name: 'n', values: { mode: 'near' } }), 'an address the preset would push past the limit is refused, not written')
}

console.log('\ninserting into the editor\'s deck')
{
  const scenes = g.readManifest(clone(manifest))!
  const map = scenes.find((s) => s.id === 'map')!
  const store = new Store(deck())
  store.goTo(0)
  const before = JSON.stringify(store.doc)
  ok(g.insertScene(store, map, map.presets[1]) === null, 'a runtime scene inserts')
  ok(store.doc.slides.map((s) => s.id).slice(0, 2).join() === 'a,a-state' && store.doc.slides[2].runtime?.library?.id === 'map' && store.doc.slides[3].id === 'b',
    'after the current slide and its states')
  ok(store.currentIndex === 2, 'the new slide is shown')
  store.undo()
  ok(JSON.stringify(store.doc) === before, 'one undo takes it all back, assets included')

  store.goTo(2)
  const sceneWeb = g.readManifest(withScenes(web()))![0]
  ok(g.insertScene(store, sceneWeb, sceneWeb.presets[0]) === null && store.slide.elements.length === 1 && store.selection[0] === store.slide.elements[0].id,
    'a web scene inserts on the current slide and is selected')

  g.insertScene(store, map)
  const onRuntime = JSON.stringify(store.doc)
  ok(g.insertScene(store, sceneWeb) === 'Live scene slides cannot hold other elements' && JSON.stringify(store.doc) === onRuntime,
    'a web scene is refused on a live scene slide, and nothing changes')

  const ro = new Store(deck())
  ro.readOnly = true
  const roBefore = JSON.stringify(ro.doc)
  ok(typeof g.insertScene(ro, map) === 'string' && JSON.stringify(ro.doc) === roBefore && ro.currentIndex === 0, 'a read-only copy refuses, and does not move')

  const empty = new Store(deck())
  const broken = { ...map, html: undefined }
  const emptyBefore = JSON.stringify(empty.doc)
  ok(typeof g.insertScene(empty, broken as typeof map) === 'string' && JSON.stringify(empty.doc) === emptyBefore, 'a scene that cannot be written is refused with no undo step')
}

console.log('\nAE5: a collaborator receives the inserted slide')
{
  const scenes = g.readManifest(clone(manifest))!
  const map = scenes.find((s) => s.id === 'map')!
  const base = deck()
  const a = new SyncState('A'), b = new SyncState('B')
  const docA = clone(base), docB = clone(base)
  a.adopt(docA); b.adopt(docB)
  const shadow = clone(docA)
  const slide = g.runtimeSlide(docA, map, map.presets[1])!
  docA.slides.splice(1, 0, slide)
  const ops = a.diff(shadow, docA, { text: true })
  b.apply(docB, ops)
  const got = docB.slides.find((s: Slide) => s.id === slide.id)
  ok(got?.runtime?.library?.id === 'map' && got.runtime.values?.place === 'Copenhagen', "the second copy has the slide, the marker and the preset's values")
  ok(got && runtimeSource(got, docB)?.html === map.html, 'and the scene HTML, so present mode runs it there')
  ok(got && typeof docB.assets?.[(got.elements[0] as { src: string }).src.slice(6)] === 'string', 'and the still, so it paints first')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
