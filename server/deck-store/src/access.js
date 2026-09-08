// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Cloudflare Access verification for the deck store (plan KTD8).
//
// Access sits in front of decks.betamobility.ai and forwards a signed JWT in
// `Cf-Access-Jwt-Assertion` on every request it lets through. The header is
// verified here, never trusted: signature against the team's JWKS, issuer,
// audience (an explicit set, one tag per Access application), expiry, and a
// Beta identity. Docs/auth-setup.md is the recipe this follows.
//
// Identity comes in two shapes:
//   - a person: `email` ending in @betamobility.io (checked again here as
//     defence in depth against a mis-scoped policy)
//   - a service token: `sub` is empty and the Client ID sits in `common_name`
//
// JWKS is fetched from `https://<team>/cdn-cgi/access/certs`, cached in the
// isolate for the response's max-age (an hour when absent), and refreshed
// ONCE when an assertion names a key id the cache lacks. If the refreshed set
// still lacks it, the request fails closed.

const JWKS_DEFAULT_TTL_MS = 60 * 60 * 1000
const BETA_DOMAIN = '@betamobility.io'
const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }

/** @type {{ domain: string, keys: Map<string, CryptoKey>, expires: number } | null} */
let cache = null

function b64uToBytes(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}
function b64uJson(s) {
  return JSON.parse(new TextDecoder().decode(b64uToBytes(s)))
}

async function fetchJwks(domain) {
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`)
  if (!res.ok) throw new Error(`jwks ${res.status}`)
  const body = await res.json()
  const keys = new Map()
  for (const k of body.keys || []) {
    if (k.kty !== 'RSA' || !k.kid) continue
    try {
      const key = await crypto.subtle.importKey(
        'jwk', { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true }, RSA, false, ['verify'])
      keys.set(k.kid, key)
    } catch { /* a malformed key is skipped, not fatal */ }
  }
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '')
  const ttl = maxAge ? Number(maxAge[1]) * 1000 : JWKS_DEFAULT_TTL_MS
  cache = { domain, keys, expires: Date.now() + ttl }
  return cache
}

/** The key for `kid`, refreshing the set once if it is unknown or stale. */
async function keyFor(domain, kid) {
  let set = cache && cache.domain === domain && cache.expires > Date.now() ? cache : null
  if (!set) set = await fetchJwks(domain)
  if (set.keys.has(kid)) return set.keys.get(kid)
  // Unknown kid: Access rotates keys, so refresh once, then fail closed.
  set = await fetchJwks(domain)
  return set.keys.get(kid) || null
}

/**
 * Verify the request's Access assertion.
 * @returns {Promise<{ kind: 'user' | 'service', id: string } | null>} null when
 *   the request must be refused (401).
 */
export async function verifyAccess(req, env) {
  const domain = String(env.ACCESS_TEAM_DOMAIN || '').trim()
  const auds = new Set(String(env.ACCESS_AUDS || '').split(',').map((s) => s.trim()).filter(Boolean))
  if (!domain || auds.size === 0) return null // unconfigured = closed

  const token = req.headers.get('cf-access-jwt-assertion')
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null

  let header, claims
  try {
    header = b64uJson(parts[0])
    claims = b64uJson(parts[1])
  } catch {
    return null
  }
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !claims) return null

  // Claims first: they are cheap, and a wrong issuer must never cost a JWKS
  // fetch to the issuer it names.
  if (claims.iss !== `https://${domain}`) return null
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!aud.some((a) => auds.has(a))) return null
  const now = Math.floor(Date.now() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return null

  let key
  try {
    key = await keyFor(domain, header.kid)
  } catch {
    return null
  }
  if (!key) return null
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  let valid = false
  try {
    valid = await crypto.subtle.verify(RSA, key, b64uToBytes(parts[2]), signed)
  } catch {
    valid = false
  }
  if (!valid) return null

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : ''
  if (email) {
    if (!email.endsWith(BETA_DOMAIN) || email.length <= BETA_DOMAIN.length) return null
    return { kind: 'user', id: email }
  }
  const cn = typeof claims.common_name === 'string' ? claims.common_name.trim() : ''
  if (cn && !claims.sub) return { kind: 'service', id: cn }
  return null
}
