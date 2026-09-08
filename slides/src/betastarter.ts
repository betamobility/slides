// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// BETA FORK: what a bare shell opens with. Upstream's showcase (starterdeck.ts)
// stays in the tree for the weekly merge; the Beta shell boots on a short deck
// in the design system, generated from beta/theme.json by
// scripts/build-beta-starter.mjs. Same contract as starterDoc(): a fresh
// docId every boot, no collab, not a template.

import { newDocId, type BentoDoc } from './model'
import { BETA_STARTER_JSON } from './starter/beta.generated'

export function betaStarterDoc(): BentoDoc {
  const doc = JSON.parse(BETA_STARTER_JSON) as BentoDoc
  doc.docId = newDocId()
  return doc
}
