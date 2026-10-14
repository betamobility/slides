// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Beta build: the scene library's rules that BOTH sides apply (2026-10-13-2236
// plan, U8 and U11). scripts/lib/beta-library.mjs refuses a scene folder that
// breaks them before the manifest is built; slides/src/beta/gallery.ts leaves a
// scene that breaks them off the shelf, so a manifest that did not come from
// that build is held to the same rules. One copy, imported by both: node runs
// this file as TypeScript (type stripping), the shell bundles it.

/**
 * Hosts a WEB scene may point at. A web scene runs whatever its host serves at
 * show time, so the host has to be one Beta controls. Exact names, no
 * wildcard: a new host is a reviewed line here.
 */
export const WEB_HOSTS: readonly string[] = ['slides.betamobility.ai', 'design.betamobility.ai']

// A still is a PICTURE. The check reads it with a strict scanner for a small
// subset of XML (elements, double- or single-quoted attributes separated by
// whitespace, text, comments, one leading XML declaration) and then holds the
// elements and attributes to an allowlist: what a drawing needs, and nothing
// that can run, load or link. Anything outside the grammar is refused, so the
// cost of a gap is a still that has to be re-saved, never one that passes
// broken or active. The manifest is stored as given, so a still is refused
// here, naming the file, instead of being cleaned somewhere unseen.
const SVG_ELEMENTS = new Set(['svg', 'g', 'defs', 'title', 'desc', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path',
  'text', 'tspan', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'use'])
const SVG_NS = 'http://www.w3.org/2000/svg'
/** The attributes a drawing needs. An allowlist too: a property the list does not name
 *  (cursor, filter, an animation's target) is refused rather than reasoned about. */
const SVG_ATTRIBUTES = new Set([
  'xmlns', 'xmlns:xlink', 'xml:space', 'version', 'viewBox', 'preserveAspectRatio', 'width', 'height', 'x', 'y', 'id', 'role', 'aria-label', 'aria-hidden',
  'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'd', 'points', 'transform', 'href',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit',
  'opacity', 'visibility', 'display', 'clip-path', 'clip-rule', 'mask', 'vector-effect', 'shape-rendering', 'paint-order',
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod',
  'patternUnits', 'patternContentUnits', 'patternTransform', 'maskUnits', 'maskContentUnits', 'clipPathUnits',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'letter-spacing', 'word-spacing', 'text-anchor', 'dominant-baseline', 'alignment-baseline',
  'text-decoration', 'text-rendering', 'dx', 'dy', 'textLength', 'lengthAdjust',
])
/** A character XML 1.0 allows in a document, less the C1 controls (a picture has no use for them). */
const xmlChar = (n: number): boolean => n === 0x9 || n === 0xa || n === 0xd || (n >= 0x20 && n <= 0x7e) || (n >= 0xa0 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff)
const WS = /[ \t\n\r]/
const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*/

/** Text or an attribute value as the browser reads it, or null when a reference in it is not one XML has. */
function unescape(text: string): string | null {
  let out = ''
  for (let i = 0; i < text.length;) {
    const c = text.codePointAt(i)!
    if (!xmlChar(c)) return null
    if (text[i] !== '&') { out += String.fromCodePoint(c); i += c > 0xffff ? 2 : 1; continue }
    const m = /^&(?:(amp|lt|gt|quot|apos)|#(\d{1,7})|#x([0-9a-fA-F]{1,6}));/.exec(text.slice(i))
    if (!m) return null
    const n = m[1] ? '&<>"\''.codePointAt(['amp', 'lt', 'gt', 'quot', 'apos'].indexOf(m[1]))! : m[2] ? Number(m[2]) : parseInt(m[3], 16)
    if (!xmlChar(n)) return null
    out += String.fromCodePoint(n)
    i += m[0].length
  }
  return out
}

/** Read the still: its elements with their attributes, or the reason it does not parse. */
interface Element { name: string; attrs: Map<string, string>; root: boolean }

function scanSvg(src: string): { error: string } | { elements: Element[] } {
  let i = 0
  const elements: Element[] = []
  const fail = (why: string) => ({ error: `${why} (not well-formed)` })
  const space = () => { while (i < src.length && WS.test(src[i])) i++ }
  const comment = () => {
    const end = src.indexOf('-->', i + 4)
    if (end < 0) return false
    const body = src.slice(i + 4, end)
    if (body.includes('--') || body.endsWith('-') || unescape(body.replace(/&/g, '&amp;')) === null) return false
    i = end + 3
    return true
  }
  /** Whitespace and comments, where the document allows nothing else. */
  const misc = () => {
    for (;;) {
      space()
      if (!src.startsWith('<!--', i)) return true
      if (!comment()) return false
    }
  }
  if (src.startsWith('<?xml', i)) {
    const end = src.indexOf('?>', i)
    if (end < 0 || !/^<\?xml[ \t]+version=(["'])1\.0\1(?:[ \t]+encoding=(["'])[Uu][Tt][Ff]-8\2)?[ \t]*$/.test(src.slice(i, end))) return fail('an XML declaration this check does not read')
    i = end + 2
  }
  if (!misc()) return fail('a malformed comment')
  if (src[i] !== '<') return fail('no root element')
  const stack: string[] = []
  for (;;) {
    if (src.startsWith('</', i)) {
      i += 2
      const name = NAME.exec(src.slice(i))?.[0]
      if (!name) return fail('a malformed closing tag')
      i += name.length
      space()
      if (src[i] !== '>') return fail(`a malformed </${name}>`)
      i++
      if (stack.pop() !== name) return fail(`a </${name}> that closes nothing open`)
    } else if (src.startsWith('<!--', i)) {
      if (!comment()) return fail('a malformed comment')
    } else if (src[i] === '<') {
      if (!stack.length && elements.length) return fail('more than one root element')
      i++
      const name = NAME.exec(src.slice(i))?.[0]
      if (!name) return fail('a malformed tag')
      i += name.length
      const attrs = new Map<string, string>()
      let selfClosing = false
      for (;;) {
        const before = i
        space()
        if (src.startsWith('/>', i)) { i += 2; selfClosing = true; break }
        if (src[i] === '>') { i++; break }
        if (i === before) return fail(`attributes on <${name}> not separated by whitespace`)
        const key = NAME.exec(src.slice(i))?.[0]
        if (!key) return fail(`a malformed attribute on <${name}>`)
        i += key.length
        space()
        if (src[i] !== '=') return fail(`${key} without a value on <${name}>`)
        i++
        space()
        const q = src[i]
        if (q !== '"' && q !== "'") return fail(`an unquoted ${key} on <${name}>`)
        const end = src.indexOf(q, i + 1)
        if (end < 0) return fail(`an unclosed ${key} on <${name}>`)
        const raw = src.slice(i + 1, end)
        const value = raw.includes('<') ? null : unescape(raw)
        if (value === null) return fail(`a character or reference XML does not allow in ${key}`)
        if (attrs.has(key)) return fail(`${key} written twice on one <${name}>`)
        attrs.set(key, value)
        i = end + 1
      }
      elements.push({ name, attrs, root: !stack.length })
      if (!selfClosing) stack.push(name)
    } else if (i >= src.length) {
      return stack.length ? fail(`a <${stack[stack.length - 1]}> never closed`) : fail('no root element')
    } else {
      const end = src.indexOf('<', i)
      const text = src.slice(i, end < 0 ? src.length : end)
      if (unescape(text) === null || text.includes('>')) return fail('text with a character or reference XML does not allow')
      i += text.length
    }
    if (!stack.length) {
      // the root is closed: only whitespace and comments may follow
      if (!misc()) return fail('a malformed comment')
      if (i < src.length) return fail('content after the root element')
      return { elements }
    }
  }
}

/** Why this SVG is not a plain picture, or null when it is one. */
export function activeSvg(svg: string): string | null {
  const read = scanSvg(svg)
  if ('error' in read) return read.error
  for (const { name, attrs, root } of read.elements) {
    if (!SVG_ELEMENTS.has(name)) return `a <${name}> element`
    if (root && (name !== 'svg' || attrs.get('xmlns') !== SVG_NS)) return 'a root that is not an <svg> in the SVG namespace'
    for (const [key, value] of attrs) {
      if (/^on/i.test(key)) return `an ${key} handler attribute`
      if (!SVG_ATTRIBUTES.has(key) && key !== 'style') return `a ${key} attribute`
      // a CSS escape can spell url( or anything else past a check that reads the letters; no picture needs one
      if (value.includes('\\')) return `a backslash in ${key}`
      if (key === 'style') return 'a style attribute (use presentation attributes)'
      // the namespace declarations a picture needs, each to its one right value
      if (key === 'xmlns' && value !== SVG_NS) return `a namespace other than SVG's on <${name}>`
      if (key === 'xmlns:xlink' && value !== 'http://www.w3.org/1999/xlink') return 'an xlink prefix bound to something other than XLink'
      if (key === 'xml:space' && value !== 'default' && value !== 'preserve') return 'an xml:space that is neither default nor preserve'
      if (key.includes(':') && key !== 'xmlns:xlink' && key !== 'xml:space') return `a ${key} attribute`
      if (key === 'href' && !/^#[\w.-]+$/.test(value)) return 'a link out of the file'
      if (/url\s*\(/i.test(value) && !/^url\(#[\w.-]+\)$/.test(value.trim())) return `a url() in ${key} that leaves the file`
      if (/javascript:|data:|https?:|^\s*\/\//i.test(value) && key !== 'xmlns' && key !== 'xmlns:xlink') return `a link out of the file in ${key}`
    }
  }
  return null
}
