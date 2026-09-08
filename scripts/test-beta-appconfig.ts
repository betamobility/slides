#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// AppConfig.syncHost precedence (plan U1, KTD2). Run as `node scripts/test-beta-appconfig.ts`;
// bundles itself with esbuild from slides/node_modules (online.ts's imports
// are extensionful, but the kernel's parameter properties defeat node's
// strip-only loader) and re-executes the bundle.
//
// WHAT THIS PROVES: syncHost() resolves localStorage 'bento-sync-url' first,
// then the host the app configured, then the platform default; and a rig that
// never calls configureApp() still gets the default rather than a throw.
// The publicKeyJwk half of the lift is proven by test-release-channel.mjs §5.

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

if (import.meta.url.endsWith('.ts')) {
  const self = fileURLToPath(import.meta.url)
  const root = resolve(self, '../..')
  const esbuild = join(root, 'slides/node_modules/.bin/esbuild')
  if (!existsSync(esbuild)) { console.log(`  FAIL  ${esbuild} is missing: run "npm ci" in slides/ first`); process.exit(1) }
  const dir = join(tmpdir(), `beta-appconfig-rig-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const bundle = join(dir, 'test-beta-appconfig.mjs')
  execFileSync(esbuild, [self, '--bundle', '--platform=node', '--format=esm', '--log-level=warning', `--outfile=${bundle}`], { stdio: 'inherit' })
  const r = spawnSync(process.execPath, ['--no-warnings', bundle], { stdio: 'inherit' })
  rmSync(dir, { recursive: true, force: true })
  process.exit(r.status ?? 1)
}

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

// a localStorage the kernel's storage.ts can talk to
const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
}

const { configureApp } = await import('../kernel/src/app.ts')
const { syncHost, DEFAULT_SYNC_HOST } = await import('../kernel/src/sync/online.ts')

console.log('syncHost() precedence')
ok(syncHost() === DEFAULT_SYNC_HOST, `before configureApp(): the platform default (${DEFAULT_SYNC_HOST}), no throw`)
configureApp({ appId: 'test-app', appName: 'test', manifestUrl: 'https://example.test/manifest.json' })
ok(syncHost() === DEFAULT_SYNC_HOST, 'configured without syncHost: still the platform default (upstream apps unaffected)')
configureApp({ appId: 'test-app', appName: 'test', manifestUrl: 'https://example.test/manifest.json', syncHost: 'wss://sync.example.test' })
ok(syncHost() === 'wss://sync.example.test', 'configured syncHost wins over the platform default')
store.set('bento-sync-url', 'ws://localhost:8787')
ok(syncHost() === 'ws://localhost:8787', "the localStorage 'bento-sync-url' dev override wins over both")
store.delete('bento-sync-url')
ok(syncHost() === 'wss://sync.example.test', 'clearing the override returns to the configured host')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
