#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
//
// splice: put runtime slides (live HTML scenes) into a deck on the Beta deck
// store, and fix native content by element id, without ever touching what a
// person arranged in the editor.
//
//   node splice.mjs --link
//   node splice.mjs --read <deckId> [--out <file>]
//   node splice.mjs --library
//   node splice.mjs <deckId> <projectDir> [--edits edits.json] [--title "<title>"] [--dry-run] [--skip-url-check]
//   node splice.mjs <deckId> --edits edits.json [--title "<title>"] [--dry-run]
//   node splice.mjs <deckId> --title "<title>" [--dry-run]
//   node splice.mjs --create <projectDir> [--dry-run] [--skip-url-check]
//
// The third and fourth forms are a content fix or a rename on a deck with no
// scene to change. A run with no scene folders, no edits and no --title
// refuses: there is nothing to do. --title changes doc.title and nothing else
// at document level.
//
// TWO WAYS IN, and the tool never asks anyone to handle a secret
// (docs/plans/2026-09-15-001-feat-one-click-publish-pairing-plan.md, U5;
// docs/plans/2026-10-13-2236-feat-upstream-merge-and-live-scenes-plan.md, U6):
//
//   · AN APPROVAL, for people. A run with no credential starts a pairing by
//     itself, prints a link for the person to click, and remembers the grant
//     it collects in ~/.bento/slides-grant.json (or SLIDES_GRANT_FILE), mode
//     0600; `--link` does the pairing alone. Every request then goes to
//     /api/publish/ as the person who approved. SLIDES_GRANT_LABEL is what
//     the approval page and the person's Agent access list call this agent.
//   · A SERVICE TOKEN, for machines: CF_ACCESS_CLIENT_ID and
//     CF_ACCESS_CLIENT_SECRET, sent as the two headers Access expects. Used
//     only when they are set, and then always, because a leftover grant file
//     must never reroute a machine run away from it.
//
// With CI set (to anything, even empty) and no credential the tool refuses and
// starts no pairing: there is nobody to click. The grant is never written
// beside the deck, so a shell with no writable home needs SLIDES_GRANT_FILE.
// The pairing lives in the process that started it: a command killed while it
// waits loses it, so the skill runs the pairing where it can wait ten minutes.
//
// SLIDES_STORE_URL (default https://slides.betamobility.ai) is the store, and
// a grant is only ever sent to the store it was approved for.
// SPLICE_TIMEOUT_MS, when set, replaces every request timeout (30 s for a
// deck or template request, 120 s per asset upload, 10 s for the url framing
// check); a request that times out fails the run with a message naming it.
//
// A scene.json with `url` is checked before any store request: the page is
// fetched once (one redirect followed) and the run refuses if its
// X-Frame-Options or CSP frame-ancestors would stop https://slides.betamobility.ai
// from framing it. A page that cannot be reached is a warning, not a refusal
// (it may be internal). --skip-url-check skips the check.
//
// A project folder:
//   deck.json                        --create only: { title?, slides: [...] }
//   scenes/<slideId>/index.html      the scene, inlined (256 KB at most)
//   scenes/<slideId>/still.png|svg   what thumbnails, print and export show (200 KB)
//   scenes/<slideId>/scene.json      { steps, props, assets?, url?, insertAfter? }
//   scenes/<slideId>/assets/<name>   heavy files scene.json lists; uploaded to
//                                    the store's asset route, never inlined
//                                    (<projectDir>/assets/<name> also found)
//
// edits.json is a list of edits, each one of three kinds:
//   { slideId, elementId, html | src | option | rows }   content of a native element
//   { slideId, values: { key: value } }                    settings of a library scene
//   { library, id, insertAfter, preset?, values? }         a new library scene slide
//
// THE SCENE LIBRARY (2026-10-13-2236 plan, U12, KTD9, KTD13). `--library`
// prints the scenes the store offers, read with the run's own credential
// (/api/harness/library.json or /api/publish/library.json). A `library` edit
// inserts scene `library` as a new runtime slide `id` after `insertAfter` (a
// slide id, or "end"): the slide the editor's gallery writes, with the
// preset's values (by name; the first when none is named) and `values` over
// them. Only a runtime scene can be inserted here; a web scene goes on a slide
// the person owns, so it is inserted from the editor. A `values` edit changes
// the named settings of a slide carrying runtime.library, declared keys only,
// each a value its setting keeps as given; every other value, the person's,
// stays. A slide carrying runtime.library is replaced from a scene folder
// only when that folder's scene.json declares the same `library` id; it then
// keeps the marker, and the replace drops values as any replace does (R14).
//
// A scene folder names a runtime slide already in the deck, which it replaces.
// To add a new one, scene.json sets insertAfter to the id of a slide in the
// deck as read (or "end"), and the folder name, the new slide's id, must not be
// in the deck. The new slide goes after that slide and after any states of
// it; two folders with the same insertAfter land in folder name order. Without
// insertAfter an unknown id is still refused (AE8), and a native slide's id is
// refused either way (AE10). Ignored by --create, where deck.json places slides.
//
// THE OWNERSHIP RULE (docs/plans/2026-09-14-001-feat-runtime-slides-plan.md,
// KTD8). A runtime slide is Claude's and is replaced wholesale, presenter
// values included (R14). A native slide is the person's: only the content of
// an element named in edits.json may change, never its position, size or
// rotation, and never the slide order. Before writing, the tool diffs what it
// is about to write against what it read and refuses on any other difference,
// so a bug in the derivation is caught by the same check as a bad edit. A
// refusal writes nothing. After a 412 the whole derivation is redone against
// a fresh read, at most three more times (R19).
//
// Node built-ins only, and no import from outside plugins/beta-slides/
// (KTD11): the marketplace installs this directory and nothing else.

import {
  readFileSync, existsSync, statSync, readdirSync, realpathSync,
  writeFileSync, mkdirSync, chmodSync, rmSync, accessSync, constants as fsConstants,
} from 'node:fs'
import { join, extname, dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readBlock, writeBlock, isEncrypted } from './lib/bento-doc.mjs'
import { checkValues, LIBRARY_ID, librarySlide, readLibrary, valuesFor } from './lib/library.mjs'

// slides/src/model.ts RUNTIME_*_BUDGET; restated because this file cannot
// import the app.
export const SRC_BUDGET = 256 * 1024
export const STILL_BUDGET = 200 * 1024
export const ASSET_BUDGET = 16 * 1024 * 1024
const MAX_ATTEMPTS = 4 // one write and three re-derived retries (R19)
// The pairing flow (one-click publish plan, U5/KTD10). `--link` asks the store
// to start a pairing, prints the link the person clicks, and remembers the
// grant it collects. The label is what the approval page shows them, in quotes,
// and what tells one agent's grant from another's on their Agent access list:
// Cowork's unless SLIDES_GRANT_LABEL names another.
const GRANT_FILE_ENV = 'SLIDES_GRANT_FILE'
const LABEL_ENV = 'SLIDES_GRANT_LABEL'
const LINK_LABEL = 'Claude (Cowork)'
// Seven seconds, not two. The store's pairing limiter is 10 requests per
// minute per address and the pairing START route shares that budget, so a
// 2-second poll spent two thirds of its requests being refused and could lock
// out the next pairing's start. The first poll still goes out immediately, so
// a click that has already happened is collected at once.
const POLL_MS = 7000
// Room kept before a pairing's deadline for the last poll's answer.
const LAST_POLL_MS = 1000
const TIMEOUT = { store: 30_000, asset: 120_000, url: 10_000 }
// The origin a url scene is framed by (the store host people open decks on),
// fixed rather than taken from SLIDES_STORE_URL: that one can be a test proxy.
const FRAMING_ORIGIN = 'https://slides.betamobility.ai'

// The deck store's asset allowlist and name rule (server/deck-store/src/worker.js).
const ASSET_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.csv': 'text/csv',
}
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const PROP_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
// What slides/src/runtime.ts checkRuntime keeps. The sanitiser repairs a bad
// value on paste; this tool refuses it instead, so the record it writes is the
// record a later paste keeps.
const COLOR_CHARS = /^[#a-zA-Z0-9(),.%\s/-]+$/
const COLOR_TRICKS = /url\s*\(|expression|@|\\/i
const MAX_PROPS = 64, MAX_TEXT = 4000, MAX_URL = 4000, MAX_ASSETS = 64
const KIND_DEFAULT = { text: '', number: 0, color: '#000000' }
const validValue = (kind, v) => kind === 'number' ? typeof v === 'number' && Number.isFinite(v)
  : kind === 'color' ? typeof v === 'string' && !!v.trim() && v.trim().length <= 64 && COLOR_CHARS.test(v.trim()) && !COLOR_TRICKS.test(v)
  : typeof v === 'string' && v.length <= MAX_TEXT
const GEOMETRY = new Set(['x', 'y', 'w', 'h', 'rotation'])
// The one key per element type an edit may change.
const CONTENT_KEY = { text: 'html', image: 'src', media: 'src', chart: 'option', table: 'rows' }

/** A refusal: the message names the offending id; nothing has been written. */
export class Refusal extends Error {}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const kb = (n) => `${(n / 1024).toFixed(1)} KB`
const isRuntime = (slide) => !!slide && typeof slide.runtime === 'object' && slide.runtime !== null

// ---- the project folder ---------------------------------------------------------

/**
 * Read and validate every scene folder once. The files do not change between
 * retries, so budgets, manifests and asset files are settled here, before any
 * request is made.
 */
export function readProject(dir, { create = false } = {}) {
  if (!dir && !create) return { deck: undefined, scenes: [] }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Refusal(`project folder not found: ${dir}`)
  let deck
  if (create) {
    const file = join(dir, 'deck.json')
    if (!existsSync(file)) throw new Refusal(`--create needs ${file} ({ title?, slides: [...] })`)
    try { deck = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { throw new Refusal(`deck.json does not parse: ${e.message}`) }
    if (!deck || !Array.isArray(deck.slides)) throw new Refusal('deck.json must be { title?, slides: [...] }')
    const seen = new Set()
    for (const s of deck.slides) {
      if (!s || typeof s.id !== 'string' || !s.id) throw new Refusal('every slide in deck.json needs a string id')
      if (seen.has(s.id)) throw new Refusal(`deck.json has two slides with id "${s.id}"`)
      seen.add(s.id)
      if (!Array.isArray(s.elements)) s.elements = []
    }
  }
  const scenesDir = join(dir, 'scenes')
  const ids = existsSync(scenesDir) ? readdirSync(scenesDir).filter((n) => statSync(join(scenesDir, n)).isDirectory()).sort() : []
  const scenes = ids.map((id) => readScene(dir, join(scenesDir, id), id))
  // Assets live at /d/<id>/assets/<name>, one namespace per deck: the same
  // name with other bytes in a second scene would overwrite the first.
  const names = new Map()
  for (const scene of scenes) {
    for (const a of scene.assets) {
      const seen = names.get(a.name)
      if (seen && seen.hash !== a.hash) {
        throw new Refusal(`asset ${a.name} is listed by scenes "${seen.scene}" and "${scene.id}" with different bytes (${seen.path}, ${a.path}); assets are deck-wide in the store, so give one a different name`)
      }
      if (!seen) names.set(a.name, { hash: a.hash, path: a.path, scene: scene.id })
    }
  }
  return { deck, scenes }
}

function readScene(projectDir, sd, id) {
  const html = join(sd, 'index.html')
  if (!existsSync(html)) throw new Refusal(`scene "${id}": index.html is missing`)
  const src = readFileSync(html)
  if (src.length > SRC_BUDGET) {
    throw new Refusal(`scene "${id}": index.html is ${kb(src.length)}, over the 256 KB inline budget. Move heavy data to assets/ and list it in scene.json, or host the page and set url`)
  }
  const stills = ['still.png', 'still.svg'].filter((n) => existsSync(join(sd, n)))
  if (stills.length !== 1) throw new Refusal(`scene "${id}": needs exactly one still (still.png or still.svg), found ${stills.length}`)
  const still = readFileSync(join(sd, stills[0]))
  if (still.length > STILL_BUDGET) throw new Refusal(`scene "${id}": ${stills[0]} is ${kb(still.length)}, over the 200 KB still budget`)
  const stillType = stills[0].endsWith('.svg') ? 'image/svg+xml' : 'image/png'

  const mf = join(sd, 'scene.json')
  if (!existsSync(mf)) throw new Refusal(`scene "${id}": scene.json is missing`)
  let m
  try { m = JSON.parse(readFileSync(mf, 'utf8')) } catch (e) { throw new Refusal(`scene "${id}": scene.json does not parse: ${e.message}`) }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Refusal(`scene "${id}": scene.json must be an object`)
  const steps = m.steps ?? 0
  if (!Number.isInteger(steps) || steps < 0 || steps > 10000) throw new Refusal(`scene "${id}": steps must be a whole number from 0`)
  const props = m.props ?? []
  if (!Array.isArray(props) || props.length > MAX_PROPS) throw new Refusal(`scene "${id}": props must be a list of at most ${MAX_PROPS}`)
  const keys = new Set()
  for (const p of props) {
    if (!p || typeof p.key !== 'string' || !PROP_KEY.test(p.key) || keys.has(p.key)) throw new Refusal(`scene "${id}": prop key ${JSON.stringify(p?.key)} is missing, repeated or not a plain identifier`)
    if (!['text', 'number', 'color'].includes(p.kind)) throw new Refusal(`scene "${id}": prop "${p.key}" kind must be text, number or color`)
    if (p.label !== undefined && (typeof p.label !== 'string' || p.label.length > 200)) throw new Refusal(`scene "${id}": prop "${p.key}" label must be text of at most 200 characters`)
    if (p.default !== undefined && !validValue(p.kind, p.default)) throw new Refusal(`scene "${id}": prop "${p.key}" default ${JSON.stringify(p.default)} is not a valid ${p.kind}`)
    if (p.format !== undefined && (typeof p.format !== 'string' || !p.format || [...p.format].length > 200 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(p.format))) throw new Refusal(`scene "${id}": prop "${p.key}" format must be one line of at most 200 characters`)
    keys.add(p.key)
  }
  if (m.library !== undefined && (typeof m.library !== 'string' || !LIBRARY_ID.test(m.library))) throw new Refusal(`scene "${id}": library must be a library scene id (lower case, digits and hyphens)`)
  if (m.insertAfter !== undefined && (typeof m.insertAfter !== 'string' || !m.insertAfter)) throw new Refusal(`scene "${id}": insertAfter must be the id of a slide in the deck, or "end"`)
  if (m.url !== undefined && (typeof m.url !== 'string' || m.url.length > MAX_URL || !/^https:\/\//i.test(m.url))) throw new Refusal(`scene "${id}": url must be https`)

  const assets = []
  if (m.assets !== undefined && (!Array.isArray(m.assets) || m.assets.length > MAX_ASSETS || new Set(m.assets).size !== m.assets.length)) {
    throw new Refusal(`scene "${id}": assets must be a list of at most ${MAX_ASSETS} distinct names`)
  }
  for (const name of m.assets ?? []) {
    if (typeof name !== 'string' || !ASSET_NAME.test(name)) throw new Refusal(`scene "${id}": asset name ${JSON.stringify(name)} is not one the store accepts`)
    const type = ASSET_TYPES[extname(name).toLowerCase()]
    if (!type) throw new Refusal(`scene "${id}": asset ${name} has a type the store does not accept (png, jpg, webp, svg, json, csv)`)
    const path = [join(sd, 'assets', name), join(projectDir, 'assets', name)].find((p) => existsSync(p))
    if (!path) throw new Refusal(`scene "${id}": asset ${name} is listed in scene.json but not in ${join(sd, 'assets')}`)
    const size = statSync(path).size
    if (size > ASSET_BUDGET) throw new Refusal(`scene "${id}": asset ${name} is ${kb(size)}, over the 16 MB asset budget`)
    assets.push({ name, path, type, size, hash: createHash('sha256').update(readFileSync(path)).digest('hex') })
  }
  return { id, src, still, stillType, steps, props, url: m.url, assets, insertAfter: m.insertAfter, library: m.library }
}

/** edits.json, validated for shape; whether each target exists is checked per read. */
export function readEdits(file) {
  if (!file) return []
  let list
  try { list = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { throw new Refusal(`edits file does not parse: ${e.message}`) }
  if (!Array.isArray(list)) throw new Refusal('edits.json must be a list of edits: { slideId, elementId, html | src | option | rows }, { slideId, values }, or { library, id, insertAfter, preset?, values? }')
  const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  for (const e of list) {
    if (!plain(e)) throw new Refusal('every edit is an object')
    if (e.library !== undefined) {
      if (typeof e.library !== 'string' || !LIBRARY_ID.test(e.library)) throw new Refusal(`library insert: ${JSON.stringify(e.library)} is not a library scene id`)
      if (typeof e.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(e.id)) throw new Refusal(`library insert of "${e.library}": id must name the new slide (letters, digits, - and _)`)
      if (typeof e.insertAfter !== 'string' || !e.insertAfter) throw new Refusal(`library insert "${e.id}": insertAfter must be the id of a slide in the deck, or "end"`)
      if (e.preset !== undefined && typeof e.preset !== 'string') throw new Refusal(`library insert "${e.id}": preset must be a preset's name`)
      if (e.values !== undefined && !plain(e.values)) throw new Refusal(`library insert "${e.id}": values must be an object of setting: value`)
      const extra = Object.keys(e).filter((k) => !['library', 'id', 'insertAfter', 'preset', 'values'].includes(k))
      if (extra.length) throw new Refusal(`library insert "${e.id}": ${extra.map((k) => JSON.stringify(k)).join(', ')} is not part of a library insert`)
      continue
    }
    if (typeof e.slideId !== 'string') throw new Refusal('every edit needs slideId (or library, for a library insert)')
    if (e.values !== undefined) {
      if (e.elementId !== undefined || Object.keys(e).length !== 2) throw new Refusal(`values edit for ${e.slideId}: { slideId, values } and nothing else`)
      if (!plain(e.values) || !Object.keys(e.values).length) throw new Refusal(`values edit for ${e.slideId}: values must name at least one setting`)
      continue
    }
    if (typeof e.elementId !== 'string') throw new Refusal('every content edit needs slideId and elementId')
    if (Object.keys(e).length < 3) throw new Refusal(`edit for ${e.slideId}/${e.elementId} changes nothing`)
  }
  return list
}

// ---- deriving the document ----------------------------------------------------------

const dataUri = (type, bytes) => `data:${type};base64,${bytes.toString('base64')}`

/** An `asset:` ref for `value`: an existing key holding the same value, else a new one. */
function intern(doc, value, prefix) {
  const assets = (doc.assets ??= {})
  for (const k of Object.keys(assets)) if (assets[k] === value) return `asset:${k}`
  const base = `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`
  let key = base
  for (let n = 2; key in assets; n++) key = `${base}-${n}`
  assets[key] = value
  return `asset:${key}`
}

/**
 * Make `slide` the runtime slide `scene` describes. The record is rebuilt from
 * nothing (so presenter `values` are gone, R14) in checkRuntime's key order,
 * and the elements become the one full-bleed still. Everything else on the
 * slide (id, notes, background, transition) is the person's and stays.
 */
/** The image element a runtime slide shows its still through: the one carrying runtime.still, else the first image. */
function stillHolder(slide) {
  const images = (slide.elements || []).filter((el) => el && el.type === 'image')
  const still = isRuntime(slide) ? slide.runtime.still : undefined
  return (still && images.find((el) => el.src === still)) || images[0]
}

function applyScene(doc, slide, scene) {
  const old = isRuntime(slide) ? slide.runtime : {}
  const rec = {}
  rec.src = intern(doc, dataUri('text/html;charset=utf-8', scene.src), 'scene')
  if (scene.url) rec.url = scene.url
  rec.still = intern(doc, dataUri(scene.stillType, scene.still), 'still')
  rec.steps = scene.steps
  rec.props = scene.props.map((p) => ({ key: p.key, label: typeof p.label === 'string' ? p.label : p.key, kind: p.kind, default: p.default ?? KIND_DEFAULT[p.kind], ...(typeof p.format === 'string' ? { format: p.format } : {}) }))
  if (scene.assets.length) rec.assets = scene.assets.map((a) => a.name)

  const holder = stillHolder(slide)
  const size = doc.size || { width: 1280, height: 720 }
  slide.elements = [{
    id: holder?.id || 'still', type: 'image', x: 0, y: 0, w: size.width, h: size.height,
    rotation: 0, opacity: 1, src: rec.still, fit: 'cover', radius: 0,
  }]
  slide.runtime = rec
  return [old.src, old.still, holder?.src].filter((r) => typeof r === 'string' && r.startsWith('asset:')).map((r) => r.slice(6))
}

/** Drop assets a replaced record held when nothing else in the document names them. */
function prune(doc, keys) {
  if (!doc.assets) return []
  const { assets, ...rest } = doc
  const text = JSON.stringify(rest)
  const gone = []
  for (const k of new Set(keys)) {
    if (!(k in assets) || text.includes(`"asset:${k}"`) || text.includes(`"${k}"`)) continue
    delete assets[k]
    gone.push(k)
  }
  return gone
}

/**
 * The document to write, from the one read. Pure; throws Refusal. Returns the
 * new document and the plan lines `--dry-run` prints.
 */
export function derive(read, { scenes }, edits = [], { title, library } = {}) {
  const doc = structuredClone(read)
  if (!Array.isArray(doc.slides)) throw new Refusal('the deck has no slides list')
  const plan = []
  if (title !== undefined) {
    plan.push(`  title: ${JSON.stringify(read.title ?? '')} becomes ${JSON.stringify(title)}`)
    doc.title = title
  }
  const byId = (id) => doc.slides.filter((s) => s && s.id === id)

  const sceneIds = new Set()
  const inserted = new Set()
  const inserts = new Map() // anchor id, or "end", to the scenes that go after it
  const contentEdits = edits.filter((e) => e.library === undefined && e.values === undefined)
  const valueEdits = edits.filter((e) => e.library === undefined && e.values !== undefined)
  const libraryInserts = edits.filter((e) => e.library !== undefined)
  const anchorCheck = (what, anchor) => {
    if (anchor === 'end') return
    const at = read.slides.filter((s) => s && s.id === anchor).length
    if (at !== 1) throw new Refusal(`${what}: insertAfter "${anchor}" ${at ? 'is ambiguous' : 'is not a slide in the deck'}; nothing was written`)
  }
  for (const e of libraryInserts) {
    if (!library) throw new Refusal(`library insert "${e.id}": the scene library was not read; nothing was written`)
    const scene = library.scenes.get(e.library)
    if (!scene) throw new Refusal(`library insert "${e.id}": "${e.library}" is not in the scene library (${[...library.scenes.keys()].join(', ') || 'it is empty'}; splice.mjs --library lists it); nothing was written`)
    if (scene.kind !== 'runtime') throw new Refusal(`library insert "${e.id}": "${e.library}" is a web scene, which goes on a slide the person owns; insert it from the editor's Scenes gallery; nothing was written`)
    if (byId(e.id).length || sceneIds.has(e.id)) throw new Refusal(`library insert "${e.id}": a slide with that id is already in the deck; nothing was written`)
    anchorCheck(`library insert "${e.id}"`, e.insertAfter)
    let values
    try { values = valuesFor(scene, { preset: e.preset, values: e.values ?? {} }) } catch (err) { throw new Refusal(`library insert "${e.id}": ${err.message}; nothing was written`) }
    inserts.set(e.insertAfter, [...(inserts.get(e.insertAfter) || []), { libraryInsert: true, id: e.id, scene, values, preset: e.preset }])
    inserted.add(e.id)
    sceneIds.add(e.id)
  }
  for (const scene of scenes) {
    const hits = byId(scene.id)
    if (!hits.length && scene.insertAfter !== undefined) {
      const anchor = scene.insertAfter
      if (anchor !== 'end') {
        const at = read.slides.filter((s) => s && s.id === anchor).length
        if (at !== 1) throw new Refusal(`scene "${scene.id}": insertAfter "${anchor}" ${at ? 'is ambiguous' : 'is not a slide in the deck'}; nothing was written`)
      }
      inserts.set(anchor, [...(inserts.get(anchor) || []), scene])
      inserted.add(scene.id)
      sceneIds.add(scene.id)
      continue
    }
    if (!hits.length) throw new Refusal(`slide "${scene.id}" is not in the deck (scenes/${scene.id}); set insertAfter in its scene.json to add it as a new slide; nothing was written`)
    if (hits.length > 1) throw new Refusal(`slide id "${scene.id}" is used by ${hits.length} slides in the deck, so scenes/${scene.id} is ambiguous; nothing was written`)
    if (!isRuntime(hits[0])) throw new Refusal(`slide "${scene.id}" is a native slide; the splice tool never converts one (a scene needs a runtime slide, or a runtime: {} placeholder, with that id); nothing was written`)
    // AE6: a library scene a person set up is replaced only by a folder that says it is that scene
    const marker = hits[0].runtime.library
    if (marker && typeof marker === 'object' && scene.library !== marker.id) {
      throw new Refusal(`slide "${scene.id}" is the library scene "${marker.id}"; scenes/${scene.id}/scene.json does not declare "library": "${marker.id}", so replacing it would discard what the person set. Change its settings with a values edit, or declare the library id to replace it; nothing was written`)
    }
    sceneIds.add(scene.id)
  }
  if (inserts.size) {
    // Rebuilt from the read order: each anchor keeps its states (the hidden
    // variants that follow it) next to it, and the new slides go after those.
    const out = []
    const place = (anchor, neighbour) => {
      for (const scene of inserts.get(anchor) || []) {
        if (scene.libraryInsert) { out.push(librarySlide(doc, scene.scene, scene.values, scene.id, intern)); continue }
        const slide = { id: scene.id, elements: [] }
        if (neighbour && neighbour.background !== undefined) slide.background = structuredClone(neighbour.background)
        out.push(slide)
      }
    }
    let group = []
    doc.slides.forEach((slide, i) => {
      out.push(slide)
      group.push(slide)
      const owner = slide?.stateOf ?? slide?.id
      if (owner !== undefined && doc.slides[i + 1]?.stateOf === owner) return
      for (const member of group) place(member?.id, member)
      group = []
    })
    place('end', doc.slides[doc.slides.length - 1])
    doc.slides = out
  }
  for (const e of libraryInserts) {
    const where = e.insertAfter === 'end' ? 'the last slide' : `"${e.insertAfter}"`
    plan.push(`  ${e.id}: new library scene "${e.library}" inserted after ${where}${e.preset !== undefined ? `, preset ${JSON.stringify(e.preset)}` : ''}${e.values && Object.keys(e.values).length ? `, ${Object.entries(e.values).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}` : ''}`)
  }
  const pruneKeys = []
  for (const scene of scenes) {
    const slide = byId(scene.id)[0]
    const values = isRuntime(slide) && slide.runtime.values && typeof slide.runtime.values === 'object' ? slide.runtime.values : {}
    const marker = isRuntime(slide) ? slide.runtime.library : undefined
    pruneKeys.push(...applyScene(doc, slide, scene))
    if (marker && scene.library === marker.id) slide.runtime.library = structuredClone(marker)
    if (inserted.has(scene.id)) { plan.push(`  ${scene.id}: new runtime slide inserted after ${scene.insertAfter === 'end' ? 'the last slide' : `"${scene.insertAfter}"`} (source ${kb(scene.src.length)}, still ${kb(scene.still.length)}, ${scene.steps} steps)`); continue }
    plan.push(`  ${scene.id}: runtime slide replaced (source ${kb(scene.src.length)}, still ${kb(scene.still.length)}, ${scene.steps} steps, ${scene.props.length} props${scene.assets.length ? `, assets ${scene.assets.map((a) => `${a.name} ${kb(a.size)}`).join(', ')}` : ''})`)
    // R14 drops them by design; the person who set them should hear about it.
    const dropped = Object.entries(values)
    if (dropped.length) plan.push(`  ${scene.id}: presenter values dropped by the replace: ${dropped.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`)
  }

  const valued = new Map()
  for (const e of valueEdits) {
    const hits = byId(e.slideId)
    if (hits.length !== 1) throw new Refusal(`values edit: slide "${e.slideId}" ${hits.length ? 'is ambiguous' : 'is not in the deck'}; nothing was written`)
    const slide = hits[0]
    if (!isRuntime(slide) || !slide.runtime.library) throw new Refusal(`values edit: slide "${e.slideId}" is not a library scene (it carries no runtime.library); nothing was written`)
    if (sceneIds.has(e.slideId)) throw new Refusal(`values edit: slide "${e.slideId}" is also replaced by a scene folder in this run; do one or the other; nothing was written`)
    try { checkValues(Array.isArray(slide.runtime.props) ? slide.runtime.props : [], e.values, `values edit on slide "${e.slideId}"`) } catch (err) { throw new Refusal(`${err.message}; nothing was written`) }
    const before = slide.runtime.values && typeof slide.runtime.values === 'object' ? slide.runtime.values : {}
    slide.runtime.values = { ...before, ...structuredClone(e.values) }
    const keys = valued.get(e.slideId) || new Set()
    for (const k of Object.keys(e.values)) keys.add(k)
    valued.set(e.slideId, keys)
    plan.push(`  ${e.slideId}: settings ${Object.entries(e.values).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}; every other value kept`)
  }

  const edited = new Map()
  for (const e of contentEdits) {
    const hits = byId(e.slideId)
    if (hits.length !== 1) throw new Refusal(`edit: slide "${e.slideId}" ${hits.length ? 'is ambiguous' : 'is not in the deck'}; nothing was written`)
    if (isRuntime(hits[0]) || sceneIds.has(e.slideId)) throw new Refusal(`edit: slide "${e.slideId}" is a runtime slide; change its scene folder instead; nothing was written`)
    const els = (hits[0].elements || []).filter((el) => el && el.id === e.elementId)
    if (els.length !== 1) throw new Refusal(`edit: element "${e.elementId}" ${els.length ? 'is ambiguous' : 'is not'} on slide "${e.slideId}"; nothing was written`)
    const keys = edited.get(`${e.slideId}\u001f${e.elementId}`) || new Set()
    for (const [k, v] of Object.entries(e)) {
      if (k === 'slideId' || k === 'elementId') continue
      els[0][k] = k === 'src' && typeof v === 'string' && v.startsWith('data:') ? intern(doc, v, 'edit') : structuredClone(v)
      keys.add(k)
    }
    edited.set(`${e.slideId}\u001f${e.elementId}`, keys)
    plan.push(`  ${e.slideId}/${e.elementId}: ${Object.keys(e).filter((k) => k !== 'slideId' && k !== 'elementId').join(', ')}`)
  }

  const gone = prune(doc, pruneKeys)
  if (gone.length) plan.push(`  assets no longer referenced, removed: ${gone.join(', ')}`)
  checkOwnership(read, doc, { scenes: sceneIds, edits: edited, inserted, title, valued })
  return { doc, plan }
}

/**
 * KTD8, as a diff of the document to write against the one read. Throws a
 * Refusal naming the first offending id. `scenes` is the set of runtime slide
 * ids being replaced or inserted; `edits` maps "slideId U+001F elementId" to
 * the keys an edit set on that element; `inserted` is the set of new runtime
 * slide ids, the only slides the output may have that the read did not.
 * `title` is the --title value; only then may doc.title change, and only to it.
 */
export function checkOwnership(read, out, { scenes, edits, inserted = new Set(), title, valued = new Map() }) {
  for (const k of new Set([...Object.keys(read), ...Object.keys(out)])) {
    if (k === 'assets' || k === 'slides') continue
    if (k === 'title' && title !== undefined && out.title === title) continue
    if (!same(read[k], out[k])) throw new Refusal(`document key "${k}" would change; the splice tool changes slides only`)
  }
  const ids = (d) => (d.slides || []).map((s) => s?.id)
  const readIds = ids(read)
  for (const nid of inserted) {
    if (readIds.includes(nid) || ids(out).filter((x) => x === nid).length !== 1) throw new Refusal(`slide "${nid}" cannot be inserted: the id is already in the deck; nothing was written`)
    if (!isRuntime(out.slides.find((s) => s?.id === nid)) || !scenes.has(nid)) throw new Refusal(`slide "${nid}": only a runtime slide from a scene folder may be inserted; nothing was written`)
  }
  const kept = (out.slides || []).filter((s) => !inserted.has(s?.id))
  if (!same(readIds, kept.map((s) => s?.id))) throw new Refusal('slide order or count would change; slide order belongs to the person editing the deck')
  read.slides.forEach((before, i) => {
    const after = kept[i]
    const sid = before.id
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (k === 'elements') continue
      if (k === 'runtime' && scenes.has(sid)) continue
      if (k === 'runtime' && valued.has(sid)) {
        // a values edit: the record is the same but for the named settings
        const allowed = valued.get(sid)
        const { values: bv = {}, ...brest } = before.runtime || {}
        const { values: av = {}, ...arest } = after.runtime || {}
        if (!same(brest, arest)) throw new Refusal(`slide "${sid}": a values edit would change more of the scene than its settings; nothing was written`)
        for (const vk of new Set([...Object.keys(bv), ...Object.keys(av)])) {
          if (!allowed.has(vk) && !same(bv[vk], av[vk])) throw new Refusal(`slide "${sid}": setting "${vk}" would change, and no values edit names it; nothing was written`)
        }
        continue
      }
      if (!same(before[k], after[k])) throw new Refusal(`slide "${sid}": "${k}" would change; only element content may change on a native slide`)
    }
    if (scenes.has(sid)) {
      if (!isRuntime(before)) throw new Refusal(`slide "${sid}" is a native slide; the splice tool never converts one`)
      // A replace keeps only the still. Anything else on the slide (a paste, an
      // older shell's extra, a co-editor's addition) would vanish silently.
      const holder = stillHolder(before)
      const extra = (before.elements || []).filter((el) => el !== holder).map((el) => el?.id)
      if (extra.length) {
        throw new Refusal(`runtime slide "${sid}" holds elements other than its still (${extra.map((x) => JSON.stringify(x)).join(', ')}); replacing it would delete them. Move them to a native slide or delete them in the editor, then run again; nothing was written`)
      }
      return
    }
    const bEls = before.elements || [], aEls = after.elements || []
    if (!same(bEls.map((e) => e?.id), aEls.map((e) => e?.id))) throw new Refusal(`slide "${sid}": elements would be added, removed or reordered`)
    bEls.forEach((b, j) => {
      const a = aEls[j]
      const allowed = edits.get(`${sid}\u001f${b.id}`) || new Set()
      for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
        if (same(b[k], a[k])) continue
        if (GEOMETRY.has(k)) {
          throw new Refusal(`element "${b.id}" on slide "${sid}": ${k} would change from ${JSON.stringify(b[k])} to ${JSON.stringify(a[k])}; position, size and rotation belong to the person editing the deck; nothing was written`)
        }
        if (k !== CONTENT_KEY[b.type] || !allowed.has(k)) {
          throw new Refusal(`element "${b.id}" on slide "${sid}": "${k}" is not a content change the splice tool may make on a ${b.type} element (only ${CONTENT_KEY[b.type] || 'nothing'}); nothing was written`)
        }
      }
    })
  })
}

// ---- the store -----------------------------------------------------------------------

/**
 * Where a grant is remembered, or null when there is nowhere.
 *
 * The home directory, never the working directory: that is whatever folder the
 * deck is being built in, and a grant left there travels with the folder for
 * as long as it lives. `SLIDES_GRANT_FILE` overrides it, which is how the rigs
 * keep a developer's real grant out of a test run and how a shell with no home
 * directory says where to keep one.
 */
function grantPath(env) {
  if (env[GRANT_FILE_ENV]) return env[GRANT_FILE_ENV]
  const home = env.HOME || env.USERPROFILE
  return home ? join(home, '.bento', 'slides-grant.json') : null
}

/** The remembered grant, or null. Never throws: an unreadable file is no grant. */
function readGrant(env) {
  const path = grantPath(env)
  if (!path || !existsSync(path)) return null
  try {
    const g = JSON.parse(readFileSync(path, 'utf8'))
    if (g && typeof g.grant === 'string' && g.grant && typeof g.store === 'string') return { ...g, path }
  } catch { /* a corrupt file is the same as no file */ }
  return null
}

/** Write `record` where only its owner can read it, whatever was there before. */
function writePrivate(path, record) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  // Removed first: `mode` applies only when the file is created, and a secret
  // must never spend a moment in a file someone else could already read.
  rmSync(path, { force: true })
  // 'wx': something put at this path since the line above is not written into.
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  chmodSync(path, 0o600)
}

/** Remember a grant, readable by nobody else. Returns the path it landed in. */
function writeGrant(env, record) {
  const path = grantPath(env)
  try {
    writePrivate(path, record)
    return path
  } catch (e) {
    throw new Error(`the approval could not be saved in ${path} (${e.message}); set ${GRANT_FILE_ENV} to a file this shell can write, outside the deck folder`)
  }
}

/**
 * Refuse BEFORE the person is asked for anything when the approval could not
 * be kept: a click whose grant cannot be saved is a click wasted, and the
 * grant it minted stays live on their list with nothing holding it.
 */
function grantPlace(env, again) {
  const path = grantPath(env)
  if (!path) throw new Refusal(`this shell has no home directory to keep an approval in, and the tool does not write one beside the deck. Set ${GRANT_FILE_ENV} to a file outside the deck folder and run ${again} again.`)
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    accessSync(dirname(path), fsConstants.W_OK)
    if (existsSync(path) && !statSync(path).isFile()) throw new Error(`${path} is not a file`)
  } catch (e) {
    throw new Refusal(`the approval could not be kept in ${path} (${e.message}). Set ${GRANT_FILE_ENV} to a file this shell can write, outside the deck folder, and run ${again} again.`)
  }
  return path
}

/** Forget a grant that the store has stopped accepting. */
function forgetGrant(path) {
  try { if (path) rmSync(path, { force: true }) } catch { /* nothing to do about it */ }
}

/**
 * Is this saved approval over?
 *
 * A grant file with no readable `expires` counts as EXPIRED, not as live: the
 * field is the only local signal there is, so an unreadable one means the file
 * cannot be trusted to still be good. Erring the other way turned a truncated
 * file into a store 401 blamed on the person.
 */
const expiredGrant = (g) => {
  const t = Date.parse(g?.expires || '')
  return !Number.isFinite(t) || t <= Date.now()
}

/** The store URL and request timeouts, read the same way by every command. */
function storeEnv(env) {
  let override
  if (env.SPLICE_TIMEOUT_MS !== undefined && env.SPLICE_TIMEOUT_MS !== '') {
    override = Number(env.SPLICE_TIMEOUT_MS)
    if (!Number.isFinite(override) || override <= 0) throw new Refusal('SPLICE_TIMEOUT_MS must be a positive number of milliseconds')
  }
  return {
    store: (env.SLIDES_STORE_URL || 'https://slides.betamobility.ai').replace(/\/+$/, ''),
    timeout: (kind) => override ?? TIMEOUT[kind],
  }
}

/**
 * Which credential this run uses, and therefore which API it talks to.
 *
 * THE SERVICE TOKEN WINS when its variables are set. It belongs to a machine,
 * so a grant file left over from a pairing must never quietly reroute that run
 * — and a HALF-SET pair is a refusal naming the missing variable, rather than
 * a silent fall-through to a weaker credential.
 *
 * A grant is used only while it is unexpired and belongs to the store this run
 * is talking to: `harness()` already refuses to follow a redirect off-origin,
 * and this stops a stale file from sending a bearer to a different host at all.
 *
 * WITH NEITHER, THE RUN PAIRS: it prints the approval link, waits for the
 * click and carries on (upstream-merge plan, U6/KTD6). Nobody is told to fetch
 * a token. The one exception is a run with `CI` set (to any value), where
 * nobody is there to click: that refuses and starts no pairing. `CI` and not a TTY test, because
 * an agent's shell has no TTY while a person is very much there.
 */
/** Is this a machine run? A half-set token pair is refused, never read as "no token". */
function hasToken(env) {
  if (!env.CF_ACCESS_CLIENT_ID && !env.CF_ACCESS_CLIENT_SECRET) return false
  for (const k of ['CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET']) {
    if (!env[k]) throw new Refusal(`${k} is not set; a machine run needs both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET. Unset both to publish with a browser approval instead`)
  }
  return true
}

async function access(env, log) {
  const { store, timeout } = storeEnv(env)

  if (hasToken(env)) {
    return {
      store, api: `${store}/api/harness`, timeout,
      auth: { 'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET },
      credential: 'the service token',
    }
  }

  let grant = readGrant(env)
  if (grant && grant.store.replace(/\/+$/, '') !== store) {
    throw new Refusal(`the saved approval is for another store (${grant.store}, this run talks to ${store}); run splice.mjs --link against this one`)
  }
  if (!grant || expiredGrant(grant)) {
    if (grant) forgetGrant(grant.path)
    // Set at all, even to "" or "false": the plan's one signal, read literally,
    // so a machine run can never be mistaken for a person by its value.
    if (env.CI !== undefined) {
      throw new Refusal(grant
        ? 'the approval expired, and CI is set, so no new approval link was started; run splice.mjs --link where a person can open a browser'
        : 'no way in to the deck store, and CI is set, so no approval link was started: run splice.mjs --link where a person can open a browser, or set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET for a machine run')
    }
    grant = await link({ env, log, again: 'the same command' })
  }
  return {
    store, api: `${store}/api/publish`, timeout,
    auth: { authorization: `Bearer ${grant.grant}` },
    credential: 'the approval', grantPath: grant.path, owner: grant.owner,
  }
}

const secs = (ms) => ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`

/**
 * A request that failed before an answer arrived, as one line naming it. A
 * write that timed out may still have landed (sent, answer lost), so only a
 * GET may say nothing was written. `unknown` marks that case for callers.
 */
function netError(method, url, e, ms) {
  const timedOut = e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError'
  const err = new Error(`${method} ${url} ${timedOut ? `timed out after ${secs(ms)} with no answer` : `failed (${e?.cause?.message || e?.message})`}. ${method === 'GET' ? 'Nothing was written by this request.' : 'The store may or may not have applied it.'}`)
  err.unknown = method !== 'GET'
  return err
}

/**
 * A harness request that never follows a redirect and gives up after `ms`.
 * fetch turns a followed 301 on a PUT or POST into a GET, and the GET of a
 * deck answers 200: the write would report success having written nothing.
 * The retired store host still answers 301, so this is not hypothetical.
 */
async function harness(url, init, ms) {
  const method = init?.method || 'GET'
  let res
  try {
    res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(ms) })
  } catch (e) {
    throw netError(method, url, e, ms)
  }
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`${method} ${url} was redirected (${res.status}${res.headers.get('location') ? ` to ${res.headers.get('location')}` : ''}); set SLIDES_STORE_URL to the store's current host. Nothing was written by this request.`)
  }
  return res
}

/** A response body; the request's timeout signal still runs while it streams. */
async function bodyText(res, method, url, ms) {
  try { return await res.text() } catch (e) { throw netError(method, url, e, ms) }
}

/**
 * A refusal from the store, in the terms of the credential actually sent.
 *
 * With a grant, a 401 means the approval is over — it lapsed, or the person
 * revoked it from the deck list — and there is nothing to check in an
 * environment variable. The stale file is deleted so the next run pairs
 * cleanly rather than failing the same way (R16).
 */
async function failed(res, what, cfg) {
  const body = (await res.text().catch(() => '')).slice(0, 300)
  if (res.status === 401 && cfg?.grantPath) {
    forgetGrant(cfg.grantPath)
    return new Refusal(`${what}: the approval is no longer valid; run splice.mjs --link and ask the person to approve publishing again`)
  }
  // Only a run that SENT the token is told to check it: a person holding an
  // approval, or nothing at all, must never be sent after one.
  if ((res.status === 401 || res.status === 403) && cfg && !cfg.grantPath) return new Error(`${what}: ${res.status}; the service token was not accepted (check CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET)`)
  if (res.status === 403 && cfg?.grantPath) {
    // Forgotten, as on a 401: with the file in place the `--link` this names
    // would answer "already approved" and the next run would be refused again.
    forgetGrant(cfg.grantPath)
    return new Refusal(`${what}: the store refused this approval (403); run splice.mjs --link and ask the person to approve again, and tell the maintainer if it repeats`)
  }
  return new Error(`${what}: the store answered ${res.status}${body ? ` (${body})` : ''}`)
}

/** Upload every scene asset once per name; `uploaded` fills as they land, so a failure knows what is already there. */
async function uploadAssets(cfg, id, scenes, log, uploaded) {
  const done = new Set() // readProject guarantees one name holds one set of bytes
  for (const scene of scenes) {
    for (const a of scene.assets) {
      if (done.has(a.name)) continue
      const what = `uploading ${a.name} for scene "${scene.id}"`
      let res
      try {
        res = await harness(`${cfg.api}/decks/${id}/assets/${encodeURIComponent(a.name)}`, {
          method: 'PUT', headers: { ...cfg.auth, 'content-type': a.type }, body: readFileSync(a.path),
        }, cfg.timeout('asset'))
      } catch (e) { e.message = `${what}: ${e.message}`; throw e }
      if (!res.ok) throw await failed(res, what, cfg)
      done.add(a.name)
      uploaded.push(a.name)
      log(`  uploaded ${a.name} (${kb(a.size)})`)
    }
  }
}

// ---- the url framing check --------------------------------------------------------------

/** Does a CSP source expression allow FRAMING_ORIGIN? */
function sourceAllows(src) {
  const s = src.toLowerCase()
  if (s === '*' || s === 'https:' || s === 'http:') return true
  const m = /^(?:(https?):\/\/)?(\*\.)?([a-z0-9.-]+)(?::(\d+|\*))?\/?$/.exec(s)
  if (!m || (m[4] && m[4] !== '443' && m[4] !== '*')) return false
  const host = new URL(FRAMING_ORIGIN).hostname
  return m[2] ? host.endsWith(`.${m[3]}`) : host === m[3]
}

/**
 * Why these response headers stop FRAMING_ORIGIN framing the page, or ''.
 * Every enforced policy must allow it; report-only policies do not block.
 */
export function refusesFraming(headers) {
  const xfo = (headers.get('x-frame-options') || '').toLowerCase()
  if (/\bdeny\b/.test(xfo)) return 'X-Frame-Options: DENY'
  if (/\bsameorigin\b/.test(xfo)) return 'X-Frame-Options: SAMEORIGIN'
  // Several CSP headers arrive joined with ", "; a comma never occurs inside one policy's source list.
  for (const policy of (headers.get('content-security-policy') || '').split(',')) {
    for (const directive of policy.split(';')) {
      const [name, ...sources] = directive.trim().split(/\s+/)
      if ((name || '').toLowerCase() !== 'frame-ancestors') continue
      if (!sources.some(sourceAllows)) return `Content-Security-Policy frame-ancestors ${sources.join(' ') || "(empty, the same as 'none')"}`
    }
  }
  return ''
}

/** One GET of `url` (one redirect followed): { refuse } when the page will not be framed, { warn } when it could not be checked. */
export async function checkFraming(url, ms) {
  let target = url
  for (let hop = 0; ; hop++) {
    let res
    try {
      res = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(ms) })
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError'
      return { warn: timedOut ? `no answer within ${secs(ms)}` : (e?.cause?.message || e?.message) }
    }
    res.body?.cancel().catch(() => {})
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= 1) return { warn: `redirected more than once (${res.status} to ${location})` }
      target = new URL(location, target).href
      continue
    }
    const why = refusesFraming(res.headers)
    if (why) return { refuse: `answers ${res.status}${target !== url ? ` (after a redirect to ${target})` : ''} with ${why}` }
    return res.ok ? {} : { warn: `it answered ${res.status}` }
  }
}

async function checkUrls(scenes, cfg, warn) {
  for (const scene of scenes) {
    if (!scene.url) continue
    const v = await checkFraming(scene.url, cfg.timeout('url'))
    if (v.refuse) {
      throw new Refusal(`scene "${scene.id}": ${scene.url} ${v.refuse}, so ${FRAMING_ORIGIN} cannot frame it and the slide would show only its still. Host the page where it may be framed, or drop url so the inlined scene runs; pass --skip-url-check only if you know the page allows framing. Nothing was written`)
    }
    if (v.warn) warn(`warning: scene "${scene.id}": could not check whether ${scene.url} allows framing (${v.warn}); if it refuses, the slide shows only its still`)
  }
}

// ---- pairing ------------------------------------------------------------------------------

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** A pairing that ended with no grant: whether anyone was asked, and what to run again. */
const lapsed = (answered, again) => answered
  ? `nobody approved the pairing before it expired. Nothing was published and nothing in the store was changed; what is on disk is untouched. Run ${again} again when someone is at a browser.`
  : `the pairing expired without the store ever answering this run. Nothing was published and nothing in the store was changed; what is on disk is untouched. Run ${again} again.`

/**
 * `--link`: pair with the store, so an agent with no credential can publish
 * as the person who approves (one-click publish plan, U5; R1, R14, R16).
 *
 * The three lines this prints ARE the user experience: one instruction, one
 * link to click, and afterwards who it acts as and until when. Never the
 * grant — the token goes to the grant file, at mode 0600, and nowhere else,
 * because an agent's stdout is transcript, log and context all at once.
 *
 * The deadline comes from the store's own `expires`, not a number here: the
 * pairing's lifetime is the store's to decide and to change.
 *
 * `again` is what a failed pairing tells the reader to run once more: `--link`
 * when that was the command, "the same command" when a deck run paired by
 * itself. Returns the grant as `readGrant` would, for that second caller.
 *
 * The pairing lives in this process and nowhere else. Remembering it on disk
 * so a killed run could be resumed was built and removed (docs/DECISIONS.md,
 * 2026-10-13): it needed a lock between runs and kept failing review.
 */
export async function link({ env = process.env, log = console.log, force = false, again = '--link' } = {}) {
  const { store, timeout } = storeEnv(env)
  const ms = timeout('store')

  // An agent that re-runs --link defensively must not cost the person another
  // click: one approval covers a week and any number of decks, so say so and
  // stop rather than starting a second pairing.
  const held = readGrant(env)
  if (!force && held && !expiredGrant(held) && held.store.replace(/\/+$/, '') === store) {
    log(`Already approved by ${held.owner}, until ${held.expires}. Nothing to do; publish as usual.`)
    return held
  }
  grantPlace(env, again)

  const startUrl = `${store}/api/link/start`
  const res = await harness(startUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: env[LABEL_ENV] || LINK_LABEL }),
  }, ms)
  if (res.status === 503) throw new Error(`${startUrl}: the store cannot start pairings right now (its rate limiter is not configured); tell the maintainer`)
  if (res.status === 429) throw new Refusal(`the store is refusing new pairings for a moment (too many just now); wait a minute and run ${again} again`)
  if (!res.ok) throw await failed(res, 'starting the pairing')
  let started
  try { started = JSON.parse(await bodyText(res, 'POST', startUrl, ms)) } catch { throw new Error('starting the pairing: the store answered 200 but its body did not parse') }
  const { code, handle, url, expires } = started
  if (typeof handle !== 'string' || !handle) throw new Error('starting the pairing: the store gave no handle to collect the approval with')

  // Read by an agent as often as by a person, so it says whose click it is.
  log('Show this link to the person: they open it and click Approve (their click, never yours). This run waits up to ten minutes and carries on as soon as they have; keep it running.')
  log(url || `${store}/link/${code}`)

  const deadline = Date.parse(expires) || Date.now() + 10 * 60 * 1000
  // The handle is a bearer for the grant until it is collected: it is never
  // printed, so neither is this URL, in any message below.
  const pollUrl = `${store}/api/link/${handle}`
  // `answered` tells a pairing nobody clicked apart from one where the store
  // never got a word in to us. Without it, a run throttled or disconnected for
  // its whole window reports that the person did not approve — which may be
  // the exact opposite of what happened.
  let answered = false
  let backoff = POLL_MS
  for (let first = true; ; first = false) {
    let left = deadline - Date.now()
    if (!first) {
      // Never past the pairing's own lifetime: the last wait is cut short so
      // the last poll still fits before the deadline, and a pairing with less
      // than that left is over.
      if (left <= LAST_POLL_MS) break
      await wait(Math.min(backoff, left - LAST_POLL_MS))
      left = deadline - Date.now()
    }
    let poll
    try {
      poll = await harness(pollUrl, {}, Math.max(1, Math.min(ms, left)))
    } catch {
      // A dropped connection must not end the pairing: the person may be about
      // to click, or may already have, and this handle is the only thing that
      // can collect the grant. Back off and keep asking until the deadline.
      backoff = Math.min(backoff * 2, 15_000)
      if (first) log('  (the store did not answer just now; still waiting)')
      continue
    }
    if (poll.status === 202) { answered = true; backoff = POLL_MS; continue } // nobody has clicked yet
    // The limiter, not the person. Back off so the polling stops competing
    // with its own budget, and keep waiting.
    if (poll.status === 429) { backoff = Math.min(backoff * 2, 15_000); continue }
    if (poll.status === 410) throw new Refusal(lapsed(answered, again))
    if (poll.status === 503) throw new Error('waiting for the approval: the store cannot answer pairings right now (its rate limiter is not configured); tell the maintainer')
    // NOT `failed()`: this route takes no credential, so its wording about
    // CF_ACCESS_* would send the reader after the wrong thing entirely.
    if (!poll.ok) throw new Error(`waiting for the approval: the store answered ${poll.status} on a route that needs no credential`)
    answered = true
    // A 200 is the store handing the grant over, once. An answer that stalls or
    // arrives broken is that one delivery lost, the same as an empty one.
    let body = null
    try { body = JSON.parse(await poll.text()) } catch { /* lost in transit */ }
    if (!body?.grant) {
      // The store minted a grant and handed it to whoever held this handle —
      // which is this tool, so our own answer was lost in transit. It cannot
      // be repeated: the store keeps only a hash of it.
      throw new Refusal(`the approval went through, but the answer carrying it was lost. Run ${again} again; the person will have to approve once more.`)
    }
    const grant = { grant: body.grant, owner: body.owner, expires: body.expires, store }
    const path = writeGrant(env, grant)
    log(`Approved by ${body.owner}. I can publish as them until ${body.expires}.`)
    log(`(kept in ${path}, readable only by you; nothing else was written)`)
    return { ...grant, path }
  }
  throw new Refusal(lapsed(answered, again))
}

// ---- the scene library -------------------------------------------------------------------

/**
 * The scene library, read with the run's credential from the route that
 * credential reaches (KTD8): /api/harness/library.json for the service token,
 * /api/publish/library.json for an approval. A store with no library yet
 * answers 404.
 */
async function fetchLibrary(cfg) {
  const ms = cfg.timeout('store')
  const url = `${cfg.api}/library.json`
  const res = await harness(url, { headers: { ...cfg.auth, accept: 'application/json' } }, ms)
  if (res.status === 404) throw new Refusal('the store has no scene library yet (its manifest has not been uploaded)')
  if (!res.ok) throw await failed(res, 'reading the scene library', cfg)
  let json
  try { json = JSON.parse(await bodyText(res, 'GET', url, ms)) } catch (e) { throw new Refusal(`the scene library does not parse: ${e.message}`) }
  try { return readLibrary(json) } catch (e) { throw new Refusal(e.message) }
}

/** `--library`: what the store offers, as the skill needs it to write a library insert. */
export async function listLibrary({ env = process.env, log = console.log } = {}) {
  const cfg = await access(env, log)
  const { scenes, skipped } = await fetchLibrary(cfg)
  log(`scene library (read with ${cfg.credential}): ${scenes.size} scene${scenes.size === 1 ? '' : 's'}`)
  for (const s of scenes.values()) {
    log(`\n${s.id}  v${s.version}  ${s.kind === 'web' ? 'web scene (insert it from the editor)' : 'runtime scene'}  ${JSON.stringify(s.name)}`)
    if (s.description) log(`  ${s.description}`)
    for (const p of s.props) log(`  setting ${p.key}: ${p.kind}${p.format ? ` (${p.format})` : ''}, default ${JSON.stringify(p.default)}  ${JSON.stringify(p.label)}`)
    for (const pr of s.presets) log(`  preset ${JSON.stringify(pr.name)}${Object.keys(pr.values ?? {}).length ? `: ${Object.entries(pr.values).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}` : ' (the defaults)'}`)
  }
  for (const x of skipped) log(`\nnot offered: ${x}`)
}

// ---- read ---------------------------------------------------------------------------------

/**
 * `--read <deckId>`: the deck as it is now, and the ids an edit needs.
 *
 * This exists because the documented "read before you write" step was a curl
 * carrying `CF_ACCESS_CLIENT_ID`, which a paired session does not have — so
 * the whole "fix a typo in an existing deck" path dead-ended for exactly the
 * sessions pairing was built for, at the step that comes before every edit.
 * Going through `cfg` instead means it works with either way in, and the
 * bearer never appears in a command an agent types or a transcript keeps.
 *
 * The file is written rather than printed (a deck is about a megabyte), and
 * what IS printed is the inventory an `edits.json` is built from: every slide,
 * which are runtime slides the tool replaces wholesale, and every native
 * element with the one key an edit may change.
 */
export async function read(id, { out, env = process.env, log = console.log } = {}) {
  if (!/^[0-9A-Za-z]{10}$/.test(id)) throw new Refusal(`"${id}" is not a deck id (ten letters and digits, the end of /d/<id>)`)
  const cfg = await access(env, log)
  const ms = cfg.timeout('store')
  const url = `${cfg.api}/decks/${id}`
  const res = await harness(url, { headers: cfg.auth }, ms)
  if (res.status === 404) throw new Refusal(`deck ${id} is not in the store`)
  if (!res.ok) throw await failed(res, `reading deck ${id}`, cfg)
  const html = await bodyText(res, 'GET', url, ms)
  const file = out || `${id}.bento.html`
  writeFileSync(file, html)
  let doc
  try { doc = readBlock(html) } catch (e) { throw new Refusal(`deck ${id}: ${e.message}`) }
  log(`${file}  (${kb(Buffer.byteLength(html))}, read with ${cfg.credential})`)
  if (isEncrypted(doc)) {
    log('the deck is encrypted; the tool cannot read inside it')
    return
  }
  log(`title: ${doc.title || '(untitled)'}`)
  for (const s of Array.isArray(doc.slides) ? doc.slides : []) {
    if (isRuntime(s) && s.runtime.library && typeof s.runtime.library === 'object') {
      const v = s.runtime.values && typeof s.runtime.values === 'object' ? s.runtime.values : {}
      const shown = (Array.isArray(s.runtime.props) ? s.runtime.props : []).map((p) => `${p.key}=${JSON.stringify(Object.prototype.hasOwnProperty.call(v, p.key) ? v[p.key] : p.default)}`)
      log(`  ${s.id}  (library scene "${s.runtime.library.id}" v${s.runtime.library.version}: change its settings with a values edit)${shown.length ? `: ${shown.join(', ')}` : ''}`)
      continue
    }
    if (isRuntime(s)) { log(`  ${s.id}  (runtime slide: replace it with a scene folder)`); continue }
    const els = (Array.isArray(s.elements) ? s.elements : [])
      .filter((e) => e && CONTENT_KEY[e.type])
      .map((e) => `${e.id} (${e.type}: ${CONTENT_KEY[e.type]})`)
    log(`  ${s.id}${s.stateOf ? ` [state of ${s.stateOf}]` : ''}${els.length ? `: ${els.join(', ')}` : ': nothing an edit may change'}`)
  }
}

// ---- update and create --------------------------------------------------------------------

export async function update(id, dir, { edits: editsFile, title, dryRun = false, skipUrlCheck = false, env = process.env, log = console.log, warn = console.error } = {}) {
  if (!/^[0-9A-Za-z]{10}$/.test(id)) throw new Refusal(`"${id}" is not a deck id (ten letters and digits, the end of /d/<id>)`)
  if (title !== undefined && (typeof title !== 'string' || !title.trim())) throw new Refusal('--title must be a non-empty title')
  const project = readProject(dir)
  const edits = readEdits(editsFile)
  if (!project.scenes.length && !edits.length && title === undefined) {
    throw new Refusal(`nothing to do: ${dir ? `no scene folders in ${join(dir, 'scenes')}` : 'no project folder'}, no edits and no --title`)
  }
  // Before the way in: a run that is going to refuse must not cost a click.
  if (!skipUrlCheck) await checkUrls(project.scenes, storeEnv(env), warn)
  const cfg = await access(env, log)
  const ms = cfg.timeout('store')
  // read once: the manifest does not change between retries
  const library = edits.some((e) => e.library !== undefined) ? await fetchLibrary(cfg) : undefined
  const deckUrl = `${cfg.api}/decks/${id}`
  let uploadsDone = false
  const uploaded = []
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = await harness(deckUrl, { headers: cfg.auth }, ms)
      if (res.status === 404) throw new Refusal(`deck ${id} is not in the store`)
      if (!res.ok) throw await failed(res, `reading deck ${id}`, cfg)
      // x-bento-etag first: Cloudflare drops a strong etag from the compressed
      // HTML a deck read returns, and a write without one is impossible.
      const etag = res.headers.get('x-bento-etag') || res.headers.get('etag')
      const html = await bodyText(res, 'GET', deckUrl, ms)
      let read
      try { read = readBlock(html) } catch (e) { throw new Refusal(`deck ${id}: ${e.message}`) }
      if (isEncrypted(read)) throw new Refusal(`deck ${id} is encrypted (a bento/enc envelope); the splice tool does not decrypt, so it cannot change it`)
      if (read.format !== 'bento/slides') throw new Refusal(`deck ${id} is not a bento/slides document`)
      const { doc, plan } = derive(read, project, edits, { title, library })
      if (dryRun) {
        log(`dry run, deck ${id}; would write:`)
        for (const l of plan) log(l)
        log('nothing was written')
        return
      }
      if (!etag) throw new Error(`reading deck ${id}: the store sent no ETag, so a conditional write is impossible`)
      // Before the write, because the deck will name them; once, after the
      // first derivation passed every check: the names are the same on every
      // retry and a re-upload would only repeat the bytes.
      if (!uploadsDone) { await uploadAssets(cfg, id, project.scenes, log, uploaded); uploadsDone = true }
      let put
      try {
        put = await harness(deckUrl, {
          method: 'PUT',
          headers: { ...cfg.auth, 'if-match': etag, 'content-type': 'text/html; charset=utf-8' },
          body: writeBlock(html, doc),
        }, ms)
      } catch (e) { if (e.unknown) e.deckWriteUnknown = true; throw e }
      if (put.ok) {
        for (const l of plan) log(l)
        log(`${cfg.store}/d/${id}`)
        return
      }
      if (put.status !== 412) throw await failed(put, `writing deck ${id}`, cfg)
      if (attempt < MAX_ATTEMPTS) log(`  deck ${id} changed since it was read; reading again (retry ${attempt} of ${MAX_ATTEMPTS - 1})`)
    }
    const conflict = new Error(`deck ${id} changed on every one of ${MAX_ATTEMPTS} attempts; the owner probably has the deck open. Ask them to close it (or wait until they stop editing) and run again.`)
    conflict.conflict = true
    throw conflict
  } catch (e) {
    // Assets go up before the deck write, so a run that fails after them has
    // changed the asset route even though the deck itself was not written.
    const assets = uploaded.length ? ` Already uploaded to deck ${id}'s assets, and left there: ${uploaded.join(', ')}.` : ''
    // A refusal on a re-derivation after a 412 ends "nothing was written",
    // which stopped being true when the assets went up.
    if (assets) e.message = e.message.replace(/[;.]?\s*[Nn]othing was written\.?$/, '.')
    if (e.deckWriteUnknown) e.message += ` Whether deck ${id} itself changed is not known; read it before running again.${assets}`
    else if (assets) e.message += `${assets} The deck itself was not changed.`
    else if (e.conflict) e.message += ' The deck was not changed.'
    throw e
  }
}

export async function create(dir, { dryRun = false, skipUrlCheck = false, env = process.env, log = console.log, warn = console.error } = {}) {
  const project = readProject(dir, { create: true })
  // The way in is asked for last, just before the one request that needs it:
  // the framing check, the public template and a dry run all come first, so
  // neither a refusal nor a dry run ever costs the person a click.
  const { store, timeout } = storeEnv(env)
  hasToken(env) // a half-set token refuses now, as it will at the real run
  if (!skipUrlCheck) await checkUrls(project.scenes, { timeout }, warn)
  const ms = timeout('store')
  // Public path; the same template GET /new/blank mints from.
  const templateUrl = `${store}/templates/blank.bento.html`
  let res
  try {
    res = await fetch(templateUrl, { redirect: 'follow', signal: AbortSignal.timeout(ms) })
  } catch (e) {
    throw netError('GET', templateUrl, e, ms)
  }
  if (!res.ok) throw await failed(res, 'fetching the blank template')
  const html = await bodyText(res, 'GET', templateUrl, ms)
  const doc = readBlock(html)
  if (doc.format !== 'bento/slides') throw new Error('the blank template is not a bento/slides document')
  // As server/deck-store/src/pages.js mintDocIntoBlock: a deck, not a
  // template, with an identity of its own and no inherited live session.
  delete doc.template
  delete doc.collab
  doc.docId = randomUUID()
  if (typeof project.deck.title === 'string') doc.title = project.deck.title
  doc.slides = structuredClone(project.deck.slides)
  const plan = []
  for (const scene of project.scenes) {
    // A deck.json slide with the scene's id holds its place; otherwise the
    // runtime slide goes after the native ones.
    let slide = doc.slides.find((s) => s.id === scene.id)
    if (!slide) doc.slides.push(slide = { id: scene.id, elements: [] })
    applyScene(doc, slide, scene)
    plan.push(`  ${scene.id}: runtime slide (source ${kb(scene.src.length)}, still ${kb(scene.still.length)}, ${scene.steps} steps)`)
  }
  if (!doc.slides.length) throw new Refusal('deck.json has no slides and there are no scenes; nothing to create')
  if (dryRun) {
    log(`dry run; would create "${doc.title}" with ${doc.slides.length} slides:`)
    for (const s of doc.slides) log(`  ${s.id}${isRuntime(s) ? ' (runtime)' : ''}`)
    for (const l of plan) log(l)
    log('nothing was written')
    return
  }
  const cfg = await access(env, log)
  const postUrl = `${cfg.api}/decks`
  const post = await harness(postUrl, {
    method: 'POST', headers: { ...cfg.auth, 'content-type': 'text/html; charset=utf-8' }, body: writeBlock(html, doc),
  }, ms)
  if (post.status !== 201) throw await failed(post, 'creating the deck', cfg)
  const answer = await bodyText(post, 'POST', postUrl, ms)
  let id, url
  try { ({ id, url } = JSON.parse(answer)) } catch { throw new Error(`creating the deck: the store answered 201 but its body did not parse, so the new deck's id is unknown (${answer.slice(0, 200)})`) }
  const link = url || `${cfg.store}/d/${id}`
  // Printed now, not at the end: if an upload fails, the deck still exists.
  log(`created deck ${id}: ${link}`)
  const uploaded = []
  try {
    await uploadAssets(cfg, id, project.scenes, log, uploaded)
  } catch (e) {
    e.message = `deck ${id} was created (${link}), but ${e.message}${uploaded.length ? ` Uploaded before the failure: ${uploaded.join(', ')}.` : ''} Run splice.mjs ${id} ${dir} to upload the assets again; do not run --create a second time.`
    throw e
  }
  for (const l of plan) log(l)
  log(link)
}

// ---- command line ---------------------------------------------------------------------

const USAGE = `usage:
  node splice.mjs --link
  node splice.mjs --read <deckId> [--out <file>]
  node splice.mjs --library
  node splice.mjs <deckId> <projectDir> [--edits edits.json] [--title "<title>"] [--dry-run] [--skip-url-check]
  node splice.mjs <deckId> --edits edits.json [--title "<title>"] [--dry-run]
  node splice.mjs <deckId> --title "<title>" [--dry-run]
  node splice.mjs --create <projectDir> [--dry-run] [--skip-url-check]`

export async function main(argv) {
  const args = [...argv]
  const flag = (n) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true }
  // undefined: the option is absent; null: it is present without a value.
  const value = (n) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v === undefined || v.startsWith('--') ? null : v }
  const dryRun = flag('--dry-run')
  const isLink = flag('--link')
  const isRead = flag('--read')
  const isLibrary = flag('--library')
  const isCreate = flag('--create')
  const skipUrlCheck = flag('--skip-url-check')
  const edits = value('--edits')
  const title = value('--title')
  const out = value('--out')
  try {
    if (edits === null || title === null || out === null) { console.error(USAGE); return 2 }
    // `--link` takes nothing else: it is the pairing, not a deck operation.
    if (isLink && !isCreate && !isRead && args.length === 0 && edits === undefined && title === undefined && !dryRun) await link({})
    else if (isLink) { console.error(USAGE); return 2 }
    else if (isLibrary && !isRead && !isCreate && args.length === 0 && edits === undefined && title === undefined && out === undefined && !dryRun) await listLibrary({})
    else if (isLibrary) { console.error(USAGE); return 2 }
    else if (isRead && !isCreate && args.length === 1 && edits === undefined && title === undefined && !dryRun) await read(args[0], { out })
    else if (isRead) { console.error(USAGE); return 2 }
    else if (isCreate && args.length === 1 && edits === undefined && title === undefined) await create(args[0], { dryRun, skipUrlCheck })
    else if (!isCreate && args.length === 2 && !args.some((a) => a.startsWith('--'))) await update(args[0], args[1], { edits, title, dryRun, skipUrlCheck })
    else if (!isCreate && args.length === 1 && (edits !== undefined || title !== undefined) && !args[0].startsWith('--')) await update(args[0], undefined, { edits, title, dryRun, skipUrlCheck })
    else { console.error(USAGE); return 2 }
    return 0
  } catch (e) {
    console.error(`✗ ${e.message}`)
    return 1
  }
}

const invoked = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (invoked) process.exitCode = await main(process.argv.slice(2))
