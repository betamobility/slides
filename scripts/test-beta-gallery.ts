// The scene gallery (2026-10-13-2236 plan, U11): what in a library manifest
// is trusted, and what an insert writes into a deck.
//
//   node scripts/test-beta-gallery.ts
//
// The manifest is the real one, built from beta/library by the same code the
// upload uses. The browser half (the dialog's states, the button at 320px) is
// scripts/test-beta-gallery-browser.mjs.

import './lib/no-document.ts' // before anything that reaches i18n
import { buildManifest, validateScene, STILL_BUDGET, WEB_HOSTS } from './lib/beta-library.mjs'
import type { BentoDoc, EmbedElement, Slide } from '../slides/src/model.ts'
import { checkRuntime, runtimeSource } from '../slides/src/runtime.ts'
import { sanitizeElement, sanitizeSlide } from '../slides/src/untrusted.ts'
import { Store } from '../slides/src/store.ts'
import { SyncState, BLOB_INLINE_MAX } from '../slides/src/sync/crdt.ts'
import { RESERVED_KEYS, STILL_INLINE_MAX, stillDataUri, stillTooLarge } from '../slides/src/beta/libraryrules.ts'
import * as g from '../slides/src/beta/gallery.ts'
import { presetsFor, webSceneOf } from '../slides/src/beta/scenesettings.ts'
import { fetchLibrary, StoreSignedOutError } from '../slides/src/beta/store.ts'
import { configureApp } from '../kernel/src/app.ts'
import { OfflineError, offlineEnabled, setOffline } from '../kernel/src/net.ts'

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
  const stillAsset = doc.assets?.[rt.still!.slice(6)] ?? ''
  ok(stillAsset.startsWith('data:image/svg+xml,') && decodeURIComponent(stillAsset.slice(19)) === map.still, 'the still is an interned svg data URI that decodes back to the library still')
  const base64Length = 26 + Math.ceil(new TextEncoder().encode(map.still).length / 3) * 4
  ok(stillAsset.length < base64Length, `percent-encoded, smaller than base64 (${stillAsset.length} for a ${map.still.length}-character still; base64 ${base64Length})`)
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

console.log('\nU11 independent round 1: rejection and transport boundaries')
{
  // Wrong-kind/undeclared preset values must not be silently repaired into a
  // different scene. Exercise the whole reader -> insertion path when admitted.
  const raw = clone(manifest).scenes.find((s) => s.id === 'map')!
  const admitted: string[] = []
  for (const values of [{ zoom: 'many' }, { zom: 5 }]) {
    const scenes = g.readManifest(withScenes({ ...raw, presets: [{ name: 'Broken', values }] }))!
    if (scenes.length) {
      const store = new Store(deck())
      const refusal = g.insertScene(store, scenes[0], scenes[0].presets[0])
      admitted.push(JSON.stringify({ values, refusal, inserted: store.slide.runtime?.values }))
    }
  }
  ok(admitted.length === 0,
    `R1 runtime preset rejects wrong kinds and undeclared keys instead of substituting defaults: ${admitted.join('; ')}`)
}
{
  // A card's <img> containment is not manifest validation: these SVGs cannot
  // be trusted as the library's portable picture (and embed views are inline SVG).
  const raw = clone(manifest).scenes[0]
  const badStills = [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="16" height="9"><div xmlns="http://www.w3.org/1999/xhtml">Only artwork</div></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.invalid/still.svg#art"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>',
  ]
  const accepted = badStills.flatMap((still, i) =>
    (['runtime', 'web'] as const).flatMap((kind) => {
      const input = kind === 'runtime' ? { ...raw, still } : web({ view: still })
      return g.readManifest(withScenes(input))!.length ? [`${kind}:${i}`] : []
    }))
  ok(accepted.length === 0, `R1 rejects active, external and malformed stills before shelving: ${accepted.join(', ')}`)
}
{
  const urls = [
    'https://example.invalid/scene/',
    'https://slides.betamobility.ai.example.invalid/scene/',
    'https://user:secret@slides.betamobility.ai/scene/',
    'https://slides.betamobility.ai:8443/scene/',
  ]
  const admitted = urls.filter((url) => g.readManifest(withScenes(web({ url })))!.length)
  ok(admitted.length === 0,
    `R1 web scene rejects foreign hosts, credentials and ports (allowed ${WEB_HOSTS.join(', ')}): ${admitted.join(', ')}`)
}
{
  // A genuinely build-valid 50 KiB still: below the library's 64 KiB limit,
  // but its base64 data URI crosses the sync engine's inline threshold.
  // The assertion is on the receiving document, not merely on a source ref.
  const raw = clone(manifest).scenes.find((s) => s.id === 'map')!
  const { id, html, still: _still, stillType: _type, ...metadata } = raw
  const prefix = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9" fill="#123456"/><!--'
  const suffix = '--></svg>'
  const still = prefix + 'x'.repeat(50 * 1024 - prefix.length - suffix.length) + suffix
  const validated = validateScene(id, { 'scene.json': JSON.stringify(metadata), 'index.html': html, 'still.svg': still })
  const scene = g.readManifest(withScenes(validated))![0]
  const store = new Store(deck()), remote = deck()
  const a = new SyncState('round1-A'), b = new SyncState('round1-B')
  a.adopt(store.doc); b.adopt(remote)
  const before = clone(store.doc)
  const refusal = g.insertScene(store, scene, scene.presets[1])
  b.apply(remote, a.diff(before, store.doc, { text: true }))
  const received = remote.slides.find((s) => s.id === store.slide.id)
  const key = store.slide.runtime!.still!.slice(6)
  const encodedLength = store.doc.assets![key].length
  ok(refusal === null && still.length < STILL_BUDGET && received?.runtime?.library?.id === 'map'
    && remote.assets?.[key] === store.doc.assets![key],
    `R1 AE5 build-valid 50 KiB still arrives with inserted slide: raw=${still.length}, encoded=${encodedLength}, inlineMax=${BLOB_INLINE_MAX}, receiverHasStill=${!!remote.assets?.[key]}`)
}
{
  const scene = g.readManifest(clone(manifest))!.find((s) => s.id === 'map')!
  const store = new Store(deck())
  store.goTo(1) // a state slide, rather than its parent
  const before = JSON.stringify(store.doc)
  g.insertScene(store, scene)
  const first = store.slide.id
  g.insertScene(store, scene)
  const second = store.slide.id
  const inserted = JSON.stringify(store.doc)
  const order = store.doc.slides.map((s) => s.id)
  store.undo(); store.undo()
  const restored = JSON.stringify(store.doc) === before && store.slide.id === 'a-state'
  store.redo(); store.redo()
  ok(restored && JSON.stringify(store.doc) === inserted && store.slide.id === second
    && order.join() === ['a', 'a-state', first, second, 'b'].join() && first !== second,
    'R1 state-slide insertion twice preserves order, identities and assets through undo/redo')
}


console.log('\nU11 independent round 2: encoding and no-repair contract')
{
  // This is not the round-one ASCII padding case. Real SVG whitespace and
  // UTF-8 labels expand under percent encoding too; raw byte size is not a
  // bound on the asset sent in an insertion op.
  const raw = clone(manifest).scenes.find((s) => s.id === 'map')!
  const { id, html, still: _still, stillType: _type, ...metadata } = raw
  const prefix = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9" fill="#123456"/><desc>'
  const suffix = '</desc></svg>'
  const missing: string[] = []
  for (const [name, content] of [['UTF-8 description', '地'.repeat(9000)], ['pretty-print whitespace', '\n'.repeat(24000)]] as const) {
    const still = prefix + content + suffix
    const validated = validateScene(id, { 'scene.json': JSON.stringify(metadata), 'index.html': html, 'still.svg': still })
    const scene = g.readManifest(withScenes(validated))![0]
    const store = new Store(deck()), remote = deck()
    const a = new SyncState('round2-A'), b = new SyncState('round2-B')
    a.adopt(store.doc); b.adopt(remote)
    const before = clone(store.doc)
    const refusal = g.insertScene(store, scene, scene.presets[0])
    b.apply(remote, a.diff(before, store.doc, { text: true }))
    const received = remote.slides.find((s) => s.id === store.slide.id)
    const key = store.slide.runtime!.still!.slice(6)
    if (refusal !== null || !received || remote.assets?.[key] !== store.doc.assets![key]) {
      missing.push(`${name}: rawBytes=${new TextEncoder().encode(still).length}, uriChars=${store.doc.assets![key].length}, receiverHasStill=${!!remote.assets?.[key]}`)
    }
  }
  ok(missing.length === 0, `R2 AE5 percent-expanded still arrives in the insertion op: ${missing.join('; ')}`)
}
{
  // readManifest compares only label/default to webSceneOf; runtimeSlide's
  // checkRuntime has stricter label/format rules and silently changes them.
  const raw = clone(manifest).scenes[0]
  const admitted: string[] = []
  for (const prop of [
    { key: 'n', label: 'N'.repeat(201), kind: 'number', default: 1 },
    { key: 'n', label: 'N', kind: 'number', default: 1, format: 'range:0:10:1\n' },
  ]) {
    const scene = g.readManifest(withScenes({ ...raw, props: [prop], presets: [{ name: 'Default', values: {} }] }))![0]
    if (scene) {
      const store = new Store(deck())
      const refusal = g.insertScene(store, scene, scene.presets[0])
      admitted.push(JSON.stringify({ input: prop, refusal, written: store.slide.runtime?.props }))
    }
  }
  ok(admitted.length === 0, `R2 runtime settings that would be repaired are left off the shelf: ${admitted.join('; ')}`)
}
{
  // null is an explicitly wrong value shape, not an absent optional field.
  // It must not become a valid default preset on the web insertion path.
  const scenes = g.readManifest(withScenes(web({ presets: [{ name: 'Broken', values: null }] })))!
  const scene = scenes[0]
  const result = scene ? g.webEmbed(deck(), scene, scene.presets[0]) : null
  ok(scenes.length === 0, `R2 web preset with null values is refused, not repaired: ${JSON.stringify(result)}`)
}
{
  // Scanner/preset controls: the new rules must still reject obfuscated
  // external refs and wrong-kind empty values, not only the round-one strings.
  const bad = [
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="&#104;ttps://evil.invalid/x#p"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(&#104;ttps://evil.invalid/x)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="u&#92;72l(//evil.invalid/x)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns="http://www.w3.org/1999/xhtml"><text>Hi</text></g></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><text>\ud800</text></svg>',
  ]
  const admitted = bad.filter((view) => g.readManifest(withScenes(web({ view })))!.length)
  for (const value of [null, false, {}, []]) {
    if (g.readManifest(withScenes(web({ props: [{ key: 'mode', label: 'Mode', kind: 'text', default: '' }], presets: [{ name: 'Broken', values: { mode: value } }] })))!.length) admitted.push(JSON.stringify(value))
  }
  ok(admitted.length === 0, `R2 obfuscated SVG references and wrong-kind empty preset values stay rejected: ${admitted.join('; ')}`)
}

console.log('\nthe inline rule (libraryrules.ts): a still travels with its slide')
{
  ok(STILL_INLINE_MAX === BLOB_INLINE_MAX, `the library limit is the sync engine one (${STILL_INLINE_MAX} = ${BLOB_INLINE_MAX})`)
  const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><text>${body}</text></svg>`
  for (const [why, body] of [['ASCII', 'x'.repeat(60000)], ['CJK', '地'.repeat(9000)], ['newlines', '\n'.repeat(30000)], ['mixed', 'Ø#%地\n'.repeat(4000)]] as const) {
    const s = svg(body)
    const uri = stillDataUri(s)
    const decoded = uri.startsWith('data:image/svg+xml;base64,') ? new TextDecoder().decode(Uint8Array.from(atob(uri.slice(26)), (c) => c.charCodeAt(0))) : decodeURIComponent(uri.slice(19))
    ok(decoded === s, `${why}: the encoding decodes back to the still`)
    ok((uri.length <= STILL_INLINE_MAX) === (stillTooLarge(s) === null), `${why}: refused exactly when it would not travel inline (${uri.length})`)
  }
  const big = svg('地'.repeat(30000))
  ok(stillTooLarge(big) !== null && g.readManifest(withScenes({ ...clone(manifest).scenes[0], still: big }))!.length === 0, 'a still that cannot travel inline is left off the shelf')
}

console.log('\nfuzz: whatever the shelf admits, an insert writes as read')
{
  // Mutate the real scenes (and a web scene) at random; for every scene the
  // reader admits, both inserts must succeed, survive the gate unchanged and
  // keep the still inline. GALLERY_FUZZ_N sets the count.
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]
  const values: unknown[] = [null, undefined, 0, -1, 1.5, 1e308, Number.NaN, '', ' ', 'x'.repeat(250), '<b>', '\n', '地', true, [], {}, { a: 1 }, '__proto__', '#ff0000', 'red', '59.9, 10.7', 'wide', 'near', 'constructor', 'prototype', '\ud800x']
  const fields = ['id', 'version', 'name', 'description', 'kind', 'steps', 'props', 'presets', 'still', 'view', 'html', 'url']
  const propFields = ['key', 'label', 'kind', 'default', 'format']
  const bases = [...clone(manifest).scenes, web()]
  // key order is the gate's business, not a difference: compare canonically
  const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x)
  let admitted = 0, bad = 0
  const N = Number(process.env.GALLERY_FUZZ_N ?? 3000)
  for (let i = 0; i < N; i++) {
    const scene = clone(pick(bases)) as Record<string, unknown>
    for (let m = 0, n = 1 + Math.floor(rnd() * 3); m < n; m++) {
      const r = rnd()
      if (r < 0.1 && Array.isArray(scene.props) && scene.props.length) {
        // a consistent rename: the presets follow, so the scene stays well-formed apart from the new name
        const pr = pick(scene.props as Record<string, unknown>[]), from = pr.key as string, to = pick(['constructor', 'prototype', '__proto__', 'fresh', '地', 'a b'])
        pr.key = to
        for (const ps of (Array.isArray(scene.presets) ? scene.presets as Array<{ values?: Record<string, unknown> }> : [])) if (ps && ps.values && typeof ps.values === "object" && from in ps.values) { ps.values[to] = ps.values[from]; delete ps.values[from] }
      } else if (r < 0.3) scene[pick(fields)] = pick(values)
      else if (r < 0.6 && Array.isArray(scene.props) && scene.props.length) (pick(scene.props as Record<string, unknown>[]))[pick(propFields)] = pick(values)
      else if (r < 0.85 && Array.isArray(scene.presets) && scene.presets.length) {
        const pr = pick(scene.presets as Record<string, unknown>[])
        if (rnd() < 0.5) pr.values = pick(values); else pr.values = { ...(pr.values as object ?? {}), [pick(['place', 'zoom', 'mode', 'to', 'zz'])]: pick(values) }
      } else delete scene[pick(fields)]
    }
    const read = g.readManifest(withScenes(scene))
    if (!read || !read.length) continue
    admitted++
    const sc = read[0]
    for (const preset of [undefined, ...sc.presets]) {
      const doc = deck()
      if (sc.kind === 'runtime') {
        // and a collaborator receives it whole, through the sync engine (round 3:
        // a key the engine refuses kept the slide from everyone else)
        const a = new SyncState('fA'), b = new SyncState('fB')
        const remote = deck()
        a.adopt(doc); b.adopt(remote)
        const before = clone(doc)
        const sl = g.runtimeSlide(doc, sc, preset)
        if (sl) { doc.slides.splice(1, 0, sl); b.apply(remote, a.diff(before, doc, { text: true })) }
        const got = sl ? remote.slides.find((x) => x.id === sl.id) : undefined
        const ok1 = !!sl && canon(sanitizeSlide(clone(sl))) === canon(sl) && runtimeSource(sl, doc)?.html === sc.html
          && (doc.assets?.[sl.runtime!.still!.slice(6)] ?? '').length <= STILL_INLINE_MAX
          && !!got && canon(got) === canon(sl) && remote.assets?.[sl.runtime!.still!.slice(6)] === doc.assets?.[sl.runtime!.still!.slice(6)]
        if (!ok1 && bad++ < 5) console.log('    admitted runtime scene did not insert as read:', JSON.stringify(scene).slice(0, 300))
      } else {
        const r = g.webEmbed(doc, sc, preset)
        const ok2 = 'element' in r && canon(sanitizeElement(clone(r.element))) === canon(r.element)
        if (!ok2 && bad++ < 5) console.log('    admitted web scene did not insert as read:', JSON.stringify(scene).slice(0, 300), JSON.stringify(r).slice(0, 200))
      }
    }
  }
  ok(bad === 0 && admitted > 0, `${N} mutated scenes, ${admitted} admitted, ${bad} that did not insert as read`)
}


console.log('\nU11 independent round 3: admission versus actual transport')
{
  // These are permitted prop identifiers in both the build and runtime gate,
  // but values become object keys in the insertion op. Test the receiver,
  // not merely sanitizeSlide(sender), which cannot see the sync refusal.
  const lost: string[] = []
  for (const key of ['constructor', 'prototype']) {
    const raw = clone(manifest).scenes[0]
    const { id, html, still, stillType: _type, ...metadata } = raw
    metadata.props = [{ key, label: 'Setting', kind: 'text', default: 'default' }]
    metadata.presets = [{ name: 'Chosen', values: { [key]: 'chosen' } }]
    // The build now refuses the key (round 3 fix). Refusing is correct, and the
    // gallery must refuse the same scene when a manifest did not come from the
    // build: both are checked, and the transport check below still runs for
    // anything either side would admit.
    let validated: unknown
    try { validated = validateScene(id, { 'scene.json': JSON.stringify(metadata), 'index.html': html, 'still.svg': still }) } catch { validated = null }
    const unbuilt = { id, ...metadata, html, still, stillType: 'image/svg+xml' }
    const scene = g.readManifest(withScenes(validated ?? unbuilt))![0]
    if (!scene) continue // refusing the unsafe scene is also correct
    const store = new Store(deck()), remote = deck()
    const a = new SyncState('r3-A'), b = new SyncState('r3-B')
    a.adopt(store.doc); b.adopt(remote)
    const before = clone(store.doc)
    const refused = g.insertScene(store, scene, scene.presets[0])
    b.apply(remote, a.diff(before, store.doc, { text: true }))
    const received = remote.slides.find((s) => s.id === store.slide.id)
    const rt = received?.runtime
    if (refused || rt?.library?.id !== scene.id || rt?.values?.[key] !== 'chosen'
      || !rt?.still || !remote.assets?.[rt.still.slice(6)]) {
      lost.push(`${key}: refusal=${refused}, received=${JSON.stringify(received)}`)
    }
  }
  ok(lost.length === 0, `R3 AE5 prototype-named settings arrive with runtime and still: ${lost.join('; ')}`)
}
{
  // JSON can carry an unpaired surrogate (e.g. an author's truncated emoji).
  // TextEncoder replaces it; the gallery must reject, not silently repair HTML.
  const html = '<!doctype html><p>\ud800</p><!-- bento:init bento:ready -->'
  const scene = g.readManifest(withScenes({ ...clone(manifest).scenes[0], html }))![0]
  const doc = deck()
  const slide = scene ? g.runtimeSlide(doc, scene, scene.presets[0]) : null
  const decoded = slide ? runtimeSource(slide, doc)?.html : undefined
  ok(!scene || (!!slide && decoded === html),
    `R3 runtime HTML survives UTF-8 insertion without repair: admitted=${!!scene}, decoded=${JSON.stringify(decoded)}`)
}
{
  // URLSearchParams coerces strings to USVString; gate survival alone misses
  // the fact that the web page receives a different preset from the one read.
  const value = '\ud800'
  const scene = g.readManifest(withScenes(web({
    props: [{ key: 'label', label: 'Label', kind: 'text', default: '' }],
    presets: [{ name: 'Chosen', values: { label: value } }],
  })))![0]
  const result = scene ? g.webEmbed(deck(), scene, scene.presets[0]) : null
  const written = result && 'element' in result ? new URL(result.element.url!).searchParams.get('label') : undefined
  ok(!scene || (result && 'element' in result && written === value),
    `R3 web preset survives query encoding without repair: admitted=${!!scene}, written=${JSON.stringify(written)}`)
}
{
  // Attack the shared encoding rule through a real URL consumer (fetch),
  // including percent signs, fragments, XML entities, astral text and both
  // encoding choices. decodeURIComponent alone isn't a transport oracle.
  const problems: string[] = []
  for (const body of ['?x=1&amp;y=2 # 100% + ;base64,', '😀地Ø'.repeat(2000), '\n'.repeat(24000)]) {
    const still = `<svg xmlns="http://www.w3.org/2000/svg"><text>${body}</text></svg>`
    const scene = g.readManifest(withScenes({ ...clone(manifest).scenes[0], still }))![0]
    if (!scene) { problems.push('valid fixture refused'); continue }
    const uri = g.svgDataUri(scene.still)
    const received = await (await fetch(uri)).text()
    if (received !== still || uri.length > STILL_INLINE_MAX) problems.push(`bad transport: ${uri.length}`)
  }
  ok(problems.length === 0, `R3 shared still encoder survives data-URL fetch: ${problems.join('; ')}`)
}

console.log('\nRESERVED_KEYS is what the sync engine refuses')
{
  // the engine's list is not exported (kernel zone): prove each name is dropped
  for (const k of RESERVED_KEYS) {
    const a = new SyncState('A'), b = new SyncState('B')
    const docA = deck(), docB = deck()
    a.adopt(docA); b.adopt(docB)
    const shadow = clone(docA)
    docA.slides[0].runtime = { src: 'asset:s', still: 'asset:t', steps: 0, props: [], values: JSON.parse(`{"${k}":"x"}`) } as never
    b.apply(docB, a.diff(shadow, docA, { text: true }))
    ok(!docB.slides[0].runtime, `a setting named ${k} does not reach a collaborator, so the library refuses it`)
  }
  ok(!['place', 'zoom', 'label'].some((k) => RESERVED_KEYS.includes(k)), 'ordinary setting names are not reserved')
}


console.log('\nU11 independent round 4: insertion boundaries and receiver state')
{
  // Test the raw HTML limit through the actual builder, reader and insert.
  // Base64 padding must not turn an at-limit page into an oversized one.
  const raw = clone(manifest).scenes[0]
  const { id, html: _html, still, stillType: _type, ...metadata } = raw
  const head = '<!doctype html><!-- bento:init bento:ready -->'
  const lost: string[] = []
  // The fix keeps the shell's gate as every shipped shell has it (it counts
  // base64 padding, R18) and makes the library measure pages the same way
  // (libraryrules.ts pageTooLarge). So 262144 bytes is refused at the build,
  // naming the file, and never reaches a shelf; below it, pages insert whole.
  for (const length of [262142, 262143]) {
    const html = head + ' '.repeat(length - head.length)
    const built = validateScene(id, { 'scene.json': JSON.stringify(metadata), 'index.html': html, 'still.svg': still })
    const scene = g.readManifest(withScenes(built))![0]
    const store = new Store(deck())
    const refusal = scene ? g.insertScene(store, scene, scene.presets[0]) : 'not admitted'
    if (refusal || runtimeSource(store.slide, store.doc)?.html !== html) lost.push(`${length} bytes: ${refusal}`)
  }
  ok(lost.length === 0, `R4 runtime HTML up to the gate's measure inserts without padding inflation: ${lost.join('; ')}`)
  const atCap = head + ' '.repeat(262144 - head.length)
  let buildRefusal = ''
  try { validateScene(id, { 'scene.json': JSON.stringify(metadata), 'index.html': atCap, 'still.svg': still }) } catch (e) { buildRefusal = (e as Error).message }
  ok(buildRefusal.includes('index.html') && g.readManifest(withScenes({ id, ...metadata, html: atCap, still, stillType: 'image/svg+xml' }))!.length === 0,
    `R4 a page the gate would measure past the budget is refused by the build naming the file, and left off the shelf (${buildRefusal})`)
}
{
  // The existing fuzz checks web inserts against the shape gate, but never
  // sends them to a second copy. Include prototype-like (nonreserved) names,
  // XML entities, query delimiters, Unicode, and unrelated duplicate params.
  const value = 'Oslo & København + 東京 😀 #?%=/'
  const props = ['toString', 'hasOwnProperty', '_mode'].map((key) => ({ key, label: key, kind: 'text', default: '' }))
  const scene = g.readManifest(withScenes(web({
    props, presets: [{ name: 'Chosen', values: Object.fromEntries(props.map((p) => [p.key, value])) }],
    url: 'https://design.betamobility.ai/scene?untouched=one&untouched=two#view',
  })))![0]
  const store = new Store(deck()), remote = deck()
  const a = new SyncState('r4-web-A'), b = new SyncState('r4-web-B')
  a.adopt(store.doc); b.adopt(remote)
  const before = clone(store.doc)
  const refusal = scene ? g.insertScene(store, scene, scene.presets[0]) : 'not admitted'
  b.apply(remote, a.diff(before, store.doc, { text: true }))
  const got = remote.slides[0].elements[0] as EmbedElement | undefined
  const query = got?.url ? new URL(got.url).searchParams : null
  ok(refusal === null && got?.app === 'web' && got.live === true && got.view === scene.still
    && JSON.stringify(got.doc) === JSON.stringify({ library: { id: scene.id, version: scene.version }, props: scene.props })
    && props.every((p) => query?.get(p.key) === value) && query?.getAll('untouched').join() === 'one,two',
    'R4 web insert transports the still, schema and exact Unicode preset to a collaborator')
}
{
  // AE5 after history operations: reused assets are no longer new in the
  // diff. A reinsert must still resolve its still on the receiving document.
  const scene = g.readManifest(clone(manifest))!.find((s) => s.id === 'map')!
  const store = new Store(deck()), remote = deck()
  store.goTo(store.doc.slides.length - 1)
  const a = new SyncState('r4-history-A'), b = new SyncState('r4-history-B')
  a.adopt(store.doc); b.adopt(remote)
  const problems: string[] = []
  const edit = (name: string, count: number, fn: () => void) => {
    const before = clone(store.doc)
    fn()
    if (store.doc.slides.filter((s) => s.runtime).length !== count) problems.push(`${name}: count`)
    b.apply(remote, a.diff(before, store.doc, { text: true }))
    for (const slide of store.doc.slides.filter((s) => s.runtime)) {
      const got = remote.slides.find((s) => s.id === slide.id)
      const key = slide.runtime!.still!.slice(6)
      if (!got || JSON.stringify(got.runtime) !== JSON.stringify(slide.runtime)
        || store.doc.assets?.[key] !== g.svgDataUri(scene.still)
        || remote.assets?.[key] !== g.svgDataUri(scene.still)
        || (got.elements[0] as { src?: string })?.src !== got.runtime?.still) problems.push(name)
    }
    if (remote.slides.map((s) => s.id).join() !== store.doc.slides.map((s) => s.id).join()) problems.push(`${name}: order`)
  }
  edit('insert at end', 1, () => { g.insertScene(store, scene, scene.presets[0]) })
  edit('insert again', 2, () => { g.insertScene(store, scene, scene.presets[1]) })
  edit('undo second', 1, () => store.undo())
  edit('undo first', 0, () => store.undo())
  edit('redo first', 1, () => store.redo())
  edit('redo second', 2, () => store.redo())
  ok(problems.length === 0, `R4 AE5 reused stills survive end insertion and undo/redo on the receiver: ${problems.join('; ')}`)
}


{
  // The shared scanner has two callers: neither may admit XML mechanisms
  // that cause a picture to resolve resources outside itself.
  const raw = clone(manifest).scenes[0]
  const { id, html, still: _still, stillType: _type, ...metadata } = raw
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="16" height="9"/></svg>'
  const attacks = [
    '<?xml-stylesheet type="text/css" href="https://evil.invalid/style.css"?>' + svg,
    '<!DOCTYPE svg [<!ENTITY picture SYSTEM "https://evil.invalid/data">]>' + svg.replace('/></svg>', '/><text>&picture;</text></svg>'),
    svg.replace('<rect ', '<rect fill="url(&#x2f;&#x2f;evil.invalid/paint.svg#p)" '),
    svg.replace('<rect width="16" height="9"/>', '<use href="&#35;local&#xA;https://evil.invalid/p.svg"/>'),
  ]
  const admitted: string[] = []
  for (const [i, still] of attacks.entries()) {
    try {
      validateScene(id, { 'scene.json': JSON.stringify(metadata), 'index.html': html, 'still.svg': still })
      admitted.push(`build:${i}`)
    } catch { /* a rejected picture is the expected outcome */ }
    if (g.readManifest(withScenes({ ...raw, still }))!.length) admitted.push(`runtime:${i}`)
    if (g.readManifest(withScenes(web({ view: still })))!.length) admitted.push(`web:${i}`)
  }
  ok(admitted.length === 0, `R4 shared scanner rejects XML resource loading on every admission path: ${admitted.join('; ')}`)
}

console.log('\nU11 independent round 5: compound limits and failure isolation')
{
  // The seeded fuzz mutates individual fields; it never combines the maximum
  // number of settings with maximum-length defaults and a near-limit still.
  const raw = clone(manifest).scenes[0]
  const props = Array.from({ length: 64 }, (_, i) => ({ key: `p${i}`, label: `P${i}`, kind: 'text', default: '😀'.repeat(2000) }))
  const still = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9"/><!--' + 'x'.repeat(60000) + '--></svg>'
  const scene = g.readManifest(withScenes({ ...raw, props, presets: [{ name: 'Defaults', values: {} }], still }))![0]
  const store = new Store(deck()), remote = deck()
  store.doc.size = { width: 720, height: 1280 }
  remote.size = clone(store.doc.size)
  const a = new SyncState('r5-max-A'), b = new SyncState('r5-max-B')
  a.adopt(store.doc); b.adopt(remote)
  const before = clone(store.doc)
  const refusal = scene ? g.insertScene(store, scene, scene.presets[0]) : 'not admitted'
  b.apply(remote, a.diff(before, store.doc, { text: true }))
  const got = remote.slides.find((s) => s.id === store.slide.id)
  const image = got?.elements[0] as { src?: string; w?: number; h?: number } | undefined
  ok(refusal === null && got?.runtime?.props?.length === 64
    && props.every((p) => got.runtime?.values?.[p.key] === p.default)
    && image?.w === 720 && image.h === 1280 && image.src === got.runtime?.still
    && remote.assets?.[image.src!.slice(6)] === g.svgDataUri(still),
    'R5 AE5 maximum settings and near-limit still arrive together on a portrait slide')
}
{
  // A valid URL becomes too large only once the chosen preset is encoded.
  // Refusal must preserve an existing redo branch, not just the document.
  const scene = g.readManifest(withScenes(web({
    props: [{ key: 'caption', label: 'Caption', kind: 'text', default: '' }],
    presets: [{ name: 'Long', values: { caption: '地'.repeat(300) } }],
  })))![0]
  const store = new Store(deck())
  const base = JSON.stringify(store.doc)
  store.commit(() => { store.doc.title = 'redo sentinel' })
  store.undo()
  const index = store.currentIndex, selection = JSON.stringify(store.selection)
  const refusal = scene ? g.insertScene(store, scene, scene.presets[0]) : 'not admitted'
  const untouched = JSON.stringify(store.doc) === base && store.currentIndex === index && JSON.stringify(store.selection) === selection
  store.redo()
  ok(refusal === 'This makes the page address too long' && untouched && store.doc.title === 'redo sentinel',
    'R5 oversized web preset refuses atomically and preserves redo history')
}
{
  // Hostile JSON, not JS prototype assignment; unknown deep fields must not
  // throw, poison subsequent scenes, or bypass the per-scene refusal.
  const real = clone(manifest).scenes[0]
  let nested: unknown = 'leaf'
  for (let i = 0; i < 100; i++) nested = { child: nested }
  const attacks = [
    { ...real, extra: nested },
    { ...real, presets: [{ name: 'Injected', values: JSON.parse('{"__proto__":{"polluted":true}}') }] },
    { ...real, still: '<svg xmlns="http://www.w3.org/2000/svg"><use href="&#x23;local" onload="alert(1)"/></svg>' },
    web({ view: '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns=""><rect width="16" height="9"/></g></svg>' }),
  ]
  const problems: string[] = []
  for (const [i, bad] of attacks.entries()) {
    try {
      const read = g.readManifest(withScenes({ ...bad, id: `r5-bad-${i}` }, real))
      if (read?.length !== 1 || read[0].id !== real.id || read[0].still !== real.still || read[0].presets[0].name !== real.presets[0].name) problems.push(`${i}: bad shelf`)
    } catch (e) { problems.push(`${i}: threw ${String(e)}`) }
  }
  ok(problems.length === 0 && !Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'),
    `R5 malformed runtime and web scenes are isolated from a valid neighbour: ${problems.join('; ')}`)
}
{
  // The actual fetchLibrary wrapper, with only the network boundary mocked.
  // A 200 Access HTML response must not become a JSON parse error; a manual
  // redirect must retain the signed-out classification; offline sends nothing.
  configureApp({ appId: 'beta-slides', appName: 'bento/slides', manifestUrl: 'https://slides.betamobility.ai/releases/manifest.json', storeHost: 'https://slides.betamobility.ai' })
  const originalFetch = globalThis.fetch, originalOffline = offlineEnabled()
  let hits = 0
  const requests: Array<{ url: string; credentials?: string; redirect?: string }> = []
  let response: Response = new Response('<!doctype html><title>Access login</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
  const results: string[] = []
  try {
    setOffline(false)
    globalThis.fetch = (async (input, init) => {
      hits++
      requests.push({ url: String(input), credentials: init?.credentials, redirect: init?.redirect })
      return response
    }) as typeof fetch
    for (const mode of ['html', 'redirect']) {
      if (mode === 'redirect') response = { type: 'opaqueredirect', status: 0, headers: new Headers() } as Response
      try { await fetchLibrary(); results.push(`${mode}: accepted`) } catch (e) { if (!(e instanceof StoreSignedOutError)) results.push(`${mode}: ${String(e)}`) }
    }
    setOffline(true)
    try { await fetchLibrary(); results.push('offline: accepted') } catch (e) { if (!(e instanceof OfflineError)) results.push(`offline: ${String(e)}`) }
    ok(results.length === 0 && hits === 2 && requests.every((r) => r.url === 'https://slides.betamobility.ai/library/library.json' && r.credentials === 'same-origin' && r.redirect === 'manual'),
      `R5 HTML login and redirect are signed-out; offline makes no request: ${results.join('; ')}, hits=${hits}`)
  } finally {
    globalThis.fetch = originalFetch
    setOffline(originalOffline)
  }
}


console.log('\nU11 independent round 6: refusal and transport boundaries')
{
  // A scene was read while writable, but permission was lost before Insert.
  // Refusal must preserve redo, assets, selection and the current state slide.
  const scenes = [g.readManifest(clone(manifest))![0], g.readManifest(withScenes(web()))![0]]
  const problems: string[] = []
  for (const scene of scenes) {
    const store = new Store(deck())
    store.goTo(1)
    store.commit(() => { store.doc.title = 'pending redo' })
    store.undo()
    const before = JSON.stringify({ doc: store.doc, index: store.currentIndex, selection: store.selection })
    store.readOnly = true
    const refusal = g.insertScene(store, scene, scene.presets[0])
    if (!refusal || JSON.stringify({ doc: store.doc, index: store.currentIndex, selection: store.selection }) !== before) problems.push(`${scene.kind}: mutated`)
    store.readOnly = false
    store.redo()
    if (store.doc.title !== 'pending redo') problems.push(`${scene.kind}: lost redo`)
  }
  ok(problems.length === 0, `R6 permission lost after selection refuses both insert kinds without consuming redo: ${problems.join('; ')}`)
}
{
  // Query metacharacters are data, even when a value resembles an address
  // with credentials. Duplicate encoded keys must become one preset value;
  // omitted settings use defaults, and unrelated duplicates stay untouched.
  const value = 'https://user:secret@evil.invalid/?x=1&mode=wrong#frag + %26 😀'
  const scene = g.readManifest(withScenes(web({
    props: [
      { key: 'mode', label: 'Mode', kind: 'text', default: 'default' },
      { key: 'caption', label: 'Caption', kind: 'text', default: '標準 & default' },
    ],
    presets: [{ name: 'Hostile-looking text', values: { mode: value } }],
    url: 'https://design.betamobility.ai/a%2Fb?%6dode=old&mode=older&keep=1&keep=2#original',
  })))![0]
  const store = new Store(deck())
  const refusal = scene ? g.insertScene(store, scene, scene.presets[0]) : 'not admitted'
  const element = store.slide.elements[0] as EmbedElement | undefined
  const u = element?.url ? new URL(element.url) : null
  ok(refusal === null && element?.app === 'web' && element.live === true && element.view === scene.still
    && webSceneOf(element.doc)?.library.id === scene.id
    && u?.origin === 'https://design.betamobility.ai' && u.pathname === '/a%2Fb' && u.hash === '#original'
    && u.searchParams.getAll('mode').length === 1 && u.searchParams.get('mode') === value
    && u.searchParams.get('caption') === '標準 & default' && u.searchParams.getAll('keep').join() === '1,2',
    'R6 web preset delimiters cannot replace the host or leak into sibling query keys')
}
{
  // A deck can already have assets named scene/still: they are not the dry
  // run's scratch assets. Exercise both reuse and collision, and a hidden
  // parent with a current state, through the receiver's actual CRDT.
  const scene = g.readManifest(clone(manifest))!.find((s) => s.id === 'map')!
  const doc = deck()
  doc.slides[0].hidden = true
  doc.assets = { scene: 'data:text/html,unrelated', still: 'data:image/svg+xml,unrelated', reusable: g.svgDataUri(scene.still) }
  const store = new Store(doc), remote = clone(doc)
  store.goTo(1)
  const a = new SyncState('r6-A'), b = new SyncState('r6-B')
  a.adopt(store.doc); b.adopt(remote)
  const before = clone(store.doc)
  const refusal = g.insertScene(store, scene, scene.presets[1])
  b.apply(remote, a.diff(before, store.doc, { text: true }))
  const inserted = store.slide, got = remote.slides.find((s) => s.id === inserted.id)
  const image = got?.elements[0] as { src?: string } | undefined
  ok(refusal === null && store.currentIndex === 2 && !got?.stateOf && !got?.hidden
    && got?.runtime?.library?.id === scene.id && got.runtime.values?.place === 'Copenhagen'
    && got.runtime.still === 'asset:reusable' && image?.src === got.runtime.still
    && remote.assets?.reusable === g.svgDataUri(scene.still)
    && runtimeSource(got, remote)?.html === scene.html
    && remote.assets?.scene === before.assets?.scene && remote.assets?.still === before.assets?.still
    && remote.slides.map((s) => s.id).join() === store.doc.slides.map((s) => s.id).join(),
    'R6 AE5 hidden-parent insertion reuses the still without overwriting existing assets')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
