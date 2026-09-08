#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Beta deck store rig: the route contract of server/deck-store under Miniflare.
//
//   node scripts/test-beta-store.ts          (from the repo root)
//   node ../scripts/test-beta-store.ts       (from slides/, after npm ci)
//
// WHAT THIS PROVES. decks.betamobility.ai is the first Beta surface in this
// repository that serves documents behind a login, so the contract worth
// pinning is the refusal path as much as the happy path: every route answers
// 401 with no body unless the Cloudflare Access assertion verifies against the
// team JWKS (signature, issuer, audience, expiry, key id, and an
// @betamobility.io identity); writes are shape-validated and answer 400 with a
// one-word reason; a served deck is the uploaded bytes, unchanged, with the
// headers KTD9 names; and the only thing that leaves the worker about a deck
// is a Plausible event carrying `surface` and `outcome`.
//
// The checks live in server/deck-store/test/worker.test.mjs, beside the
// worker, so the two can be read together. This file exists because
// scripts/ has no package.json of its own: miniflare is a devDependency of
// slides/ (the @gfx/zopfli precedent), and ESM resolves from the importing
// file's location, not the cwd, so it is resolved from slides/ explicitly and
// handed in.

import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const slidesPkg = join(root, 'slides', 'package.json')
if (!existsSync(join(root, 'slides', 'node_modules'))) {
  console.log('FAIL  slides/node_modules is missing: run `npm ci` in slides/ first (miniflare lives there)')
  process.exit(1)
}

const require = createRequire(slidesPkg)
const { Miniflare } = await import(pathToFileURL(require.resolve('miniflare')).href)

const { run } = await import(pathToFileURL(join(root, 'server', 'deck-store', 'test', 'worker.test.mjs')).href)
const failures: number = await run(Miniflare)
if (failures) {
  console.log(`
The deck store's route contract is what U8's editor code and the beta-slides
skill will be written against; a red here means a served deck, a refusal, or
an analytics event no longer matches docs/plans/2026-09-08-002 KTD7 to KTD9.`)
  process.exit(1)
}
