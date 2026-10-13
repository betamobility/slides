#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// BETA FORK: a saved Beta deck advertises a schema that accepts it.
//
//   node scripts/test-beta-schema.ts        (after `npm run build:single` in slides/)
//
// WHAT THIS PROVES (upstream-merge plan U3, R4). Upstream stamps every saved
// deck with a `$schema` URL and publishes the schema there. Two things were
// wrong for a Beta deck after the merge: the stamp named upstream's copy, and
// the generator printed `runtime: {}` for the fork's slide key, so an agent
// validating a Beta deck learned nothing about runtime slides. The validating
// cases (a runtime deck passes, a broken one fails) live in upstream's
// scripts/test-slides-schema.ts, which owns the validator; this rig checks the
// plumbing around them: the stamp, the file on disk, what the release stages,
// what the worker serves without a login, and what the built shell tells an
// agent reading it.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')
let checks = 0
let failures = 0
function ok(cond: unknown, what: string) {
  checks++
  if (!cond) failures++
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${what}`)
}

const URL_ = 'https://slides.betamobility.ai/schema/slides.json'
const version = JSON.parse(read('slides/package.json')).version as string

console.log('the stamp and the file')
ok(new RegExp(`export const SCHEMA_URL = '${URL_.replace(/[.]/g, '\\.')}' // BETA FORK`).test(read('slides/src/schema.ts')), 'schema.ts stamps Beta\'s URL, on one marked line')
const main = JSON.parse(read('schema/slides.json'))
ok(main.$id === URL_, `schema/slides.json carries that URL as its $id (${main.$id})`)
ok(main['x-bento-version'] === version && existsSync(join(root, `schema/slides-${version}.json`)), `it is stamped ${version} and has its version-pinned twin`)
const rt = main.$defs?.slide?.properties?.runtime
ok(rt && rt.type === 'object' && Object.keys(rt.properties ?? {}).length === 7, 'slide.runtime is a described object, not the empty schema the generator prints for an untagged check')
ok(/runtime: tag\(\(v\) => checkRuntime\(v\), RUNTIME_SCHEMA\)/.test(read('slides/src/untrusted.ts')), 'because the runtime check carries its schema (untrusted.ts SLIDE_CHECKS)')
ok(!/from '\.\/untrusted/.test(read('slides/src/runtime.ts')), 'which is built beside checkRuntime without importing untrusted.ts (that file imports this one)')

console.log('\nwhat a release puts on the site, and what the worker lets through')
const release = read('scripts/release.mjs')
ok(/mkdirSync\(join\(site, 'schema'\)/.test(release) && /\$id\?\.startsWith\('https:\/\/slides\.betamobility\.ai\/'\)/.test(release), 'release.mjs stages schema/ into the site, Beta\'s own files only')
const staged = readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.json') && JSON.parse(read(`schema/${f}`)).$id?.startsWith('https://slides.betamobility.ai/'))
ok(staged.includes('slides.json') && staged.includes(`slides-${version}.json`) && !staged.some((f) => /slides-1\./.test(f)), `that is slides.json and its twin, none of upstream's (${staged.join(', ')})`)
const worker = read('server/deck-store/src/worker.js')
ok(/const PUBLIC_PREFIXES = \[[^\]]*'\/schema\/'[^\]]*\]/.test(worker), 'the deck-store worker serves /schema/ without a login (PUBLIC_PREFIXES)')
ok(new URL(URL_).pathname.startsWith('/schema/'), 'and the stamped URL is under that prefix')

// The live --routes pass probes the Access bypass (KTD3).
ok(/path:\s*['"]\/schema\/slides\.json['"]/.test(read('scripts/check-store-live.mjs')),
  'check-store-live.mjs --routes asks for the schema anonymously, so a missing Access bypass is caught')

console.log('\nwhat the built shell tells an agent')
const shellPath = join(root, 'slides/dist-single/Bento_Slides.bento.html')
if (!existsSync(shellPath)) {
  ok(false, 'slides/dist-single/Bento_Slides.bento.html is built (run `npm run build:single` in slides/ first)')
} else {
  const shell = readFileSync(shellPath, 'utf8')
  ok(shell.includes(`Schema: ${URL_} (= window.bento.schema())`), 'the tooling comment names Beta\'s schema URL')
  ok(!shell.includes('bento.page/schema') && !shell.includes('bento.page/llms.txt'), 'and neither upstream\'s schema nor its llms.txt')
  ok(/--schema-url https:\/\/slides\.betamobility\.ai\/schema\/slides\.json --llms-url none/.test(read('slides/package.json')), 'because build:single passes both flags to postbuild-compress.mjs')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
