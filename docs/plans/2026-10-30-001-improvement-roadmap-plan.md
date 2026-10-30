# Improvement roadmap: the highest-impact changes to beta/slides

Written 2026-10-30 from a review of `main` at `126b441b`. This is a ranked
roadmap, not a unit-level implementation plan: each unit below gets its own
`/ce:plan` (or goes straight to `/ce:work` where it is small) when picked up.
Where this file and `docs/PLATFORM.md` disagree, PLATFORM wins.

## How the review was done

Four read-only passes in parallel, then spot checks on the claims that drove
the ranking:

- **Upstream drift:** `git log main..upstream/main` and a dry-run
  `git merge-tree --write-tree main upstream/main`.
- **Beta-specific features:** the deck store, the pairing and publish flow,
  the skill, PowerPoint export, the scene library, templates, analytics, and
  the open items in the plans and docs.
- **Code health:** `tsc -b`, `npm run build:single`, the shell size against
  `scripts/size-budgets.json`, and the last 30 CI runs.
- **Hands-on UX:** the built shell in Playwright at 1440px and 390px, covering
  layouts, typing, inserts, presenting, PPTX and PDF export. The screenshot
  names cited below (`05-typed.png` and so on) are from that session's
  scratch folder and are not committed. Each one is reproducible by
  following the step described beside it.

Claims that were checked and **dropped**, so nobody re-plans them:

- *"Charts aren't in Beta colours."* Navy and orange (`#0F2A4A`, `#E4572E`)
  are the design system's `--chart-1/2` (`beta/v131/tokens.json:52`). The
  only inconsistency is the starter deck's charcoal example chart, which is
  cosmetic.
- *"Templates are off-brand."* That applied only to stale, gitignored local
  builds in `beta/templates/`. The live
  `https://slides.betamobility.ai/templates/*.bento.html` files (checked
  2026-10-30) carry the v1.5.0 theme: white background, `#242F30` accent,
  Geist, and the design-system chart palette.
- *"Encrypted decks leak to IndexedDB."* `kernel/src/autosave.ts` already
  never snapshots encrypted decks and purges snapshots taken before encryption
  (lines 16 and 265). Upstream's sealed-content work (#785, #796) is hardening
  on top of that, not a fix for an exposure.
- *"Harness read and If-Match are awaiting a decision."* Both have shipped
  (`server/deck-store/src/worker.js:32`, `:555`).

## Only the maintainer can do these (not engineering units)

1. **U15 acceptance on a real deck.** Open a deck from slides.betamobility.ai,
   take the update through the chip, insert a map and a counter from Scenes,
   change their settings in the panel, have Claude change one value with the
   splice tool, then present. Everything it depends on has been live since
   2026-10-14, but the whole path has never been run end to end.
2. **Cowork confirmation.** In one Cowork session, run
   `echo "${CI-unset}"`, check whether `~/.bento` survives a new session, and
   check whether Cowork can fetch `https://slides.betamobility.ai/agents.md`.
   Pairing is the publish path for people, and it has only been reasoned
   about for Cowork, never run there.

Both feed the units below. If U15 finds a break, it goes ahead of everything
except R1.

## Ranked units

Order matters: **R1 goes first** because every Beta edit to `slides/src` made
before the merge widens its conflict surface, and two upstream changes (#695
Tab indent, #689 paste position) land directly under R2.

### R1. Merge upstream v1.2.8 to v1.2.10 (do first)

**Why.** The fork is two releases and 133 commits behind; its own rule is to
merge weekly. Users get faster saves (#792, #793, #794), a lost-offline-edit
fix (#809: a first-saved file must carry its CRDT state), and tighter sync
allowlists (#683, #685, #704). They also get the slide list no longer jumping
on click (#839), embedded font weights declared correctly (#850), Tab and
Shift+Tab indent for bullets (#695), and a table crash fix (#730).

**Cost, from the dry run.**
- 14 conflicted files with 19 hunks. None are in the fork's three kernel files.
- About 8 are mechanical: CHANGELOG, DECISIONS, `slides/package.json` (keep
  Beta's dated version), `schema/slides.json`, `pt.ts`, and `packed.ts`
  (regenerate it, don't hand-merge it).
- `editor.ts` has 3 hunks. `canvas.ts`, `present.ts`, `validate.ts` and
  `vite.config.ts` have one each.
- About 80 commits are dash, spaces, type and home, so they are irrelevant to
  slides but come along with the merge.

**Two decisions inside the unit:**
- **CI layout.** Upstream #778 split `ci.yml` into per-zone workflows and
  composite actions. The fork's `beta` job and the `if:`-gated `validate` job
  need a new home that `test-ci-registered.ts` still accepts.
- **Release environment.** Upstream's K4 signing gate (#824) makes
  `scripts/release.mjs` need Playwright and Chromium, plus a signed
  `history.json`. Decide whether Beta's release adopts it as is.

**Done when:**
- `main` contains `upstream/main` at v1.2.10 by a merge commit.
- The full `beta` job is green, including `test-sync.ts` (crdt.ts changed),
  `test-preview.ts`, `shell-gate.mjs`, the marker rig and the new upstream
  slides rigs.
- A stored deck opened from `/new` saves, presents and exports PPTX in a
  browser.
- `CLAUDE.md` is still the `@AGENTS.md` wrapper.

### R2. Bullets are one list, not a dot and a box per line

**Why.** This is the most-used layout, and it breaks on every surface.
`scripts/lib/beta-general.mjs:55-61` builds each bullet as two text elements:
a `•` with `role: 'list-marker'` and a separate body box.
- **Editor:** Enter adds an unbulleted line that overlaps the next row
  (screenshot `05-typed.png`).
- **Present:** unfilled rows show bare dots, because placeholders hide but
  markers don't (`11-present-bullets.png`).
- **PPTX:** bullets export as literal "•" text runs rather than PowerPoint
  bullets.

**Change.** Each Bullets layout gets one body text element holding a real
list. The editor already makes a list when you type `- ` (markdown autoformat),
and #695 from R1 adds Tab indent. Confirm that `slides/src/export/pptx.ts`
maps list items to native paragraph bullets, and add that if it doesn't (fork
rule 2: an addition inside the existing text case). Rebuild the templates and
re-upload them to `/templates/`.

**Path.** Beta zone (`scripts/lib/`, `beta/`). Any PPTX change is inside the
fork-owned `pptx.ts`. Nothing goes upstream.

**Done when** all of these hold on a deck created at `/new`:
- Enter on a bullet adds a bullet inside the same box, with no overlap.
- Present mode shows no orphan dots.
- The exported PPTX opens with native bullets.
- `test-beta-layouts.ts` and `test-beta-pptx.ts` assert the one-element shape
  and the native bullet output.

### R3. Speaker notes reachable without scrolling past the theme

**Why.** Notes is daily, per-slide work for consultants. Today it is the last
section of the right panel, below the deck-wide theme editor and about ten
code-syntax colour pickers that appear on every slide (`08-notes.png`).

**Change.** The slide panel's order is Slideshow, Theme, Interactivity,
Layout, then Speaker notes. The notes call is already a Beta fork hook
(`slides/src/editor/panels.ts:517`, `this.buildNotes(slide) // BETA FORK`).
Move that call so it comes straight after the Slideshow section. Optionally,
add `Theme` to `CLOSED_BY_DEFAULT` (`panels.ts:233`), since the theme is
deck-wide and rarely touched per slide. Moving notes under the canvas, as
PowerPoint does, is an upstream conversation, not a fork edit.

**Path.** Moves a line that is already a fork hook and keeps its marker. No
new kernel or upstream surface.

**Done when** on a fresh slide at 1440x900, the Notes textarea is visible
without scrolling the panel. Screenshot before and after.

### R4. Analytics on the publish path, inside the existing decision

**Why.** Beta's policy is analytics on by default. The worker records
`deck_new`, `deck_open` and `deck_save` (KTD12: server-side, surface and
outcome only). It records nothing about pairing start or approval, publish by
grant, the 429 and 503 refusals, or library asset uploads. When pairing breaks
for people, nothing shows it.

**Change.** Add outcome events for those routes within KTD12; don't
relitigate it. Add an uptime check on the public pairing routes, which
deliberately return 503 when `LINK_LIMIT` is missing (README:134), reported to
Mission Control. PPTX export happens in the client, so an export event needs
its own short design note. That note is a follow-up, not part of this unit.

**Path.** `server/deck-store/` only (Beta zone). Deploy is the maintainer's.

**Done when:**
- `server/deck-store/test/worker.test.mjs` asserts each new event fires with
  only surface and outcome fields.
- After the deploy, Plausible shows a pairing event from a real pairing.
- The uptime check exists and alerts.

### R5. Deck-store durability

**Why.** Every stored deck lives in one R2 bucket (`DECKS`), with grants in
one KV namespace. I found no versioning, backup or lifecycle configuration.
`If-Match` stops blind overwrites, but nothing recovers a deck that was
overwritten or deleted on purpose.

**Change.** Turn on R2 object versioning (or a scheduled export to a second
bucket) and write the restore procedure into `server/deck-store/README.md`.

**Done when** a deck overwritten in a test bucket has been restored by
following the README, and the README records the result.

### R6. Put a ceiling back on the shell size

**Why.** `dist-single/Bento_Slides.bento.html` is 1,101,491 B, which is 24%
over its `reference` of 889,007 B (`scripts/size-budgets.json`,
`enforce: false`). It has drifted by about 212 KB and nothing fails on it.
Every open, email and Drive preview pays for it.

**Change.** Attribute the 212 KB (pptxgenjs, the scene library, the upstream
merge). Re-baseline `reference` from a CI build after R1, and set a generous
`max` with `enforce: true`.

**Done when** the size rig fails a build that is 5% over the new ceiling, and
the commit names what bought the current bytes.

### R7. PPTX: say what will degrade before export, and fix the two clients notice

**Why.** These elements degrade in `slides/src/export/pptx.ts` (~364–506):
- runtime scenes, embeds and SVG become pictures
- gradients flatten to their first stop
- path arcs become straight lines
- code loses its colouring
- fonts are not embedded, so a client without Geist sees substitutes, and the
  theme fonts say Calibri

The report appears only after export. Gradients and fonts are what a client
sees first.

**Change.**
- Show the degrade report before export, as a confirm, using the same data.
- Map two-stop linear gradients to native gradient fills.
- Set the PPTX theme fonts to the deck's fallback stack (Arial and Times New
  Roman) so substitution is predictable.

**Done when** `test-beta-pptx.ts` covers a gradient fill and the theme-font
mapping, and an exported Beta template opens in PowerPoint with no Calibri.

### R8. More scenes in the library

**Why.** The library holds two scenes (`counter`, `map`). The gallery, the
settings panel and splice-by-id are all built, so each new scene is cheap and
directly useful.

**Change.** Add four scenes consultants ask for, for example a KPI row, a
timeline, a before-and-after comparison and an annotated chart. Add the web
`embed` `url` carve-out in the splice tool, deferred in the 2026-10-13 plan
(lines 120–128).

**Done when** each scene has a manifest entry, a settings form, a captured
still for PPTX, and a `test-beta-library` case.

## Deliberately not ranked

- **Phone ⋯ overflow at 390px and inserts landing at slide centre.** Both are
  real, but they are upstream behaviour, and consultants edit on desktop.
  Report them upstream.
- **Layout picker shows built-ins above "This document".** Partly by design:
  people enter through `/new` with a template. Revisit after R2 if the picker
  still confuses.
- **Splitting the `beta` CI job.** It takes about 250–290 s and showed no
  failures in 30 runs. R1 redraws the CI layout anyway, so decide it there.
- **Interaction rigs for drag, resize and marquee.** Moveable can't be driven
  synthetically. That is upstream's area.
- **`app: "html"` inline embed and a headless Claude collaborator**
  (`docs/beta-claude-authoring-handoff.md`). Runtime slides and the scene
  library cover most of the need. Reopen only if U15 or Robert's next deck
  shows a gap.
- **Housekeeping.**
  - Rename `beta/v131/`, which holds v1.5.0.
  - Fix the stop-hook `tail -1` bug in claude-config.
  - Remove `DRIVE-PREVIEW-TEST.bento.html` from Drive.
  - Delete the locked stale worktree
    `.claude/worktrees/plan-upstream-and-live-scenes`.
