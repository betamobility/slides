// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Beta build: a scene's settings (2026-10-13-2236 plan, U10, KTD9, KTD10).
//
// One pure module for everything that reads or writes a scene's settings, so
// the panel form, the gallery (U11) and the splice tool (U12) agree:
//   - the FORMAT HINT grammar a setting may carry (U9 stores it as a free
//     string; this is the one parser): `bool`, `latlon`, `select:a|b|c`,
//     `range:min:max:step`;
//   - what a typed value becomes: kept, held to its range (with a note), or
//     refused (with a note), never silently dropped;
//   - presets: a preset sets every declared setting and nothing else;
//   - a WEB scene's settings live in its page address's query string
//     (KTD10). Only the query is rewritten; the origin, path and fragment
//     stay as they are, and a change to another setting made meanwhile (a
//     colleague's, through sync) is kept because the write starts from the
//     address as it is at that moment.
// No DOM here: scripts/test-beta-scenesettings.ts drives it in node.

import type { RuntimeProp } from '../model.ts'
import { checkRuntimeValue } from '../runtime.ts'

export type Value = string | number
export type Hint =
  | { kind: 'bool' }
  | { kind: 'latlon' }
  | { kind: 'select'; options: string[] }
  | { kind: 'range'; min: number; max: number; step: number }

/**
 * The longest page address a web embed keeps: the shell's own `isWebUrl`
 * (slides/src/model.ts) refuses a longer one, so a settings change that would
 * pass it is refused in the form instead of being dropped on the next load.
 */
export const MAX_WEB_URL = 2048

/** The hint a setting's `format` names, or null for none (or one this build does not read: the plain control is used). */
export function parseHint(format: unknown, kind: RuntimeProp['kind']): Hint | null {
  if (typeof format !== 'string') return null
  if (format === 'bool') return kind === 'number' ? { kind: 'bool' } : null
  if (format === 'latlon') return kind === 'text' ? { kind: 'latlon' } : null
  if (format.startsWith('select:')) {
    if (kind !== 'text') return null
    const options = [...new Set(format.slice(7).split('|').filter((o) => o.length > 0))]
    return options.length ? { kind: 'select', options } : null
  }
  const r = /^range:(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(format)
  if (r && kind === 'number') {
    const [min, max, step] = [Number(r[1]), Number(r[2]), Number(r[3])]
    if (min < max && step > 0) return { kind: 'range', min, max, step }
  }
  return null
}

/** Every declared setting with its current value: the chosen one, else the default. Undeclared keys are not settings. */
export function valuesOf(props: RuntimeProp[], values?: Record<string, Value>): Record<string, Value> {
  const out: Record<string, Value> = {}
  for (const p of props) {
    const v = values && Object.prototype.hasOwnProperty.call(values, p.key) ? values[p.key] : undefined
    out[p.key] = v !== undefined && checkRuntimeValue(p.kind, v) !== undefined ? v : p.default
  }
  return out
}

/** Why a value was changed or refused, for the form to show beside the control. Plain English keys for t(). */
export type Note =
  | { says: 'Held at {value}: the scene allows {min} to {max}'; value: Value; min: number; max: number }
  | { says: 'Not one of the choices' }
  | { says: 'Not a position. Write latitude, longitude' }
  | { says: 'Held at {value}: latitude is -90 to 90, longitude -180 to 180'; value: Value }
  | { says: 'Not a number' }
  | { says: 'Not a colour the scene can use' }
  | { says: 'Too long' }

/** What a typed value becomes for this setting: `value` to store (maybe held to a limit) and an optional note; no `value` means refused. */
export function coerce(prop: RuntimeProp, input: unknown): { value?: Value; note?: Note } {
  const hint = parseHint(prop.format, prop.kind)
  if (prop.kind === 'number') {
    const n = typeof input === 'number' ? input : typeof input === 'string' && input.trim() !== '' ? Number(input.trim().replace(',', '.')) : Number.NaN
    if (hint?.kind === 'bool') {
      if (input === true || n === 1) return { value: 1 }
      if (input === false || n === 0) return { value: 0 }
      return { note: { says: 'Not a number' } }
    }
    if (!Number.isFinite(n)) return { note: { says: 'Not a number' } }
    if (hint?.kind === 'range') {
      const snapped = Number((hint.min + Math.round((n - hint.min) / hint.step) * hint.step).toFixed(10))
      const held = Math.min(hint.max, Math.max(hint.min, snapped))
      if (held !== n) return { value: held, note: { says: 'Held at {value}: the scene allows {min} to {max}', value: held, min: hint.min, max: hint.max } }
      return { value: held }
    }
    return { value: n }
  }
  if (prop.kind === 'color') {
    const v = checkRuntimeValue('color', typeof input === 'string' ? input : '')
    return v === undefined ? { note: { says: 'Not a colour the scene can use' } } : { value: v }
  }
  // text
  const s = typeof input === 'string' ? input : typeof input === 'number' ? String(input) : ''
  if (hint?.kind === 'select') return hint.options.includes(s) ? { value: s } : { note: { says: 'Not one of the choices' } }
  if (hint?.kind === 'latlon') {
    const pos = parseLatLon(s)
    if (!pos) return { note: { says: 'Not a position. Write latitude, longitude' } }
    const lat = Math.max(-90, Math.min(90, pos[0])), lon = Math.max(-180, Math.min(180, pos[1]))
    const value = `${round6(lat)}, ${round6(lon)}`
    return lat !== pos[0] || lon !== pos[1] ? { value, note: { says: 'Held at {value}: latitude is -90 to 90, longitude -180 to 180', value } } : { value }
  }
  return checkRuntimeValue('text', s) === undefined ? { note: { says: 'Too long' } } : { value: s }
}

const round6 = (n: number) => Number(n.toFixed(6))

/** "59.9, 10.7", "59,9 10,7", "59.9;10.7" → [lat, lon], or null. */
export function parseLatLon(s: string): [number, number] | null {
  const raw = s.trim()
  let parts = raw.split(/\s*;\s*|\s*,\s+|\s+/)
  parts = parts.length === 2 ? parts.map((p) => p.replace(',', '.')) : raw.split(',')
  if (parts.length !== 2) return null
  const [lat, lon] = parts.map((p) => (/^[-+]?\d+(?:\.\d+)?$/.test(p.trim()) ? Number(p.trim()) : Number.NaN))
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null
}

export interface Preset { name: string; values: Record<string, Value> }

/** The values a preset gives: every declared setting, from the preset where it names one and from its default otherwise. Nothing undeclared. */
export function applyPreset(props: RuntimeProp[], preset: Preset): Record<string, Value> {
  const out: Record<string, Value> = {}
  for (const p of props) {
    const v = Object.prototype.hasOwnProperty.call(preset.values, p.key) ? coerce(p, preset.values[p.key]).value : undefined
    out[p.key] = v ?? p.default
  }
  return out
}

/** The preset the current values are exactly, or null ("custom"). */
export function activePreset(props: RuntimeProp[], values: Record<string, Value> | undefined, presets: Preset[]): string | null {
  const now = valuesOf(props, values)
  for (const preset of presets) {
    const want = applyPreset(props, preset)
    if (props.every((p) => want[p.key] === now[p.key])) return preset.name
  }
  return null
}

// The library's presets, by scene id. Filled when the library manifest has
// been read (the gallery, U11); the panel offers presets only for a scene whose
// library entry is known, because a deck carries its settings but not the
// library's presets (KTD9).
const presetsById = new Map<string, Preset[]>()
/** Remember the presets of every scene in a library manifest. */
export function rememberPresets(manifest: unknown): void {
  const scenes = (manifest as { scenes?: unknown })?.scenes
  if (!Array.isArray(scenes)) return
  for (const s of scenes) {
    const id = (s as { id?: unknown })?.id, presets = (s as { presets?: unknown })?.presets
    if (typeof id !== 'string' || !Array.isArray(presets)) continue
    presetsById.set(id, presets.filter((p): p is Preset => !!p && typeof (p as Preset).name === 'string' && !!(p as Preset).values && typeof (p as Preset).values === 'object'))
  }
}
/** The presets for a library scene, or null when the library has not been read or the scene has none. */
export const presetsFor = (library: { id: string } | undefined): Preset[] | null =>
  (library && presetsById.get(library.id)?.length ? presetsById.get(library.id)! : null)

// ---- a web scene: settings in the page address ------------------------------

/** The settings a web scene's address carries, by declared key; a missing or unusable one is its default. */
export function readQuery(url: string | undefined, props: RuntimeProp[]): Record<string, Value> {
  const out: Record<string, Value> = {}
  let q: URLSearchParams | null = null
  try { q = url ? new URL(url).searchParams : null } catch { q = null }
  for (const p of props) {
    const raw = q?.get(p.key)
    const v = raw == null ? undefined : coerce(p, raw).value
    out[p.key] = v ?? p.default
  }
  return out
}

/**
 * The address with one setting written into its query string, starting from
 * the address as it is NOW (so a change made meanwhile to another setting
 * survives). Origin, path, fragment and every parameter that is not this
 * setting stay as they were. An error instead when the result would be longer
 * than the shell keeps, or the address is not one.
 */
export function writeQuery(url: string | undefined, key: string, value: Value): { url: string } | { error: 'Not a web address' | 'This makes the page address too long' } {
  let u: URL
  try { u = new URL(url ?? '') } catch { return { error: 'Not a web address' } }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Not a web address' }
  u.searchParams.set(key, String(value))
  const out = u.href
  return out.length > MAX_WEB_URL ? { error: 'This makes the page address too long' } : { url: out }
}

/** A web scene's settings record (KTD10: the embed's `doc`), or null when the embed is not a library scene. */
export function webSceneOf(doc: unknown): { library: { id: string; version: number }; props: RuntimeProp[] } | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null
  const d = doc as { library?: unknown; props?: unknown }
  const lib = d.library as { id?: unknown; version?: unknown } | undefined
  if (!lib || typeof lib.id !== 'string' || !Number.isInteger(lib.version) || !Array.isArray(d.props)) return null
  const props: RuntimeProp[] = []
  for (const p of d.props) {
    if (!p || typeof p !== 'object') continue
    const q = p as Record<string, unknown>
    if (typeof q.key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(q.key) || q.key === '__proto__' || props.some((x) => x.key === q.key)) continue
    if (q.kind !== 'text' && q.kind !== 'number' && q.kind !== 'color') continue
    const dflt = checkRuntimeValue(q.kind, q.default)
    props.push({ key: q.key, label: typeof q.label === 'string' ? q.label : q.key, kind: q.kind, default: dflt ?? (q.kind === 'number' ? 0 : q.kind === 'color' ? '#000000' : ''), ...(typeof q.format === 'string' ? { format: q.format } : {}) })
  }
  return { library: { id: lib.id, version: lib.version as number }, props }
}
