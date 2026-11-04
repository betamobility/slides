// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// The #bento-doc block, split and re-serialised server-side.
//
// The store's posture is that a deck is STREAMED: the bytes a person uploaded
// are the bytes everyone gets back. Two places need to break that, and both
// go through here so neither can drift from the splice contract
// (docs/PLATFORM.md section 2, AGENTS.md hard rules 1 and 2):
//
//   · `pages.js mintDocIntoBlock` — a docId into the blank template
//   · a GRANT's read and write (one-click publish plan, KTD6/KTD7) — `collab`
//     stripped on the way out, the stored one restored on the way in
//
// What must survive a rewrite: exactly one block, the same `id`, plaintext
// JSON, `<` escaped as < so nothing can close the script early, and a
// file that still survives DOMParser → splice → outerHTML. Old updaters on
// people's disks are frozen code that depends on all of it.

/**
 * Split a file into its block and everything around it, or null when there is
 * not exactly one block.
 *
 * `shell` is the part a browser RUNS: the markup before the block, the
 * block's own opening and closing tags, and the markup after it. Only `body`
 * — the JSON text — is the document. That division is what lets a grant's
 * write be pinned: the block is the agent's to change, the shell is not.
 */
export function splitShell(html) {
  const src = String(html)
  // One pass: the same matches BLOCK_ALL makes (an opening tag, then the
  // first closing tag after it, then on from there), without the two
  // whole-file regex scans that took 6 ms on a 7.6 MB deck. The regexes are
  // made per call, so no lastIndex outlives it.
  const open = /<script\b[^>]*\bid=["']?bento-doc["']?[^>]*>/gi
  const close = /<\/script>/gi
  const found = []
  let from = 0
  while (found.length < 2) {
    open.lastIndex = from
    const o = open.exec(src)
    if (!o) break
    close.lastIndex = o.index + o[0].length
    const c = close.exec(src)
    if (!c) break
    found.push({ o, c })
    from = c.index + c[0].length
  }
  if (found.length !== 1) return null
  const { o, c } = found[0]
  return {
    prefix: src.slice(0, o.index),
    open: o[0],
    body: src.slice(o.index + o[0].length, c.index),
    close: c[0],
    suffix: src.slice(c.index + c[0].length),
  }
}

/** The bytes a browser would run, with the document itself taken out. */
export const shellOf = (parts) => `${parts.prefix}${parts.open}${parts.close}${parts.suffix}`

/**
 * `html` with its document passed through `fn` and written back.
 *
 * `fn` receives the parsed document and returns the one to store; returning
 * null leaves the file exactly as it came in (how an encrypted deck is
 * handled — its keys are inside the ciphertext, and there is nothing to
 * strip or restore).
 *
 * Throws on anything that would leave a file the store must not serve: no
 * block, two blocks, JSON that does not parse, or an escape that failed.
 */
export function rewriteBlock(html, fn) {
  const parts = splitShell(html)
  if (!parts) throw new Error('no single #bento-doc block')
  if (!parts.body.trim()) throw new Error('the #bento-doc block is empty')
  const doc = JSON.parse(parts.body)
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('the #bento-doc block is not a JSON object')
  const out = fn(doc)
  if (out === null) return String(html)
  const json = JSON.stringify(out === undefined ? doc : out).replace(/</g, '\\u003c')
  if (json.indexOf('</scr' + 'ipt') !== -1) throw new Error('a literal closing script tag survived escaping')
  return `${parts.prefix}${parts.open}${json}${parts.close}${parts.suffix}`
}

// --- reading a block without parsing it ------------------------------------
//
// Parsing a whole block costs the worker several full copies of the deck: the
// text, the parsed object, the re-serialised JSON, its escaped copy and the
// joined file. A 7.6 MB deck took about 21 ms on a laptop to strip one key,
// and in production every grant read and write of such a deck ended in
// Cloudflare's 1102 "Worker exceeded resource limits" (2026-11-04), which the
// editor reports as "Signed out". The store only ever needs a few TOP-LEVEL
// fields (format, title, docId, collab...), so `topFields` walks the
// top-level object and records where each value starts and ends, jumping
// over strings with indexOf. A deck is mostly a few very long strings
// (images, fonts, scenes), so the walk costs the number of tokens, not bytes.
//
// It checks that the block is one JSON object, that every bracket and string
// is closed, and that every value outside a string is a JSON literal. It does
// not check inside a string (escapes, control characters): the editor's
// untrusted gate reads every string again when the deck is opened.

const isWs = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09
const SCALAR = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/

/** Index just past the string that opens at `i`, or -1. */
function skipString(text, i) {
  let j = i + 1
  for (;;) {
    const k = text.indexOf('"', j)
    if (k < 0) return -1
    let b = 0
    while (text.charCodeAt(k - 1 - b) === 0x5c) b++
    if (b % 2 === 0) return k + 1
    j = k + 1
  }
}

function skipWs(text, i) {
  while (i < text.length && isWs(text.charCodeAt(i))) i++
  return i
}

/** Index just past the number, true, false or null at `i`, or -1. */
function skipScalar(text, i) {
  let j = i
  while (j < text.length) {
    const c = text.charCodeAt(j)
    if (c === 0x2c || c === 0x7d || c === 0x5d || c === 0x3a || isWs(c)) break
    j++
  }
  return j > i && SCALAR.test(text.slice(i, j)) ? j : -1
}

/** Index just past the JSON value at `i`, or -1. */
function skipValue(text, i) {
  const c = text.charCodeAt(i)
  if (c === 0x22) return skipString(text, i)
  if (c !== 0x7b && c !== 0x5b) return skipScalar(text, i)
  const stack = [] // what is open: '{' or '['
  let expect = 'value' // value | key | colon | sep | first-key | first-value
  let j = i
  for (;;) {
    j = skipWs(text, j)
    if (j >= text.length) return -1
    const ch = text.charCodeAt(j)
    const top = stack[stack.length - 1]
    if (expect === 'value' || expect === 'first-value') {
      if (ch === 0x7b) { stack.push('{'); j++; expect = 'first-key'; continue }
      if (ch === 0x5b) { stack.push('['); j++; expect = 'first-value'; continue }
      if (ch === 0x5d && expect === 'first-value') { stack.pop(); j++; if (!stack.length) return j; expect = 'sep'; continue }
      const end = ch === 0x22 ? skipString(text, j) : skipScalar(text, j)
      if (end < 0) return -1
      j = end; expect = 'sep'; continue
    }
    if (expect === 'key' || expect === 'first-key') {
      if (ch === 0x7d && expect === 'first-key') { stack.pop(); j++; if (!stack.length) return j; expect = 'sep'; continue }
      if (ch !== 0x22) return -1
      j = skipString(text, j)
      if (j < 0) return -1
      expect = 'colon'; continue
    }
    if (expect === 'colon') {
      if (ch !== 0x3a) return -1
      j++; expect = 'value'; continue
    }
    // sep: a comma, or the close of whatever is open
    if (ch === 0x2c) { j++; expect = top === '{' ? 'key' : 'value'; continue }
    if ((ch === 0x7d && top === '{') || (ch === 0x5d && top === '[')) {
      stack.pop(); j++
      if (!stack.length) return j
      continue
    }
    return -1
  }
}

/**
 * The top-level fields of a JSON object text, in order:
 * `{ fields: [{ key, keyStart, start, end }], close }`, where `start..end` is
 * the value's text and `close` the index of the final `}`. Null when the text
 * is not one well-formed JSON object.
 */
export function topFields(text) {
  const src = String(text)
  let i = skipWs(src, 0)
  if (src.charCodeAt(i) !== 0x7b) return null
  i = skipWs(src, i + 1)
  const fields = []
  if (src.charCodeAt(i) === 0x7d) return skipWs(src, i + 1) === src.length ? { fields, close: i } : null
  for (;;) {
    i = skipWs(src, i)
    if (src.charCodeAt(i) !== 0x22) return null
    const keyStart = i
    const keyEnd = skipString(src, i)
    if (keyEnd < 0) return null
    let key
    try { key = JSON.parse(src.slice(keyStart, keyEnd)) } catch { return null }
    i = skipWs(src, keyEnd)
    if (src.charCodeAt(i) !== 0x3a) return null
    const start = skipWs(src, i + 1)
    const end = skipValue(src, start)
    if (end < 0) return null
    fields.push({ key, keyStart, start, end })
    i = skipWs(src, end)
    const c = src.charCodeAt(i)
    if (c === 0x2c) { i++; continue }
    if (c !== 0x7d) return null
    return skipWs(src, i + 1) === src.length ? { fields, close: i } : null
  }
}

const lastField = (top, key) => { let hit; for (const f of top.fields) if (f.key === key) hit = f; return hit }

/** The parsed value of top-level `key` (the last one, as JSON.parse keeps), or undefined. */
export function fieldValue(text, top, key) {
  const hit = lastField(top, key)
  if (!hit) return undefined
  try { return JSON.parse(String(text).slice(hit.start, hit.end)) } catch { return undefined }
}

/** The raw JSON text of top-level `key` (the last one), or undefined. */
export function fieldText(text, top, key) {
  const hit = lastField(top, key)
  return hit ? String(text).slice(hit.start, hit.end) : undefined
}

/**
 * `text` with every top-level `key` removed and, when `valueText` is given,
 * one `"key":valueText` appended. Every copy goes, so a duplicate key cannot
 * carry a value past a strip.
 */
export function setField(text, top, key, valueText) {
  const src = String(text)
  const keep = top.fields.filter((f) => f.key !== key)
  let out = src.slice(0, top.fields.length ? top.fields[0].keyStart : top.close)
  keep.forEach((f, n) => { out += (n ? ',' : '') + src.slice(f.keyStart, f.end) })
  if (valueText !== undefined) out += (keep.length ? ',' : '') + JSON.stringify(key) + ':' + valueText
  return out + src.slice(top.close)
}
