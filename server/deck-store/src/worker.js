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
//   PUT    /api/decks/:id          replace in place → 200 + ETag; If-Match
//                                  honoured when sent (412), never required;
//                                  a 412 carries the current ETag and writer
//                                  (every deck ETag travels with
//                                  x-bento-service-gen, see GEN_HEADER)
//   DELETE /api/decks/:id          owner only → 204, the deck's assets with it
//   GET    /d/:id                  the stored bytes, streamed, unchanged, + ETag
//   HEAD   /d/:id                  the same headers, no body (the editor's boot)
//   GET    /d/:id/assets/:name     a scene asset, sandboxed, no-cache + ETag
//                                  (If-None-Match → 304)
//   POST   /api/harness/decks      create, for service-token callers
//   GET    /api/harness/decks/:id  read by id + ETag, for service-token callers
//   PUT    /api/harness/decks/:id  replace; If-Match REQUIRED (428), stale → 412
//   PUT    /api/harness/decks/:id/assets/:name
//                                  upload a scene asset, service token only
//   GET    /link/:code             the approval page for a pairing
//   POST   /link/:code/approve     record the consent; same-origin + nonce
//   POST   /api/grants/:hash/revoke
//                                  end one of your own grants; same-origin
//
// Public, no assertion, verified by THIS WORKER rather than by Access (the
// agent prefixes; see "the agent prefixes" below):
//   POST   /api/link/start         begin a pairing → {code, handle, url, expires}
//   GET    /api/link/:handle       the agent's poll → 202 | 200 + grant | 410
//   POST   /api/publish/decks      create, as the person who approved
//   GET    /api/publish/decks/:id  read by id, with `collab` removed
//   PUT    /api/publish/decks/:id  replace; If-Match REQUIRED, `collab`
//                                  restored, the shell pinned
//   PUT    /api/publish/decks/:id/assets/:name    upload a scene asset
//
// A person (any @betamobility.io identity) may read, list, create and replace
// anything; only DELETE is the owner's. A service token (Claude from a file
// harness) may create, read a deck whose id it already knows, replace
// conditionally and upload assets, and only on the harness routes. It cannot
// list, so a leaked token cannot enumerate anyone's work — but a read hands
// over the whole file, including the deck's live-session owner keys.
// Plan: docs/plans/2026-09-14-001-feat-runtime-slides-plan.md U1, U2 (KTD5,
// KTD6).
//
// A GRANT is the third identity (one-click publish plan): a bearer a person
// approved in the browser, good for eight hours, that acts as them on the
// publish prefix. It reaches create, read, replace and asset upload on any
// deck by id — never list, never delete — and what it reads carries no
// `collab` block at all, so it holds no live-session keys. Ownership follows
// the person, so a deck an agent made is theirs to delete.
//
// The worker never reads into a document beyond the shape check on write:
// one #bento-doc block whose JSON parses and is a bento/slides document or a
// bento/enc envelope. Serving is a stream of the stored object.

import { verifyAccess } from './access.js'
import { rewriteBlock, shellOf, splitShell } from './block.js'
import {
  approvePairing, listGrants, readPairing, revokeGrant, verifyGrant,
} from './grant.js'
import { empty, flagOn, json, text } from './http.js'
import { ID_PAT, TOKEN_PAT, mintId } from './ids.js'
import {
  formNonce, isAgentPath, linkPoll, linkStart, pageRequest, rateLimited, sameOrigin,
} from './link.js'
import { indexPage, linkDonePage, linkPage, mintDocIntoBlock, newPage } from './pages.js'

const MAX_BYTES = 32 * 1024 * 1024
const KEY = (id) => `decks/${id}.bento.html`
// Encoded bytes per metadata value. Title, owner, writer and docId share the
// 2048-byte object budget with the timestamps and kind; 512 each leaves room.
const META_MAX = 512

// The service generation (runtime slides plan, KTD12): how many times a
// service token has written this deck, kept in customMetadata as `sg` and sent
// with every deck ETag as this header. A 412 names only the LATEST writer, so
// a Claude replace followed by a person's save reads as a person write; the
// editor compares the generation it booted with against the 412's, and only a
// match lets a live tab retry. Missing metadata (a deck stored before this) is 0.
const GEN_HEADER = 'x-bento-service-gen'

// Is this identity an AGENT writing, rather than a person at a keyboard?
// There are two kinds of agent now — a service token from a file harness and
// a grant from a paired Cowork session (one-click publish plan, KTD5) — and
// every place that used to ask `who.kind === 'service'` was really asking
// this. A shipped editor compares the generation it booted with and reads the
// 412 body's `writer`, so a grant write that answered "person" there would
// make a live tab retry over it. One predicate, so a third kind cannot land
// on the person side of one branch and the agent side of another.
const agentWrite = (who) => who.kind !== 'user'

/**
 * What goes in `writer` metadata.
 *
 * A grant writes as the PERSON who approved it, with `grant:` in front, so
 * the index says "alice asked her agent for this" rather than hiding the
 * agent or hiding alice. `owner` is the bare email, because ownership is what
 * makes a deck deletable and that has to be hers.
 */
const writerOf = (who) => (who.kind === 'grant' ? `grant:${who.id}` : who.id)

/**
 * Was the version that won written by a person at a keyboard?
 *
 * The 412 body's `writer` is `'person' | 'service'` and that enum is FROZEN:
 * `slides/src/beta/store.ts` on people's disks reads exactly those two words,
 * and a live tab retries only over a person's write. `verifyAccess` only ever
 * gives a person an email, so an `@` was the whole test — and a grant's
 * writer carries an email too, which is why it needs the prefix excluded.
 */
const wroteAsPerson = (writer) => writer.includes('@') && !writer.startsWith('grant:')

// The ETag again, under a name Cloudflare leaves alone. On the live host the
// edge drops a strong `etag` from any response it compresses (every deck is
// HTML, so every deck read lost it), while custom headers pass untouched.
// Clients read this first and fall back to `etag`.
const ETAG_HEADER = 'x-bento-etag'
const genOf = (obj) => {
  const n = Number.parseInt(obj?.customMetadata?.sg ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

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
// NOT here, though the plan's KTD0 listed it: /404.html. An unknown path is
// gated before it ever reaches Pages, so Pages' 404 page is never served to
// an anonymous visitor and nothing fetches it by name. Listing it bought
// nothing and cost a second entry, because Pages 308s an `.html` URL to its
// extensionless form: inside an allowlisted PREFIX the target stays inside
// that prefix (/templates/x.html → /templates/x), but a root-level EXACT
// entry's twin escapes the list. Measured on the live host — /404.html 308d
// to a gated /404. One less public path is the safer direction.
const PUBLIC_PATHS = new Set([
  '/agents.md', '/slides/agents.md',
  '/robots.txt', '/sitemap.xml', '/LICENSE',
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

const html = (body, extra = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', ...extra } })

// Pages that act on a click: the approval page and the index, which carries
// the Revoke buttons. A framed one is a clickjacked one, and both actions
// arrive with the person's Access session attached (KTD13). Belt and braces:
// `frame-ancestors` is the modern rule, `x-frame-options` the one an older
// browser honours.
// Pages that act on a click, hardened against a script on this same origin
// (a stored deck at /d/:id is first-party HTML here):
//
//  · frame-ancestors / x-frame-options — not clickjackable.
//  · Cross-Origin-Opener-Policy — a popup opened by a deck's script is
//    severed from its opener, so the script cannot read this page's DOM and
//    lift the nonce. MEASURED: without it `w.document` reads fine
//    same-origin; with it the read throws a DOMException.
//  · Cross-Origin-Resource-Policy — not readable as a subresource either.
const NO_FRAMING = {
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
}

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
  return storeBytes(req, env, ctx, who, bytes, evt)
}

/**
 * The storage half of a create, shared by `POST /api/decks` and `GET /new/blank`.
 *
 * Extracted so the server-side blank deck cannot drift from the uploaded one:
 * the same shape check, the same metadata, the same analytics, the same link.
 * `create` is now the body read plus this; nothing about its behaviour moved.
 */
async function storeBytes(req, env, ctx, who, bytes, evt) {
  const meta = inspect(bytes)
  if (meta.reason) { track(ctx, req, evt, 'rejected'); return text(400, meta.reason) }
  const id = mintId()
  const now = new Date().toISOString()
  await env.DECKS.put(KEY(id), bytes, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
    customMetadata: {
      title: encMeta(meta.title), docId: encMeta(meta.docId), kind: meta.kind,
      owner: encMeta(who.id), writer: encMeta(writerOf(who)), created: now, updated: now,
      sg: agentWrite(who) ? '1' : '0',
    },
  })
  track(ctx, req, evt, 'ok')
  // The link is on the origin that was CALLED, never canonicalized to
  // STORE_HOST. That looks like an improvement and is a bug: a 2026.9.2 shell
  // handing off on the retired host resolves the reply only if the url
  // `startsWith` the host IT opened (slides/src/beta/store.ts, the
  // `bento-store-saved` branch — frozen code on someone's disk). A canonical
  // link would be silently ignored there and the handoff would time out after
  // ten minutes with the document discarded. An old-host link 301s for as
  // long as that host lives, which is the grace period's whole job.
  return json(201, { id, url: `${new URL(req.url).origin}/d/${id}` })
}

/**
 * `GET /new/blank` — a blank deck, made HERE, answered as a redirect to it.
 *
 * The client used to do this: fetch the 1 MB template into the browser, mint a
 * docId, POST the 1 MB back, then navigate. That is two megabytes across the
 * person's connection and a visible "Making a blank deck. This takes a moment."
 * card with a Close button, for what is one internal fetch from the worker.
 * Here the same three steps run beside the store, and the person's browser sees
 * only a 302 into the editor.
 *
 * `mintDocIntoBlock` is the SAME function the page inlined, imported rather
 * than copied, so the rig keeps exercising the code that actually runs.
 *
 * Gated by the same `NEW_ENABLED` flag as the index button and /new's own
 * branch: a typed URL must not create decks on a host whose index says it
 * cannot. Unlike `/new`, this route is NOT exempt from the old host's redirect
 * — no shipped file asks for it, so a 301 to the live host is correct.
 */
async function createBlank(req, env, ctx, who) {
  const origin = env.PAGES_ORIGIN
  if (!origin) return text(502, 'store: PAGES_ORIGIN is not configured')
  let tpl
  try {
    // Pages answers `.html` with a 308 to the extensionless path (see the
    // README's release notes), so this follows redirects like every other
    // reader of that origin.
    const res = await fetch(`https://${origin}/templates/blank.bento.html`, { redirect: 'follow' })
    if (!res.ok) return text(502, `store: the blank template answered ${res.status}`)
    tpl = await res.text()
  } catch (err) {
    return text(502, `store: the blank template did not load (${err?.message || 'fetch failed'})`)
  }
  let html
  try {
    html = mintDocIntoBlock(tpl, crypto.randomUUID())
  } catch (err) {
    return text(502, `store: the blank template could not be prepared (${err?.message || 'mint failed'})`)
  }
  const stored = await storeBytes(req, env, ctx, who, new TextEncoder().encode(html), 'deck_new')
  if (stored.status !== 201) return stored
  const { url } = await stored.json()
  return new Response(null, { status: 302, headers: { location: url, 'cache-control': 'no-store' } })
}

/**
 * The version a caller read, from `If-Match`, as R2 wants it: the bare etag.
 * `httpEtag` is the quoted form a client echoes back; a weak `W/` prefix is
 * tolerated because some HTTP clients add one. `*` means "any version", which
 * is the same as no condition. Returns '' when there is no usable header.
 */
function ifMatchOf(req) {
  const raw = (req.headers.get('if-match') || '').trim()
  if (!raw || raw === '*') return ''
  return raw.replace(/^W\//, '').replace(/^"(.*)"$/, '$1')
}

/**
 * `put` with an etag precondition, reporting a failed one as `null`.
 * Workers' R2 resolves `null` when `onlyIf` fails; Miniflare has been seen to
 * throw a PreconditionFailed instead. Both mean the same thing here, so both
 * collapse into the one answer the route gives: 412.
 */
async function putIfMatch(env, key, bytes, opts, etag) {
  try {
    return await env.DECKS.put(key, bytes, etag ? { ...opts, onlyIf: { etagMatches: etag } } : opts)
  } catch (err) {
    if (etag && /precondition/i.test(`${err?.name} ${err?.message}`)) return null
    throw err
  }
}

/**
 * A grant's upload, with the stored `collab` put back and the shell pinned
 * (one-click publish plan, KTD7, R12/R20).
 *
 * Returns `{ bytes }` to store, or `{ reason }` — one word, the way `inspect`
 * refuses — for a 400.
 *
 * TWO checks, in this order, before anything is stored:
 *
 * 1. THE SHELL MUST BE THE STORED ONE, byte for byte. `inspect` looks only
 *    inside the block, so without this a grant could swap the runtime around
 *    a deck and have it run first-party on the store's origin for every
 *    partner who opens it. The block is the agent's to write; the shell is
 *    not. A create cannot be pinned this way — there is nothing to pin it
 *    against — and that stays accepted, as it already is for a service token.
 * 2. THE STORED `collab` GOES BACK IN, because the grant was never shown it.
 *    A read-modify-write would otherwise destroy the deck's live session,
 *    which is the exact damage stripping it was meant to prevent. When the
 *    stored deck has none, the incoming one must not invent one.
 *
 * The format may not change either: an encrypted deck stays encrypted and a
 * readable one stays readable. Encrypting a partner's deck under a password
 * only the agent knows would be as destructive as deleting it, and a grant
 * cannot delete.
 */
async function restoreIntoUpload(existing, bytes) {
  const incomingSrc = new TextDecoder().decode(bytes)
  const storedSrc = await existing.text()
  const a = splitShell(storedSrc)
  const b = splitShell(incomingSrc)
  if (!a || !b) return { reason: 'block' }
  if (shellOf(a) !== shellOf(b)) return { reason: 'shell' }
  let stored, incoming
  try {
    stored = JSON.parse(a.body)
    incoming = JSON.parse(b.body)
  } catch {
    return { reason: 'json' }
  }
  const encStored = stored?.format === 'bento/enc'
  const encIncoming = incoming?.format === 'bento/enc'
  if (encStored !== encIncoming) return { reason: 'format' }
  // Encrypted both ways: nothing to restore, and nothing here can read it.
  if (encStored) return { bytes }
  try {
    const out = rewriteBlock(incomingSrc, (doc) => {
      if (stored.collab === undefined) delete doc.collab
      else doc.collab = stored.collab
      return doc
    })
    return { bytes: new TextEncoder().encode(out) }
  } catch {
    return { reason: 'block' }
  }
}

/**
 * The 412 both conflict paths answer: the precondition classified up front on
 * the grant path, and a failed `onlyIf` on the put.
 *
 * Who wrote the version that won, and which version it is. The editor uses
 * both: a tab live-synced with its room already holds a person's edits and may
 * retry against this ETag; an agent's replace never travels through sync, so
 * the editor stops. `writer` is the stored identity, and verifyAccess only
 * ever gives a person an email, so an `@` was the person test — a grant's
 * writer carries one too, which is what `wroteAsPerson` excludes.
 */
async function conflict(env, ctx, req, id) {
  track(ctx, req, 'deck_save', 'conflict')
  const current = await env.DECKS.head(KEY(id))
  const res = json(412, {
    error: 'changed', message: 'The deck changed since the version you read. Re-read it, re-apply your change and try again.',
    writer: wroteAsPerson(decMeta(current?.customMetadata?.writer)) ? 'person' : 'service',
  })
  if (current) {
    res.headers.set('etag', current.httpEtag)
    res.headers.set(ETAG_HEADER, current.httpEtag)
    res.headers.set(GEN_HEADER, String(genOf(current)))
  }
  return res
}

// KTD5. `requireMatch` is the harness route's rule: a replace from a file
// harness must say which version it read (428 otherwise). The people route
// honours If-Match when present but cannot require it, because shells already
// on disk save without one and must keep working.
async function replace(req, env, ctx, who, id, { requireMatch = false, restoreCollab = false } = {}) {
  // A `get` rather than a `head` on the grant path: the stored document is
  // needed, not only its metadata. Everything else reads the same fields.
  const existing = restoreCollab ? await env.DECKS.get(KEY(id)) : await env.DECKS.head(KEY(id))
  if (!existing) return empty(404)
  const etag = ifMatchOf(req)
  if (requireMatch && !etag) {
    track(ctx, req, 'deck_save', 'rejected')
    return json(428, { error: 'if-match-required', message: 'Read the deck first (GET /api/harness/decks/:id) and send its ETag as If-Match.' })
  }
  let bytes = await readBody(req)
  if (!bytes) { track(ctx, req, 'deck_save', 'rejected'); return text(400, 'size') }
  if (restoreCollab) {
    // THE PRECONDITION IS CLASSIFIED FIRST, before the shell is compared.
    // Otherwise a person saving between a grant's read and its write — which
    // legitimately moves the shell, that is how an update lands — surfaces as
    // `400 shell` instead of `412`. The tool re-reads and retries a 412 and
    // gives up on a 400, so the wrong one of those two turns an ordinary
    // conflict into a failed run. `existing` is already the current object, so
    // this costs no extra read; the `onlyIf` on the put below stays, because
    // the get-then-put window is still a race and its 412 is the right answer.
    if (etag && etag !== existing.etag) return conflict(env, ctx, req, id)
    const restored = await restoreIntoUpload(existing, bytes)
    if (restored.reason) { track(ctx, req, 'deck_save', 'rejected'); return text(400, restored.reason) }
    bytes = restored.bytes
  }
  const meta = inspect(bytes)
  if (meta.reason) { track(ctx, req, 'deck_save', 'rejected'); return text(400, meta.reason) }
  const prev = existing.customMetadata || {}
  // An agent's write bumps the generation, a person's carries it forward. Read
  // from the head above: with If-Match the put only lands on that same version.
  const gen = genOf(existing) + (agentWrite(who) ? 1 : 0)
  const stored = await putIfMatch(env, KEY(id), bytes, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
    customMetadata: {
      title: encMeta(meta.title), docId: encMeta(meta.docId), kind: meta.kind,
      owner: prev.owner || encMeta(who.id), writer: encMeta(writerOf(who)),
      created: prev.created || new Date().toISOString(), updated: new Date().toISOString(),
      sg: String(gen),
    },
  }, etag)
  if (!stored) return conflict(env, ctx, req, id)
  track(ctx, req, 'deck_save', 'ok')
  return new Response(null, { status: 200, headers: { etag: stored.httpEtag, [ETAG_HEADER]: stored.httpEtag, [GEN_HEADER]: String(gen) } })
}

async function remove(env, who, id) {
  const existing = await env.DECKS.head(KEY(id))
  if (!existing) return empty(404)
  if (decMeta(existing.customMetadata?.owner) !== who.id) return empty(403)
  // Assets first: a failure part-way leaves a deck with fewer assets (its
  // scenes show their stills), never orphaned assets nothing can reach.
  let cursor
  do {
    const page = await env.DECKS.list({ prefix: ASSET_PREFIX(id), cursor })
    if (page.objects.length) await env.DECKS.delete(page.objects.map((o) => o.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  await env.DECKS.delete(KEY(id))
  return empty(204)
}

// --- scene assets (KTD6) -------------------------------------------------------
//
// Heavy files a runtime slide's scene needs (a 7 MB map SVG, a CSV) live
// beside the deck, not inside it. A harness uploads them; the shell on the
// store origin fetches them with the person's Access cookie and hands the
// bytes to the sandboxed scene, which never makes a credentialed request.
// They are keyed by deck id, so a duplicated deck has none until re-uploaded.

const ASSET_MAX = 16 * 1024 * 1024
const ASSET_PREFIX = (id) => `assets/${id}/`
const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const ASSET_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/json', 'text/csv'])

/**
 * Strip what makes an SVG active: script elements, foreignObject (which
 * embeds arbitrary HTML) and on* handler attributes. A regex pass, because a
 * worker has no DOM parser; it is a second line behind the GET's
 * `content-security-policy: sandbox`, not the only one. Repeated until stable
 * so a split tag (`<scr<script></script>ipt>`) cannot reassemble itself.
 */
function cleanSvg(src) {
  let prev
  let out = src
  do {
    prev = out
    out = out
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/gi, '')
      .replace(/([\s/])on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1')
  } while (out !== prev)
  // Whatever tags are left unpaired (self-closing, or a stray close).
  return out.replace(/<\/?(?:script|foreignObject)\b[^>]*>/gi, '')
}

async function putAsset(req, env, id, name) {
  if (!ASSET_NAME_RE.test(name)) return text(400, 'name')
  if (!(await env.DECKS.head(KEY(id)))) return empty(404)
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (!ASSET_TYPES.has(type)) return text(415, 'type')
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > ASSET_MAX) return text(413, 'size')
  let bytes = await req.arrayBuffer()
  if (bytes.byteLength > ASSET_MAX) return text(413, 'size')
  if (type === 'image/svg+xml') bytes = new TextEncoder().encode(cleanSvg(new TextDecoder().decode(bytes)))
  const stored = await env.DECKS.put(ASSET_PREFIX(id) + name, bytes, { httpMetadata: { contentType: type } })
  return new Response(null, { status: 200, headers: { etag: stored.httpEtag, [ETAG_HEADER]: stored.httpEtag } })
}

// `no-cache`, not a max-age: a harness re-uploads an asset under the same name
// when it redraws a scene, and an hour of stale cache showed the old one. The
// browser revalidates with If-None-Match instead, which costs a 304 and no body.
async function serveAsset(req, env, id, name) {
  if (!ASSET_NAME_RE.test(name)) return empty(404)
  const key = ASSET_PREFIX(id) + name
  const headers = (obj) => ({
    'cache-control': 'private, no-cache',
    etag: obj.httpEtag,
    [ETAG_HEADER]: obj.httpEtag,
    'x-content-type-options': 'nosniff',
    // Opened directly, an asset is a document on the store's origin; the
    // sandbox gives it an opaque one, so an SVG the strip missed still
    // cannot reach the deck API with the person's cookie.
    'content-security-policy': 'sandbox',
  })
  const inm = (req.headers.get('if-none-match') || '').trim()
  if (inm) {
    const head = await env.DECKS.head(key)
    if (!head) return empty(404)
    const tags = inm === '*' ? ['*'] : inm.split(',').map((t) => t.trim().replace(/^W\//, ''))
    if (tags.includes('*') || tags.includes(head.httpEtag)) return new Response(null, { status: 304, headers: headers(head) })
  }
  const obj = await env.DECKS.get(key)
  if (!obj) return empty(404)
  return new Response(obj.body, {
    status: 200,
    headers: {
      ...headers(obj),
      'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'content-length': String(obj.size),
    },
  })
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

// `length` is passed explicitly when the body is not the stored object: a
// grant's read is re-serialised, so `obj.size` would be a lie the client
// truncates on. The ETag stays the STORED object's, so the If-Match a grant
// sends back still names a version R2 knows.
// The ONE policy a served deck gets in enforcing mode, beside the report-only
// CSP above. A deck is uploaded HTML served first-party on the store's own
// origin, so a planted script could otherwise submit a form to the store's
// own control plane — which is exactly how the pairing approval would be
// forged (a script's form post is indistinguishable from a real click: both
// arrive same-origin, dest=document, mode=navigate, and even Sec-Fetch-User
// is ?1 inside a click handler; all measured).
//
// Narrow on purpose. `form-action` is the only directive here, so nothing
// about a deck's scripts, fetches, fonts or media changes and the full policy
// stays report-only until someone has verified it against real decks. A deck
// has no forms — MEASURED: with this header a deck still fetches its own
// assets (200) while its form post is blocked at navigation and never reaches
// the server at all.
const DECK_ENFORCED_CSP = "form-action 'none'"

const deckHeaders = (obj, length = obj.size) => ({
  'content-type': 'text/html; charset=utf-8',
  'content-length': String(length),
  'content-security-policy': DECK_ENFORCED_CSP,
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  etag: obj.httpEtag,
  [ETAG_HEADER]: obj.httpEtag,
  [GEN_HEADER]: String(genOf(obj)),
})

async function serve(env, ctx, req, id) {
  const obj = await env.DECKS.get(KEY(id))
  if (!obj) { track(ctx, req, 'deck_open', 'missing'); return empty(404) }
  track(ctx, req, 'deck_open', 'ok')
  return new Response(obj.body, {
    status: 200,
    headers: { ...deckHeaders(obj), 'content-security-policy-report-only': CSP },
  })
}

// `HEAD /d/:id` is how the editor learns the version it is showing (KTD12).
// A head, not a get, so no body is fetched; and not tracked, or every open
// would count twice.
async function serveHead(env, id) {
  const obj = await env.DECKS.head(KEY(id))
  if (!obj) return empty(404)
  return new Response(null, { status: 200, headers: { ...deckHeaders(obj), 'content-security-policy-report-only': CSP } })
}

// `GET /api/harness/decks/:id` (R10). Not owner-scoped, and not tracked: it
// is a harness's read-before-replace, not a person opening a deck.
//
// `stripCollab` is the grant path (KTD6, R11). The WHOLE `collab` block goes,
// not its three private fields: room plus the symmetric key is exactly what
// `saveReaderCopy` writes into a read-only copy, so leaving them would hand
// an eight-hour grant a reader capability on the live session that outlives
// it. The tool never reads `collab`, so dropping it costs nothing — and the
// restore on write (see `replace`) is what keeps a read-modify-write from
// destroying the keys instead.
async function harnessRead(env, id, { stripCollab = false } = {}) {
  const obj = await env.DECKS.get(KEY(id))
  if (!obj) return empty(404)
  if (!stripCollab) return new Response(obj.body, { status: 200, headers: deckHeaders(obj) })
  const src = await obj.text()
  let out
  try {
    out = rewriteBlock(src, (doc) => {
      // An encrypted deck is served as it is: its keys are inside the
      // ciphertext, and there is no document here to strip.
      if (doc.format === 'bento/enc') return null
      delete doc.collab
      return doc
    })
  } catch {
    // Better to refuse than to serve a file whose block could not be rewritten
    // — the unstripped bytes are exactly what must not leave on this path.
    return text(502, 'store: this deck could not be prepared for an agent')
  }
  const bytes = new TextEncoder().encode(out)
  return new Response(bytes, { status: 200, headers: deckHeaders(obj, bytes.byteLength) })
}

/**
 * Everything under the two Bypass prefixes, and nothing else.
 *
 * The pairing routes are public (the agent has no credential yet — that is
 * what pairing is for) and rate-limited; U3 adds the publish routes, which
 * take a bearer. Every path that is not an exactly routed method-and-path
 * falls off the end as 401 with no body.
 */
async function agentRoutes(req, env, ctx, url, path, m) {
  if (path === '/api/link/start' && m === 'POST') {
    return (await rateLimited(req, env)) || linkStart(req, env, url)
  }
  const lp = new RegExp(`^/api/link/(${TOKEN_PAT})$`).exec(path)
  if (lp && m === 'GET') {
    return (await rateLimited(req, env)) || linkPoll(env, lp[1])
  }

  // Everything else under either prefix needs a grant. Verified BEFORE any
  // storage read, so a bad bearer answers the same for a deck that exists as
  // for one that does not, and an Access assertion counts for nothing here.
  const who = await verifyGrant(req, env)
  if (!who) return empty(401)

  // One-to-one with the harness routes (KTD5): same handlers, same
  // conditional-write contract, the option flags U8 fills in.
  if (path === '/api/publish/decks' && m === 'POST') return create(req, env, ctx, who)
  const pd = new RegExp(`^/api/publish/decks/(${ID_PAT})$`).exec(path)
  if (pd && m === 'GET') return harnessRead(env, pd[1], { stripCollab: true })
  if (pd && m === 'PUT') return replace(req, env, ctx, who, pd[1], { requireMatch: true, restoreCollab: true })
  const pa = new RegExp(`^/api/publish/decks/(${ID_PAT})/assets/(.+)$`).exec(path)
  if (pa && m === 'PUT') return putAsset(req, env, pa[1], pa[2])

  // NOT routed here, deliberately (R9): no list, so a leaked grant cannot
  // enumerate anyone's work, and no delete, so it cannot destroy a deck it is
  // only borrowing an identity to write.
  return empty(401)
}

// --- router --------------------------------------------------------------------

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)
    const path = url.pathname
    const m = req.method

    // The retired host, before anything else, so a signed-out person
    // following an old link is redirected rather than bounced through a login
    // on a host that is going away. (Which also means the old host's Access
    // application has to go: Access answers before this worker runs, and a
    // gated old host would never reach this branch.)
    //
    // TWO EXEMPTIONS, both the same reason. A shell already on someone's disk
    // opens <its own storeHost>/new and rejects any reply from another origin
    // (KTD9) — and the page it lands on posts to a RELATIVE /api/decks, which
    // it reads with redirect:'manual', so a 301 there arrives as an
    // opaqueredirect and the person is told they are signed out while the
    // document they were publishing is discarded. So the handoff page and the
    // upload it makes both keep answering here; everything else redirects.
    if (flagOn(env.REDIRECT_OLD_HOST) && env.OLD_HOST && env.STORE_HOST && url.hostname === env.OLD_HOST) {
      const handoff = (m === 'GET' && path === '/new') || (m === 'POST' && path === '/api/decks')
      if (!handoff) return Response.redirect(`https://${env.STORE_HOST}${path}${url.search}`, 301)
    }

    // The public release channel comes next, and it is the ONLY other thing
    // ahead of identity. These paths are anonymous machine traffic from files
    // already on people's disks (KTD0); Access is configured to Bypass them,
    // so there is no assertion here to verify and nothing to verify it against.
    if (isPublicPath(path) && (m === 'GET' || m === 'HEAD')) return passThrough(req, env, url)

    // The two Bypass prefixes an agent uses, before verifyAccess — which would
    // answer 401 to every one of them, there being no assertion to verify.
    // Not a pass-through and not in PUBLIC_PREFIXES: these are handled HERE.
    if (isAgentPath(path)) return agentRoutes(req, env, ctx, url, path, m)

    // Identity next, before any routing of our own: an unknown path without an
    // assertion is 401, not 404, so nothing about the store is enumerable
    // without Access. Enumerability now stops at the allowlist above, and
    // that list is reads of maintainer-published bytes only.
    const who = await verifyAccess(req, env)
    if (!who) return empty(401)

    // Harness routes: same handlers, open to any verified identity.
    if (path === '/api/harness/decks' && m === 'POST') return create(req, env, ctx, who)
    const hm = new RegExp(`^/api/harness/decks/(${ID_PAT})$`).exec(path)
    if (hm && m === 'GET') return harnessRead(env, hm[1])
    if (hm && m === 'PUT') return replace(req, env, ctx, who, hm[1], { requireMatch: true })
    // The asset upload is the one harness route a person may not use (U2): a
    // person's scenes arrive through the splice tool, never a browser, and an
    // upload route open to every signed-in page is a way to plant files on
    // the store's origin. `(.+)` so a bad name is a 400, not a 404.
    const am = new RegExp(`^/api/harness/decks/(${ID_PAT})/assets/(.+)$`).exec(path)
    if (am && m === 'PUT') return agentWrite(who) ? putAsset(req, env, am[1], am[2]) : empty(403)

    // Everything else is for people. A service token stops here.
    if (who.kind !== 'user') return empty(403)

    // Is a blank deck on offer? The flag, and the store's own host: on the
    // retired one /new is only ever a handoff target, and its fetch of the
    // blank template would follow a 301 cross-origin and die on CORS with a
    // confusing error. The index must not offer what /new would not honour,
    // so both read this.
    const canCreate = flagOn(env.NEW_ENABLED) && (!env.STORE_HOST || url.hostname === env.STORE_HOST)

    // The approval flow (U2). These sit HERE, behind the person gate, and not
    // with the agent prefixes: the whole point is that Access has already
    // established who is approving. A service token is refused above.
    const lm = new RegExp(`^/link/(${ID_PAT})$`).exec(path)
    if (lm && m === 'GET') {
      // A script cannot READ this page: its nonce is the second half of the
      // approval's protection, and a fetch or an iframe from a stored deck is
      // same-origin for free on this host.
      if (!pageRequest(req)) return text(403, 'Open this link in a browser tab.')
      const pairing = await readPairing(env, lm[1])
      if (!pairing) return text(410, 'This approval link has expired or has already been used.')
      return html(linkPage(who.id, lm[1], pairing), NO_FRAMING)
    }
    const la = new RegExp(`^/link/(${ID_PAT})/approve$`).exec(path)
    if (la && m === 'POST') {
      if (!sameOrigin(req, url) || !pageRequest(req)) return text(403, 'This has to be approved from the store’s own page.')
      const nonce = await formNonce(req)
      // Read once, for the label the done page repeats back.
      const pairing = await readPairing(env, la[1])
      let outcome
      try {
        outcome = await approvePairing(env, la[1], nonce, who.id)
      } catch {
        // The consent may already have been recorded — the state write lands
        // before the code is deleted — so say so rather than showing a raw
        // platform error to someone who just clicked Approve.
        return text(502, 'The store could not finish recording this approval. Check with whoever asked for it before approving again.')
      }
      if (outcome === 'nonce') return text(403, 'This approval form is out of date. Open the link again.')
      if (outcome !== 'ok') return text(410, 'This approval link has expired or has already been used.')
      return html(linkDonePage(who.id, pairing || {}), NO_FRAMING)
    }

    // R10: a person ends their own agent access here. A form post, never a
    // GET — a revoking GET would fire from any image tag anyone could plant —
    // and same-origin, because Access attaches the session either way (KTD13).
    const gr = /^\/api\/grants\/([0-9a-f]{64})\/revoke$/.exec(path)
    if (m === 'POST' && (gr || path.startsWith('/api/grants/'))) {
      if (!sameOrigin(req, url) || !pageRequest(req)) return text(403, 'This has to be revoked from the store’s own page.')
      // A hash that is not this person's revokes nothing and answers 404: the
      // page never shows anyone else's, so there is nothing to distinguish.
      if (!gr || !(await revokeGrant(env, who.id, gr[1]))) return empty(404)
      return new Response(null, { status: 303, headers: { location: '/', 'cache-control': 'no-store' } })
    }

    if (path === '/' && m === 'GET') {
      return html(indexPage(await listDecks(env, url.origin), who.id, {
        create: canCreate, grants: await listGrants(env, who.id),
      }), NO_FRAMING)
    }
    if (path === '/new' && m === 'GET') return html(newPage(who.id, { create: canCreate }))
    if (path === '/new/blank' && m === 'GET') {
      if (!canCreate) return empty(404)
      return createBlank(req, env, ctx, who)
    }
    if (path === '/api/decks' && m === 'GET') return json(200, { decks: await listDecks(env, url.origin) })
    if (path === '/api/decks' && m === 'POST') return create(req, env, ctx, who, url.searchParams.get('new') === '1' ? 'deck_new' : 'deck_save')
    const dm = new RegExp(`^/api/decks/(${ID_PAT})$`).exec(path)
    if (dm && m === 'PUT') return replace(req, env, ctx, who, dm[1])
    if (dm && m === 'DELETE') return remove(env, who, dm[1])
    const sm = new RegExp(`^/d/(${ID_PAT})$`).exec(path)
    if (sm && m === 'GET') return serve(env, ctx, req, sm[1])
    if (sm && m === 'HEAD') return serveHead(env, sm[1])
    const sa = new RegExp(`^/d/(${ID_PAT})/assets/([^/]+)$`).exec(path)
    if (sa && m === 'GET') return serveAsset(req, env, sa[1], sa[2])

    return empty(404)
  },
}
