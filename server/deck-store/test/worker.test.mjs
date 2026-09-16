// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Route contract for the deck store worker, run against Miniflare by
// scripts/test-beta-store.ts (which resolves miniflare from slides/node_modules
// and hands the class in). Plan: docs/plans/2026-09-08-002-feat-beta-slides-
// v1-1-plan.md, U7, KTD7 to KTD9 and KTD12.
//
// WHAT THIS PROVES. Every route refuses without a valid Cloudflare Access
// assertion (401, no body), writes are shape-validated (400, one word), the
// served bytes are the uploaded bytes, and the only thing that leaves the
// worker about a deck is a Plausible event carrying `surface` and `outcome`.
//
// Access is exercised for real: the test mints RSA keys at runtime (nothing
// on disk), publishes the public half through a stub JWKS endpoint that the
// worker's outbound fetch is routed to, and signs assertions with every
// failure mode the plan lists. The worker's outbound fetch answers the JWKS,
// Plausible and the stub Pages origin; anything else THROWS, so a subrequest
// sent to the wrong host is a distinct failure rather than the same 502 the
// upstream-error scenario expects.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

// The page's own minting logic, imported from the module the page inlines it
// from — so what the rig exercises is the code the browser runs, not a copy.
import { mintDocIntoBlock, indexPage } from '../src/pages.js'
// The grant store, exercised directly against Miniflare's own KV: mint,
// verify, list and revoke are worker-side functions with no route of their
// own, and the routes that use them arrive in U2 and U3.
import { mintGrant, verifyGrant, listGrants, revokeGrant } from '../src/grant.js'

const subtle = webcrypto.subtle
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

// ---- config the worker is started with ----------------------------------
const TEAM_DOMAIN = 'beta-test.cloudflareaccess.com'
const ISS = `https://${TEAM_DOMAIN}`
const CERTS_URL = `${ISS}/cdn-cgi/access/certs`
const HUMAN_AUD = 'a'.repeat(64)
const SERVICE_AUD = 'b'.repeat(64)
const PLAUSIBLE_URL = 'https://plausible.io/api/event'
const MAX_BYTES = 32 * 1024 * 1024
// The Pages project the worker proxies the public release channel from
// (KTD2/KTD3). A stub stands in for it; the point of the constant is that the
// worker must reach THIS host and never the host of the incoming request.
const PAGES_ORIGIN = 'beta-site-stub.pages.dev'

// ---- helpers --------------------------------------------------------------
const b64u = (bytes) => Buffer.from(bytes).toString('base64url')
const b64uJson = (o) => b64u(Buffer.from(JSON.stringify(o)))

async function rsaKey() {
  return subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'])
}
async function jwk(kid, pair) {
  const pub = await subtle.exportKey('jwk', pair.publicKey)
  return { kid, kty: pub.kty, n: pub.n, e: pub.e, alg: 'RS256', use: 'sig' }
}
async function sign(pair, kid, claims) {
  const head = b64uJson({ alg: 'RS256', kid, typ: 'JWT' })
  const body = b64uJson(claims)
  const sig = await subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(`${head}.${body}`))
  return `${head}.${body}.${b64u(new Uint8Array(sig))}`
}

const now = () => Math.floor(Date.now() / 1000)
/** Claims Access puts in a human assertion, with overrides. */
function human(email, over = {}) {
  return {
    aud: [HUMAN_AUD], email, exp: now() + 600, iat: now(), nbf: now() - 5,
    iss: ISS, type: 'app', identity_nonce: 'n0', sub: `sub-${email}`, country: 'NO', ...over,
  }
}
/** Claims Access puts in a service-token assertion: identity in common_name, sub empty. */
function service(over = {}) {
  return {
    aud: [SERVICE_AUD], common_name: 'deadbeef.access', exp: now() + 600, iat: now(), nbf: now() - 5,
    iss: ISS, type: 'app', sub: '', ...over,
  }
}

/** A minimal bento/slides file: the #bento-doc block with `<` escaped the way the kernel writes it. */
function deck(doc, { pad = '' } = {}) {
  const json = JSON.stringify(doc).replace(/</g, '\\u003c')
  return `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>` +
    `<script type="application/json" id="bento-doc">${json}</script>` +
    `<!--${pad}--><script>/* runtime */</script></body></html>`
}
const slidesDoc = (title, extra = {}) => ({
  format: 'bento/slides', v: 1, docId: `doc-${title.length}-x`, title, slides: [{ id: 's1', elements: [] }], ...extra,
})
/** The document in a file's #bento-doc block. */
const docOfHtml = (html) => {
  const m = /<script\b[^>]*\bid=["']?bento-doc["']?[^>]*>([\s\S]*?)<\/script>/i.exec(html)
  if (!m) throw new Error('no #bento-doc block')
  return JSON.parse(m[1])
}
/** `html` with its block replaced by `doc`, as the splice tool's writeBlock does. */
const writeBlockInto = (html, doc) => {
  const json = JSON.stringify(doc).replace(/</g, '\\u003c')
  return html.replace(/(<script\b[^>]*\bid=["']?bento-doc["']?[^>]*>)[\s\S]*?(<\/script>)/i, (_m, open, close) => `${open}${json}${close}`)
}
const encEnvelope = () => ({ format: 'bento/enc', v: 1, it: 600000, salt: 'c2FsdA==', iv: 'aXZpdml2aXZpdg==', data: 'Y2lwaGVy' })

// ---- rig -----------------------------------------------------------------
export async function run(Miniflare) {
  let checks = 0, failures = 0
  const ok = (cond, msg) => {
    checks++
    if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
  }
  const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)

  // Keys: k1 is published, k2 is a rogue key the JWKS never carries, k3 is
  // added later to prove a refresh picks up a rotation.
  const k1 = await rsaKey(), k2 = await rsaKey(), k3 = await rsaKey()
  const jwks = { keys: [await jwk('k1', k1)] }
  let certsFetches = 0
  const events = []
  let plausible = 'ok' // 'ok' | 'fail' | 'throw'
  // Every subrequest the worker makes to the Pages origin, in order. The
  // header-stripping and wrong-host assertions read from here.
  const proxied = []

  /**
   * What the stub Pages project serves at `path`. Deterministic, per-path.
   *
   * The blank template is the exception and has to be a real document: the
   * worker mints an identity into those bytes for `GET /new/blank`. Keeping it
   * here rather than in the outbound stub means the public pass-through
   * assertions, which compare against this function, stay true of it too.
   */
  const pagesBody = (path) => (path === '/templates/blank.bento.html'
    ? blankTemplate()
    : `stub bytes for ${path}\n${'x'.repeat(64)}\n`)

  // `GET /new/blank` reads the blank template from PAGES_ORIGIN. Prefer the
  // real built file — that is the document a colleague's first deck is made
  // from — and fall back to a minimal template so this route is still covered
  // before `node scripts/build-beta-templates.mjs` has run.
  let templateOutage = false
  const builtBlank = join(repoRoot, 'beta', 'templates', 'blank.bento.html')
  const blankTemplate = () => (existsSync(builtBlank)
    ? readFileSync(builtBlank, 'utf8')
    : `<!doctype html><html><body><script type="application/bento+json" id="bento-doc">${
        JSON.stringify({
          format: 'bento/slides', v: 1, template: true, title: 'Blank deck',
          collab: { on: true, room: 'inherited-should-be-dropped' },
          slides: [{ id: 's1', elements: [] }],
        }).replace(/</g, '\\u003c')
      }</script></body></html>`)

  // Kept in a variable so a scenario can flip one flag and put it back
  // without re-stating the whole worker configuration.
  const mfOptions = {
    modules: true,
    // Module names are computed relative to modulesRoot; without it they are
    // relative to the cwd, and from slides/ that puts a `..` in the name,
    // which workerd refuses ("can't use '..' to break out of starting
    // directory"). Probed: rootPath does not help, modulesRoot does.
    modulesRoot: join(here, '..', 'src'),
    scriptPath: join(here, '..', 'src', 'worker.js'),
    // wrangler treats .js as ESM; Miniflare's default rules treat it as
    // CommonJS, so say so or access.js fails to parse on its first `export`.
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: '2026-07-01',
    r2Buckets: ['DECKS'],
    // The grants (one-click publish plan, KTD3). KV, not R2: native expiry and
    // per-key reads are the whole reason a grant does not need a cron sweep.
    kvNamespaces: ['GRANTS'],
    // The pairing routes are public, so they are rate-limited (KTD9).
    // Miniflare implements the binding, so the rig proves the 429 as well as
    // the body caps; OQ1 is answered yes.
    ratelimits: { LINK_LIMIT: { namespace_id: '1001', simple: { limit: 10, period: 60 } } },
    bindings: {
      ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUDS: `${HUMAN_AUD},${SERVICE_AUD}`,
      PAGES_ORIGIN, NEW_ENABLED: 'on',
      STORE_HOST: 'slides.betamobility.ai', OLD_HOST: 'decks.betamobility.ai',
      REDIRECT_OLD_HOST: 'on', LINK_LIMIT_REQUIRED: 'on',
    },
    outboundService: async (req) => {
      if (req.url === CERTS_URL) {
        certsFetches++
        return new Response(JSON.stringify(jwks), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' } })
      }
      if (req.url === PLAUSIBLE_URL) {
        events.push({ headers: Object.fromEntries(req.headers), body: await req.json() })
        if (plausible === 'throw') throw new Error('plausible down')
        if (plausible === 'fail') return new Response('nope', { status: 500 })
        return new Response('ok', { status: 202 })
      }
      if (req.url.startsWith(`https://${PAGES_ORIGIN}/`)) {
        proxied.push({ url: req.url, method: req.method, headers: Object.fromEntries(req.headers) })
        const p = new URL(req.url).pathname
        // Pages 308s an `.html` URL to its extensionless form (KTD3).
        if (p === '/releases/slides/redirected.html') {
          return new Response(null, { status: 308, headers: { location: `https://${PAGES_ORIGIN}/releases/slides/redirected` } })
        }
        if (p === '/releases/slides/boom') return new Response('upstream exploded', { status: 500 })
        // One scenario takes the blank template away, to prove `/new/blank`
        // answers a readable 502 rather than storing a broken deck.
        if (p === '/templates/blank.bento.html' && templateOutage) {
          return new Response('gone', { status: 404 })
        }
        return new Response(pagesBody(p), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=300', 'etag': '"stub"' },
        })
      }
      // A THROW, not a 502: the error-wrapper scenario asserts a 502, so a
      // stub that answered 502 here would let a misdirected subrequest pass.
      throw new Error(`unexpected outbound fetch: ${req.url}`)
    },
  }
  const mf = new Miniflare(mfOptions)

  // The store's host. OLD_ORIGIN is the retired one, used only by the
  // redirect scenarios — every other assertion in this file is about the host
  // the store actually lives on now.
  const ORIGIN = 'https://slides.betamobility.ai'
  const OLD_ORIGIN = 'https://decks.betamobility.ai'
  const tokens = {
    alice: await sign(k1, 'k1', human('alice@betamobility.io')),
    bob: await sign(k1, 'k1', human('bob@betamobility.io')),
    service: await sign(k1, 'k1', service()),
  }
  /** Dispatch a request; `as` names a canned identity or is a raw assertion string. */
  async function call(method, path, { as, body, headers = {}, origin = ORIGIN, redirect = 'manual' } = {}) {
    const h = { 'user-agent': 'rig/1.0', ...headers }
    if (as) h['cf-access-jwt-assertion'] = tokens[as] || as
    return mf.dispatchFetch(origin + path, { method, headers: h, body, redirect })
  }
  const bodyOf = async (r) => Buffer.from(await r.arrayBuffer())
  async function waitFor(pred, ms = 3000) {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 25)) }
    return pred()
  }

  try {
    // ---------------------------------------------------- 401 on every route
    console.log('\nno assertion, or an assertion Access would never issue: 401 with no body')
    const minimal = deck(slidesDoc('Minimal'))
    for (const [m, p, b] of [
      ['GET', '/'], ['GET', '/new'], ['GET', '/api/decks'], ['POST', '/api/decks', minimal],
      ['PUT', '/api/decks/0123456789', minimal], ['DELETE', '/api/decks/0123456789'], ['GET', '/d/0123456789'],
      ['POST', '/api/harness/decks', minimal], ['PUT', '/api/harness/decks/0123456789', minimal], ['GET', '/nowhere'],
      ['GET', '/api/harness/decks/0123456789'], ['HEAD', '/d/0123456789'],
      ['PUT', '/api/harness/decks/0123456789/assets/map.png', 'x'], ['GET', '/d/0123456789/assets/map.png'],
      // A prefix-boundary match, not a substring one: these start like an
      // allowlisted prefix and are gated all the same (KTD0).
      ['GET', '/releases-secret'], ['GET', '/releases-secret/manifest.json'], ['GET', '/templates-private/x'],
      ['GET', '/agents.md.bak'], ['GET', '/skills'],
      // Deliberately not public: an unknown path never reaches Pages, so its
      // 404 page is never served anonymously and nothing fetches it by name.
      ['GET', '/404.html'], ['GET', '/404'],
      // The allowlist covers reads. A write to an allowlisted path is not a
      // pass-through and still needs an assertion.
      ['POST', '/releases/slides/manifest.json', minimal],
    ]) {
      const r = await call(m, p, { body: b })
      eq(r.status, 401, `${m} ${p} without an assertion is 401`)
      eq((await bodyOf(r)).length, 0, `${m} ${p} 401 carries no body`)
    }
    const bad = {
      expired: await sign(k1, 'k1', human('alice@betamobility.io', { exp: now() - 10 })),
      'wrong aud': await sign(k1, 'k1', human('alice@betamobility.io', { aud: ['c'.repeat(64)] })),
      'wrong issuer': await sign(k1, 'k1', human('alice@betamobility.io', { iss: 'https://evil.cloudflareaccess.com' })),
      'wrong email domain': await sign(k1, 'k1', human('mallory@example.com')),
      'no identity at all': await sign(k1, 'k1', human('', { email: undefined, common_name: undefined })),
      // Flip a char in the MIDDLE of the signature: the last base64url char
      // carries only padding bits, so flipping it decodes to the same bytes.
      'bad signature': ((t) => { const i = t.lastIndexOf('.') + 40; return t.slice(0, i) + (t[i] === 'A' ? 'B' : 'A') + t.slice(i + 1) })(await sign(k1, 'k1', human('alice@betamobility.io'))),
      'not a jwt': 'garbage',
    }
    for (const [why, tok] of Object.entries(bad)) {
      for (const [m, p] of [['GET', '/d/0123456789'], ['GET', '/api/decks'], ['POST', '/api/decks']]) {
        const r = await call(m, p, { as: tok, body: m === 'POST' ? minimal : undefined })
        eq(r.status, 401, `${why}: ${m} ${p} is 401`)
        eq((await bodyOf(r)).length, 0, `${why}: ${m} ${p} has no body`)
      }
    }

    // -------------------------------------- the public release channel (U1)
    // The one behaviour a deck already on someone's disk depends on: after the
    // host swap its update check reaches THIS worker, with no Access cookie
    // and no assertion, and must come back with the Pages project's bytes
    // unaltered. Access is configured to Bypass these prefixes (KTD1), so the
    // worker sees the request with nothing attached at all.
    console.log('\npublic release-channel paths: served anonymously, byte-identical, from PAGES_ORIGIN')
    let r
    const PUBLIC_PATHS = [
      '/releases/slides/manifest.json', '/releases/slides/Bento_Slides.bento.html', '/releases/packs.json',
      '/templates/client-pitch.bento.html', '/templates/blank.bento.html',
      '/agents.md', '/slides/agents.md',
      '/skills/SKILL.md', '/skills/beta-slides.zip',
      '/logo/favicon-32.png',
      '/robots.txt', '/sitemap.xml', '/LICENSE',
    ]
    for (const p of PUBLIC_PATHS) {
      const before = proxied.length
      r = await call('GET', p) // no `as`: not one header of identity
      eq(r.status, 200, `GET ${p} with no assertion at all is 200`)
      eq(await r.text(), pagesBody(p), `GET ${p} returns the origin's exact bytes`)
      eq(proxied.length - before, 1, `GET ${p} made exactly one subrequest`)
      eq(new URL(proxied[proxied.length - 1].url).host, PAGES_ORIGIN, `GET ${p} fetched PAGES_ORIGIN, not its own host`)
    }
    r = await call('GET', '/releases/slides/manifest.json')
    eq(r.headers.get('content-type'), 'application/octet-stream', 'the upstream content-type survives the proxy')
    eq(r.headers.get('cache-control'), 'public, max-age=300', 'the upstream cache-control survives the proxy')
    ok(!r.headers.has('content-security-policy-report-only'), 'a pass-through carries none of the deck headers')

    console.log('\nthe proxy forwards no credential of ours (KTD3)')
    const sneaky = {
      'cf-access-jwt-assertion': tokens.alice,
      'cf-access-authenticated-user-email': 'alice@betamobility.io',
      'cf-access-client-id': 'id.access',
      'cf-access-client-secret': 'shhh',
      cookie: 'CF_Authorization=' + tokens.alice,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    }
    r = await call('GET', '/releases/slides/manifest.json', { headers: sneaky })
    eq(r.status, 200, 'a signed-in browser gets the same pass-through')
    const sub = proxied[proxied.length - 1].headers
    for (const h of ['cf-access-jwt-assertion', 'cf-access-authenticated-user-email', 'cf-access-client-id', 'cf-access-client-secret', 'cookie']) {
      ok(!(h in sub), `the subrequest carries no ${h}`)
    }
    eq(sub.accept, '*/*', 'the subrequest asks for */* whatever the browser asked for')
    ok(!JSON.stringify(sub).includes(tokens.alice), 'no assertion of ours reaches another origin in any header')

    console.log('\nupstream redirects and failures')
    r = await call('GET', '/releases/slides/redirected.html')
    eq(r.status, 200, 'an upstream 308 resolves to the final bytes, not a redirect')
    eq(await r.text(), pagesBody('/releases/slides/redirected'), 'and those bytes are the extensionless target’s')
    r = await call('GET', '/releases/slides/boom')
    eq(r.status, 502, 'an upstream 500 surfaces as the wrapper’s readable error')
    ok((await r.text()).length > 0, 'and that error says something')

    console.log('\na pass-through is not tracked (KTD7)')
    const eventsBefore = events.length
    await call('GET', '/releases/slides/manifest.json')
    await new Promise((res) => setTimeout(res, 60))
    eq(events.length, eventsBefore, 'no Plausible event fires for a release-channel fetch')

    // ------------------------------------------------ unknown kid, refresh once
    console.log('\nunknown key id: one JWKS refresh, then fail closed')
    const before = certsFetches
    const rogue = await sign(k2, 'k2', human('alice@betamobility.io'))
    r = await call('GET', '/api/decks', { as: rogue })
    eq(r.status, 401, 'a key the JWKS never carried is 401')
    eq(certsFetches - before, 1, 'exactly one JWKS refresh was attempted for the unknown kid')
    // Rotation: k3 appears in the JWKS, and the refresh picks it up.
    jwks.keys.push(await jwk('k3', k3))
    r = await call('GET', '/api/decks', { as: await sign(k3, 'k3', human('alice@betamobility.io')) })
    eq(r.status, 200, 'a freshly rotated key is accepted after the refresh')

    // --------------------------------------------------------------- create
    console.log('\ncreate and serve')
    const titled = deck(slidesDoc('Strategi 2026 for Bærum <script>alert(1)</script>'))
    r = await call('POST', '/api/decks', { as: 'alice', body: titled })
    eq(r.status, 201, 'POST /api/decks with a valid assertion is 201')
    const created = await r.json()
    ok(/^[0-9A-Za-z]{10}$/.test(created.id || ''), `id is 10 base62 chars (${created.id})`)
    eq(created.url, `${ORIGIN}/d/${created.id}`, 'url points at the serve route on the request origin')
    const id = created.id

    r = await call('GET', `/d/${id}`, { as: 'bob' })
    eq(r.status, 200, 'GET /d/:id by another valid identity is 200')
    ok(Buffer.compare(await bodyOf(r), Buffer.from(titled)) === 0, 'served bytes are byte-identical to the upload')
    eq(r.headers.get('content-type'), 'text/html; charset=utf-8', 'content-type is text/html; charset=utf-8')
    eq(r.headers.get('cache-control'), 'private, no-store', 'cache-control is private, no-store')
    eq(r.headers.get('x-content-type-options'), 'nosniff', 'x-content-type-options is nosniff')
    const csp = r.headers.get('content-security-policy-report-only') || ''
    ok(csp.length > 0, 'a report-only CSP ships with the deck')
    ok(!r.headers.has('content-security-policy'), 'no enforced CSP in v1.1 (KTD9)')
    for (const frag of ["script-src 'self' 'unsafe-inline' blob:", 'font-src', 'data:', 'img-src', 'media-src', 'connect-src', 'wss://sync.betamobility.ai', 'frame-src https:']) {
      ok(csp.includes(frag), `CSP carries ${frag}`)
    }
    // The release manifest is same-origin now that the store and the release
    // channel share a host, so `'self'` covers it and the literal is gone.
    ok(!csp.includes('https://slides.betamobility.ai'), 'the manifest host is no longer named as foreign in connect-src')
    ok(!csp.includes('report-to') && !csp.includes('report-uri'), 'CSP reports to the console only (no report endpoint in v1.1)')

    r = await call('GET', '/d/zzzzzzzzzz', { as: 'alice' })
    eq(r.status, 404, 'unknown id is 404')
    eq((await bodyOf(r)).length, 0, '404 carries no body')
    r = await call('GET', '/d/short', { as: 'alice' })
    eq(r.status, 404, 'a malformed id is 404 too')

    // ------------------------------------------------------- Plausible events
    console.log('\nanalytics: deck_open and deck_save carry surface and outcome only')
    ok(await waitFor(() => events.some((e) => e.body.name === 'deck_open')), 'a deck_open event reached Plausible')
    ok(await waitFor(() => events.some((e) => e.body.name === 'deck_save')), 'a deck_save event reached Plausible')
    const opens = events.filter((e) => e.body.name === 'deck_open' && e.body.props.outcome === 'ok')
    eq(opens.length, 1, 'exactly one successful deck_open so far')
    for (const e of events) {
      eq(e.body.domain, 'betamobility.ai', `${e.body.name}: posted to the betamobility.ai site`)
      eq(Object.keys(e.body.props).sort().join(','), 'outcome,surface', `${e.body.name}: props are surface and outcome, nothing else`)
      eq(e.body.props.surface, 'deck-store', `${e.body.name}: surface is deck-store`)
      const flat = JSON.stringify(e)
      ok(!flat.includes(id) && !flat.includes('Strategi') && !flat.includes('alice'), `${e.body.name}: no id, title or email leaves the worker`)
      eq(e.headers['user-agent'], 'rig/1.0', `${e.body.name}: forwards the caller's user agent`)
    }
    plausible = 'fail'
    r = await call('GET', `/d/${id}`, { as: 'alice' })
    eq(r.status, 200, 'a Plausible 500 does not fail the serve')
    plausible = 'throw'
    r = await call('GET', `/d/${id}`, { as: 'alice' })
    eq(r.status, 200, 'a Plausible network failure does not fail the serve')
    plausible = 'ok'

    // ---------------------------------------------------------------- list
    console.log('\nlist and index')
    await new Promise((res) => setTimeout(res, 20)) // distinct `updated` stamps
    r = await call('POST', '/api/decks', { as: 'bob', body: deck(slidesDoc('Second deck')) })
    const second = await r.json()
    r = await call('GET', '/api/decks', { as: 'alice' })
    eq(r.status, 200, 'GET /api/decks is 200')
    const list = (await r.json()).decks
    ok(Array.isArray(list) && list.length >= 2, `list carries every deck (${list?.length})`)
    eq(list[0].id, second.id, 'newest first')
    const mine = list.find((d) => d.id === id)
    eq(mine?.owner, 'alice@betamobility.io', 'list carries the owner')
    eq(mine?.writer, 'alice@betamobility.io', 'list carries the last writer')
    eq(mine?.title, 'Strategi 2026 for Bærum <script>alert(1)</script>', 'list carries the raw title (æøå intact)')
    eq(mine?.size, Buffer.byteLength(titled), 'list carries the size')
    ok(typeof mine?.updated === 'string' && !Number.isNaN(Date.parse(mine.updated)), 'list carries an ISO updated time')
    eq(mine?.url, `${ORIGIN}/d/${id}`, 'list carries the link')
    ok(list.every((d) => !('docId' in d) || typeof d.docId === 'string'), 'docId, when present, is a string')

    r = await call('GET', '/', { as: 'alice' })
    eq(r.status, 200, 'GET / is 200')
    const index = await r.text()
    ok(index.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'a script tag in a title renders inert on the index')
    ok(!index.includes('<script>alert(1)</script>'), 'the raw script tag is not in the index markup')
    ok(index.includes('Bærum'), 'the index shows æøå as typed')
    ok(index.includes(`/d/${id}`) && index.includes(`/d/${second.id}`), 'the index links every deck')
    ok(index.indexOf(`/d/${second.id}`) < index.indexOf(`/d/${id}`), 'the index lists newest first')
    ok(/<script[^>]+data-domain="betamobility\.ai"[^>]+plausible\.io/.test(index) || /<script[^>]+plausible\.io[^>]+data-domain="betamobility\.ai"/.test(index),
      'the index loads the Plausible script for betamobility.ai')
    eq(r.headers.get('content-type'), 'text/html; charset=utf-8', 'index is served as html')

    // -------------------------------------------- the index reads as a home
    console.log('\nthe index is where work starts (U4)')
    ok(/<a class="cta" href="\/new\/blank">/.test(index), 'a New deck action leads the page while the flag is on')
    ok(index.includes('/plugin marketplace add betamobility/slides'), 'the footer carries the plugin-install lines the landing page used to')
    ok(index.includes('/plugin install beta-slides@beta-slides'), 'both of them')
    // The deck links carry whatever origin served the request, so the check
    // that matters is the page's own prose: it no longer tells anyone where
    // the store lives, because the store lives where they already are.
    ok(!index.includes('Stored at decks.betamobility.ai'), 'and the footer no longer names the retired host')
    ok(index.indexOf('<th>Updated</th>') < index.indexOf('<th>Owner</th>'),
      'when it changed comes before who owns it')
    ok(!index.includes('<th>Kind</th>'), 'kind is no longer a column of its own')
    // Every deck so far is an ordinary deck, so no kind tag is drawn; the
    // encrypted and template decks below prove the other half.
    ok(!index.includes('class="kind"'), 'an ordinary deck carries no kind tag')

    // ----------------------------------------------------------------- put
    console.log('\nreplace')
    const edited = deck(slidesDoc('Strategi 2026 for Bærum, edited'))
    r = await call('PUT', `/api/decks/${id}`, { as: 'bob', body: edited })
    eq(r.status, 200, 'PUT by a different valid identity is 200')
    r = await call('GET', `/d/${id}`, { as: 'alice' })
    ok(Buffer.compare(await bodyOf(r), Buffer.from(edited)) === 0, 'the replaced bytes are served byte-identical')
    r = await call('GET', '/api/decks', { as: 'alice' })
    const after = (await r.json()).decks.find((d) => d.id === id)
    eq(after?.owner, 'alice@betamobility.io', 'PUT keeps the owner')
    eq(after?.writer, 'bob@betamobility.io', 'PUT records the writer')
    eq(after?.created, mine?.created, 'PUT keeps created')
    ok(Date.parse(after?.updated) > Date.parse(mine?.updated), 'PUT advances updated')
    eq(after?.title, 'Strategi 2026 for Bærum, edited', 'PUT refreshes the title')
    r = await call('PUT', '/api/decks/zzzzzzzzzz', { as: 'bob', body: edited })
    eq(r.status, 404, 'PUT on an unknown id is 404 (no upsert)')

    // ------------------------------------------------------ write validation
    console.log('\nwrite validation: 400 with a one-word reason')
    const cases = {
      'no #bento-doc block': ['<!doctype html><html><body><script>x</script></body></html>', 'block'],
      'two #bento-doc blocks': [minimal + '<script type="application/json" id="bento-doc">{}</script>', 'block'],
      'unparseable JSON': [minimal.replace('id="bento-doc">', 'id="bento-doc">{nope'), 'json'],
      'neither slides nor enc': [deck({ format: 'bento/spaces', v: 1 }), 'format'],
      'enc envelope missing iv': [deck({ format: 'bento/enc', v: 1, data: 'x', salt: 'y' }), 'format'],
      'enc envelope wrong v': [deck({ format: 'bento/enc', v: 2, data: 'x', salt: 'y', iv: 'z' }), 'format'],
      'empty body': ['', 'block'],
    }
    for (const [why, [body, reason]] of Object.entries(cases)) {
      for (const [m, p] of [['POST', '/api/decks'], ['PUT', `/api/decks/${id}`]]) {
        r = await call(m, p, { as: 'alice', body })
        eq(r.status, 400, `${why}: ${m} is 400`)
        eq((await r.text()).trim(), reason, `${why}: ${m} reason is one word`)
      }
    }
    const huge = deck(slidesDoc('Huge'), { pad: 'x'.repeat(MAX_BYTES) })
    ok(Buffer.byteLength(huge) > MAX_BYTES, `oversize fixture is over 32 MB (${Buffer.byteLength(huge)})`)
    r = await call('POST', '/api/decks', { as: 'alice', body: huge })
    eq(r.status, 400, 'a body over 32 MB is 400')
    eq((await r.text()).trim(), 'size', 'oversize reason is "size"')
    // The worker also refuses on a declared content-length over the cap
    // before reading the body; undici refuses to SEND a mismatched
    // content-length, so that fast path cannot be exercised from here and is
    // covered by the full-body case above.
    r = await call('GET', `/d/${id}`, { as: 'alice' })
    ok(Buffer.compare(await bodyOf(r), Buffer.from(edited)) === 0, 'a rejected PUT left the stored bytes untouched')

    // -------------------------------------------------------- enc envelope
    console.log('\nencrypted deck')
    const enc = deck(encEnvelope())
    r = await call('POST', '/api/decks', { as: 'alice', body: enc })
    eq(r.status, 201, 'a bento/enc envelope stores')
    const encId = (await r.json()).id
    r = await call('GET', `/d/${encId}`, { as: 'bob' })
    ok(Buffer.compare(await bodyOf(r), Buffer.from(enc)) === 0, 'the encrypted deck serves byte-identical')
    r = await call('GET', '/api/decks', { as: 'alice' })
    const encRow = (await r.json()).decks.find((d) => d.id === encId)
    eq(encRow?.kind, 'encrypted', 'the list marks it encrypted')
    ok(!('docId' in encRow) || encRow.docId === '', 'no docId is invented for an envelope')

    // ---------------------------------------------------------- delete
    console.log('\ndelete')
    r = await call('DELETE', `/api/decks/${id}`, { as: 'bob' })
    eq(r.status, 403, 'DELETE by a non-owner is 403')
    r = await call('GET', `/d/${id}`, { as: 'bob' })
    eq(r.status, 200, 'the deck is still there after the refused delete')
    r = await call('DELETE', `/api/decks/${id}`, { as: 'alice' })
    eq(r.status, 204, 'DELETE by the owner is 204')
    r = await call('GET', `/d/${id}`, { as: 'alice' })
    eq(r.status, 404, 'the deleted deck is gone')
    r = await call('DELETE', `/api/decks/${id}`, { as: 'alice' })
    eq(r.status, 404, 'DELETE on an unknown id is 404')

    // ------------------------------------------------------- service token
    console.log('\nservice token: harness routes only, identified by common_name')
    for (const [m, p, b] of [
      ['GET', '/api/decks'], ['GET', `/d/${second.id}`], ['DELETE', `/api/decks/${second.id}`],
      ['POST', '/api/decks', minimal], ['PUT', `/api/decks/${second.id}`, minimal], ['GET', '/'], ['GET', '/new'],
      // A read by id is the harness route's, never the people's (R10).
      ['HEAD', `/d/${second.id}`], ['GET', `/d/${second.id}/assets/map.png`],
    ]) {
      r = await call(m, p, { as: 'service', body: b })
      eq(r.status, 403, `service token on ${m} ${p} is 403`)
    }
    r = await call('POST', '/api/harness/decks', { as: 'service', body: deck(slidesDoc('From a harness')) })
    eq(r.status, 201, 'service token on POST /api/harness/decks is 201')
    const harnessId = (await r.json()).id
    r = await call('GET', `/api/harness/decks/${harnessId}`, { as: 'service' })
    r = await call('PUT', `/api/harness/decks/${harnessId}`, { as: 'service', body: deck(slidesDoc('From a harness, again')), headers: { 'if-match': r.headers.get('etag') } })
    eq(r.status, 200, 'service token on PUT /api/harness/decks/:id is 200')
    r = await call('GET', '/api/decks', { as: 'alice' })
    const hrow = (await r.json()).decks.find((d) => d.id === harnessId)
    eq(hrow?.owner, 'deadbeef.access', 'a service token with empty sub is recorded as owner by common_name')
    eq(hrow?.writer, 'deadbeef.access', 'and as writer')
    r = await call('POST', '/api/harness/decks', { as: await sign(k1, 'k1', service({ common_name: '' })) })
    eq(r.status, 401, 'a service assertion with neither email nor common_name is 401')
    r = await call('GET', `/api/harness/decks/${harnessId}`, { as: 'alice' })
    r = await call('PUT', `/api/harness/decks/${harnessId}`, { as: 'alice', body: deck(slidesDoc('Human on harness')), headers: { 'if-match': r.headers.get('etag') } })
    eq(r.status, 200, 'a human identity may use the harness deck routes (same handlers)')

    // ------------------------------- harness read, conditional replace (U1)
    // Plan docs/plans/2026-09-14-001-feat-runtime-slides-plan.md, KTD5. The
    // version is R2's httpEtag, never a field in customMetadata.
    console.log('\nharness read by id and conditional replace (U1, KTD5)')
    const versionA = deck(slidesDoc('Harness read, version A'))
    r = await call('POST', '/api/harness/decks', { as: 'service', body: versionA })
    const readId = (await r.json()).id
    r = await call('GET', `/api/harness/decks/${readId}`, { as: 'service' })
    eq(r.status, 200, 'service token GET /api/harness/decks/:id is 200')
    ok(Buffer.compare(await bodyOf(r), Buffer.from(versionA)) === 0, 'the harness read returns the stored bytes')
    eq(r.headers.get('content-type'), 'text/html; charset=utf-8', 'with the deck content type')
    eq(r.headers.get('cache-control'), 'private, no-store', 'and private, no-store')
    const etagA = r.headers.get('etag')
    ok(/^"[^"]+"$/.test(etagA || ''), `and a quoted ETag (${etagA})`)
    eq(r.headers.get('x-bento-etag'), etagA, 'and the same value as x-bento-etag (the edge drops etag from compressed HTML)')
    r = await call('GET', `/api/harness/decks/${readId}`, { as: 'service' })
    eq(r.headers.get('etag'), etagA, 'a second read returns the same ETag')
    r = await call('GET', '/api/harness/decks/zzzzzzzzzz', { as: 'service' })
    eq(r.status, 404, 'a harness read of an unknown id is 404')
    r = await call('GET', `/api/harness/decks/${second.id}`, { as: 'service' })
    eq(r.status, 200, 'a service token can read a deck a person created (read is not owner-scoped)')

    // AE2: Claude read A, a person saved B, Claude writes based on A.
    const versionB = deck(slidesDoc('Harness read, version B from a person'))
    r = await call('PUT', `/api/decks/${readId}`, { as: 'alice', body: versionB, headers: { 'if-match': etagA } })
    eq(r.status, 200, 'a person PUT with the current If-Match is 200')
    const etagB = r.headers.get('etag')
    ok(!!etagB && etagB !== etagA, `and answers the new ETag (${etagB})`)
    r = await call('PUT', `/api/harness/decks/${readId}`, { as: 'service', body: deck(slidesDoc('Claude, based on A')), headers: { 'if-match': etagA } })
    eq(r.status, 412, 'a harness PUT with a stale If-Match is 412 (AE2)')
    ok(/re-read/i.test(await r.text()), 'the 412 tells the caller to re-read')
    r = await call('GET', `/api/harness/decks/${readId}`, { as: 'service' })
    ok(Buffer.compare(await bodyOf(r), Buffer.from(versionB)) === 0, 'the refused PUT left version B stored, and the next read returns it')
    eq(r.headers.get('etag'), etagB, 'with version B\'s ETag')
    r = await call('PUT', `/api/harness/decks/${readId}`, { as: 'service', body: deck(slidesDoc('No If-Match')) })
    eq(r.status, 428, 'a harness PUT without If-Match is 428')
    r = await call('GET', `/api/harness/decks/${readId}`, { as: 'service' })
    eq(r.headers.get('etag'), etagB, 'the 428 wrote nothing')
    const versionC = deck(slidesDoc('Harness read, version C from Claude'))
    r = await call('PUT', `/api/harness/decks/${readId}`, { as: 'service', body: versionC, headers: { 'if-match': etagB } })
    eq(r.status, 200, 'a harness PUT with the current If-Match is 200')
    const etagC = r.headers.get('etag')
    ok(!!etagC && etagC !== etagB, 'and answers the new ETag')
    eq(r.headers.get('x-bento-etag'), etagC, 'and x-bento-etag on the PUT 200')
    r = await call('GET', `/api/harness/decks/${readId}`, { as: 'service' })
    ok(Buffer.compare(await bodyOf(r), Buffer.from(versionC)) === 0, 'the stored bytes changed')
    eq(r.headers.get('etag'), etagC, 'and the read carries the ETag the PUT answered')
    // The 412 says who wrote the version that won, and which version that is:
    // a live-synced editor may overwrite a person's save, never Claude's.
    r = await call('PUT', `/api/decks/${readId}`, { as: 'alice', body: deck(slidesDoc('Stale after Claude')), headers: { 'if-match': etagB } })
    eq(r.status, 412, 'a person PUT stale against a harness save is 412')
    eq((await r.json()).writer, 'service', 'and the 412 body says the current version was written by a service')
    eq(r.headers.get('etag'), etagC, 'and carries the current ETag')

    // The people route: If-Match honoured, never required (shells on disk).
    const versionD = deck(slidesDoc('Harness read, version D from an old shell'))
    r = await call('PUT', `/api/decks/${readId}`, { as: 'bob', body: versionD })
    eq(r.status, 200, 'a person PUT without If-Match is still 200')
    const etagD = r.headers.get('etag')
    ok(!!etagD && etagD !== etagC, 'and answers the new ETag')
    r = await call('PUT', `/api/decks/${readId}`, { as: 'alice', body: deck(slidesDoc('Stale editor')), headers: { 'if-match': etagC } })
    eq(r.status, 412, 'a person PUT with a stale If-Match is 412 (AE11 at the store)')
    eq(r.headers.get('etag'), etagD, 'the person 412 carries the current ETag')
    eq(r.headers.get('x-bento-etag'), etagD, 'and as x-bento-etag')
    eq((await r.json()).writer, 'person', 'and says the current version was written by a person')
    r = await call('GET', `/d/${readId}`, { as: 'alice' })
    ok(Buffer.compare(await bodyOf(r), Buffer.from(versionD)) === 0, 'the refused person PUT left the stored bytes untouched')
    eq(r.headers.get('etag'), etagD, 'GET /d/:id carries the ETag')
    eq(r.headers.get('x-bento-etag'), etagD, 'and as x-bento-etag')

    // Shape validation answers before any precondition.
    r = await call('PUT', `/api/harness/decks/${readId}`, { as: 'service', body: 'no doc block here', headers: { 'if-match': etagA } })
    eq(r.status, 400, 'a harness PUT failing the shape check is 400 even with a stale If-Match')
    r = await call('PUT', `/api/decks/${readId}`, { as: 'alice', body: 'no doc block here', headers: { 'if-match': etagA } })
    eq(r.status, 400, 'a person PUT failing the shape check is 400 even with a stale If-Match')

    // HEAD /d/:id is the editor's boot call (KTD12): headers, no body, no event.
    await waitFor(() => false, 150)
    const eventsBeforeHead = events.length
    r = await call('HEAD', `/d/${readId}`, { as: 'alice' })
    eq(r.status, 200, 'HEAD /d/:id is 200')
    eq(r.headers.get('etag'), etagD, 'HEAD carries the same ETag as GET')
    eq(r.headers.get('x-bento-etag'), etagD, 'and as x-bento-etag')
    eq(r.headers.get('content-type'), 'text/html; charset=utf-8', 'and the same content type')
    eq((await bodyOf(r)).length, 0, 'HEAD has no body')
    r = await call('HEAD', '/d/zzzzzzzzzz', { as: 'alice' })
    eq(r.status, 404, 'HEAD of an unknown id is 404')
    await waitFor(() => false, 150)
    eq(events.length, eventsBeforeHead, 'HEAD sends no analytics event')

    // Service generation (KTD12, the live retry). A 412 names only the LATEST
    // writer, so "Claude replaced it, then a person saved" reads as a person
    // write. `sg` in customMetadata counts service-token writes, and every
    // response that carries a deck ETag carries it too, so the editor can tell.
    console.log('\nservice generation: x-bento-service-gen')
    const GEN = 'x-bento-service-gen'
    r = await call('POST', '/api/decks', { as: 'alice', body: deck(slidesDoc('Gen, person-made')) })
    const genPerson = (await r.json()).id
    r = await call('HEAD', `/d/${genPerson}`, { as: 'alice' })
    eq(r.headers.get(GEN), '0', 'a person-created deck reports service generation 0')
    r = await call('POST', '/api/harness/decks', { as: 'service', body: deck(slidesDoc('Gen, service-made')) })
    const genId = (await r.json()).id
    r = await call('GET', `/api/harness/decks/${genId}`, { as: 'service' })
    eq(r.headers.get(GEN), '1', 'a service-created deck reports generation 1 on the harness GET')
    const genE1 = r.headers.get('etag')
    r = await call('GET', `/d/${genId}`, { as: 'alice' })
    eq(r.headers.get(GEN), '1', 'and on GET /d/:id')
    await bodyOf(r)
    r = await call('HEAD', `/d/${genId}`, { as: 'alice' })
    eq(r.headers.get(GEN), '1', 'and on HEAD /d/:id')
    r = await call('PUT', `/api/decks/${genId}`, { as: 'alice', body: deck(slidesDoc('Gen, person save')), headers: { 'if-match': genE1 } })
    eq(r.status, 200, 'a person save on it is 200')
    eq(r.headers.get(GEN), '1', 'a person write carries the generation forward unchanged')
    const genE2 = r.headers.get('etag')
    r = await call('PUT', `/api/harness/decks/${genId}`, { as: 'service', body: deck(slidesDoc('Gen, Claude replaces')), headers: { 'if-match': genE2 } })
    eq(r.status, 200, 'a service replace is 200')
    eq(r.headers.get(GEN), '2', 'a service write bumps the generation, and its 200 says so')
    const genE3 = r.headers.get('etag')
    r = await call('PUT', `/api/decks/${genId}`, { as: 'bob', body: deck(slidesDoc('Gen, person after Claude')), headers: { 'if-match': genE3 } })
    eq(r.headers.get(GEN), '2', 'a person write after it keeps generation 2')
    r = await call('PUT', `/api/decks/${genId}`, { as: 'alice', body: deck(slidesDoc('Gen, stale tab')), headers: { 'if-match': genE2 } })
    eq(r.status, 412, 'a tab still on the pre-Claude version is 412')
    eq((await r.json()).writer, 'person', 'the 412 names only the latest writer, a person')
    eq(r.headers.get(GEN), '2', 'but carries generation 2, so a tab holding 1 sees that Claude wrote in between')
    r = await call('HEAD', `/d/${genId}`, { as: 'alice' })
    eq(r.headers.get(GEN), '2', 'HEAD agrees')
    const genObj = await (await mf.getR2Bucket('DECKS')).head(`decks/${genId}.bento.html`)
    eq(genObj?.customMetadata?.sg, '2', 'the generation is stored in customMetadata as sg')

    // ------------------------------------------------ scene assets (U2)
    console.log('\nscene assets: harness upload, people read (U2, KTD6)')
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png body')])
    const assetPath = (deckId, name) => `/api/harness/decks/${deckId}/assets/${name}`
    r = await call('PUT', assetPath(readId, 'map.png'), { as: 'service', body: png, headers: { 'content-type': 'image/png' } })
    eq(r.status, 200, 'service token PUT of a PNG asset is 200')
    r = await call('GET', `/d/${readId}/assets/map.png`, { as: 'bob' })
    eq(r.status, 200, 'a person GET of the asset is 200')
    ok(Buffer.compare(await bodyOf(r), png) === 0, 'the asset bytes round-trip')
    eq(r.headers.get('content-type'), 'image/png', 'with the stored content type')
    eq(r.headers.get('cache-control'), 'private, no-cache', 'cache-control is private, no-cache (a re-upload is seen at once)')
    eq(r.headers.get('x-content-type-options'), 'nosniff', 'x-content-type-options is nosniff')
    eq(r.headers.get('content-security-policy'), 'sandbox', 'content-security-policy is sandbox')
    const assetEtag = r.headers.get('etag')
    ok(/^"[^"]+"$/.test(assetEtag || ''), `the asset GET carries a quoted ETag (${assetEtag})`)
    r = await call('GET', `/d/${readId}/assets/map.png`, { as: 'bob', headers: { 'if-none-match': assetEtag } })
    eq(r.status, 304, 'If-None-Match with the current ETag is 304')
    eq((await bodyOf(r)).length, 0, 'the 304 has no body')
    eq(r.headers.get('etag'), assetEtag, 'and repeats the ETag')
    const png2 = Buffer.concat([png, Buffer.from(' re-uploaded')])
    r = await call('PUT', assetPath(readId, 'map.png'), { as: 'service', body: png2, headers: { 'content-type': 'image/png' } })
    eq(r.status, 200, 'a re-upload of the asset is 200')
    r = await call('GET', `/d/${readId}/assets/map.png`, { as: 'bob', headers: { 'if-none-match': assetEtag } })
    eq(r.status, 200, 'after a re-upload, the old ETag gets a 200')
    ok(Buffer.compare(await bodyOf(r), png2) === 0, 'with the new bytes')
    ok(!!r.headers.get('etag') && r.headers.get('etag') !== assetEtag, 'and a new ETag')
    r = await call('PUT', assetPath(readId, 'map.png'), { as: 'service', body: png, headers: { 'content-type': 'image/png' } })
    r = await call('GET', `/d/${readId}/assets/nothere.png`, { as: 'bob' })
    eq(r.status, 404, 'an unknown asset is 404')

    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">' +
      '<script type="text/javascript">alert(2)</script><SCRIPT>alert(3)</SCRIPT>' +
      '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>' +
      '<rect width="10" height="10" fill="red" onclick=\'alert(4)\' onmouseover=alert(5) /><g/onfocus="alert(6)"></g>' +
      '<scr<script></script>ipt>alert(7)</script></svg>'
    r = await call('PUT', assetPath(readId, 'scene.svg'), { as: 'service', body: svg, headers: { 'content-type': 'image/svg+xml; charset=utf-8' } })
    eq(r.status, 200, 'service token PUT of an SVG asset is 200')
    r = await call('GET', `/d/${readId}/assets/scene.svg`, { as: 'alice' })
    const cleaned = await r.text()
    eq(r.headers.get('content-type'), 'image/svg+xml', 'the SVG serves as image/svg+xml')
    ok(!/<script/i.test(cleaned), 'the stored SVG carries no <script>')
    ok(!/foreignObject/i.test(cleaned), 'nor a foreignObject')
    ok(!/\son[a-z]+\s*=/i.test(cleaned), 'nor an on* handler attribute')
    ok(!/alert/.test(cleaned), 'and nothing of what they carried')
    ok(/<rect width="10" height="10" fill="red"/.test(cleaned) && /viewBox="0 0 10 10"/.test(cleaned), 'the drawing itself survives')

    for (const [name, why] of [['dir%2Fmap.png', 'an encoded slash'], ['dir/map.png', 'a slash'], ['a'.repeat(81), 'over 80 chars'], ['.hidden', 'a leading dot']]) {
      r = await call('PUT', assetPath(readId, name), { as: 'service', body: png, headers: { 'content-type': 'image/png' } })
      eq(r.status, 400, `an asset name with ${why} is 400`)
    }
    r = await call('PUT', assetPath(readId, 'a'.repeat(80)), { as: 'service', body: png, headers: { 'content-type': 'image/png' } })
    eq(r.status, 200, 'an 80-char asset name is fine')
    r = await call('PUT', assetPath('zzzzzzzzzz', 'map.png'), { as: 'service', body: png, headers: { 'content-type': 'image/png' } })
    eq(r.status, 404, 'an asset for an unknown deck is 404')
    for (const type of ['text/html', 'application/octet-stream', 'image/svg']) {
      r = await call('PUT', assetPath(readId, 'x.bin'), { as: 'service', body: png, headers: { 'content-type': type } })
      eq(r.status, 415, `an asset typed ${type} is 415`)
    }
    for (const type of ['image/jpeg', 'image/webp', 'application/json', 'text/csv; charset=utf-8']) {
      r = await call('PUT', assetPath(readId, 'ok.dat'), { as: 'service', body: 'x', headers: { 'content-type': type } })
      eq(r.status, 200, `an asset typed ${type} is accepted`)
    }
    r = await call('PUT', assetPath(readId, 'huge.png'), { as: 'service', body: Buffer.alloc(16 * 1024 * 1024 + 1), headers: { 'content-type': 'image/png' } })
    eq(r.status, 413, 'a 16 MB + 1 byte asset is 413')
    r = await call('GET', `/d/${readId}/assets/huge.png`, { as: 'alice' })
    eq(r.status, 404, 'and nothing was stored')
    r = await call('PUT', assetPath(readId, 'map.png'), { as: 'alice', body: png, headers: { 'content-type': 'image/png' } })
    eq(r.status, 403, 'a person cannot PUT to the harness asset route')

    // DELETE cascades: the deck's assets go with it, another deck's stay.
    r = await call('POST', '/api/decks', { as: 'alice', body: deck(slidesDoc('Deck with assets')) })
    const doomed = (await r.json()).id
    for (const name of ['one.png', 'two.png']) {
      r = await call('PUT', assetPath(doomed, name), { as: 'service', body: png, headers: { 'content-type': 'image/png' } })
      eq(r.status, 200, `asset ${name} uploaded for the deck about to be deleted`)
    }
    r = await call('DELETE', `/api/decks/${doomed}`, { as: 'alice' })
    eq(r.status, 204, 'the owner deletes the deck')
    for (const name of ['one.png', 'two.png']) {
      r = await call('GET', `/d/${doomed}/assets/${name}`, { as: 'alice' })
      eq(r.status, 404, `deleting the deck removed asset ${name}`)
    }
    r = await call('GET', `/d/${readId}/assets/map.png`, { as: 'alice' })
    eq(r.status, 200, 'another deck\'s assets are untouched')

    // ----------------------------------------------------------- /new page
    console.log('\nhandoff page')
    r = await call('GET', '/new', { as: 'alice' })
    eq(r.status, 200, 'GET /new is 200')
    const page = await r.text()
    ok(page.includes('bento-store-ready') && page.includes('bento-store-save') && page.includes('bento-store-saved'),
      'the page speaks the three message types of the handoff protocol')
    ok(page.includes('window.opener'), 'the page talks to its opener')
    // The upload must be reachable ONLY from the Save button. The page keeps
    // the whole upload in one function that only the click handler calls, and
    // the message handler never mentions the API. This is a static reading of
    // the script; the browser smoke in U8 is the behavioural check.
    const script = page.slice(page.indexOf('<script>'), page.lastIndexOf('</script>'))
    const apiCalls = script.match(/\/api\/decks/g) || []
    eq(apiCalls.length, 1, 'the page names the create route exactly once')
    const onMessage = script.slice(script.indexOf("addEventListener('message'"), script.indexOf('function save'))
    ok(onMessage.length > 0 && !onMessage.includes('fetch(') && !onMessage.includes('/api/decks'),
      'the message handler stores nothing: no fetch, no API route between receipt and save()')
    ok(/addEventListener\('click', save\)/.test(script),
      'save() is wired to the Save button click')
    ok(script.includes('e.source !== window.opener') || script.includes('e.source === window.opener'),
      'the page accepts a document from its opener only')
    ok(script.includes('received') , 'the page keeps a received flag so later documents are discarded')

    // ------------------------------------------------- /new creates a deck
    // The same page, second branch (KTD6). It runs only when there is NO
    // opener, so the handoff above is untouched by any of this.
    console.log('\nthe blank-deck create branch')
    ok(page.includes("location.replace('/new/blank')"), 'the create branch redirects to the worker route')
    ok(!script.includes('/templates/blank.bento.html'),
      'and does NOT pull the template into the tab any more — that is the worker’s job now')
    ok(!script.includes('mintDocIntoBlock'), 'nor carry an inlined copy of the minting logic')

    // THE PLACEMENT IS THE FEATURE. Deciding this at the bottom of the body
    // let the browser paint the whole handoff card — heading, Save button,
    // Close button, "keep this tab open" footer — before the redirect fired,
    // for the audience that card is not addressed to. It read as the fix not
    // having landed at all.
    const redirectAt = page.indexOf("location.replace('/new/blank')")
    ok(redirectAt !== -1 && redirectAt < page.indexOf('<main>'),
      'and it is decided BEFORE <main>, so the card is never parsed for that audience')
    ok(redirectAt < page.indexOf('id="save"'),
      'before the Save button that belongs to the other audience')
    ok(redirectAt < page.indexOf('The document stays in this tab'),
      'and before the footer telling them to keep a tab open')
    ok(page.indexOf('if (window.opener) return') < redirectAt,
      'an opener still wins: the handoff is tested before the redirect')

    // ------------------------------------------- GET /new/blank (the route)
    // What the index's New deck button and the redirect above both land on.
    // One navigation, one 302, no megabyte through the person's browser.
    console.log('\nGET /new/blank makes the deck server-side')
    const proxiedBefore = proxied.length
    r = await call('GET', '/new/blank', { as: 'alice' })
    eq(r.status, 302, 'GET /new/blank is a redirect, never a page')
    const madeUrl = r.headers.get('location')
    ok(/\/d\/[0-9A-Za-z]{10}$/.test(madeUrl || ''), 'it redirects straight to the new deck')
    eq(r.headers.get('cache-control'), 'no-store', 'and is never cached — every visit is a new deck')
    ok(proxied.slice(proxiedBefore).some((p) => new URL(p.url).pathname === '/templates/blank.bento.html'),
      'the worker read the blank template from PAGES_ORIGIN itself')
    const madeId = madeUrl.slice(madeUrl.lastIndexOf('/') + 1)
    r = await call('GET', `/d/${madeId}`, { as: 'alice' })
    eq(r.status, 200, 'the deck it made is served')
    const madeDoc = JSON.parse(/<script\b[^>]*\bid=["']?bento-doc["']?[^>]*>([\s\S]*?)<\/script>/i.exec(await r.text())[1])
    eq(madeDoc.format, 'bento/slides', 'and is a bento/slides document')
    ok(!('template' in madeDoc), 'with the template flag cleared')
    ok(!('collab' in madeDoc), 'and no inherited collab credentials')
    ok(typeof madeDoc.docId === 'string' && madeDoc.docId.length > 8, 'carrying a freshly minted docId')
    const madeRow = (await (await call('GET', '/api/decks', { as: 'alice' })).json()).decks.find((d) => d.id === madeId)
    eq(madeRow?.kind, 'deck', 'the store lists it as a deck, not a template')
    eq(madeRow?.owner, 'alice@betamobility.io', 'owned by whoever clicked New deck')

    // Two clicks, two decks. A shared identity here would mean two people's
    // first decks silently syncing with each other.
    r = await call('GET', '/new/blank', { as: 'bob' })
    const secondUrl = r.headers.get('location')
    ok(secondUrl !== madeUrl, 'a second create makes a genuinely different deck')

    r = await call('GET', '/new/blank', { origin: OLD_ORIGIN, as: 'alice' })
    eq(r.status, 301, 'on the retired host it redirects like everything else — no shipped file asks for it')

    console.log('\nthe blank template failing is a readable 502, never a broken deck')
    templateOutage = true
    r = await call('GET', '/new/blank', { as: 'alice' })
    eq(r.status, 502, 'a missing template answers 502')
    ok((await r.text()).includes('blank template'), 'and says which upstream failed')
    templateOutage = false

    // The real thing: run the page's own minting logic over the real blank
    // template and check what a colleague's first deck would actually be.
    const blankPath = join(repoRoot, 'beta', 'templates', 'blank.bento.html')
    if (existsSync(blankPath)) {
      const blank = readFileSync(blankPath, 'utf8')
      const minted = mintDocIntoBlock(blank, 'a-fresh-uuid-0001')
      const mm = /<script\b[^>]*\bid=["']?bento-doc["']?[^>]*>([\s\S]*?)<\/script>/i.exec(minted)
      ok(!!mm, 'the minted file still has one plaintext, extractable #bento-doc block')
      const mdoc = JSON.parse(mm[1])
      eq(mdoc.format, 'bento/slides', 'the minted document is a bento/slides document')
      eq(mdoc.docId, 'a-fresh-uuid-0001', 'it carries the docId that was minted into it')
      ok(!('template' in mdoc), 'the template flag is cleared, so it is a deck and not a template')
      ok(!('collab' in mdoc), 'and it carries no inherited collab credentials')
      eq(mdoc.slides.length, 1, 'one slide, the blank cover')
      // Through the worker's own validator, on the route the page posts to:
      // this is exactly what /new stores.
      r = await call('POST', '/api/decks?new=1', { as: 'alice', body: minted })
      eq(r.status, 201, 'the store accepts what the create branch would post')
      const mintedId = (await r.json()).id
      const mrow = (await (await call('GET', '/api/decks', { as: 'alice' })).json()).decks.find((d) => d.id === mintedId)
      eq(mrow?.kind, 'deck', 'and lists it as a deck, not a template')
      eq(mrow?.docId, 'a-fresh-uuid-0001', 'under the identity the page minted, so a reload finds the same deck')
    } else {
      console.log('  skip  beta/templates/blank.bento.html is not built here (node scripts/build-beta-templates.mjs); CI builds it first')
    }

    // A document whose CONTENT contains a closing script tag must not produce
    // one in the block. This is the rule that has broken shipped files before.
    const hostile = `<!doctype html><html><body><script type="application/bento+json" id="bento-doc">${
      JSON.stringify({ format: 'bento/slides', v: 1, template: true, title: 'x', slides: [{ id: 's', elements: [{ id: 'e', type: 'text', html: 'a </scr' + 'ipt><scr' + 'ipt>alert(1)</scr' + 'ipt> b' }] }] }).replace(/</g, '\\u003c')
    }</script></body></html>`
    const mintedHostile = mintDocIntoBlock(hostile, 'uuid-hostile')
    ok(!/<\/script\s*>/i.test(mintedHostile.slice(mintedHostile.indexOf('id="bento-doc"'), mintedHostile.lastIndexOf('</script>'))),
      'a closing script tag inside the document never survives into the block')
    ok(mintedHostile.includes('\\u003c/scr' + 'ipt'), 'it is escaped the way every builder in this repo escapes it')
    const rt = JSON.parse(/<script\b[^>]*\bid=["']?bento-doc["']?[^>]*>([\s\S]*?)<\/script>/i.exec(mintedHostile)[1])
    ok(rt.slides[0].elements[0].html.includes('</scr' + 'ipt>'), 'and the content itself survives the round trip intact')

    console.log('\ndeck_new')
    ok(await waitFor(() => events.some((e) => e.body.name === 'deck_new')), 'a deck_new event reached Plausible')
    for (const e of events.filter((e) => e.body.name === 'deck_new')) {
      eq(Object.keys(e.body.props).sort().join(','), 'outcome,surface', 'deck_new props are surface and outcome, nothing else')
      eq(e.body.props.surface, 'deck-store', 'deck_new surface is deck-store')
      ok(!JSON.stringify(e).includes('alice') && !JSON.stringify(e).includes('blank'), 'deck_new carries no email, id or path')
    }

    console.log('\nthe create branch is behind NEW_ENABLED; the handoff never is')
    await mf.setOptions({ ...mfOptions, bindings: { ...mfOptions.bindings, NEW_ENABLED: 'off' } })
    r = await call('GET', '/new', { as: 'alice' })
    eq(r.status, 200, 'with the flag off /new still answers — a shipped deck depends on it (KTD9)')
    const offBlank = await call('GET', '/new/blank', { as: 'alice' })
    eq(offBlank.status, 404, 'but /new/blank is gone: a typed URL cannot create what the index will not offer')
    const offPage = await r.text()
    ok(offPage.includes('bento-store-ready') && offPage.includes('window.opener'), 'and it is still the handoff page')
    ok(!offPage.includes("location.replace('/new/blank')"), 'but no-opener does not create')
    ok(offPage.includes('Open this page from a deck'), 'a person who arrives early is told what this page is for')
    r = await call('GET', '/', { as: 'alice' })
    const offIndex = await r.text()
    ok(!offIndex.includes('href="/new/blank"'), 'and the index offers no New deck link it cannot honour')
    ok(offIndex.includes('/plugin marketplace add betamobility/slides'), 'the footer is not flag-dependent')
    await mf.setOptions(mfOptions)
    r = await call('GET', '/new', { as: 'alice' })
    ok((await r.text()).includes("location.replace('/new/blank')"), 'and the flag flips back')

    // ------------------------------------------------- the real built shell
    // The synthetic deck above proves the contract; this proves the validator
    // accepts what the product actually writes (the shell's tooling comment
    // names #bento-doc in prose, and a comment-blind regex must not trip on
    // it). CI builds the shell before the Beta rigs; locally it may be absent.
    console.log('\nreal files round-trip (AE4)')
    const shellPath = join(repoRoot, 'slides', 'dist-single', 'Bento_Slides.bento.html')
    if (existsSync(shellPath)) {
      // The bare shell's #bento-doc is EMPTY (the starter deck is generated
      // at boot), so it is not a deck and must be refused as unparseable.
      r = await call('POST', '/api/decks', { as: 'alice', body: readFileSync(shellPath) })
      eq(r.status, 400, 'the bare shell (empty #bento-doc) is refused')
      eq((await r.text()).trim(), 'json', 'with reason "json"')
    } else {
      console.log('  skip  slides/dist-single/Bento_Slides.bento.html is not built here (npm run build:single); CI has it')
    }
    const templatePath = join(repoRoot, 'beta', 'templates', 'client-pitch.bento.html')
    if (existsSync(templatePath)) {
      const tpl = readFileSync(templatePath)
      r = await call('POST', '/api/decks', { as: 'alice', body: tpl })
      eq(r.status, 201, `a Beta template (${tpl.length} bytes, a real saved deck) is accepted`)
      const tplId = (await r.json()).id
      r = await call('GET', `/d/${tplId}`, { as: 'bob' })
      ok(Buffer.compare(await bodyOf(r), tpl) === 0, 'the template serves byte-identical')
      r = await call('GET', '/api/decks', { as: 'alice' })
      const srow = (await r.json()).decks.find((d) => d.id === tplId)
      eq(srow?.kind, 'template', 'the template is listed as a template')
      ok(typeof srow?.title === 'string' && srow.title.length > 0, `its title is read (${JSON.stringify(srow?.title)})`)
      // Templates carry no docId (the editor mints one at load), so none is invented.
      ok(!('docId' in srow), 'no docId is invented for a template that has none')
    } else {
      console.log('  skip  beta/templates/client-pitch.bento.html is not built here (node scripts/build-beta-templates.mjs); CI builds it first')
    }

    // ------------------------------------------------ metadata byte budget
    // Live R2 caps custom metadata at 2 KB of ENCODED bytes; Miniflare does
    // not enforce it, so the cap is asserted on what the worker stores.
    console.log('\nmetadata budget')
    const longTitle = '🚌'.repeat(400) + 'æøå'.repeat(100)
    r = await call('POST', '/api/decks', { as: 'alice', body: deck(slidesDoc(longTitle)) })
    eq(r.status, 201, 'an emoji-heavy 700-char title is accepted')
    const longId = (await r.json()).id
    const stored = await (await mf.getR2Bucket('DECKS')).head(`decks/${longId}.bento.html`)
    const metaBytes = Object.entries(stored.customMetadata).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v), 0)
    ok(metaBytes <= 2048, `stored custom metadata stays under R2's 2 KB budget (${metaBytes} bytes)`)
    ok(/^[A-Za-z0-9%._~-]*$/.test(stored.customMetadata.title), 'the stored title is ASCII (percent-encoded)')
    r = await call('GET', '/api/decks', { as: 'alice' })
    const lrow = (await r.json()).decks.find((d) => d.id === longId)
    ok(longTitle.startsWith(lrow.title) && lrow.title.length > 0, `the listed title is a clean prefix of the original (${lrow.title.length} chars)`)

    // ---------------------------------------------------------- misc routes
    // Rendered directly, because these two states are hard to reach live: an
    // empty store, and a deck the index should mark. Same function the route
    // calls.
    console.log('\nthe index empty state and the kind tag')
    const emptyIdx = indexPage([], 'alice@betamobility.io', { create: true })
    ok(emptyIdx.includes('class="empty"'), 'an empty store renders the empty state, not an empty table')
    ok(emptyIdx.includes('href="/new/blank"'), 'and it points at New deck')
    ok(!emptyIdx.includes('<table'), 'with no table at all')
    ok(indexPage([], 'alice@betamobility.io', { create: false }).includes('Save to Beta'),
      'with the flag off the empty state still says where a deck comes from')
    const tagged = indexPage([
      { id: 'x', url: '/d/x', title: 'A player', kind: 'player', owner: 'a@b.io', writer: 'a@b.io', updated: new Date().toISOString(), size: 10 },
      { id: 'y', url: '/d/y', title: 'A deck', kind: 'deck', owner: 'a@b.io', writer: 'a@b.io', updated: new Date().toISOString(), size: 10 },
    ], 'alice@betamobility.io', { create: true })
    ok(/class="kind">player</.test(tagged), 'a deck that is not an ordinary deck is tagged')
    eq((tagged.match(/class="kind"/g) || []).length, 1, 'and an ordinary one beside it is not')
    ok(indexPage([{ id: 'z', url: '/d/z', title: '<img src=x onerror=alert(1)>', kind: 'deck', owner: '', writer: '', updated: '', size: 0 }], 'a@b.io', {})
      .includes('&lt;img src=x onerror=alert(1)&gt;'), 'a title carrying markup is still escaped')

    // ------------------------------------------------------ the old host
    console.log('\nthe retired host redirects, except what a shipped deck needs (U6)')
    r = await call('GET', `/d/${second.id}`, { origin: OLD_ORIGIN })
    eq(r.status, 301, 'covers AE7: an old deck link is a 301')
    eq(r.headers.get('location'), `${ORIGIN}/d/${second.id}`, 'to the same path on the new host')
    eq((await bodyOf(r)).length, 0, 'and no deck bytes leave the old host')
    r = await call('GET', '/d/abc?x=1&y=%C3%A6', { origin: OLD_ORIGIN })
    eq(r.headers.get('location'), `${ORIGIN}/d/abc?x=1&y=%C3%A6`, 'the query survives the redirect intact')
    r = await call('GET', '/', { origin: OLD_ORIGIN })
    eq(r.status, 301, 'the old index redirects with no assertion in play at all')
    r = await call('GET', '/api/decks', { as: 'alice', origin: OLD_ORIGIN })
    eq(r.status, 301, 'and so does a signed-in request: the host is going away, not gated')

    // The two exemptions. Both exist because a shell already on disk drives
    // this flow and rejects an answer from any other origin (KTD9).
    r = await call('GET', '/new', { as: 'alice', origin: OLD_ORIGIN })
    eq(r.status, 200, '/new on the old host is NOT redirected')
    ok((await r.text()).includes('bento-store-ready'), 'and still serves the handoff page')
    r = await call('POST', '/api/decks', { as: 'alice', body: deck(slidesDoc('Handed off from an old shell')), origin: OLD_ORIGIN })
    eq(r.status, 201, 'and the upload that page makes is not redirected either')
    const handedOff = await r.json()
    // NOT canonicalized to the new host, deliberately. A 2026.9.2 shell
    // resolves the handoff only if the url startsWith the host IT opened
    // (slides/src/beta/store.ts, `bento-store-saved` — frozen code on
    // someone's disk). A canonical link would be silently ignored there and
    // the handoff would time out with the document discarded.
    eq(handedOff.url, `${OLD_ORIGIN}/d/${handedOff.id}`,
      'the link handed back is on the origin that was called, so a shipped shell accepts it')
    r = await call('GET', `/d/${handedOff.id}`, { as: 'alice' })
    eq(r.status, 200, 'and the deck is there, reachable on the new host')
    r = await call('GET', `/d/${handedOff.id}`, { origin: OLD_ORIGIN })
    eq(r.status, 301, 'while the old-host form of that link redirects, for as long as the host lives')

    console.log('\nthe create branch belongs to the store host')
    r = await call('GET', '/new', { as: 'alice', origin: OLD_ORIGIN })
    ok(!(await r.text()).includes("location.replace('/new/blank')"),
      'no create branch on the retired host: /new/blank there is a 301 the handoff audience must not be sent through')
    r = await call('GET', '/new', { as: 'alice' })
    ok((await r.text()).includes("location.replace('/new/blank')"), 'and it is there on the store host')
    // Narrow: only those two. A PUT is not part of the handoff.
    r = await call('PUT', `/api/decks/${handedOff.id}`, { as: 'alice', body: minimal, origin: OLD_ORIGIN })
    eq(r.status, 301, 'a PUT on the old host still redirects: the exemption is the handoff, not the API')
    r = await call('GET', '/new', { as: 'alice' })
    eq(r.status, 200, 'a request to the new host is never redirected')

    console.log('\nwith the flag off, the old host is exactly what it is today')
    await mf.setOptions({ ...mfOptions, bindings: { ...mfOptions.bindings, REDIRECT_OLD_HOST: 'off' } })
    r = await call('GET', `/d/${second.id}`, { origin: OLD_ORIGIN })
    eq(r.status, 401, 'no assertion is 401 again, not a redirect')
    r = await call('GET', `/d/${second.id}`, { as: 'alice', origin: OLD_ORIGIN })
    eq(r.status, 200, 'and a signed-in deck open still serves the deck')
    await mf.setOptions(mfOptions)

    // --------------------------------------------- the grant store (U1, KTD2/KTD3)
    //
    // A grant is an opaque bearer the store never keeps: KV holds sha256 of
    // it, so a dump between approval and delivery is worthless (AE9). These
    // checks call the module against Miniflare's real KV namespace, because
    // the routes that mint and verify grants land in U2 and U3.
    console.log('\nthe grant store: mint, verify, list, revoke (U1)')
    // A stub to a runtime object is POISONED by `mf.setOptions()`, so it is
    // re-acquired after every flag flip rather than held for the whole run
    // (Miniflare throws "Attempted to use poisoned stub" otherwise).
    let kv = await mf.getKVNamespace('GRANTS')
    let grantEnv = { GRANTS: kv }
    const refreshKv = async () => { kv = await mf.getKVNamespace('GRANTS'); grantEnv = { GRANTS: kv } }
    const bearer = (token) => ({ authorization: `Bearer ${token}` })
    const asReq = (headers) => new Request('https://slides.betamobility.ai/api/publish/decks', { headers })

    const g1 = await mintGrant(grantEnv, 'alice@betamobility.io', 'Claude (Cowork)')
    ok(typeof g1.token === 'string' && g1.token.length >= 43, 'a minted grant hands back a token')
    const id0 = await verifyGrant(asReq(bearer(g1.token)), grantEnv)
    eq(id0?.kind, 'grant', 'a minted grant verifies as a grant identity')
    eq(id0?.id, 'alice@betamobility.io', 'and carries the approving person, not a token name')
    ok(!(await verifyGrant(asReq(bearer(`${g1.token.slice(0, -1)}${g1.token.at(-1) === 'A' ? 'B' : 'A'}`)), grantEnv)),
      'a bearer with one character changed does not verify')
    ok(!(await verifyGrant(asReq({ authorization: 'Bearer' }), grantEnv)), 'a malformed Authorization header does not verify')
    ok(!(await verifyGrant(asReq({ authorization: `Basic ${g1.token}` }), grantEnv)), 'a non-Bearer scheme does not verify')
    ok(!(await verifyGrant(asReq({}), grantEnv)), 'no Authorization header does not verify')
    ok(!(await verifyGrant(asReq(bearer(g1.token)), {})), 'an unbound GRANTS namespace fails closed')

    // The raw token is in the caller's hands and nowhere else (R21, AE9).
    const dump = await kv.list({})
    let raws = 0
    for (const k of dump.keys) {
      const v = await kv.get(k.name)
      if (v && v.includes(g1.token)) raws++
    }
    eq(raws, 0, 'no KV value holds the raw token, only its hash')
    ok(dump.keys.some((k) => k.name === `grant:${g1.hash}`), 'the grant is keyed by its hash')

    // Expiry is the value's own clock, not only KV's TTL: a grant minted nine
    // hours ago is dead even while the key survives.
    const stale = await mintGrant(grantEnv, 'alice@betamobility.io', 'old', { now: Date.now() - 9 * 3600_000 })
    ok(await kv.get(`grant:${stale.hash}`), 'a stale grant can still be in KV')
    ok(!(await verifyGrant(asReq(bearer(stale.token)), grantEnv)), 'and does not verify: its stored exp has passed')

    const g2 = await mintGrant(grantEnv, 'alice@betamobility.io', 'second')
    const gb = await mintGrant(grantEnv, 'bob@betamobility.io', 'bobs')
    let myGrants = await listGrants(grantEnv, 'alice@betamobility.io')
    eq(myGrants.filter((x) => x.hash === gb.hash).length, 0, "alice's list does not carry bob's grant")
    ok(myGrants.some((x) => x.hash === g1.hash) && myGrants.some((x) => x.hash === g2.hash), 'alice sees both of her live grants')
    ok(myGrants.every((x) => typeof x.label === 'string' && typeof x.created === 'string' && Number.isFinite(x.exp)),
      'a listed grant carries its label, when it started and when it ends')
    // A prefix that is a prefix of a real address must not match it.
    eq((await listGrants(grantEnv, 'alice@')).length, 0, 'alice@ matches nothing: the list prefix ends at the colon')

    ok(await revokeGrant(grantEnv, 'alice@betamobility.io', g2.hash), 'a grant revokes')
    ok(!(await verifyGrant(asReq(bearer(g2.token)), grantEnv)), 'a revoked grant no longer verifies')
    myGrants = await listGrants(grantEnv, 'alice@betamobility.io')
    ok(!myGrants.some((x) => x.hash === g2.hash), 'and is gone from the list')
    ok(myGrants.some((x) => x.hash === g1.hash), 'while the other one is untouched')
    ok(!(await revokeGrant(grantEnv, 'bob@betamobility.io', g1.hash)), "bob cannot revoke alice's grant")
    ok(await verifyGrant(asReq(bearer(g1.token)), grantEnv), 'and it still verifies afterwards')
    ok(!(await revokeGrant(grantEnv, 'alice@betamobility.io', 'not-a-hash')), 'a hash-shaped nothing revokes nothing')

    // ------------------------------------- the two agent prefixes are fail-closed (U1)
    //
    // Access Bypasses /api/link/ and /api/publish/, so nothing verifies them
    // but this worker. Anything not exactly routed there is 401 with no body —
    // never 404, which would say whether a deck exists.
    console.log('\nthe agent prefixes: bearer or nothing, 401 with no body (U1, KTD4)')
    for (const [m2, p2] of [
      ['GET', '/api/link/'], ['GET', '/api/link'], ['POST', '/api/link'],
      ['GET', '/api/publish/'], ['GET', '/api/publish'],
      ['GET', '/api/publish/nowhere'], ['DELETE', `/api/publish/decks/${second.id}`],
      ['GET', '/api/publish/decks'], ['GET', '/api/link/start'],
    ]) {
      const rr = await call(m2, p2, { body: m2 === 'POST' ? '{}' : undefined })
      eq(rr.status, 401, `${m2} ${p2} with nothing attached is 401`)
      eq((await bodyOf(rr)).length, 0, `${m2} ${p2} 401 carries no body`)
    }
    // A person's cookie is not a credential here: these prefixes take a bearer.
    r = await call('GET', `/api/publish/decks/${second.id}`, { as: 'alice' })
    eq(r.status, 401, "a person's assertion on the publish path is 401: the prefix takes a bearer")
    r = await call('GET', `/api/publish/decks/${second.id}`)
    eq(r.status, 401, 'an anonymous read of a deck that exists is 401, the same as one that does not')
    r = await call('GET', '/api/publish/decks/0123456789')
    eq(r.status, 401, 'and a deck id that exists nowhere answers identically')
    // The other direction: a grant is not an identity on the gated routes.
    r = await call('GET', '/api/decks', { headers: bearer(g1.token) })
    eq(r.status, 401, 'a bearer on the gated API is 401: only Access speaks there')
    r = await call('GET', '/api/harness/decks/0123456789', { headers: bearer(g1.token) })
    eq(r.status, 401, 'and on the harness routes too')
    const grantEventsBefore = events.length
    await call('GET', '/api/publish/decks/0123456789', { headers: bearer(g1.token) })
    eq(events.length, grantEventsBefore, 'a refused agent request sends no analytics event')

    // ------------------------------------------------ pairing (U2, KTD1/KTD2/KTD13)
    //
    // The device-authorization flow: the agent starts a pairing with no
    // credential at all, the person approves it in the browser they are
    // already signed into, and the agent's poll collects a grant. Two values,
    // never one: whoever can see the approval URL holds the code, and only the
    // agent holds the handle the grant is delivered to.
    console.log('\npairing: start, the approval page, approve, poll (U2)')
    // Every scenario gets its own client IP: the rate limiter keys on it, so
    // sharing one would make an unrelated case trip the limit (KTD9).
    let ipN = 0
    const fromIp = () => ({ 'cf-connecting-ip': `10.0.0.${++ipN}` })
    const startPair = (label, { headers = {}, body } = {}) => call('POST', '/api/link/start', {
      headers: { 'content-type': 'application/json', ...fromIp(), ...headers },
      body: body !== undefined ? body : JSON.stringify(label === undefined ? {} : { label }),
    })
    const pollPair = (handle, extra = {}) => call('GET', `/api/link/${handle}`, { headers: { ...fromIp(), ...extra } })
    const nonceIn = (page) => (/name="nonce" value="([^"]+)"/.exec(page) || [])[1]
    const sameOrigin = { 'sec-fetch-site': 'same-origin' }
    // The value's own clock is what expires a pairing, so the rig can retire
    // one without waiting ten minutes. Only `exp` is touched.
    const expireKey = async (key) => {
      const v = JSON.parse(await kv.get(key))
      v.exp = Math.floor(Date.now() / 1000) - 5
      await kv.put(key, JSON.stringify(v))
    }

    r = await startPair('Claude (Cowork)')
    eq(r.status, 200, 'POST /api/link/start needs no credential of any kind')
    const pair = await r.json()
    ok(/^[0-9A-Za-z]{10}$/.test(pair.code), 'start hands back a ten-character code')
    ok(typeof pair.handle === 'string' && pair.handle.length >= 43, 'and a longer handle, which no person ever types')
    ok(pair.handle !== pair.code, 'the code and the handle are two different values (KTD1)')
    eq(pair.url, `${ORIGIN}/link/${pair.code}`, 'the approval URL is the code on the store host')
    ok(Number.isFinite(Date.parse(pair.expires)), 'and it says when the code dies')

    r = await pollPair(pair.handle)
    eq(r.status, 202, 'a poll before approval is 202')
    let pollBody = await r.text()
    ok(!/grant/i.test(pollBody) || !/[A-Za-z0-9_-]{43}/.test(pollBody), 'and carries no grant material')

    console.log('\nthe approval page: what it says, and what it refuses (U2, R3/R19)')
    r = await call('GET', `/link/${pair.code}`)
    eq(r.status, 401, 'the approval page is behind Access: no assertion is 401')
    r = await call('GET', `/link/${pair.code}`, { as: 'service' })
    eq(r.status, 403, 'and a service token is not a person: 403')
    r = await call('GET', `/link/${pair.code}`, { as: 'alice' })
    eq(r.status, 200, 'a signed-in person gets the page')
    const approvePage = await r.text()
    ok(approvePage.includes('publish decks as you'), 'it says what is being granted')
    ok(approvePage.includes('8 hours'), 'it says for how long')
    ok(approvePage.includes('Approve only if you asked an agent to publish in the last few minutes.'),
      'it says when not to approve')
    ok(approvePage.includes('&quot;Claude (Cowork)&quot;'), "the agent's label is shown as quoted, escaped text")
    ok(/Started/.test(approvePage), 'it says when the pairing was started')
    ok(approvePage.includes('alice@betamobility.io'), 'the page shows WHO would be granted: the signed-in identity')
    ok(!approvePage.includes(pair.handle), 'and never the handle, which is the agent’s alone')
    ok(!approvePage.includes('plausible.io'), 'no analytics on a page whose URL carries the code')
    eq(r.headers.get('x-frame-options'), 'DENY', 'the approval page cannot be framed')
    ok(/frame-ancestors 'none'/.test(r.headers.get('content-security-policy') || ''), 'and says so in CSP too')
    const nonce = nonceIn(approvePage)
    ok(!!nonce, 'the form carries a nonce')

    // AE7: a cross-site form carrying the person's session must not approve.
    r = await call('POST', `/link/${pair.code}/approve`, {
      as: 'alice', headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' },
      body: `nonce=${nonce}`,
    })
    eq(r.status, 403, 'approve from another site is 403, even with a valid session')
    r = await call('POST', `/link/${pair.code}/approve`, {
      as: 'alice', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
      body: `nonce=${nonce}`,
    })
    eq(r.status, 403, 'and a foreign Origin is 403 as well')
    r = await pollPair(pair.handle)
    eq(r.status, 202, 'after a refused cross-site approve the code is still pending')
    r = await call('POST', `/link/${pair.code}/approve`, {
      as: 'alice', headers: { ...sameOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'nonce=wrong',
    })
    eq(r.status, 403, 'approve with the wrong nonce is 403')
    r = await call('POST', `/link/${pair.code}/approve`, {
      as: 'alice', headers: { ...sameOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: '',
    })
    eq(r.status, 403, 'and approve with no nonce at all is 403')
    r = await call('POST', `/link/${pair.code}/approve`, {
      headers: { ...sameOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: `nonce=${nonce}`,
    })
    eq(r.status, 401, 'approve with no assertion is 401')
    r = await call('POST', `/link/${pair.code}/approve`, {
      as: 'service', headers: { ...sameOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: `nonce=${nonce}`,
    })
    eq(r.status, 403, 'approve with a service token is 403: only a person consents')

    console.log('\napproval, delivery, and the grant that comes out (U2, F1/AE9)')
    r = await call('POST', `/link/${pair.code}/approve`, {
      as: 'alice', headers: { ...sameOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: `nonce=${nonce}`,
    })
    eq(r.status, 200, 'alice approves, same-origin, with the nonce')
    const donePage = await r.text()
    ok(/close this tab/i.test(donePage), 'and is told she can close the tab')

    // AE9: approved, not yet polled — the namespace holds nothing usable.
    const beforeDelivery = await kv.list({})
    let usable = 0
    for (const k of beforeDelivery.keys) {
      const v = (await kv.get(k.name)) || ''
      for (const cand of v.match(/[A-Za-z0-9_-]{43}/g) || []) {
        if (await verifyGrant(asReq(bearer(cand)), grantEnv)) usable++
      }
    }
    eq(usable, 0, 'between approval and the first poll, no stored value is a usable grant (AE9)')

    r = await pollPair(pair.handle)
    eq(r.status, 200, 'the first poll after approval is 200')
    const delivered = await r.json()
    eq(delivered.owner, 'alice@betamobility.io', 'the grant names the person who approved')
    ok(Number.isFinite(Date.parse(delivered.expires)), 'and says when it ends')
    const aliceGrant = await verifyGrant(asReq(bearer(delivered.grant)), grantEnv)
    eq(aliceGrant?.id, 'alice@betamobility.io', 'the delivered grant verifies as alice')

    r = await pollPair(pair.handle)
    eq(r.status, 200, 'a second poll is still answered, so a dropped connection is not a silent loss')
    const second2 = await r.json()
    ok(!second2.grant, 'but it carries no grant: the raw token was never stored (R21)')
    r = await pollPair(pair.handle)
    eq(r.status, 410, 'a third poll is 410: the handle is gone')
    r = await pollPair('x'.repeat(43))
    eq(r.status, 410, 'an unknown handle is 410')

    console.log('\na pairing is single-use, and short-lived (U2, R4/F4)')
    r = await call('GET', `/link/${pair.code}`, { as: 'alice' })
    eq(r.status, 410, 'the code is single-use: its page is gone once approved')
    r = await call('POST', `/link/${pair.code}/approve`, {
      as: 'alice', headers: { ...sameOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: `nonce=${nonce}`,
    })
    eq(r.status, 410, 'and approving it a second time is 410')
    r = await call('GET', '/link/0000000000', { as: 'alice' })
    eq(r.status, 410, 'a code nobody minted is 410')

    const stalePair = await (await startPair('stale')).json()
    await expireKey(`link:${stalePair.code}`)
    r = await call('GET', `/link/${stalePair.code}`, { as: 'alice' })
    eq(r.status, 410, 'an expired code has no approval page')
    await expireKey(`handle:${stalePair.handle}`)
    r = await pollPair(stalePair.handle)
    eq(r.status, 410, 'and its handle polls 410, so the agent learns nobody approved (F4)')

    console.log('\nthe pairing values are not credentials anywhere else (AE4)')
    const unapproved = await (await startPair('unapproved')).json()
    for (const cred of [unapproved.code, unapproved.handle]) {
      const rr = await call('GET', '/api/publish/decks/0123456789', { headers: { authorization: `Bearer ${cred}` } })
      eq(rr.status, 401, 'a pairing code or handle used as a bearer on the publish path is 401')
    }

    console.log('\nthe start endpoint is public, so it is capped (U2, R5/KTD9)')
    r = await startPair(undefined, { body: 'not json' })
    eq(r.status, 400, 'a body that is not JSON is 400')
    r = await startPair(undefined, { headers: { 'content-type': 'text/plain' }, body: '{}' })
    eq(r.status, 400, 'a request that is not application/json is 400')
    r = await startPair(undefined, { body: JSON.stringify({ label: 'x'.repeat(200) }) })
    eq(r.status, 400, 'a label over 80 characters is 400')
    r = await startPair(undefined, { body: JSON.stringify({ label: 'a', pad: 'x'.repeat(2048) }) })
    eq(r.status, 400, 'a body over 1 KB is 400')
    r = await startPair(undefined, { body: JSON.stringify({}) })
    eq(r.status, 200, 'a start with no label at all is fine')
    r = await call('POST', '/api/link/start', { headers: { 'content-type': 'application/json', ...fromIp() }, body: JSON.stringify({ label: '<script>alert(1)</script>' }) })
    const evil = await r.json()
    r = await call('GET', `/link/${evil.code}`, { as: 'alice' })
    const evilPage = await r.text()
    ok(!evilPage.includes('<script>alert(1)</script>'), "a label's markup never reaches the page as markup")
    ok(evilPage.includes('&lt;script&gt;'), 'it is shown escaped, as what the agent called itself')

    console.log('\nthe rate limiter is required in production (U2, KTD9)')
    const burstIp = { 'cf-connecting-ip': '198.51.100.7' }
    let limited = 0
    for (let i = 0; i < 12; i++) {
      const rr = await call('POST', '/api/link/start', { headers: { 'content-type': 'application/json', ...burstIp }, body: '{}' })
      if (rr.status === 429) limited++
    }
    ok(limited > 0, 'a burst from one address is refused with 429')
    // A handle of the right SHAPE that names no pairing: the limiter answers
    // before the lookup, so the poll route is limited on the same key. (A
    // misshapen handle is the 401 above and never costs a KV read at all.)
    r = await call('GET', `/api/link/${'n'.repeat(43)}`, { headers: burstIp })
    eq(r.status, 429, 'and the poll route is limited on the same key')

    await mf.setOptions({ ...mfOptions, ratelimits: undefined })
    r = await call('POST', '/api/link/start', { headers: { 'content-type': 'application/json', ...fromIp() }, body: '{}' })
    eq(r.status, 503, 'with LINK_LIMIT_REQUIRED on and no binding, start is 503 rather than unguarded')
    await mf.setOptions({ ...mfOptions, ratelimits: undefined, bindings: { ...mfOptions.bindings, LINK_LIMIT_REQUIRED: 'off' } })
    r = await call('POST', '/api/link/start', { headers: { 'content-type': 'application/json', ...fromIp() }, body: '{}' })
    eq(r.status, 200, 'with the flag off (the rig, wrangler dev) it runs without one')
    await mf.setOptions(mfOptions)
    await refreshKv()

    console.log('\nthe index cannot be framed either (KTD13)')
    r = await call('GET', '/', { as: 'alice' })
    eq(r.headers.get('x-frame-options'), 'DENY', 'the index carries x-frame-options DENY')
    ok(/frame-ancestors 'none'/.test(r.headers.get('content-security-policy') || ''), 'and frame-ancestors none')

    // -------------------------------------------- what a grant reaches (U3, R8/R9)
    //
    // The reach of a signed-in partner, minus list and delete: create, read,
    // replace and asset upload, on any deck by id. Every "is this an agent
    // writing" branch must take the agent side, or a shipped editor — which
    // compares x-bento-service-gen and reads the 412 body's `writer` — would
    // retry over a grant's write.
    console.log('\nthe publish path: a grant acts as the person (U3)')
    const aliceTok = (await mintGrant(grantEnv, 'alice@betamobility.io', 'Claude (Cowork)')).token
    const bobTok = (await mintGrant(grantEnv, 'bob@betamobility.io', 'Claude (Cowork)')).token
    const asGrant = (token, extra = {}) => ({ authorization: `Bearer ${token}`, ...extra })
    const publish = (method, path, opts = {}) => call(method, path, opts)

    r = await publish('POST', '/api/publish/decks', { headers: asGrant(aliceTok), body: deck(slidesDoc('Fra Cowork')) })
    eq(r.status, 201, 'a grant creates a deck')
    const grantMade = await r.json()
    ok(/^[0-9A-Za-z]{10}$/.test(grantMade.id), 'and gets an id back')
    eq(grantMade.url, `${ORIGIN}/d/${grantMade.id}`, 'with the deck link')

    // AE2: the deck is the approving person's, on the index and in the API.
    r = await call('GET', '/api/decks', { as: 'alice' })
    const grantRow = (await r.json()).decks.find((d) => d.id === grantMade.id)
    eq(grantRow?.owner, 'alice@betamobility.io', 'the deck is owned by the person who approved, not by a token')
    eq(grantRow?.writer, 'grant:alice@betamobility.io', 'and the last writer says it was her agent')
    r = await call('GET', `/d/${grantMade.id}`, { as: 'alice' })
    eq(r.status, 200, 'she can open it in the browser')
    eq(r.headers.get('x-bento-service-gen'), '1', 'a grant create counts as a service generation')

    // R13: ownership is what makes a deck deletable, and the grant is not it.
    r = await call('DELETE', `/api/decks/${grantMade.id}`, { as: 'bob' })
    eq(r.status, 403, 'bob cannot delete a deck alice asked for')
    r = await call('DELETE', `/api/decks/${grantMade.id}`, { headers: asGrant(aliceTok) })
    eq(r.status, 401, 'and the grant itself cannot delete it: the prefix never reaches DELETE (AE5)')
    r = await call('GET', '/api/decks', { headers: asGrant(aliceTok) })
    eq(r.status, 401, 'nor list the store (AE5)')
    r = await call('GET', '/api/publish/decks', { headers: asGrant(aliceTok) })
    eq(r.status, 401, 'and there is no list route under the publish prefix either')

    console.log('\na grant reads and replaces any deck by id (U3, R8)')
    // A deck bob made in the browser, which alice's agent may still change:
    // four partners with equal access, from every surface.
    r = await call('POST', '/api/decks', { as: 'bob', body: deck(slidesDoc('Bobs deck')) })
    const bobs = await r.json()
    r = await publish('GET', `/api/publish/decks/${bobs.id}`, { headers: asGrant(aliceTok) })
    eq(r.status, 200, "alice's grant reads a deck bob created")
    const bobsEtag = r.headers.get('x-bento-etag')
    ok(!!bobsEtag, 'the read carries x-bento-etag, which is how a conditional write is possible')
    eq(r.headers.get('etag'), bobsEtag, 'and the plain etag beside it')
    const bobsRead = await r.text()
    r = await publish('PUT', `/api/publish/decks/${bobs.id}`, {
      headers: asGrant(aliceTok, { 'if-match': bobsEtag }), body: bobsRead,
    })
    eq(r.status, 200, 'and replaces it')
    eq(r.headers.get('x-bento-service-gen'), '1', 'bumping the service generation')
    r = await call('GET', '/api/decks', { as: 'bob' })
    const bobsRow = (await r.json()).decks.find((d) => d.id === bobs.id)
    eq(bobsRow?.owner, 'bob@betamobility.io', 'the deck stays bobs: a replace never moves ownership')
    eq(bobsRow?.writer, 'grant:alice@betamobility.io', "while the last writer is alice's agent")

    console.log('\nthe conditional-write contract is the harness one (U3, KTD8)')
    r = await publish('PUT', `/api/publish/decks/${grantMade.id}`, { headers: asGrant(aliceTok), body: deck(slidesDoc('No match')) })
    eq(r.status, 428, 'a grant replace without If-Match is 428, as on the harness route')
    r = await publish('PUT', `/api/publish/decks/${grantMade.id}`, {
      headers: asGrant(aliceTok, { 'if-match': '"nonsense"' }), body: deck(slidesDoc('Stale')),
    })
    eq(r.status, 412, 'a stale If-Match is 412')
    const conflict = await r.json()
    eq(conflict.writer, 'service', "and names the writer with the enum a shipped editor reads: a grant write is a 'service' write")
    ok(!!r.headers.get('x-bento-service-gen'), 'the 412 carries the generation header')
    ok(!!r.headers.get('x-bento-etag'), 'and the current etag')

    // The other direction: a person's save must still read as a person's.
    r = await call('GET', `/api/publish/decks/${grantMade.id}`, { headers: asGrant(aliceTok) })
    const madeEtag = r.headers.get('x-bento-etag')
    const madeRead = await r.text()
    // Her save must CHANGE the bytes: an R2 etag is a hash of the content, so
    // re-storing the same file would leave the version indistinguishable and
    // the conditional write below would pass for the wrong reason.
    r = await call('PUT', `/api/decks/${grantMade.id}`, { as: 'alice', body: deck(slidesDoc('Alice endret den')) })
    eq(r.status, 200, "a person's save after a grant write still needs no If-Match")
    eq(r.headers.get('x-bento-service-gen'), '1', 'and carries the generation forward rather than bumping it')
    r = await publish('PUT', `/api/publish/decks/${grantMade.id}`, {
      headers: asGrant(aliceTok, { 'if-match': madeEtag }), body: madeRead,
    })
    eq(r.status, 412, "a person's save between a grant's read and its write makes the write 412")
    const raced = await r.json()
    eq(raced.writer, 'person', 'and that 412 names a person, because a person wrote the version that won')

    console.log('\nscene assets: a grant uploads, a person still may not (U3)')
    r = await publish('PUT', `/api/publish/decks/${grantMade.id}/assets/points.json`, {
      headers: asGrant(aliceTok, { 'content-type': 'application/json' }), body: '[1,2,3]',
    })
    eq(r.status, 200, 'a grant uploads a scene asset')
    r = await call('PUT', `/api/publish/decks/${grantMade.id}/assets/points.json`, {
      as: 'alice', headers: { 'content-type': 'application/json' }, body: '[1,2,3]',
    })
    eq(r.status, 401, "a person's assertion is not a credential on the publish prefix")
    r = await call('PUT', `/api/harness/decks/${grantMade.id}/assets/points.json`, {
      as: 'alice', headers: { 'content-type': 'application/json' }, body: '[1,2,3]',
    })
    eq(r.status, 403, 'and the harness asset route still refuses a person (unchanged)')
    r = await publish('PUT', `/api/publish/decks/${grantMade.id}/assets/map.svg`, {
      headers: asGrant(aliceTok, { 'content-type': 'image/svg+xml' }),
      body: '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/decks")</script><rect/></svg>',
    })
    eq(r.status, 200, 'an svg uploads')
    r = await call('GET', `/d/${grantMade.id}/assets/map.svg`, { as: 'alice' })
    const svgOut = await r.text()
    ok(!/<script/i.test(svgOut), 'and the active parts are still stripped out of it')
    r = await publish('PUT', `/api/publish/decks/${grantMade.id}/assets/bad name.json`, {
      headers: asGrant(aliceTok, { 'content-type': 'application/json' }), body: '[]',
    })
    eq(r.status, 400, 'a bad asset name is still a 400, not a 404')

    console.log('\na dead grant is refused, and the bearer never comes back out (U3, F3/R21)')
    const deadGrant = await mintGrant(grantEnv, 'alice@betamobility.io', 'deadGrant')
    await revokeGrant(grantEnv, 'alice@betamobility.io', deadGrant.hash)
    r = await publish('POST', '/api/publish/decks', { headers: asGrant(deadGrant.token), body: deck(slidesDoc('Revoked')) })
    eq(r.status, 401, 'a revoked grant cannot create')
    eq((await bodyOf(r)).length, 0, 'and the refusal carries no body')
    const expiredGrant = await mintGrant(grantEnv, 'alice@betamobility.io', 'old', { now: Date.now() - 9 * 3600_000 })
    r = await publish('POST', '/api/publish/decks', { headers: asGrant(expiredGrant.token), body: deck(slidesDoc('Expired')) })
    eq(r.status, 401, 'an expired grant cannot create either (F3)')

    const leakCheck = [...events].map((e) => JSON.stringify(e)).join('\n')
    ok(!leakCheck.includes(aliceTok), 'no analytics event carries the bearer')
    r = await publish('PUT', `/api/publish/decks/0123456789`, { headers: asGrant(aliceTok, { 'if-match': 'x' }), body: deck(slidesDoc('Nope')) })
    eq(r.status, 404, 'a grant write to a deck that is not there is 404: the bearer verified, the deck did not exist')
    ok(!(await r.text()).includes(aliceTok), 'and no response body repeats the bearer')

    // ------------------------------- the block rewrite: strip, restore, pin (U8)
    //
    // The store's posture is "stream the stored bytes", and this is its ONE
    // exception: a grant's read is re-serialised with `collab` deleted, and a
    // grant's write has the stored `collab` put back before anything is
    // stored. The whole block, not the three private fields: room plus the
    // symmetric key is what `saveReaderCopy` writes, a reader capability that
    // would outlive the grant it came from.
    console.log('\ncollab is stripped on a grant read and restored on its write (U8, AE3)')
    const liveCollab = {
      on: true, room: 'w0123456789abcdef', key: 'c3ltbWV0cmljLWtleS1oZXJl',
      writerPub: 'cHViCg==', writerPriv: 'cHJpdgo=', ownerPriv: 'b3duZXItcHJpdgo=',
      invite: { pub: 'aW52aXRlLXB1Ygo=', priv: 'aW52aXRlLXByaXYK' },
      sync: { v: 2, regs: {} },
    }
    const withText = (title, text, extra = {}) => ({
      format: 'bento/slides', v: 1, docId: 'doc-collab-x', title,
      slides: [{ id: 's1', elements: [{ id: 't-01', type: 'text', x: 10, y: 10, w: 100, h: 20, html: text }] }],
      ...extra,
    })
    const liveBytes = deck(withText('Levende dekk', 'før', { collab: liveCollab }), { pad: 'shell-marker' })
    r = await call('POST', '/api/decks', { as: 'bob', body: liveBytes })
    const live = await r.json()

    r = await publish('GET', `/api/publish/decks/${live.id}`, { headers: asGrant(aliceTok) })
    eq(r.status, 200, 'a grant reads the deck')
    const strippedEtag = r.headers.get('x-bento-etag')
    const strippedSrc = await r.text()
    const strippedDoc = docOfHtml(strippedSrc)
    ok(!('collab' in strippedDoc), 'the document it receives has no collab key at all')
    eq(strippedDoc.slides[0].elements[0].html, 'før', 'the content is all there, æøå included')
    ok(Buffer.byteLength(strippedSrc) !== Buffer.byteLength(liveBytes), 'and is a different length from the stored object, because the block was rewritten')
    // The served body is WHOLE: `content-length` is computed from the
    // rewritten bytes rather than `obj.size`, and a stale length would
    // truncate a real client here. The header itself cannot be asserted from
    // this rig — MEASURED: workerd answers `transfer-encoding: chunked`
    // locally and drops content-length from every response, explicit or not —
    // so completeness is what is checked here and the header is checked over
    // real HTTP by scripts/check-store-live.mjs.
    ok(strippedSrc.trimEnd().endsWith('</html>'), 'the served file is complete, not truncated to the stored length')

    // Only the block may differ. Everything around it is the shell a browser
    // runs, and it is byte-identical.
    const shellOfHtml = (html) => html.replace(/(<script\b[^>]*\bid=["']?bento-doc["']?[^>]*>)[\s\S]*?(<\/script>)/i, '$1$2')
    eq(shellOfHtml(strippedSrc), shellOfHtml(liveBytes), 'the served bytes differ from the stored ones only inside the #bento-doc block')

    // A person's read is untouched: the exception is the grant path only.
    r = await call('GET', `/d/${live.id}`, { as: 'bob' })
    eq(await r.text(), liveBytes, "a person's read of the same deck is byte-identical to the upload")
    r = await call('GET', `/api/harness/decks/${live.id}`, { as: 'service' })
    ok((await r.text()).includes('ownerPriv'), 'and a service token still reads the whole file, unchanged')

    // AE3, the other half: the write back restores what was stripped.
    const grantEdited = writeBlockInto(strippedSrc, { ...strippedDoc, slides: [{ id: 's1', elements: [{ ...strippedDoc.slides[0].elements[0], html: 'etter' }] }] })
    r = await publish('PUT', `/api/publish/decks/${live.id}`, {
      headers: asGrant(aliceTok, { 'if-match': strippedEtag }), body: grantEdited,
    })
    eq(r.status, 200, 'and writes it back with one text element changed')
    r = await call('GET', `/d/${live.id}`, { as: 'bob' })
    const storedAfter = docOfHtml(await r.text())
    eq(storedAfter.slides[0].elements[0].html, 'etter', 'the change is stored')
    eq(JSON.stringify(storedAfter.collab), JSON.stringify(liveCollab),
      'and the collab block is back, value for value: room, key, both private keys, the invite and the sync state')

    console.log('\na deck with no live session never grows one (U8)')
    const bareBytes = deck(withText('Uten collab', 'a'))
    r = await call('POST', '/api/decks', { as: 'bob', body: bareBytes })
    const bare = await r.json()
    r = await publish('GET', `/api/publish/decks/${bare.id}`, { headers: asGrant(aliceTok) })
    const bareEtag = r.headers.get('x-bento-etag')
    const bareSrc = await r.text()
    ok(!('collab' in docOfHtml(bareSrc)), 'a grant read of a deck with no collab has none')
    r = await publish('PUT', `/api/publish/decks/${bare.id}`, {
      headers: asGrant(aliceTok, { 'if-match': bareEtag }), body: bareSrc,
    })
    eq(r.status, 200, 'the write back succeeds')
    r = await call('GET', `/d/${bare.id}`, { as: 'bob' })
    ok(!('collab' in docOfHtml(await r.text())), 'and no collab key was invented')

    console.log('\nthe shell is pinned: a grant changes the block and nothing else (U8, AE8)')
    r = await publish('GET', `/api/publish/decks/${live.id}`, { headers: asGrant(aliceTok) })
    const pinEtag = r.headers.get('x-bento-etag')
    const pinSrc = await r.text()
    const storedBefore = await (await call('GET', `/d/${live.id}`, { as: 'bob' })).text()
    for (const [what, body] of [
      ['one byte outside the block', pinSrc.replace('shell-marker', 'shell-markeR')],
      ['an added script', pinSrc.replace('</body>', '<script>fetch("/api/decks")</script></body>')],
      ['a changed title tag', pinSrc.replace('<title>t</title>', '<title>x</title>')],
    ]) {
      const rr = await publish('PUT', `/api/publish/decks/${live.id}`, {
        headers: asGrant(aliceTok, { 'if-match': pinEtag }), body,
      })
      eq(rr.status, 400, `a grant replace with ${what} is refused`)
      eq(await rr.text(), 'shell', 'with the one-word reason `shell`')
    }
    eq(await (await call('GET', `/d/${live.id}`, { as: 'bob' })).text(), storedBefore, 'and the stored bytes are untouched')
    // A person may still change the shell: that is how an update lands.
    r = await call('PUT', `/api/decks/${live.id}`, { as: 'bob', body: pinSrc.replace('shell-marker', 'a-new-shell') })
    eq(r.status, 200, "a person's save is not pinned: a shell update is what ⌘S after an update is")

    console.log('\nan encrypted deck is served and stored as it is (U8)')
    const encBytes = deck(encEnvelope())
    r = await call('POST', '/api/decks', { as: 'bob', body: encBytes })
    const encDeck = await r.json()
    r = await publish('GET', `/api/publish/decks/${encDeck.id}`, { headers: asGrant(aliceTok) })
    eq(r.status, 200, 'a grant may read an encrypted deck')
    const encEtag = r.headers.get('x-bento-etag')
    eq(await r.text(), encBytes, 'and gets the stored bytes unchanged: its keys are inside the ciphertext')
    r = await publish('PUT', `/api/publish/decks/${encDeck.id}`, {
      headers: asGrant(aliceTok, { 'if-match': encEtag }),
      body: deck({ ...encEnvelope(), data: 'Y2lwaGVyMg==' }),
    })
    eq(r.status, 200, 'and may replace one with another envelope, with nothing parsed or restored')
    // The format may not change under a grant: encrypting someone else's deck
    // would be as destructive as deleting it, which a grant cannot do either.
    r = await publish('GET', `/api/publish/decks/${bare.id}`, { headers: asGrant(aliceTok) })
    const flipEtag = r.headers.get('x-bento-etag')
    const flipSrc = await r.text()
    r = await publish('PUT', `/api/publish/decks/${bare.id}`, {
      headers: asGrant(aliceTok, { 'if-match': flipEtag }), body: shellOfHtml(flipSrc).replace(/(id=["']?bento-doc["']?[^>]*>)/i, `$1${JSON.stringify(encEnvelope()).replace(/</g, '\\u003c')}`),
    })
    eq(r.status, 400, 'a grant cannot turn a readable deck into an encrypted one')

    console.log('\nunmatched')
    r = await call('GET', '/nowhere', { as: 'alice' })
    eq(r.status, 404, 'an unknown path with a valid assertion is 404')
    r = await call('PATCH', `/api/decks/${second.id}`, { as: 'alice', body: minimal })
    eq(r.status, 404, 'an unsupported method on a known path is 404')
  } finally {
    await mf.dispose()
  }

  console.log(`\n${checks - failures}/${checks} checks passed`)
  return failures
}
