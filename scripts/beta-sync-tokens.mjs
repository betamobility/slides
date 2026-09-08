#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Vendor the design-system tokens into beta/tokens.json.
//
//   node scripts/beta-sync-tokens.mjs                 (sibling repo, default)
//   node scripts/beta-sync-tokens.mjs --from <dir>    (any checkout)
//   BETA_DESIGN_SYSTEM=<dir> node scripts/beta-sync-tokens.mjs
//
// WHAT THIS DOES. `beta/tokens.json` is a COPY, not a link: a deck must build
// from this repository alone, and the design system is a separate repo that
// moves on its own schedule. So the sync copies `tokens.json` verbatim, then
// merges `beta/tokens.slides.json` on top (the accents, link colours, chart
// palette and table defaults the design system deliberately does not define,
// DESIGN.md section 7), and records where the copy came from under `_source`
// so a reviewer can tell which design-system commit a deck was branded from.
//
// Re-running is the refresh path. The overlay lives in its own committed file
// precisely so that a sync can never lose it.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const betaDir = join(root, 'beta')

const args = process.argv.slice(2)
const fromArg = args.includes('--from') ? args[args.indexOf('--from') + 1] : undefined
const from = resolve(fromArg ?? process.env.BETA_DESIGN_SYSTEM ?? join(betaDir, '../../design-system'))

const src = join(from, 'tokens.json')
if (!existsSync(src)) {
  console.error(`beta-sync-tokens: no tokens.json in ${from}\n` +
    `  Pass --from <path-to-design-system> or set BETA_DESIGN_SYSTEM.`)
  process.exit(1)
}

let sha = 'unknown'
try {
  sha = execFileSync('git', ['-C', from, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
} catch {
  console.error(`beta-sync-tokens: ${from} is not a git checkout; recording sha "unknown"`)
}

const core = JSON.parse(readFileSync(src, 'utf8'))
const overlayPath = join(betaDir, 'tokens.slides.json')
if (!existsSync(overlayPath)) {
  console.error(`beta-sync-tokens: missing overlay ${overlayPath}`)
  process.exit(1)
}
const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'))
if (!overlay.slides || typeof overlay.slides !== 'object') {
  console.error(`beta-sync-tokens: ${overlayPath} has no "slides" block`)
  process.exit(1)
}

const merged = {
  _source: { repo: 'Tools/design-system', sha, syncedAt: new Date().toISOString() },
  ...core,
  slides: overlay.slides,
}

const out = join(betaDir, 'tokens.json')
writeFileSync(out, JSON.stringify(merged, null, 2) + '\n')
console.log(`beta-sync-tokens: wrote ${out} from ${from} @ ${sha}`)
