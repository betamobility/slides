# Beta zone

Everything that makes this fork of [nyblnet/bento](https://github.com/nyblnet/bento) a Beta Mobility build lives here, outside upstream's tree, so a weekly merge from upstream never touches it. Upstream's `slides/`, `kernel/` and `scripts/test-*.ts` stay as they are; this directory adds the Beta identity on top, expressed in Bento's own document keys (`theme`, `fonts`, `assets`, `meta`) rather than a parallel Beta layer.

```
beta/
├── README.md            this file
├── v131/                the design-system snapshot: tokens.json (v1.5.0), SOURCE.md (its commit), Geist fonts, logo, sample images
├── fonts/               DM Mono woff2 (OFL, see fonts/LICENSES.md)
├── logo/                favicons + recolorable wordmark, vendored from the design system (see logo/README.md)
├── library/             the scene library (see library/README.md)
├── theme.json           generated: the theme + fonts + assets fragment every Beta deck carries
└── templates/           generated and gitignored: the template decks, spliced into the built shell
```

## Templates are built, never committed

`beta/templates/*.bento.html` embed the shell they were built from, so a committed copy carries whatever runtime was in `slides/dist-single/` at the time (release 2026.9.1 shipped them on the upstream 1.0.19 runtime). The directory is gitignored; build it from the current shell and let the rig prove it:

```sh
cd slides && npm run build:single                # the shell the templates embed
node ../scripts/build-beta-templates.mjs         # writes beta/templates/{general,blank,client-pitch,insight-brief,workshop}.bento.html
node ../scripts/test-beta-templates-current.ts   # fails on any template whose payload differs from the shell's
```

The documents themselves live in `scripts/lib/beta-layouts.mjs` (`betaTemplates`); that is the file to edit. `scripts/release.mjs` builds the same decks into `site/templates/` for `slides.betamobility.ai`, and `scripts/publish-site.mjs` refuses to publish a template that does not embed the released shell.

## Refreshing the tokens

The design system (`Tools/design-system`, the sibling repo) is the source of truth for colour and type. Its `tokens.json` is vendored into `beta/v131/`, not linked, so a deck builds from this repository alone. The directory name is historical; `SOURCE.md` says which design-system commit the snapshot is (v1.5.0, `5233d68`, token file 3.1.0).

```sh
node scripts/beta-sync-tokens.mjs            # copies ../design-system/tokens.json into beta/v131/ and records its commit in SOURCE.md
node scripts/build-beta-theme.mjs            # writes beta/theme.json from the snapshot and the fonts
node scripts/build-beta-starter.mjs          # the deck a bare shell opens with
node scripts/test-beta-theme.ts              # proves the result is complete, valid, additive and embedded
```

`beta-sync-tokens.mjs` looks for the design system at `../design-system` relative to the repository root. From a worktree or another machine pass `--from <path>` or set `BETA_DESIGN_SYSTEM`. Commit the snapshot and the generated files: the rig fails when `beta/theme.json` is not byte-identical to a fresh generation, so a stale fragment cannot ship.

The generator fails, naming every missing token, when one it needs is renamed or removed upstream. It never substitutes a fallback colour.

## What the fragment carries

`betaFoundation()` in `scripts/lib/beta-general.mjs` builds it; the general template, the blank deck, the starter deck and the other templates all carry the same one.

- `theme.background` white `#FFFFFF`, `theme.color` ink `#1A1A1A`, `theme.accent` deep `#242F30`.
- `theme.palette`: every remaining slot of `slides/src/palette.ts` `PALETTE_SLOTS`: `bg2` subtle surface, `tx2` muted ink, `accent2` sage tint, `accent3` peach tint, `accent4`..`accent6` the grey and ink steps, `hlink` and `folHlink` the ink and muted ink. An element that records a `themeRefs` slot always resolves to a real colour.
- `theme.fontFamily` `'Geist', Arial, sans-serif` for working titles and body; `theme.headingFamily` `'Times New Roman', Times, serif`, the fallback the design system documents for its licensed serif Rhymes, for the cover, chapter, statement, quote and closing titles.
- `theme.chartPalette`: the design system's four chart series (`--chart-1..4`: `#0F2A4A`, `#E4572E`, `#6FA8DC`, `#C7CED6`).
- `theme.table`: subtle header, white rows, the control-border grey, Geist.
- `fonts[]` and `assets`: Geist 300 to 700 and DM Mono 400 as woff2 data URIs, the wordmark and the layouts' images.
- `meta.company` `Beta Mobility`.
- `beta: { designSystem, tokens }`: the design-system commit and token-file version the fragment was built from.

Decks made before 2026-10-14 keep the 1.0.0 theme they were saved with (cream, sage, Inter, Playfair Display); a theme lives in the deck, and nothing rewrites it.

## Fonts a PPTX recipient needs

A Bento deck embeds its faces, so the HTML file renders identically everywhere. A PPTX export cannot carry fonts, so whoever opens the exported deck needs these installed. Both are free under the SIL Open Font License:

| Family | Used for | Download |
|---|---|---|
| Geist | titles, body, labels, tables | https://fonts.google.com/specimen/Geist |
| DM Mono | sources, data callouts and tags | https://fonts.google.com/specimen/DM+Mono |

Without them PowerPoint substitutes a system face; the layout survives, the character does not. Rhymes, the design system's licensed display serif, is not embedded because a deck is a redistributed file and its licence does not travel with it.
