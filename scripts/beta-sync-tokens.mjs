#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Refresh the design-system snapshot every Beta deck theme is built from.
//
//   node scripts/beta-sync-tokens.mjs                 (sibling repo ../design-system, default)
//   node scripts/beta-sync-tokens.mjs --from <dir>    (any checkout of betamobility/design-system)
//   BETA_DESIGN_SYSTEM=<dir> node scripts/beta-sync-tokens.mjs
//
// Copies <design-system>/tokens.json to beta/v131/tokens.json and writes that
// checkout's commit into beta/v131/SOURCE.md, which scripts/lib/beta-general.mjs
// reads as the provenance every deck carries. Then run build-beta-theme.mjs,
// build-beta-starter.mjs and build-beta-templates.mjs, and commit the results.
// (Until 2026-10-14 this wrote beta/tokens.json, the 1.0.0 format, merged with
// a hand-edited Slides overlay; v1.5.0 carries everything a deck needs.)

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const from = resolve(args.includes('--from') ? args[args.indexOf('--from') + 1] : process.env.BETA_DESIGN_SYSTEM ?? join(root, '..', 'design-system'))
const src = join(from, 'tokens.json')
if (!existsSync(src)) {
  console.error(`beta-sync-tokens: no tokens.json in ${from}\n  pass --from <checkout of betamobility/design-system> or set BETA_DESIGN_SYSTEM`)
  process.exit(1)
}
let sha
try { sha = execFileSync('git', ['-C', from, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim() } catch {
  console.error(`beta-sync-tokens: ${from} is not a git checkout; the snapshot needs a commit to name`)
  process.exit(1)
}
const snapshot = join(root, 'beta', 'v131')
copyFileSync(src, join(snapshot, 'tokens.json'))
const sourceMd = join(snapshot, 'SOURCE.md')
const text = readFileSync(sourceMd, 'utf8')
if (!/commit [0-9a-f]{7}/.test(text)) { console.error(`beta-sync-tokens: ${sourceMd} names no commit to update`); process.exit(1) }
writeFileSync(sourceMd, text.replace(/commit [0-9a-f]{7}/, `commit ${sha}`))
console.log(`beta-sync-tokens: beta/v131/tokens.json from ${from} @ ${sha}; now run build-beta-theme, build-beta-starter and build-beta-templates`)
