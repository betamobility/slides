// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Grants: a short-lived bearer that lets an agent act as the person who
// approved it (one-click publish plan, KTD2 and KTD3).
//
// A grant is 32 random bytes. The store NEVER keeps them: KV holds
// sha256(token), so a dump of the namespace between an approval and its
// delivery contains nothing a caller could use (R21). The raw token exists in
// the open exactly once, in the answer to the poll that minted it.
//
// Two keys per grant, written and deleted together:
//   grant:<hash>            → the grant, read on every verify
//   person:<email>:<hash>   → the same, listed for the person's index page
//
// The trailing colon in the person prefix is not cosmetic: listing
// `person:alice@` would otherwise match `person:alice@betamobility.io:…`, and
// a list prefix is what decides whose grants someone sees.
//
// KV's own `expirationTtl` retires a key without a sweep, and the stored `exp`
// is checked on every verify as well — eventual consistency means a key can
// outlive its expiry at some locations, and the clock in the value is the one
// that fails closed. There is no secret and no signing key anywhere here: the
// hash is the whole mechanism, so `wrangler.toml` stays `[vars]` only.

// Eight hours, the lifetime Johan set on 2026-09-16 and the number the
// approval page tells the person out loud. One place, so the page and the
// grant cannot disagree.
export const GRANT_TTL_S = 8 * 60 * 60
export const LABEL_MAX = 80

const TOKEN_BYTES = 32
// 32 bytes base64url, unpadded: exactly 43 characters. Shape-checked before
// anything is hashed or read, so garbage never costs a KV lookup.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const HASH_RE = /^[0-9a-f]{64}$/

const grantKey = (hash) => `grant:${hash}`
const personKey = (email, hash) => `person:${email}:${hash}`
const personPrefix = (email) => `person:${email}:`

const b64u = (bytes) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A fresh opaque grant token. */
function mintToken() {
  const buf = new Uint8Array(TOKEN_BYTES)
  crypto.getRandomValues(buf)
  return b64u(buf)
}

/** sha256 of a token, lowercase hex — the only form the store keeps. */
export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Mint a grant for `email` and store its hash under both keys.
 *
 * Returns `{ token, hash, exp, created }`; the token is the ONLY copy and is
 * not recoverable afterwards. `opts.now` exists for the rig, which needs a
 * grant whose stored expiry has already passed while its key is still there.
 */
export async function mintGrant(env, email, label, { now = Date.now() } = {}) {
  if (!env?.GRANTS) throw new Error('grant: the GRANTS namespace is not bound')
  const token = mintToken()
  const hash = await hashToken(token)
  const created = new Date(now).toISOString()
  const exp = Math.floor(now / 1000) + GRANT_TTL_S
  const record = {
    email, exp, created,
    label: String(label ?? '').slice(0, LABEL_MAX),
  }
  const value = JSON.stringify(record)
  // The person key carries the same record as metadata so the index page's
  // list costs one KV operation instead of one per grant.
  await env.GRANTS.put(grantKey(hash), value, { expirationTtl: GRANT_TTL_S })
  await env.GRANTS.put(personKey(email, hash), value, { expirationTtl: GRANT_TTL_S, metadata: record })
  return { token, hash, exp, created }
}

/**
 * The grant identity behind this request's `Authorization: Bearer …`, or null.
 *
 * `kind` is a third identity kind beside `verifyAccess`'s 'user' and
 * 'service'; the worker's `agentWrite` predicate is what keeps every
 * "is this an agent writing" branch from having to know about it.
 */
export async function verifyGrant(req, env) {
  if (!env?.GRANTS) return null // unbound = closed, as verifyAccess is
  const raw = (req.headers.get('authorization') || '').trim()
  const m = /^Bearer[ ]+(\S+)$/.exec(raw)
  if (!m || !TOKEN_RE.test(m[1])) return null
  const hash = await hashToken(m[1])
  let record
  try {
    record = await env.GRANTS.get(grantKey(hash), 'json')
  } catch {
    return null
  }
  if (!record || typeof record.email !== 'string' || !record.email) return null
  if (!Number.isFinite(record.exp) || record.exp <= Math.floor(Date.now() / 1000)) return null
  return { kind: 'grant', id: record.email, grant: hash, exp: record.exp }
}

/** Every live grant of `email`, newest first. Metadata only; no token. */
export async function listGrants(env, email) {
  if (!env?.GRANTS || !email) return []
  const out = []
  const now = Math.floor(Date.now() / 1000)
  let cursor
  do {
    const page = await env.GRANTS.list({ prefix: personPrefix(email), cursor })
    for (const k of page.keys) {
      const hash = k.name.slice(personPrefix(email).length)
      const meta = k.metadata || {}
      if (!HASH_RE.test(hash)) continue
      if (!Number.isFinite(meta.exp) || meta.exp <= now) continue
      out.push({ hash, label: String(meta.label ?? ''), created: String(meta.created ?? ''), exp: meta.exp })
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  out.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0))
  return out
}

/**
 * End one grant of `email`. Both keys go, or neither: the person key is read
 * first, so a hash belonging to somebody else deletes nothing and answers
 * false — which is how the revoke route tells a 403 from a 404.
 */
export async function revokeGrant(env, email, hash) {
  if (!env?.GRANTS || !email || !HASH_RE.test(String(hash || ''))) return false
  const mine = await env.GRANTS.get(personKey(email, hash))
  if (!mine) return false
  await env.GRANTS.delete(grantKey(hash))
  await env.GRANTS.delete(personKey(email, hash))
  return true
}
