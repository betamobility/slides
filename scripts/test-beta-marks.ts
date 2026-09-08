#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Beta mark rig (plan 2026-09-08-002, U5, KTD13): one mark, every copy identical.
//
//   node scripts/test-beta-marks.ts
//
// WHAT THIS PROVES. The Beta mark — a charcoal rounded square carrying the
// cream "b" of the wordmark — is carried as a LITERAL in four places, because
// none of them can import it: `slides/index.html` is static (the favicon data
// URI and the CSS-drawn boot splash), `slides/src/beta/marks.ts` is the
// runtime copy for the About header, and `scripts/release.mjs` writes it to
// the site root as `favicon.svg`. Four literals drift; this rig is what stops
// them. So:
//
//   1. IDENTICAL. The favicon href decodes to the same bytes as the splash's
//      inline svg, the `marks.ts` export and the `favicon.svg` release.mjs
//      writes.
//   2. BETA'S. The svg carries Beta's charcoal and cream and none of the
//      upstream mark's colour literals — the tell of a half-done swap.
//   3. SMALL. Under 1 KB, so the data URI stays a cheap attribute in every
//      saved file, and free of double quotes, which would end the href early.
//   4. CARRIED. postbuild-compress.mjs lifts the `<link rel="icon">` tag into
//      the built shell by regex; that regex must still match, and the built
//      shell (when present) must carry the same tag.
//   5. LINKED. Both published pages (`site-src/landing.html`, `404.html`) link
//      `/favicon.svg`, and release.mjs's site assembly writes that file.

import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '../..')

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const read = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null)

// ---- the four copies --------------------------------------------------------
const indexHtml = read('slides/index.html') ?? ''
const marksTs = read('slides/src/beta/marks.ts')
const releaseMjs = read('scripts/release.mjs') ?? ''

// This is the SAME regex postbuild-compress.mjs uses to carry the tag into the
// shell (see §4); keep it verbatim.
const FAVICON_TAG = /<link rel="icon"[^>]*\/?>/
const linkTag = indexHtml.match(FAVICON_TAG)?.[0] ?? ''
const href = linkTag.match(/href="([^"]*)"/)?.[1] ?? ''
const DATA_PREFIX = 'data:image/svg+xml,'
const favicon = href.startsWith(DATA_PREFIX) ? decodeURIComponent(href.slice(DATA_PREFIX.length)) : ''

const splashDiv = indexHtml.match(/<div id="bento-splash"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? ''
const splash = splashDiv.match(/<div class="bs-mark">(<svg[\s\S]*?<\/svg>)<\/div>/)?.[1] ?? ''

// A double-quoted or template literal: the svg uses single quotes for its
// attributes so the data URI can sit inside href="…".
const marksExport = marksTs?.match(/export const BETA_MARK_SVG = (["`])([\s\S]*?)\1/)?.[2] ?? ''
const releaseLiteral = releaseMjs.match(/const BETA_MARK_SVG = (["`])([\s\S]*?)\1/)?.[2] ?? ''

console.log('§1 identical')
ok(favicon.startsWith('<svg') && favicon.endsWith('</svg>'), 'index.html favicon href is a data:image/svg+xml URI that decodes to an svg')
ok(splash.length > 0, 'index.html boot splash draws the mark as an inline svg inside .bs-mark')
ok(marksTs !== null, 'slides/src/beta/marks.ts exists')
ok(marksExport.length > 0, 'marks.ts exports BETA_MARK_SVG as a double-quoted or template literal')
ok(releaseLiteral.length > 0, 'release.mjs carries BETA_MARK_SVG as a double-quoted or template literal')
ok(favicon === splash, 'favicon and splash mark are byte-identical')
ok(favicon === marksExport, 'favicon and marks.ts BETA_MARK_SVG are byte-identical')
ok(favicon === releaseLiteral, 'favicon and the favicon.svg release.mjs writes are byte-identical')

console.log('\n§2 Beta\'s mark, not upstream\'s')
ok(/#1A1A1A/i.test(favicon), 'charcoal #1A1A1A is the square')
ok(/#F5F3EF/i.test(favicon), 'cream #F5F3EF is the b')
for (const c of ['#16273E', '#FF9E8A', '#5E7699', '#F0EBE0']) {
  ok(!new RegExp(c, 'i').test(favicon), `no upstream colour literal ${c}`)
}
ok(!/#16273E|#FF9E8A|#5E7699|#F0EBE0/i.test(splashDiv), 'the splash markup carries no upstream tile colours')
ok(/<path[^>]*\bd='/.test(favicon), 'the b is a path (the wordmark glyph), not a letter in a font the thumbnailer may lack')

console.log('\n§3 small and href-safe')
ok(Buffer.byteLength(favicon) > 0 && Buffer.byteLength(favicon) < 1024, `svg is under 1 KB (${Buffer.byteLength(favicon)} bytes)`)
ok(!favicon.includes('"'), 'svg has no double quotes (they would end href="…")')
ok(!/[<>#]/.test(href), 'data URI percent-encodes <, > and # (bare ones break the attribute or the fragment)')

console.log('\n§4 carried into the shell')
ok(FAVICON_TAG.test(indexHtml), 'postbuild-compress.mjs\'s favicon regex still matches the link tag')
ok(readFileSync(join(root, 'scripts/postbuild-compress.mjs'), 'utf8').includes('/<link rel="icon"[^>]*\\/?>/'),
  'postbuild-compress.mjs still uses the regex this rig mirrors (update both if it changes)')
ok(/<!-- BETA FORK[^>]*-->\s*\n\s*<link rel="icon"/.test(indexHtml), 'the favicon line is marked BETA FORK for the weekly upstream merge')
const shell = read('slides/dist-single/Bento_Slides.bento.html')
if (shell === null) {
  console.log('  ·     slides/dist-single/Bento_Slides.bento.html not built; skipping the built-shell check (CI builds first)')
} else {
  const shellHref = shell.match(FAVICON_TAG)?.[0].match(/href="([^"]*)"/)?.[1] ?? ''
  ok(shellHref === href, 'the built shell carries the same favicon href as index.html')
  ok(!/#16273E|%2316273E/i.test(shell.match(FAVICON_TAG)?.[0] ?? '#16273E'), 'the built shell\'s favicon has no upstream navy')
}

console.log('\n§5 the release site')
const landing = read('site-src/landing.html') ?? ''
const notFound = read('site-src/404.html') ?? ''
ok(landing.includes('<link rel="icon" href="/favicon.svg">'), 'site-src/landing.html links /favicon.svg')
ok(notFound.includes('<link rel="icon" href="/favicon.svg">'), 'site-src/404.html links /favicon.svg')
const owns = releaseMjs.slice(releaseMjs.indexOf('if (app.ownsSiteContent)'))
ok(owns.includes("join(site, 'favicon.svg')") && owns.includes('BETA_MARK_SVG'), 'release.mjs writes BETA_MARK_SVG to site/favicon.svg inside the ownsSiteContent block')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.log(`
The mark is one svg carried as four literals. Regenerate all four from the
same string (slides/src/beta/marks.ts is the readable one; the favicon is the
same string with <, > and # percent-encoded) and run this rig again.`)
  process.exit(1)
}
