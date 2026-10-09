# Handoff: Claude-authored decks that stay live, and slides with full HTML freedom

Written 2026-09-11 after the step-back on Robert's feedback. This is the
thinking, not a plan; the plan comes out of `/ce:brainstorm` once a direction
is picked. Nothing in here is built unless it says so.

## What we were asked

Two questions, verbatim from Johan:

1. How do we automate that a file created via Claude becomes an actual file and
   that Claude keeps updating that?
2. What can we do to achieve the fluid and dynamic way of working of a
   hand-rolled reveal.js file? Separate out slides, split up the presentation
   file, use reveal in parallel and splice somehow. Two decks in parallel is
   fine: one edited in the UI, one more Claude-driven.

Constraint stated up front and kept throughout: **the UI editor stays.** Basic
slides are edited by people in the app.

## Robert's feedback, the two halves

- **Freedom.** Claude either rasterises screenshots (blurry) or spends ages
  building editable vectors. He wants full HTML: animations, maps, the feel of
  Johan's hand-rolled reveal.js meetup deck.
- **Round trip.** Claude reverts his manual UI edits. Root cause, verified:
  `build-frokost-deck.py` hardcodes geometry and regenerates the whole deck,
  and the harness token can only create or replace (`POST`/`PUT`), never read,
  so every regenerate is blind.

His deck `/d/Api0W36RwG`: 33 slides, 13.8 MB, four live `web` embeds that
work, one 6.1 MB traced SVG that is the weight problem.

## What we have, measured

- bento present mode is a Reveal.js overlay (`slides/src/present.ts`).
  "Reveal in parallel" is already how it runs.
- Animated SVG is first class today: `render.ts scopeCss` keeps `@keyframes`
  verbatim (lines 186–193); `present.ts` calls `restartSvgAnimations` on
  every slide change (three call sites). Nothing in `agents.md` says so; its
  one svg line steers towards "compose rects and paths".
- `embed` element (Beta fork): `{type:'embed', app, view (svg, required),
  doc?, url?, live?}`. The `view` goes through the same `sanitizeSvg` scoping
  path; a live sandboxed iframe (`allow-scripts allow-forms`, no same-origin)
  mounts only online and only with `opts.liveMedia`. Thumbnails use
  `svgAsImage`.
- Upstream decision 2026-08-19 on embeds: view + doc + opt-in live iframe;
  `srcdoc` "genuinely works"; the objection was embedding a 500 KB app shell,
  not a small hand-written fragment.
- Sync stack portability: `kernel/src/sync/crdt.ts` has zero browser
  references; `session.ts` four (BroadcastChannel, beforeunload,
  window.setInterval/setTimeout); `online.ts` two plus WebSocket and
  `crypto.subtle`. All of these exist in Node 22. The join flow and
  `netWebSocket` have not been run outside a browser.
- CRDT merge is last-writer-wins per (node, key). A change to `html` on an
  element and a change to `w` on the same element never conflict.
- The meetup deck (`Claude Code Meetup.html`): 110 KB, reveal.js 5.1.0 from
  CDN, 37 sections, 6 `@keyframes`, 5 inline SVG, 2 iframes, 14 relative
  images, one ~30 KB global `<style>`. Per section: min 247 B, median 822 B,
  max 38 KB.

## What others are doing (research, 2026-09-11)

Every "Claude + HTML slides" approach found converges on the shape bento
already has.

- `bluedusk/html-slides`: one self-contained HTML file with the deck as
  embedded JSON. That is bento's format.
- Deckary's Claude Code workflow: a project folder (`index.html`,
  `styles.css`, `assets/`, `feedback.md`) Claude edits in place; the human
  reviews, writes feedback into the repo, Claude iterates. Their framing:
  framework choice depends on **who edits draft two**.
- Slidev, Marp, reveal.js: code-first, Markdown or HTML in, one HTML out. All
  assume the author edits source, not a canvas.

Robert edits draft two in the UI. So the platform is right and both
complaints are gaps in guidance and tooling, not architecture.

## The one rule that makes splicing safe

**Claude owns content. The UI owns geometry.**

A splice keyed by element id that updates content fields (`html`, `view`, an
svg asset, a chart option) and never touches `x/y/w/h` is the whole mechanism.
Robert's script clobbered his map because it had no ownership rule, not
because it was a script.

## Question 1: the deck stays the deck

Three layers, in sequence.

1. **Discipline, no code.** The deck is the document; the generator is
   scaffolding you stop using after v1. Read the deck, change the keys you
   mean, write it back. Goes into the skill as a rule together with the
   ownership split.
2. **Harness read + `If-Match`.** `GET /api/harness/decks/:id` and an
   `If-Match` check on `PUT` (412 on mismatch). Ids are not enumerable, so the
   documented "a leaked token cannot list decks" property holds; what changes
   is that a token can read a deck whose id it already knows. This loosens a
   deliberate security choice in `server/deck-store/src/worker.js` and needs
   Johan's explicit yes. Worker-only change.
3. **Claude as a live collaborator.** A headless client that joins the deck's
   room with an invite key and pushes CRDT ops. Because merge is per key, a
   collaborator changing `html` cannot overwrite a `w` someone dragged; the
   ownership rule falls out of the merge. It also retires the
   two-machines-one-Drive-file question: the relay is the merge point, not the
   filesystem. Promising, untested outside the browser.

## Question 2: the hand-rolled feel

Four primitives, cheapest first.

1. **Animated SVG, already works.** All six keyframes in the meetup deck are
   expressible as an `svg` element today. Docs fix only.
2. **Inline HTML embed: `app: "html"`, `doc` = markup, rendered as a
   sandboxed `srcdoc` iframe.** The "full HTML freedom" primitive. Unlike the
   live `web` embed it is self-contained and works offline. Same sandbox as
   `liveFrame`, one branch inside the existing embed `case` (fork rule 2),
   PPTX degrade already handled through the `view`. Small PR, needs a shell
   release.
3. **Per-slide source files in a repo**, one HTML or SVG per slide, spliced in
   by id under the ownership rule. This is "split the file". The reveal-style
   freedom lives in the source files; the bento deck stays what colleagues
   open and edit.
4. **Live `web` embed** for genuinely external things (maps, dashboards).
   Works today.

What bento cannot do: page-level CSS and JS. The meetup deck's 30 KB global
`<style>` has no equivalent; each inline embed carries its own styles.

## Recommended order

1. Docs: animated SVG with `@keyframes`, embed `view` as a placeholder rather
   than a screenshot, a weight budget, the ownership rule, worked examples
   from the meetup deck. Fixes Robert's next attempt with no code.
2. Harness `GET` + `If-Match`. Worker-only, after Johan's yes.
3. `app: "html"` embed. Small PR plus a shell release.
4. Headless collaborator. Plan first; the join flow is unverified.

## Open items carried from the session

- Harness `GET` + `If-Match`: awaiting Johan's decision.
- `agents.md` section as in step 1 above: offered, not written.
- Stop hook `localhost-url-gate.sh` reads the last line, not the last message
  (`tail -1` on multi-line jq output); fix is `gsub("\n"; " ")`. Documented in
  claude-config #78, not yet fixed.
- `DRIVE-PREVIEW-TEST.bento.html` still sits in Johan's My Drive root.
- Cowork fetching `agents.md` over the network: untested.

## Sources

- https://github.com/bluedusk/html-slides
- https://deckary.com/blog/claude-code-presentations
- https://www.pkgpulse.com/guides/slidev-vs-marp-vs-revealjs-code-first-presentations-2026
