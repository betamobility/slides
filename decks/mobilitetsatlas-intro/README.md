# Danmarks Mobilitetsatlas — an introduction for municipalities

`Mobilitetsatlas-introduktion.bento.html` · 15 slides + 3 state slides ·
presenter Robert Martin · audience: Danish municipalities meeting the atlas for
the first time.

**Published:** <https://decks.betamobility.ai/d/ExgV4CeniH> (behind Access,
`@betamobility.io`). Re-publish a rebuild in place with `PUT
/api/harness/decks/ExgV4CeniH` — a fresh `POST` makes a second deck with a new
link, which is not what you want once the link has been shared.

The deck is **generated**, not hand-edited. Every figure is recomputed from the
atlas's published artifacts and every screenshot is taken by a script here, so
the deck can be rebuilt when the atlas publishes a new edition.

```sh
curl -fsSL https://slides.betamobility.ai/templates/insight-brief.bento.html -o template.bento.html
node build-deck.mjs                 # → Mobilitetsatlas-introduktion.bento.html
node verify-deck.mjs                # validate() + a render of every slide into shots/
node ../../scripts/export-pptx.mjs Mobilitetsatlas-introduktion.bento.html
```

`template.bento.html` and `shots/` are not committed: the template is a download
and the shots are a check, not an artifact.

## Where the numbers come from

Everything is the **published 0.4.0 edition** (22 August 2026) in
`dk-mobility/data/published/`, which is what mobilitetsatlas.dk serves.
`figures.py` and `figures2.py` recompute each figure and print the artifact it
came from; `scatter.py` builds the 98-point scatter and the Pearson r.

| Figure | Source | Check |
|---|---|---|
| 36,204 stops · 1,574 routes · 20 operators | `pt/network-stats.json` | counted, with the counting rule in the artifact's metadata |
| 29 of 98 in E/F/G · 1.15 m · 19% | `league_table.json` | grade counts and population shares match /en/metode exactly |
| 80.1 → 25.2 across the five DST groups | `league_table.json` × `kommune-groups.json` | population-weighted, ratio 3.17 |
| Aarhus 68.6 · B · no. 24 · 70.5 / 66.7 | `league_table.json` | matches the live page |
| A–G bands, counts, population shares | `league_table.json` | 22/9/4/34/17/9/3 = 98 |
| r = −0.664, n = 98 | `trends/<slug>.json` × `league_table.json` | identical to the r the live Explore page prints |

Roskilde's 70.7 / 66.3 → 68.5 and the method copy are quoted from
mobilitetsatlas.dk/en/metode.

## Three things to know before rebuilding

**The three embeds are LIVE, and that took a change on each side.** They frame
`/embed/kommune/<slug>` — an atlas route that renders the map alone, no chrome
(betamobility/dk-mobility#230) — and the shell grants those origins
`allow-same-origin` through `trustedFrameOrigins`.

Both halves are load-bearing, and each was measured, not assumed:

- **The chrome had to go.** A sandboxed frame has an opaque origin, where
  `document.cookie` throws rather than returning `""`. Two chrome components
  read it unguarded, so the ordinary kommune page dies on boot in a frame and
  the browser paints its own "This page couldn't load" — which the shell cannot
  recover from, because it only restores the view on an `error` event and a
  crashed-but-loaded page fires `load`. `diagnose-embed.mjs` reproduces it.
- **The sandbox had to open.** Mapbox GL starts its worker from a `blob:` URL,
  which an opaque origin forbids, so even the chrome-free route renders zero
  canvases under the default flags. `check-sandbox-gl.mjs` runs the same URL
  under three flag sets: 0 canvases with Bento's flags, 1 with
  `allow-same-origin` added, 1 with no sandbox at all.

Every embed still carries its `view`, so offline, in print, in a thumbnail and
in PowerPoint the deck shows a real screenshot rather than a hole.

**The shell matters.** `build-deck.mjs` splices into `template-shell.bento.html`
when present (a locally built shell) and the published template otherwise. Only
a v1.1+ shell carries `trustedFrameOrigins`; splice into an older one and the
maps frame under the old sandbox and paint nothing.

**Byvisning has to be driven by keyboard.** `shoot-byvisning.mjs` reaches the 3D
massing with mapbox's keyboard handler (`=` zooms exactly one level, `Shift+↑`
pitches). Wheel and right-drag were tried three times: their gain is unknown and
nothing reads back, so a frame that never cleared the `detail-buildings`
`minzoom: 15` looks identical to one that did.

## Design

Beta's `insight-brief` template supplies the theme, the three embedded faces and
the six `beta-*` layouts — and since the atlas inlines Beta's tokens verbatim
(`site/app/globals.css`), that palette already IS the atlas palette. The one
addition is the A–G ramp, which is data-encoding colour rather than decoration,
so it is written as literals from the app's own `SATURATED_GRADE_HEX` (the ramp
on municipality pages, and the one in these screenshots) and carries no
`themeRefs`. The palette has twelve fixed slots and no room for seven more.
