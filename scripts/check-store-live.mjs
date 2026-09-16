#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
//
// Is everything the site publishes still reachable without a login?
//
//   BENTO_SITE_DIR=../bento-site node scripts/check-store-live.mjs
//   node scripts/check-store-live.mjs --host https://slides.betamobility.ai
//
// WHAT THIS PROVES, and why it is INVERTED. slides.betamobility.ai serves the
// gated deck store and the public release channel from one worker, and which
// paths are public is decided in two places that can drift apart: the worker's
// allowlist (server/deck-store/src/worker.js) and the Cloudflare Access
// applications, which live in a dashboard and are not in this repository at
// all. Bypassed requests are not logged, so drift there is silent.
//
// A checker written the obvious way — walk the allowlist, confirm each entry
// answers — would pass forever while a path published LATER quietly started
// asking for a login. So this walks the PUBLISHED INVENTORY instead: every
// file in the deploy tree must answer 200 anonymously, or be named in
// `intentionally-gated.txt` beside this script. A newly published path that
// nobody added to the allowlist fails the check instead of failing a
// colleague's shipped deck silently, months later.
//
// The name deliberately avoids the `test-*` prefix: scripts/test-ci-registered.ts
// requires every test-* rig to run in CI, and this one needs the network and a
// live host. Its own logic is unit-tested (--selftest) and that runs with the
// repo gates.
//
// Plan: docs/plans/2026-09-10-001-feat-slides-host-swap-plan.md, U7.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walk } from './site-inventory.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d }

const DEFAULT_HOST = 'https://slides.betamobility.ai'
const EXCEPTIONS_FILE = join(here, 'check-store-live.gated.txt')

// In the site repo but never deployed by Pages, so not a published path.
// Verified against the live host: `/.nojekyll` is served, `/.wrangler/...` is
// not — Pages excludes its own cache directory, not dotfiles in general.
const NOT_DEPLOYED = ['.wrangler/', '.git/']

/**
 * The published tree as URL paths. Directory index files become their
 * extensionless form as well, because that is what Pages serves and what a
 * link in the wild points at.
 */
export function publishedPaths(files) {
  const out = new Set()
  for (const f of files) {
    const rel = f.split('\\').join('/')
    if (NOT_DEPLOYED.some((d) => rel.startsWith(d))) continue
    const p = '/' + rel
    out.add(p)
    if (p.endsWith('/index.html')) out.add(p.slice(0, -'index.html'.length) || '/')
  }
  return [...out].sort()
}

/**
 * Is this redirect Pages tidying a URL, or Access asking us to log in?
 *
 * It matters because BOTH are 3xx and they mean opposite things. Pages `308`s
 * every `.html` URL to its extensionless form, so a blanket "must answer 200"
 * would fail on most of the published tree; and blanket redirect-following
 * would march into the Access login page and report a cheerful 200 for a path
 * that is gated. So: follow a redirect that stays on this host and is not an
 * Access login, and treat every other redirect as a gate.
 */
export const isTidyingRedirect = (from, location) => {
  if (!location) return false
  let to
  try { to = new URL(location, from) } catch { return false }
  if (to.host !== new URL(from).host) return false             // off-host = Access
  if (to.pathname.startsWith('/cdn-cgi/access/')) return false // on-host Access login
  return true
}

/** Paths deliberately not public, one per line; `#` comments and blanks ignored. */
export function readExceptions(text) {
  return new Set(text.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean))
}

/**
 * The check itself, with `fetchOne` injected so it is testable with no
 * network. Returns `{ failures, checked, results }`; a path passes when it
 * answers 200 anonymously, or when it is on the exception list AND does not.
 * An exception that answers 200 anyway is reported too — a stale exception is
 * how a list like this rots.
 */
export async function sweep(paths, exceptions, fetchOne) {
  const results = []
  for (const p of paths) {
    const status = await fetchOne(p)
    const gated = exceptions.has(p)
    let verdict
    if (status === 200) verdict = gated ? 'unexpectedly-public' : 'ok'
    else verdict = gated ? 'gated-on-purpose' : 'FAIL'
    results.push({ path: p, status, verdict })
  }
  return { results, checked: results.length, failures: results.filter((r) => r.verdict === 'FAIL').length }
}

// ---- the agent routes (--routes) ------------------------------------------
//
// The pairing and publish prefixes are Access BYPASS destinations, added in a
// dashboard this repository cannot see, exactly like the release channel. The
// inventory sweep above cannot notice them: they are not published files. So
// this is the one thing that says whether those two destinations still exist
// and still point where the worker expects.
//
// The asymmetry is the whole check. `/api/link/start` and `/api/publish/` must
// answer WITHOUT a login, because an agent has no session — while `/api/link`
// (no trailing slash) and `/link/<code>` sit OUTSIDE the bypassed prefixes and
// must still be gated, because Access answers before the worker does. If the
// destinations were entered as bare prefixes without the slash, or dropped,
// one half of that flips.
//
// A pairing started here is a ten-minute KV entry nobody approves; it grants
// nothing and expires by itself.

/** A 3xx into Access, or a 401 from the worker: either way, not public. */
const isGated = (res) => res.status === 401 || res.status === 403
  || (res.status >= 300 && res.status < 400 && !isTidyingRedirect(res.url, res.headers?.location))

export function routeExpectations() {
  const deadBearer = `Bearer ${'x'.repeat(43)}`
  return [
    {
      name: 'POST /api/link/start answers with no login at all',
      method: 'POST', path: '/api/link/start',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'live check' }),
      // 429 is a pass: the endpoint is there and its limiter is working. 503
      // is not — that is the limiter binding missing in production.
      ok: (res) => (res.status === 200 && /"code"/.test(res.body || '')) || res.status === 429,
      why: 'the Bypass destination /api/link/ is missing, so an agent cannot start a pairing',
    },
    {
      name: 'a bad bearer on the publish path is 401 with no body',
      method: 'GET', path: '/api/publish/decks/0123456789', headers: { authorization: deadBearer },
      ok: (res) => res.status === 401 && !res.body,
      why: 'the publish prefix is not reaching the worker, or is answering something other than a flat refusal',
    },
    {
      name: 'the publish prefix has no list route',
      method: 'GET', path: '/api/publish/decks', headers: { authorization: deadBearer },
      ok: (res) => res.status === 401,
      why: 'a grant must never be able to enumerate the store',
    },
    {
      name: 'bare /api/link is still gated',
      method: 'GET', path: '/api/link',
      ok: isGated,
      why: 'the Bypass destination was entered without its trailing slash, widening the public surface',
    },
    {
      name: 'the approval page is still behind Access',
      method: 'GET', path: '/link/0123456789',
      ok: isGated,
      why: 'the approval page is how the store learns who approved; anonymous access there would break the whole premise',
    },
    {
      // The frame headers on `/` and `/link/*` cannot be read anonymously —
      // Access answers first — so the worker rig is where those are asserted.
      // What IS checkable here is that the index is gated at all.
      name: 'the index is still gated',
      method: 'GET', path: '/',
      ok: isGated,
      why: 'the deck list would be readable by anyone',
    },
  ]
}

export async function sweepRoutes(checks, fetchRoute) {
  const results = []
  for (const c of checks) {
    const res = await fetchRoute(c)
    results.push({ name: c.name, status: res.status, pass: !!c.ok(res), why: c.why })
  }
  return { results, checked: results.length, failures: results.filter((r) => !r.pass).length }
}

// ---- self-test: the three cases, no network -------------------------------

if (args.includes('--selftest')) {
  let checks = 0, failures = 0
  const ok = (cond, msg) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }

  const paths = publishedPaths(['releases/slides/manifest.json', 'agents.md', 'decks/secret.html', 'index.html', '.wrangler/cache/pages.json'])
  ok(paths.includes('/releases/slides/manifest.json'), 'a published file becomes a URL path')
  ok(paths.includes('/'), 'and an index.html also becomes its directory')
  ok(!paths.some((p) => p.startsWith('/.wrangler/')), 'and what Pages never deploys is not a published path')

  // Both kinds of 3xx, told apart. Pages tidies a URL; Access asks for a login.
  ok(isTidyingRedirect('https://h/404.html', 'https://h/404'), 'a same-host redirect is Pages tidying a URL')
  ok(isTidyingRedirect('https://h/404.html', '/404'), 'and a relative one is too')
  ok(!isTidyingRedirect('https://h/d/x', 'https://team.cloudflareaccess.com/login'), 'an off-host redirect is Access, not tidying')
  ok(!isTidyingRedirect('https://h/d/x', 'https://h/cdn-cgi/access/login/h'), 'and so is an on-host Access login path')

  const allPublic = async () => 200
  let out = await sweep(paths, new Set(), allPublic)
  ok(out.failures === 0, `every published path reachable: passes (${out.checked} checked)`)

  const oneGated = async (p) => (p === '/decks/secret.html' ? 302 : 200)
  out = await sweep(paths, new Set(), oneGated)
  ok(out.failures === 1, 'a published path that is gated and unlisted: fails')
  ok(out.results.find((r) => r.path === '/decks/secret.html').verdict === 'FAIL', '…and names the path that failed')

  out = await sweep(paths, readExceptions('# on purpose\n/decks/secret.html\n\n'), oneGated)
  ok(out.failures === 0, 'the same path on the exception list: passes')
  ok(out.results.find((r) => r.path === '/decks/secret.html').verdict === 'gated-on-purpose', '…recorded as gated on purpose')

  out = await sweep(paths, readExceptions('/agents.md'), allPublic)
  ok(out.results.find((r) => r.path === '/agents.md').verdict === 'unexpectedly-public',
    'an exception that answers 200 anyway is reported, so the list cannot rot unnoticed')
  ok(out.failures === 0, 'but it does not fail the run: it is a wider surface, not a broken consumer')

  // --- the agent routes, both directions of the asymmetry ------------------
  const routeChecks = routeExpectations()
  ok(routeChecks.some((c) => c.path === '/api/link/start' && c.method === 'POST'), 'the route pass starts a pairing anonymously')
  ok(routeChecks.some((c) => c.path === '/api/link' && c.method === 'GET'), 'and asserts the bare prefix is still gated')

  const healthy = async (c) => {
    if (c.path === '/api/link/start') return { status: 200, body: '{"code":"abc0123456","handle":"h"}', headers: {}, url: 'https://h' + c.path }
    if (c.path.startsWith('/api/publish/')) return { status: 401, body: '', headers: {}, url: 'https://h' + c.path }
    return { status: 302, body: '', headers: { location: 'https://team.cloudflareaccess.com/login' }, url: 'https://h' + c.path }
  }
  let rt = await sweepRoutes(routeChecks, healthy)
  ok(rt.failures === 0, `a correctly configured host passes every route check (${rt.checked} checked)`)

  // The two failures that matter, because each is a dashboard edit nobody logs.
  rt = await sweepRoutes(routeChecks, async (c) => (c.path === '/api/link/start'
    ? { status: 302, body: '', headers: { location: 'https://team.cloudflareaccess.com/login' }, url: 'https://h' + c.path }
    : healthy(c)))
  ok(rt.failures === 1 && /link\/ is missing/.test(rt.results.find((r) => !r.pass).why),
    'a dropped Bypass destination fails, and the message says which one')

  rt = await sweepRoutes(routeChecks, async (c) => (c.path === '/api/link'
    ? { status: 200, body: 'hello', headers: {}, url: 'https://h' + c.path }
    : healthy(c)))
  ok(rt.failures === 1 && /trailing slash/.test(rt.results.find((r) => !r.pass).why),
    'a destination entered without its trailing slash fails too, the other way round')

  rt = await sweepRoutes(routeChecks, async (c) => (c.path === '/api/link/start'
    ? { status: 503, body: 'store: the pairing rate limiter is not configured', headers: {}, url: 'https://h' + c.path }
    : healthy(c)))
  ok(rt.failures === 1, 'a 503 from the start route fails: the limiter binding is missing in production')
  rt = await sweepRoutes(routeChecks, async (c) => (c.path === '/api/link/start'
    ? { status: 429, body: '', headers: {}, url: 'https://h' + c.path }
    : healthy(c)))
  ok(rt.failures === 0, 'while a 429 passes: the endpoint is there and its limiter is working')

  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

// ---- the live run ----------------------------------------------------------

const host = (opt('host', DEFAULT_HOST)).replace(/\/+$/, '')

// `--routes` is its own run: it needs no published tree, only the live host.
if (args.includes('--routes')) {
  console.log(`the agent routes against ${host}, anonymously\n`)
  const fetchRoute = async (c) => {
    const url = host + c.path
    try {
      const r = await fetch(url, {
        method: c.method, headers: { 'user-agent': 'beta-store-live-check', ...(c.headers || {}) },
        body: c.body, redirect: 'manual',
      })
      return { status: r.status, body: await r.text().catch(() => ''), headers: { location: r.headers.get('location') }, url }
    } catch (err) {
      return { status: 0, body: String(err?.message || err), headers: {}, url }
    }
  }
  const out = await sweepRoutes(routeExpectations(), fetchRoute)
  for (const r of out.results) console.log(`  ${r.pass ? 'ok   ' : 'FAIL '} ${r.name} (${r.status})${r.pass ? '' : `\n         ${r.why}`}`)
  console.log(`\n${out.checked - out.failures}/${out.checked} route checks passed`)
  if (out.failures) {
    console.log(`
The pairing and publish prefixes are Access Bypass destinations, edited in a
dashboard and not in this repository. A failure here means one of them was
dropped, renamed, or entered without its trailing slash — see
server/deck-store/README.md, "Setup, in order".`)
    process.exit(1)
  }
  process.exit(0)
}

const siteDir = process.env.BENTO_SITE_DIR
  ? resolve(process.env.BENTO_SITE_DIR)
  : resolve(root, '..', 'bento-site')

if (!existsSync(siteDir)) {
  console.error(`✗ no published tree at ${siteDir} — clone the site repo, or set BENTO_SITE_DIR`)
  process.exit(1)
}

const exceptions = existsSync(EXCEPTIONS_FILE) ? readExceptions(readFileSync(EXCEPTIONS_FILE, 'utf8')) : new Set()
const paths = publishedPaths(walk(siteDir))
console.log(`${paths.length} published paths, ${exceptions.size} listed as intentionally gated`)
console.log(`against ${host}, anonymously\n`)

// No cookie, no assertion. Redirects are followed only when they are Pages
// tidying a URL — see above — and at most a few hops.
const fetchOne = async (p) => {
  let url = host + p
  for (let hop = 0; hop < 4; hop++) {
    let r
    try {
      r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'beta-store-live-check' } })
    } catch (err) {
      console.log(`  ERR   ${p}: ${err?.message || err}`)
      return 0
    }
    if (r.status < 300 || r.status >= 400) return r.status
    const location = r.headers.get('location')
    if (!isTidyingRedirect(url, location)) return r.status
    url = new URL(location, url).href
  }
  return 508 // a redirect loop on this host is not a reachable path either
}

const { results, checked, failures } = await sweep(paths, exceptions, fetchOne)
for (const r of results) {
  if (r.verdict === 'ok') continue
  console.log(`  ${r.verdict === 'FAIL' ? 'FAIL ' : r.verdict === 'unexpectedly-public' ? 'note ' : 'skip '} ${r.path}  (${r.status})`)
}
console.log(`\n${checked - failures}/${checked} published paths reachable without a login`)
if (failures) {
  console.log(`
A published path that needs a login is a machine consumer breaking with no
error: a shipped deck's update check, the plugin marketplace fetch, or the
skill's download. Either add its prefix to PUBLIC_PREFIXES / PUBLIC_PATHS in
server/deck-store/src/worker.js and give it an Access Bypass application, or
put it in scripts/check-store-live.gated.txt and say why.`)
  process.exit(1)
}
