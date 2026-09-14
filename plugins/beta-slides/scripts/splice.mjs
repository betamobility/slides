#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
//
// splice: put runtime slides (live HTML scenes) into a deck on the Beta deck
// store, and fix native content by element id, without ever touching what a
// person arranged in the editor.
//
//   node splice.mjs <deckId> <projectDir> [--edits edits.json] [--title "<title>"] [--dry-run] [--skip-url-check]
//   node splice.mjs <deckId> --edits edits.json [--title "<title>"] [--dry-run]
//   node splice.mjs <deckId> --title "<title>" [--dry-run]
//   node splice.mjs --create <projectDir> [--dry-run] [--skip-url-check]
//
// The second and third forms are a content fix or a rename on a deck with no
// scene to change. A run with no scene folders, no edits and no --title
// refuses: there is nothing to do. --title changes doc.title and nothing else
// at document level.
//
// Environment: CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (the Access
// service token, sent as the same two headers the skill's curl recipes use),
// and SLIDES_STORE_URL (default https://slides.betamobility.ai).
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
// edits.json is a list of { slideId, elementId, html | src | option | rows }.
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

import { readFileSync, existsSync, statSync, readdirSync, realpathSync } from 'node:fs'
import { join, extname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readBlock, writeBlock, isEncrypted } from './lib/bento-doc.mjs'

// slides/src/model.ts RUNTIME_*_BUDGET; restated because this file cannot
// import the app.
export const SRC_BUDGET = 256 * 1024
export const STILL_BUDGET = 200 * 1024
export const ASSET_BUDGET = 16 * 1024 * 1024
const MAX_ATTEMPTS = 4 // one write and three re-derived retries (R19)
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
    keys.add(p.key)
  }
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
  return { id, src, still, stillType, steps, props, url: m.url, assets, insertAfter: m.insertAfter }
}

/** edits.json, validated for shape; whether each target exists is checked per read. */
export function readEdits(file) {
  if (!file) return []
  let list
  try { list = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { throw new Refusal(`edits file does not parse: ${e.message}`) }
  if (!Array.isArray(list)) throw new Refusal('edits.json must be a list of { slideId, elementId, html | src | option | rows }')
  for (const e of list) {
    if (!e || typeof e.slideId !== 'string' || typeof e.elementId !== 'string') throw new Refusal('every edit needs slideId and elementId')
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
  rec.props = scene.props.map((p) => ({ key: p.key, label: typeof p.label === 'string' ? p.label : p.key, kind: p.kind, default: p.default ?? KIND_DEFAULT[p.kind] }))
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
export function derive(read, { scenes }, edits = [], { title } = {}) {
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
    sceneIds.add(scene.id)
  }
  if (inserts.size) {
    // Rebuilt from the read order: each anchor keeps its states (the hidden
    // variants that follow it) next to it, and the new slides go after those.
    const out = []
    const place = (anchor, neighbour) => {
      for (const scene of inserts.get(anchor) || []) {
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
  const pruneKeys = []
  for (const scene of scenes) {
    const slide = byId(scene.id)[0]
    const values = isRuntime(slide) && slide.runtime.values && typeof slide.runtime.values === 'object' ? slide.runtime.values : {}
    pruneKeys.push(...applyScene(doc, slide, scene))
    if (inserted.has(scene.id)) { plan.push(`  ${scene.id}: new runtime slide inserted after ${scene.insertAfter === 'end' ? 'the last slide' : `"${scene.insertAfter}"`} (source ${kb(scene.src.length)}, still ${kb(scene.still.length)}, ${scene.steps} steps)`); continue }
    plan.push(`  ${scene.id}: runtime slide replaced (source ${kb(scene.src.length)}, still ${kb(scene.still.length)}, ${scene.steps} steps, ${scene.props.length} props${scene.assets.length ? `, assets ${scene.assets.map((a) => `${a.name} ${kb(a.size)}`).join(', ')}` : ''})`)
    // R14 drops them by design; the person who set them should hear about it.
    const dropped = Object.entries(values)
    if (dropped.length) plan.push(`  ${scene.id}: presenter values dropped by the replace: ${dropped.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`)
  }

  const edited = new Map()
  for (const e of edits) {
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
  checkOwnership(read, doc, { scenes: sceneIds, edits: edited, inserted, title })
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
export function checkOwnership(read, out, { scenes, edits, inserted = new Set(), title }) {
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

function config(env) {
  for (const k of ['CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET']) {
    if (!env[k]) throw new Refusal(`${k} is not set; the splice tool needs the deck store service token (1Password, Development)`)
  }
  let override
  if (env.SPLICE_TIMEOUT_MS !== undefined && env.SPLICE_TIMEOUT_MS !== '') {
    override = Number(env.SPLICE_TIMEOUT_MS)
    if (!Number.isFinite(override) || override <= 0) throw new Refusal('SPLICE_TIMEOUT_MS must be a positive number of milliseconds')
  }
  return {
    store: (env.SLIDES_STORE_URL || 'https://slides.betamobility.ai').replace(/\/+$/, ''),
    auth: { 'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET },
    timeout: (kind) => override ?? TIMEOUT[kind],
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

async function failed(res, what) {
  const body = (await res.text().catch(() => '')).slice(0, 300)
  if (res.status === 401 || res.status === 403) return new Error(`${what}: ${res.status}; the service token was not accepted (check CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET)`)
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
        res = await harness(`${cfg.store}/api/harness/decks/${id}/assets/${encodeURIComponent(a.name)}`, {
          method: 'PUT', headers: { ...cfg.auth, 'content-type': a.type }, body: readFileSync(a.path),
        }, cfg.timeout('asset'))
      } catch (e) { e.message = `${what}: ${e.message}`; throw e }
      if (!res.ok) throw await failed(res, what)
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

// ---- update and create --------------------------------------------------------------------

export async function update(id, dir, { edits: editsFile, title, dryRun = false, skipUrlCheck = false, env = process.env, log = console.log, warn = console.error } = {}) {
  if (!/^[0-9A-Za-z]{10}$/.test(id)) throw new Refusal(`"${id}" is not a deck id (ten letters and digits, the end of /d/<id>)`)
  if (title !== undefined && (typeof title !== 'string' || !title.trim())) throw new Refusal('--title must be a non-empty title')
  const project = readProject(dir)
  const edits = readEdits(editsFile)
  if (!project.scenes.length && !edits.length && title === undefined) {
    throw new Refusal(`nothing to do: ${dir ? `no scene folders in ${join(dir, 'scenes')}` : 'no project folder'}, no edits and no --title`)
  }
  const cfg = config(env)
  if (!skipUrlCheck) await checkUrls(project.scenes, cfg, warn)
  const ms = cfg.timeout('store')
  const deckUrl = `${cfg.store}/api/harness/decks/${id}`
  let uploadsDone = false
  const uploaded = []
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = await harness(deckUrl, { headers: cfg.auth }, ms)
      if (res.status === 404) throw new Refusal(`deck ${id} is not in the store`)
      if (!res.ok) throw await failed(res, `reading deck ${id}`)
      // x-bento-etag first: Cloudflare drops a strong etag from the compressed
      // HTML a deck read returns, and a write without one is impossible.
      const etag = res.headers.get('x-bento-etag') || res.headers.get('etag')
      const html = await bodyText(res, 'GET', deckUrl, ms)
      let read
      try { read = readBlock(html) } catch (e) { throw new Refusal(`deck ${id}: ${e.message}`) }
      if (isEncrypted(read)) throw new Refusal(`deck ${id} is encrypted (a bento/enc envelope); the splice tool does not decrypt, so it cannot change it`)
      if (read.format !== 'bento/slides') throw new Refusal(`deck ${id} is not a bento/slides document`)
      const { doc, plan } = derive(read, project, edits, { title })
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
      if (put.status !== 412) throw await failed(put, `writing deck ${id}`)
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
  const cfg = config(env)
  if (!skipUrlCheck) await checkUrls(project.scenes, cfg, warn)
  const ms = cfg.timeout('store')
  // Public path; the same template GET /new/blank mints from.
  const templateUrl = `${cfg.store}/templates/blank.bento.html`
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
  const postUrl = `${cfg.store}/api/harness/decks`
  const post = await harness(postUrl, {
    method: 'POST', headers: { ...cfg.auth, 'content-type': 'text/html; charset=utf-8' }, body: writeBlock(html, doc),
  }, ms)
  if (post.status !== 201) throw await failed(post, 'creating the deck')
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
  const isCreate = flag('--create')
  const skipUrlCheck = flag('--skip-url-check')
  const edits = value('--edits')
  const title = value('--title')
  try {
    if (edits === null || title === null) { console.error(USAGE); return 2 }
    if (isCreate && args.length === 1 && edits === undefined && title === undefined) await create(args[0], { dryRun, skipUrlCheck })
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
