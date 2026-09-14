// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
//
// The #bento-doc block, read and written from Node with built-ins only.
//
// This file ships inside the beta-slides plugin (plan 2026-09-14-001, KTD11):
// the marketplace installs plugins/beta-slides/ and nothing else, so nothing
// here may import from outside that directory. scripts/build-beta-templates.mjs
// imports `spliceDoc` from here rather than keeping its own copy.
//
// Two writers, on purpose. `spliceDoc` is the templates builder's: it matches
// the exact opening tag the built shell carries and is kept byte-for-byte as
// it was, so the templates it produces do not move. `readBlock`/`writeBlock`
// are the splice tool's: a stored deck may have been written by any shell or
// harness, so they find the block by id (as the deck store's shape check does)
// and keep whatever opening tag it had.
//
// AGENTS.md hard rules 1 and 2: `<` is escaped as < inside the block so
// no literal `</script>` can end it, and the block keeps its id and stays
// plaintext.

export function spliceDoc(shellText, doc) {
  const blockRe = /<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/
  const json = JSON.stringify(doc).replace(/</g, '\\u003c')
  if (json.includes('</script')) throw new Error('a literal </script> survived escaping')
  const out = shellText.replace(blockRe, () => `<script type="application/bento+json" id="bento-doc">\n${json}\n</scr` + 'ipt>')
  if (!out.includes(json)) throw new Error('splice failed')
  return out
}

const blockRe = () => /(<script\b[^>]*\bid=["']?bento-doc["']?[^>]*>)([\s\S]*?)(<\/script>)/gi

/**
 * The document in `html`'s #bento-doc block. Throws unless there is exactly
 * one block and it parses to an object. JSON.parse decodes the < escapes
 * itself, so there is no unescape pass (one would corrupt a string holding a
 * literal backslash-u003c).
 */
export function readBlock(html) {
  const blocks = [...html.matchAll(blockRe())]
  if (blocks.length !== 1) throw new Error(blocks.length ? 'more than one #bento-doc block' : 'no #bento-doc block')
  const body = blocks[0][2]
  if (!body.trim()) throw new Error('the #bento-doc block is empty')
  const doc = JSON.parse(body)
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('the #bento-doc block is not a JSON object')
  return doc
}

/** A `bento/enc` envelope: the block holds ciphertext, not a document. */
export const isEncrypted = (doc) => !!doc && doc.format === 'bento/enc'

/** `html` with its one #bento-doc block replaced by `doc`, opening tag kept. */
export function writeBlock(html, doc) {
  readBlock(html) // exactly one block, or throw before building anything
  const json = JSON.stringify(doc).replace(/</g, '\\u003c')
  if (json.includes('</script')) throw new Error('a literal </script> survived escaping')
  const out = html.replace(blockRe(), (_m, open) => `${open}\n${json}\n</scr` + 'ipt>')
  if (!out.includes(json)) throw new Error('splice failed')
  return out
}
