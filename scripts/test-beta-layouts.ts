#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Beta layouts and templates rig (plan U4). Run as `node scripts/test-beta-layouts.ts`;
// it bundles itself with esbuild from slides/node_modules (validate.ts reaches
// render.ts, whose imports are extensionless) and re-executes the bundle.
//
// WHAT THIS PROVES
//   1. FIT. Every Beta layout element sits inside the 96 px side margins on
//      the 1280x720 canvas (right edge <= 1184, bottom <= 720); full-bleed
//      bands (x = 0, w = 1280) are the one exception and are named.
//   2. ROLES. Every text element in every layout carries a role and a
//      placeholder, so content rides across layouts (AE5).
//   3. TEMPLATES. Each built template parses, validates with no error and no
//      unknown key except `beta`, is `template: true`, carries no docId or
//      collab, and is under 2 MB.
//   4. AE5. Applying beta-chart-text to a slide built from beta-two-col keeps
//      every role-matched text and yields the chart.
//   5. MORPH. Footer chrome shares ids across content layouts.

import { readFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

if (import.meta.url.endsWith('.ts')) {
  const self = fileURLToPath(import.meta.url)
  const root = resolve(self, '../..')
  const esbuild = join(root, 'slides/node_modules/.bin/esbuild')
  if (!existsSync(esbuild)) { console.log(`  FAIL  ${esbuild} is missing: run "npm ci" in slides/ first`); process.exit(1) }
  const dir = join(tmpdir(), `beta-layouts-rig-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const bundle = join(dir, 'test-beta-layouts.mjs')
  execFileSync(esbuild, [self, '--bundle', '--platform=node', '--format=esm', '--log-level=warning', `--outfile=${bundle}`], { stdio: 'inherit' })
  const r = spawnSync(process.execPath, [bundle], { stdio: 'inherit', env: { ...process.env, BETA_RIG_ROOT: root } })
  rmSync(dir, { recursive: true, force: true })
  process.exit(r.status ?? 1)
}

type BentoDoc = import('../slides/src/model.ts').BentoDoc
type Slide = import('../slides/src/model.ts').Slide
const { validateDoc } = await import('../slides/src/validate.ts')
const { applyLayout, parseDoc } = await import('../slides/src/model.ts')
const { betaLayouts, betaTemplates, slideFrom, CANVAS } = await import('./lib/beta-layouts.mjs')

const root = process.env.BETA_RIG_ROOT ?? process.cwd()
let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const fragment = JSON.parse(readFileSync(join(root, 'beta/theme.json'), 'utf8'))
const layouts = betaLayouts(fragment.theme) as Slide[]
const NAMES = ['beta-title', 'beta-section', 'beta-two-col', 'beta-chart-text', 'beta-hero', 'beta-closing']

console.log('fit')
ok(layouts.map((l) => l.id).join() === NAMES.join(), `six layouts in plan order (${layouts.map((l) => l.id).join(', ')})`)
for (const ly of layouts) {
  const bad: string[] = []
  for (const e of ly.elements) {
    const fullBleed = e.x === 0 && e.w === CANVAS.width
    const right = e.x + e.w, bottom = e.y + e.h
    if (e.x < 0 || e.y < 0 || bottom > CANVAS.height) bad.push(`${e.id} bottom ${bottom}`)
    if (!fullBleed && (e.x < 96 || right > CANVAS.width - 96)) bad.push(`${e.id} right ${right}`)
  }
  ok(bad.length === 0, `${ly.id} fits 1280x720 inside 96 px margins${bad.length ? ': ' + bad.join(', ') : ''}`)
}

console.log('\nroles')
for (const ly of layouts) {
  const texts = ly.elements.filter((e) => e.type === 'text') as Array<{ id: string; role?: string; placeholder?: string; html?: string }>
  ok(texts.every((t) => t.role), `${ly.id}: every text element has a role`)
  ok(texts.every((t) => t.placeholder || (t.html && /\{\{/.test(t.html))), `${ly.id}: every text is a placeholder or a token-only chrome line`)
  const literal = ly.elements.filter((e) => !e.themeRefs && e.type !== 'chart')
  ok(literal.length === 0, `${ly.id}: every painted element records themeRefs provenance`)
}

console.log('\nmorph chrome')
const withFooter = layouts.filter((l) => l.elements.some((e) => e.id === 'beta-foot-page'))
ok(withFooter.length >= 3, `${withFooter.length} layouts share the footer ids (beta-foot-company, beta-foot-page)`)
ok(layouts.every((l) => l.elements.some((e) => e.id === 'beta-title-h')), 'every layout has a beta-title-h so titles morph slide to slide')

console.log('\ntemplates')
const built = betaTemplates(fragment) as Record<string, BentoDoc>
for (const name of ['client-pitch', 'insight-brief', 'workshop']) {
  const file = join(root, 'beta/templates', `${name}.bento.html`)
  ok(existsSync(file), `${name}.bento.html is built`)
  if (!existsSync(file)) continue
  const html = readFileSync(file, 'utf8')
  ok(statSync(file).size < 2 * 1024 * 1024, `${name}: under 2 MB (${Math.round(statSync(file).size / 1024)} KB), fonts are the only embedded assets`)
  const m = html.match(/<script type="application\/bento\+json" id="bento-doc">\s*([\s\S]*?)\s*<\/script>/)
  ok(!!m, `${name}: #bento-doc block is plaintext and regex-extractable`)
  const raw = JSON.parse(m![1])
  ok(raw.template === true && !('docId' in raw) && !('collab' in raw), `${name}: template:true, no docId, no collab in the file`)
  ok(JSON.stringify(raw) === JSON.stringify(built[name]), `${name}: the built file matches the library (rebuild after editing beta-layouts.mjs)`)
  const doc = parseDoc(m![1])!
  ok(!!doc && !doc.template && typeof doc.docId === 'string' && doc.docId.length > 0, `${name}: parseDoc instantiates it with a fresh docId and clears template`)
  const res = validateDoc(doc)
  type F = { code: string; severity: string; message: string; path?: string; slide?: string; element?: string }
  const findings = res.findings as F[]
  const errors = findings.filter((f) => f.severity === 'error')
  const tolerated = (f: F) => f.code === 'unknown-key' && f.path === 'beta' && !f.slide
  const warnings = findings.filter((f) => f.severity === 'warning' && !tolerated(f))
  const show = (fs: F[]) => fs.map((f) => `${f.code}@${f.slide ?? '-'}/${f.element ?? '-'}/${f.path ?? '-'}: ${f.message}`).join('\n          ')
  ok(errors.length === 0, `${name}: validate() reports no errors${errors.length ? '\n          ' + show(errors) : ''}`)
  ok(warnings.length === 0, `${name}: no warnings except unknown-key on beta${warnings.length ? '\n          ' + show(warnings) : ''}`)
  ok(findings.some(tolerated), `${name}: the beta provenance key is reported as the one tolerated unknown key`)
  ok(!res.findings.some((f: { code: string }) => f.code === 'font-not-embedded'), `${name}: every face is embedded`)
  ok(doc.slides.every((s) => s.elements.every((e) => e.type !== 'text' || ((e as { role?: string }).role ?? '') !== '')), `${name}: every text element on every slide carries a role`)
  ok(doc.slides.some((s) => s.elements.some((e) => e.type === 'text' && /\{\{company\}\}/.test((e as { html: string }).html))), `${name}: footers or bylines use {{company}}`)
  ok(doc.slides.some((s) => s.elements.some((e) => !!(e as { fx?: unknown }).fx)), `${name}: the cover has a motion moment`)
}

console.log('\nAE5: content rides across layouts by role')
const twoCol = slideFrom(layouts, 'beta-two-col', 's', { 'beta-title-h': 'Kept title', 'beta-col-right': 'Kept body' }) as Slide
const chartText = layouts.find((l) => l.id === 'beta-chart-text')!
const known = new Set(layouts.flatMap((l) => l.elements.map((e) => e.id)))
const applied = applyLayout(twoCol, chartText, known)
const title = applied.find((e) => e.id === 'beta-title-h') as { html: string }
const body = applied.find((e) => e.id === 'beta-col-right') as { html: string }
ok(title?.html === 'Kept title', 'title text kept its content')
ok(body?.html === 'Kept body', 'body text kept its content')
ok(applied.some((e) => e.type === 'chart'), 'the chart placeholder appears')
ok(applied.some((e) => e.id === 'beta-foot-page'), 'footer chrome comes from the new layout')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
