#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The bento/slides JSON Schema: built from the gate's tables, published for
// agents, pinned to the runtime.
//
//   slides/node_modules/.bin/esbuild scripts/test-slides-schema.ts --bundle --platform=node --format=esm --outfile=/tmp/t.mjs && node /tmp/t.mjs
//
// WHAT THIS PROVES. (1) The checked-in schema/slides.json is byte-for-byte
// what slides/src/schema.ts builds, and window.bento.schema() is that same
// function — one source. (2) The schema's key set per element type equals the
// gate's key set: a field taught to the gate and not the schema, or the other
// way round, fails here. (3) The starter deck (and the gallery fixtures when
// present) validate against it with a small validator for exactly the subset
// of JSON Schema the generator emits; a deck with an unknown key does not.
// (4) `$schema` at the top of a deck is stripped on load, and BOTH the 1.1.0
// release's parseDoc and main's accept a deck carrying it (frozen copies of
// their one condition line, sha-noted) — ignored, never rejected — which is
// what lets save.ts write it. (5) The URL is a pointer, not a beacon: nothing
// in the runtime fetches, imports or links it.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildSchema, SCHEMA_URL, stampSchema } from '../slides/src/schema.ts'
import { starterDoc } from '../slides/src/starterdeck.ts'
import { parseDoc, FORMAT } from '../slides/src/model.ts'
import { MODEL_KEYS } from '../slides/src/modelkeys.generated.ts'
import { CHECKED_KEYS } from '../slides/src/untrusted.ts'
import { checkRuntime } from '../slides/src/runtime.ts' // BETA FORK

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
// bundled into a temp file in CI, so the repo root is the cwd, as the other bundled rigs do
const root = process.cwd()
const read = (f: string) => readFileSync(join(root, f), 'utf8')
type J = Record<string, unknown>
const version = JSON.parse(read('slides/package.json')).version as string

// --- a validator for the subset the generator emits ------------------------
function validate(schema: J, value: unknown, root: J, path = '$'): string[] {
  const errs: string[] = []
  const e = (m: string) => errs.push(`${path}: ${m}`)
  if (typeof schema.$ref === 'string') {
    const target = (schema.$ref as string).replace('#/', '').split('/').reduce<unknown>((o, k) => (o as J)?.[k], root) as J
    if (!target) return [`${path}: dangling $ref ${schema.$ref}`]
    return validate(target, value, root, path)
  }
  if (Array.isArray(schema.anyOf)) {
    if (!(schema.anyOf as J[]).some((s) => validate(s, value, root, path).length === 0)) e('matches no anyOf branch')
    return errs
  }
  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf as J[]
    const n = branches.filter((s) => validate(s, value, root, path).length === 0).length
    if (n === 1) return errs
    // the element union is discriminated by `type`: report THAT branch's
    // errors, so a typo'd key is named rather than "no branch matched"
    const resolve = (s: J): J => (typeof s.$ref === 'string' ? (s.$ref as string).replace('#/', '').split('/').reduce<unknown>((o, k) => (o as J)?.[k], root) as J : s)
    const disc = value && typeof value === 'object' ? (value as J).type : undefined
    const mine = branches.map(resolve).find((s) => ((s.properties as J)?.type as J)?.const === disc)
    if (mine) errs.push(...validate(mine, value, root, path))
    else e(`matches ${n} oneOf branches`)
    return errs
  }
  if ('const' in schema && value !== schema.const) e(`expected const ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) e(`not one of ${JSON.stringify(schema.enum)}`)
  const t = schema.type
  if (t === 'number' || t === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) e('not a number')
    else {
      if (t === 'integer' && !Number.isInteger(value)) e('not an integer')
      if (typeof schema.minimum === 'number' && value < schema.minimum) e(`< ${schema.minimum}`)
      if (typeof schema.maximum === 'number' && value > schema.maximum) e(`> ${schema.maximum}`)
    }
  } else if (t === 'string') {
    if (typeof value !== 'string') e('not a string')
    else {
      // BETA FORK (U9 break round 1): JSON Schema counts characters (code points), not UTF-16 units
      if (typeof schema.maxLength === 'number' && [...value].length > schema.maxLength) e('too long')
      if (typeof schema.minLength === 'number' && [...value].length < schema.minLength) e('too short') // BETA FORK
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) e(`fails /${schema.pattern}/`)
    }
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') e('not a boolean')
  } else if (t === 'array') {
    if (!Array.isArray(value)) e('not an array')
    else {
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) e('too few items')
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) e('too many items')
      if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items as J, v, root, `${path}[${i}]`)))
    }
  } else if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) e('not an object')
    else {
      const props = (schema.properties ?? {}) as Record<string, J>
      for (const k of (schema.required as string[] | undefined) ?? []) if (!(k in (value as J))) e(`missing ${k}`)
      for (const [k, v] of Object.entries(value as J)) {
        if (Object.prototype.hasOwnProperty.call(props, k)) errs.push(...validate(props[k], v, root, `${path}.${k}`)) // BETA FORK: own keys only, or `constructor` reads as declared
        else if (schema.additionalProperties === false) e(`unknown key ${k}`)
        else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errs.push(...validate(schema.additionalProperties as J, v, root, `${path}.${k}`))
      }
      if (typeof schema.maxProperties === 'number' && Object.keys(value as J).length > schema.maxProperties) e('too many properties')
    }
  }
  return errs
}
const check = (doc: unknown, schema: J) => validate(schema, doc, schema)

console.log('one source\n')
const built = buildSchema(version)
const file = JSON.parse(read('schema/slides.json')) as J
ok(JSON.stringify(built) === JSON.stringify(file), 'schema/slides.json is byte-for-byte what buildSchema(version) returns (build-schema.mjs --check pins it in CI too)')
// BETA FORK: Beta's shell stamps Beta's copy of the schema (it describes slide.runtime).
const BETA_SCHEMA_URL = 'https://slides.betamobility.ai/schema/slides.json'
ok(file.$id === SCHEMA_URL && file.$id === BETA_SCHEMA_URL, `$id is the published URL (${file.$id})`)
ok(file['x-bento-version'] === version, `stamped with the shell version ${version}`)
ok(existsSync(join(root, `schema/slides-${version}.json`)), 'a version-pinned twin exists')
const mainSrc = read('slides/src/main.ts')
ok(/schema\(\)\s*\{\s*return buildSchema\(APP_VERSION\)/.test(mainSrc), 'window.bento.schema() is the same function, stamped with the running version')

console.log('\nthe gate and the schema agree\n')
const defs = file.$defs as Record<string, J>
for (const type of Object.keys(MODEL_KEYS.element)) {
  const keys = (MODEL_KEYS.element as Record<string, readonly string[]>)[type]
  const schemaKeys = Object.keys((defs[type].properties as J)).sort()
  const gateKeys = keys.filter((k) => CHECKED_KEYS.element.includes(k)).sort()
  ok(schemaKeys.join() === gateKeys.join(), `${type}: schema keys == gate keys (${schemaKeys.length})`)
  ok((defs[type].required as string[]).includes('type') && (defs[type].required as string[]).includes('id'), `${type}: type and id required`)
}
ok(Object.keys(defs.slide.properties as J).sort().join() === [...MODEL_KEYS.slide].filter((k) => CHECKED_KEYS.slide.includes(k)).sort().join(), 'slide: schema keys == gate keys')
ok(Object.keys(defs.doc.properties as J).sort().join() === [...MODEL_KEYS.doc, '$schema', 'compact'].sort().join(), 'doc: every model key plus $schema and the compact flag')
ok(Object.keys(defs.theme.properties as J).sort().join() === [...MODEL_KEYS.theme].sort().join(), 'theme: keys from model.ts (via modelkeys.generated.ts)')

console.log('\nreal decks validate; a typo does not\n')
const starter = JSON.parse(JSON.stringify(starterDoc()))
const starterErrs = check(starter, file)
ok(starterErrs.length === 0, `the starter deck validates (${starterErrs.length} errors${starterErrs.length ? ': ' + starterErrs.slice(0, 3).join('; ') : ''})`)
const fixtures = join(root, 'scripts/fixtures/compact-decks')
if (existsSync(fixtures)) {
  for (const f of readdirSync(fixtures).filter((f) => f.endsWith('.json'))) {
    const errs = check(JSON.parse(readFileSync(join(fixtures, f), 'utf8')), file)
    ok(errs.length === 0, `${f} validates (${errs.length}${errs.length ? ': ' + errs.slice(0, 3).join('; ') : ''})`)
  }
}
const typo = JSON.parse(JSON.stringify(starter))
typo.slides[0].elements[0].fontsize = 12
ok(check(typo, file).some((m) => /unknown key fontsize/.test(m)), 'an element with `fontsize` (typo) fails with the key named')
const badEnum = JSON.parse(JSON.stringify(starter))
badEnum.slides[0].transition = 'wipe'
ok(check(badEnum, file).some((m) => /transition/.test(m)), 'an unknown transition fails')
const noFormat = { slides: [] }
ok(check(noFormat, file).length > 0, 'no format / no slides fails')
const withSchema = { ...JSON.parse(JSON.stringify(starter)), $schema: SCHEMA_URL }
ok(check(withSchema, file).length === 0, 'a deck carrying $schema validates')

console.log('\n$schema is a pointer for readers, never document data\n')
const loaded = parseDoc(JSON.stringify(withSchema))
ok(!!loaded && !('$schema' in loaded), 'parseDoc strips $schema on load')
// Frozen from the 1.1.0 release (03280f5) and origin/main (131015e): the one
// condition parseDoc applies. Neither looks at unknown top-level keys, so a
// deck carrying $schema is accepted and the key rides along untouched — an
// old shell keeps it and writes it back; its validate() lists it as unknown.
const frozenCondition = (doc: J) => !!(doc && doc.format === FORMAT && Array.isArray(doc.slides) && (doc.slides as unknown[]).length > 0)
const releaseSrc = 'if (doc && doc.format === FORMAT && Array.isArray(doc.slides) && doc.slides.length > 0) {'
ok(frozenCondition(withSchema), '1.1.0 (03280f5) parseDoc accepts a deck carrying $schema (frozen condition)')
ok(read('slides/src/model.ts').includes(releaseSrc), "main's parseDoc still applies exactly that condition (source check)")

console.log('\nthe saved JSON opens with its pointer\n')
{
  const live = JSON.parse(JSON.stringify(starter))
  const stamped = stampSchema(live)
  ok(Object.keys(stamped)[0] === '$schema' && stamped.$schema === SCHEMA_URL, 'stampSchema puts $schema FIRST, with the published URL')
  ok(!('$schema' in live), 'the input object is untouched (a new object, not a mutation)')
  ok(JSON.stringify(stamped).startsWith(`{"$schema":"${BETA_SCHEMA_URL}",`), 'serialized, the file starts with the pointer (about 60 B)') // BETA FORK
  const again = parseDoc(JSON.stringify(stamped))
  ok(!!again && !('$schema' in again), 'load → save → load: the live document never carries it')
  const facade = read('slides/src/save.ts')
  ok(/function prepareForSave[\s\S]*stampSchema\(pruneUnusedAssets\(adoptBuiltinFonts\(doc\)\)\)/.test(facade), 'prepareForSave stamps the pointer on every write path (⌘S, autosave, exports, serialize())')
}

console.log('\nno beacon\n')
const carriers: string[] = []
for (const dir of ['slides/src', 'kernel/src']) {
  const walk = (d: string) => {
    for (const f of readdirSync(join(root, d), { withFileTypes: true })) {
      const p = `${d}/${f.name}`
      if (f.isDirectory()) walk(p)
      else if (/\.(ts|css|html)$/.test(f.name) && !/\.generated\./.test(f.name)) {
        const src = readFileSync(join(root, p), 'utf8')
        if (!src.includes('/schema/slides.json')) continue // BETA FORK: either host's schema URL
        carriers.push(p)
        const lines = src.split('\n').filter((l) => l.includes('/schema/slides.json'))
        ok(!lines.some((l) => /fetch\(|import\(|href=|src=|new URL\(/.test(l)), `${p}: the URL is text only (${lines.length} line${lines.length === 1 ? '' : 's'})`)
      }
    }
  }
  walk(dir)
}
ok(carriers.length > 0 && carriers.includes('slides/src/schema.ts'), `the URL appears as text in: ${carriers.join(', ')}`)
const tooling = read('scripts/postbuild-compress.mjs')
ok(tooling.includes('https://bento.page/schema/slides.json') && tooling.includes('https://bento.page/llms.txt') && tooling.includes('window.bento.schema()'), 'the Tooling comment names the URL, schema() and llms.txt')
const llms = read('site-src/llms.txt')
ok(/^# /.test(llms) && llms.includes('https://bento.page/schema/slides.json') && llms.includes('agents.md'), 'llms.txt exists with the schema and the agent guide')
// BETA FORK: Beta's site publishes the schema and no llms.txt (scripts/test-beta-schema.ts covers the Beta build's own tooling comment).
ok(read('scripts/release.mjs').includes("'schema'"), 'release.mjs stages schema/ into the site')

// BETA FORK: the runtime slide in the published schema (upstream-merge plan U3, R4, AE11).
console.log('\na runtime slide validates; a broken one does not\n')
{
  const rt = (defs.slide.properties as Record<string, J>).runtime
  // BETA FORK, from the independent break round: what the gate hands back validates.
  const savedCases: Array<[string, J, boolean]> = [
    ['an uppercase HTTPS url', { url: 'HTTPS://example.com/scene', steps: 0, props: [] }, true],
    // the gate trims a colour, so the padded input is repaired, not kept
    ['a colour default padded with spaces', { steps: 0, props: [{ key: 'tint', label: 'Tint', kind: 'color', default: ' '.repeat(4001) + '#fff' }] }, false],
  ]
  for (const [name, record, unchanged] of savedCases) {
    const saved = checkRuntime(record) as unknown as J
    const d = JSON.parse(JSON.stringify(starter)); d.slides[0].runtime = saved
    const errors = check(stampSchema(d), file)
    ok((JSON.stringify(saved) === JSON.stringify(record)) === unchanged && errors.length === 0, `${name}: what the gate keeps validates${unchanged ? ', unchanged' : ', repaired'} (${errors.join('; ')})`)
  }
  // BETA FORK, break round 2: a reserved key is expressible in schema, unlike values/props joins.
  const reserved = { steps: 0, props: [{ key: '__proto__', label: 'Reserved', kind: 'text', default: 'hello' }] }
  ok(validate(rt, reserved, file).length > 0 && checkRuntime(reserved)!.props.length === 0,
    'the schema rejects the reserved __proto__ prop that the gate drops')
  const matrix: J[] = []
  for (const steps of [-1, 0, 10000, 10001, '3', null]) {
    for (const kind of ['text', 'number', 'color', 'unknown']) {
      for (const value of ['', 'hello', '#fff', 'url(x)', 12, null]) {
        matrix.push({ steps, props: [{ key: 'setting', label: 'Setting', kind, default: value }], values: { setting: value } })
      }
    }
  }
  const invalidOutputs = matrix.filter((record) => validate(rt, checkRuntime(record), file).length)
  ok(invalidOutputs.length === 0, `all ${matrix.length} generated repaired runtime records validate (${invalidOutputs.length} failures)`)
  // BETA FORK, break round 3: independently vary fields that the gate drops.
  {
    const cases: Array<[string, unknown]> = [
      ['src', 'asset:'], ['src', 'asset:bad;key'], ['src', 'asset:' + 'x'.repeat(201)],
      ['still', 'https://example.com/still.png'], ['url', 'http://example.com/scene'],
      ['assets', ['../private.json']], ['assets', ['scene/secret.json']],
      ['props', [{ key: 'bad key', label: 'Bad', kind: 'text', default: '' }]],
    ]
    const failures = cases.filter(([key, value]) => {
      const record = { steps: 0, props: [], [key]: value }
      const saved = checkRuntime(record)
      return validate(rt, record, file).length === 0 || validate(rt, saved, file).length !== 0
    })
    ok(failures.length === 0, `round 3: invalid runtime field matrix rejects inputs and accepts gate outputs (${JSON.stringify(failures)})`)
  }
  {
    const d = JSON.parse(JSON.stringify(starter))
    d.slides[0].runtime = { steps: 0, props: [], constructor: { unexpected: true } }
    ok(check(d, file).some((m) => /unknown key constructor/.test(m)),
      'round 3: inherited Object keys cannot bypass runtime additionalProperties false in the validator')
  }
  // BETA FORK (U9): the library marker and a setting's format hint
  {
    const prop = { key: 'mode', label: 'Mode', kind: 'text', default: 'a' }
    const valid: J[] = [
      { steps: 0, props: [{ ...prop, format: 'select:a|b|c' }], library: { id: 'map', version: 1 } },
      { steps: 2, props: [{ key: 'on', label: 'On', kind: 'number', default: 1, format: 'bool' }, { key: 'p', label: 'P', kind: 'text', default: '59.9, 10.7', format: 'latlon' }], library: { id: 'a-b-' + 'c'.repeat(36), version: 1000000 } },
      { steps: 0, props: [{ ...prop, format: 'x'.repeat(200) }] },
    ]
    const invalid: J[] = [
      { steps: 0, props: [{ ...prop, format: '' }] }, { steps: 0, props: [{ ...prop, format: 'x'.repeat(201) }] },
      { steps: 0, props: [{ ...prop, format: 'a\nb' }] }, { steps: 0, props: [{ ...prop, format: 7 }] },
      { steps: 0, props: [], library: { id: 'Map', version: 1 } }, { steps: 0, props: [], library: { id: 'map', version: 0 } },
      { steps: 0, props: [], library: { id: 'map', version: 1.5 } }, { steps: 0, props: [], library: { id: 'map' } },
      { steps: 0, props: [], library: { id: 'map', version: 1, extra: true } }, { steps: 0, props: [], library: 'map' },
      { steps: 0, props: [], library: { id: 'x'.repeat(41), version: 1 } }, { steps: 0, props: [], library: { id: 'map', version: 1000001 } },
    ]
    const badValid = valid.filter((r) => validate(rt, r, file).length || JSON.stringify(checkRuntime(r)) !== JSON.stringify(r))
    const missed = invalid.filter((r) => validate(rt, r, file).length === 0)
    const badSaved = [...valid, ...invalid].filter((r) => validate(rt, checkRuntime(r), file).length)
    ok(!badValid.length && !missed.length && !badSaved.length,
      `U9 library and format: ${valid.length} kept unchanged, ${invalid.length} refused by the schema, every gate output valid; mismatches=${JSON.stringify({ badValid, missed, badSaved })}`)
  }
  // BETA FORK: independent U9 schema/gate differential. JSON Schema counts
  // Unicode code points, not UTF-16 code units. Keep this oracle separate
  // from validate(), whose string length implementation is also under test.
  {
    const propsSchema = (rt.properties as J).props as J
    const branch = ((propsSchema.items as J).anyOf as J[])[0]
    const hintSchema = (branch.properties as J).format as J
    const acceptsHint = (s: string) => [...s].length >= Number(hintSchema.minLength) &&
      [...s].length <= Number(hintSchema.maxLength) && new RegExp(String(hintSchema.pattern), 'u').test(s)
    ok(!acceptsHint('x'.repeat(201)) && !acceptsHint(''),
      'U9 independent schema: negative controls reject empty and 201-character hints')
    const hints = [100, 101, 193].map(n => 'select:' + '🚲'.repeat(n))
    const records = hints.map(format => ({ steps: 0, props: [
      { key: 'mode', label: 'Mode', kind: 'text', default: 'a', format },
    ], library: { id: 'map', version: 1 } }))
    const lost = records.filter(r => acceptsHint(r.props[0].format) &&
      checkRuntime(r)?.props[0].format !== r.props[0].format)
    ok(!lost.length,
      `U9 independent schema: schema-valid astral hints survive gate; lost code-point lengths=${lost.map(r => [...r.props[0].format].length)}`)
    const falseRejections = records.filter(r => acceptsHint(r.props[0].format) && validate(rt, r, file).length)
    ok(!falseRejections.length,
      `U9 independent schema: rig validator agrees with code-point maxLength; falsely rejected=${falseRejections.map(r => [...r.props[0].format].length)}`)
    const finalTerminators = ['\n', '\r', '\r\n'].filter(suffix => {
      const record = { steps: 0, props: [{ key: 'mode', label: 'Mode', kind: 'text', default: 'a', format: 'select:a|b' + suffix }] }
      return validate(rt, record, file).length === 0 && checkRuntime(record)?.props[0].format === undefined
    })
    ok(!finalTerminators.length,
      `U9 independent schema: schema rejects trailing ASCII newlines that the gate drops; incorrectly accepted=${JSON.stringify(finalTerminators)}`)
    const multiline = ['\u0085', '\u2028', '\u2029'].filter(c => acceptsHint(`select:a${c}|b`))
    ok(!multiline.length,
      `U9 independent schema: published single-line pattern refuses Unicode line separators; accepted=${JSON.stringify(multiline)}`)
  }
  // BETA FORK (U9 independent round 2): derive malformed markers from the
  // published closed schema, then require the gate's promised atomic drop.
  {
    const malformed = ['extra', '__proto__', 'constructor'].map(key =>
      JSON.parse(`{"steps":0,"props":[],"library":{"id":"map","version":1,"${key}":true}}`))
    const rejected = malformed.every(r => validate(rt, r, file).some(e => e.includes('unknown key')))
    const repaired = malformed.filter(r => checkRuntime(r)?.library !== undefined)
    ok(rejected && repaired.length === 0,
      `U9 R2 schema-malformed library is dropped, never repaired; schema rejected all=${rejected}, gate retained=${repaired.length}`)
  }
  // BETA FORK (U9 independent round 2): generated boundary cross-product,
  // with independent expectations and bad inputs to prove rejection works.
  {
    const mismatches: string[] = []
    for (const id of ['a', 'a' + '-'.repeat(39), 'A', 'a'.repeat(41)]) {
      for (const version of [1, 1000000, 0, 1.5, 1000001]) {
        for (const format of ['bool', '🚲'.repeat(200), '', '🚲'.repeat(201), 'bool\u0085']) {
          const record = { steps: 0, props: [{ key: 'mode', label: 'Mode', kind: 'text', default: 'a', format }], library: { id, version } }
          const validLibrary = (id === 'a' || id === 'a' + '-'.repeat(39)) && (version === 1 || version === 1000000)
          const validHint = format === 'bool' || format === '🚲'.repeat(200)
          const gated = checkRuntime(record)!
          if ((validate(rt, record, file).length === 0) !== (validLibrary && validHint) ||
              (gated.library !== undefined) !== validLibrary || (gated.props[0].format !== undefined) !== validHint ||
              validate(rt, gated, file).length !== 0)
            mismatches.push(`${id}/${version}/${[...format].length}`)
        }
      }
    }
    ok(!mismatches.length, `U9 R2 generated schema boundaries: 100 records agree in both directions; mismatches=${mismatches.join(',')}`)
  }
  // BETA FORK (U9 independent round 3): generate controls at every position
  // and all supported kinds. Oracle uses numeric code points, not the gate's
  // regex or the published schema. Test-only mutation proves false acceptance
  // is detected even when the gate still strips the bad hint.
  {
    const failures: string[] = []
    const schema = structuredClone(rt)
    if (process.env.U9_R3_MUTANT === 'schema') {
      const branches = ((((schema.properties as J).props as J).items as J).anyOf as J[])
      for (const branch of branches) delete ((branch.properties as J).format as J).pattern
    }
    const chars = [...Array.from({ length: 161 }, (_, n) => n), 0x2028, 0x2029, 0x1f6b2]
    for (const kind of ['text', 'number', 'color']) for (const cp of chars) for (const position of [0, 1, 2]) {
      const pieces = ['a', 'b']; pieces.splice(position, 0, String.fromCodePoint(cp))
      const format = pieces.join('')
      const printable = cp >= 32 && !(cp >= 127 && cp <= 159) && cp !== 0x2028 && cp !== 0x2029
      const prop = { key: 'mode', label: 'Mode', kind, default: kind === 'number' ? 1 : kind === 'color' ? '#123456' : 'a', format }
      const record = { steps: 0, props: [prop], library: { version: 1, id: 'map' } }
      const gated = checkRuntime(record)!
      if ((validate(schema, record, file).length === 0) !== printable ||
          (gated.props[0].format === format) !== printable || gated.props.length !== 1 ||
          gated.props[0].default !== prop.default || gated.library?.id !== 'map' ||
          validate(schema, gated, file).length !== 0) failures.push(`${kind}/U+${cp.toString(16)}/${position}`)
    }
    ok(!failures.length, `U9 R3 schema differential: 1476 generated hint/kind/position records; mismatches=${failures.slice(0, 12).join(',')}`)
  }
  // BETA FORK (U9 independent round 4): typed JSON boundaries beyond the
  // earlier integer/range matrix; hints remain opaque even when their grammar
  // is unknown. The expectation table is independent of both regex sources.
  {
    const markers: Array<[unknown, boolean]> = [
      [{ id: 'a0-9', version: 1e6 }, true], [{ id: 'a', version: 1.0000000000000002 }, false],
      [{ id: 'a', version: true }, false], [{ id: 'a', version: null }, false],
      [{ id: 'a', version: [] }, false], [{ id: 'a', version: {} }, false],
      [{ id: 'a', version: -0 }, false], [{ id: 'a', version: Number.MAX_SAFE_INTEGER }, false],
      [{ id: ['a'], version: 1 }, false], [{ id: null, version: 1 }, false],
      [{ id: 'a\n', version: 1 }, false], [{ id: 'a\u2028', version: 1 }, false],
      [{ id: 'a/b', version: 1 }, false], [{ id: 'a', version: 1, toString: null }, false],
      [[], false], [null, false],
    ]
    const hints: Array<[unknown, boolean]> = [
      ['range:not-yet-parsed', true], ['select:', true], [' ', true],
      ['future: $& \\u003c </script> "quoted" | 🚲', true],
      [true, false], [null, false], [[], false], [{ toString: 'bool' }, false],
    ]
    const schema = structuredClone(rt)
    if (process.env.U9_R4_MUTANT === 'schema') {
      const lib = ((schema.properties as J).library as J).properties as J
      ;(lib.version as J).type = 'number'
    }
    const errors: string[] = []
    for (const [i, [library, goodMarker]] of markers.entries()) for (const [j, [format, goodHint]] of hints.entries()) {
      const input = JSON.parse(JSON.stringify({ steps: 0, props: [
        { key: 'mode', label: 'Mode', kind: 'text', default: 'a', format },
      ], values: { mode: 'b' }, library }))
      const out = checkRuntime(input)!
      if ((validate(schema, input, file).length === 0) !== (goodMarker && goodHint) ||
        (out.library !== undefined) !== goodMarker || (out.props[0].format !== undefined) !== goodHint ||
        (goodHint && out.props[0].format !== format) || out.props[0].default !== 'a' || out.values?.mode !== 'b' ||
        validate(schema, out, file).length !== 0) errors.push(`${i}/${j}`)
    }
    ok(!errors.length, `U9 R4 schema typed boundaries: 128 records reject coercions and preserve opaque hints; mismatches=${errors}`)
  }
  // BETA FORK, break round 4: independently cross limits and object shapes.
  // Refusal is checked on INPUT; every repair/drop must still produce a
  // schema-valid saved record. Kind/value joins remain the documented gap.
  {
    const prop = { key: 'caption', label: 'Caption', kind: 'text', default: '' }
    const valid: J[] = [
      { src: 'asset:' + 'x'.repeat(200), steps: 10000, props: [] },
      { url: 'https://' + 'x'.repeat(3992), steps: 0, props: [] },
      { steps: 0, props: [{ ...prop, label: 'x'.repeat(200), default: 'x'.repeat(4000) }] },
      { steps: 0, props: Array.from({ length: 64 }, (_, i) => ({ ...prop, key: `p${i}` })) },
      { steps: 0, props: [], assets: Array.from({ length: 64 }, (_, i) => `a${i}.json`) },
    ]
    const invalid: J[] = [
      { src: 'asset:' + 'x'.repeat(201), props: [] },
      { url: 'https://' + 'x'.repeat(3993), props: [] },
      { props: [{ ...prop, label: 'x'.repeat(201) }] },
      { props: [{ ...prop, default: 'x'.repeat(4001) }] },
      { props: Array.from({ length: 65 }, (_, i) => ({ ...prop, key: `p${i}` })) },
      { assets: Array.from({ length: 65 }, (_, i) => `a${i}.json`) },
      { assets: ['x'.repeat(81)] }, { props: null }, { values: [] },
      { steps: 0.5 }, { props: [{ ...prop, extra: true }] },
      JSON.parse('{"steps":0,"props":[],"__proto__":{"injected":true}}'),
    ]
    const badValid = valid.filter((r) => validate(rt, r, file).length || JSON.stringify(checkRuntime(r)) !== JSON.stringify(r))
    const missed = invalid.filter((r) => validate(rt, r, file).length === 0)
    const badSaved = [...valid, ...invalid].filter((r) => validate(rt, checkRuntime(r), file).length)
    ok(!badValid.length && !missed.length && !badSaved.length,
      `round 4 runtime limit matrix: ${valid.length} exact boundaries and ${invalid.length} refused inputs; mismatches=${JSON.stringify({ badValid, missed, badSaved })}`)
  }
  const repairedDefault = { steps: 0, props: [{ key: 'zoom', label: 'Zoom', kind: 'number', default: 'banana' }] }
  ok(validate(rt, repairedDefault, file).length > 0 && ((checkRuntime(repairedDefault) as unknown as J).props as J[])[0].default === 0, 'a number prop with a text default: the schema refuses what the gate would repair to 0')
  ok(validate(rt, { steps: 0, props: [{ key: 'tint', label: 'Tint', kind: 'color', default: 'url(x)' }] }, file).length > 0, 'a colour default that smuggles url() is refused, as the gate refuses it')
  ok(validate(rt, { steps: 0, props: [{ key: 'tint', label: 'Tint', kind: 'color', default: 'rgb(10, 20, 30)' }] }, file).length === 0, 'an ordinary colour default validates')

  ok(!!rt && rt.type === 'object' && rt.additionalProperties === false, 'slide.runtime is described, and closed to unknown keys')
  ok(Object.keys(rt.properties as J).sort().join() === 'assets,library,props,src,steps,still,url,values', `with the keys the gate accepts (library since U9) (${Object.keys(rt.properties as J).sort().join()})`)
  const deck = JSON.parse(JSON.stringify(starter))
  deck.assets = { ...(deck.assets ?? {}), 'scene-src': 'data:text/html;base64,PHA+aGk8L3A+', 'scene-still': 'data:image/svg+xml;base64,PHN2Zy8+' }
  deck.slides.push({
    id: 'live', notes: '',
    elements: [{ id: 'still', type: 'image', x: 0, y: 0, w: 1280, h: 720, rotation: 0, opacity: 1, src: 'asset:scene-still' }],
    runtime: { src: 'asset:scene-src', still: 'asset:scene-still', steps: 3, props: [{ key: 'zoom', label: 'Zoom', kind: 'number', default: 11 }, { key: 'tint', label: 'Tint', kind: 'color', default: '#1b1b1b' }], values: { zoom: 12 }, assets: ['points.json'] },
  })
  const errs = check(deck, file)
  ok(errs.length === 0, `a deck with a runtime slide validates (${errs.length}${errs.length ? ': ' + errs.slice(0, 3).join('; ') : ''})`)
  // and what validates loads with nothing dropped: the gate keeps the record whole
  const kept = parseDoc(JSON.stringify(stampSchema(deck)))?.slides.find((s) => s.id === 'live') as unknown as J
  ok(JSON.stringify((kept?.runtime as J)) === JSON.stringify(deck.slides.at(-1).runtime), 'and the gate keeps that record byte for byte')
  ok(check({ ...deck, slides: [{ ...deck.slides.at(-1), runtime: { steps: 0, props: [] } }] }, file).length === 0, 'a placeholder record (no scene yet) validates')
  const bad = (mutate: (r: J) => void) => { const d = JSON.parse(JSON.stringify(deck)); mutate(d.slides.at(-1).runtime); return check(d, file) }
  ok(bad((r) => { (r.props as J[])[0].kind = 'select' }).some((m) => /props\[0\]/.test(m)), 'a prop of an unknown kind fails, naming the prop')
  ok(bad((r) => { r.sandbox = 'allow-same-origin' }).some((m) => /unknown key sandbox/.test(m)), 'a key the record does not have (a sandbox, say) fails with the key named')
  ok(bad((r) => { r.url = 'http://example.com/' }).some((m) => /url/.test(m)), 'a url that is not https fails')
  ok(bad((r) => { r.src = 'data:text/html,<p>x</p>' }).some((m) => /src/.test(m)), 'a src that is not an asset ref fails')
  ok(bad((r) => { r.steps = -1 }).some((m) => /steps/.test(m)), 'a negative step count fails')
  const typoSlide = JSON.parse(JSON.stringify(deck)); typoSlide.slides.at(-1).runtim = {}
  ok(check(typoSlide, file).some((m) => /unknown key runtim/.test(m)), 'a slide with an unknown key fails with the key named')
  ok(check(7 as unknown, rt).length > 0, 'runtime: 7 is refused by the schema, as the gate drops it')
}


// BETA FORK, from break round 5: real save output, not a hand-built fixture.
{
  const { serializeFile, capturePristine, embeddedDocBlock } = await import('../slides/src/save.ts')
  const { sanitizeDoc, guardOpenedDoc } = await import('../slides/src/restoregate.ts')
  const { betaStarterDoc } = await import('../slides/src/betastarter.ts')
  class SchemaShell {
    block = { textContent: '' }
    title = { textContent: '' }
    cloneNode() { return new SchemaShell() }
    querySelectorAll(s: string) { return s === 'script' ? [this.block] : [] }
    getElementById(id: string) { return id === 'bento-doc' ? this.block : null }
    querySelector(s: string) { return s === 'title' ? this.title : null }
    get documentElement() { return { outerHTML: `<html><head><title>${this.title.textContent}</title></head><body><script id="bento-doc">${this.block.textContent}</script></body></html>` } }
  }
  const { configureApp } = await import('../kernel/src/app.ts')
  configureApp({ appId: 'beta-slides', appName: 'beta/slides', manifestUrl: 'https://invalid.example/manifest' })
  const priorDocument = globalThis.document
  ;(globalThis as any).document = new SchemaShell()
  capturePristine()
  const inputs: Array<[string, any]> = [['starterDoc', starterDoc()], ['betaStarterDoc', betaStarterDoc()]]
  for (const name of readdirSync(join(root, 'beta/templates')).filter(n => n.endsWith('.bento.html'))) {
    inputs.push([name, parseDoc(embeddedDocBlock(read(`beta/templates/${name}`))!)])
  }
  const runtime = starterDoc()
  runtime.slides[0].runtime = { steps: 2, props: [{ key: 'caption', label: 'Caption', kind: 'text', default: 'Oslo' }], values: { caption: 'Bergen' } }
  inputs.push(['runtime deck', runtime])
  for (const [name, input] of inputs) {
    guardOpenedDoc(input) // main.ts's actual file-open guard precedes saving
    const saved = JSON.parse(embeddedDocBlock(serializeFile(input))!)
    const errs = check(saved, file)
    const parsed = parseDoc(JSON.stringify(saved))!
    const gated = sanitizeDoc(parsed as unknown as J)
    ok(saved.$schema === file.$id && errs.length === 0 && !!gated && gated.dropped.length === 0,
      `saved ${name}: advertised schema accepts actual save output and reload drops nothing; errors=${JSON.stringify(errs.slice(0, 8))}; dropped=${JSON.stringify(gated?.dropped.slice(0, 8))}`)
    // Failing-first control: changing a slide key must make these exact saved bytes fail.
    saved.slides[0].runtim = {}
    ok(check(saved, file).some(e => e.includes('unknown key runtim')),
      `saved ${name}: unknown slide key fails with its name`)
  }
  ;(globalThis as any).document = priorDocument
}

// BETA FORK: tests exercise the plugin writers, not copied output shapes.
{
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  // Keep this import external to the bundle: the CLI guard belongs to splice.mjs.
  const { pathToFileURL } = await import('node:url')
  const { create, derive, readProject } = await import(pathToFileURL(join(root, 'plugins/beta-slides/scripts/splice.mjs')).href)
  const { readBlock } = await import(pathToFileURL(join(root, 'plugins/beta-slides/scripts/lib/bento-doc.mjs')).href)
  const fixture = mkdtempSync(join(tmpdir(), 'beta-schema-round6-'))
  const priorFetch = globalThis.fetch
  try {
    const sceneDir = join(fixture, 'scenes/live-scene')
    mkdirSync(sceneDir, { recursive: true })
    writeFileSync(join(fixture, 'deck.json'), JSON.stringify({ title: 'Schema splice probe', slides: [] }))
    writeFileSync(join(sceneDir, 'index.html'), '<main>Scene</main>')
    writeFileSync(join(sceneDir, 'still.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"></svg>')
    writeFileSync(join(sceneDir, 'scene.json'), JSON.stringify({ steps: 2, url: 'https://example.test/scene', props: [
      { key: 'caption', kind: 'text', default: 'Oslo' },
      { key: 'amount', kind: 'number', default: 3 },
      { key: 'color', kind: 'color', default: '#123456' },
    ] }))
    const template = read('beta/templates/blank.bento.html')
    let posted = ''
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url) === 'https://schema-test.invalid/templates/blank.bento.html') return new Response(template)
      if (String(url) === 'https://schema-test.invalid/api/harness/decks' && init?.method === 'POST') {
        posted = init.body
        return Response.json({ id: 'round6', url: 'https://schema-test.invalid/d/round6' }, { status: 201 })
      }
      throw new Error('unexpected test request: ' + url)
    }) as typeof fetch
    await create(fixture, { skipUrlCheck: true, env: { SLIDES_STORE_URL: 'https://schema-test.invalid', CF_ACCESS_CLIENT_ID: 'test-id', CF_ACCESS_CLIENT_SECRET: 'test-secret' }, log() {} })
    const created = readBlock(posted)
    // Failing-first control: this exact writer output with a misspelled slide key fails.
    const broken = structuredClone(created)
    broken.slides[0].runtim = broken.slides[0].runtime
    ok(check(broken, file).some(e => e.includes('unknown key runtim')), 'create: unknown slide key is rejected')
    ok(check(created, file).length === 0, 'create: actual POST document validates: ' + JSON.stringify(check(created, file)))
    const project = readProject(fixture)
    const replaced = derive(created, project).doc
    const invalid = structuredClone(replaced)
    invalid.slides[0].runtime.url = 'javascript:alert(1)'
    ok(check(invalid, file).length > 0 && check(replaced, file).length === 0,
      'applyScene: replacement validates and invalid runtime URL fails')
  } finally { globalThis.fetch = priorFetch; rmSync(fixture, { recursive: true, force: true }) }
}

// BETA FORK: round 6, Beta web embeds must retain every accepted URL on save.
{
  const { sanitizeElement } = await import('../slides/src/untrusted.ts')
  const { serializeFile, embeddedDocBlock } = await import('../slides/src/save.ts')
  for (const url of ['https://example.test/live', 'HTTPS://example.test/live']) {
    const embed = { id: 'web-probe', type: 'embed', x: 0, y: 0, w: 1280, h: 720,
      rotation: 0, opacity: 1, app: 'web', url, live: true, view: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }
    const bad = { ...embed, accidentalKey: true }
    ok(validate((file.$defs as J).embed as J, bad, file).length > 0,
      'web embed: unknown key fails (' + url + ')')
    const gated = sanitizeElement(embed)
    const d = starterDoc()
    d.slides[0].elements = [gated!]
    // The save rig above captured a minimal shell; use the real serializer.
    const saved = JSON.parse(embeddedDocBlock(serializeFile(d))!)
    const errs = check(saved, file)
    ok(!!gated && (gated as any).url === url && saved.$schema === file.$id
      && saved.slides[0].elements[0].url === url && errs.length === 0,
      'web embed: gate-kept URL validates (' + url + '): ' + JSON.stringify(errs))
  }
}

// BETA FORK: round 7, negative mutations precede generated valid/save cases.
{
  const rt = (file.$defs as any).slide.properties.runtime
  const { isDeepStrictEqual } = await import('node:util')
  const errors: string[] = []
  for (let n = 0; n < 96; n++) {
    const kind = (['text', 'number', 'color'] as const)[n % 3]
    const value = kind === 'text' ? `Oslo ${n} 🚲` : kind === 'number' ? n / 7 : '#12ABef'
    const record = { src: 'asset:scene', still: 'asset:still', steps: n,
      url: Array.from('https', (c, i) => n & (1 << i) ? c.toUpperCase() : c).join('') + '://example.test/scene',
      props: [{ key: 'setting', label: 'Setting', kind, default: value, format: n % 2 ? 'select:a|b' : '🚲'.repeat(200) }],
      values: { setting: value }, library: { id: 'scene-' + n, version: n + 1 }, assets: ['scene.js'] }
    const broken = structuredClone(record) as any
    broken.library.version = 0
    if (!validate(rt, broken, file).length || checkRuntime(broken)?.library) errors.push(`invalid library ${n}`)
    const kept = checkRuntime(record)!
    if (validate(rt, record, file).length || !isDeepStrictEqual(kept, record)) errors.push(`valid record ${n}`)
    // A repaired input may fail schema validation, but the gate's actual output must pass.
    const repaired = checkRuntime({ ...record, steps: '-7', src: 'javascript:bad',
      props: [{ ...record.props[0], default: kind === 'number' ? '3.5' : kind === 'color' ? '  #12ABef  ' : false }] })!
    if (validate(rt, repaired, file).length) errors.push(`repaired output ${n}`)
    const deck = starterDoc(); deck.slides[0].runtime = kept
    if (check(deck, file).length) errors.push(`deck ${n}`)
    ;(deck.slides[0] as any).runtimeTypo = {}
    if (!check(deck, file).some(e => e.includes('unknown key runtimeTypo'))) errors.push(`unknown slide key ${n}`)
  }
  ok(errors.length === 0, 'round 7 generated runtime/library/format records and repaired outputs validate; invalid library and slide keys fail: ' + errors.join(', '))
}

// BETA FORK: round 7 attacks the round 6 scheme-case fix exhaustively.
{
  const { sanitizeElement } = await import('../slides/src/untrusted.ts')
  const { serializeFile, embeddedDocBlock } = await import('../slides/src/save.ts')
  const errors: string[] = []
  for (const scheme of ['http', 'https']) for (let bits = 0; bits < 1 << scheme.length; bits++) {
    const mixed = Array.from(scheme, (c, i) => bits & (1 << i) ? c.toUpperCase() : c).join('')
    const url = mixed + '://example.test/scene?q=Oslo#view'
    const el = { id: 'case-probe', type: 'embed', x: 0, y: 0, w: 800, h: 450,
      rotation: 0, opacity: 1, app: 'web', url, live: true, view: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }
    if (!validate((file.$defs as J).embed as J, { ...el, url: 'javascript:bad' }, file).length) errors.push('bad scheme accepted')
    const kept = sanitizeElement(el)
    const deck = starterDoc(); deck.slides[0].elements = kept ? [kept] : []
    const saved = JSON.parse(embeddedDocBlock(serializeFile(deck))!)
    if (!kept || (kept as any).url !== url || check(saved, file).length) errors.push(mixed)
  }
  ok(errors.length === 0, 'round 7 all 48 HTTP/HTTPS scheme casings survive gate/save/schema; invalid scheme fails: ' + errors.join(', '))
}

// BETA FORK: round 7, exercise the library writer used by U11 and U12.
{
  const { readManifest, runtimeSlideWith } = await import('../slides/src/beta/libraryread.ts')
  const raw = { id: 'round-seven', version: 1, name: 'Round seven', kind: 'runtime', steps: 2,
    props: [{ key: 'caption', label: 'Caption', kind: 'text', default: 'Oslo', format: 'select:Oslo|Bergen' }],
    presets: [], html: '<main>Scene</main>', still: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"></svg>' }
  ok(readManifest({ format: 'beta/library', v: 1, scenes: [{ ...raw, version: 0 }] })?.length === 0,
    'round 7 library writer refuses invalid library version first')
  const scene = readManifest({ format: 'beta/library', v: 1, scenes: [raw] })?.[0]
  const deck = starterDoc()
  const slide = scene && runtimeSlideWith(deck, scene, { caption: 'Bergen' })
  if (slide) deck.slides.push(slide)
  const { serializeFile, embeddedDocBlock } = await import('../slides/src/save.ts')
  const saved = JSON.parse(embeddedDocBlock(serializeFile(deck))!)
  const errs = check(saved, file)
  ok(!!slide && saved.slides.at(-1).runtime.library.id === raw.id && saved.$schema === file.$id && errs.length === 0,
    'round 7 actual library insert and save validate against advertised schema: ' + JSON.stringify(errs))
}

// BETA FORK: round 8, terminal line breaks must not evade the format rule.
{
  const rt = (file.$defs as any).slide.properties.runtime
  const misses: string[] = []
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    const record = { props: [{ key: 'mode', label: 'Mode', kind: 'text', default: 'a', format: 'bool' + suffix }] }
    const kept = checkRuntime(record)!
    if (validate(rt, record, file).length === 0 || kept.props[0].format !== undefined || validate(rt, kept, file).length) misses.push(JSON.stringify(suffix))
  }
  const clean = { props: [{ key: 'mode', label: 'Mode', kind: 'text', default: 'a', format: 'bool' }] }
  ok(!misses.length && validate(rt, clean, file).length === 0 && checkRuntime(clean)!.props[0].format === 'bool',
    'round 8 terminal format line breaks fail schema and gate; clean hint passes; mismatches=' + misses.join(', '))
}

// BETA FORK: round 8, actual saved URLs at the gate's length limit, with
// mixed-case schemes and opaque path/query characters (negative control first).
{
  const { sanitizeElement } = await import('../slides/src/untrusted.ts')
  const { serializeFile, embeddedDocBlock } = await import('../slides/src/save.ts')
  const misses: string[] = []
  for (const prefix of ['hTtP://example.test/', 'hTtPs://example.test/']) {
    for (const tail of ['?q=%2F%3F%23#part', '/é/🚲?x=1&y=2']) {
      const url = prefix + 'a'.repeat(2048 - prefix.length - tail.length) + tail
      const el = { id: 'round8-url', type: 'embed', x: 0, y: 0, w: 800, h: 450, rotation: 0, opacity: 1,
        app: 'web', live: true, url, view: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }
      const invalid = { ...el, url: 'javascript:alert(1)' }
      if (!validate((file.$defs as J).embed as J, invalid, file).length) misses.push('invalid scheme')
      const kept = sanitizeElement(el)
      const deck = starterDoc(); deck.slides[0].elements = kept ? [kept] : []
      const saved = JSON.parse(embeddedDocBlock(serializeFile(deck))!)
      if (!kept || (kept as any).url !== url || check(saved, file).length) misses.push(prefix + tail)
    }
  }
  ok(!misses.length, 'round 8 mixed-case embed URLs at the gate limit survive save/schema; bad scheme fails: ' + misses.join(', '))
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
