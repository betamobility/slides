#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
//
// Headless PPTX export (plan U5, agent-native follow-up): the same mapper the
// editor's Export PPTX button runs, callable from a file harness so an agent
// authoring a deck can export it and read the degrade report without a
// browser. SVG and embed views travel as SVG pictures here (no rasteriser).
//
//   node scripts/export-pptx.mjs <deck.bento.html> [--out <file.pptx>]
//
// The session (`collab`) is deleted before the mapper sees the document, the
// way the editor does it (KTD7).

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const outIdx = args.indexOf('--out')
if (!file) { console.error('usage: node scripts/export-pptx.mjs <deck.bento.html> [--out <file.pptx>]'); process.exit(2) }
const out = outIdx >= 0 && args[outIdx + 1] ? resolve(args[outIdx + 1]) : resolve(file).replace(/\.bento\.html$|\.html$/i, '') + '.pptx'

const html = readFileSync(resolve(file), 'utf8')
const m = html.match(/<script type="application\/bento\+json" id="bento-doc">\s*([\s\S]*?)\s*<\/script>/)
if (!m || !m[1].trim()) { console.error(`✗ no #bento-doc block in ${file} (a downloaded shell has an empty block until a deck is written into it)`); process.exit(1) }
const doc = JSON.parse(m[1].replace(/\\u003c/g, '<'))
delete doc.collab

// The mapper is TypeScript with extensionless imports: bundle it once per run.
const esbuild = join(root, 'slides/node_modules/.bin/esbuild')
if (!existsSync(esbuild)) { console.error(`✗ ${esbuild} missing: run "npm ci" in slides/ first`); process.exit(1) }
const dir = join(tmpdir(), `beta-export-pptx-${process.pid}`)
mkdirSync(dir, { recursive: true })
const bundle = join(dir, 'pptx.mjs')
execFileSync(esbuild, [join(root, 'slides/src/export/pptx.ts'), '--bundle', '--platform=node', '--format=esm', '--log-level=warning', `--outfile=${bundle}`], { stdio: 'inherit' })
const { mapDeck } = await import(pathToFileURL(bundle).href)
const { pptx, report } = await mapDeck(doc)
const bytes = Buffer.from(await pptx.write({ outputType: 'nodebuffer' }))
writeFileSync(out, bytes)
rmSync(dir, { recursive: true, force: true })

console.log(`${basename(out)}  ${Math.round(bytes.length / 1024)} KB, ${doc.slides.length} slides`)
const named = report.filter((r) => r.elementId !== '*')
if (!named.length) console.log('no degradations')
else {
  console.log(`${named.length} element(s) degraded:`)
  for (const r of named) console.log(`  ${r.slideId}/${r.elementId}  ${r.reason}  ${r.detail}`)
}
for (const r of report.filter((x) => x.elementId === '*')) console.log(`  deck  ${r.reason}  ${r.detail}`)
