// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
//
// Editable-PPTX export (Beta fork, plan U5). A pure mapping from a
// bento/slides document to a pptxgenjs presentation, plus a DEGRADE REPORT
// naming every element that could not make the trip intact.
//
// Runs in the browser (the editor's Export PPTX button) and under node (the
// rig), so nothing here touches the DOM. The one browser-only capability,
// rasterising SVG markup to a PNG, is injected through `opts.rasterize`; when
// it is absent the SVG travels as an SVG picture, which PowerPoint 2016+ and
// Keynote both open.
//
// SECRETS. The editor hands this a copy with `collab` deleted (KTD7) and the
// mapper deletes it again on its own copy, so a caller that forgets still
// leaks nothing: `scripts/test-beta-pptx.ts` maps the raw fixture and greps
// the zip for every collab value. `scripts/test-export-secrets.ts` pins the
// editor's half.
//
// GEOMETRY. The canvas is px at 96 dpi; PowerPoint wants inches and points.
// 1280x720 px becomes a 13.333 x 7.5 in slide (16:9). Font sizes: px * 0.75.
//
// The mapping table is in the plan's Planning Contract; the short version:
//   text, code, shape, chart, table  -> editable
//   image                            -> native picture
//   svg, media (poster), embed (view)-> picture, reported
//   gradients, fonts, motion         -> reported

import PptxGenJS from 'pptxgenjs'
import type {
  BentoDoc, SlideElement, TextElement, CodeElement, ShapeElement, ImageElement,
  SvgElement, ChartElement, TableElement, MediaElement, EmbedElement,
} from '../model'

export interface DegradeEntry {
  /** `*` for a deck-wide degradation (motion, fonts) */
  slideId: string
  /** `*` for a deck-wide degradation */
  elementId: string
  /** stable machine key: gradient | svg | media | embed | code-colour | motion | fonts | path-arc | image-remote | chart | background | unknown:<type> */
  reason: string
  /** one human sentence, shown in the editor toast and printed by the rig */
  detail: string
}

export interface MapOptions {
  /** Browser-only: turn SVG markup into a PNG data URI at w x h px. Return null to fall back to the SVG itself. */
  rasterize?: (svg: string, w: number, h: number) => Promise<string | null>
  /** Values for {{author}} / {{company}} / {{date}} tokens; defaults from doc.meta and today. */
  fields?: Record<string, string>
}

export interface MapResult {
  pptx: PptxGenJS
  report: DegradeEntry[]
}

const PX_PER_IN = 96
const PT_PER_PX = 0.75
const inch = (px: number) => Math.round((px / PX_PER_IN) * 10000) / 10000
const pt = (px: number) => Math.round(px * PT_PER_PX * 100) / 100

/** A 4x3 mid-grey PNG used where an element has no picture to give. */
const PLACEHOLDER_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAADdv/LVAAAAEklEQVR4nGP4//8/AwMDAwMDAwAlBAP9YMz9BQAAAABJRU5ErkJggg=='

// ---- svg guard (DOM-free) ----------------------------------------------------
//
// Mirrors type/src/embed.ts safeView(): it must BE an svg, carry no script,
// foreign content, event handler or external reference. An allow-list on
// references (a same-document fragment or an inline raster), because naming
// the bad schemes is a losing game. In the browser the rasteriser runs the
// real sanitiser first; this is the node path's only guard.

const SVG_BANNED = /<\s*(script|iframe|object|embed|foreignObject|link|meta|style)\b/i
const SVG_HANDLER = /\son[a-z]+\s*=/i
const SVG_REMOTE = /\b(?:href|xlink:href|src)\s*=\s*["']?(?!#|data:image\/(?:png|jpe?g|gif|webp);base64,)/i

export function safeSvg(markup: string): string | null {
  const s = markup.trim()
  if (!/^<svg[\s>]/i.test(s)) return null
  if (SVG_BANNED.test(s) || SVG_HANDLER.test(s) || SVG_REMOTE.test(s)) return null
  return s
}

// ---- colour ----------------------------------------------------------------

interface Colour { hex: string; transparency: number }

/** '#rgb' | '#rrggbb' | '#rrggbbaa' | 'rgb()' | 'rgba()' | 'none' | 'transparent' -> hex + transparency %, or null for no paint. */
export function parseColour(value: string | undefined): Colour | null {
  if (!value) return null
  const v = value.trim().toLowerCase()
  if (v === 'none' || v === 'transparent') return null
  let m = /^#([0-9a-f]{3})$/.exec(v)
  if (m) return { hex: m[1].split('').map((c) => c + c).join('').toUpperCase(), transparency: 0 }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v)
  if (m) return { hex: m[1].toUpperCase(), transparency: m[2] ? Math.round((1 - parseInt(m[2], 16) / 255) * 100) : 0 }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/.exec(v)
  if (m) {
    const hex = [m[1], m[2], m[3]].map((n) => Math.max(0, Math.min(255, +n)).toString(16).padStart(2, '0')).join('').toUpperCase()
    const a = m[4] === undefined ? 1 : Math.max(0, Math.min(1, parseFloat(m[4])))
    return { hex, transparency: Math.round((1 - a) * 100) }
  }
  return null
}

const hexOr = (value: string | undefined, fallback: string): string => parseColour(value)?.hex ?? fallback

// ---- fonts -------------------------------------------------------------------

/** "'Playfair Display', Georgia, serif" -> "Playfair Display": PowerPoint wants one family name. */
export function fontFace(stack: string | undefined, fallback: string): string {
  const first = (stack ?? '').split(',')[0]?.trim().replace(/^['"]|['"]$/g, '')
  return first || fallback
}

// ---- rich text ---------------------------------------------------------------

interface Run { text: string; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; breakLine?: boolean }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
const decode = (s: string) => s.replace(/&(#?\w+);/g, (m, e: string) => {
  if (ENTITIES[e] !== undefined) return ENTITIES[e]
  if (/^#\d+$/.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 10))
  if (/^#x[0-9a-f]+$/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16))
  return m
})

/**
 * The inline HTML subset a text element carries (see untrusted.ts ALLOWED_TAGS)
 * flattened to pptxgenjs runs. Block tags break lines; unknown tags unwrap.
 */
export function htmlToRuns(html: string): Run[] {
  const runs: Run[] = []
  const state = { bold: 0, italic: 0, underline: 0, strike: 0 }
  let firstBlock = true
  const push = (text: string) => {
    if (!text) return
    runs.push({
      text,
      bold: state.bold > 0 || undefined,
      italic: state.italic > 0 || undefined,
      underline: state.underline > 0 || undefined,
      strike: state.strike > 0 || undefined,
    })
  }
  const br = () => {
    if (runs.length) runs[runs.length - 1].breakLine = true
    else runs.push({ text: '', breakLine: true })
  }
  const re = /<\/?([a-z0-9]+)[^>]*>|[^<]+/gi
  for (const m of html.matchAll(re)) {
    if (m[1] === undefined) { push(decode(m[0])); continue }
    const tag = m[1].toLowerCase()
    const closing = m[0].startsWith('</')
    const d = closing ? -1 : 1
    switch (tag) {
      case 'b': case 'strong': case 'h1': case 'h2': state.bold += d; break
      case 'i': case 'em': state.italic += d; break
      case 'u': state.underline += d; break
      case 's': case 'strike': case 'del': state.strike += d; break
      case 'br': br(); break
      default: break
    }
    if ((tag === 'p' || tag === 'div' || tag === 'li' || tag === 'h1' || tag === 'h2') && !closing) {
      if (firstBlock) firstBlock = false
      else br()
    }
    if (tag === 'li' && !closing) push('• ')
  }
  // never hand pptxgenjs an empty run list: PowerPoint drops the shape
  return runs.length ? runs : [{ text: '' }]
}

function resolveFields(html: string, fields: Record<string, string>): string {
  return html.replace(/\{\{\s*([a-z]+)\s*\}\}/gi, (m, k: string) => fields[k.toLowerCase()] ?? m)
}

// ---- svg path -> custom geometry ---------------------------------------------

type Pt = PptxGenJS.ShapeProps['points'] extends Array<infer P> | undefined ? P : never

/**
 * M/L/H/V/C/Q/Z (absolute and relative) become pptxgenjs points. Arcs (A) are
 * flattened to a few straight segments and reported: OOXML has an arc primitive
 * but it is centre-parameterised and pptxgenjs's is not a faithful map of SVG's
 * endpoint form.
 */
export function pathToPoints(d: string, box: [number, number, number, number]): { points: Pt[]; arcs: number } {
  const [bx, by, bw, bh] = box
  const sx = bw ? 1 / bw : 1
  const sy = bh ? 1 / bh : 1
  const norm = (x: number, y: number): [number, number] => [(x - bx) * sx, (y - by) * sy]
  const points: Pt[] = []
  let arcs = 0
  let cx = 0, cy = 0, startX = 0, startY = 0
  const tokens = d.match(/[MLHVCQZAmlhvcqza]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
  let i = 0
  let cmd = ''
  const num = () => parseFloat(tokens[i++])
  while (i < tokens.length) {
    const t = tokens[i]
    if (/[A-Za-z]/.test(t)) { cmd = t; i++; if (cmd === 'Z' || cmd === 'z') { points.push({ x: norm(startX, startY)[0], y: norm(startX, startY)[1], close: true } as Pt); cx = startX; cy = startY } ; continue }
    const rel = cmd === cmd.toLowerCase()
    switch (cmd.toUpperCase()) {
      case 'M': { let x = num(), y = num(); if (rel) { x += cx; y += cy } cx = x; cy = y; startX = x; startY = y; const [nx, ny] = norm(x, y); points.push({ x: nx, y: ny, moveTo: true } as Pt); cmd = rel ? 'l' : 'L'; break }
      case 'L': { let x = num(), y = num(); if (rel) { x += cx; y += cy } cx = x; cy = y; const [nx, ny] = norm(x, y); points.push({ x: nx, y: ny } as Pt); break }
      case 'H': { let x = num(); if (rel) x += cx; cx = x; const [nx, ny] = norm(cx, cy); points.push({ x: nx, y: ny } as Pt); break }
      case 'V': { let y = num(); if (rel) y += cy; cy = y; const [nx, ny] = norm(cx, cy); points.push({ x: nx, y: ny } as Pt); break }
      case 'C': { let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num(); if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy } const [nx, ny] = norm(x, y); const [a, b] = norm(x1, y1); const [c, e] = norm(x2, y2); points.push({ x: nx, y: ny, curve: { type: 'cubic', x1: a, y1: b, x2: c, y2: e } } as Pt); cx = x; cy = y; break }
      case 'Q': { let x1 = num(), y1 = num(), x = num(), y = num(); if (rel) { x1 += cx; y1 += cy; x += cx; y += cy } const [nx, ny] = norm(x, y); const [a, b] = norm(x1, y1); points.push({ x: nx, y: ny, curve: { type: 'quadratic', x1: a, y1: b } } as Pt); cx = x; cy = y; break }
      case 'A': { num(); num(); num(); num(); num(); let x = num(), y = num(); if (rel) { x += cx; y += cy } arcs++; const [nx, ny] = norm(x, y); points.push({ x: nx, y: ny } as Pt); cx = x; cy = y; break }
      default: i++
    }
  }
  return { points, arcs }
}

// ---- the mapper ----------------------------------------------------------------

export async function mapDeck(input: BentoDoc, opts: MapOptions = {}): Promise<MapResult> {
  // Never touch the caller's object, and never let a session travel (KTD7).
  const doc = JSON.parse(JSON.stringify(input)) as BentoDoc
  delete doc.collab

  const report: DegradeEntry[] = []
  const degrade = (slideId: string, elementId: string, reason: string, detail: string) =>
    report.push({ slideId, elementId, reason, detail })

  const W = doc.size?.width || 1280
  const H = doc.size?.height || 720
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'BENTO', width: inch(W), height: inch(H) })
  pptx.layout = 'BENTO'
  pptx.title = doc.title ?? ''
  if (doc.meta?.author) pptx.author = doc.meta.author
  if (doc.meta?.company) pptx.company = doc.meta.company
  if (doc.meta?.subject) pptx.subject = doc.meta.subject

  const bodyFace = fontFace(doc.theme?.fontFamily, 'Inter')
  const headingFace = fontFace(doc.theme?.headingFamily, bodyFace)
  const themeColour = hexOr(doc.theme?.color, '1A1A1A')
  const themeBg = hexOr(doc.theme?.background, 'FFFFFF')
  const chartColours = (doc.theme?.chartPalette ?? [doc.theme?.accent ?? '#4A7C59']).map((c) => hexOr(c, '4A7C59'))

  const today = new Date()
  const fields: Record<string, string> = {
    author: doc.meta?.author ?? '',
    company: doc.meta?.company ?? '',
    subject: doc.meta?.subject ?? '',
    event: doc.meta?.event ?? '',
    date: today.toISOString().slice(0, 10),
    year: String(today.getFullYear()),
    title: doc.title ?? '',
    ...(opts.fields ?? {}),
  }

  const asset = (ref: string | undefined): string | undefined =>
    ref?.startsWith('asset:') ? doc.assets?.[ref.slice(6)] : ref

  // deck-wide degradations, reported once each
  const slides = doc.slides ?? []
  const hasMotion = slides.some((s) =>
    s.transition === 'morph' || !!s.stateOf || !!s.hover ||
    s.elements.some((e) => !!e.fx || !!e.showOnHover || !!e.morphId))
  if (hasMotion) degrade('*', '*', 'motion', 'Morph transitions, entrance and ambient effects, hover states and state slides do not exist in PowerPoint; state slides are exported hidden.')
  if (doc.fonts?.length) {
    const names = [...new Set(doc.fonts.map((f) => f.family))].join(', ')
    degrade('*', '*', 'fonts', `Embedded fonts (${names}) are referenced by name; the recipient needs them installed or PowerPoint substitutes.`)
  }

  const svgPicture = async (markup: string, w: number, h: number): Promise<string> => {
    const png = opts.rasterize ? await opts.rasterize(markup, w, h) : null
    if (png) return png
    // No rasteriser (node): the SVG travels as itself, so it must pass the
    // same DOM-free guard type/src/embed.ts applies to an embed's view. A
    // refused picture is the placeholder; the report already names it.
    const safe = safeSvg(markup)
    if (!safe) return PLACEHOLDER_PNG
    const b64 = typeof btoa === 'function'
      ? btoa(unescape(encodeURIComponent(safe)))
      : Buffer.from(safe, 'utf8').toString('base64')
    return `image/svg+xml;base64,${b64}`
  }

  const picture = (s: PptxGenJS.Slide, data: string, el: SlideElement, fit: 'contain' | 'cover' | 'fill' = 'fill') => {
    const opt: PptxGenJS.ImageProps = { data, x: inch(el.x), y: inch(el.y), w: inch(el.w), h: inch(el.h) }
    if (el.rotation) opt.rotate = el.rotation
    if (el.opacity !== undefined && el.opacity < 1) opt.transparency = Math.round((1 - el.opacity) * 100)
    if (fit === 'contain') opt.sizing = { type: 'contain', w: inch(el.w), h: inch(el.h) }
    if (fit === 'cover') opt.sizing = { type: 'cover', w: inch(el.w), h: inch(el.h) }
    s.addImage(opt)
  }

  const isData = (src: string | undefined) => !!src && /^data:/.test(src)

  for (const slide of slides) {
    const s = pptx.addSlide()
    const hidden = !!slide.stateOf || !!slide.hidden
    if (hidden) s.hidden = true

    const bg = parseColour(slide.background)
    if (bg) s.background = { color: bg.hex }
    else {
      s.background = { color: themeBg }
      if (slide.background && slide.background !== 'none') degrade(slide.id, '*', 'background', `Slide background "${slide.background.slice(0, 40)}" is not a flat colour; the theme background is used.`)
    }

    for (const el of slide.elements) {
      const box = { x: inch(el.x), y: inch(el.y), w: inch(el.w), h: inch(el.h) }
      const rotate = el.rotation ? { rotate: el.rotation } : {}
      const transparency = el.opacity !== undefined && el.opacity < 1 ? Math.round((1 - el.opacity) * 100) : 0
      switch (el.type) {
        case 'text': {
          const t = el as TextElement
          const runs = htmlToRuns(resolveFields(t.html, fields))
          const colour = parseColour(t.color)
          const face = fontFace(t.fontFamily, /playfair|serif/i.test(t.fontFamily ?? '') ? headingFace : bodyFace)
          const props: PptxGenJS.TextPropsOptions = {
            ...box, ...rotate,
            fontFace: face,
            fontSize: pt(t.fontSize),
            color: colour?.hex ?? themeColour,
            bold: t.fontWeight >= 600,
            align: t.align ?? 'left',
            valign: t.valign ?? 'top',
            lineSpacingMultiple: t.lineHeight || 1.2,
            margin: 0,
            fit: 'none',
            wrap: true,
          }
          if (t.letterSpacing) props.charSpacing = pt(t.letterSpacing)
          if (transparency || colour?.transparency) props.transparency = Math.max(transparency, colour?.transparency ?? 0)
          s.addText(runs.map((r) => ({ text: r.text, options: { bold: r.bold || props.bold, italic: r.italic, underline: r.underline ? { style: 'sng' } : undefined, strike: r.strike ? 'sngStrike' : undefined, breakLine: r.breakLine } })), props)
          if (t.colorGradient) degrade(slide.id, el.id, 'gradient', 'Gradient text is flattened to its solid colour.')
          break
        }
        case 'code': {
          const c = el as CodeElement
          const lines = c.content.split('\n')
          s.addText(lines.map((line, i) => ({ text: line, options: { breakLine: i < lines.length - 1 } })), {
            ...box, ...rotate,
            fontFace: fontFace(c.fontFamily, 'Courier New'),
            fontSize: pt(c.fontSize),
            color: hexOr(c.color, themeColour),
            align: c.align ?? 'left',
            valign: c.valign ?? 'top',
            lineSpacingMultiple: c.lineHeight || 1.4,
            margin: 0, fit: 'none', wrap: true,
          })
          degrade(slide.id, el.id, 'code-colour', 'Code is exported as monospace text without syntax colouring.')
          break
        }
        case 'shape': {
          const sh = el as ShapeElement
          const fill = parseColour(sh.fillGradient ? sh.fillGradient.stops[0]?.color : sh.fill)
          if (sh.fillGradient) degrade(slide.id, el.id, 'gradient', `Gradient fill flattened to its first stop (${sh.fillGradient.stops[0]?.color ?? '?'}).`)
          const stroke = parseColour(sh.stroke)
          const line: PptxGenJS.ShapeLineProps | undefined = stroke && sh.strokeWidth > 0
            ? {
                color: stroke.hex, width: pt(sh.strokeWidth),
                transparency: stroke.transparency || undefined,
                dashType: sh.strokeStyle === 'dashed' ? 'dash' : sh.strokeStyle === 'dotted' ? 'sysDot' : 'solid',
                beginArrowType: arrowOf(sh.lineStart), endArrowType: arrowOf(sh.lineEnd),
              }
            : undefined
          const common: PptxGenJS.ShapeProps = {
            ...box, ...rotate,
            fill: fill ? { color: fill.hex, transparency: Math.max(transparency, fill.transparency) || undefined } : { type: 'none' },
            line: line ?? { type: 'none' },
          }
          if (sh.shape === 'line') {
            s.addShape(pptx.ShapeType.line, { ...common, h: box.h || 0, fill: undefined })
          } else if (sh.shape === 'rect') {
            if (sh.radius > 0) s.addShape(pptx.ShapeType.roundRect, { ...common, rectRadius: inch(Math.min(sh.radius, Math.min(sh.w, sh.h) / 2)) })
            else s.addShape(pptx.ShapeType.rect, common)
          } else if (sh.shape === 'ellipse') {
            s.addShape(pptx.ShapeType.ellipse, common)
          } else if (sh.shape === 'triangle') {
            s.addShape(pptx.ShapeType.triangle, common)
          } else if (sh.shape === 'arrow') {
            s.addShape(pptx.ShapeType.rightArrow, common)
          } else if (sh.shape === 'path' && sh.d) {
            const pb = sh.pathBox ?? [0, 0, sh.w, sh.h]
            const { points, arcs } = pathToPoints(sh.d, pb)
            const scaled = points.map((p) => scalePoint(p, box.w, box.h))
            s.addShape('custGeom' as PptxGenJS.SHAPE_NAME, { ...common, points: scaled })
            if (arcs) degrade(slide.id, el.id, 'path-arc', `${arcs} arc segment(s) flattened to straight lines.`)
          } else {
            s.addShape(pptx.ShapeType.rect, common)
          }
          break
        }
        case 'image': {
          const im = el as ImageElement
          const src = asset(im.src)
          if (isData(src)) picture(s, src!, el, im.fit)
          else { picture(s, PLACEHOLDER_PNG, el); degrade(slide.id, el.id, 'image-remote', `Image at ${(src ?? '').slice(0, 60)} is not embedded in the file; a placeholder was exported.`) }
          break
        }
        case 'svg': {
          const sv = el as SvgElement
          const markup = (sv.asset ? doc.assets?.[sv.asset] : sv.markup) ?? ''
          picture(s, markup ? await svgPicture(markup, el.w, el.h) : PLACEHOLDER_PNG, el, 'contain')
          degrade(slide.id, el.id, 'svg', 'SVG artwork is exported as a picture, not as editable shapes.')
          break
        }
        case 'chart': {
          const ch = el as ChartElement
          addChart(pptx, s, ch, box, chartColours, bodyFace, themeColour, (reason, detail) => degrade(slide.id, el.id, reason, detail))
          break
        }
        case 'table': {
          addTable(s, el as TableElement, box, bodyFace, themeColour)
          break
        }
        case 'media': {
          const md = el as MediaElement
          const poster = asset(md.poster)
          picture(s, isData(poster) ? poster! : PLACEHOLDER_PNG, el, md.fit ?? 'contain')
          degrade(slide.id, el.id, 'media', `${md.kind === 'audio' ? 'Audio' : 'Video'} is exported as its poster image.`)
          break
        }
        case 'embed': {
          // The static `view` tier is the whole point of the shape (KTD3):
          // it is what prints, thumbnails and exports. Never the live frame.
          const em = el as EmbedElement
          const view = asset(em.view)
          picture(s, view && /^<svg/i.test(view.trim()) ? await svgPicture(view, el.w, el.h) : PLACEHOLDER_PNG, el, 'contain')
          degrade(slide.id, el.id, 'embed', 'A live embed is exported as a picture of its static view.')
          break
        }
        default: {
          // A kind this mapper does not know (whatever upstream adds next).
          // Anything carrying a static picture exports as one so export never
          // crashes on a new element, and the report says so.
          const any = el as unknown as { id: string; type: string; x: number; y: number; w: number; h: number; rotation: number; opacity: number; view?: string; poster?: string; src?: string }
          const view = asset(any.view) ?? asset(any.poster) ?? (isData(any.src) ? any.src : undefined)
          const data = view
            ? (/^<svg/i.test(view.trim()) ? await svgPicture(view, any.w, any.h) : isData(view) ? view : PLACEHOLDER_PNG)
            : PLACEHOLDER_PNG
          picture(s, data, any as unknown as SlideElement, 'contain')
          degrade(slide.id, any.id, `unknown:${any.type}`, `Element kind "${any.type}" is not mapped; a picture stands in.`)
        }
      }
    }

    if (slide.notes && slide.notes.trim()) s.addNotes(slide.notes)
  }

  return { pptx, report }
}

function arrowOf(end: ShapeElement['lineEnd']): PptxGenJS.ShapeLineProps['endArrowType'] {
  switch (end) {
    case 'arrow': return 'triangle'
    case 'dot': return 'oval'
    case 'bar': return 'stealth'
    default: return 'none'
  }
}

function scalePoint(p: Pt, w: number, h: number): Pt {
  const q = { ...(p as Record<string, unknown>) } as Record<string, unknown>
  q.x = (p as { x: number }).x * w
  q.y = (p as { y: number }).y * h
  const curve = (p as { curve?: Record<string, number | string> }).curve
  if (curve) {
    const c = { ...curve }
    for (const k of ['x1', 'x2']) if (typeof c[k] === 'number') c[k] = (c[k] as number) * w
    for (const k of ['y1', 'y2']) if (typeof c[k] === 'number') c[k] = (c[k] as number) * h
    q.curve = c
  }
  return q as unknown as Pt
}

// ---- chart ---------------------------------------------------------------------

type Opt = Record<string, any>

function addChart(
  pptx: PptxGenJS, s: PptxGenJS.Slide, el: ChartElement, box: { x: number; y: number; w: number; h: number },
  palette: string[], face: string, colour: string, degrade: (reason: string, detail: string) => void,
) {
  const option = (el.option ?? {}) as Opt
  const series: Opt[] = Array.isArray(option.series) ? option.series : option.series ? [option.series] : []
  if (!series.length) { degrade('chart', 'Chart has no series; nothing exported.'); return }
  const types = [...new Set(series.map((x) => String(x.type ?? 'bar')))]
  const kind = types[0]
  if (types.length > 1) degrade('chart-mixed', `Mixed series types (${types.join(', ')}) exported as ${kind}.`)
  const xAxis = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis
  const labels: string[] = Array.isArray(xAxis?.data) ? xAxis.data.map(String) : []
  const colours = series.map((x, i) => hexOr(x.itemStyle?.color ?? x.lineStyle?.color, palette[i % palette.length]))
  const common: PptxGenJS.IChartOpts = {
    ...box,
    chartColors: colours,
    showLegend: series.length > 1 || kind === 'pie',
    legendPos: 'b',
    legendFontFace: face, legendFontSize: 10, legendColor: colour,
    catAxisLabelFontFace: face, catAxisLabelFontSize: 10, catAxisLabelColor: colour,
    valAxisLabelFontFace: face, valAxisLabelFontSize: 10, valAxisLabelColor: colour,
  }
  if (kind === 'pie' || kind === 'doughnut') {
    const first = series[0]
    const data = (first.data ?? []) as Array<Opt | number>
    const names = data.map((d, i) => typeof d === 'object' ? String(d.name ?? i) : String(i))
    const values = data.map((d) => typeof d === 'object' ? Number(d.value ?? 0) : Number(d))
    s.addChart(kind === 'doughnut' ? pptx.ChartType.doughnut : pptx.ChartType.pie, [{ name: String(first.name ?? 'Series'), labels: names, values }], {
      ...common, chartColors: values.map((_, i) => palette[i % palette.length]), showPercent: false, showValue: true,
      dataLabelFontFace: face, dataLabelFontSize: 10, dataLabelColor: colour,
    })
    return
  }
  if (kind === 'scatter') {
    // pptxgenjs scatter: first series is X, the rest are Y
    const pts = ((series[0].data ?? []) as Array<[number, number]>)
    s.addChart(pptx.ChartType.scatter, [
      { name: 'X', values: pts.map((p) => Number(p[0])) },
      ...series.map((x) => ({ name: String(x.name ?? 'Series'), values: ((x.data ?? []) as Array<[number, number]>).map((p) => Number(p[1])) })),
    ], { ...common, lineSize: 0 })
    return
  }
  const data = series.map((x) => ({
    name: String(x.name ?? 'Series'),
    labels: labels.length ? labels : ((x.data ?? []) as unknown[]).map((_, i) => String(i + 1)),
    values: ((x.data ?? []) as Array<Opt | number>).map((d) => typeof d === 'object' ? Number(d.value ?? 0) : Number(d)),
  }))
  const chartType = kind === 'line' ? pptx.ChartType.line : kind === 'area' ? pptx.ChartType.area : pptx.ChartType.bar
  const extra: PptxGenJS.IChartOpts = kind === 'bar' ? { barDir: 'col', barGapWidthPct: 60 } : kind === 'line' ? { lineSize: 2, lineSmooth: series.some((x) => !!x.smooth) } : {}
  if (!['bar', 'line', 'area'].includes(kind)) degrade('chart', `Series type "${kind}" is not mapped; exported as bars.`)
  s.addChart(chartType, data, { ...common, ...extra })
}

// ---- table -----------------------------------------------------------------------

function addTable(s: PptxGenJS.Slide, el: TableElement, box: { x: number; y: number; w: number; h: number }, face: string, colour: string) {
  const st = el.style
  const weights = el.columns.map((c) => Math.max(0.01, c.w || 1))
  const total = weights.reduce((a, b) => a + b, 0)
  const colW = weights.map((w) => Math.round((box.w * (w / total)) * 10000) / 10000)
  const border = parseColour(st.borderColor)
  const borderOpt: PptxGenJS.BorderProps = border && st.borderWidth > 0
    ? { type: 'solid', pt: pt(st.borderWidth), color: border.hex }
    : { type: 'none' }
  const rows: PptxGenJS.TableRow[] = el.rows.map((row, r) => {
    const isHeader = el.header && r === 0
    const zebra = !isHeader && st.zebra && ((el.header ? r - 1 : r) % 2 === 1)
    return row.cells.map((cell) => {
      const runs = htmlToRuns(cell.html ?? '')
      const fill = isHeader ? parseColour(st.headerBg) : parseColour(cell.bg) ?? (zebra ? parseColour(st.zebra) : null)
      const text = runs.map((rn) => ({ text: rn.text, options: { bold: rn.bold || cell.bold || isHeader, italic: rn.italic, breakLine: rn.breakLine } }))
      const cellOpt: PptxGenJS.TableCellProps = {
        fontFace: fontFace(st.fontFamily, face),
        fontSize: pt(st.fontSize || 16),
        color: isHeader ? hexOr(st.headerColor, 'FFFFFF') : hexOr(cell.color ?? st.color, colour),
        align: cell.align ?? 'left',
        valign: 'middle',
        border: borderOpt,
        margin: [pt(st.cellPadY), pt(st.cellPadX), pt(st.cellPadY), pt(st.cellPadX)],
      }
      if (fill) cellOpt.fill = { color: fill.hex }
      return { text, options: cellOpt }
    })
  })
  s.addTable(rows, { ...box, colW, autoPage: false, fontFace: face })
}
