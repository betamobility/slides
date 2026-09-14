#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
//
// Assemble the beta-slides skill for the Beta toolkit (betamobility/skills,
// plugins/beta-toolkit/skills/beta-slides/). The toolkit installs skill
// folders only, so the splice tool travels inside the skill:
//
//   <out>/SKILL.md, reveal/…          from plugins/beta-slides/skills/beta-slides/
//   <out>/scripts/splice.mjs          from plugins/beta-slides/scripts/
//   <out>/scripts/lib/bento-doc.mjs   (splice.mjs imports ./lib/bento-doc.mjs)
//
// This repo stays the source; the toolkit copy is regenerated, never edited.
//
//   node scripts/build-beta-toolkit-skill.mjs <out-dir>

import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const plugin = join(root, 'plugins/beta-slides')

export function build(out) {
  out = resolve(out)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, 'scripts/lib'), { recursive: true })
  cpSync(join(plugin, 'skills/beta-slides'), out, { recursive: true })
  cpSync(join(plugin, 'scripts/splice.mjs'), join(out, 'scripts/splice.mjs'))
  cpSync(join(plugin, 'scripts/lib/bento-doc.mjs'), join(out, 'scripts/lib/bento-doc.mjs'))
  let sha = 'unknown'
  try { sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() } catch {}
  writeFileSync(join(out, 'SOURCE.md'),
    '# Generated, do not edit here\n\n' +
    'This folder is built from https://github.com/betamobility/slides ' +
    `(commit ${sha}) by \`node scripts/build-beta-toolkit-skill.mjs\`.\n` +
    'Change the skill in `plugins/beta-slides/` there, then rebuild and copy it here.\n')
  return out
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2]
  if (!out) { console.error('usage: node scripts/build-beta-toolkit-skill.mjs <out-dir>'); process.exit(2) }
  const dir = build(out)
  for (const f of ['SKILL.md', 'reveal/shim.js', 'scripts/splice.mjs', 'scripts/lib/bento-doc.mjs']) {
    if (!existsSync(join(dir, f))) { console.error(`missing ${f}`); process.exit(1) }
  }
  console.log(`built ${dir}`)
}
