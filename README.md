# Beta Slides

Beta Mobility's presentation system: a fork of [nyblnet/bento](https://github.com/nyblnet/bento) that builds `bento/slides` with the Beta design system, editable-PPTX export, an `embed` element and a Claude Code plugin. For Beta authors and for Claude.

**Production:** https://slides.betamobility.ai (release channel, not yet live; see Status)
**Client:** Internal
**Status:** Active, phase one

## Overview

Beta had no presentation system: decks were made ad hoc, the design system was re-applied by hand each time, and Claude could not create or revise a deck the way it revises a repo. Bento is the only substrate where the document is plain JSON an agent edits directly, the file works from `file://` with no backend, collaboration is end-to-end encrypted with the file itself as the capability, and shipped documents keep opening by explicit platform contract. This fork adds the two things the format lacks, an editable-PPTX path and a live `embed` element, and expresses the Beta design system in Bento's own `theme`, `fonts`, `layouts` and `meta` keys rather than in a parallel layer.

The plan of record is `docs/plans/2026-09-08-001-feat-beta-slides-bento-fork-plan.md`. Upstream's own README is kept verbatim at `docs/upstream-README.md`.

## This is a fork

- **Upstream:** `nyblnet/bento`, tracked as the `upstream` git remote. Only `slides/` and `kernel/` are built; Spaces, Dash, Type and `home/` ride along unbuilt with their CI disabled, not deleted.
- **Cadence:** `main` merges `upstream/main` weekly, or before a release, whichever is sooner. Merge, never rebase.
- **Kernel divergence:** exactly two files, `kernel/src/update.ts` and `kernel/src/sync/online.ts`, which read the signing key and relay host from `AppConfig` instead of constants (plus the `AppConfig` fields in `kernel/src/app.ts`). That lift is offered upstream as a pull request (see `docs/upstream-prs/`). Any further kernel change stops the work and becomes an upstream PR first.
- **Identity:** `appId: 'beta-slides'`, so a Beta deck never self-updates from bento.page and an upstream deck never updates from Beta.
- **Upstream invariants win.** `docs/PLATFORM.md` and `docs/PARALLEL-WORK.md` apply unchanged. Where this fork and an invariant disagree, the fork is wrong.

## Tech Stack

- **App:** TypeScript, Vite, single-file build (`slides/dist-single/Bento_Slides.bento.html`)
- **Relay:** Cloudflare Worker + Durable Object (`server/sync-worker`), deployed as `sync.betamobility.ai`
- **Release site:** static tree published by `scripts/publish-site.mjs` into `betamobility/slides-site`, served by Cloudflare Pages at `slides.betamobility.ai`
- **Tests:** upstream's `node scripts/test-*.ts` rigs; Beta rigs are `scripts/test-beta-*`
- **Deploy:** releases are cut locally and signed with an offline ECDSA key (`docs/RELEASING.md`)

> **Deviations from default stack:** no Next.js, no Supabase, no Vercel. The product is one HTML file that runs from disk; the only services are a blind relay and a static release site. Tests use upstream's script rigs, not Vitest, so the fork stays mergeable.

## Architecture

```
├── slides/          the app (src/, single-file build)
├── kernel/          shared kernel; two files diverge from upstream (see above)
├── beta/            Beta zone upstream never sees: tokens, fonts, theme, templates
├── plugins/         beta-slides Claude Code plugin (skill)
├── scripts/         build, release, rigs; Beta additions are build-beta-* and test-beta-*
├── server/          sync relay worker
├── docs/            upstream docs + docs/plans (Beta) + docs/upstream-prs (Beta)
├── spaces/ dash/ type/ home/   upstream apps, unbuilt here
```

## External Dependencies

| Service | Used for | Credentials |
|---------|----------|-------------|
| Cloudflare Workers | sync relay at `sync.betamobility.ai` | `CLOUDFLARE_API_TOKEN` (wrangler) |
| Cloudflare Pages | release site at `slides.betamobility.ai` | dashboard |
| GitHub `betamobility/slides-site` | published release tree | `gh` auth |
| `Tools/design-system/tokens.json` | source of `beta/tokens.json` | none (sibling repo) |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BENTO_SITE_DIR` | path to a clone of `betamobility/slides-site`, read by `scripts/release.mjs` and `scripts/publish-site.mjs` |
| `CLOUDFLARE_API_TOKEN` | wrangler auth for the relay deploy |

The release signing key lives at `~/.bento/release-key.json` on the maintainer's machine only. Never in the repo, never in CI.

## Development

```sh
cd slides
npm ci
npm run dev                    # dev server
npm run build:single           # → dist-single/Bento_Slides.bento.html
node_modules/.bin/tsc -b       # typecheck
node_modules/.bin/tsc -p ../kernel
node ../scripts/shell-gate.mjs dist-single/Bento_Slides.bento.html
```

The full gate list is the Verification Contract in the plan; CI runs the `beta` job in `.github/workflows/ci.yml`.

## Upstream pull requests

Offered to `nyblnet/bento` from this fork. Bodies live in `docs/upstream-prs/`.

- `AppConfig` lift: `publicKeyJwk` and `syncHost` as optional per-app config. Branch `upstream-pr/appconfig-lift`.
- `embed` element, consumer side in slides, to the `bento/embed` shape. Branch `upstream-pr/embed-consumer`.

Both are prepared for Johan to open: upstream's hard rule 10 declines agent-authored PRs, so they carry no agent attribution and go out under his account.
