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
  data at edit time with an as-of date, and exports editable PowerPoint. Covers
  the three kinds of slide: native slides people edit in bento, code slides
  (syntax-highlighted, morphing between steps) and live HTML scenes (runtime
  slides) spliced into decks in the store. Full
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

## Pick the kind of slide first

Every slide in a Beta deck is one of three kinds. Decide per slide, before
you write anything, because each is authored, stored and updated differently.

| The slide needs | Kind | People can edit it in bento | You write |
|---|---|---|---|
| Text, charts, tables, images, diagrams, morphs, animated SVG | **Native slide** | Everything: move, resize, retype, restyle | Elements in `slide.elements` |
| Source code shown to an audience, or a code walkthrough | **Code slide** (a native slide with a `code` element) | Everything, the code included | A `code` element; one slide per step for a walkthrough |
| A live page: a map to pan, a running demo, script-driven animation, a scene with its own step logic | **Live scene** (runtime slide) | Reorder, notes and the scene's declared properties; not the scene itself | A scene folder, spliced in with `splice.mjs` |

Default to native. A code slide is a native slide, so everything under
Native slides applies to it too. Reach for a live scene only when the browser
itself is the point; the test is under Runtime slides below.

Whichever kind, where the deck lives decides how you write it:

- **A file on disk** (not in the store): edit the `#bento-doc` JSON directly.
  Add, remove and reorder slides and elements freely.
- **A new deck for the store**: build it locally, then create it with the
  `curl` recipe (no live scenes) or `splice.mjs --create` (any live scene).
- **A deck already in the store**: only `splice.mjs`, under the ownership
  rule. You change content by element id and replace or add live scenes; you
  never add, move or reorder native slides or elements.

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

## Native slides

A native slide is ordinary bento elements (`text`, `shape`, `image`,
`chart`, `table`, `svg`, `media`, `code`) placed on the slide. It is the
only kind a person can fully edit in the bento UI, so it is the default.

1. **Instantiate from a Beta layout.** Copy the layout from `doc.layouts`
   (keep its element ids, so the chrome morphs between slides), give the
   slide a new id, and fill `html` on the placeholder elements. Delete a
   placeholder you do not use rather than leaving it empty.
2. **Add elements on the grid.** 96 px margins, content between x = 96 and
   x = 1184, a two-column split at 528 + 32 + 528. Measure text with
   `window.bento.measure()` before you size a box (agents.md).
3. **Every element carries its palette slots and role.** A text element in
   the Beta system looks like this:

   ```json
   { "id": "kpi-share", "type": "text", "x": 96, "y": 208, "w": 528, "h": 120,
     "rotation": 0, "opacity": 1, "html": "38 %", "fontSize": 96,
     "fontFamily": "'Playfair Display', Georgia, serif", "fontWeight": 700,
     "color": "#4A7C59", "align": "left", "valign": "top", "lineHeight": 1.1,
     "role": "title", "themeRefs": { "color": "accent1" } }
   ```

4. **Ids are yours to choose and keep.** Use readable, deterministic ids
   (`kpi-share`, `map-legend`), unique within the slide. They are how
   `edits.json` finds an element later, how morphs pair and how comments
   anchor. An element that should travel between two slides keeps the same
   id on both, and the second slide sets `"transition": "morph"`.
5. **Animated diagrams stay native.** An `svg` element with `@keyframes` in
   its `<style>` animates in present mode and stays movable in the editor
   (agents.md, "Motion without a runtime slide").

In a stored deck, a person may since have moved, resized or restyled what you
wrote. Read the deck first, take ids from that copy, and change only content
through `edits.json` (the key per type is listed under Runtime slides). If the
brief needs a native slide that is not in a stored deck yet, you cannot add
it: ask the person to add a slide from the right layout in the editor, then
fill it by id. Never rebuild the deck to get round this.

## Code slides

Code goes in a `code` element, never in a text element or a screenshot. It
keeps the source as plain text, highlights it, stays editable in the editor
(double-click it), and between two slides it **morphs token by token**: lines
that moved travel to their new place and new tokens fade in.

```json
{ "id": "code-main", "type": "code", "x": 96, "y": 176, "w": 1088, "h": 440,
  "rotation": 0, "opacity": 1,
  "content": "export function fare(km: number) {\n  return 32 + km * 4.5\n}",
  "grammarName": "ts",
  "fontSize": 28, "fontFamily": "'DM Mono', 'Courier New', monospace",
  "color": "#1A1A1A", "align": "left", "valign": "top", "lineHeight": 1.45,
  "role": "body", "themeRefs": { "color": "tx1" } }
```

- **`content`** is the raw source: real newlines (`\n` in JSON), spaces for
  indentation, no HTML and no escaping beyond JSON's own. Every `<` becomes
  `\u003c` when the block is written back, as for any string in the document.
- **`grammarName`** picks the highlighter: `ts`, `js`, `py`, `sql`, `sh`,
  `json`, `yaml`, `go`, `rust`, `java`, `csharp`, `kotlin`, `swift`, `html`,
  `css`, `dockerfile`, `hcl`, `r`, `diff`, `md` and about sixty more (the
  editor's Language menu lists them all). Names are these exact ids: shell is
  `sh`, not `bash`, and an unknown name silently falls back to `js`. Use `diff` to show a change with added
  and removed lines coloured.
- **Colours.** The syntax colours are fixed by the renderer and are not
  palette slots. Only `color`, the colour of plain tokens, is yours: `tx1` on
  a light slide, `bg1` on a dark one. For a panel behind the code, put a
  `shape` rect with `fill` on `bg2` (and its `themeRefs`) under the element.
- **Type.** DM Mono at 24 to 32 px, `lineHeight` about 1.45. Lines do not
  wrap and anything past the box is clipped. At 28 px a 1088 px box holds
  about 60 characters per line, and a box holds `h / (fontSize × lineHeight)`
  lines: about 10 in the 440 px box above. Cut the code to fit rather than
  shrinking the type below 22 px.
- **A walkthrough is a sequence of slides.** Duplicate the slide, change
  `content`, keep the element's `id` the same (or give each copy the same
  `morphId`), and set `"transition": "morph"` on every slide after the first.
  Change a little per step: one function added, one line moved. Put the
  explanation in a title or a side column, not in code comments.
- **In a stored deck** change the source with `edits.json` and the key
  `content`: `[{ "slideId": "s4", "elementId": "code-main", "content": "…" }]`.
  The language, font and box stay as the person left them. For a new step in
  a stored walkthrough, ask the person to duplicate the slide in the editor,
  then change its `content` by id.
- **PowerPoint** gets the code as monospace text without syntax colours; the
  export report names each one (`code-colour`). Say so with the report.
- Code that has to **run** in front of the audience is a live scene, not a
  code element.

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
7. **Offer to publish it**, if the user wants a link rather than a file. The
   deck store lives on the same host as everything else above, behind Beta's
   login, and a harness publishes through the service-token routes with
   `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in the environment
   (they are in 1Password, Development; never put them in a file):

   ```bash
   # create a deck with no runtime slides → 201 {"id":"<id>","url":"https://slides.betamobility.ai/d/<id>"}
   curl -fsS -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
             -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
             -H 'content-type: text/html; charset=utf-8' \
             --data-binary "@<Topic>.bento.html" \
             https://slides.betamobility.ai/api/harness/decks
   ```

   A deck with runtime slides is created with `splice.mjs --create` instead
   (see Runtime slides below). **A deck that is already in the store is
   changed only with `splice.mjs`.** There is no hand-written replace: the
   tool reads the deck, keeps what people arranged, and writes back only if
   nobody saved in between.

   Give the user the `url` from the reply. The token may create, read a deck
   whose id it already has, and replace it; it cannot list decks, so a leaked
   token cannot enumerate anyone's work, and there is no harness way to
   discover an id you were not given. A read hands over the whole file,
   including the deck's live-session owner keys, so treat a downloaded deck
   like the token itself. Anyone signed in at
   `https://slides.betamobility.ai/` sees the deck in the list and can edit
   it; the link is the invitation.

## Runtime slides

A runtime slide is one live HTML scene that fills a whole slide. In present
mode the scene runs in a sandboxed frame; everywhere else (editor,
thumbnails, print, PDF, PowerPoint, an older shell) the slide is its still,
a picture you draw. The guide's "Beta build → Runtime slides" section has the
record shape and the full protocol.

### Use one only when the browser is the point

**Try an `svg` element with `@keyframes` first.** Its `<style>` animations
run in present mode and restart every time the slide is entered, the slide
stays editable in the UI, and most animated diagrams need nothing more (see
"Motion without a runtime slide" in the guide). Text, charts, tables, step
reveals and morphs are native features; never make a runtime slide for them.

Use a runtime slide for what the file's own elements cannot do: a map people
pan and zoom, a live demo, bespoke animation driven by script, anything where
the browser runtime is the thing being shown.

### The project folder

Scenes are files you write and preview in a browser, then splice into the
deck. One folder per deck:

```
<project>/
  deck.json                      --create only: { "title": "…", "slides": [ … ] }
  edits.json                     optional: content changes to native elements
  assets/<name>                  heavy files shared by several scenes
  scenes/<slideId>/index.html    the scene
  scenes/<slideId>/still.svg     or still.png, exactly one
  scenes/<slideId>/scene.json    { "steps": 3, "props": [ … ], "assets": [ … ], "url": "https://…", "insertAfter": "s2" }
  scenes/<slideId>/assets/<name> heavy files this scene lists
```

The folder name under `scenes/` is the slide id. In `scene.json` every key is
optional: `steps` (a whole number, default 0), `props` (a list of
`{ "key", "label", "kind": "text" | "number" | "color", "default" }`),
`assets` (file names, looked up in the scene's `assets/` and then the
project's `assets/`) and `url` (https only: the frame loads that page instead
of `index.html`, which must still exist) and `insertAfter` (update only: add
this scene as a new slide, see below). Keys pressed inside a hosted `url`
page do not drive the show; the presenter clicks outside the frame to get the
arrows back, and offline the still shows.

Assets are stored per deck, not per scene: two scenes may list the same asset
name only when the files hold the same bytes. The same name with different
bytes stops the run before any request, so give one of the files another
name.

### A scene

The scene waits for `bento:init` before it trusts any state, installs its
message listener before it sends `bento:ready`, and leaves slide navigation
to the shell. Start from this:

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #F5F3EF; color: #1A1A1A; font: 28px/1.4 Inter, system-ui, sans-serif; }
  main { padding: 96px; }
  .step { opacity: 0.15; transition: opacity 0.4s; }
  .step.on { opacity: 1; }
  .reduce .step { transition: none; }
</style>
</head>
<body>
<main>
  <h1 id="title"></h1>
  <p class="step">First point</p>
  <p class="step">Second point</p>
  <p class="step">Third point</p>
</main>
<script>
  // Defaults match scene.json, so the file previews on its own in a browser.
  const state = { step: 0, props: { title: 'Title' }, assets: {} }

  function render() {
    document.getElementById('title').textContent = state.props.title
    document.querySelectorAll('.step').forEach((el, i) => el.classList.toggle('on', i <= state.step))
    // state.assets[name] is an object URL, or missing: always draw something without it.
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window.parent) return // never test ev.origin: a sandboxed frame's is 'null'
    const m = ev.data || {}
    if (m.type === 'bento:init') {
      state.step = m.step // the last step when the presenter arrives going backwards
      Object.assign(state.props, m.props)
      document.body.classList.toggle('reduce', m.reduceMotion)
    } else if (m.type === 'bento:step') {
      state.step = m.index
    } else if (m.type === 'bento:props') {
      Object.assign(state.props, m.values)
    } else if (m.type === 'bento:motion') {
      document.body.classList.toggle('reduce', m.reduce)
    } else if (m.type === 'bento:assets') {
      for (const [name, blob] of Object.entries(m.assets)) state.assets[name] = URL.createObjectURL(blob)
    } else {
      return
    }
    render()
  })

  // Keys pressed inside the frame never reach the shell. Forward the ones the
  // scene does not use; the shell steps or changes slide and takes focus back.
  const NAV = { ArrowRight: 'next', ' ': 'next', PageDown: 'next', ArrowLeft: 'prev', PageUp: 'prev', Escape: 'exit' }
  window.addEventListener('keydown', (ev) => {
    const dir = NAV[ev.key]
    if (!dir || ev.defaultPrevented || ev.target.closest?.('input, textarea, select')) return
    ev.preventDefault()
    window.parent.postMessage({ type: 'bento:navigate', dir }, '*')
  })

  render()
  window.parent.postMessage({ type: 'bento:ready' }, '*')
</script>
</body>
</html>
```

Rules the template already follows:

- **Steps belong to the shell.** It counts them from `scene.json`, walks
  them with the arrows before leaving the slide, and tells the scene with
  `bento:step { index }` (from 0). A scene that also moves a step on its own
  arrow handling double-steps. Steps only count once the scene has sent
  `bento:ready`; before that, and in a frame that failed to load, the arrows
  change slide.
- **Nothing reaches a scene before `bento:ready`.** `bento:init { step,
  steps, props, reduceMotion }` comes first, then `bento:assets`.
- **Honour reduced motion** (`reduceMotion` in init, `bento:motion {
  reduce }` later).
- **A scene is self-contained.** Its CSS, script and small data are inline;
  it makes no request for its assets itself.

### The still

The still is a placeholder picture of the scene, drawn by you: a hand-drawn
SVG (the outline of the map, the first frame of the demo, a title) or a small
PNG. It is not a screenshot of a map or a live page. It is what thumbnails,
print, PDF, PowerPoint and older shells show, and what present mode shows
when the frame fails to load.

Keep it small. The hard cap is 200 KB. When the runtime slide is slide one,
keep the still under about 45 KB: every save writes a first-page thumbnail
into the file under a 64 KB budget, the still travels as base64 (a third
larger), and above that budget the thumbnail drops the picture for a tinted
box.

### Budgets and assets

- `index.html`: 256 KB at most, inlined into the deck.
- The still: 200 KB at most, always inlined.
- Anything heavier (a 7 MB map, a GeoJSON, a CSV) goes in `assets/` and is
  listed in `scene.json`: 16 MB per file, at most 64 per scene, types
  png, jpg, webp, svg, json and csv. Names are letters, digits, `.`, `_`
  and `-`. The tool uploads them to the store's asset route; an SVG asset has
  scripts, `foreignObject` and event handlers stripped on upload.
- **Referenced assets play only when the deck is opened from the store by a
  signed-in person.** The shell fetches them from
  `https://slides.betamobility.ai/d/<id>/assets/<name>` and hands the bytes to
  the scene. A copy on disk, in Drive or downloaded runs the scene without
  them, so the scene must still draw something. Assets belong to one deck id:
  a "Duplicate as new deck" copy has none until the tool runs against it.

The tool refuses anything over budget and writes nothing.

### Creating and updating a deck with splice.mjs

The tool is `scripts/splice.mjs` in the beta-slides plugin, next to its
`skills/` folder (in a checkout of betamobility/slides:
`plugins/beta-slides/scripts/splice.mjs`). It needs Node 18 or newer and
nothing else. It reads `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`
from the environment (1Password, Development; never put them in a file) and,
optionally, `SLIDES_STORE_URL` (default `https://slides.betamobility.ai`).

```bash
# a new deck: the published blank template, deck.json's slides, then the scenes
node splice.mjs --create <projectDir> [--dry-run] [--skip-url-check]

# an existing deck: replace or insert runtime slides, apply edits.json
node splice.mjs <deckId> <projectDir> [--edits edits.json] [--title "<title>"] [--dry-run] [--skip-url-check]

# an existing deck, content fixes only (a typo, a figure): no project folder
node splice.mjs <deckId> --edits edits.json [--title "<title>"] [--dry-run]

# an existing deck, renamed: nothing else changes
node splice.mjs <deckId> --title "<title>" [--dry-run]
```

`<deckId>` is the ten characters at the end of `/d/<id>`. Every command
prints what it did and the deck's link. Exit code 0 is success, 1 is a
refusal or a store error (the message says which; a refusal comes before the
deck write, and in update mode the deck itself was not changed), 2 is a usage
error.

Every request to the store times out: 30 seconds for reading or writing a
deck and for the blank template, 120 seconds for each asset upload. A timeout
stops the run with a message naming the request. Assets go up before the deck
is written, so if the run fails after that, the message lists the assets that
were uploaded and says the deck itself was not changed. With `--create`, the
new deck's link is printed as soon as the store creates it; if an asset
upload then fails, the error carries the deck id, and you finish with
`splice.mjs <deckId> <projectDir>` rather than creating a second deck.

- **`--create`**: `deck.json` holds full bento slides, each with an `id`. A
  slide whose id matches a scene folder is where that runtime slide goes;
  other scenes are added after the native slides. The deck gets a fresh
  `docId` and the Beta theme, fonts and layouts from the blank template.
- **Update**: a folder under `scenes/` whose name is a runtime slide in the
  deck replaces that slide. An id two slides share, or the id of a native
  slide, stops the run; the tool never turns a native slide into a runtime
  slide. A folder whose name is not in the deck stops the run too, unless its
  `scene.json` sets `insertAfter`. A runtime slide that holds elements other
  than its still (something pasted onto it, say) stops the run naming those
  element ids, because the replace would delete them; ask the person to move
  or delete them in the editor.
- **Adding a runtime slide to an existing deck**: pick a new slide id that no
  slide in the deck uses, name the folder after it, and set `"insertAfter"` in
  its `scene.json` to the id of the slide it follows, or `"end"` to append.
  The anchor must be a slide in the deck as it is now (not another new
  scene); the new slide goes after it and after any states of it, and takes
  its background. Once inserted, the next run replaces it like any other
  runtime slide and `insertAfter` is ignored.
- **Edits only**: with no scene to change, run
  `splice.mjs <deckId> --edits edits.json`. A run with neither scene folders
  nor edits nor `--title` is refused.
- **`--title "<title>"`** (update only) renames the deck: it changes the
  document title and nothing else at document level. It works alone, or
  beside scenes and edits. With `--create`, the title comes from `deck.json`.
- **The url check**: when a `scene.json` sets `url`, the tool fetches that
  page once before it touches the store (following one redirect) and stops
  if the page refuses to be framed by `https://slides.betamobility.ai`: an
  `X-Frame-Options` header (DENY or SAMEORIGIN), or a
  `Content-Security-Policy` whose `frame-ancestors` does not allow that
  origin. Such a page would show only its still in the deck. A page the tool
  cannot reach (an internal one, say) prints a warning and the run goes on.
  `--skip-url-check` skips the check; use it only when you know the page
  allows framing.
- **`edits.json`** changes the content of native elements by id:
  `[{ "slideId": "s3", "elementId": "t-04", "html": "New text" }]`. The one
  key per type is `html` (text), `content` (code), `src` (image, media),
  `option` (chart) and `rows` (table). Anything else is refused.
- **`--dry-run`** reads the deck and prints the plan without writing. Run it
  first.
- An encrypted deck is refused; the tool does not decrypt. A deck that is in
  a live session while the tool writes is unsupported: collaborators are not
  told the store copy changed.

**Cowork** runs the same commands with its own service token, set in the same
two variables, so it can be revoked without touching local Claude Code runs.
If `node` is not available in Cowork's shell, the tool cannot run there; say
so to the user rather than falling back to a hand-written replace.

### The ownership rule (hard rule)

**Claude owns content, the UI owns geometry.** You replace runtime slides
wholesale and change the text, code, images, chart data and table cells of
native elements by id. You never change an element's position, size or rotation,
never add, remove or reorder slides or elements (the one exception is a new
runtime slide placed with `insertAfter`), and never touch slide notes,
backgrounds or transitions in a stored deck. People move things in the
editor, and their layout always survives your update. The tool enforces this:
it compares what it would write with what it read and refuses any change
outside the rule.

A replace resets the values a presenter set for a scene's properties to your
defaults. The tool's plan output (with `--dry-run` and on a real run) has a
line `<slideId>: presenter values dropped by the replace: key="value", …` for
each replaced slide that had them. Pass that line on to the user.

**Never regenerate a deck from a script once people have edited it.** A
fresh `--create` is a new deck; it does not update the old one.

**Read before you write.** Before you plan a change, read the deck as it is
now, not a copy from earlier in the session:

```bash
curl -fsS -o current.bento.html \
     -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
     -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
     https://slides.betamobility.ai/api/harness/decks/<id>
```

Take slide and element ids from that file, then change it with `splice.mjs`.

### When the tool reports a 412

A 412 means someone saved the deck after the tool read it. The tool reads
again and redoes its changes against the fresh copy, up to three times. If
every attempt loses, it stops with "the owner probably has the deck open":
autosave changes the deck every few seconds while someone edits. Nothing was
written. Tell the user, ask the person to close the deck or stop editing, and
run the command again. Never work around it.

## Self-audit (Beta additions to upstream's list)

- [ ] Every colour is a palette slot via `themeRefs`; no hex in content?
- [ ] Three faces only, full stacks, all embedded (`validate()` shows no
      `font-not-embedded`)?
- [ ] Every text element carries a `role`; slides come from Beta layouts?
- [ ] `meta.author` set; tokens, not literals, in title slides and footers?
- [ ] Every fetched figure has a `Data as of` kicker on its slide?
- [ ] Each slide is the right kind: native by default, source code in a
      `code` element with a real `grammarName`, a live scene only where the
      browser is the point?
- [ ] A code walkthrough keeps one element id across its steps, with
      `morph` on every step after the first, and no line clipped at the box?
- [ ] PPTX exported and its degrade report reported to the user?
