#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// BETA FORK: build the scene library's manifest from beta/library/<scene>/
// and, when asked, upload it to the deck store (2026-10-13-2236 plan, U8).
//
//   node scripts/build-beta-library.mjs            validate, write the manifest, list the scenes
//   node scripts/build-beta-library.mjs --check    validate only; what CI runs
//   node scripts/build-beta-library.mjs --upload   validate, then PUT it to the store
//   ... --out <file>                               where to write it (default below)
//
// The manifest is GENERATED and never committed: it carries every scene's HTML,
// and the folders are the source (scripts/lib/beta-library.mjs says what a
// folder holds and what is refused). It is written under beta/library/.out/,
// which .gitignore names.
//
// THE UPLOAD goes to the store, never to a public origin (KTD13): the site
// repo and its Pages host are public, and the library is for signed-in people.
// It needs the store's SERVICE TOKEN, as the two variables the splice tool
// reads, CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET; a person's login or
// an agent's grant is refused by the route (server/deck-store, PUT
// /api/harness/library.json). SLIDES_STORE_URL names another store (default
// https://slides.betamobility.ai). Nothing is uploaded without --upload, and
// CI never passes it.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildManifest, LibraryError, serialize } from './lib/beta-library.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const known = new Set(['--check', '--upload', '--out', '--dir'])
for (const [i, a] of args.entries()) {
  if (a.startsWith('--') ? !known.has(a) : !['--out', '--dir'].includes(args[i - 1])) { console.error(`build-beta-library: unknown argument ${a}`); process.exit(2) }
}
const dir = value('--dir') ?? join(root, 'beta/library')
const out = value('--out') ?? join(root, 'beta/library/.out/library.json')

let manifest
try {
  manifest = buildManifest(dir)
} catch (e) {
  if (!(e instanceof LibraryError)) throw e
  console.error(`build-beta-library: ${e.message}`)
  process.exit(1)
}
const body = serialize(manifest)
for (const s of manifest.scenes) {
  console.log(`  ${s.id}  v${s.version}  ${s.kind}  ${s.props.length} settings, ${s.presets.length} presets  "${s.name}"`)
}
console.log(`${manifest.scenes.length} scenes, ${(Buffer.byteLength(body) / 1024).toFixed(1)} KB`)

if (flag('--check')) process.exit(0)

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, body)
console.log(`wrote ${out}`)

if (flag('--upload')) {
  const { CF_ACCESS_CLIENT_ID: id, CF_ACCESS_CLIENT_SECRET: secret } = process.env
  if (!id || !secret) {
    console.error('build-beta-library: --upload needs the store\'s service token in CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET; nothing was uploaded')
    process.exit(1)
  }
  const store = (process.env.SLIDES_STORE_URL || 'https://slides.betamobility.ai').replace(/\/+$/, '')
  let res
  try {
    res = await fetch(`${store}/api/harness/library.json`, {
      method: 'PUT', redirect: 'manual',
      headers: { 'content-type': 'application/json', 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret },
      body,
    })
  } catch (e) {
    console.error(`build-beta-library: could not reach ${store}: ${e.message}`)
    process.exit(1)
  }
  if (res.status !== 200) {
    const why = res.status === 404 ? 'the store does not have the library route yet (deploy server/deck-store first)'
      : res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400) ? 'the service token was not accepted'
      : (await res.text().catch(() => '')).slice(0, 200)
    console.error(`build-beta-library: the store answered ${res.status}: ${why}`)
    process.exit(1)
  }
  console.log(`uploaded to ${store} (etag ${res.headers.get('etag')})`)
}
