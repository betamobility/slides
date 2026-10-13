// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
//
// The ONE place that knows what "this deck embeds that shell" means.
//
// A built shell carries its runtime as `bento/deflate-b86` script blocks
// (`deflate-b64` before upstream 1.2.0; scripts/lib/apphash.mjs reads both), and
// every deck that embeds the shell — the gallery, the 404 deck, the guestbook,
// the Beta templates — carries the same blocks verbatim (the builders splice a
// document into the shell, they never touch the payload). So two files share a
// runtime exactly when their payload blocks hash the same. publish-site.mjs
// used to hold this inline; it is a module now so the templates rig
// (scripts/test-beta-templates-current.ts) and the publish-gate rig
// (scripts/test-publish-gate.mjs) run the same regex the publish does, and a
// drift between "what the gate checks" and "what the rig checks" is impossible.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { appHash } from './apphash.mjs'
import { join } from 'node:path'

/**
 * sha256 over the concatenated payload blocks, or null when the file carries
 * none. Callers MUST treat null as "not a shell", never as "matches another
 * null" — see staleEmbeddedDecks.
 */
export const payloadHash = appHash // upstream's fingerprint: one definition of "the same runtime"

export const payloadHashOfFile = (file) => payloadHash(readFileSync(file, 'utf8'))

const decksIn = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.bento.html')).sort().map((f) => join(dir, f)) : []

/**
 * Every file in an assembled `site/` tree that embeds the released shell and
 * therefore has to be rebuilt whenever the shell changes. Only files that
 * exist are returned; a missing optional deck (the guestbook epoch on a clean
 * tag checkout) is not a stale deck.
 */
export function embeddedShellDecks(site) {
  return [
    ...decksIn(join(site, 'gallery')),
    // BETA FORK: the starter decks release.mjs builds at /templates/.
    ...decksIn(join(site, 'templates')),
    join(site, '404.bento.html'),
    join(site, 'guestbook.bento.html'),
  ].filter(existsSync)
}

/**
 * Which of `decks` do NOT carry `shellFile`'s payload. Throws when the shell
 * itself has no payload: a blockless shell would otherwise "match" a blockless
 * deck and the whole check would pass vacuously.
 */
export function staleEmbeddedDecks(shellFile, decks) {
  const shellHash = payloadHashOfFile(shellFile)
  if (!shellHash) throw new Error(`${shellFile} carries no runtime payload blocks — not a built shell`)
  return decks.filter((d) => payloadHashOfFile(d) !== shellHash)
}
