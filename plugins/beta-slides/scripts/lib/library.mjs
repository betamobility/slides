// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
//
// The scene library, seen from the splice tool (2026-10-13-2236 plan, U12,
// KTD9, KTD13): which scenes a manifest offers, whether a value is one a
// setting keeps, and the slide a library insert writes.
//
// THE SAME SLIDE THE GALLERY WRITES. The editor's gallery
// (slides/src/beta/gallery.ts runtimeSlide) and this file build a library
// scene's runtime slide independently, because this directory may import
// nothing from outside plugins/beta-slides/ (KTD11). scripts/test-beta-gallery.ts
// builds the same scene both ways and compares them, decoded assets
// included, so the two cannot drift apart unseen.
//
// THE SAME RULES THE LIBRARY BUILD AND THE GALLERY APPLY, restated for the
// same reason from slides/src/beta/libraryrules.ts (that rig compares them
// too): a still that travels with its slide, a page the shell's gate keeps,
// setting names the sync engine accepts, text that needs no repair. A scene
// that breaks one is not offered, never repaired.

/** slides/src/beta/libraryrules.ts STILL_INLINE_MAX: the sync engine's BLOB_INLINE_MAX. */
export const STILL_INLINE_MAX = 64 * 1024
/** slides/src/beta/libraryrules.ts PAGE_BUDGET, measured as the shell's gate measures it. */
export const PAGE_BUDGET = 256 * 1024
/** slides/src/beta/libraryrules.ts RESERVED_KEYS: names the sync engine drops. */
export const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype']

export const LIBRARY_ID = /^[a-z][a-z0-9-]{0,39}$/
const PROP_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const COLOR_CHARS = /^[#a-zA-Z0-9(),.%\s/-]+$/
const COLOR_TRICKS = /url\s*\(|expression|@|\\/i
/** One printable line, as the gallery reads a name or a description (slides/src/beta/gallery.ts line). */
const line = (v, max) => typeof v === 'string' && v.trim().length > 0 && [...v].length <= max && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(v)
const MAX_TEXT = 4000

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

/** A text that is not well-formed UTF-16, anywhere in a value. */
export function hasLoneSurrogate(v, depth = 0) {
  if (typeof v === 'string') return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(v)
  if (depth > 32 || v === null || typeof v !== 'object') return depth > 32
  if (Array.isArray(v)) return v.some((x) => hasLoneSurrogate(x, depth + 1))
  return Object.keys(v).some((k) => hasLoneSurrogate(k) || hasLoneSurrogate(v[k], depth + 1))
}

/** A still as a data: URI, in whichever of percent-encoding and base64 is shorter. */
export function stillDataUri(svg) {
  const pct = 'data:image/svg+xml,' + svg.replace(/[\u0000-\u001f%#\u007f-\u{10ffff}]/gu, (c) => encodeURIComponent(c))
  const b64 = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64')
  return pct.length <= b64.length ? pct : b64
}
/** The page as the shell stores it: base64 of its UTF-8 bytes. */
export const pageDataUri = (html) => 'data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64')
const gatePageBytes = (html) => Math.ceil(Buffer.byteLength(html, 'utf8') / 3) * 3

// ---- a setting's value --------------------------------------------------------

/** One of the shell's three kinds, as its gate keeps it (slides/src/runtime.ts). */
function validKind(kind, v) {
  if (kind === 'number') return typeof v === 'number' && Number.isFinite(v)
  if (kind === 'color') return typeof v === 'string' && !!v.trim() && v.trim().length <= 64 && COLOR_CHARS.test(v.trim()) && !COLOR_TRICKS.test(v)
  return typeof v === 'string' && v.length <= MAX_TEXT
}

/** "-12.50" or 1e-7 as m * 10^e, exactly. */
function dec(s) {
  const x = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(s)
  if (!x) return null
  const frac = x[3] ?? ''
  return { m: BigInt(x[1] + x[2] + frac), e: Number(x[4] ?? 0) - frac.length }
}
const at = (d, e) => d.m * 10n ** BigInt(d.e - e)

/**
 * Why `v` is not a value this setting keeps as given, or null when it is.
 * The form (slides/src/beta/scenesettings.ts coerce) would hold or refuse
 * anything this refuses; the tool refuses instead of writing a value the
 * panel would then show changed.
 */
export function settingRefusal(prop, v) {
  if (!validKind(prop.kind, v)) return `is not a ${prop.kind}`
  if (hasLoneSurrogate(v)) return 'carries text that is not well-formed'
  const f = typeof prop.format === 'string' ? prop.format : ''
  if (f === 'bool' && prop.kind === 'number') return v === 0 || v === 1 ? null : 'is a yes/no setting: 0 or 1'
  if (f === 'latlon' && prop.kind === 'text') {
    const m = /^\s*([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)\s*$/.exec(v)
    if (!m) return 'is not a position: write "latitude, longitude"'
    if (Math.abs(Number(m[1])) > 90 || Math.abs(Number(m[2])) > 180) return 'is outside latitude -90 to 90, longitude -180 to 180'
    // the form keeps a position in one spelling (scenesettings.ts: six decimals at most, ", " between)
    const round6 = (n) => Number(Number(n).toFixed(6))
    const canonical = `${round6(m[1])}, ${round6(m[2])}`
    return v === canonical ? null : `is written as the form would not keep it; write ${JSON.stringify(canonical)}`
  }
  if (f.startsWith('select:') && prop.kind === 'text') {
    const options = f.slice(7).split('|').filter(Boolean)
    if (options.length) return options.includes(v) ? null : `is not one of ${options.map((o) => JSON.stringify(o)).join(', ')}`
  }
  const r = /^range:(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(f)
  if (r && prop.kind === 'number' && Number(r[1]) < Number(r[2]) && Number(r[3]) > 0) {
    const [lo, hi, st, x] = [dec(r[1]), dec(r[2]), dec(r[3]), dec(String(v))]
    if (!lo || !hi || !st || !x) return `is not a number the range ${r[1]} to ${r[2]} can hold`
    const e = Math.min(lo.e, hi.e, st.e, x.e)
    const [min, max, step, n] = [at(lo, e), at(hi, e), at(st, e), at(x, e)]
    if (n < min || n > max) return `is outside ${r[1]} to ${r[2]}`
    if (n !== max && (n - min) % step !== 0n) return `is not on the range's steps of ${r[3]} from ${r[1]}`
  }
  return null
}

// ---- the manifest ---------------------------------------------------------------

/**
 * The scenes a manifest offers, by id, each read the way the gallery reads
 * it; `skipped` names the ones left out and why. Throws when the JSON is not
 * a library manifest at all.
 */
export function readLibrary(json) {
  if (!isObject(json) || json.format !== 'beta/library' || json.v !== 1 || !Array.isArray(json.scenes)) {
    throw new Error('the store answered with something that is not a scene library manifest')
  }
  const scenes = new Map()
  const skipped = []
  for (const raw of json.scenes) {
    const id = isObject(raw) && typeof raw.id === 'string' ? raw.id : '?'
    const why = sceneRefusal(raw)
    if (why) { skipped.push(`${id}: ${why}`); continue }
    if (!scenes.has(id)) scenes.set(id, raw)
  }
  return { scenes, skipped }
}

function sceneRefusal(s) {
  if (!isObject(s)) return 'not an object'
  if (hasLoneSurrogate(s)) return 'text that is not well-formed'
  if (typeof s.id !== 'string' || !LIBRARY_ID.test(s.id)) return 'an id outside the folder rule'
  if (!Number.isInteger(s.version) || s.version < 1 || s.version > 1_000_000) return 'no whole-number version'
  if (!line(s.name, 80)) return 'no readable name'
  if (s.description !== undefined && s.description !== '' && !line(s.description, 200)) return 'a description that is not one readable line'
  if (s.kind !== 'runtime' && s.kind !== 'web') return 'an unknown kind'
  const steps = s.steps ?? 0
  if (!Number.isInteger(steps) || steps < 0 || steps > 10000) return 'steps that are not a whole number'
  const props = s.props ?? []
  if (!Array.isArray(props) || props.length > 64) return 'a settings list it cannot read'
  const keys = new Set()
  for (const p of props) {
    if (!isObject(p) || typeof p.key !== 'string' || !PROP_KEY.test(p.key) || RESERVED_KEYS.includes(p.key) || keys.has(p.key)) return `a setting key ${JSON.stringify(p?.key)} that is missing, repeated or reserved`
    if (!['text', 'number', 'color'].includes(p.kind)) return `setting "${p.key}" of an unknown kind`
    // as the shell's gate keeps a label (slides/src/runtime.ts): a string of at most 200 UTF-16 units
    if (typeof p.label !== 'string' || p.label.length > 200) return `setting "${p.key}" without a label the shell keeps`
    if (!validKind(p.kind, p.default)) return `setting "${p.key}" whose default is not a ${p.kind}`
    if (p.format !== undefined && (typeof p.format !== 'string' || !p.format || [...p.format].length > 200 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(p.format))) return `setting "${p.key}" with a format hint it cannot read`
    keys.add(p.key)
  }
  if (!Array.isArray(s.presets)) return 'no presets list'
  const names = new Set()
  for (const pr of s.presets) {
    if (!isObject(pr) || typeof pr.name !== 'string' || !pr.name.trim() || names.has(pr.name)) return 'a preset without a name of its own'
    if (pr.values !== undefined && !isObject(pr.values)) return `preset "${pr.name}" whose values are not an object`
    for (const [k, v] of Object.entries(pr.values ?? {})) {
      const prop = props.find((p) => p.key === k)
      if (!prop) return `preset "${pr.name}" sets "${k}", which is not a setting`
      const bad = settingRefusal(prop, v)
      if (bad) return `preset "${pr.name}": "${k}" ${bad}`
    }
    names.add(pr.name)
  }
  const still = s.kind === 'web' ? s.view : s.still
  if (typeof still !== 'string' || !/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(still)) return 'no svg still'
  if (stillDataUri(still).length > STILL_INLINE_MAX) return `a still too large to travel with its slide (over ${STILL_INLINE_MAX} characters encoded)`
  if (s.kind === 'runtime') {
    if (typeof s.html !== 'string' || !s.html) return 'no page'
    if (gatePageBytes(s.html) > PAGE_BUDGET) return 'a page over the 256 KB inline budget'
  } else if (typeof s.url !== 'string' || !/^https:\/\//i.test(s.url)) return 'no https page address'
  return null
}

/**
 * The values a library insert writes: every declared setting, from `values`
 * where it names one, else from the preset (by name; the first when none is
 * named), else the default. Throws naming the key or preset that is wrong.
 */
export function valuesFor(scene, { preset, values = {} } = {}) {
  let chosen = scene.presets[0]
  if (preset !== undefined) {
    chosen = scene.presets.find((p) => p.name === preset)
    if (!chosen) throw new Error(`library scene "${scene.id}" has no preset ${JSON.stringify(preset)} (it has ${scene.presets.map((p) => JSON.stringify(p.name)).join(', ') || 'none'})`)
  }
  checkValues(scene.props, values, `library scene "${scene.id}"`)
  const out = {}
  for (const p of scene.props) {
    out[p.key] = hasOwn(values, p.key) ? values[p.key] : chosen && hasOwn(chosen.values ?? {}, p.key) ? chosen.values[p.key] : p.default
  }
  return out
}

/** Every key declared, every value one its setting keeps; throws naming the first that is not. */
export function checkValues(props, values, where) {
  if (!isObject(values)) throw new Error(`${where}: values must be an object of setting: value`)
  for (const [k, v] of Object.entries(values)) {
    const prop = props.find((p) => p.key === k)
    if (!prop) throw new Error(`${where}: "${k}" is not one of its settings (${props.map((p) => p.key).join(', ') || 'it has none'})`)
    const bad = settingRefusal(prop, v)
    if (bad) throw new Error(`${where}: "${k}" ${JSON.stringify(v)} ${bad}`)
  }
}

/**
 * The runtime slide a library insert writes: the gallery's slide, field for
 * field (slides/src/model.ts emptySlide and defaultImage; the runtime record
 * in the gate's key order). `intern` puts a data URI in doc.assets and
 * returns its `asset:` ref.
 */
export function librarySlide(doc, scene, values, id, intern) {
  const size = doc.size || { width: 1280, height: 720 }
  const src = intern(doc, pageDataUri(scene.html), 'scene')
  const still = intern(doc, stillDataUri(scene.still), 'still')
  return {
    id, background: '#FFFFFF', transition: 'fade',
    elements: [{ id: 'still', type: 'image', x: 0, y: 0, w: size.width, h: size.height, rotation: 0, opacity: 1, src: still, fit: 'cover', radius: 0 }],
    notes: '',
    runtime: {
      src, still, steps: scene.steps ?? 0,
      props: scene.props.map((p) => ({ key: p.key, label: p.label, kind: p.kind, default: p.default, ...(p.format !== undefined ? { format: p.format } : {}) })),
      values, library: { id: scene.id, version: scene.version },
    },
  }
}
