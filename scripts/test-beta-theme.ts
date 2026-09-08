#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Beta theme rig: the design-system tokens become a complete, embedded theme.
//
//   node scripts/test-beta-theme.ts
//
// Self-bundling: `validate.ts` reaches `render.ts`, whose imports are
// extensionless, so Node's native type stripping cannot load it. When this file
// is run directly it bundles itself with esbuild (from slides/node_modules, the
// same way ci.yml bundles test-validate.ts) and re-executes the bundle. The
// rig proper starts at "WHAT THIS PROVES".
//
// WHAT THIS PROVES. `beta/theme.json` is the one place a Beta deck gets its
// identity from, and it is GENERATED: a token renamed in the design system, a
// font file lost, or a slot left to Bento's fallback would each ship silently
// as a deck that looks almost right. So:
//
//   1. COMPLETE. Every `PALETTE_SLOTS` entry resolves to a real hex colour,
//      never to `paletteOf()`'s accent fallback.
//   2. VALID. A minimal deck carrying the fragment validates with no
//      `font-not-embedded` and no unknown key except the `beta` provenance
//      block, which upstream preserves as an unknown field on purpose.
//   3. ADDITIVE. Deleting `palette` and `themeRefs` changes no rendered value,
//      the same property test-theme.ts holds upstream to.
//   4. LOUD. A token path the generator needs but cannot find is a non-zero
//      exit naming the path, never a substituted colour.
//   5. TRACEABLE. A re-sync at another design-system SHA updates the
//      provenance, and only the slots whose tokens moved differ.
//   6. EMBEDDED. Every `fonts[]` entry points at an asset that decodes as a
//      real woff2 file (magic `wOF2`), so the faces travel inside the deck.

import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// ---- self-bundle ------------------------------------------------------------
if (import.meta.url.endsWith('.ts')) {
  const self = fileURLToPath(import.meta.url)
  const root = resolve(self, '../..')
  const esbuild = join(root, 'slides/node_modules/.bin/esbuild')
  if (!existsSync(esbuild)) {
    console.log(`  FAIL  ${esbuild} is missing: run "npm ci" in slides/ first`)
    process.exit(1)
  }
  const dir = join(tmpdir(), `beta-theme-rig-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const bundle = join(dir, 'test-beta-theme.mjs')
  execFileSync(esbuild, [self, '--bundle', '--platform=node', '--format=esm', '--log-level=warning', `--outfile=${bundle}`], { stdio: 'inherit' })
  const r = spawnSync(process.execPath, [bundle], { stdio: 'inherit', env: { ...process.env, BETA_RIG_ROOT: root } })
  rmSync(dir, { recursive: true, force: true })
  process.exit(r.status ?? 1)
}

// ---- the rig ----------------------------------------------------------------
// Dynamic imports on purpose: a static import is hoisted above the guard and
// Node would try to resolve render.ts's extensionless imports before bundling.
type BentoDoc = import('../slides/src/model.ts').BentoDoc
const { PALETTE_SLOTS, paletteOf, resolveThemeRefs } = await import('../slides/src/palette.ts')
const { validateDoc } = await import('../slides/src/validate.ts')

const root = process.env.BETA_RIG_ROOT ?? process.cwd()
if (!existsSync(join(root, 'beta')) || !existsSync(join(root, 'scripts'))) {
  console.log(`  FAIL  ${root} is not the repository root (no beta/ and scripts/)`)
  process.exit(1)
}
const generator = join(root, 'scripts/build-beta-theme.mjs')
const tokensPath = join(root, 'beta/tokens.json')
const themePath = join(root, 'beta/theme.json')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const HEX6 = /^#[0-9a-f]{6}$/i
const scratch = join(tmpdir(), `beta-theme-rig-work-${process.pid}`)
mkdirSync(scratch, { recursive: true })
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

type Fragment = {
  theme: BentoDoc['theme']
  fonts: NonNullable<BentoDoc['fonts']>
  assets: Record<string, string>
  meta: NonNullable<BentoDoc['meta']>
  beta: { designSystem: string; tokens: string }
}

/** Run the generator on a tokens file. Never throws: the rig reports instead. */
function generate(tokens: string, out: string): { status: number; stderr: string; stdout: string } {
  if (!existsSync(generator)) return { status: 127, stderr: `${generator} does not exist`, stdout: '' }
  const r = spawnSync(process.execPath, [generator, '--tokens', tokens, '--out', out], { cwd: root, encoding: 'utf8' })
  return { status: r.status ?? 1, stderr: r.stderr ?? '', stdout: r.stdout ?? '' }
}

function readJson<T>(p: string): T | null {
  try { return JSON.parse(readFileSync(p, 'utf8')) as T } catch { return null }
}

/** A minimal deck (docs/agents.md skeleton) with the fragment applied. */
function deckWith(frag: Fragment, refs = false): BentoDoc {
  const el: Record<string, unknown> = {
    id: 't1', type: 'text', x: 96, y: 260, w: 1088, h: 160, rotation: 0, opacity: 1,
    html: 'Hello from Beta.', fontSize: 88, fontFamily: frag.theme.headingFamily,
    fontWeight: 700, color: frag.theme.color, align: 'left', valign: 'top', lineHeight: 1.1,
  }
  const card: Record<string, unknown> = {
    id: 'card', type: 'shape', shape: 'rect', x: 96, y: 480, w: 400, h: 120, rotation: 0, opacity: 1,
    fill: frag.theme.accent, stroke: frag.theme.palette?.accent2, strokeWidth: 2, radius: 8,
  }
  if (refs) {
    el.themeRefs = { color: 'tx1' }
    card.themeRefs = { fill: 'accent1', stroke: 'accent2' }
  }
  const slide: Record<string, unknown> = {
    id: 's1', background: frag.theme.background, transition: 'none', notes: '', elements: [el, card],
  }
  if (refs) slide.themeRefs = { background: 'bg1' }
  return {
    format: 'bento/slides', version: 1, docId: 'beta-theme-rig', title: 'Beta rig',
    size: { width: 1280, height: 720 },
    theme: frag.theme, fonts: frag.fonts, assets: frag.assets, meta: frag.meta,
    beta: frag.beta,
    slides: [slide],
  } as unknown as BentoDoc
}

// ---------------------------------------------------------------- inputs exist
ok(existsSync(tokensPath), 'beta/tokens.json exists (run scripts/beta-sync-tokens.mjs)')
ok(existsSync(generator), 'scripts/build-beta-theme.mjs exists')

// The committed fragment must be what the generator produces from the
// committed tokens, byte for byte: a stale theme.json is a stale brand.
const fresh = join(scratch, 'fresh.json')
{
  const r = generate(tokensPath, fresh)
  ok(r.status === 0, `the generator succeeds on beta/tokens.json${r.status ? `: ${r.stderr.trim().split('\n')[0]}` : ''}`)
}
const committed = readJson<Fragment>(themePath)
const frag = readJson<Fragment>(fresh)
ok(!!committed, 'beta/theme.json exists and parses')
ok(!!frag, 'the generated fragment parses')
if (committed && frag) {
  ok(JSON.stringify(committed) === JSON.stringify(frag),
    'beta/theme.json is byte-identical to a fresh generation (regenerate and commit if not)')
  const again = join(scratch, 'again.json')
  generate(tokensPath, again)
  ok(readFileSync(fresh, 'utf8') === readFileSync(again, 'utf8'), 'two generator runs are byte-identical (no timestamps in the fragment)')
  ok(readFileSync(fresh).byteLength < 400 * 1024, `the fragment is under 400 KB (${(readFileSync(fresh).byteLength / 1024).toFixed(0)} KB)`)
}

if (!frag) {
  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(1)
}

// ------------------------------------------------- 1. every slot, valid hex
{
  const p = paletteOf(deckWith(frag)) as Record<string, string | undefined>
  for (const slot of PALETTE_SLOTS) {
    ok(typeof p[slot] === 'string' && HEX6.test(p[slot] as string), `palette slot ${slot} is a six-digit hex colour (${p[slot]})`)
  }
  ok(p.bg1?.toUpperCase() === '#F5F3EF', 'bg1 is cream')
  ok(p.tx1?.toUpperCase() === '#1A1A1A', 'tx1 is charcoal')
  ok(p.bg2?.toUpperCase() === '#F0EDE8', 'bg2 is cream-dark')
  ok(p.tx2?.toUpperCase() === '#333333', 'tx2 is charcoal-light')
  ok(p.accent1?.toUpperCase() === '#4A7C59', 'accent1 is the sage accent')
  ok(p.hlink?.toUpperCase() === '#4A7C59' && p.folHlink?.toUpperCase() === '#3D6B4A', 'hlink is accent1 and folHlink is the sage hover')
  // bg1/tx1/accent1 live on theme.background/color/accent; every other slot
  // must be written explicitly, or paletteOf() quietly hands back accent1.
  const palette = (frag.theme.palette ?? {}) as Record<string, string | undefined>
  const slotsThatFellBack = PALETTE_SLOTS.filter((s) => !['bg1', 'tx1', 'accent1'].includes(s) && !palette[s])
  ok(slotsThatFellBack.length === 0, `no slot relies on paletteOf()'s accent fallback${slotsThatFellBack.length ? ` (${slotsThatFellBack.join(', ')})` : ''}`)
}
ok(frag.theme.headingFamily === "'Playfair Display', Georgia, serif", `headingFamily is the full serif stack (${frag.theme.headingFamily})`)
ok(frag.theme.fontFamily === "'Inter', system-ui, sans-serif", `fontFamily is the full sans stack (${frag.theme.fontFamily})`)
ok(Array.isArray(frag.theme.chartPalette) && frag.theme.chartPalette.length >= 5 && frag.theme.chartPalette.every((c) => HEX6.test(c)),
  'chartPalette has five or more hex series colours')
ok(frag.theme.chartPalette?.[0]?.toUpperCase() === '#4A7C59', 'chartPalette leads with accent1')
ok(frag.theme.table?.headerBg?.toUpperCase() === '#1A1A1A' && frag.theme.table?.zebra?.toUpperCase() === '#F0EDE8',
  'table defaults carry the charcoal header and cream-dark zebra')
ok(frag.meta.company === 'Beta Mobility', 'meta.company is Beta Mobility')
ok(typeof frag.beta?.designSystem === 'string' && frag.beta.designSystem.length >= 7, `beta.designSystem carries the design-system SHA (${frag.beta?.designSystem})`)
ok(typeof frag.beta?.tokens === 'string', `beta.tokens carries the tokens version (${frag.beta?.tokens})`)

// --------------------------------------------- 2. validates, fonts embedded
{
  const res = validateDoc(deckWith(frag), { measure: false })
  const codes = res.findings.map((f) => `${f.code}@${f.path ?? ''}`)
  ok(res.counts.error === 0, `a minimal Beta deck has no validation errors (${codes.filter((c) => c.startsWith('missing')).join(', ') || 'none'})`)
  ok(!res.findings.some((f) => f.code === 'font-not-embedded'),
    `no font-not-embedded finding${res.findings.filter((f) => f.code === 'font-not-embedded').map((f) => ` (${f.message})`).join('')}`)
  const unknown = res.findings.filter((f) => f.code === 'unknown-key')
  ok(unknown.length === 1 && unknown[0].path === 'beta',
    `the only unknown key is the top-level "beta" provenance block (${unknown.map((f) => f.path).join(', ') || 'none'})`)
  ok(!res.findings.some((f) => f.code === 'missing-asset'), 'every font asset is present in doc.assets')
}

// ------------------------------------------------------- 3. additivity
{
  const derived = deckWith(frag, true)
  resolveThemeRefs(derived)
  const stripped = JSON.parse(JSON.stringify(derived))
  delete stripped.theme.palette
  for (const s of stripped.slides) { delete s.themeRefs; for (const e of s.elements) delete e.themeRefs }
  const visible = (doc: unknown) => JSON.stringify(doc, (k, v) => (k === 'themeRefs' || k === 'palette' ? undefined : v))
  ok(visible(derived) === visible(stripped), 'stripping palette + themeRefs leaves every rendered value byte-identical')
  const card = derived.slides[0].elements[1] as unknown as { fill: string; stroke: string }
  ok(card.fill === frag.theme.accent && card.stroke === frag.theme.palette?.accent2,
    'a Beta deck resolves refs to the very literals it already carries')
}

// ------------------------------------------- 4. missing token is loud
{
  const tokens = readJson<Record<string, any>>(tokensPath)!
  const cases: Array<[string, (t: any) => void]> = [
    ['slides.accent1', (t) => { delete t.slides.accent1 }],
    ['colors.core.cream', (t) => { delete t.colors.core.cream }],
    ['fonts.display.stack', (t) => { delete t.fonts.display.stack }],
  ]
  for (const [path, mutate] of cases) {
    const copy = JSON.parse(JSON.stringify(tokens))
    mutate(copy)
    const p = join(scratch, `missing-${path}.json`)
    writeFileSync(p, JSON.stringify(copy))
    const r = generate(p, join(scratch, `missing-${path}.out.json`))
    ok(r.status !== 0 && r.stderr.includes(path), `removing ${path} makes the generator exit non-zero naming the path (exit ${r.status})`)
  }
}

// ------------------------------------------- 5. re-sync at another SHA
{
  const tokens = readJson<Record<string, any>>(tokensPath)!
  const copy = JSON.parse(JSON.stringify(tokens))
  copy._source.sha = 'deadbee'
  copy.slides.accent2.value = '#123456'
  const p = join(scratch, 'resync.json')
  writeFileSync(p, JSON.stringify(copy))
  const out = join(scratch, 'resync.out.json')
  const r = generate(p, out)
  const next = readJson<Fragment>(out)
  ok(r.status === 0 && !!next, 'the generator accepts a re-synced tokens file')
  if (next) {
    ok(next.beta.designSystem === 'deadbee', `beta.designSystem follows _source.sha (${next.beta.designSystem})`)
    const flat = (o: unknown, prefix = '', acc: Record<string, string> = {}): Record<string, string> => {
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o as Record<string, unknown>)) flat(v, prefix ? `${prefix}.${k}` : k, acc)
      else acc[prefix] = JSON.stringify(o)
      return acc
    }
    const a = flat(frag), b = flat(next)
    const diff = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort()
    const expected = ['beta.designSystem', 'theme.chartPalette.1', 'theme.palette.accent2']
    ok(JSON.stringify(diff) === JSON.stringify(expected),
      `only the moved slot and its chart series differ (${diff.join(', ')})`)
  }
}

// ------------------------------------------------- 6. woff2 magic
{
  const families = new Set(frag.fonts.map((f) => f.family))
  for (const fam of ['Inter', 'Playfair Display', 'DM Mono']) ok(families.has(fam), `fonts[] declares ${fam}`)
  for (const f of frag.fonts) {
    const data = frag.assets[f.asset]
    const isUri = typeof data === 'string' && data.startsWith('data:font/woff2;base64,')
    const magic = isUri ? Buffer.from(data.slice('data:font/woff2;base64,'.length), 'base64').subarray(0, 4).toString('latin1') : ''
    ok(isUri && magic === 'wOF2', `${f.family} ${f.weight ?? ''} asset "${f.asset}" is a data: URI that decodes as woff2`)
    ok(typeof f.weight === 'string' && /^\d{3}$/.test(f.weight), `${f.family} entry carries a numeric weight (${f.weight})`)
  }
  const fromDisk = frag.fonts.every((f) => existsSync(join(root, 'beta/fonts', `${f.asset.replace(/^font-/, '')}.woff2`)))
  ok(fromDisk, 'every font asset key names a file in beta/fonts/ (asset "font-<name>" is beta/fonts/<name>.woff2)')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
