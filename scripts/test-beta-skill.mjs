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
//   6. Runtime slides (docs/plans/2026-09-14-001, U8): both files carry the
//      section, the splice tool and the ownership rule; the skill has no bare
//      replace recipe left; every bento:* message, budget and asset type the
//      docs name is the one the code uses.

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
// The site's own host also serves the deck store now (2026-09-10 plan, U5),
// so a URL the skill names is legitimate if the site publishes it as a file
// OR the worker answers it as a route. The routes are enumerated, not
// pattern-matched loosely, so this stays the check it was: a skill pointing
// at a URL nothing serves is still a failure.
const storeRoute = (u) => u === '/'
  || u === '/new'
  || u === '/api/decks'
  || u === '/api/harness/decks'
  || /^\/api\/harness\/decks\/(<id>|[0-9A-Za-z]{10})$/.test(u)
  || /^\/d\/(<id>|[0-9A-Za-z]{10})$/.test(u)
  || /^\/api\/harness\/decks\/(<id>|[0-9A-Za-z]{10})\/assets\/(<name>|[A-Za-z0-9][A-Za-z0-9._-]{0,79})$/.test(u)
  || /^\/d\/(<id>|[0-9A-Za-z]{10})\/assets\/(<name>|[A-Za-z0-9][A-Za-z0-9._-]{0,79})$/.test(u)
const serves = (u) => published.has(u) || storeRoute(u)
// The predicate's own negative case, so a later widening cannot quietly turn
// this into a check that passes for anything.
ok(!serves('/api/harness/nowhere') && !serves('/releases/slides/nope.json') && !serves('/d/')
  && !serves('/d/<id>/assets/') && !serves('/api/harness/decks/<id>/assets/a/b'),
  'a URL the site neither publishes nor routes is still refused')
const urls = [...new Set([...skill.matchAll(new RegExp(`${SITE.origin.replace(/[.]/g, '\\.')}(/[^\\s)"'\`]*)`, 'g'))].map((m) => m[1].replace(/[.,:;]+$/, '')))]
ok(urls.length >= 3, `the skill names ${urls.length} URL(s) under ${SITE.origin}`)
for (const u of urls) ok(serves(u), `${u} is published or routed by ${SITE.origin}`)
// R6: the host the skill publishes to is the host the app is configured with.
const configuredStore = /storeHost:\s*'([^']*)'/.exec(read('slides/src/main.ts'))?.[1]
ok(configuredStore === SITE.origin, `the skill's harness host is the app's storeHost (${configuredStore})`)
ok(/\/api\/harness\/decks/.test(skill), 'the skill says how a harness publishes a deck')
ok(/CF-Access-Client-Id/.test(skill) && /CF-Access-Client-Secret/.test(skill), 'and names the service-token headers it needs')
ok(!/CF_ACCESS_CLIENT_SECRET\s*=\s*\S/.test(skill), 'without carrying a secret of its own')
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

console.log('\nruntime slides')
ok(/^## Runtime slides$/m.test(skill), 'the skill carries a "Runtime slides" section')
ok(/^### Runtime slides$/m.test(guide), 'docs/agents.md carries a "Runtime slides" subsection')
ok(/^### Motion without a runtime slide$/m.test(guide), 'docs/agents.md carries "Motion without a runtime slide"')
for (const [name, text] of [['the skill', skill], ['docs/agents.md', guide]]) {
  ok(/splice\.mjs --create <projectDir>/.test(text) && /splice\.mjs <deckId> <projectDir>/.test(text), `${name} gives both splice commands`)
  ok(/Claude owns content, the UI owns geometry/.test(text), `${name} states the ownership rule`)
  ok(/412/.test(text) && /owner probably has the deck open/.test(text), `${name} says what a 412 means`)
  // A typo fix on a deck with no runtime slide is the common case; the tool is
  // the only documented way to make it, so the command must be there.
  ok(/splice\.mjs <deckId> --edits edits\.json/.test(text), `${name} gives the edits-only command`)
  ok(/insertAfter/.test(text) && /"end"/.test(text), `${name} documents insertAfter and "end" for a new runtime slide`)
  ok(!/needs at least one scene\s+folder|cannot\s+run with `--edits` alone/.test(text), `${name} no longer says edits need a scene`)
  // The review follow-ups: each is a behaviour an agent can only use or
  // recover from if the doc it reads names it.
  ok(/splice\.mjs <deckId> --title "<title>"/.test(text), `${name} gives the --title rename command`)
  ok(/--skip-url-check/.test(text) && /X-Frame-Options/.test(text) && /frame-ancestors/.test(text), `${name} documents the url framing check and --skip-url-check`)
  ok(/presenter\s+values\s+dropped/.test(text), `${name} points at the dropped presenter values line`)
  ok(/times? out/.test(text), `${name} says store requests time out`)
  ok(/elements\s+other\s+than\s+its\s+still/.test(text), `${name} documents the extra-elements refusal`)
  ok(/same\s+(asset\s+)?name[^.]*different\s+bytes/.test(text), `${name} documents the cross-scene asset name rule`)
}
// The replace recipe U1 wrote is gone: splice.mjs is the only way to change a
// deck in the store. [^`] keeps each match inside one code block.
ok(!/curl\b[^`]*?-X\s*PUT[^`]*?\/api\/harness\/decks\/<id>/.test(skill), 'the skill has no bare curl -X PUT to /api/harness/decks/<id>')
ok(/curl[^`]*\/api\/harness\/decks(?![/\w])/.test(skill), 'and keeps the curl create recipe')
const presentSrc = read('slides/src/runtime-present.ts')
const codeTypes = new Set([...presentSrc.matchAll(/bento:[a-z]+/g)].map((m) => m[0]))
for (const [name, text] of [['the skill', skill], ['docs/agents.md', guide]]) {
  const named = new Set([...text.matchAll(/bento:[a-z]+/g)].map((m) => m[0]).filter((t) => t !== 'bento:slides'))
  const unknown = [...named].filter((t) => !codeTypes.has(t))
  ok(named.size >= 7 && unknown.length === 0, `every bento:* message ${name} names is one runtime-present.ts speaks (${named.size} named${unknown.length ? ', unknown: ' + unknown.join(', ') : ''})`)
}
const model = read('slides/src/model.ts')
for (const [k, label, bytes] of [['RUNTIME_SRC_BUDGET', '256 KB', 256 * 1024], ['RUNTIME_STILL_BUDGET', '200 KB', 200 * 1024], ['RUNTIME_ASSET_BUDGET', '16 MB', 16 * 1024 * 1024]]) {
  const m = new RegExp(`${k} = ([\\d\\s*]+)`).exec(model)
  const got = m ? m[1].split('*').reduce((a, n) => a * Number(n.trim()), 1) : NaN
  ok(got === bytes && skill.includes(label) && guide.includes(label), `${k} is ${label} in model.ts, the skill and the guide`)
}
const worker = read('server/deck-store/src/worker.js')
for (const t of ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/json', 'text/csv']) {
  ok(worker.includes(`'${t}'`) && guide.includes(t), `asset type ${t} is accepted by the store and named in the guide`)
}
ok(!/<image href="data:image\/png/.test(guide), 'the Embed section no longer recommends a raster screenshot as the view')

console.log('\nthree kinds of slide')
ok(/^## Pick the kind of slide first$/m.test(skill), 'the skill opens with a chooser between the three kinds of slide')
ok(/^## Native slides$/m.test(skill) && /^## Code slides$/m.test(skill), 'the skill carries "Native slides" and "Code slides" sections')
// The splice tool does not accept a code element's content; the skill must not
// promise it does (CONTENT_KEY in splice.mjs is the authority).
const splice = read('plugins/beta-slides/scripts/splice.mjs')
const codeKey = /CONTENT_KEY = \{[^}]*\bcode:/.test(splice)
ok(codeKey || !/`content` \(code\)|html \| content \| src/.test(skill), `the skill names content as an edits key only if splice.mjs accepts it (splice accepts it: ${codeKey})`)
{
  // Every language id the skill offers is one the tokenizer knows. Derived
  // from the source, never restated: an unknown id silently renders as js.
  const tokenize = read('kernel/src/tokenize.ts')
  const langs = new Set([...tokenize.matchAll(/^  ([a-z]+): \{/gm)].map((m) => m[1]).concat(['diff', 'md']))
  // The bullet that offers the ids: from `grammarName` to the next bullet.
  const para = /`grammarName`[^]*?\n- /.exec(skill.slice(skill.indexOf('## Code slides')))?.[0] ?? ''
  // `bash` is named only as the id NOT to use.
  const offered = [...para.matchAll(/`([a-z]+)`/g)].map((m) => m[1]).filter((w) => w !== 'bash')
  const unknown = offered.filter((w) => !langs.has(w))
  ok(offered.length >= 15 && unknown.length === 0, `every grammarName the skill offers is a tokenizer language (${offered.length} named${unknown.length ? ', unknown: ' + unknown.join(', ') : ''})`)
}

console.log('\nporting a reveal.js deck')
ok(/^### Porting a reveal\.js deck/m.test(skill), 'the skill carries "Porting a reveal.js deck"')
const skillDir = 'plugins/beta-slides/skills/beta-slides'
for (const f of ['reveal/shim.js', 'reveal/harness.html', 'reveal/reset.css', 'reveal/reveal.css']) {
  ok(existsSync(join(root, skillDir, f)) && skill.includes(f.replace('reveal/reset.css', 'reveal/reset.css')), `${f} ships in the skill folder${/\.js$|harness/.test(f) ? ' and the skill names it' : ''}`)
}
ok(/MIT licensed/.test(read(`${skillDir}/reveal/reveal.css`)), "the vendored reveal.css keeps reveal.js's licence header")
for (const f of ['reveal/shim.js', 'reveal/harness.html']) {
  const named = new Set([...read(`${skillDir}/${f}`).matchAll(/bento:[a-z]+/g)].map((m) => m[0]))
  const unknown = [...named].filter((t) => !codeTypes.has(t))
  ok(named.size >= 4 && unknown.length === 0, `every bento:* message ${f} speaks is one runtime-present.ts speaks (${named.size}${unknown.length ? ', unknown: ' + unknown.join(', ') : ''})`)
}
{
  // steps = fragment groups + 1 is what moveStep/enterStep walk: 0 <= index < steps.
  const present = read('slides/src/runtime-present.ts')
  ok(/to >= 0 && to < steps/.test(present) && /steps - 1/.test(present), 'the shell walks steps 0..steps-1, so N fragment groups need steps = N + 1')
  ok(/number of fragment groups plus one/.test(skill), 'the skill says steps = fragment groups + 1')
}
const stillNames = /\['still\.png', 'still\.svg'\]/.test(splice)
ok(stillNames && /`still\.png` or\s+`still\.svg`, nothing else/.test(skill), 'the port recipe names the only still files splice.mjs reads')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
