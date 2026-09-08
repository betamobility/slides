# Beta zone

Everything that makes this fork of [nyblnet/bento](https://github.com/nyblnet/bento) a Beta Mobility build lives here, outside upstream's tree, so a weekly merge from upstream never touches it. Upstream's `slides/`, `kernel/` and `scripts/test-*.ts` stay as they are; this directory adds the Beta identity on top, expressed in Bento's own document keys (`theme`, `fonts`, `assets`, `meta`) rather than a parallel Beta layer.

```
beta/
├── README.md            this file
├── tokens.slides.json   the Slides overlay: accents, links, chart series, table defaults (hand-edited)
├── tokens.json          generated: design-system tokens plus the overlay, with provenance under _source
├── fonts/               Inter, Playfair Display, DM Mono woff2 (OFL, see fonts/LICENSES.md)
├── theme.json           generated: the theme + fonts + assets fragment every Beta deck carries
└── templates/           generated and gitignored: the three starter decks, spliced into the built shell
```

## Templates are built, never committed

`beta/templates/*.bento.html` embed the shell they were built from, so a committed copy carries whatever runtime was in `slides/dist-single/` at the time (release 2026.9.1 shipped them on the upstream 1.0.19 runtime). The directory is gitignored; build it from the current shell and let the rig prove it:

```sh
cd slides && npm run build:single                # the shell the templates embed
node ../scripts/build-beta-templates.mjs         # writes beta/templates/{client-pitch,insight-brief,workshop}.bento.html
node ../scripts/test-beta-templates-current.ts   # fails on any template whose payload differs from the shell's
```

The documents themselves live in `scripts/lib/beta-layouts.mjs` (`betaTemplates`); that is the file to edit. `scripts/release.mjs` builds the same decks into `site/templates/` for `slides.betamobility.ai`, and `scripts/publish-site.mjs` refuses to publish a template that does not embed the released shell.

## Refreshing the tokens

The design system (`Tools/design-system`, the sibling repo) is the source of truth for colour and type. Its `tokens.json` is vendored, not linked, so a deck builds from this repository alone.

```sh
node scripts/beta-sync-tokens.mjs            # copies ../../design-system/tokens.json, merges the overlay, records the git SHA
node scripts/build-beta-theme.mjs            # writes beta/theme.json from beta/tokens.json and beta/fonts/
node scripts/test-beta-theme.ts              # proves the result is complete, valid, additive and embedded
```

`beta-sync-tokens.mjs` looks for the design system at `../../design-system` relative to `beta/`. From a worktree or another machine pass `--from <path>` or set `BETA_DESIGN_SYSTEM`. Commit both generated files: the rig fails when `beta/theme.json` is not byte-identical to a fresh generation, so a stale fragment cannot ship.

The generator fails, naming every missing path, when a token it needs is renamed or removed upstream. It never substitutes a fallback colour.

## What the fragment carries

- `theme.background` cream `#F5F3EF`, `theme.color` charcoal `#1A1A1A`, `theme.accent` sage `#4A7C59`.
- `theme.palette`: every remaining slot of `slides/src/palette.ts` `PALETTE_SLOTS` (`bg2`, `tx2`, `accent2` to `accent6`, `hlink`, `folHlink`), so an element that records a `themeRefs` slot always resolves to a real colour and never to `paletteOf()`'s accent fallback.
- `theme.headingFamily` `'Playfair Display', Georgia, serif` and `theme.fontFamily` `'Inter', system-ui, sans-serif`.
- `theme.chartPalette`: accent1 to accent5, resolved from the slots so a moved accent moves its chart series.
- `theme.table`: charcoal header with cream text, cream-dark zebra rows, the design system's border colour.
- `fonts[]` and `assets`: four woff2 faces as data URIs (Inter 400 and 700, Playfair Display 700, DM Mono 400), about 114 KB in total.
- `meta.company` `Beta Mobility`.
- `beta: { designSystem, tokens }`: the design-system commit and tokens version the fragment was built from. `validate()` reports it as the one tolerated `unknown-key`; upstream preserves unknown top-level keys.

## The accent decision

The design system defines no accent on purpose. `DESIGN.md` section 7 makes accents project-specific extensions layered on top of the core tokens, so `tokens.json` has no accent, link, chart or table keys and never will. `beta/tokens.slides.json` is the Slides project's extension: sage `#4A7C59` (the betamobility-com accent) as `accent1` and link colour, its hover `#3D6B4A` as the followed-link colour, teal `#40916C` as the second series, and the charcoal and grey steps of the core scale as series three to five. Editing an accent means editing that file and re-running the two scripts; `beta/tokens.json` is overwritten on every sync.

## Fonts a PPTX recipient needs

A Bento deck embeds its faces, so the HTML file renders identically everywhere. A PPTX export cannot carry fonts, so whoever opens the exported deck needs these installed. All three are free under the SIL Open Font License:

| Family | Used for | Download |
|---|---|---|
| Inter | body, labels, tables | https://fonts.google.com/specimen/Inter |
| Playfair Display | headings | https://fonts.google.com/specimen/Playfair+Display |
| DM Mono | code and data callouts | https://fonts.google.com/specimen/DM+Mono |

Without them PowerPoint substitutes a system face; the layout survives, the character does not. The commercial faces in Beta's wider brand (PP Editorial New, Neue Montreal) are not used here because a deck is a redistributed file and their licences do not travel with it.
