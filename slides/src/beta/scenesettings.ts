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
  | { kind: 'range'; min: number; max: number; step: number; decimals: number }

/**
 * The longest page address a web embed keeps: the shell's own `isWebUrl`
 * (slides/src/model.ts) refuses a longer one, so a settings change that would
 * pass it is refused in the form instead of being dropped on the next load.
 */
export const MAX_WEB_URL = 2048

const RANGE = /^range:(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/

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
  const r = RANGE.exec(format)
  if (r && kind === 'number') {
    const [min, max, step] = [Number(r[1]), Number(r[2]), Number(r[3])]
    // the precision the range is written in: a step lands on min + k*step to that many decimals
    const decimals = Math.max(...[r[1], r[3]].map((x) => (x.split('.')[1] ?? '').length))
    if ([min, max, step].every(Number.isFinite) && min < max && step > 0 && decimals <= 20) return { kind: 'range', min, max, step, decimals }
  }
  return null
}

/** Every declared setting with its current value: the chosen one, else the default. Undeclared keys are not settings. */
export function valuesOf(props: RuntimeProp[], values?: Record<string, Value>): Record<string, Value> {
  const out: Record<string, Value> = {}
  for (const p of props) {
    const v = values && Object.prototype.hasOwnProperty.call(values, p.key) ? values[p.key] : undefined
    // as the gate keeps it (a stored "1" for a number is the number 1)
    out[p.key] = (v !== undefined ? checkRuntimeValue(p.kind, v) : undefined) ?? p.default
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
      const held = snap(n, prop.format as string)
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

// ---- range snapping, in exact decimals -------------------------------------
//
// A step is min + k*step, and the nearest one is found in exact decimal
// arithmetic, never in binary doubles: the range is read from the digits it
// is written in, and the input from its shortest decimal spelling (String(n),
// the number as it was typed). In doubles three things broke before any
// rounding could repair them: n - min left the safe-integer range on a large
// negative offset, the quotient overflowed on a finite huge bound, and a
// decimal midpoint (0.15 on a 0.1 step) is not a midpoint in binary, so the
// tie went the wrong way. The one conversion back to a number is the last step.

/** A decimal as m * 10^e, exactly. Reads "-12.50", "1e+308", "1.5e-7". */
function dec(s: string): { m: bigint; e: number } {
  const x = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(s)
  if (!x) throw new Error(`not a decimal: ${s}`)
  const frac = x[3] ?? ''
  return { m: BigInt(x[1] + x[2] + frac), e: Number(x[4] ?? 0) - frac.length }
}
const at = (d: { m: bigint; e: number }, e: number) => d.m * 10n ** BigInt(d.e - e)

/**
 * The value a range keeps for n: at or past an end, that end (allowed even
 * where the steps do not land on it); between them, the nearest step, a tie
 * going up as Math.round's does, and never past max.
 */
function snap(n: number, format: string): number {
  const r = RANGE.exec(format)!
  const [lo, hi, st, x] = [dec(r[1]), dec(r[2]), dec(r[3]), dec(String(n))]
  const e = Math.min(lo.e, hi.e, st.e, x.e)
  const [min, max, step, v] = [at(lo, e), at(hi, e), at(st, e), at(x, e)]
  if (v >= max) return Number(r[2])
  if (v <= min) return Number(r[1])
  const k = (2n * (v - min) + step) / (2n * step) // floor of (v-min)/step + 1/2; both sides positive
  let s = min + k * step
  if (s > max) s = max
  return Number(`${s}e${e}`)
}

/** Whether n is min + k*step exactly, for a range format: what a native slider (step-aligned) can show. */
export function onStep(format: string, n: number): boolean {
  const r = RANGE.exec(format)
  if (!r || !Number.isFinite(n)) return false
  const [lo, st, x] = [dec(r[1]), dec(r[3]), dec(String(n))]
  const e = Math.min(lo.e, st.e, x.e)
  const d = at(x, e) - at(lo, e)
  return d >= 0n && d % at(st, e) === 0n
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

/**
 * The settings a web scene's address carries, by declared key, AS THEY ARE:
 * a value outside today's range or choices (an older copy, a hand edit) is
 * shown, not replaced by the default, so the form and the active preset say
 * what the page really gets. Only a missing value, or one the gate would not
 * keep as that kind, reads as the default.
 */
export function readQuery(url: string | undefined, props: RuntimeProp[]): Record<string, Value> {
  const out: Record<string, Value> = {}
  let q: URLSearchParams | null = null
  try { q = url ? new URL(url).searchParams : null } catch { q = null }
  for (const p of props) {
    const raw = q?.get(p.key)
    const typed = raw == null ? undefined : p.kind === 'number' ? (raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : undefined) : raw
    out[p.key] = (typed !== undefined ? checkRuntimeValue(p.kind, typed) : undefined) ?? p.default
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

/** The address with every setting written at once (a preset): one length check, on the final address. */
export function writeQueryAll(url: string | undefined, values: Record<string, Value>): { url: string } | { error: 'Not a web address' | 'This makes the page address too long' } {
  let u: URL
  try { u = new URL(url ?? '') } catch { return { error: 'Not a web address' } }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Not a web address' }
  for (const [k, v] of Object.entries(values)) u.searchParams.set(k, String(v))
  return u.href.length > MAX_WEB_URL ? { error: 'This makes the page address too long' } : { url: u.href }
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
