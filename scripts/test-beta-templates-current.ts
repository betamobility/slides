#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Beta templates are current rig (plan v1.1 U1, KTD1).
//
//   node scripts/test-beta-templates-current.ts [--shell path] [--dir dir]
//
// WHAT THIS PROVES. Every deck in beta/templates/ embeds the runtime of the
// shell in slides/dist-single/ — byte for byte, measured as a sha256 over the
// `bento/deflate-b64` payload blocks, the same regex scripts/publish-site.mjs
// runs before a publish (both import scripts/lib/beta-shell-payload.mjs).
//
// WHY. The templates are generated output — build-beta-templates.mjs splices
// a document into whatever shell is built — and they used to be committed.
// Release 2026.9.1 shipped with beta/templates/ still carrying the upstream
// 1.0.19 runtime it had been built from a week earlier, so a template opened
// from the site offered an "update" to the release it was published with.
// They are gitignored now and CI builds them from the shell it just built;
// this rig is what fails if anyone commits them again, or builds them before
// rebuilding the shell.
//
// Vacuous passes are closed off on every side: no shell, a shell without
// payload, an empty templates directory and a template without payload all
// FAIL rather than skip.

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { payloadHashOfFile } from './lib/beta-shell-payload.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const shellPath = opt('shell', join(root, 'slides/dist-single/Bento_Slides.bento.html'))
const dir = opt('dir', join(root, 'beta/templates'))
const rel = (p: string) => p.startsWith(root) ? p.slice(root.length + 1) : p

let checks = 0
let failures = 0
const ok = (cond: boolean, msg: string) => {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

console.log('shell')
ok(existsSync(shellPath), `built shell at ${rel(shellPath)} (run "npm run build:single" in slides/)`)
const shellHash = existsSync(shellPath) ? payloadHashOfFile(shellPath) : null
ok(shellHash !== null, 'the shell carries bento/deflate-b64 payload blocks (guard is live)')

console.log('\ntemplates')
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.bento.html')).sort() : []
ok(files.length > 0, `${rel(dir)} holds at least one template (run "node scripts/build-beta-templates.mjs")`)
for (const f of files) {
  const file = join(dir, f)
  const hash = payloadHashOfFile(file)
  if (hash === null) {
    ok(false, `${rel(file)} carries no bento/deflate-b64 payload — not a deck built from a shell`)
  } else {
    ok(hash === shellHash, `${rel(file)} embeds the built shell's runtime` +
      (hash === shellHash ? '' : ` (payload ${hash.slice(0, 12)}… ≠ shell ${String(shellHash).slice(0, 12)}… — rebuild it from the current shell)`))
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.log('\nbeta/templates/ is generated output. Rebuild it from the current shell:\n' +
    '  cd slides && npm run build:single && node ../scripts/build-beta-templates.mjs')
  process.exit(1)
}
