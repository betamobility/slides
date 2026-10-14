#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Write beta/theme.json: the theme, fonts and font assets every Beta deck
// carries.
//
//   node scripts/build-beta-theme.mjs [--out <path>]
//
// ONE SOURCE. Since design system v1.5.0 the fragment is betaFoundation() in
// scripts/lib/beta-general.mjs: the palette, chart palette and type read from
// the token snapshot in beta/v131/ (tokens.json, design system 5233d68), with
// Geist 300-700 and DM Mono 400 embedded. The general template, the blank
// deck, the starter deck and every other template carry the same fragment, so
// there is one Beta look. (Until 2026-10-14 this script mapped the 1.0.0
// tokens in beta/tokens.json: cream, Inter and Playfair Display.)
//
// Deterministic: the same snapshot and font files give byte-identical output,
// so scripts/test-beta-theme.ts can prove the committed file is fresh.

import { writeFileSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { betaFoundation } from './lib/beta-general.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const outPath = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : join(root, 'beta', 'theme.json'))

const fragment = betaFoundation()
writeFileSync(outPath, JSON.stringify(fragment, null, 2) + '\n')
console.log(`build-beta-theme: wrote ${outPath} (${(readFileSync(outPath).byteLength / 1024).toFixed(0)} KB, design-system ${fragment.beta.designSystem}, tokens ${fragment.beta.tokens})`)
