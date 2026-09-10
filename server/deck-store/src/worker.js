// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Beta deck store — a Cloudflare Worker at slides.betamobility.ai that keeps
// bento/slides files in R2 and serves them unchanged behind Cloudflare Access,
// and that passes the public release channel through to the Pages project.
// Plans: docs/plans/2026-09-08-002-feat-beta-slides-v1-1-plan.md U7 (KTD7 to
// KTD9, KTD12) and docs/plans/2026-09-10-001-feat-slides-host-swap-plan.md.
//
// Public, no assertion, proxied to PAGES_ORIGIN (KTD0):
//   GET /releases/… /templates/… /skills/… /logo/…
//   GET /agents.md /slides/agents.md /robots.txt /sitemap.xml /404.html /LICENSE
//
// Routes (every one behind a verified Access assertion; 401 with no body
// otherwise):
//   GET    /                       index page, every deck newest first
//   GET    /new                    handoff page for a deck on file://, and
//                                  (with NEW_ENABLED) the blank-deck create page
//   GET    /api/decks              list (metadata only)
//   POST   /api/decks              create → 201 {id, url}
//   PUT    /api/decks/:id          replace in place → 200
//   DELETE /api/decks/:id          owner only → 204
//   GET    /d/:id                  the stored bytes, streamed, unchanged
//   POST   /api/harness/decks      create, for service-token callers
//   PUT    /api/harness/decks/:id  replace, for service-token callers
//
// A person (any @betamobility.io identity) may read, list, create and replace
// anything; only DELETE is the owner's. A service token (Claude from a file
// harness) may only create and replace, and only on the harness routes, so a
// leaked token cannot list or read decks.
//
// The worker never reads into a document beyond the shape check on write:
// one #bento-doc block whose JSON parses and is a bento/slides document or a
// bento/enc envelope. Serving is a stream of the stored object.

import { verifyAccess } from './access.js'
import { indexPage, newPage } from './pages.js'

const MAX_BYTES = 32 * 1024 * 1024
const KEY = (id) => `decks/${id}.bento.html`
const ID_RE = /^[0-9A-Za-z]{10}$/
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
// Encoded bytes per metadata value. Title, owner, writer and docId share the
// 2048-byte object budget with the timestamps and kind; 512 each leaves room.
const META_MAX = 512

// Hosts the shell reaches from a stored deck, for the report-only CSP (KTD9).
// The relay is the fork's own (slides/src/main.ts). The release manifest used
// to be foreign and is now same-origin, so `'self'` covers it (2026-09-10 plan,
// U1) — the deck store and the release channel share a host.
const RELAY_HOST = 'sync.betamobility.ai'

// --- the public release channel (2026-09-10 plan, KTD0 to KTD3) -------------
//
// slides.betamobility.ai serves BOTH the gated deck store and the public
// release channel. Access is configured to Bypass the prefixes below, so a
// request for one of them reaches this worker with no assertion at all — and
// the worker passes it through to the Pages project that holds the signed
// bytes. Everything not on this list falls through to verifyAccess, so a path
// nobody thought about costs a login prompt, never a served deck.
//
// The match is a PREFIX BOUNDARY, not a substring: `/releases-secret` is
// gated. Reads only: a write to an allowlisted path is not a pass-through.
const PUBLIC_PREFIXES = ['/releases/', '/templates/', '/skills/', '/logo/']
const PUBLIC_PATHS = new Set([
  '/agents.md', '/slides/agents.md',
  '/robots.txt', '/sitemap.xml', '/404.html', '/LICENSE',
])
const isPublicPath = (path) => PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p))

// Credentials that must never leave this origin. The Access assertion is a
// bearer token bound to THIS application's audience; the cookie is the session
// it was minted from. Neither is any business of the Pages project.
const STRIP_FROM_SUBREQUEST = [
  'cf-access-jwt-assertion', 'cf-access-authenticated-user-email',
  'cf-access-client-id', 'cf-access-client-secret', 'cookie',
]

/**
 * THE one way this worker talks to the Pages origin. Every rule KTD3 names
 * lives here so a second call site cannot re-implement it and drop one:
 *
 *  · the host comes from `[vars]`, never from the incoming request — a worker
 *    on a Custom Domain that fetched its own hostname would re-invoke itself;
 *  · redirects are followed, because Pages 308s `.html` to extensionless;
 *  · the body is returned UNREAD and unmodified, so the manifest's sha256 pin
 *    over the shell still holds;
 *  · the Accept header is replaced with the any-type one, because
 *    Cloudflare's edge has been recorded injecting an analytics beacon into
 *    HTML fetched with a browser Accept header;
 *  · no `cf` cache options: whether they are honoured against another
 *    account's zone is undocumented, and the default is what Cloudflare
 *    recommends for a middleware fetch.
 *
 * An upstream failure surfaces as a readable 502 rather than a platform error,
 * the way server/sync-worker wraps its Durable Object subrequests.
 */
async function passThrough(req, env, url) {
  const origin = env.PAGES_ORIGIN
  if (!origin) return text(502, 'store: PAGES_ORIGIN is not configured')
  const headers = new Headers(req.headers)
  for (const h of STRIP_FROM_SUBREQUEST) headers.delete(h)
  headers.set('accept', '*/*')
  let res
  try {
    res = await fetch(`https://${origin}${url.pathname}${url.search}`, {
      method: req.method, headers, redirect: 'follow',
    })
  } catch (err) {
    return text(502, `store: the release channel origin did not answer (${err?.message || 'fetch failed'})`)
  }
  if (res.status >= 500) return text(502, `store: the release channel origin answered ${res.status}`)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers })
}

const PLAUSIBLE_URL = 'https://plausible.io/api/event'
const PLAUSIBLE_DOMAIN = 'betamobility.ai'

/** 10 base62 chars from getRandomValues, rejection-sampled so no char is favoured. */
function mintId() {
  let out = ''
  const buf = new Uint8Array(32)
  while (out.length < 10) {
    crypto.getRandomValues(buf)
    for (const b of buf) {
      if (b >= 248) continue // 248 = 62 * 4; drop the biased tail
      out += BASE62[b % 62]
      if (out.length === 10) break
    }
  }
  return out
}

// A wrangler [vars] flag. Vars are strings, so say what counts as on.
const flagOn = (v) => v === 'on' || v === 'true' || v === '1'

const empty = (status) => new Response(null, { status })
const text = (status, body) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' } })
const html = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } })

// --- write validation (shape only) ------------------------------------------

const DOC_BLOCK = /<script\b[^>]*\bid=["']?bento-doc["']?[^>]*>([\s\S]*?)<\/script>/gi

/**
 * Inspect an upload. Returns `{ reason }` (one word) on refusal, else the
 * metadata the shape yields. The bytes themselves are never modified.
 */
function inspect(bytes) {
  if (bytes.byteLength > MAX_BYTES) return { reason: 'size' }
  const src = new TextDecoder().decode(bytes)
  const blocks = [...src.matchAll(DOC_BLOCK)]
  if (blocks.length !== 1) return { reason: 'block' }
  let doc
  try {
    doc = JSON.parse(blocks[0][1])
  } catch {
    return { reason: 'json' }
  }
  if (!doc || typeof doc !== 'object') return { reason: 'json' }
  if (doc.format === 'bento/enc') {
    if (doc.v === 1 && doc.data && doc.salt && doc.iv) return { title: 'Encrypted deck', docId: '', kind: 'encrypted' }
    return { reason: 'format' }
  }
  if (doc.format === 'bento/slides') {
    const title = typeof doc.title === 'string' ? doc.title : ''
    const kind = doc.readonly ? 'player' : doc.template ? 'template' : 'deck'
    return { title, docId: typeof doc.docId === 'string' ? doc.docId : '', kind }
  }
  return { reason: 'format' }
}

/** Read the body with the size cap enforced before the bytes are parsed. */
async function readBody(req) {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BYTES) return null
  const bytes = await req.arrayBuffer()
  return bytes
}

// R2 custom metadata is header-valued and capped at 2 KB in total, and the
// cap is on the ENCODED bytes (Miniflare does not enforce it, live R2 does):
// percent-encode so a title with æøå or a quote survives, then bound the
// encoded length, cutting only at a `%` boundary so no escape is split.
const encMeta = (s) => {
  let out = encodeURIComponent(String(s ?? ''))
  if (out.length <= META_MAX) return out
  // Trim by code point, never by encoded char: a cut inside a multi-byte
  // sequence (an emoji is four escapes) would not decode at all.
  const cps = [...String(s)].slice(0, META_MAX)
  while (cps.length && (out = encodeURIComponent(cps.join(''))).length > META_MAX) cps.pop()
  return out
}
const decMeta = (s) => { try { return decodeURIComponent(s || '') } catch { return '' } }

function rowOf(obj, origin) {
  const id = obj.key.slice('decks/'.length, -'.bento.html'.length)
  const m = obj.customMetadata || {}
  const row = {
    id, url: `${origin}/d/${id}`,
    title: decMeta(m.title), kind: m.kind || 'deck',
    owner: decMeta(m.owner), writer: decMeta(m.writer),
    created: m.created || '', updated: m.updated || obj.uploaded?.toISOString?.() || '',
    size: obj.size,
  }
  if (m.docId) row.docId = decMeta(m.docId)
  return row
}

async function listDecks(env, origin) {
  const rows = []
  let cursor
  do {
    const page = await env.DECKS.list({ prefix: 'decks/', cursor, include: ['customMetadata'] })
    for (const o of page.objects) if (o.key.endsWith('.bento.html')) rows.push(rowOf(o, origin))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  rows.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0))
  return rows
}

// --- analytics (KTD12): server-side, surface + outcome, nothing else -------

function track(ctx, req, name, outcome) {
  const origin = new URL(req.url).origin
  const body = JSON.stringify({
    name, domain: PLAUSIBLE_DOMAIN,
    url: `${origin}/${name === 'deck_open' ? 'd/' : 'api/decks'}`,
    props: { surface: 'deck-store', outcome },
  })
  const p = fetch(PLAUSIBLE_URL, {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', 'user-agent': req.headers.get('user-agent') || 'beta-decks' },
  }).then(() => undefined, () => undefined) // a failed event never fails the response
  ctx.waitUntil(p)
}

// --- handlers -----------------------------------------------------------------

// `evt` is the analytics name: a deck made at /new is a deck_new, every other
// create is a deck_save. Nothing else about the two paths differs.
async function create(req, env, ctx, who, evt = 'deck_save') {
  const bytes = await readBody(req)
  if (!bytes) { track(ctx, req, evt, 'rejected'); return text(400, 'size') }
  const meta = inspect(bytes)
  if (meta.reason) { track(ctx, req, evt, 'rejected'); return text(400, meta.reason) }
  const id = mintId()
  const now = new Date().toISOString()
  await env.DECKS.put(KEY(id), bytes, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
    customMetadata: {
      title: encMeta(meta.title), docId: encMeta(meta.docId), kind: meta.kind,
      owner: encMeta(who.id), writer: encMeta(who.id), created: now, updated: now,
    },
  })
  track(ctx, req, evt, 'ok')
  return json(201, { id, url: `${new URL(req.url).origin}/d/${id}` })
}

async function replace(req, env, ctx, who, id) {
  const existing = await env.DECKS.head(KEY(id))
  if (!existing) return empty(404)
  const bytes = await readBody(req)
  if (!bytes) { track(ctx, req, 'deck_save', 'rejected'); return text(400, 'size') }
  const meta = inspect(bytes)
  if (meta.reason) { track(ctx, req, 'deck_save', 'rejected'); return text(400, meta.reason) }
  const prev = existing.customMetadata || {}
  await env.DECKS.put(KEY(id), bytes, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
    customMetadata: {
      title: encMeta(meta.title), docId: encMeta(meta.docId), kind: meta.kind,
      owner: prev.owner || encMeta(who.id), writer: encMeta(who.id),
      created: prev.created || new Date().toISOString(), updated: new Date().toISOString(),
    },
  })
  track(ctx, req, 'deck_save', 'ok')
  return empty(200)
}

async function remove(env, who, id) {
  const existing = await env.DECKS.head(KEY(id))
  if (!existing) return empty(404)
  if (decMeta(existing.customMetadata?.owner) !== who.id) return empty(403)
  await env.DECKS.delete(KEY(id))
  return empty(204)
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' https: data: blob:",
  "media-src 'self' https: data: blob:",
  `connect-src 'self' https://${RELAY_HOST} wss://${RELAY_HOST}`,
  'frame-src https:',
  'worker-src blob:',
  "object-src 'none'",
  "base-uri 'self'",
].join('; ')

async function serve(env, ctx, req, id) {
  const obj = await env.DECKS.get(KEY(id))
  if (!obj) { track(ctx, req, 'deck_open', 'missing'); return empty(404) }
  track(ctx, req, 'deck_open', 'ok')
  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(obj.size),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy-report-only': CSP,
    },
  })
}

// --- router --------------------------------------------------------------------

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)
    const path = url.pathname
    const m = req.method

    // The public release channel comes first, and it is the ONLY thing that
    // does. These paths are anonymous machine traffic from files already on
    // people's disks (KTD0); Access is configured to Bypass them, so there is
    // no assertion here to verify and nothing to verify it against.
    if (isPublicPath(path) && (m === 'GET' || m === 'HEAD')) return passThrough(req, env, url)

    // Identity next, before any routing of our own: an unknown path without an
    // assertion is 401, not 404, so nothing about the store is enumerable
    // without Access. Enumerability now stops at the allowlist above, and
    // that list is reads of maintainer-published bytes only.
    const who = await verifyAccess(req, env)
    if (!who) return empty(401)

    // Harness routes: same handlers, open to any verified identity.
    if (path === '/api/harness/decks' && m === 'POST') return create(req, env, ctx, who)
    const hm = /^\/api\/harness\/decks\/([0-9A-Za-z]{10})$/.exec(path)
    if (hm && m === 'PUT') return replace(req, env, ctx, who, hm[1])

    // Everything else is for people. A service token stops here.
    if (who.kind !== 'user') return empty(403)

    if (path === '/' && m === 'GET') return html(indexPage(await listDecks(env, url.origin), who.id))
    if (path === '/new' && m === 'GET') return html(newPage(who.id, { create: flagOn(env.NEW_ENABLED) }))
    if (path === '/api/decks' && m === 'GET') return json(200, { decks: await listDecks(env, url.origin) })
    if (path === '/api/decks' && m === 'POST') return create(req, env, ctx, who, url.searchParams.get('new') === '1' ? 'deck_new' : 'deck_save')
    const dm = /^\/api\/decks\/([0-9A-Za-z]{10})$/.exec(path)
    if (dm && m === 'PUT') return replace(req, env, ctx, who, dm[1])
    if (dm && m === 'DELETE') return remove(env, who, dm[1])
    const sm = /^\/d\/([0-9A-Za-z]{10})$/.exec(path)
    if (sm && m === 'GET') return serve(env, ctx, req, sm[1])

    return empty(404)
  },
}
