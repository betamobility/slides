// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// The pairing handshake's HTTP surface, and the checks that decide whether a
// request came from a real page (one-click publish plan, U2/KTD1/KTD9/KTD13).
//
// Split out of worker.js when that file passed a thousand lines: this is a
// self-contained concern — two public endpoints, their rate limit, their body
// caps, and the request-provenance rules the person-facing approval and revoke
// routes share. The grant STORE and the pairing state machine live in
// grant.js; the router that dispatches to all of it stays in worker.js.

import { LABEL_MAX, pollPairing, startPairing } from './grant.js'
import { empty, flagOn, json, text } from './http.js'
import { TOKEN_PAT } from './ids.js'

// --- the agent prefixes (one-click publish plan, KTD4) -------------------------
//
// Two prefixes Access BYPASSES, the way it bypasses the release channel, so a
// request arrives here with no assertion at all:
//
//   /api/link/     the pairing handshake. Public by necessity: the agent has
//                  no credential yet, which is the whole point of pairing.
//   /api/publish/  what a grant reaches, verified by a bearer.
//
// Nothing but this worker guards them, so this is where the worker does what
// Access does elsewhere, and it fails closed in every direction:
//
//  · an Access assertion here is IGNORED. A person's cookie with no bearer is
//    401 — otherwise a page on this origin could publish as its reader.
//  · anything not an exactly routed method and path is 401 WITH NO BODY,
//    never 404, so nothing under these prefixes says whether a deck exists.
//  · the bearer is verified before any R2 read, so a refusal costs the same
//    and says the same for a real deck id as for a made-up one.
//
// The trailing slash is part of each prefix: a bare `/api/link` matches
// neither this nor an Access Bypass destination, and falls through to the
// gated routes — which is why the pairing routes live UNDER `/api/link/`
// rather than at it.
export const AGENT_PREFIXES = ['/api/link/', '/api/publish/']
export const isAgentPath = (path) => AGENT_PREFIXES.some((p) => path.startsWith(p))

// The pairing-start body. One kilobyte and an 80-character label: this is the
// only public non-GET endpoint on the host, and the 32 MB deck cap has no
// business being its limit.
const LINK_BODY_MAX = 1024

/**
 * The rate limit on the public pairing routes (KTD9).
 *
 * `LINK_LIMIT_REQUIRED` exists because the binding is the only thing standing
 * between a public POST and whoever finds it: in production a missing binding
 * must be a 503, not an unguarded endpoint. The rig and `wrangler dev` turn
 * the flag off and run without one.
 *
 * Returns null when the request may proceed, else the response to send.
 */
export async function rateLimited(req, env) {
  const limiter = env.LINK_LIMIT
  if (!limiter?.limit) {
    return flagOn(env.LINK_LIMIT_REQUIRED) ? text(503, 'store: the pairing rate limiter is not configured') : null
  }
  // Per-location and eventually consistent, which is what a limiter on an
  // anonymous endpoint can be. `cf-connecting-ip` is set by the edge on every
  // real request; the fallback keeps a local run working.
  const key = req.headers.get('cf-connecting-ip') || 'anon'
  try {
    const { success } = await limiter.limit({ key })
    return success ? null : text(429, 'store: too many pairing requests; wait a minute')
  } catch {
    return flagOn(env.LINK_LIMIT_REQUIRED) ? text(503, 'store: the pairing rate limiter did not answer') : null
  }
}

/** `POST /api/link/start` — begin a pairing. No credential, by design (R1). */
export async function linkStart(req, env, url) {
  if (!(req.headers.get('content-type') || '').toLowerCase().includes('application/json')) return text(400, 'content-type')
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > LINK_BODY_MAX) return text(400, 'size')
  const raw = await req.text()
  if (raw.length > LINK_BODY_MAX) return text(400, 'size')
  let body
  try {
    body = raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return text(400, 'json')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return text(400, 'json')
  const label = body.label === undefined ? '' : body.label
  if (typeof label !== 'string' || label.length > LABEL_MAX) return text(400, 'label')
  const { code, handle, exp } = await startPairing(env, label)
  // The URL is on the origin that was called, the way a deck link is: a
  // person opens what the agent printed.
  return json(200, {
    code, handle,
    url: `${url.origin}/link/${code}`,
    expires: new Date(exp * 1000).toISOString(),
  })
}

/**
 * `GET /api/link/<handle>` — the agent's poll (R1).
 *
 * 202 while nobody has approved, 200 with the grant once, 200 without one for
 * the poll after that (the raw token is never stored, so it cannot be
 * repeated — see `pollPairing`), and 410 when the pairing is gone.
 */
export async function linkPoll(env, handle) {
  const res = await pollPairing(env, handle)
  if (res.state === 'pending') return json(202, { state: 'pending' })
  if (res.state === 'delivered') {
    return json(200, {
      state: 'delivered', grant: res.token, owner: res.owner,
      expires: new Date(res.exp * 1000).toISOString(),
    })
  }
  if (res.state === 'done') {
    return json(200, {
      state: 'collected',
      message: 'This approval was already collected. If you did not receive the grant, start a new pairing.',
    })
  }
  return json(410, { state: 'gone', message: 'This pairing is no longer open. Start a new one.' })
}

/**
 * Is this POST from our own page? (KTD13.)
 *
 * The approval and revoke pages sit behind the human Access application, so
 * Access attaches the assertion to ANY request carrying the session cookie —
 * including a cross-site auto-submitting form on someone else's site. A
 * browser sets `Sec-Fetch-Site` itself and a page cannot forge it, so that is
 * the primary check; `Origin` covers a client that omits it. A request with
 * neither header is not a browser form post and is refused.
 *
 * SAME-ORIGIN IS NOT ENOUGH ON THIS HOST, which is why `pageRequest` below
 * exists as well: `/d/:id` serves uploaded deck HTML as a first-party
 * document here, so a script inside a stored deck is same-origin for free.
 */
export function sameOrigin(req, url) {
  const site = (req.headers.get('sec-fetch-site') || '').toLowerCase()
  if (site) return site === 'same-origin'
  const origin = req.headers.get('origin')
  return !!origin && origin === url.origin
}

/**
 * Is this a real page in a browser, rather than a script's request?
 *
 * The attack this closes: a script in a stored deck (first-party on this
 * origin, see above) starts its own pairing on the public route, reads
 * `/link/<code>` to lift the nonce, and posts the approval — collecting a
 * grant that acts as whoever opened the deck. Every step is same-origin.
 *
 * MEASURED, in Chrome, rather than taken from the spec:
 *
 *   fetch('/link/…')                  dest=empty     mode=cors
 *   an iframe                         dest=iframe    mode=navigate
 *   window.open(…)                    dest=document  mode=navigate
 *   a script's form.submit()           dest=document  mode=navigate  user=null
 *   the same inside a click handler    dest=document  mode=navigate  user=?1
 *
 * So `dest` separates a script's READ of the page (empty, iframe) from a real
 * navigation — that is what this function is for — while `Sec-Fetch-User` is
 * NOT a defence, because a script that submits a form inside a click handler
 * gets `?1` for free. The popup read and the forged form post are closed by
 * two response headers instead: COOP on these pages (a popup's opener cannot
 * touch its DOM) and `form-action 'none'` on a served deck.
 *
 * A request with no `Sec-Fetch-Dest` at all is allowed through: that is a
 * non-browser client (curl in the README's verification steps), which carries
 * no victim's session to abuse. `sameOrigin` still governs the writes.
 */
export function pageRequest(req) {
  const dest = (req.headers.get('sec-fetch-dest') || '').toLowerCase()
  return !dest || dest === 'document'
}

/** The nonce out of an approval form's body. */
export async function formNonce(req) {
  const raw = await req.text()
  try {
    return new URLSearchParams(raw).get('nonce') || ''
  } catch {
    return ''
  }
}
