// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Beta build: runtime slides. A runtime slide is one live HTML scene that
// fills the slide, recorded in `slide.runtime` (model.ts RuntimeSlide), plus
// its still as an ordinary full-bleed `image` element in `slide.elements`.
// The still being a real element is the whole backward-compatibility story:
// an older shell paints `elements` and nothing else, so it shows the still
// with no code at all (docs/plans/2026-09-14-001, KTD1).
//
// Every surface that treats a runtime slide differently (render, present,
// panels, export, the sanitiser) does it in one guard block that delegates
// here, so the Beta addition stays out of upstream's files (fork rule 2).
//
// Deliberately free of DOM and of untrusted.ts: untrusted.ts imports this
// file for SLIDE_CHECKS, so the checks below cannot borrow its helpers.

import type { BentoDoc, ImageElement, RuntimeProp, RuntimeSlide, Slide } from './model.ts'
import { RUNTIME_SRC_BUDGET } from './model.ts'

export function isRuntimeSlide(slide: Slide | null | undefined): boolean {
  return !!slide && typeof slide.runtime === 'object' && slide.runtime !== null
}

/**
 * The still to paint: the image element carrying `runtime.still`, else the
 * slide's first image element (a placeholder has no still ref yet), else the
 * bare `asset:` ref when no element holds it. null when there is nothing.
 */
export function runtimeStill(slide: Slide, doc: BentoDoc): ImageElement | string | null {
  if (!isRuntimeSlide(slide)) return null
  const ref = slide.runtime!.still
  const images = slide.elements.filter((el): el is ImageElement => el.type === 'image')
  const holder = ref ? images.find((el) => el.src === ref) : undefined
  if (holder) return holder
  if (images.length) return images[0]
  return ref && doc.assets?.[assetKey(ref)] != null ? ref : null
}

/**
 * What a present-mode frame loads: the url override when set, else the scene
 * HTML decoded from its asset. null when the slide has neither (a placeholder,
 * or a source refused on paste), in which case the still stays.
 */
export function runtimeSource(slide: Slide, doc: BentoDoc): { html?: string; url?: string } | null {
  if (!isRuntimeSlide(slide)) return null
  const rt = slide.runtime!
  if (typeof rt.url === 'string' && HTTPS.test(rt.url)) return { url: rt.url }
  if (typeof rt.src !== 'string' || !rt.src.startsWith('asset:')) return null
  const raw = doc.assets?.[assetKey(rt.src)]
  if (typeof raw !== 'string') return null
  const html = decodeAsset(raw)
  return html == null ? null : { html }
}

/** Asset keys the record references, for the clipboard to carry. */
export function runtimeAssetKeys(slide: Slide): string[] {
  const rt = slide.runtime
  if (!rt) return []
  return [rt.src, rt.still].filter((r): r is string => typeof r === 'string' && r.startsWith('asset:')).map(assetKey)
}

/** Follow a paste's asset-key remap (clipboard.ts mergeAssets). */
export function remapRuntimeRefs(slide: Slide, remap: Map<string, string>): void {
  const rt = slide.runtime
  if (!rt || !remap.size) return
  for (const k of ['src', 'still'] as const) {
    const ref = rt[k]
    if (typeof ref === 'string' && ref.startsWith('asset:') && remap.has(assetKey(ref))) rt[k] = 'asset:' + remap.get(assetKey(ref))
  }
}

// ---- the sanitiser ---------------------------------------------------------

const HTTPS = /^https:\/\//i
/** Same breakout characters untrusted.ts refuses in an id or asset key. */
const BREAKOUT = /["'<>{};]/
const PROP_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
/** Mirrors untrusted.ts `color` (and render.ts cssColor): one rule for colours. */
const COLOR_CHARS = /^[#a-zA-Z0-9(),.%\s/-]+$/
const COLOR_TRICKS = /url\s*\(|expression|@|\\/i
const MAX_PROPS = 64
const MAX_TEXT = 4_000
const MAX_URL = 4_000
const MAX_STEPS = 10_000
const PROTO = '__proto__'
const KIND_DEFAULT: Record<RuntimeProp['kind'], string | number> = { text: '', number: 0, color: '#000000' }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const assetKey = (ref: string) => ref.slice(6)
const assetRef = (v: unknown): string | undefined =>
  typeof v === 'string' && v.startsWith('asset:') && v.length > 6 && v.length <= 206 && !BREAKOUT.test(v) ? v : undefined
const safeColor = (v: unknown): v is string =>
  typeof v === 'string' && !!v.trim() && v.trim().length <= 64 && COLOR_CHARS.test(v.trim()) && !COLOR_TRICKS.test(v)
const finite = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

function checkValue(kind: RuntimeProp['kind'], v: unknown): string | number | undefined {
  if (kind === 'number') return finite(v)
  if (kind === 'color') return safeColor(v) ? v : undefined
  return typeof v === 'string' && v.length <= MAX_TEXT ? v : undefined
}

/**
 * Rebuild a foreign `runtime` record. Unlike most of untrusted.ts this repairs
 * a little: a bad `steps` becomes 0 and a bad prop default becomes its kind's
 * default. Both are numeric or constant coercions that cannot smuggle anything,
 * and dropping them instead would turn a scene into a native slide over a typo.
 * An unknown prop kind drops that prop only; values are kept only for declared
 * keys. `src` and `still` must be `asset:` refs and `url` https.
 *
 * With `assets` (the paste's asset table) a source whose bytes exceed
 * RUNTIME_SRC_BUDGET is refused too; SLIDE_CHECKS runs without it, because a
 * check sees one value and the bytes live elsewhere.
 */
export function checkRuntime(value: unknown, assets?: Record<string, string>): RuntimeSlide | undefined {
  if (!isPlainObject(value)) return undefined
  // built in the model's key order, so a clean record round-trips byte-identical
  const out = {} as RuntimeSlide

  const src = assetRef(value.src)
  if (src && !(assets && assetBytes(assets[assetKey(src)]) > RUNTIME_SRC_BUDGET)) out.src = src
  const still = assetRef(value.still)
  if (typeof value.url === 'string' && value.url.length <= MAX_URL && HTTPS.test(value.url)) out.url = value.url
  if (still) out.still = still

  const steps = finite(value.steps)
  out.steps = steps !== undefined && Number.isInteger(steps) && steps >= 0 && steps <= MAX_STEPS ? steps : 0

  out.props = []
  if (Array.isArray(value.props)) {
    for (const p of value.props.slice(0, MAX_PROPS)) {
      if (!isPlainObject(p) || typeof p.key !== 'string' || !PROP_KEY.test(p.key) || p.key === PROTO) continue
      if (p.kind !== 'text' && p.kind !== 'number' && p.kind !== 'color') continue
      if (out.props.some((q) => q.key === p.key)) continue
      const label = typeof p.label === 'string' && p.label.length <= 200 ? p.label : p.key
      out.props.push({ key: p.key, label, kind: p.kind, default: checkValue(p.kind, p.default) ?? KIND_DEFAULT[p.kind] })
    }
  }

  if (isPlainObject(value.values)) {
    const values: Record<string, string | number> = {}
    for (const prop of out.props) {
      if (prop.key === PROTO || !Object.prototype.hasOwnProperty.call(value.values, prop.key)) continue
      const v = checkValue(prop.kind, value.values[prop.key])
      if (v !== undefined) values[prop.key] = v
    }
    if (Object.keys(values).length) out.values = values
  }
  return out
}

/** Decoded size of an asset value in bytes (a data: URI or raw markup). */
function assetBytes(raw: string | undefined): number {
  if (typeof raw !== 'string') return 0
  const m = /^data:[^,]*;base64,/i.exec(raw)
  if (m) return Math.floor(((raw.length - m[0].length) * 3) / 4)
  return new TextEncoder().encode(raw).length
}

function decodeAsset(raw: string): string | null {
  if (!raw.startsWith('data:')) return raw
  const comma = raw.indexOf(',')
  if (comma < 0) return null
  const meta = raw.slice(5, comma)
  const body = raw.slice(comma + 1)
  try {
    if (/;base64$/i.test(meta)) {
      const bin = atob(body)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new TextDecoder().decode(bytes)
    }
    return decodeURIComponent(body)
  } catch {
    return null
  }
}
