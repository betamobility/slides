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

const subtle = webcrypto.subtle
const here = dirname(fileURLToPath(import.meta.url))

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

  /** What the stub Pages project serves at `path`. Deterministic, per-path. */
  const pagesBody = (path) => `stub bytes for ${path}\n${'x'.repeat(64)}\n`

  const mf = new Miniflare({
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
    bindings: {
      ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUDS: `${HUMAN_AUD},${SERVICE_AUD}`,
      PAGES_ORIGIN,
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
        return new Response(pagesBody(p), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=300', 'etag': '"stub"' },
        })
      }
      // A THROW, not a 502: the error-wrapper scenario asserts a 502, so a
      // stub that answered 502 here would let a misdirected subrequest pass.
      throw new Error(`unexpected outbound fetch: ${req.url}`)
    },
  })

  const ORIGIN = 'https://decks.betamobility.ai'
  const tokens = {
    alice: await sign(k1, 'k1', human('alice@betamobility.io')),
    bob: await sign(k1, 'k1', human('bob@betamobility.io')),
    service: await sign(k1, 'k1', service()),
  }
  /** Dispatch a request; `as` names a canned identity or is a raw assertion string. */
  async function call(method, path, { as, body, headers = {} } = {}) {
    const h = { 'user-agent': 'rig/1.0', ...headers }
    if (as) h['cf-access-jwt-assertion'] = tokens[as] || as
    return mf.dispatchFetch(ORIGIN + path, { method, headers: h, body })
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
      // A prefix-boundary match, not a substring one: these start like an
      // allowlisted prefix and are gated all the same (KTD0).
      ['GET', '/releases-secret'], ['GET', '/releases-secret/manifest.json'], ['GET', '/templates-private/x'],
      ['GET', '/agents.md.bak'], ['GET', '/skills'],
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
      '/robots.txt', '/sitemap.xml', '/404.html', '/LICENSE',
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
    ]) {
      r = await call(m, p, { as: 'service', body: b })
      eq(r.status, 403, `service token on ${m} ${p} is 403`)
    }
    r = await call('POST', '/api/harness/decks', { as: 'service', body: deck(slidesDoc('From a harness')) })
    eq(r.status, 201, 'service token on POST /api/harness/decks is 201')
    const harnessId = (await r.json()).id
    r = await call('PUT', `/api/harness/decks/${harnessId}`, { as: 'service', body: deck(slidesDoc('From a harness, again')) })
    eq(r.status, 200, 'service token on PUT /api/harness/decks/:id is 200')
    r = await call('GET', '/api/decks', { as: 'alice' })
    const hrow = (await r.json()).decks.find((d) => d.id === harnessId)
    eq(hrow?.owner, 'deadbeef.access', 'a service token with empty sub is recorded as owner by common_name')
    eq(hrow?.writer, 'deadbeef.access', 'and as writer')
    r = await call('POST', '/api/harness/decks', { as: await sign(k1, 'k1', service({ common_name: '' })) })
    eq(r.status, 401, 'a service assertion with neither email nor common_name is 401')
    r = await call('PUT', `/api/harness/decks/${harnessId}`, { as: 'alice', body: deck(slidesDoc('Human on harness')) })
    eq(r.status, 200, 'a human identity may use the harness routes (same handlers)')

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

    // ------------------------------------------------- the real built shell
    // The synthetic deck above proves the contract; this proves the validator
    // accepts what the product actually writes (the shell's tooling comment
    // names #bento-doc in prose, and a comment-blind regex must not trip on
    // it). CI builds the shell before the Beta rigs; locally it may be absent.
    console.log('\nreal files round-trip (AE4)')
    const repo = join(here, '..', '..', '..')
    const shellPath = join(repo, 'slides', 'dist-single', 'Bento_Slides.bento.html')
    if (existsSync(shellPath)) {
      // The bare shell's #bento-doc is EMPTY (the starter deck is generated
      // at boot), so it is not a deck and must be refused as unparseable.
      r = await call('POST', '/api/decks', { as: 'alice', body: readFileSync(shellPath) })
      eq(r.status, 400, 'the bare shell (empty #bento-doc) is refused')
      eq((await r.text()).trim(), 'json', 'with reason "json"')
    } else {
      console.log('  skip  slides/dist-single/Bento_Slides.bento.html is not built here (npm run build:single); CI has it')
    }
    const templatePath = join(repo, 'beta', 'templates', 'client-pitch.bento.html')
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
