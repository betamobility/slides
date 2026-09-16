// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// The two random shapes this worker mints, in one place.
//
// A deck id and a pairing code are different things that happen to share a
// shape (ten base62 characters, short enough to read off a URL); a handle, a
// nonce and a grant token are all opaque 32-byte tokens nobody reads aloud.
// The rejection sampling below is the part worth having once: taking `b % 62`
// over all 256 byte values would favour the first 70 characters of the
// alphabet, so the biased tail is dropped instead.

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

// Kept as patterns, not only compiled regexes, so a route can build
// `^/link/(<pattern>)$` from the same source the validator uses.
export const ID_PAT = '[0-9A-Za-z]{10}'
export const TOKEN_PAT = '[A-Za-z0-9_-]{43}'
export const ID_RE = new RegExp(`^${ID_PAT}$`)
export const TOKEN_RE = new RegExp(`^${TOKEN_PAT}$`)

/** Ten base62 characters: a deck id, or a pairing code. */
export function mintId() {
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

/** 32 random bytes as 43 base64url characters: a token nobody types. */
export function mintToken() {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  let s = ''
  for (const b of buf) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
