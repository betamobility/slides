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
//
// The regex is NOT global. The store's own `DOC_BLOCK` is `/gi` and is used
// with `matchAll`, which is safe; an `exec` against a global regex carries
// `lastIndex` between calls, and a rewriter called twice in one request would
// then miss the block the second time.
const BLOCK = /(<script\b[^>]*\bid=["']?bento-doc["']?[^>]*>)([\s\S]*?)(<\/script>)/i
const BLOCK_ALL = /<script\b[^>]*\bid=["']?bento-doc["']?[^>]*>[\s\S]*?<\/script>/gi

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
  if ((src.match(BLOCK_ALL) || []).length !== 1) return null
  const m = BLOCK.exec(src)
  if (!m) return null
  return {
    prefix: src.slice(0, m.index),
    open: m[1],
    body: m[2],
    close: m[3],
    suffix: src.slice(m.index + m[0].length),
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
