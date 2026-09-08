#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// PPTX export rig (plan U5). Characterisation-first: the DEGRADE REPORT for the
// fixture deck is pinned here before the mapper exists, so the mapper is done
// when the report matches and the file it writes is a real PPTX.
//
// Run as `node scripts/test-beta-pptx.ts`. The mapper imports slides/src/model
// extensionlessly, so when run as .ts the rig bundles itself with esbuild from
// slides/node_modules (the way ci.yml bundles test-validate.ts) and re-executes
// the bundle. Needs `npm ci` in slides/ first.

import { readFileSync, writeFileSync, mkdtempSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

// ---- self-bundle ------------------------------------------------------------
if (import.meta.url.endsWith('.ts')) {
  const self = fileURLToPath(import.meta.url)
  const root = resolve(self, '../..')
  const esbuild = join(root, 'slides/node_modules/.bin/esbuild')
  if (!existsSync(esbuild)) {
    console.log(`  FAIL  ${esbuild} is missing: run "npm ci" in slides/ first`)
    process.exit(1)
  }
  const dir = join(tmpdir(), `beta-pptx-rig-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const bundle = join(dir, 'test-beta-pptx.mjs')
  execFileSync(esbuild, [self, '--bundle', '--platform=node', '--format=esm', '--log-level=warning', `--outfile=${bundle}`], { stdio: 'inherit' })
  const r = spawnSync(process.execPath, [bundle], { stdio: 'inherit', env: { ...process.env, BETA_RIG_ROOT: root } })
  rmSync(dir, { recursive: true, force: true })
  process.exit(r.status ?? 1)
}

// ---- the rig ----------------------------------------------------------------
// Dynamic import on purpose: a static import is hoisted above the guard.
type BentoDoc = import('../slides/src/model.ts').BentoDoc
type DegradeEntry = import('../slides/src/export/pptx.ts').DegradeEntry
const { mapDeck } = await import('../slides/src/export/pptx.ts')

const root = process.env.BETA_RIG_ROOT ?? process.cwd()
let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const fixture = JSON.parse(readFileSync(join(root, 'scripts/fixtures/beta-export-fixture.json'), 'utf8')) as BentoDoc

// ---- 1. the degrade report, pinned ------------------------------------------
// One line per element (or per deck for deck-wide degradations), sorted, so a
// mapper that silently stops reporting something turns this red.
const EXPECTED_REPORT: Array<Pick<DegradeEntry, 'elementId' | 'slideId' | 'reason'>> = [
  { slideId: 's1', elementId: 'sh-grad', reason: 'gradient' },
  { slideId: 's2', elementId: 'svg-1', reason: 'svg' },
  { slideId: 's3', elementId: 'media-1', reason: 'media' },
  { slideId: 's3', elementId: 'code-1', reason: 'code-colour' },
  { slideId: 's3', elementId: 'embed-1', reason: 'embed' },
  { slideId: 's3', elementId: 'svg-hostile', reason: 'svg' },
  { slideId: '*', elementId: '*', reason: 'motion' },
  { slideId: '*', elementId: '*', reason: 'fonts' },
]
const key = (e: { slideId: string; elementId: string; reason: string }) => `${e.slideId}/${e.elementId}/${e.reason}`

console.log('degrade report')
const doc = JSON.parse(JSON.stringify(fixture)) as BentoDoc
delete doc.collab
const { pptx, report } = await mapDeck(doc)
const got = report.map(key).sort()
const want = EXPECTED_REPORT.map(key).sort()
for (const w of want) ok(got.includes(w), `reports ${w}`)
for (const g of got) ok(want.includes(g), `nothing unexpected: ${g}`)
ok(report.every((r) => typeof r.detail === 'string' && r.detail.length > 0), 'every entry carries a human-readable detail')

// ---- 2. the file ------------------------------------------------------------
console.log('\nthe pptx')
const bytes = Buffer.from(await pptx.write({ outputType: 'nodebuffer' }) as Uint8Array)
ok(bytes.length > 2000 && bytes[0] === 0x50 && bytes[1] === 0x4b, `output is a zip (${bytes.length} bytes)`)
const work = mkdtempSync(join(tmpdir(), 'beta-pptx-'))
const file = join(work, 'fixture.pptx')
writeFileSync(file, bytes)
execFileSync('unzip', ['-q', '-o', file, '-d', join(work, 'x')])
const list = execFileSync('find', [join(work, 'x'), '-type', 'f'], { encoding: 'utf8' }).split('\n').filter(Boolean)
const rel = (p: string) => p.slice(join(work, 'x').length + 1)
const slideXml = list.filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(rel(p))).sort()
const notesXml = list.filter((p) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(rel(p)))
// 3 linear slides + 1 state (hidden) + 1 hidden = 5 slide parts
ok(slideXml.length === 5, `ppt/slides/ holds one file per slide incl. state and hidden (${slideXml.length})`)
ok(notesXml.length >= 2, `ppt/notesSlides/ carries speaker notes (${notesXml.length})`)
const read = (p: string) => readFileSync(p, 'utf8')
const all = slideXml.map(read)

// slide ordering follows doc.slides; the state and hidden slides are marked hidden
const hiddenFlags = all.map((x) => /<p:sld[^>]*\sshow="0"/.test(x))
ok(hiddenFlags[3] === true && hiddenFlags[4] === true, 'the stateOf slide and the hidden slide are hidden in PowerPoint')
ok(hiddenFlags[0] === false && hiddenFlags[1] === false && hiddenFlags[2] === false, 'linear slides are visible')

// text: 88px -> 66pt -> sz="6600"; lineHeight 1.1 -> lnSpc 110%; font face named
const s1 = all[0]
ok(/sz="6600"/.test(s1), 'a fontSize 88 text carries sz="6600" (88px = 66pt)')
ok(/<a:lnSpc><a:spcPct val="110000"\/>/.test(s1), 'lineHeight 1.1 becomes lnSpc 110%')
ok(/typeface="Playfair Display"/.test(s1), 'the heading fontFace is the family name, not the stack')
ok(/<a:b val="1"\/>|\sb="1"/.test(s1) && /one/.test(s1), 'inline <b> becomes a bold run')
ok(!/<b>|<i>|<br>/.test(s1.replace(/<a:[^>]*>/g, '')), 'no raw HTML tags survive into the run text')

// gradient shape: filled with the FIRST stop, and reported (checked above)
ok(/<a:srgbClr val="4A7C59"\/>/.test(s1), 'the gradient shape is filled with its first stop')
ok(!/gradFill/.test(s1), 'no gradient fill was attempted')

// chart: two series in the chartPalette, categories from xAxis.data
const chartXml = list.filter((p) => /^ppt\/charts\/chart\d+\.xml$/.test(rel(p))).map(read).join('')
ok(/<c:ser>[\s\S]*<c:ser>/.test(chartXml), 'the bar chart carries two series')
ok(/4A7C59/.test(chartXml) && /40916C/.test(chartXml), 'series colours come from theme.chartPalette')
ok(/<c:v>Q1<\/c:v>/.test(chartXml) && /<c:v>Q3<\/c:v>/.test(chartXml), 'categories come from xAxis.data')

// table: header fill on row 0, zebra alternation below
const s2 = all[1]
ok(/<a:tbl>/.test(s2), 'the table is a real table')
ok(/<a:tcPr[^>]*>[\s\S]*?<a:srgbClr val="1A1A1A"\/>/.test(s2), 'the header row carries the header fill')
ok(/<a:srgbClr val="F0EDE8"\/>/.test(s2), 'zebra rows carry the zebra fill')
ok(/<a:gridCol w="\d+"\/>/.test(s2), 'columns carry widths from the weights')

// images: the embed's view, the svg and the media poster all landed as pictures
const s3 = all[2]
ok((s3.match(/<p:pic>/g) ?? []).length >= 2, 'media poster and embed view are pictures on slide 3')
ok((s2.match(/<p:pic>/g) ?? []).length >= 2, 'image and rasterised svg are pictures on slide 2')

// notes
const notesAll = notesXml.map(read).join('')
ok(/Title notes for slide one\./.test(notesAll), 'speaker notes survive')

// ---- 2b. hostile markup never reaches the zip --------------------------------
console.log('\nhostile svg')
const allText = list.map(read).join('\n')
ok(!/evil\.example|alert\(1\)|<script/i.test(allText), 'a script-carrying svg asset is refused; nothing of it is in the zip')
ok(list.some((p) => /^ppt\/media\/.*\.svg$/.test(rel(p))), 'clean svg artwork still travels as an svg picture under node')

// ---- 3. secrets -------------------------------------------------------------
console.log('\nsecrets')
// mapDeck is handed a copy with collab deleted by the editor; the rig proves
// that even a caller who forgets gets nothing through: map the RAW fixture.
const { pptx: leaky } = await mapDeck(JSON.parse(JSON.stringify(fixture)) as BentoDoc)
const leakBytes = Buffer.from(await leaky.write({ outputType: 'nodebuffer' }) as Uint8Array)
writeFileSync(join(work, 'leak.pptx'), leakBytes)
execFileSync('unzip', ['-q', '-o', join(work, 'leak.pptx'), '-d', join(work, 'y')])
const leakText = execFileSync('find', [join(work, 'y'), '-type', 'f'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(read).join('\n')
for (const secret of ['FIXTURE-ROOM-KEY-SECRET', 'FIXTURE-OWNER-PRIV-SECRET', 'FIXTURE-WRITER-PRIV-SECRET', 'wFIXTUREROOM']) {
  ok(!leakText.includes(secret), `${secret} appears nowhere in the zip`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(`pptx at ${file}`)
process.exit(failures ? 1 : 0)
