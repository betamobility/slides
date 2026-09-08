#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Turn beta/tokens.json into beta/theme.json: the theme, fonts and assets
// fragment every Beta deck carries.
//
//   node scripts/build-beta-theme.mjs
//   node scripts/build-beta-theme.mjs --tokens <path> --out <path>
//
// WHAT THIS DOES. The design system is the source of truth for colour and
// type; Bento's `theme` is where a deck reads them from. This script is the
// only bridge, and it is a pure function of two inputs: the tokens file and
// the woff2 files in beta/fonts/. No timestamps, no environment: the same
// inputs give byte-identical output, so the committed theme.json can be diffed
// and the rig can prove it is fresh.
//
// Every token the mapping needs is read through `need()`, which collects
// missing paths and exits non-zero naming all of them. A design-system rename
// must fail here, loudly, rather than ship a deck with a fallback colour that
// looks almost right.
//
// SLOT MAPPING (slides/src/palette.ts PALETTE_SLOTS). bg1/tx1/accent1 are the
// canonical `theme.background/color/accent`; paletteOf() reads them from
// there and only the remaining nine slots live in `theme.palette`.
//
//   bg1  cream          tx1  charcoal        accent1  slides.accent1 (sage)
//   bg2  cream-dark     tx2  charcoal-light  accent2..6  slides.accent2..6
//   hlink  slides.link  folHlink  slides.folLink
//
// FONTS. Fontsource ships static instances, so Inter is two files (400, 700)
// and the fragment declares four `fonts[]` entries for three families. Each
// becomes an @font-face at boot with its bytes in `assets` as a data: URI.
// DM Mono is embedded and available to any element that names it, but the
// slides theme has no mono slot (only fontFamily, headingFamily and
// table.fontFamily), so nothing in `theme` points at it.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const betaDir = join(root, 'beta')

const args = process.argv.slice(2)
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const tokensPath = resolve(flag('--tokens') ?? join(betaDir, 'tokens.json'))
const outPath = resolve(flag('--out') ?? join(betaDir, 'theme.json'))
const fontsDir = join(betaDir, 'fonts')

if (!existsSync(tokensPath)) {
  console.error(`build-beta-theme: ${tokensPath} does not exist (run scripts/beta-sync-tokens.mjs)`)
  process.exit(1)
}
const tokens = JSON.parse(readFileSync(tokensPath, 'utf8'))

// ---- token access ------------------------------------------------------------
const missing = []
function need(path) {
  let cur = tokens
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object' || !(seg in cur)) { missing.push(path); return undefined }
    cur = cur[seg]
  }
  if (cur === undefined || cur === null || cur === '') { missing.push(path); return undefined }
  return cur
}
const HEX6 = /^#[0-9a-f]{6}$/i
/** A palette slot must be a six-digit hex: palette.ts shifts hex only. */
function hex(path) {
  const v = need(path)
  if (v === undefined) return undefined
  if (!HEX6.test(v)) { missing.push(`${path} (not a #RRGGBB colour: ${JSON.stringify(v)})`); return undefined }
  return v.toUpperCase()
}

// ---- colours ---------------------------------------------------------------
const cream = hex('colors.core.cream.value')
const creamDark = hex('colors.core.cream-dark.value')
const charcoal = hex('colors.core.charcoal.value')
const charcoalLight = hex('colors.core.charcoal-light.value')
const accent = {}
for (let i = 1; i <= 6; i++) accent[i] = hex(`slides.accent${i}.value`)
const link = hex('slides.link.value')
const folLink = hex('slides.folLink.value')
// Chart series are SLOT NAMES (accent1..accent6), never a second copy of the
// hex values: a moved accent must move its series with it.
const chartSlots = need('slides.chartPalette')
let chartPalette = []
if (chartSlots !== undefined) {
  if (!Array.isArray(chartSlots) || chartSlots.length < 2) missing.push('slides.chartPalette (expected an array of accent slot names)')
  else {
    for (const s of chartSlots) {
      const m = /^accent([1-6])$/.exec(String(s))
      if (!m) { missing.push(`slides.chartPalette entry ${JSON.stringify(s)} (expected accent1..accent6)`); continue }
      if (accent[m[1]] !== undefined) chartPalette.push(accent[m[1]])
    }
  }
}
const table = {
  headerBg: need('slides.table.headerBg'),
  headerColor: need('slides.table.headerColor'),
  zebra: need('slides.table.zebra'),
  borderColor: need('slides.table.borderColor'),
  color: need('slides.table.color'),
}

// ---- type ------------------------------------------------------------------
// The design system's stacks are unquoted ("Playfair Display, Georgia, serif").
// docs/agents.md asks for a full stack with the embedded family quoted, and
// `validate()` matches the FIRST family against fonts[] by name, so the first
// family is kept verbatim and the fallbacks are Bento's system-neutral ones.
function firstFamily(stack) { return stack.split(',')[0].trim().replace(/^['"]|['"]$/g, '') }
const displayStack = need('fonts.display.stack')
const sansStack = need('fonts.sans.stack')
const monoStack = need('fonts.mono.stack')

const version = need('version')
const sha = need('_source.sha')

if (missing.length) {
  console.error(`build-beta-theme: ${missing.length} required token path(s) missing in ${tokensPath}:`)
  for (const m of missing) console.error(`  ${m}`)
  process.exit(1)
}

const displayFamily = firstFamily(displayStack)   // Playfair Display
const sansFamily = firstFamily(sansStack)         // Inter
const monoFamily = firstFamily(monoStack)         // DM Mono

// ---- fonts -----------------------------------------------------------------
// asset key "font-<name>" is beta/fonts/<name>.woff2; the rig checks that.
const FONT_FILES = [
  { family: sansFamily, weight: '400', file: 'inter-latin-400-normal' },
  { family: sansFamily, weight: '700', file: 'inter-latin-700-normal' },
  { family: displayFamily, weight: '700', file: 'playfair-display-latin-700-normal' },
  { family: monoFamily, weight: '400', file: 'dm-mono-latin-400-normal' },
]
const assets = {}
const fonts = []
const lost = []
for (const f of FONT_FILES) {
  const p = join(fontsDir, `${f.file}.woff2`)
  if (!existsSync(p)) { lost.push(p); continue }
  const bytes = readFileSync(p)
  if (bytes.subarray(0, 4).toString('latin1') !== 'wOF2') { lost.push(`${p} (not a woff2 file)`); continue }
  const key = `font-${f.file}`
  assets[key] = 'data:font/woff2;base64,' + bytes.toString('base64')
  fonts.push({ family: f.family, asset: key, weight: f.weight })
}
if (lost.length) {
  console.error(`build-beta-theme: font file(s) missing or invalid under ${fontsDir}:`)
  for (const l of lost) console.error(`  ${l}`)
  process.exit(1)
}

// ---- the fragment ----------------------------------------------------------
const fragment = {
  theme: {
    background: cream,
    color: charcoal,
    accent: accent[1],
    fontFamily: `'${sansFamily}', system-ui, sans-serif`,
    headingFamily: `'${displayFamily}', Georgia, serif`,
    palette: {
      bg2: creamDark,
      tx2: charcoalLight,
      accent2: accent[2], accent3: accent[3], accent4: accent[4],
      accent5: accent[5], accent6: accent[6],
      hlink: link,
      folHlink: folLink,
    },
    chartPalette,
    table: {
      headerBg: table.headerBg,
      headerColor: table.headerColor,
      zebra: table.zebra,
      borderColor: table.borderColor,
      color: table.color,
      fontFamily: `'${sansFamily}', system-ui, sans-serif`,
    },
  },
  fonts,
  assets,
  meta: { company: 'Beta Mobility' },
  beta: { designSystem: sha, tokens: version },
}

writeFileSync(outPath, JSON.stringify(fragment, null, 2) + '\n')
console.log(`build-beta-theme: wrote ${outPath} (${(readFileSync(outPath).byteLength / 1024).toFixed(0)} KB, design-system ${sha}, tokens ${version})`)
