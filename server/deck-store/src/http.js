// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// The shapes a reply comes in, and how a wrangler flag is read.
//
// Plumbing shared by worker.js and link.js, extracted when the pairing
// surface moved into its own module and both needed the same four helpers.
// Nothing here knows anything about decks, grants or Access.

export const empty = (status) => new Response(null, { status })

export const text = (status, body) => new Response(body, {
  status, headers: { 'content-type': 'text/plain; charset=utf-8' },
})

export const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
})

// A wrangler [vars] flag. Vars are strings, so say what counts as on.
export const flagOn = (v) => v === 'on' || v === 'true' || v === '1'
