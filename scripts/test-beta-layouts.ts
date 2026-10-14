#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Beta layouts and templates rig (plan U4). Run as `node scripts/test-beta-layouts.ts`;
// it bundles itself with esbuild from slides/node_modules (validate.ts reaches
// render.ts, whose imports are extensionless) and re-executes the bundle.
//
// WHAT THIS PROVES (since 2026-10-14: the layouts are the general template's,
// on design system v1.5.0; scripts/test-beta-general.ts checks their 64 px
// grid, type sizes and logo placement)
//   1. ONE SOURCE. betaLayouts() is the general template's 35 layouts, and
//      every element sits on the 1280x720 canvas.
//   2. ROLES. Every text element in every layout carries a role and a
//      placeholder, so content rides across layouts (AE5); painted text and
//      shapes record themeRefs provenance.
//   3. TEMPLATES. Each built template parses, validates with no error or
//      warning, is `template: true`, carries no docId or collab, is under 2 MB,
//      carries the wordmark on every slide, and no slide number or live token.
//   4. AE5. Applying the chart layout to a slide built from two-columns keeps
//      the role-matched text and yields the chart.
//   5. The starter (compiled into the shell) is built the same way and current.

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
const { generalTemplate } = await import('./lib/beta-general.mjs')

console.log('one source')
ok(JSON.stringify(layouts) === JSON.stringify(generalTemplate().layouts), `the deck layouts are the general template's (${layouts.length})`)
ok(layouts.length === 35, `35 layouts (${layouts.length})`)
for (const ly of layouts) {
  const bad = ly.elements.filter((e) => e.x < 0 || e.y < 0 || e.x + e.w > CANVAS.width + 0.01 || e.y + e.h > CANVAS.height + 0.01).map((e) => e.id)
  ok(bad.length === 0, `${ly.id} sits on the 1280x720 canvas${bad.length ? ': ' + bad.join(', ') : ''}`)
}

console.log('\nroles')
for (const ly of layouts) {
  const texts = ly.elements.filter((e) => e.type === 'text') as Array<{ id: string; role?: string; placeholder?: string; html?: string }>
  ok(texts.every((t) => t.role), `${ly.id}: every text element has a role`)
  ok(texts.every((t) => t.placeholder || t.role === 'list-marker' || (t.html && /\{\{/.test(t.html))), `${ly.id}: every text is a placeholder, a list marker or a token-only line`)
  const literal = ly.elements.filter((e) => (e.type === 'text' || e.type === 'shape') && !e.themeRefs)
  ok(literal.length === 0, `${ly.id}: painted text and shapes record themeRefs provenance`)
}

console.log('\nmorph chrome')
ok(layouts.every((l) => l.elements.some((e) => e.id === 'beta-logo')), 'every layout carries the wordmark under one id, so it holds still across slides')
ok(layouts.filter((l) => l.id !== 'sans-statement').every((l) => l.elements.some((e) => e.id === 'title')), 'every layout but the sans statement has a `title`, so titles carry across')

console.log('\ndefault transition')
ok(layouts.every((l) => l.transition === 'none'), `every layout's transition is none (${layouts.map((l) => l.transition).join(', ')})`)
for (const [name, doc] of Object.entries(betaTemplates(fragment) as Record<string, BentoDoc>)) {
  ok(doc.slides.every((s) => s.transition === 'none'), `${name}: every slide's transition is none`)
}

console.log('\ntemplates')
const built = betaTemplates(fragment) as Record<string, BentoDoc>
for (const name of ['blank', 'client-pitch', 'insight-brief', 'workshop']) {
  const file = join(root, 'beta/templates', `${name}.bento.html`)
  ok(existsSync(file), `${name}.bento.html is built`)
  if (!existsSync(file)) continue
  const html = readFileSync(file, 'utf8')
  ok(statSync(file).size < 2 * 1024 * 1024, `${name}: under 2 MB (${Math.round(statSync(file).size / 1024)} KB): fonts and a placeholder image, no sample photographs`)
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
  const warnings = findings.filter((f) => f.severity === 'warning')
  const show = (fs: F[]) => fs.map((f) => `${f.code}@${f.slide ?? '-'}/${f.element ?? '-'}/${f.path ?? '-'}: ${f.message}`).join('\n          ')
  ok(errors.length === 0, `${name}: validate() reports no errors${errors.length ? '\n          ' + show(errors) : ''}`)
  // the beta provenance key is in the format now (model.ts BentoDoc.beta), so it is no longer a tolerated unknown key
  ok(warnings.length === 0, `${name}: no warnings at all${warnings.length ? '\n          ' + show(warnings) : ''}`)
  ok(!!(doc as { beta?: { designSystem?: string } }).beta?.designSystem, `${name}: carries the beta provenance stamp`)
  ok(!res.findings.some((f: { code: string }) => f.code === 'font-not-embedded'), `${name}: every face is embedded`)
  ok(doc.slides.every((s) => s.elements.every((e) => e.type !== 'text' || ((e as { role?: string }).role ?? '') !== '')), `${name}: every text element on every slide carries a role`)
  ok(doc.slides.every((s) => s.elements.some((e) => e.id === 'beta-logo')), `${name}: the wordmark is on every slide`)
  ok(!doc.slides.some((s) => s.elements.some((e) => e.type === 'text' && /\{\{page/.test((e as { html: string }).html))), `${name}: no slide numbers (design system v1.5.0)`)
}

console.log('\nstarter')
const { betaStarter } = await import('./lib/beta-layouts.mjs')
const starter = betaStarter(fragment) as BentoDoc & { template?: boolean }
ok(!starter.template && !('docId' in starter) && !('collab' in starter), 'the Beta starter is not a template and carries no docId or collab')
ok(starter.slides.length >= 3 && starter.layouts!.length === 35, `the starter has ${starter.slides.length} slides and all 35 layouts`)
const sres = validateDoc(JSON.parse(JSON.stringify({ ...starter, docId: 'starter' })) as BentoDoc)
ok(!sres.findings.some((f: { severity: string }) => f.severity === 'error'), 'the starter validates with no errors')
ok(starter.slides.every((s) => s.transition === 'none'), "every starter slide's transition is none")
const gen = readFileSync(join(root, 'slides/src/starter/beta.generated.ts'), 'utf8')
ok(gen.includes(JSON.stringify(JSON.stringify(starter).replace(/</g, '\\u003c'))), 'slides/src/starter/beta.generated.ts is current (run build-beta-starter.mjs)')

console.log('\nAE5: content rides across layouts by role')
const twoCol = slideFrom(layouts, 'two-columns', 's', { title: 'Kept title', left: 'Kept body' }) as Slide
const chartLayout = layouts.find((l) => l.id === 'chart')!
const known = new Set(layouts.flatMap((l) => l.elements.map((e) => e.id)))
const applied = applyLayout(twoCol, chartLayout, known)
const title = applied.find((e) => e.id === 'title') as { html: string }
ok(title?.html === 'Kept title', 'title text kept its content')
ok(applied.some((e) => e.type === 'text' && (e as { html: string }).html === 'Kept body'), 'body text kept its content')
ok(applied.some((e) => e.type === 'chart'), 'the chart placeholder appears')
ok(applied.some((e) => e.id === 'beta-logo'), 'the wordmark comes with the new layout')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
