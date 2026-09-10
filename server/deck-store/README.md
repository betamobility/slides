# Beta deck store (`beta-decks`)

A Cloudflare Worker at `https://slides.betamobility.ai` that keeps `bento/slides` files in R2 and serves them unchanged behind Cloudflare Access. A deck saved here has a link; a colleague opens the link behind the same login, edits, and saves back in place. The worker never rewrites, indexes or decrypts a deck: on write it checks only that the file carries one `#bento-doc` block holding a `bento/slides` document or a `bento/enc` envelope, and on read it streams the stored bytes.

The same worker also answers the **public release channel** on that host, by passing those paths through to the Pages project unread. So one hostname carries two surfaces with opposite postures — everything below is written to keep them apart.

`decks.betamobility.ai` is the store's former address. It answers `301` for a grace period and is then deleted.

Plans: `docs/plans/2026-09-08-002-feat-beta-slides-v1-1-plan.md` U7 (KTD7 to KTD9, KTD12) and `docs/plans/2026-09-10-001-feat-slides-host-swap-plan.md`.

## Routes

### Public — no assertion, proxied to `PAGES_ORIGIN`

`GET`/`HEAD` only, matched on a prefix boundary, returned byte-for-byte:

| Prefix or path | Who fetches it |
|---|---|
| `/releases/` | shipped decks checking for updates; the skill downloading a shell |
| `/templates/` | the skill; the `/new` page cloning the blank deck |
| `/skills/` | `/plugin marketplace add betamobility/slides` |
| `/logo/` | favicons for the pages |
| `/agents.md`, `/slides/agents.md` | the skill and any agent harness |
| `/robots.txt`, `/sitemap.xml`, `/404.html`, `/LICENSE` | crawlers and the site's own furniture |

Anything not on that list is gated, so a path nobody thought about costs a login prompt and never a served deck. The list lives in `PUBLIC_PREFIXES` / `PUBLIC_PATHS` in `src/worker.js`, and every subrequest goes through one helper (`passThrough`) that strips our Access credentials, flattens `Accept`, follows redirects and returns the body unread.

### Gated — every one behind an assertion the worker verified itself

| Route | Who | Answer |
|---|---|---|
| `GET /` | person | index page, every deck newest first, and New deck |
| `GET /new` | person, or a deck on `file://` | with an opener: the handoff page. Without one, and with `NEW_ENABLED` on: redirect to `/new/blank` |
| `GET /new/blank` | person (the index's New deck) | clone the blank template, mint a `docId`, store it, `302` to `/d/<id>`. `404` when `NEW_ENABLED` is off |
| `GET /api/decks` | person | `{decks:[{id,url,title,kind,owner,writer,created,updated,size,docId?}]}` |
| `POST /api/decks` | person | body = the `.bento.html`; `201 {id,url}`. `?new=1` only changes the analytics event |
| `PUT /api/decks/:id` | person | replace in place; keeps `owner` and `created`, records `writer` |
| `DELETE /api/decks/:id` | owner | `204`; `403` for anyone else |
| `GET /d/:id` | person | the stored bytes, `text/html; charset=utf-8`, `private, no-store`, `nosniff`, report-only CSP |
| `POST /api/harness/decks`, `PUT /api/harness/decks/:id` | service token or person | same handlers as above |

Refusals: `401` with no body when the Access assertion is missing or does not verify (every gated route, including `/d/:id`); `403` for a service token anywhere outside `/api/harness/`; `400` with a one-word reason (`size`, `block`, `json`, `format`) on a write that fails the shape check; `404` with no body for an unknown id or path. The size cap is 32 MB.

In production Access answers first and an anonymous request to a gated path never reaches the worker at all — it gets a **redirect to the login page**, not the `401` the worker would have sent. Both refusals are correct and they are different things: Access governs *availability*, the worker governs *confidentiality*. A wrong Access policy costs a login prompt on a machine path; it can never serve a deck, because the worker verifies the assertion itself regardless.

Every valid `@betamobility.io` identity may read, list, create and replace any deck; that is the store's premise (every signed-in identity is a trusted editor). A service token identifies through `common_name` (Access sends `sub: ""` for service tokens) and may only create and replace, so a leaked token cannot list or read.

Analytics: the worker posts `deck_open`, `deck_save` and `deck_new` to Plausible's events API for the `betamobility.ai` site with `surface: deck-store` and an `outcome`, and nothing else. No id, title, email, path or content leaves the worker. A Plausible failure never fails the response. Public pass-through fetches are **not** tracked: they are anonymous machine requests from shipped files, and they would add volume without insight.

### The retired host

With `REDIRECT_OLD_HOST` on, every request to `decks.betamobility.ai` answers `301` to the same path and query on `slides.betamobility.ai` — **except `GET /new` and `POST /api/decks`**, which keep working there.

Both exemptions are the same reason. A shell already on someone's disk opens `<the storeHost it was built with>/new` and rejects any reply whose origin is not that host; and the handoff page it lands on posts to a *relative* `/api/decks` with `redirect: 'manual'`, so a `301` there arrives as an `opaqueredirect` and the page reports "Signed out" while the document being published is discarded. Redirecting either one breaks a flow in files we can no longer change.

The branch runs **before** the worker's own Access check, so a signed-out person following an old link is redirected rather than sent through a login on a host that is going away. That only works if Access is not gating the old host — see the Access section.

## Configuration (`wrangler.toml` `[vars]`)

| Var | What it is |
|---|---|
| `ACCESS_TEAM_DOMAIN` | the team domain, e.g. `round-smoke-5856.cloudflareaccess.com` |
| `ACCESS_AUDS` | comma-separated AUD tags, one per application whose assertions the worker should accept. **Bypass applications' AUDs do not belong here** — there is no assertion on those paths to verify |
| `PAGES_ORIGIN` | the Pages project the public paths are read from. Never derived from the request: a Worker on a Custom Domain that fetched its own hostname would re-invoke itself |
| `STORE_HOST` | `slides.betamobility.ai`. The canonical origin a created deck's link points at, whichever hostname was called |
| `OLD_HOST` | `decks.betamobility.ai`, the host that redirects |
| `REDIRECT_OLD_HOST` | `on` from cutover step 4. Off until the new host actually answers as the store |
| `NEW_ENABLED` | `on` from cutover step 9, after release v2026.9.3. It gates the blank-deck create only — the index's button, `/new`'s no-opener redirect and `/new/blank` itself, which `404`s when off. `/new` keeps answering a shipped deck's handoff throughout |

None of these are secrets: an AUD tag is public to anyone holding a token, and the JWKS is public. The worker fails closed while the Access vars are empty or still placeholders.

## Setup, in order

Everything here is the maintainer's: it needs the Cloudflare dashboard or an Access-scoped token, never the DNS-only `CLOUDFLARE_API_TOKEN` in the shell.

1. **Enable R2** on the account (paid subscription) and create the bucket:

   ```sh
   cd server/deck-store
   env -u CLOUDFLARE_API_TOKEN npx wrangler r2 bucket create beta-decks
   ```

2. **SSL/TLS mode Full (Strict)** on the `betamobility.ai` zone before the hostname is proxied. Proxying puts the zone's SSL mode in the request path, and Flexible in front of an HTTPS origin loops with `ERR_TOO_MANY_REDIRECTS` that only authenticated users see (`Docs/auth-setup.md`).

3. **Free the hostname, then deploy.** A Worker Custom Domain cannot be created on a hostname that already has a CNAME, and the Pages custom domain is one — so detach `slides.betamobility.ai` from the Pages project first, then deploy. **Do not delete the Pages project:** it still serves the release channel through `PAGES_ORIGIN`, and re-attaching its custom domain is the rollback.

   ```sh
   env -u CLOUDFLARE_API_TOKEN npx wrangler deploy
   ```

   Wrangler needs the OAuth login (`npx wrangler login`) or a token with Workers Scripts: Edit, Workers Routes: Edit, Workers R2 Storage: Edit and Account Settings: Read. Until the Access vars are filled the worker answers `401` to everything, which is the safe state.

   The hostname has no origin between detaching it from Pages and the worker's certificate being issued. Poll the worker's domain status rather than probing the hostname — a probe can poison the local resolver for the negative TTL. What breaks in that window: shipped decks' update checks (they retry on next launch, and a failed check is silent by design), `/plugin marketplace add`, and the skill's downloads. Nothing is corrupted and nothing needs repair afterwards.

4. **Access applications, in this order** (Zero Trust, Access, Applications, Self-hosted). Order matters: create the Bypass applications *first*, or the machine paths are gated for however long the gap lasts, and every shipped deck's update check gets a login page instead of a manifest — silently, with no user seeing an error.

   1. **One Bypass application carrying every public destination** on `slides.betamobility.ai`: `/releases/`, `/templates/`, `/skills/`, `/logo/`, `/agents.md`, `/slides/agents.md`, `/robots.txt`, `/sitemap.xml`, `/404.html`, `/LICENSE`. One Bypass policy (`Everyone`) covers them all. Its AUD stays **out** of `ACCESS_AUDS`.

      A self-hosted application takes up to **fifty destinations**, and Access matches on the most specific *destination* across applications — so ten destinations in one application behave exactly like ten single-destination applications, and are a tenth of the work. (An earlier draft of the plan said one application per prefix; this is the same thing, said shorter.)

      The mechanism is *destination* path scoping — the narrower destination wins and inherits nothing from the broader one. That is a different rule from policy ordering inside one application, which would not give path specificity. **Never put a device-posture check in a Bypass policy:** that combination is documented as broken when a Worker intercepts the request. Bypassed requests carry no assertion and **are not logged**, which is acceptable for anonymous fetches of already-public signed bytes, and is why the live checker below is the only thing that would catch drift.

      A path destination is a bare prefix with **no wildcard**: `slides.betamobility.ai/releases/` covers everything beneath it. Confirmed against production — the harness application has run on `decks.betamobility.ai/api/harness/`, written exactly that way, since 2026-09-08, and it matches `/api/harness/decks`.

   2. **The domain-wide human app** on `slides.betamobility.ai`, policy Allow with the existing Google Workspace login restricted to `@betamobility.io`. Note its AUD.

   3. **The service-token app**, more specific: hostname `slides.betamobility.ai`, path `/api/harness/`, one `non_identity` policy (Service Auth) allowing a service token created under Access, Service Auth. Note this app's AUD and the token's Client ID and Client Secret; the worker records the Client ID (`<hex>.access`, the `common_name` claim) as owner and writer.

   4. **On the old host**, delete the domain-wide application — otherwise Access answers before the worker and the `301` never fires for the signed-out person it exists for. Replace it with two path-scoped Allow applications on `decks.betamobility.ai`, one for `/new` and one for `/api/decks`, so the two exempted handoff paths still arrive carrying an assertion. Keep the old host's AUD in `ACCESS_AUDS` until the host is deleted.

   App edits through the API need `PUT` with the whole object, not `PATCH` (`10405`).

5. **Fill `ACCESS_AUDS`** with the human and service-token AUDs (and the old host's, for now), leave the Bypass AUDs out, and redeploy with `REDIRECT_OLD_HOST = "on"`.

6. **Verify as an authenticated user, as a token, and as nobody.**

   ```sh
   # every published path still reachable with no login — the inverted sweep
   BENTO_SITE_DIR=../bento-site node scripts/check-store-live.mjs

   # byte fidelity, both ways: the two bodies must be identical to each other
   # and to what the Pages origin serves, and the sha256 must match the
   # manifest's signed payload (a JSON string inside the manifest JSON — parse twice)
   curl -s -H 'accept: */*' https://slides.betamobility.ai/releases/slides/Bento_Slides.bento.html | shasum -a 256
   curl -s -H 'accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' \
        https://slides.betamobility.ai/releases/slides/Bento_Slides.bento.html | shasum -a 256
   curl -s https://beta-slides-site.pages.dev/releases/slides/Bento_Slides.bento.html | shasum -a 256

   curl -si https://slides.betamobility.ai/d/<a real id>   # Access login page (302), never a deck
   curl -si -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" \
        https://slides.betamobility.ai/api/decks           # refused: a service token cannot list
   curl -si -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" \
        --data-binary @deck.bento.html https://slides.betamobility.ai/api/harness/decks   # 201 {id,url}

   curl -si https://decks.betamobility.ai/d/<id>           # 301 to the new host
   curl -si https://decks.betamobility.ai/new              # 200-or-login, never a 301
   ```

   Then open `https://slides.betamobility.ai/` in a browser signed in with a Beta account: the index lists the decks, New deck lands you in the editor on `/d/<id>`, a title and ⌘S survive a reload. Re-run the byte-fidelity check **after** the release too — the shell it tested is the one the release replaces.

   An anonymous probe and a signed-in probe exercise different origins here. Both get run, and the browser half by a person.

## Local

```sh
cd server/deck-store
npx wrangler dev --port 8788
```

Local dev has no Access in front, so every request is `401` until an assertion is presented; the rig below shows how to mint one against a stub JWKS. For hands-on work, point `ACCESS_TEAM_DOMAIN` at a team domain you control and paste a real assertion from a browser's `Cf-Access-Jwt-Assertion` header.

## Tests

```sh
cd slides && npm ci
node ../scripts/test-beta-store.ts
node ../scripts/check-store-live.mjs --selftest
```

`scripts/test-beta-store.ts` runs `test/worker.test.mjs` under Miniflare (a devDependency of `slides/`, the `@gfx/zopfli` precedent): a local R2 bucket, RSA keys minted at run time, a stub JWKS the worker's outbound fetch is routed to, a stub Pages origin that records every subrequest, and a stub Plausible endpoint that records events. It pins the route contract, the Access refusals (missing, expired, wrong audience, wrong issuer, wrong email domain, unknown key id after one refresh, bad signature, service token off its routes), the public pass-through (anonymous, byte-identical, from `PAGES_ORIGIN`, carrying none of our credentials), the write validation, byte-identical serving with the KTD9 headers, both `/new` branches, the old-host redirect and its two exemptions, and the analytics payload.

`scripts/check-store-live.mjs` needs the network and the live host, so it is **not** a `test-*` rig and does not run in CI — only its own three cases do (`--selftest`). Run the live sweep after any Access change: Bypassed requests are not logged, so drift there is otherwise silent.
