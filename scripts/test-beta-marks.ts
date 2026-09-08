#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Beta mark rig (plan 2026-09-08-002, U5, KTD13): the design system's own
// favicon and wordmark, verbatim, on every surface, with every copy identical.
//
//   node scripts/test-beta-marks.ts
//
// WHAT THIS PROVES. Beta's mark is NOT drawn here: the favicon PNGs and the
// recolorable wordmark are vendored from Tools/design-system into
// `beta/logo/` (as beta/fonts/ vendors the faces), and carried as literals
// where nothing can import a file — `slides/index.html` (the favicon as a
// base64 data URI, the boot splash as the inline wordmark) and
// `slides/src/beta/marks.ts` (the runtime copies for the About header). The
// release site links the PNGs by path and release.mjs copies them. Literals
// drift and vendored files rot; this rig is what stops both. So:
//
//   1. VENDORED. Every file in beta/logo/ hashes to the design-system
//      original it was copied from. The hashes are pinned HERE so a re-vendor
//      is a visible diff in this file, never a silent swap.
//   2. IDENTICAL. The favicon href in index.html decodes to the bytes of
//      beta/logo/favicon-32.png, and marks.ts carries the same href; the
//      splash's inline svg, marks.ts's wordmark and the `<svg>` element of
//      beta/logo/wordmark.svg are the same string.
//   3. UPSTREAM'S MARK IS GONE. No navy/peach svg favicon, no CSS tiles.
//   4. CARRIED. postbuild-compress.mjs lifts `<link rel="icon" …>` into the
//      built shell by regex; that regex must still match, and the built
//      shell (when present) must carry the same href.
//   5. LINKED. Both published pages carry the design system's three favicon
//      link tags and release.mjs's site assembly copies beta/logo/*.png to
//      site/logo/.

import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '../..')

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const text = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null)
const bytes = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p)) : null)
const sha256 = (b: Buffer | null) => (b ? createHash('sha256').update(b).digest('hex') : '')

// ---- §1 vendored ------------------------------------------------------------
// SHA-256 of Tools/design-system/public/logo/* at commit 599f91a0 (2026-09-08).
// Re-vendoring = update beta/logo/, these hashes and beta/logo/README.md together.
const VENDORED: Record<string, string> = {
  'favicon-16.png': 'c49874d383c60be29830abbc845c33a8a7685557906f59f48312aab164d6a091',
  'favicon-32.png': 'e3024c4c756c5fc5a5c54fcd8f2e2f0050adcdf5304ad373f19d7eb5f0df4e71',
  'apple-touch-icon.png': 'd91cb4b6f72f8a10c60a2bd5fd786f2bcf072ea52f0795243030b63fabc51a8b',
  'wordmark.svg': '8f000967871211325bec4e0db54d0ab31702ed309cc87a9caf0843b1ec8e4b7c',
}
console.log('§1 vendored from the design system, unchanged')
for (const [f, hash] of Object.entries(VENDORED)) {
  const b = bytes(`beta/logo/${f}`)
  ok(b !== null, `beta/logo/${f} exists`)
  ok(sha256(b) === hash, `beta/logo/${f} matches the design-system original (sha256 ${hash.slice(0, 12)}…)`)
}
const logoReadme = text('beta/logo/README.md') ?? ''
ok(/design-system/.test(logoReadme) && /599f91a0/.test(logoReadme), 'beta/logo/README.md names the design-system source and the commit it was copied at')
const png32 = bytes('beta/logo/favicon-32.png') ?? Buffer.alloc(0)
ok(png32.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'favicon-32.png is a PNG (magic bytes)')

// ---- §2 identical -----------------------------------------------------------
const indexHtml = text('slides/index.html') ?? ''
const marksTs = text('slides/src/beta/marks.ts')
const wordmarkFile = text('beta/logo/wordmark.svg') ?? ''
// The file carries an XML prolog and a comment the splash cannot inline; the
// `<svg>` element itself is what every copy must equal, verbatim.
const wordmarkEl = wordmarkFile.match(/<svg[\s\S]*<\/svg>/)?.[0] ?? ''

// This is the SAME regex postbuild-compress.mjs uses to carry the tag into the
// shell (see §4); keep it verbatim.
const FAVICON_TAG = /<link rel="icon"[^>]*\/?>/
const linkTag = indexHtml.match(FAVICON_TAG)?.[0] ?? ''
const href = linkTag.match(/href="([^"]*)"/)?.[1] ?? ''
const B64_PREFIX = 'data:image/png;base64,'
const faviconBytes = href.startsWith(B64_PREFIX) ? Buffer.from(href.slice(B64_PREFIX.length), 'base64') : Buffer.alloc(0)

const splashDiv = indexHtml.match(/<div id="bento-splash"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? ''
const splashSvg = splashDiv.match(/<div class="bs-mark">(<svg[\s\S]*?<\/svg>)<\/div>/)?.[1] ?? ''

const marksHref = marksTs?.match(/export const BETA_FAVICON_DATA_URI = (["'])([^"']*)\1/)?.[2] ?? ''
const marksWordmark = marksTs?.match(/export const BETA_LOGO_WORDMARK_SVG = `([\s\S]*?)`/)?.[1] ?? ''

console.log('\n§2 identical')
ok(linkTag.includes('type="image/png"') && linkTag.includes('sizes="32x32"'), 'index.html favicon is the 32×32 PNG link the design system prescribes')
ok(faviconBytes.length > 0, 'index.html favicon href is a data:image/png;base64 URI')
ok(faviconBytes.length > 0 && faviconBytes.equals(png32), 'index.html favicon decodes to the bytes of beta/logo/favicon-32.png')
ok(marksTs !== null, 'slides/src/beta/marks.ts exists')
ok(marksHref.length > 0 && marksHref === href, 'marks.ts BETA_FAVICON_DATA_URI is the same href as index.html')
ok(wordmarkEl.startsWith('<svg') && wordmarkEl.includes('currentColor'), 'beta/logo/wordmark.svg is the recolorable wordmark (currentColor)')
ok(splashSvg.length > 0, 'index.html boot splash draws the wordmark inline inside .bs-mark')
ok(splashSvg === wordmarkEl, 'splash wordmark is the <svg> element of beta/logo/wordmark.svg, byte for byte')
ok(marksWordmark.length > 0 && marksWordmark === wordmarkEl, 'marks.ts BETA_LOGO_WORDMARK_SVG is the same element, byte for byte')
ok(!marksWordmark.includes('${') && !marksWordmark.includes('</script'), 'the marks.ts template literal interpolates nothing and cannot close a script block')

// ---- §3 upstream's mark is gone ---------------------------------------------
console.log('\n§3 upstream\'s mark is gone')
ok(!/image\/svg\+xml/.test(linkTag), 'the favicon is no longer upstream\'s inline svg')
ok(!/16273E|FF9E8A|5E7699|F0EBE0/i.test(linkTag), 'no upstream colour literal in the favicon tag')
// Word-bounded: `.bs-bar` (the progress bar, which stays) contains "bs-b".
ok(!/\bbs-[abc]\b|bsTile|bsSheen/.test(indexHtml), 'the CSS tile mark (.bs-a/.bs-b/.bs-c, bsTile, bsSheen) is gone from the splash')
ok(!/#16273e|#ff9e8a|#5e7699|#f0ebe0/i.test(indexHtml.slice(indexHtml.indexOf('<body'))), 'the splash carries none of upstream\'s tile colours')

// ---- §4 carried into the shell ----------------------------------------------
console.log('\n§4 carried into the shell')
ok(FAVICON_TAG.test(indexHtml), 'postbuild-compress.mjs\'s favicon regex still matches the link tag')
ok((text('scripts/postbuild-compress.mjs') ?? '').includes('/<link rel="icon"[^>]*\\/?>/'),
  'postbuild-compress.mjs still uses the regex this rig mirrors (update both if it changes)')
ok(/<!-- BETA FORK[^>]*-->\s*\n\s*<link rel="icon"/.test(indexHtml), 'the favicon line is marked BETA FORK for the weekly upstream merge')
ok(Buffer.byteLength(href) < 1024, `the favicon data URI stays small (${Buffer.byteLength(href)} bytes; it rides in every saved deck)`)
const shell = text('slides/dist-single/Bento_Slides.bento.html')
if (shell === null) {
  console.log('  ·     slides/dist-single/Bento_Slides.bento.html not built; skipping the built-shell check (CI builds first)')
} else {
  const shellTag = shell.match(FAVICON_TAG)?.[0] ?? ''
  ok((shellTag.match(/href="([^"]*)"/)?.[1] ?? '') === href, 'the built shell carries the same favicon href as index.html')
  ok(shell.includes(splashSvg), 'the built shell carries the splash wordmark')
}

// ---- §5 the release site ----------------------------------------------------
console.log('\n§5 the release site')
const SITE_LINKS = [
  '<link rel="icon" type="image/png" sizes="16x16" href="/logo/favicon-16.png">',
  '<link rel="icon" type="image/png" sizes="32x32" href="/logo/favicon-32.png">',
  '<link rel="apple-touch-icon" sizes="180x180" href="/logo/apple-touch-icon.png">',
]
for (const page of ['site-src/landing.html', 'site-src/404.html']) {
  const html = text(page) ?? ''
  for (const tag of SITE_LINKS) ok(html.includes(tag), `${page} carries ${tag.match(/href="([^"]*)"/)?.[1]}`)
}
const releaseMjs = text('scripts/release.mjs') ?? ''
const owns = releaseMjs.slice(releaseMjs.indexOf('if (app.ownsSiteContent)'))
ok(owns.includes('beta/logo') && owns.includes("join(site, 'logo')"), 'release.mjs copies beta/logo/*.png to site/logo/ inside the ownsSiteContent block')
ok(!releaseMjs.includes('favicon.svg'), 'release.mjs no longer writes a hand-drawn favicon.svg')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.log(`
Beta's mark is the design system's, verbatim. Re-vendor from
Tools/design-system/public/logo/ into beta/logo/ (and pin the new hashes
above), regenerate the data URI in slides/index.html and slides/src/beta/marks.ts
from beta/logo/favicon-32.png, and inline the <svg> element of wordmark.svg into
the splash and marks.ts unchanged. Then run this rig again.`)
  process.exit(1)
}
