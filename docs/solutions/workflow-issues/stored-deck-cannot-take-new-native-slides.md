---
title: "An agent cannot add a native slide to a deck in the store, so merging two decks has no clean path"
date: 2026-11-03
category: workflow-issues
module: splice (plugins/beta-slides/scripts/splice.mjs), the ownership rule (runtime slides plan KTD8)
problem_type: workflow_issue
component: tooling
severity: medium
applies_when:
  - "An agent is asked to add slides, or a test slide, to a deck that is already in the store"
  - "Two stored decks are to be merged into one"
  - "Someone asks why a slide an agent added shows only a Live scene panel in the editor"
symptoms:
  - "The only slide splice can insert into a stored deck is a runtime slide (a scene folder or a library scene with insertAfter)"
  - "That slide shows Scenes in the toolbar and a Live scene panel (Inline scene, No adjustable values) instead of the full element editor"
  - "To get an editable slide the person must add a blank one in the editor so the agent can fill it by element id"
root_cause: missing_capability
resolution_type: code_fix
resolved: "2026-11-04, betamobility/slides#84: splice takes { slide, insertAfter } in edits.json"
tags: [splice, ownership-rule, native-slides, runtime-slides, merge, store]
---

# An agent cannot add a native slide to a deck in the store, so merging two decks has no clean path

> **Resolved by #84 (2026-11-04).** `splice.mjs` now takes a native insert,
> `{ "slide": { … }, "insertAfter": "<slide id>" | "end" }` in `edits.json`,
> and `checkOwnership` accepts it on the terms set out under "The fix to build"
> below. SKILL.md and `docs/agents.md` say so. Merging two decks is a series of
> native inserts into the deck people already use: no new link, nothing for
> the person to prepare. `scripts/test-beta-splice.ts` ("native insert")
> covers it. The rest of this page is the history of why it was needed.

## What happened

On 2026-11-03 two decks for Movia's scenario workshop were to be merged the
next morning: the workshop deck (`0OzmgWwEXU`, 18 native slides) and Johan's
simulation talk (`HdQD9xsBjR`, 11 native slides and one runtime slide with a
live map). Asked to insert a test slide at the end of the workshop deck "so we
know it works", the agent used the only insert splice offers, a scene folder
with `"insertAfter": "end"`.

The slide arrived, but as a runtime slide. In the editor it showed `Scenes` in
the toolbar and a `Live scene` panel (`Inline scene · 2 KB`, `No adjustable
values`) where every native slide has the full editor. Johan's reaction: it
"seems to be treated as something different all together which is quite
worrying". The deck itself was fine (the ownership check passed; the read-back
had the 18 slides unchanged plus the new one), but the test had tested the
wrong path: the merge is native slides, and a runtime slide says nothing about
them.

The second attempt worked but is a workaround: Johan added a slide from a
layout in the editor and saved, the agent read its ids
(`slide-mw0yd69t-mrd35`: `title`, `body`) and filled them with `--edits`. The
slide stayed native and fully editable. Johan: "if I have to create blank
slides for you to fill out... that seems like a hack / workaround."

## Why

The ownership rule (`docs/plans/2026-09-14-001-feat-runtime-slides-plan.md`,
KTD8) makes native slides the person's. In a stored deck splice may change
only an element's content key (`CONTENT_KEY` in `splice.mjs`) and may add or
replace runtime slides. `checkOwnership` refuses any slide id it does not
account for, so a new native slide is refused like any other difference. The
scene library inserts (U12) extended the inserts to library scenes, still all
runtime slides.

The rule exists to protect what people arranged in the editor: positions,
sizes, order, notes. Appending new native slides touches none of that, so the
rule is stricter than its purpose for this case.

## What to do today

- **One or two slides:** the person adds them from a layout in the editor and
  saves; the agent reads the deck, takes the new slide's element ids and fills
  them through `edits.json`.
- **A merge of whole decks:** build one new deck. Read both stored decks,
  combine their `slides` (and the `assets` the slides reference) in a local
  `deck.json` with scene folders for the runtime slides, and create it with
  `splice.mjs --create`. Every native slide stays native. The cost is a new
  link: do it before anyone edits, and retire both old links so edits do not
  land in the wrong copy.
- **Before inserting a runtime slide as a "test", say what it is.** It is
  edited differently from every other slide, and a person who has not seen
  one will read the Live scene panel as something broken.

## The fix to build

An append-only native insert in splice: an `edits.json` entry such as
`{ "insertAfter": "<slide id>" | "end", "slide": { … native slide … } }`.

- The new slide id must not be in the deck as read, as for scene inserts.
- Its elements carry layout ids, palette slots in `themeRefs` and roles, as
  for `--create`.
- `checkOwnership` treats inserted native ids as it treats inserted runtime
  ids: every slide that was in the read must come out byte-identical apart
  from the content edits named, and the read slides keep their relative order.
- Assets the new slide references are interned the same way scenes' are.
- Tests: an insert at the end and after a named slide; a refusal for an id
  already in the deck; a refusal when an existing slide moves, changes or
  disappears in the same run; a 412 retry that re-derives the insert against
  the fresh read.

With that in place, merging decks becomes a series of inserts into the deck
people already use, with no new link and nothing for the person to prepare.
SKILL.md ("A deck already in the store") and `docs/agents.md` would then say
native inserts are allowed and keep "never move or reorder" as the rule.
