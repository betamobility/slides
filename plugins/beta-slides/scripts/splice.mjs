#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
//
// splice: put runtime slides (live HTML scenes) into a deck on the Beta deck
// store, and fix native content by element id, without ever touching what a
// person arranged in the editor.
//
//   node splice.mjs <deckId> <projectDir> [--edits edits.json] [--dry-run]
//   node splice.mjs --create <projectDir> [--dry-run]
//
// Environment: CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (the Access
// service token, sent as the same two headers the skill's curl recipes use),
// and SLIDES_STORE_URL (default https://slides.betamobility.ai).
//
// A project folder:
//   deck.json                        --create only: { title?, slides: [...] }
//   scenes/<slideId>/index.html      the scene, inlined (256 KB at most)
//   scenes/<slideId>/still.png|svg   what thumbnails, print and export show (200 KB)
//   scenes/<slideId>/scene.json      { steps, props, assets?, url? }
//   scenes/<slideId>/assets/<name>   heavy files scene.json lists; uploaded to
//                                    the store's asset route, never inlined
//                                    (<projectDir>/assets/<name> also found)
//
// edits.json is a list of { slideId, elementId, html | src | option | rows }.
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
  if (!create && !scenes.length) throw new Refusal(`no scene folders in ${scenesDir}`)
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
    assets.push({ name, path, type, size })
  }
  return { id, src, still, stillType, steps, props, url: m.url, assets }
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
function applyScene(doc, slide, scene) {
  const old = isRuntime(slide) ? slide.runtime : {}
  const rec = {}
  rec.src = intern(doc, dataUri('text/html;charset=utf-8', scene.src), 'scene')
  if (scene.url) rec.url = scene.url
  rec.still = intern(doc, dataUri(scene.stillType, scene.still), 'still')
  rec.steps = scene.steps
  rec.props = scene.props.map((p) => ({ key: p.key, label: typeof p.label === 'string' ? p.label : p.key, kind: p.kind, default: p.default ?? KIND_DEFAULT[p.kind] }))
  if (scene.assets.length) rec.assets = scene.assets.map((a) => a.name)

  const images = (slide.elements || []).filter((el) => el && el.type === 'image')
  const holder = (old.still && images.find((el) => el.src === old.still)) || images[0]
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
export function derive(read, { scenes }, edits = []) {
  const doc = structuredClone(read)
  if (!Array.isArray(doc.slides)) throw new Refusal('the deck has no slides list')
  const plan = []
  const byId = (id) => doc.slides.filter((s) => s && s.id === id)

  const sceneIds = new Set()
  for (const scene of scenes) {
    const hits = byId(scene.id)
    if (!hits.length) throw new Refusal(`slide "${scene.id}" is not in the deck (scenes/${scene.id}); nothing was written`)
    if (hits.length > 1) throw new Refusal(`slide id "${scene.id}" is used by ${hits.length} slides in the deck, so scenes/${scene.id} is ambiguous; nothing was written`)
    if (!isRuntime(hits[0])) throw new Refusal(`slide "${scene.id}" is a native slide; the splice tool never converts one (a scene needs a runtime slide, or a runtime: {} placeholder, with that id); nothing was written`)
    sceneIds.add(scene.id)
  }
  const pruneKeys = []
  for (const scene of scenes) {
    pruneKeys.push(...applyScene(doc, byId(scene.id)[0], scene))
    plan.push(`  ${scene.id}: runtime slide replaced (source ${kb(scene.src.length)}, still ${kb(scene.still.length)}, ${scene.steps} steps, ${scene.props.length} props${scene.assets.length ? `, assets ${scene.assets.map((a) => `${a.name} ${kb(a.size)}`).join(', ')}` : ''})`)
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
  checkOwnership(read, doc, { scenes: sceneIds, edits: edited })
  return { doc, plan }
}

/**
 * KTD8, as a diff of the document to write against the one read. Throws a
 * Refusal naming the first offending id. `scenes` is the set of runtime slide
 * ids being replaced; `edits` maps "slideId U+001F elementId" to the keys an
 * edit set on that element.
 */
export function checkOwnership(read, out, { scenes, edits }) {
  for (const k of new Set([...Object.keys(read), ...Object.keys(out)])) {
    if (k === 'assets' || k === 'slides') continue
    if (!same(read[k], out[k])) throw new Refusal(`document key "${k}" would change; the splice tool changes slides only`)
  }
  const ids = (d) => (d.slides || []).map((s) => s?.id)
  if (!same(ids(read), ids(out))) throw new Refusal('slide order or count would change; slide order belongs to the person editing the deck')
  read.slides.forEach((before, i) => {
    const after = out.slides[i]
    const sid = before.id
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (k === 'elements') continue
      if (k === 'runtime' && scenes.has(sid)) continue
      if (!same(before[k], after[k])) throw new Refusal(`slide "${sid}": "${k}" would change; only element content may change on a native slide`)
    }
    if (scenes.has(sid)) {
      if (!isRuntime(before)) throw new Refusal(`slide "${sid}" is a native slide; the splice tool never converts one`)
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
  return {
    store: (env.SLIDES_STORE_URL || 'https://slides.betamobility.ai').replace(/\/+$/, ''),
    auth: { 'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET },
  }
}

/**
 * A harness request that never follows a redirect. fetch turns a followed
 * 301 on a PUT or POST into a GET, and the GET of a deck answers 200: the
 * write would report success having written nothing. The retired store host
 * still answers 301, so this is not hypothetical.
 */
async function harness(url, init) {
  let res
  try {
    res = await fetch(url, { ...init, redirect: 'manual' })
  } catch (e) {
    throw new Error(`${init?.method || 'GET'} ${url} failed (${e.cause?.message || e.message})`)
  }
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`${init?.method || 'GET'} ${url} was redirected (${res.status}${res.headers.get('location') ? ` to ${res.headers.get('location')}` : ''}); set SLIDES_STORE_URL to the store's current host. Nothing was written by this request.`)
  }
  return res
}

async function failed(res, what) {
  const body = (await res.text().catch(() => '')).slice(0, 300)
  if (res.status === 401 || res.status === 403) return new Error(`${what}: ${res.status}; the service token was not accepted (check CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET)`)
  return new Error(`${what}: the store answered ${res.status}${body ? ` (${body})` : ''}`)
}

async function uploadAssets(cfg, id, scenes, log) {
  for (const scene of scenes) {
    for (const a of scene.assets) {
      const res = await harness(`${cfg.store}/api/harness/decks/${id}/assets/${encodeURIComponent(a.name)}`, {
        method: 'PUT', headers: { ...cfg.auth, 'content-type': a.type }, body: readFileSync(a.path),
      })
      if (!res.ok) throw await failed(res, `uploading ${a.name} for scene "${scene.id}"`)
      log(`  uploaded ${a.name} (${kb(a.size)})`)
    }
  }
}

export async function update(id, dir, { edits: editsFile, dryRun = false, env = process.env, log = console.log } = {}) {
  if (!/^[0-9A-Za-z]{10}$/.test(id)) throw new Refusal(`"${id}" is not a deck id (ten letters and digits, the end of /d/<id>)`)
  const project = readProject(dir)
  const edits = readEdits(editsFile)
  const cfg = config(env)
  let uploaded = false
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await harness(`${cfg.store}/api/harness/decks/${id}`, { headers: cfg.auth })
    if (res.status === 404) throw new Refusal(`deck ${id} is not in the store`)
    if (!res.ok) throw await failed(res, `reading deck ${id}`)
    const etag = res.headers.get('etag')
    const html = await res.text()
    let read
    try { read = readBlock(html) } catch (e) { throw new Refusal(`deck ${id}: ${e.message}`) }
    if (isEncrypted(read)) throw new Refusal(`deck ${id} is encrypted (a bento/enc envelope); the splice tool does not decrypt, so it cannot change it`)
    if (read.format !== 'bento/slides') throw new Refusal(`deck ${id} is not a bento/slides document`)
    const { doc, plan } = derive(read, project, edits)
    if (dryRun) {
      log(`dry run, deck ${id}; would write:`)
      for (const l of plan) log(l)
      log('nothing was written')
      return
    }
    if (!etag) throw new Error(`reading deck ${id}: the store sent no ETag, so a conditional write is impossible`)
    // Once, after the first derivation passed every check: the names are the
    // same on every retry and a re-upload would only repeat the bytes.
    if (!uploaded) { await uploadAssets(cfg, id, project.scenes, log); uploaded = true }
    const put = await harness(`${cfg.store}/api/harness/decks/${id}`, {
      method: 'PUT',
      headers: { ...cfg.auth, 'if-match': etag, 'content-type': 'text/html; charset=utf-8' },
      body: writeBlock(html, doc),
    })
    if (put.ok) {
      for (const l of plan) log(l)
      log(`${cfg.store}/d/${id}`)
      return
    }
    if (put.status !== 412) throw await failed(put, `writing deck ${id}`)
    if (attempt < MAX_ATTEMPTS) log(`  deck ${id} changed since it was read; reading again (retry ${attempt} of ${MAX_ATTEMPTS - 1})`)
  }
  throw new Error(`deck ${id} changed on every one of ${MAX_ATTEMPTS} attempts; the owner probably has the deck open. Ask them to close it (or wait until they stop editing) and run again. The deck was not changed.`)
}

export async function create(dir, { dryRun = false, env = process.env, log = console.log } = {}) {
  const project = readProject(dir, { create: true })
  const cfg = config(env)
  // Public path; the same template GET /new/blank mints from.
  const res = await fetch(`${cfg.store}/templates/blank.bento.html`, { redirect: 'follow' })
  if (!res.ok) throw await failed(res, 'fetching the blank template')
  const html = await res.text()
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
  const post = await harness(`${cfg.store}/api/harness/decks`, {
    method: 'POST', headers: { ...cfg.auth, 'content-type': 'text/html; charset=utf-8' }, body: writeBlock(html, doc),
  })
  if (post.status !== 201) throw await failed(post, 'creating the deck')
  const { id, url } = await post.json()
  await uploadAssets(cfg, id, project.scenes, log)
  for (const l of plan) log(l)
  log(url || `${cfg.store}/d/${id}`)
}

// ---- command line ---------------------------------------------------------------------

const USAGE = `usage:
  node splice.mjs <deckId> <projectDir> [--edits edits.json] [--dry-run]
  node splice.mjs --create <projectDir> [--dry-run]`

export async function main(argv) {
  const args = [...argv]
  const flag = (n) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true }
  const value = (n) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v }
  const dryRun = flag('--dry-run')
  const isCreate = flag('--create')
  const edits = value('--edits')
  try {
    if (isCreate && args.length === 1 && edits === undefined) await create(args[0], { dryRun })
    else if (!isCreate && args.length === 2 && !args.some((a) => a.startsWith('--'))) await update(args[0], args[1], { edits, dryRun })
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
