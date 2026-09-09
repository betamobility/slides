# Danmarks Mobilitetsatlas — an introduction for municipalities

`Mobilitetsatlas-introduktion.bento.html` · 15 slides + 3 state slides ·
presenter Robert Martin · audience: Danish municipalities meeting the atlas for
the first time.

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

## Two things to know before rebuilding

**Live embeds are off, deliberately.** Bento sandboxes an embed's iframe without
`allow-same-origin`; the atlas reads `document.cookie` at boot, which throws in
an opaque origin, and the frame renders "This page couldn't load". The shell only
restores the static view on an `error` event, and a crashed-but-loaded page fires
`load`, so nothing recovers it. `diagnose-embed.mjs` shows the failure and shows
it disappearing the moment `allow-same-origin` is added. Until one side changes,
the three embeds carry only their static `view`.

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
`themeRefs`. Bento's palette has twelve fixed slots and no room for seven more.
