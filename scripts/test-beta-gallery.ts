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
import { STILL_INLINE_MAX, stillDataUri, stillTooLarge } from '../slides/src/beta/libraryrules.ts'
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
  const values: unknown[] = [null, undefined, 0, -1, 1.5, 1e308, Number.NaN, '', ' ', 'x'.repeat(250), '<b>', '\n', '地', true, [], {}, { a: 1 }, '__proto__', '#ff0000', 'red', '59.9, 10.7', 'wide', 'near']
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
      if (r < 0.3) scene[pick(fields)] = pick(values)
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
        const sl = g.runtimeSlide(doc, sc, preset)
        const ok1 = !!sl && canon(sanitizeSlide(clone(sl))) === canon(sl) && runtimeSource(sl, doc)?.html === sc.html
          && (doc.assets?.[sl.runtime!.still!.slice(6)] ?? '').length <= STILL_INLINE_MAX
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

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
