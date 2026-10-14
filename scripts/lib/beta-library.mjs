// SPDX-License-Identifier: MIT
// BETA FORK: the scene library's manifest, built from beta/library/<scene>/
// folders (2026-10-13-2236 plan, U8, KTD8, KTD13, KTD14).
//
// One folder is one scene, authored by Beta in this repo:
//
//   beta/library/<id>/scene.json   name, version, description, kind, steps,
//                                  props, presets (and url for a web scene)
//   beta/library/<id>/index.html   a runtime scene's page (not for a web scene)
//   beta/library/<id>/still.svg    what the slide shows where no frame runs
//
// The manifest inlines every scene's HTML and still, because a scene is COPIED
// into the deck at insert (KTD8): a deck must run offline and on an older
// shell, so nothing in it may point back at the library. `html` and `still`
// are raw text, the shape the splice tool's applyScene takes (it makes the
// data URIs itself). The manifest goes to the store, never to a public origin
// (KTD13); scripts/build-beta-library.mjs does the writing and the upload.
//
// Pure where it can be: validateScene takes file contents, not paths, so
// scripts/test-beta-library.ts checks every refusal without a folder on disk.
//
// A prop's `format` (bool, latlon, select:…, range:…) is CARRIED here as an
// opaque string. Its grammar belongs to the format unit (U9), where the three
// validators that read it share one parser; this file must not grow a fourth.

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const FORMAT = 'beta/library'
export const MANIFEST_V = 1
/** A runtime scene's page: the shell's RUNTIME_SRC_BUDGET (slides/src/model.ts). */
export const HTML_BUDGET = 256 * 1024
/** A library still (KTD14): smaller than the shell allows, so it travels inline with the first frame. */
export const STILL_BUDGET = 64 * 1024
/** The whole manifest; the store refuses more. */
export const MANIFEST_BUDGET = 8 * 1024 * 1024
/**
 * Hosts a WEB scene may point at. A web scene runs whatever its host serves at
 * show time, so the host has to be one Beta controls. Exact names, no
 * wildcard: a new host is a reviewed line here.
 */
export const WEB_HOSTS = ['slides.betamobility.ai', 'design.betamobility.ai']

const ID = /^[a-z][a-z0-9-]{0,39}$/
// the shell's rules for a setting (slides/src/runtime.ts checkRuntime), restated by the splice tool too
const PROP_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const KINDS = ['text', 'number', 'color']
const COLOR_CHARS = /^[#a-zA-Z0-9(),.%\s/-]+$/
const COLOR_TRICKS = /url\s*\(|expression|@|\\/i
const MAX_PROPS = 64, MAX_TEXT = 4000, MAX_PRESETS = 24, MAX_URL = 2048
const SCENE_KEYS = new Set(['name', 'version', 'description', 'kind', 'steps', 'props', 'presets', 'url'])
const PROP_KEYS = new Set(['key', 'label', 'kind', 'default', 'format'])

export class LibraryError extends Error {}

const validValue = (kind, v) => kind === 'number' ? typeof v === 'number' && Number.isFinite(v)
  : kind === 'color' ? typeof v === 'string' && !!v.trim() && v.trim().length <= 64 && COLOR_CHARS.test(v.trim()) && !COLOR_TRICKS.test(v)
  : typeof v === 'string' && v.length <= MAX_TEXT
/** Control characters and the invisible direction marks: a name is read by a person choosing a scene. */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const kb = (n) => `${(n / 1024).toFixed(1)} KB`
const bytes = (s) => Buffer.byteLength(s, 'utf8')

// A still is a PICTURE, and the check is an allowlist, not a search for known
// tricks: the elements and attributes a drawing needs, and nothing that can
// run, load or link. The manifest is stored as given, so what is refused here
// is refused naming the file instead of being cleaned somewhere unseen.
const SVG_ELEMENTS = new Set(['svg', 'g', 'defs', 'title', 'desc', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path',
  'text', 'tspan', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'use'])
const SVG_ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/
/** An attribute value as the browser will read it: numeric references decoded, so an encoded "javascript:" is seen as one. */
const decoded = (v) => v.replace(/&#(\d{1,7});|&#x([0-9a-fA-F]{1,6});/g, (_, d, h) => { const n = d ? Number(d) : parseInt(h, 16); return n <= 0x10ffff ? String.fromCodePoint(n) : '' })

/** Why this SVG is not a plain picture, or null when it is one. */
export function activeSvg(svg) {
  // comments carry nothing; an XML declaration may lead the file
  const body = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*<\?xml[^>]*\?>/i, '')
  if (/<!|<\?/.test(body)) return 'a doctype, CDATA or processing instruction'
  const tag = /<(\/?)([^\s<>/]*)((?:"[^"]*"|'[^']*'|[^<>"'])*)>/g
  let m, rest = body
  // well-formed too: a picture the browser cannot parse is not drawn at all
  const open = []
  let roots = 0
  while ((m = tag.exec(body))) {
    const [, close, name, attrs] = m
    if (!SVG_ELEMENTS.has(name)) return `a <${name || '?'}> element`
    if (close) {
      if (attrs.trim()) return `a malformed </${name}> tag`
      if (open.pop() !== name) return `a </${name}> that closes nothing open (not well-formed)`
      continue
    }
    if (!open.length && ++roots > 1) return 'more than one root element (not well-formed)'
    if (!open.length && name !== 'svg') return `a <${name}> outside the <svg> element`
    if (!/\/\s*$/.test(attrs)) open.push(name)
    const attr = /([^\s=/"']+)\s*=\s*("[^"]*"|'[^']*')/g
    const seen = new Set()
    let a, left = attrs
    while ((a = attr.exec(attrs))) {
      const key = a[1], raw = a[2].slice(1, -1)
      if (seen.has(key)) return `${key} written twice on one <${name}> (not well-formed)`
      seen.add(key)
      if (SVG_ENTITY.test(raw)) return `an encoded value in ${key}`
      const value = decoded(raw)
      left = left.replace(a[0], '')
      if (/^on/i.test(key)) return `an ${key} handler attribute`
      if (key === 'style') return 'a style attribute (use presentation attributes)'
      if (key.includes(':') && key !== 'xmlns:xlink' && key !== 'xml:space') return `a ${key} attribute`
      if (key === 'href' && !/^#[\w.-]+$/.test(value)) return 'a link out of the file'
      if (/url\s*\(/i.test(value) && !/^url\(#[\w.-]+\)$/.test(value.trim())) return `a url() in ${key} that leaves the file`
      if (/javascript:|data:|https?:|^\s*\/\//i.test(value) && key !== 'xmlns' && key !== 'xmlns:xlink') return `a link out of the file in ${key}`
    }
    if (left.replace(/\//g, '').trim()) return `an attribute without a quoted value on <${name}>`
  }
  if (open.length) return `a <${open[open.length - 1]}> never closed (not well-formed)`
  rest = body.replace(tag, '')
  if (/[<>]/.test(rest)) return 'markup that does not parse as tags'
  return null
}

/**
 * One scene, from its folder's contents. `files` maps a file name to its text
 * (absent = no such file). Returns the manifest entry; throws LibraryError
 * naming the file and what is wrong with it.
 */
export function validateScene(id, files) {
  const at = (file) => `beta/library/${id}/${file}`
  const fail = (file, why) => { throw new LibraryError(`${at(file)}: ${why}`) }
  if (typeof id !== 'string' || !ID.test(id)) throw new LibraryError(`beta/library/${id}: a scene folder is named in lower case, digits and hyphens, starting with a letter`)

  if (typeof files['scene.json'] !== 'string') fail('scene.json', 'is missing')
  let m
  try { m = JSON.parse(files['scene.json'].replace(/^\ufeff/, '')) } catch (e) { fail('scene.json', `does not parse: ${e.message}`) }
  if (!isObject(m)) fail('scene.json', 'must be an object')
  for (const k of Object.keys(m)) if (!SCENE_KEYS.has(k)) fail('scene.json', `has a key this build does not know: ${JSON.stringify(k)}`)
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 80 || UNPRINTABLE.test(m.name)) fail('scene.json', 'name must be text of 1 to 80 characters, with no control or direction characters')
  if (!Number.isInteger(m.version) || m.version < 1) fail('scene.json', 'version must be a whole number from 1')
  if (m.description !== undefined && (typeof m.description !== 'string' || m.description.length > 200 || UNPRINTABLE.test(m.description))) fail('scene.json', 'description must be text of at most 200 characters, with no control or direction characters')
  const kind = m.kind ?? 'runtime'
  if (kind !== 'runtime' && kind !== 'web') fail('scene.json', 'kind must be "runtime" or "web"')
  const steps = m.steps ?? 0
  if (!Number.isInteger(steps) || steps < 0 || steps > 10000) fail('scene.json', 'steps must be a whole number from 0')

  const props = m.props ?? []
  if (!Array.isArray(props) || props.length > MAX_PROPS) fail('scene.json', `props must be a list of at most ${MAX_PROPS}`)
  const kinds = new Map()
  const outProps = props.map((p) => {
    if (!isObject(p) || typeof p.key !== 'string' || !PROP_KEY.test(p.key) || p.key === '__proto__' || kinds.has(p.key)) fail('scene.json', `prop key ${JSON.stringify(p?.key)} is missing, repeated or not a plain identifier`)
    for (const k of Object.keys(p)) if (!PROP_KEYS.has(k)) fail('scene.json', `prop "${p.key}" has a key this build does not know: ${JSON.stringify(k)}`)
    if (!KINDS.includes(p.kind)) fail('scene.json', `prop "${p.key}" kind must be text, number or color`)
    if (typeof p.label !== 'string' || !p.label.trim() || p.label.length > 200 || UNPRINTABLE.test(p.label)) fail('scene.json', `prop "${p.key}" needs a label of 1 to 200 characters, with no control or direction characters`)
    if (!validValue(p.kind, p.default)) fail('scene.json', `prop "${p.key}" default ${JSON.stringify(p.default)} is not a valid ${p.kind}`)
    // carried, not parsed (see the header): one printable line
    if (p.format !== undefined && (typeof p.format !== 'string' || !p.format || p.format.length > 200 || /[\u0000-\u001f\u007f]/.test(p.format))) fail('scene.json', `prop "${p.key}" format must be one line of at most 200 characters`)
    kinds.set(p.key, p.kind)
    return { key: p.key, label: p.label, kind: p.kind, default: p.default, ...(p.format !== undefined ? { format: p.format } : {}) }
  })

  const presets = m.presets
  if (!Array.isArray(presets) || !presets.length || presets.length > MAX_PRESETS) fail('scene.json', `presets must be a list of 1 to ${MAX_PRESETS}; the gallery opens on the first`)
  const names = new Set()
  const outPresets = presets.map((p) => {
    if (!isObject(p) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80 || UNPRINTABLE.test(p.name) || names.has(p.name)) fail('scene.json', `preset name ${JSON.stringify(p?.name)} is missing, repeated or longer than 80 characters`)
    for (const k of Object.keys(p)) if (k !== 'name' && k !== 'values') fail('scene.json', `preset "${p.name}" has a key this build does not know: ${JSON.stringify(k)}`)
    const values = p.values ?? {}
    if (!isObject(values)) fail('scene.json', `preset "${p.name}" values must be an object`)
    for (const [k, v] of Object.entries(values)) {
      if (!Object.prototype.hasOwnProperty.call(values, k) || !kinds.has(k)) fail('scene.json', `preset "${p.name}" sets "${k}", which is not one of the scene's props`)
      if (!validValue(kinds.get(k), v)) fail('scene.json', `preset "${p.name}" value for "${k}" (${JSON.stringify(v)}) is not a valid ${kinds.get(k)}`)
    }
    names.add(p.name)
    return { name: p.name, values: { ...values } }
  })

  const still = files['still.svg']
  if (typeof still !== 'string') fail('still.svg', 'is missing')
  if (bytes(still) > STILL_BUDGET) fail('still.svg', `is ${kb(bytes(still))}, over the ${STILL_BUDGET / 1024} KB a library still may be`)
  if (!/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(still)) fail('still.svg', 'is not an SVG document')
  const active = activeSvg(still)
  if (active) fail('still.svg', `carries ${active}; a still is a picture`)

  const base = { id, version: m.version, name: m.name, ...(m.description ? { description: m.description } : {}), kind, steps, props: outProps, presets: outPresets }
  if (kind === 'web') {
    if (files['index.html'] !== undefined) fail('index.html', 'a web scene has no page of its own; its page is at its url')
    if (typeof m.url !== 'string' || m.url.length > MAX_URL) fail('scene.json', 'a web scene needs a url')
    let u
    try { u = new URL(m.url) } catch { fail('scene.json', `url ${JSON.stringify(m.url)} is not a URL`) }
    if (u.protocol !== 'https:') fail('scene.json', `url must be https (${u.host || m.url} is ${u.protocol.replace(':', '')})`)
    if (u.username || u.password) fail('scene.json', `url must not carry a login (${u.host})`)
    if (u.port || !WEB_HOSTS.includes(u.hostname)) fail('scene.json', `url host ${u.host} is not one Beta controls (allowed: ${WEB_HOSTS.join(', ')})`)
    // measured as it will be stored: a URL grows when it is normalised
    if (u.href.length > MAX_URL) fail('scene.json', `url is ${u.href.length} characters once normalised, over ${MAX_URL}`)
    return { ...base, url: u.href, view: still }
  }
  if (m.url !== undefined) fail('scene.json', 'only a web scene has a url; a runtime scene is its index.html')
  const html = files['index.html']
  if (typeof html !== 'string') fail('index.html', 'is missing')
  if (bytes(html) > HTML_BUDGET) fail('index.html', `is ${kb(bytes(html))}, over the ${HTML_BUDGET / 1024} KB inline budget`)
  // the scene contract (plugins/beta-slides skill): it listens for bento:init and says bento:ready
  for (const word of ['bento:init', 'bento:ready']) if (!html.includes(word)) fail('index.html', `never mentions ${word}; a scene waits for bento:init and says bento:ready`)
  return { ...base, html, still, stillType: 'image/svg+xml' }
}

/** The manifest for a list of validated scenes, sorted by id so the bytes do not depend on the file system. */
export function manifestOf(scenes) {
  const ids = new Set()
  for (const s of scenes) {
    if (ids.has(s.id)) throw new LibraryError(`beta/library/${s.id}: two scenes share this id`)
    ids.add(s.id)
  }
  const manifest = { format: FORMAT, v: MANIFEST_V, scenes: [...scenes].sort((a, b) => (a.id < b.id ? -1 : 1)) }
  // measured on the bytes that are sent: serialize() escapes every "<" to six characters
  const size = bytes(serialize(manifest))
  if (size > MANIFEST_BUDGET) throw new LibraryError(`the manifest is ${kb(size)}, over the ${MANIFEST_BUDGET / 1024 / 1024} MB the store accepts`)
  return manifest
}

const FILES = ['scene.json', 'index.html', 'still.svg']

/** Read every scene folder under `dir` and build the manifest. Anything else in a folder is an error: nothing rides along unseen. */
export function buildManifest(dir) {
  if (!existsSync(dir)) throw new LibraryError(`${dir} does not exist`)
  const scenes = []
  for (const id of readdirSync(dir).sort()) {
    const sd = join(dir, id)
    // README.md beside the folders, and the generated .out/
    const kind = lstatSync(sd)
    if (kind.isSymbolicLink()) throw new LibraryError(`beta/library/${id}: is a symbolic link; a scene is a real folder in this repository`)
    if (id.startsWith('.') || !kind.isDirectory()) continue
    const files = {}
    for (const name of readdirSync(sd)) {
      if (name === '.DS_Store') continue
      if (!FILES.includes(name)) throw new LibraryError(`beta/library/${id}/${name}: a scene folder holds scene.json, still.svg and (for a runtime scene) index.html, nothing else`)
      const f = lstatSync(join(sd, name))
      if (!f.isFile()) throw new LibraryError(`beta/library/${id}/${name}: is not a plain file (a link or a folder); nothing is read through one`)
      try { files[name] = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(sd, name))) } catch { throw new LibraryError(`beta/library/${id}/${name}: is not UTF-8 text`) }
    }
    scenes.push(validateScene(id, files))
  }
  if (!scenes.length) throw new LibraryError(`${dir} holds no scene folder`)
  return manifestOf(scenes)
}

/** The manifest's bytes: stable, and with `<` escaped so the JSON is inert wherever it is pasted. */
export const serialize = (manifest) => JSON.stringify(manifest).replace(/</g, '\\u003c') + '\n'

/**
 * What the store checks before it keeps an upload, and what a reader may rely
 * on. Shared with the worker's rig so the two cannot drift: a manifest this
 * accepts is one the worker accepts.
 */
export function manifestShape(value) {
  if (!isObject(value) || value.format !== FORMAT || value.v !== MANIFEST_V || !Array.isArray(value.scenes)) return false
  const ids = new Set()
  return value.scenes.every((s) => {
    if (!isObject(s) || typeof s.id !== 'string' || !ID.test(s.id) || ids.has(s.id) || !Number.isInteger(s.version) || s.version < 1) return false
    ids.add(s.id)
    if (s.kind === 'runtime') return typeof s.html === 'string' && s.url === undefined
    if (s.kind !== 'web' || typeof s.url !== 'string' || s.html !== undefined) return false
    let u
    try { u = new URL(s.url) } catch { return false }
    return u.protocol === 'https:' && !u.port && !u.username && !u.password && WEB_HOSTS.includes(u.hostname)
  })
}
