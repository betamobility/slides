// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// topFields / fieldValue / setField (src/block.js) against JSON.parse.
//
//   node server/deck-store/test/block.test.mjs [deck.bento.html ...]
//
// The scanner replaces a whole-document parse on the worker's hot paths, so
// it must agree with JSON.parse on every text that does not hide a problem
// inside a string: same verdict (object or not), same top-level keys, same
// values. Real decks passed as arguments are checked too: stripping and
// restoring `collab` must give the document the old full rewrite gave.

import { readFileSync } from 'node:fs'
import { fieldText, fieldValue, rewriteBlock, setField, splitShell, topFields } from '../src/block.js'

let failed = 0
let passed = 0
const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.log('  FAIL ', msg) } }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const parsesAsObject = (t) => { try { const v = JSON.parse(t); return !!v && typeof v === 'object' && !Array.isArray(v) } catch { return false } }

// --- fixed cases ------------------------------------------------------------
const cases = [
  '{}', ' { } ', '{"a":1}', '{"a":-1.5e+3,"b":true,"c":null,"d":false}', '{"a":[]}', '{"a":{}}',
  '{"a":[1,[2,[3,{"b":[]}]]],"c":"x"}', '{"a":"q\\"uote","b":"back\\\\"}', '{"a":"\\\\\\""}',
  '{"a":[,]}', '{"a":[1,]}', '{"a":1,}', '{,}', '{"a"}', '{"a":}', '{"a":tru}', '{"a":01}', '{"a":1.}',
  '[1]', '"x"', '1', '{"a":1}x', '{"a":1}}', '{"a":[1}', '{"a":{"b":1]}', '{"a":"unterminated}',
  '{"a":{"b":}}', '{"a":{,}}', '{"a":[1 2]}', '{"a":{"b" 1}}', '{"a":1 "b":2}', '{"a":"x","a":"y"}',
  '\n{\n  "a" : [ 1 , 2 ] ,\n  "b" : { "c" : "d" }\n}\n',
]
for (const t of cases) {
  const top = topFields(t)
  ok(!!top === parsesAsObject(t), `verdict for ${JSON.stringify(t)}: scanner ${!!top}, JSON.parse ${parsesAsObject(t)}`)
  if (top) {
    const doc = JSON.parse(t)
    ok(same([...new Set(top.fields.map((f) => f.key))], Object.keys(doc)), `keys for ${JSON.stringify(t)}`)
    for (const k of Object.keys(doc)) ok(same(fieldValue(t, top, k), doc[k]), `value of ${k} in ${JSON.stringify(t)}`)
  }
}

// --- random documents, and random damage to them ----------------------------
let seed = 7
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const pick = (a) => a[Math.floor(rnd() * a.length)]
const word = () => pick(['a', 'b', 'collab', 'title', 'docId', 'x"y', 'back\\slash', 'æøå', '{', ']', ':', ','])
function value(depth) {
  const r = rnd()
  if (depth > 3 || r < 0.35) return pick([0, -2.5, 1e21, true, false, null, word(), '', 'a\\"b\\\\'])
  if (r < 0.65) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(depth + 1))
  const o = {}
  for (let n = Math.floor(rnd() * 4); n > 0; n--) o[word()] = value(depth + 1)
  return o
}
for (let n = 0; n < 3000; n++) {
  const doc = {}
  for (let k = Math.floor(rnd() * 6); k > 0; k--) doc[word()] = value(0)
  const pretty = rnd() < 0.5
  let t = pretty ? JSON.stringify(doc, null, rnd() < 0.5 ? 2 : '\t') : JSON.stringify(doc)
  if (rnd() < 0.4) {
    // damage it: drop, duplicate or swap one structural character
    const at = Math.floor(rnd() * t.length)
    const how = rnd()
    t = how < 0.33 ? t.slice(0, at) + t.slice(at + 1) : how < 0.66 ? t.slice(0, at) + t[at] + t.slice(at) : t.slice(0, at) + pick(['{', '}', '[', ']', ',', ':', '"', '1']) + t.slice(at + 1)
  }
  const top = topFields(t)
  const valid = parsesAsObject(t)
  // a damaged quote can move characters into or out of a string, where the
  // scanner deliberately does not look; those cases must still never be
  // accepted with keys JSON.parse would not see
  if (valid) {
    ok(!!top, `random valid text rejected: ${t.slice(0, 120)}`)
    if (top) {
      const d = JSON.parse(t)
      for (const k of Object.keys(d)) ok(same(fieldValue(t, top, k), d[k]), `random value ${k}`)
      // setField: remove, replace, add
      const removed = JSON.parse(setField(t, top, 'collab'))
      const want = { ...d }; delete want.collab
      ok(same(removed, want), `strip collab: ${t.slice(0, 80)}`)
      const put = JSON.parse(setField(t, top, 'collab', '{"room":"r1"}'))
      ok(same(put.collab, { room: 'r1' }) && same(Object.keys(put).filter((k) => k !== 'collab').sort(), Object.keys(want).sort()), `set collab: ${t.slice(0, 80)}`)
    }
  } else if (top) {
    ok(/"/.test(t), `invalid text accepted without a string involved: ${t.slice(0, 120)}`)
  }
}

// --- real decks: the new strip/restore against the old full rewrite --------
for (const file of process.argv.slice(2)) {
  const html = readFileSync(file, 'utf8')
  const parts = splitShell(html)
  ok(!!parts, `${file}: one block`)
  if (!parts) continue
  const t0 = performance.now()
  const top = topFields(parts.body)
  const scanMs = performance.now() - t0
  ok(!!top, `${file}: scanner reads the block`)
  if (!top) continue
  const doc = JSON.parse(parts.body)
  for (const k of ['format', 'title', 'docId', 'readonly', 'template']) ok(same(fieldValue(parts.body, top, k), doc[k]), `${file}: ${k}`)
  const oldStrip = JSON.parse(splitShell(rewriteBlock(html, (d) => { delete d.collab })).body)
  const newStrip = JSON.parse(setField(parts.body, top, 'collab'))
  ok(same(oldStrip, newStrip), `${file}: strip collab matches the full rewrite`)
  const collab = fieldText(parts.body, top, 'collab') ?? '{"room":"test"}'
  const stripped = setField(parts.body, top, 'collab')
  const back = JSON.parse(setField(stripped, topFields(stripped), 'collab', collab))
  ok(same(back.collab, JSON.parse(collab)), `${file}: restore puts collab back`)
  console.log(`  ${file.split('/').pop()}: ${(parts.body.length / 1e6).toFixed(1)} MB block scanned in ${scanMs.toFixed(1)} ms, ${top.fields.length} top-level fields`)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
