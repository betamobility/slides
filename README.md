# Beta Slides

Beta Mobility's presentation system: a fork of [nyblnet/bento](https://github.com/nyblnet/bento) that builds `bento/slides` with the Beta design system, editable-PPTX export, an `embed` element and a Claude Code plugin. For Beta authors and for Claude.

**Production:** https://slides.betamobility.ai — one host, two surfaces: the deck store (sign in, your decks, `/new`) and the public release channel shipped decks self-update from (current release v2026.9.2, 2026-09-08; v2026.9.1 was the first). `decks.betamobility.ai` is the store's former address and answers `301` until it is deleted.
**Client:** Internal
**Status:** Active, v1.1

## Overview

Beta had no presentation system: decks were made ad hoc, the design system was re-applied by hand each time, and Claude could not create or revise a deck the way it revises a repo. Bento is the only substrate where the document is plain JSON an agent edits directly, the file works from `file://` with no backend, collaboration is end-to-end encrypted with the file itself as the capability, and shipped documents keep opening by explicit platform contract. This fork adds the two things the format lacks, an editable-PPTX path and a live `embed` element, and expresses the Beta design system in Bento's own `theme`, `fonts`, `layouts` and `meta` keys rather than in a parallel layer.

The plans of record are `docs/plans/2026-09-08-001-feat-beta-slides-bento-fork-plan.md` (v1, the fork) and `docs/plans/2026-09-08-002-feat-beta-slides-v1-1-plan.md` (v1.1, the review fixes and the deck store). Upstream's own README is kept verbatim at `docs/upstream-README.md`.

## This is a fork

- **Upstream:** `nyblnet/bento`, tracked as the `upstream` git remote. Only `slides/` and `kernel/` are built; Spaces, Dash, Type and `home/` ride along unbuilt with their CI disabled, not deleted.
- **Cadence:** `main` merges `upstream/main` weekly, or before a release, whichever is sooner. Merge, never rebase.
- **Kernel divergence:** exactly two files, `kernel/src/update.ts` and `kernel/src/sync/online.ts`, which read the signing key and relay host from `AppConfig` instead of constants (plus the `AppConfig` fields in `kernel/src/app.ts`). That lift is offered upstream as a pull request (see `docs/upstream-prs/`). Any further kernel change stops the work and becomes an upstream PR first.
- **Identity:** `appId: 'beta-slides'`, so a Beta deck never self-updates from bento.page and an upstream deck never updates from Beta.
- **Upstream invariants win.** `docs/PLATFORM.md` and `docs/PARALLEL-WORK.md` apply unchanged. Where this fork and an invariant disagree, the fork is wrong.

## Tech Stack

- **App:** TypeScript, Vite, single-file build (`slides/dist-single/Bento_Slides.bento.html`)
- **Relay:** Cloudflare Worker + Durable Object + R2 for encrypted asset blobs (`server/sync-worker`), deployed as `sync.betamobility.ai`
- **Deck store:** Cloudflare Worker + R2 behind Cloudflare Access (`server/deck-store`), deployed as `slides.betamobility.ai`, which also passes the public release paths through to Pages
- **Release site:** static tree published by `scripts/publish-site.mjs` into `betamobility/slides-site`, served by Cloudflare Pages at `beta-slides-site.pages.dev` and reached through the worker
- **Tests:** upstream's `node scripts/test-*.ts` rigs; Beta rigs are `scripts/test-beta-*`
- **Deploy:** releases are cut locally and signed with an offline ECDSA key (`docs/RELEASING.md`)

> **Deviations from default stack:** no Next.js, no Supabase, no Vercel. The product is one HTML file that runs from disk; the only services are a blind relay and a static release site. Tests use upstream's script rigs, not Vitest, so the fork stays mergeable.

## Architecture

```
├── slides/          the app (src/, single-file build)
├── kernel/          shared kernel; two files diverge from upstream (see above)
├── beta/            Beta zone upstream never sees: tokens, fonts, theme; templates/ is generated (gitignored)
├── plugins/         beta-slides Claude Code plugin (skill)
├── scripts/         build, release, rigs; Beta additions are build-beta-* and test-beta-*
├── server/          sync relay worker (sync-worker) and the deck store (deck-store)
├── docs/            upstream docs + docs/plans (Beta) + docs/upstream-prs (Beta)
├── spaces/ dash/ type/ home/   upstream apps, unbuilt here
```

## External Dependencies

| Service | Used for | Credentials |
|---------|----------|-------------|
| Cloudflare Workers + R2 | sync relay at `sync.betamobility.ai` | wrangler OAuth login (`env -u CLOUDFLARE_API_TOKEN`) |
| Cloudflare Workers + R2 + Access | deck store at `slides.betamobility.ai` | wrangler OAuth login; Access apps in the dashboard |
| Cloudflare Pages | release tree at `beta-slides-site.pages.dev` | dashboard |
| GitHub `betamobility/slides-site` | published release tree | `gh` auth |
| `Tools/design-system/tokens.json` | source of `beta/tokens.json` | none (sibling repo) |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BENTO_SITE_DIR` | path to a clone of `betamobility/slides-site`, read by `scripts/release.mjs` and `scripts/publish-site.mjs` |
| `CLOUDFLARE_API_TOKEN` | Beta's DNS-only Cloudflare token. It cannot deploy Workers or Pages: unset it for every wrangler command (`env -u CLOUDFLARE_API_TOKEN npx wrangler …`) and use the OAuth login instead |

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

## Releasing (Beta)

`docs/RELEASING.md` is upstream's procedure and still applies up to the publish step; the Beta differences are these.

- **Versions are dated, `YYYY.M.N`** (`2026.9.1` was the first). Upstream's `v1.0.x` tags already exist in this repository, so a Beta `1.0.x` line would collide on the next `git fetch upstream`; and `kernel/src/update.ts` compares versions as dotted numbers, so a `-beta.1` suffix would compare as `NaN`. Each release adds a `## [YYYY.M.N]` section to `CHANGELOG.md`; its first six bold lead-ins are the signed notes.
- **`gh` must default to this fork.** `gh repo set-default betamobility/slides` once per clone, or `publish-site.mjs`'s `gh release create` resolves to `nyblnet/bento` (the fork's parent) and refuses the tag.
- **The site is deployed to Cloudflare Pages by direct upload**, not by the dashboard's git integration. After `publish-site.mjs` has mirrored and pushed `betamobility/slides-site`:

  ```sh
  cd ../slides-site && npx wrangler pages deploy . --project-name beta-slides-site --branch main
  ```

  Project `beta-slides-site`. Its custom domain was `slides.betamobility.ai`; that hostname belongs to the deck-store worker now, which fetches this project by its `*.pages.dev` name. Do not delete the project — re-attaching its custom domain is the rollback for the host swap. Wrangler needs `wrangler login` (OAuth); the DNS-only `CLOUDFLARE_API_TOKEN` in the shell cannot deploy Workers or Pages, so run wrangler with `env -u CLOUDFLARE_API_TOKEN`.
- **Pages answers `.html` URLs with a 308 to the extensionless path.** `…/Bento_Slides.bento.html` redirects to `…/Bento_Slides.bento`; `fetch` and `curl -L` follow it and the bytes match the manifest hash, so shipped decks and the skill are unaffected. A client that does not follow redirects gets an empty 308. The store worker's pass-through follows redirects for the same reason.
- **The old release-channel landing page is still in the published tree, and nothing links to it.** `site-src/landing.html` used to be what `slides.betamobility.ai/` served; the root is the deck list now, and the two plugin-install lines that page carried moved into that list's footer. It is left published rather than deleted so no shipped link 404s — it is not live, and it is not an entry point.

## Deck store

`server/deck-store/` is a worker at `slides.betamobility.ai` that stores decks in an R2 bucket (`beta-decks`) and serves them unchanged behind Cloudflare Access: a domain-wide Access application for people (Google Workspace, `@betamobility.io`), one path-scoped to `/api/harness/` for a service token so Claude can save from a file harness, and one Bypass application per public prefix. The worker verifies the `Cf-Access-Jwt-Assertion` itself against the team JWKS and refuses everything without one, including `GET /d/<id>`. Any signed-in Beta identity can open, list and edit any deck; only delete is the owner's.

The same worker answers the public release channel on that host by passing `/releases/`, `/templates/`, `/skills/`, `/logo/` and a handful of exact paths through to the Pages project, unread and unmodified. Access governs whether those paths need a login; the worker governs whether a deck is ever served without one. `server/deck-store/README.md` has the route table, the Access setup in the order it must be done, and the live checker.

```sh
cd server/deck-store
env -u CLOUDFLARE_API_TOKEN npx wrangler deploy      # after R2 is enabled and the bucket exists
```

Setup order (R2, SSL Full (Strict), deploy, the two Access applications, the `ACCESS_TEAM_DOMAIN`/`ACCESS_AUDS` vars) and the route table are in `server/deck-store/README.md`. The rig is `node scripts/test-beta-store.ts` (Miniflare, from `slides/` after `npm ci`).

## Upstream pull requests

Offered to `nyblnet/bento` from this fork. Bodies live in `docs/upstream-prs/`.

- `AppConfig` lift: `publicKeyJwk` and `syncHost` as optional per-app config. Branch `upstream-pr/appconfig-lift`, open as [nyblnet/bento#423](https://github.com/nyblnet/bento/pull/423).
- `embed` element, consumer side in slides, to the `bento/embed` shape. Branch `upstream-pr/embed-consumer`, open as [nyblnet/bento#424](https://github.com/nyblnet/bento/pull/424).
- Layout picker clamped to the viewport (the fork's #12). Branch `upstream-pr/layout-picker-clamp`, open as [nyblnet/bento#425](https://github.com/nyblnet/bento/pull/425).

All three were opened from Johan's GitHub account on 2026-09-08 at his instruction. The branches carry no agent attribution trailers (upstream's hard rule 8); whether upstream accepts them under its rule 10 is upstream's call.
