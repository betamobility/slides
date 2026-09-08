#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// beta-slides plugin rig (plan U7). Static claims only; the real proof is one
// deck authored end to end by Claude from a brief, recorded in the PR.
//
//   node scripts/test-beta-skill.mjs
//
// WHAT THIS PROVES
//   1. Every slides.betamobility.ai URL the skill names is a path the release
//      site publishes (scripts/apps.mjs + scripts/release.mjs), and every
//      template it names is a file in beta/templates/.
//   2. The plugin and marketplace manifests agree, and the plugin installs
//      as beta-slides@beta-slides.
//   3. The skill carries the inherited collab warning and the Beta rules
//      (palette slots via themeRefs, the as-of kicker, Export PPTX, the
//      visual check).
//   4. AE3, statically: a deck built per the rules carries a kicker-role
//      "Data as of <ISO date>" beside its refreshed figure, and every colour
//      literal on every element has a themeRefs entry.
//   5. docs/agents.md carries the "Beta build" section the skill points at.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APPS, SITE } from './apps.mjs'
import { betaTemplates } from './lib/beta-layouts.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (rel) => readFileSync(join(root, rel), 'utf8')
let checks = 0
let failures = 0
const ok = (cond, msg) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }

const skill = read('plugins/beta-slides/skills/beta-slides/SKILL.md')
const plugin = JSON.parse(read('plugins/beta-slides/.claude-plugin/plugin.json'))
const market = JSON.parse(read('.claude-plugin/marketplace.json'))

console.log('published paths')
// What the site serves for slides: the release tree, the guide at / and /<dir>/, and beta/templates/.
const published = new Set([
  `/releases/${APPS.slides.dir}/${APPS.slides.shell}`,
  `/releases/${APPS.slides.dir}/manifest.json`,
  '/agents.md',
  `/${APPS.slides.dir}/agents.md`,
  ...readdirSync(join(root, 'beta/templates')).filter((f) => f.endsWith('.bento.html')).map((f) => `/templates/${f}`),
])
const urls = [...new Set([...skill.matchAll(new RegExp(`${SITE.origin.replace(/[.]/g, '\\.')}(/[^\\s)"'\`]*)`, 'g'))].map((m) => m[1].replace(/[.,:;]+$/, '')))]
ok(urls.length >= 3, `the skill names ${urls.length} URL(s) under ${SITE.origin}`)
for (const u of urls) ok(published.has(u), `${u} is published by the release site`)
ok(!/bento\.page\/releases/.test(skill), 'the skill never downloads the upstream shell')
ok(/build-beta-templates\.mjs[\s\S]*join\(site, 'templates'\)/.test(read('scripts/release.mjs')), 'release.mjs publishes the Beta templates at /templates/')

console.log('\ntemplates')
const names = [...skill.matchAll(/templates\/([a-z-]+)\.bento\.html/g)].map((m) => m[1])
ok(names.length === 3, `the skill names three templates (${names.join(', ')})`)
for (const n of names) ok(existsSync(join(root, `beta/templates/${n}.bento.html`)), `${n}.bento.html exists in beta/templates/`)
const layoutNames = ['beta-title', 'beta-section', 'beta-two-col', 'beta-chart-text', 'beta-hero', 'beta-closing']
for (const l of layoutNames) ok(skill.includes(`\`${l}\``), `the skill names layout ${l}`)

console.log('\nmanifests')
ok(plugin.name === 'beta-slides', 'plugin.json name is beta-slides')
ok(market.name === 'beta-slides', 'marketplace name is beta-slides, so the install is beta-slides@beta-slides')
ok(market.plugins.some((p) => p.name === 'beta-slides' && p.source === './plugins/beta-slides'), 'marketplace registers ./plugins/beta-slides')
ok(!market.plugins.some((p) => p.name === 'bento-slides'), 'marketplace does not also offer bento-slides (same trigger phrases, wrong shell)')
ok(/^name: beta-slides$/m.test(skill) && /^description: >-$/m.test(skill), 'SKILL.md frontmatter has name and description')
ok(plugin.homepage === SITE.origin, `plugin homepage is ${SITE.origin}`)

console.log('\ninherited and added rules')
for (const [what, re] of [
  ['the collab warning', /ownerPriv[\s\S]*Tell the user before you continue/],
  ['palette slots via themeRefs', /themeRefs/],
  ['the no-hex rule', /No hex colours/i],
  ['the as-of kicker', /Data as of YYYY-MM-DD/],
  ['Export PPTX with the report', /Export PPTX[\s\S]*report/],
  ['the visual check', /look at every\s+slide/],
  ['meta.author', /meta\.author/],
  ['the fetch of the Beta agent guide', new RegExp(`Fetch ${SITE.origin.replace(/[.]/g, '\\.')}/agents\\.md`)],
  ['upstream by name', /bento-slides/],
]) ok(re.test(skill), `the skill carries ${what}`)

console.log('\nAE3, statically')
const fragment = JSON.parse(read('beta/theme.json'))
const deck = betaTemplates(fragment)['insight-brief']
const slide = deck.slides.find((s) => s.elements.some((e) => e.type === 'chart'))
const asOf = slide.elements.find((e) => e.role === 'kicker' && /Data as of/.test(e.placeholder ?? e.html ?? ''))
ok(!!asOf, 'the chart slide of insight-brief carries a Data as of kicker (role kicker)')
// the SHIPPED templates and starter never carry a live token in the as-of slot:
// '{{date}}' would re-date itself on every open, which is the opposite of a
// fetch date. Checked on the unmodified library output, before any rewrite.
const { betaStarter } = await import('./lib/beta-layouts.mjs')
const shipped = [...Object.values(betaTemplates(fragment)), betaStarter(fragment)]
const liveAsOf = shipped.flatMap((d) => d.slides.flatMap((s) => s.elements)).filter((e) => e.id === 'beta-asof' && /\{\{/.test(e.html ?? ''))
ok(liveAsOf.length === 0, `no shipped as-of kicker carries a live token (placeholder stays a placeholder)${liveAsOf.length ? ': ' + liveAsOf.length : ''}`)
// a deck per the rules: fill the kicker with an ISO date and check the shape
const filled = JSON.parse(JSON.stringify(deck))
for (const s of filled.slides) for (const e of s.elements) if (e.id === 'beta-asof') { e.html = 'Data as of 2026-09-03'; delete e.placeholder }
const stamped = filled.slides.flatMap((s) => s.elements).filter((e) => e.role === 'kicker' && /^Data as of \d{4}-\d{2}-\d{2}$/.test(e.html ?? ''))
ok(stamped.length >= 1, 'a refreshed figure is stamped "Data as of <ISO date>" on its slide')
const literalNoRef = filled.slides.flatMap((s) => s.elements).filter((e) => {
  const paints = ['color', 'fill', 'stroke'].filter((k) => typeof e[k] === 'string' && /^#/.test(e[k]))
  return paints.some((k) => !(e.themeRefs && e.themeRefs[k]))
})
ok(literalNoRef.length === 0, `every colour literal on every element has a themeRefs entry${literalNoRef.length ? ': ' + literalNoRef.map((e) => e.id).join(', ') : ''}`)

console.log('\nagent guide')
const guide = read('docs/agents.md')
ok(/^## Beta build/m.test(guide), 'docs/agents.md carries a "Beta build" section')
ok(/embed/.test(guide) && /themeRefs/.test(guide) && /Export PPTX|PPTX/.test(guide), 'the Beta build section covers embed, palette slots and the export report')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
