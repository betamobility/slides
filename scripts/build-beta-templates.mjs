#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
//
// Build the three Beta starter decks (plan U4) into beta/templates/ by
// splicing each document into the built shell. Same splice as the gallery
// builder (scripts/build-example-decks.mjs): `<` escaped as < so no
// literal `</script>` can end the block (AGENTS.md hard rule 1).
//
//   node scripts/build-beta-templates.mjs [--shell path] [--out dir]
//
// Needs `npm run build:single` in slides/ first. Templates carry
// `template: true` and no docId or collab: every open mints a fresh deck.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { betaTemplates } from './lib/beta-layouts.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const shellPath = opt('shell', join(root, 'slides/dist-single/Bento_Slides.bento.html'))
const outDir = opt('out', join(root, 'beta/templates'))

if (!existsSync(shellPath)) {
  console.error(`✗ no built shell at ${shellPath} — run "npm run build:single" in slides/ first`)
  process.exit(1)
}
const shell = readFileSync(shellPath, 'utf8')
const fragment = JSON.parse(readFileSync(join(root, 'beta/theme.json'), 'utf8'))

export function spliceDoc(shellText, doc) {
  const blockRe = /<script type="application\/bento\+json" id="bento-doc">[\s\S]*?<\/script>/
  const json = JSON.stringify(doc).replace(/</g, '\\u003c')
  if (json.includes('</script')) throw new Error('a literal </script> survived escaping')
  const out = shellText.replace(blockRe, () => `<script type="application/bento+json" id="bento-doc">\n${json}\n</scr` + 'ipt>')
  if (!out.includes(json)) throw new Error('splice failed')
  return out
}

mkdirSync(outDir, { recursive: true })
for (const [name, doc] of Object.entries(betaTemplates(fragment))) {
  if ('docId' in doc || 'collab' in doc) throw new Error(`${name}: a template must not carry docId or collab`)
  const file = join(outDir, `${name}.bento.html`)
  const html = spliceDoc(shell, doc)
  writeFileSync(file, html)
  console.log(`${name}.bento.html  ${Math.round(html.length / 1024)} KB, ${doc.slides.length} slides, ${doc.layouts.length} layouts`)
}
