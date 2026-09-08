---
name: beta-slides
description: >-
  Create and edit Beta Mobility presentations — single-file .bento.html decks
  whose document is plain JSON in a "#bento-doc" script block, built on the
  Beta fork of bento/slides. Use whenever the user wants a slide deck or
  presentation: starting from NOTHING (it downloads the Beta build from
  slides.betamobility.ai, or starts from a Beta template), from source
  material, or by improving an existing .bento.html. Applies the Beta design
  system through the deck's own theme, layouts and palette slots, refreshes
  data at edit time with an as-of date, and exports editable PowerPoint. Full
  schema + recipes at https://slides.betamobility.ai/agents.md.
---

# Authoring Beta decks

This skill EXTENDS upstream's `bento-slides` skill; it does not replace its
guidance. **Fetch https://slides.betamobility.ai/agents.md before authoring
and follow it in full.** It is upstream's agent guide plus a "Beta build"
section, and everything below assumes you have it open: the document shape,
the material-to-feature mapping (charts, morph, state slides, ken-burns,
motion paths), the self-audit, and the gotchas all live there.

A deck is one self-contained `.bento.html` file. You edit the JSON inside
the `#bento-doc` block only, escaping every `<` as `\u003c`, and never touch
the compressed runtime around it.

## Before reading any deck: the collab check

If `doc.collab` carries `ownerPriv`, `writerPriv` or `invite`, the deck's live
session keys are in the file, and anything that receives the file or its JSON
can join that session and write to it. **Tell the user before you continue**;
only they can decide. The remedies are upstream's: a read-only copy, *Share →
Stop sharing* on a duplicate, or *Share → Rotate keys* if it already went
somewhere. This rule is inherited unchanged.

## Starting from nothing

Prefer a Beta template; fall back to the bare Beta shell. Never download from
bento.page: that shell has upstream's identity and self-updates from upstream.

```bash
# a branded starter (pick the closest shape; each carries the Beta theme, fonts and layouts)
curl -fsSL https://slides.betamobility.ai/templates/client-pitch.bento.html   -o "<Topic>.bento.html"
curl -fsSL https://slides.betamobility.ai/templates/insight-brief.bento.html  -o "<Topic>.bento.html"
curl -fsSL https://slides.betamobility.ai/templates/workshop.bento.html       -o "<Topic>.bento.html"

# or the bare Beta build, then apply the theme fragment from agents.md "Beta build"
curl -fsSL https://slides.betamobility.ai/releases/slides/Bento_Slides.bento.html -o "<Topic>.bento.html"
```

A template is `template: true` with no `docId` and no `collab`. Keep it that
way in the file you write: the app mints a fresh identity on first open. When
editing an existing deck, never regenerate `docId`.

## Beta rules (on top of upstream's)

1. **No hex colours in content.** Every colour on an element is a palette
   slot recorded in `themeRefs` (`{ "color": "tx1" }`, `{ "fill": "accent1" }`,
   `{ "fill": "accent1 -20%" }`), with the literal filled from `doc.theme`.
   Slots: `bg1 tx1 bg2 tx2 accent1..accent6 hlink folHlink`. A brief that asks
   for a colour outside the system gets the nearest slot and one sentence on
   why: the design system is the deck's identity, and a deck that breaks it
   is not a Beta deck. Do not restate this on every slide.
2. **Typefaces are the three the deck carries.** Playfair Display for titles
   (`theme.headingFamily`), Inter for body (`theme.fontFamily`), DM Mono for
   kickers, numbers and tags. Always the full stack string, never a bare
   family name. No other faces; they would not travel in the file.
3. **Use the Beta layouts by name and set `role`.** `beta-title`,
   `beta-section`, `beta-two-col`, `beta-chart-text`, `beta-hero`,
   `beta-closing` live in `doc.layouts`. Instantiate slides from them (same
   element ids, so chrome morphs), keep `role` on every text element
   (`title | subtitle | body | kicker`), and use the guide's column
   arithmetic: 96 px margins, a 1088 px band, rows flush at x = 1184.
4. **Write `meta.author`** (the person presenting) and keep `meta.company`.
   Title slides and footers use `{{company}}`, `{{author}}`, `{{date}}` and
   `{{page:2}}` tokens, never literal strings.
5. **Refresh data at edit time, stamp it.** For any figure fetched from a
   Beta source (Mission Control, a report, an API), write the VALUE into the
   document and add a `kicker`-role text element on that slide reading
   `Data as of YYYY-MM-DD` (the date you fetched it, ISO). A deck opened on
   stage never fetches anything; the number and its date travel in the file.
6. **Live content goes in an `embed` element** only when the brief needs a
   live surface, and always with a static `view` (SVG) so it renders offline
   and prints. The guide's "Beta build" section has the shape.

## Workflow

1. Run the collab check above.
2. Fetch the agent guide; classify the source material; map it to features
   (chart, table, morph, state slide, hero, sequence, headline number,
   media), exactly as upstream's workflow says.
3. Author from a Beta template or the bare shell, under the Beta rules.
4. `window.bento.validate()` clean, then **open the deck and look at every
   slide** (upstream's rule; a deck nobody rendered is not finished).
5. **Export PPTX** and read the report to the user: every element that
   became a picture or lost a gradient is named there. Say it before they
   send the file. In a browser it is the button beside Export PDF; from a
   file harness (no browser) run the same mapper headlessly:

   ```bash
   node scripts/export-pptx.mjs "<Topic>.bento.html"    # from a checkout of betamobility/slides
   ```

   It writes `<Topic>.pptx` beside the deck and prints the report.
6. Write back the `#bento-doc` block, or return the replacement JSON.

## Self-audit (Beta additions to upstream's list)

- [ ] Every colour is a palette slot via `themeRefs`; no hex in content?
- [ ] Three faces only, full stacks, all embedded (`validate()` shows no
      `font-not-embedded`)?
- [ ] Every text element carries a `role`; slides come from Beta layouts?
- [ ] `meta.author` set; tokens, not literals, in title slides and footers?
- [ ] Every fetched figure has a `Data as of` kicker on its slide?
- [ ] PPTX exported and its degrade report reported to the user?
