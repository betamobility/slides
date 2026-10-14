// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Beta build: reading the scene library and writing a library scene's slide
// (2026-10-13-2236 plan, U11 and U12). Pure: no DOM, no i18n.
//
// ONE READING FOR EVERY READER. The editor's gallery (gallery.ts) imports this
// file; the splice tool cannot (it may import nothing outside
// plugins/beta-slides/, KTD11), so scripts/build-beta-plugin-library.mjs
// bundles this file into plugins/beta-slides/scripts/lib/library-core.mjs and
// CI fails when that copy is stale. What the shelf offers, what an insert
// writes and which values a setting keeps as given are therefore the same
// code in both, not two copies kept alike by tests.

import type { BentoDoc, RuntimeProp, RuntimeSlide, Slide } from '../model.ts'
import { defaultImage, emptySlide, internAsset, RUNTIME_SRC_BUDGET, RUNTIME_STILL_BUDGET, uid } from '../model.ts'
import { checkRuntime, LIBRARY_ID } from '../runtime.ts'
import { activeSvg, hasLoneSurrogate, pageTooLarge, RESERVED_KEYS, stillDataUri, stillTooLarge, WEB_HOSTS } from './libraryrules.ts'
import { applyPreset, coerce, rememberPresets, webSceneOf, writeQueryAll, type Preset } from './scenesettings.ts'

export interface LibraryScene {
  id: string
  version: number
  name: string
  description: string
  kind: 'runtime' | 'web'
  steps: number
  props: RuntimeProp[]
  presets: Preset[]
  /** svg markup: the runtime slide's still, or the web embed's view */
  still: string
  /** a runtime scene's page */
  html?: string
  /** a web scene's page */
  url?: string
}

const MAX_SCENES = 200
const MAX_PRESETS = 32
const MAX_NAME = 80
const MAX_DESCRIPTION = 200
const MAX_VERSION = 1_000_000
const MAX_STEPS = 10_000

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const utf8Bytes = (s: string) => new TextEncoder().encode(s)
/** One printable line: no control, line-break or direction characters. */
const line = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && [...v].length <= max && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(v)

/**
 * The scenes in a manifest that read cleanly, in its order (the build sorts
 * them by id); null when it is not a library manifest at all. Remembers the
 * presets for the settings panel (U10).
 */
export function readManifest(json: unknown): LibraryScene[] | null {
  if (!isObject(json) || json.format !== 'beta/library' || json.v !== 1 || !Array.isArray(json.scenes)) return null
  const out: LibraryScene[] = []
  for (const raw of json.scenes.slice(0, MAX_SCENES)) {
    const s = readScene(raw)
    if (s && !out.some((o) => o.id === s.id)) out.push(s)
  }
  rememberPresets({ scenes: out })
  return out
}

function readScene(raw: unknown): LibraryScene | null {
  // text that is not well-formed would become U+FFFD when written as UTF-8 or into a URL: a repair
  if (!isObject(raw) || hasLoneSurrogate(raw)) return null
  const { id, version, name, kind } = raw
  if (typeof id !== 'string' || !LIBRARY_ID.test(id)) return null
  if (!Number.isInteger(version) || (version as number) < 1 || (version as number) > MAX_VERSION) return null
  if (!line(name, MAX_NAME)) return null
  if (kind !== 'runtime' && kind !== 'web') return null
  const description = raw.description === undefined ? '' : raw.description
  if (description !== '' && !line(description, MAX_DESCRIPTION)) return null
  const steps = raw.steps ?? 0
  if (!Number.isInteger(steps) || (steps as number) < 0 || (steps as number) > MAX_STEPS) return null
  // settings: the same reading a web scene's `doc` gets, and every one must survive it
  if (raw.props !== undefined && !Array.isArray(raw.props)) return null
  const rawProps = (raw.props as unknown[] | undefined) ?? []
  // a key the sync engine refuses would keep the slide from every collaborator
  if (rawProps.some((p) => isObject(p) && RESERVED_KEYS.includes(p.key as string))) return null
  // the runtime gate's own reading of the settings (labels, kinds, defaults,
  // format hints), and every one must come through exactly as written
  const gated = checkRuntime({ steps: 0, props: rawProps, values: {} }) as RuntimeSlide | undefined
  const props = gated?.props ?? []
  const asWritten = (p: unknown) => isObject(p) ? JSON.stringify({ key: p.key, label: p.label, kind: p.kind, default: p.default, ...(p.format !== undefined ? { format: p.format } : {}) }) : ''
  if (props.length !== rawProps.length || rawProps.some((p, i) => asWritten(p) !== JSON.stringify(props[i]))) return null
  if (!webSceneOf({ library: { id, version }, props })) return null
  const presets: Preset[] = []
  if (!Array.isArray(raw.presets) || raw.presets.length > MAX_PRESETS) return null
  for (const p of raw.presets) {
    if (!isObject(p) || !line(p.name, MAX_NAME) || presets.some((q) => q.name === p.name)) return null
    if (p.values !== undefined && !isObject(p.values)) return null
    const values = p.values ?? {}
    // every value names a declared setting and is one it keeps as given:
    // a preset the form would have to hold or refuse is not repaired here
    for (const [k, v] of Object.entries(values)) {
      const prop = props.find((q) => q.key === k)
      const r = prop ? coerce(prop, v) : null
      if (!r || r.value === undefined || r.note || r.value !== v) return null
    }
    presets.push({ name: p.name as string, values: { ...(values as Preset['values']) } })
  }
  const still = kind === 'web' ? raw.view : raw.still
  // a picture by the library's own rules (libraryrules.ts): nothing that can run, load or link
  if (typeof still !== 'string' || utf8Bytes(still).length > RUNTIME_STILL_BUDGET || activeSvg(still) !== null || stillTooLarge(still) !== null) return null
  const base = { id, version: version as number, name: name as string, description: description as string, kind, steps: steps as number, props, presets, still } as LibraryScene
  if (kind === 'runtime') {
    // measured as the gate measures it (libraryrules.ts): a page the shelf shows is one the insert can write
    if (typeof raw.html !== 'string' || !raw.html || utf8Bytes(raw.html).length > RUNTIME_SRC_BUDGET || pageTooLarge(raw.html) !== null) return null
    return { ...base, html: raw.html }
  }
  // https, on a host Beta controls, no login and no port: the build's rule (libraryrules.ts)
  if (typeof raw.url !== 'string' || 'error' in writeQueryAll(raw.url, {})) return null
  let u: URL
  try { u = new URL(raw.url) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !WEB_HOSTS.includes(u.hostname)) return null
  return { ...base, url: raw.url }
}

/** A still as a data: URI (libraryrules.ts): the shorter encoding, under the inline limit for any still readScene admits. */
export const svgDataUri = stillDataUri

/** A data: URI holding UTF-8 text, base64 as the splice tool writes it. */
function textDataUri(type: string, text: string): string {
  const bytes = utf8Bytes(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${type};base64,${btoa(bin)}`
}

/** The values a preset gives (every declared setting); the defaults when there is no preset. */
/**
 * A slide's settings as the shell's gate keeps them on load (checkRuntime):
 * a setting of a kind it does not know, or one hand-edited past its rules, is
 * not there. A tool that writes values checks against these, or it would
 * write a value the next load drops.
 */
export function gatedProps(props: unknown): RuntimeProp[] {
  const r = checkRuntime({ steps: 0, props, values: {} }) as RuntimeSlide | undefined
  return r?.props ?? []
}

export const valuesFor = (scene: LibraryScene, preset: Preset | undefined) => applyPreset(scene.props, preset ?? { name: '', values: {} })

/**
 * Why `v` is not a value this setting keeps AS GIVEN, or null when it is: the
 * settings panel's own coerce, refusing anything it would refuse, hold or
 * rewrite. A tool that writes values (the splice tool) refuses these rather
 * than writing something the panel would then show changed.
 */
export function valueRefusal(prop: RuntimeProp, v: unknown): string | null {
  const r = coerce(prop, v)
  if (r.value === undefined) return r.note ? r.note.says.replace(/\{(\w+)\}/g, (_m, k) => String((r.note as Record<string, unknown>)[k] ?? '')) : 'is not a value this setting takes'
  if (r.note || r.value !== v) return `would be kept as ${JSON.stringify(r.value)}, not as given`
  return null
}

/**
 * A runtime scene as a new slide. Interns the scene's HTML and still into
 * `doc.assets`, so call it inside the commit that inserts the slide. null when
 * the record would not pass the gate (nothing is interned then).
 */
export function runtimeSlide(doc: BentoDoc, scene: LibraryScene, preset?: Preset): Slide | null {
  return runtimeSlideWith(doc, scene, valuesFor(scene, preset))
}

/** The same slide, with every setting's value given (the splice tool's insert: a preset with values over it). */
export function runtimeSlideWith(doc: BentoDoc, scene: LibraryScene, values: Record<string, string | number>): Slide | null {
  if (scene.kind !== 'runtime' || !scene.html) return null
  const srcUri = textDataUri('text/html;charset=utf-8', scene.html)
  const stillUri = svgDataUri(scene.still)
  const record = {
    src: 'asset:scene', still: 'asset:still', steps: scene.steps, props: scene.props,
    values, library: { id: scene.id, version: scene.version },
  }
  // checked against the assets it will point at, before anything is written
  const checked = checkRuntime(record, { scene: srcUri, still: stillUri })
  if (!checked || checked.src !== record.src || checked.still !== record.still || !checked.library || (checked.props?.length ?? 0) !== scene.props.length) return null
  const size = doc.size ?? { width: 1280, height: 720 }
  checked.src = internAsset(doc, srcUri)
  checked.still = internAsset(doc, stillUri)
  return emptySlide({
    id: uid('slide'),
    elements: [defaultImage(checked.still, { id: 'still', x: 0, y: 0, w: size.width, h: size.height, fit: 'cover' })],
    runtime: checked,
  })
}
