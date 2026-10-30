#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// BETA FORK: write each library scene's captured still (2026-10-30-001
// roadmap, R8). See scripts/lib/beta-library-still.mjs for what is captured
// and why.
//
//   node scripts/build-beta-library-stills.mjs            rewrite beta/library/<id>/still.svg
//   node scripts/build-beta-library-stills.mjs --check    fail when one is stale
//   ... [<id> ...]                                        only these scenes
//
// Only scenes whose page draws into <svg id="scene"> are captured; the
// others' stills are drawn by hand. Needs playwright (PLAYWRIGHT_MODULE) and
// a Chrome (CHROME_PATH), as the browser rigs do.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureStill, capturedScenes } from './lib/beta-library-still.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dir = join(root, 'beta/library')
const args = process.argv.slice(2)
const check = args.includes('--check')
const all = capturedScenes(dir)
const ids = args.filter((a) => !a.startsWith('--'))
for (const id of ids) if (!all.includes(id)) { console.error(`build-beta-library-stills: ${id} is not a captured scene (${all.join(', ')})`); process.exit(2) }

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
let stale = 0
for (const id of ids.length ? ids : all) {
  // a fresh page per scene: nothing one scene's script left behind reaches the next
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const still = await captureStill(page, readFileSync(join(dir, id, 'index.html'), 'utf8'))
  await page.close()
  if (errors.length) { console.error(`  ${id}: the page threw while drawing (${errors.join(' | ')}); nothing written`); stale++; continue }
  const file = join(dir, id, 'still.svg')
  let have = ''
  try { have = readFileSync(file, 'utf8') } catch { /* none yet */ }
  if (have === still) { console.log(`  ${id}: current (${Buffer.byteLength(still)} bytes)`); continue }
  if (check) { stale++; console.error(`  ${id}: still.svg is stale; run node scripts/build-beta-library-stills.mjs ${id}`); continue }
  writeFileSync(file, still)
  console.log(`  ${id}: wrote still.svg (${Buffer.byteLength(still)} bytes)`)
}
await browser.close()
process.exit(stale ? 1 : 0)
