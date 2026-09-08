#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Beta About rig (plan 2026-09-08-002, U2, KTD2 + KTD3): the About dialog
// reads as Beta's, links only to Beta, and is quiet when the file is current.
//
//   node scripts/test-beta-about.ts
//
// WHAT THIS PROVES. `openAbout` stays upstream's; every Beta literal lives in
// `slides/src/beta/about.ts` and the editor calls into it. The dialog itself
// cannot be rendered in node (editor.ts pulls Moveable, Selecto and the
// canvas), so this rig checks the two things that can be checked here and
// leaves the third to the browser smoke:
//
//   1. STATIC. The three editor regions that carried upstream's links —
//      openAbout, openHelp, the post-update banner — contain no "bento.page"
//      and no "nyblnet", and each carries a `// BETA FORK` marker. The launch
//      auto-check (the setTimeout beside the update chip) only badges the
//      chip: its body never calls openAbout. CI runs this rig.
//   2. MODULE. The fragment module, bundled with esbuild from
//      slides/node_modules (about.ts reaches i18n.ts, whose imports are
//      extensionless): the header carries the design-system wordmark and the
//      product name; the promo names slides.betamobility.ai and the fork
//      repo; the "What's new" URL is the fork changelog with GitHub's heading
//      anchor for `## [<version>]`; the credits name the three OFL faces the
//      Beta deck embeds; and the update section's decision, with
//      checkForUpdates stubbed to current / newer / failed / not run, is one
//      line and no buttons when current, notes + buttons when newer, the
//      manual button only when the check failed.
//   3. BROWSER (not here). The rendered dialog on a current deck shows the
//      one-line status; that is the U2 browser smoke.

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

// ---- §1 static: the editor source ------------------------------------------
// Runs in the .ts phase, BEFORE bundling, so a missing fragment module or a
// leftover upstream link reports as a FAIL rather than an esbuild crash.
if (import.meta.url.endsWith('.ts')) {
  const self = fileURLToPath(import.meta.url)
  const root = resolve(self, '../..')
  const editorPath = join(root, 'slides/src/editor/editor.ts')
  const aboutPath = join(root, 'slides/src/beta/about.ts')
  const editor = readFileSync(editorPath, 'utf8')

  console.log('§1 editor.ts: Beta literals only, marked, dialog never opened by the launch check')
  ok(existsSync(aboutPath), 'slides/src/beta/about.ts exists (the fragment module KTD2 names)')

  /** The method body from its signature to the next member at class indent. */
  const region = (start: RegExp, name: string): string => {
    const m = start.exec(editor)
    if (!m) { ok(false, `${name}: signature found in editor.ts`); return '' }
    const from = m.index
    const rest = editor.slice(from + m[0].length)
    const next = /\n {2}(?:private |protected |public |async |[a-zA-Z_]+\()/.exec(rest)
    return editor.slice(from, next ? from + m[0].length + next.index : undefined)
  }
  const regions: Record<string, string> = {
    openAbout: region(/private openAbout\(/, 'openAbout'),
    openHelp: region(/private openHelp\(/, 'openHelp'),
    noticeIfJustUpdated: region(/private noticeIfJustUpdated\(/, 'noticeIfJustUpdated'),
  }
  for (const [name, src] of Object.entries(regions)) {
    ok(src.length > 200, `${name}: region sliced (${src.length} chars)`)
    ok(!/bento\.page/.test(src), `${name}: no "bento.page"`)
    ok(!/nyblnet/.test(src), `${name}: no "nyblnet"`)
    ok(/\/\/ BETA FORK/.test(src), `${name}: carries a // BETA FORK marker`)
  }
  ok(!/Fraunces|Instrument Sans/.test(regions.openAbout), 'openAbout: upstream typeface credits are gone')
  ok(/whatsNewUrl\(/.test(regions.openAbout) && /whatsNewUrl\(/.test(regions.noticeIfJustUpdated),
    'both "What’s new" links route through whatsNewUrl()')
  ok(!/Full guide at/.test(regions.openHelp), 'openHelp: the external guide line is dropped')

  // The launch auto-check: the setTimeout body beside the update chip. The
  // chip's own click handler (the line above it) legitimately opens About,
  // so the regex is scoped to the timer body only.
  const chip = /this\.updatesB = btn\([\s\S]*?setTimeout\(async \(\) => \{([\s\S]*?)\}, \d+\)/.exec(editor)
  ok(!!chip, 'launch auto-check block found beside the update chip')
  ok(!!chip && !/openAbout/.test(chip[1]), 'launch auto-check never opens the About dialog (badges the chip only)')

  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
  ok(ci.includes('scripts/test-beta-about.ts'), 'ci.yml runs this rig')

  if (!existsSync(aboutPath)) {
    console.log(`\n${checks} checks, ${failures} failed — fragment module missing, module checks skipped`)
    process.exit(1)
  }

  // ---- bundle and run §2 ----------------------------------------------------
  const esbuild = join(root, 'slides/node_modules/.bin/esbuild')
  if (!existsSync(esbuild)) { console.log(`  FAIL  ${esbuild} is missing: run "npm ci" in slides/ first`); process.exit(1) }
  const dir = join(tmpdir(), `beta-about-rig-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const bundle = join(dir, 'test-beta-about.mjs')
  execFileSync(esbuild, [self, '--bundle', '--platform=node', '--format=esm', '--log-level=warning', `--outfile=${bundle}`], { stdio: 'inherit' })
  const r = spawnSync(process.execPath, ['--no-warnings', bundle], { stdio: 'inherit', env: { ...process.env, BETA_RIG_ROOT: root } })
  rmSync(dir, { recursive: true, force: true })
  console.log(`\n§1: ${checks} checks, ${failures} failed`)
  process.exit(failures || (r.status ?? 1) ? 1 : 0)
}

// ---- §2 module: the fragment ---------------------------------------------------
// a localStorage the kernel's storage.ts (behind i18n) can talk to
const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
}

const about = await import('../slides/src/beta/about.ts')
const { BETA_LOGO_WORDMARK_SVG } = await import('../slides/src/beta/marks.ts')
type UpdateCheck = import('../kernel/src/update.ts').UpdateCheck

console.log('§2 slides/src/beta/about.ts')

// header
const head = about.aboutHeaderHtml('2026.9.2', 1)
ok(head.includes(BETA_LOGO_WORDMARK_SVG), 'header carries the design-system wordmark (marks.ts, verbatim)')
ok(head.includes('beta/slides'), 'header names the product "beta/slides"')
ok(head.includes('2026.9.2') && head.includes('format v1'), 'header shows app + format version')
ok(head.includes('href="https://slides.betamobility.ai"'), 'header links to slides.betamobility.ai')
ok(head.includes('class="ed-about-logo"'), 'header keeps upstream\'s .ed-about-logo hook (styles unchanged)')
ok(!/bento\.page|nyblnet/.test(head), 'header: no upstream links')
ok(!/bento\.page|nyblnet/.test(about.aboutHeaderTitle()), 'header title: no upstream links')

// promo
const promo = about.aboutPromoHtml()
ok(promo.includes('https://slides.betamobility.ai'), 'promo links slides.betamobility.ai')
ok(promo.includes('https://github.com/betamobility/slides'), 'promo links the fork repository')
ok(!/bento\.page|nyblnet|New to Bento/.test(promo), 'promo: no upstream copy')

// what's new
ok(about.changelogAnchor('[2026.9.2]') === '202692', 'anchor: "[2026.9.2]" → "202692"')
ok(about.changelogAnchor('[2026.10.11]') === '20261011', 'anchor: "[2026.10.11]" → "20261011"')
ok(about.changelogAnchor('Hello World — 1.0') === 'hello-world--10', 'anchor: lowercase, punctuation dropped, spaces → hyphens')
ok(about.changelogAnchor('[2026.9.1] — 2026-09-08') === '202691--2026-09-08', 'anchor: a dated heading folds the date in, which is why the link avoids anchors')
ok(about.whatsNewUrl('2026.9.2') === 'https://github.com/betamobility/slides/blob/main/CHANGELOG.md',
  `whatsNewUrl("2026.9.2") is the changelog top (newest release first) = ${about.whatsNewUrl('2026.9.2')}`)
ok(about.whatsNewUrl('2026.10.11') === about.whatsNewUrl('2026.9.2'), 'whatsNewUrl is the same for every version')
// The real CHANGELOG headings carry a date after an em dash; the anchor of
// such a heading differs from the version-only anchor the plan specifies.
// Reported, not asserted: U9 owns the heading format.
{
  const real = /^## \[(\d{4}\.\d+\.\d+)\][^\n]*/m.exec(readFileSync(join(process.env.BETA_RIG_ROOT ?? resolve(fileURLToPath(import.meta.url), '../..'), 'CHANGELOG.md'), 'utf8'))
  if (real) {
    const a = about.changelogAnchor(real[0].slice(3))
    console.log(`  note  CHANGELOG heading "${real[0].slice(3)}" anchors as #${a}; whatsNewUrl gives #${about.changelogAnchor(`[${real[1]}]`)}`)
  }
}

// credits
const credits = about.aboutCreditsText()
ok(credits.includes('reveal.js, Moveable, Selecto (MIT)'), 'credits keep the MIT libraries')
ok(credits.includes('Inter, Playfair Display and DM Mono typefaces (OFL-1.1)'), 'credits name Inter, Playfair Display and DM Mono')
ok(!/Fraunces|Instrument Sans/.test(credits), 'credits drop upstream\'s faces')

// update section decision
const release = { version: '2026.9.3', url: 'x', sha256: 'y', sig: 'z', notes: '• one\n• two' } as any
const cur = about.updateStatus({ status: 'current', version: '2026.9.2' } as UpdateCheck)
ok(cur.line === 'Up to date, 2026.9.2', `current: one line "${cur.line}"`)
ok(!cur.showCheck && !cur.showActions, 'current: no manual button, no update buttons')

const upd = about.updateStatus({ status: 'update', release } as UpdateCheck)
ok(upd.showActions, 'newer: the notes + update buttons render (upstream branch)')
ok(upd.showCheck, 'newer: the manual button stays')

const err = about.updateStatus({ status: 'error', message: 'offline' } as UpdateCheck)
ok(/did not run/.test(err.line) && err.line.includes('offline'), `failed: says the check did not run — "${err.line}"`)
ok(err.showCheck && !err.showActions, 'failed: manual button only')

const none = about.updateStatus(undefined)
ok(none.line.length > 0 && none.showCheck && !none.showActions, `not run (auto-check off): "${none.line}", manual button only`)

for (const [k, v] of Object.entries({ head, promo, credits, cur: cur.line, err: err.line, none: none.line })) {
  ok(!/bento\.page|nyblnet/.test(v), `${k}: no "bento.page" / "nyblnet"`)
}

console.log(`\n§2: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
