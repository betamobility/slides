// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// BETA FORK: fold a newer cloud version into a tab that has unsaved edits.
//
// THE CASE. Claude (or a colleague whose tab is not in the live room) writes
// a deck while a person has it open and is editing. Until now the tab learned
// this from a refused save (412), latched, and the person's edits could only
// leave as a separate deck. A merge keeps both in the one deck.
//
// THREE DOCUMENTS. `base` is the version this tab last had in common with the
// cloud (what it loaded, or what its last save wrote). `theirs` is the cloud's
// version now. `ours` is the tab's document, unsaved edits included. What
// changed from base to theirs is applied on top of ours.
//
// THE ENGINE IS THE SYNC ENGINE. Merging two edit histories of one deck is
// exactly what bento-sync does between live peers, and slides/src/sync/crdt.ts
// is held to convergence by scripts/test-sync.ts. So there is no second merge
// algorithm: two replicas adopt `base`, each diffs its side into ops, and the
// cloud's ops are applied to ours. Slides and elements are matched by id;
// insertions from both sides survive, in order; every property is a register.
//
// WHEN BOTH SIDES CHANGED THE SAME PROPERTY, the person's edit wins: it is the
// one on screen. The cloud's value is not lost: the store keeps the version
// it replaces under history/ (server/deck-store "deck history"), and the
// editor names the elements where this happened. Text is merged as a WHOLE
// value per element (`text: false`), not token by token: a token merge of
// "Claude rewrote the sentence" with "the person fixed one word" interleaves
// the two, which is neither.

import type { BentoDoc } from '../model.ts'
import { SyncState, type Op } from '../sync/crdt.ts'

export interface MergeConflict {
  /** Slide id, or null for a deck-level property (title, theme). */
  slideId: string | null
  /** Element id, when the property is an element's. */
  elementId?: string
  key: string
}

export interface MergeResult {
  doc: BentoDoc
  /** Properties both sides changed, where the person's value was kept. */
  conflicts: MergeConflict[]
  /** Whether the cloud's version changed anything in ours. */
  changed: boolean
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const SEP = '\u001f'

/** Which register a set op writes: node + key. */
const regOf = (o: Op): string | null => (o.op === 'set' ? `${o.el ?? o.sl ?? '@doc'}\u0000${o.k}` : null)

/**
 * Merge `theirs` into `ours` over `base`. Pure: none of the three is modified.
 * The result keeps OURS's identity (docId, collab): it is still the deck open
 * in this tab.
 */
export function mergeCloudVersion(base: BentoDoc, ours: BentoDoc, theirs: BentoDoc): MergeResult {
  const cloud = new SyncState('cloud')
  cloud.adopt(clone(base))
  // A deep copy: toJSON() hands back the engine's live tables (vv, pos, …),
  // and a replica sharing them would see the cloud's ops as already applied.
  const tab = SyncState.fromJSON('tab', clone(cloud.toJSON()))
  // The cloud's edits are minted first; the tab's are stamped later, so on a
  // register both set, the tab's (the person's) wins.
  const theirOps = cloud.diff(clone(base), clone(theirs), { text: false })
  tab.lamport = Math.max(tab.lamport, cloud.lamport)
  const ourOps = tab.diff(clone(base), clone(ours), { text: false })
  const ourRegs = new Set(ourOps.map(regOf).filter((r): r is string => !!r))

  const conflicts: MergeConflict[] = []
  for (const o of theirOps) {
    const r = regOf(o)
    if (!r || !ourRegs.has(r) || o.op !== 'set') continue
    // the same value on both sides is agreement, not a conflict
    const mine = ourOps.find((x) => regOf(x) === r) as (Op & { v?: unknown }) | undefined
    if (mine && JSON.stringify(mine.v) === JSON.stringify(o.v)) continue
    if (o.el) {
      const i = o.el.indexOf(SEP)
      conflicts.push({ slideId: o.el.slice(0, i), elementId: o.el.slice(i + 1), key: o.k })
    } else conflicts.push({ slideId: o.sl ?? null, key: o.k })
  }

  const out = clone(ours)
  const res = tab.apply(out, theirOps)
  // identity stays the open deck's, whatever the cloud's bytes said
  const o = out as unknown as Record<string, unknown>
  const src = ours as unknown as Record<string, unknown>
  o.docId = src.docId
  if (src.collab !== undefined) o.collab = clone(src.collab)
  else delete o.collab
  return { doc: out, conflicts, changed: res.changed }
}
