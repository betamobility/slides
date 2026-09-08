# Beta deck store (`beta-decks`)

A Cloudflare Worker at `https://decks.betamobility.ai` that keeps `bento/slides` files in R2 and serves them unchanged behind Cloudflare Access. A deck saved here has a link; a colleague opens the link behind the same login, edits, and saves back in place. The worker never rewrites, indexes or decrypts a deck: on write it checks only that the file carries one `#bento-doc` block holding a `bento/slides` document or a `bento/enc` envelope, and on read it streams the stored bytes.

Plan: `docs/plans/2026-09-08-002-feat-beta-slides-v1-1-plan.md`, U7 (KTD7 to KTD9, KTD12).

## Routes

| Route | Who | Answer |
|---|---|---|
| `GET /` | person | index page, every deck newest first |
| `GET /new` | person | handoff page: a deck on `file://` posts its document here, the person clicks Save |
| `GET /api/decks` | person | `{decks:[{id,url,title,kind,owner,writer,created,updated,size,docId?}]}` |
| `POST /api/decks` | person | body = the `.bento.html`; `201 {id,url}` |
| `PUT /api/decks/:id` | person | replace in place; keeps `owner` and `created`, records `writer` |
| `DELETE /api/decks/:id` | owner | `204`; `403` for anyone else |
| `GET /d/:id` | person | the stored bytes, `text/html; charset=utf-8`, `private, no-store`, `nosniff`, report-only CSP |
| `POST /api/harness/decks`, `PUT /api/harness/decks/:id` | service token or person | same handlers as above |

Refusals: `401` with no body when the Access assertion is missing or does not verify (every route, including `/d/:id`); `403` for a service token anywhere outside `/api/harness/`; `400` with a one-word reason (`size`, `block`, `json`, `format`) on a write that fails the shape check; `404` with no body for an unknown id or path. The size cap is 32 MB.

Every valid `@betamobility.io` identity may read, list, create and replace any deck; that is the store's premise (every signed-in identity is a trusted editor). A service token identifies through `common_name` (Access sends `sub: ""` for service tokens) and may only create and replace, so a leaked token cannot list or read.

Analytics: the worker posts `deck_open` and `deck_save` to Plausible's events API for the `betamobility.ai` site with `surface: deck-store` and an `outcome`, and nothing else. No id, title, email or content leaves the worker. A Plausible failure never fails the response.

## Setup, in order

Everything here is the maintainer's: it needs the Cloudflare dashboard or an Access-scoped token, never the DNS-only `CLOUDFLARE_API_TOKEN` in the shell.

1. **Enable R2** on the account (paid subscription) and create the bucket:

   ```sh
   cd server/deck-store
   env -u CLOUDFLARE_API_TOKEN npx wrangler r2 bucket create beta-decks
   ```

2. **SSL/TLS mode Full (Strict)** on the `betamobility.ai` zone before the hostname is proxied. Proxying puts the zone's SSL mode in the request path, and Flexible in front of an HTTPS origin loops with `ERR_TOO_MANY_REDIRECTS` that only authenticated users see (`Docs/auth-setup.md`).

3. **Deploy the worker.** `custom_domain = true` in `wrangler.toml` makes wrangler create the proxied `decks.betamobility.ai` record itself; no manual CNAME.

   ```sh
   env -u CLOUDFLARE_API_TOKEN npx wrangler deploy
   ```

   Wrangler needs the OAuth login (`npx wrangler login`) or a token with Workers Scripts: Edit, Workers Routes: Edit, Workers R2 Storage: Edit and Account Settings: Read. Until the Access vars are filled the worker answers `401` to everything, which is the safe state.

4. **Two Access applications** (Zero Trust, Access, Applications, Self-hosted):
   - **Human app** on the hostname `decks.betamobility.ai`, policy Allow with the existing Google Workspace login restricted to `@betamobility.io`. Note its Application Audience (AUD) tag.
   - **Service-token app**, more specific: hostname `decks.betamobility.ai`, path `/api/harness/`, one `non_identity` policy (Service Auth) allowing a service token created under Access, Service Auth. Access precedence lets the narrower app win on that path, so the human app's policy is not widened and a human on the hostname still gets SSO. Note this app's AUD tag and the token's Client ID and Client Secret; the worker records the Client ID (`<hex>.access`, the `common_name` claim) as owner and writer.
   - App edits through the API need `PUT`, not `PATCH` (`10405`).

5. **Fill the vars** in `wrangler.toml` and redeploy:

   ```toml
   [vars]
   ACCESS_TEAM_DOMAIN = "betamobility.cloudflareaccess.com"
   ACCESS_AUDS = "<human app AUD>,<service-token app AUD>"
   ```

   The team domain is under Zero Trust, Settings, Custom Pages. Both values are public to anyone holding a token, so they are vars, not secrets.

6. **Verify as an authenticated user, and as nobody.**

   ```sh
   curl -si https://decks.betamobility.ai/                     # Access login page (302 to the team domain), never a deck
   curl -si -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" \
        https://decks.betamobility.ai/api/decks                # 403: a service token cannot list
   curl -si -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" \
        --data-binary @deck.bento.html https://decks.betamobility.ai/api/harness/decks   # 201 {id,url}
   ```

   Then open `https://decks.betamobility.ai/` in a browser signed in with a Beta account: the index lists the deck. Fetch `/d/<id>` with the browser's Access cookie and compare bytes to the upload.

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
```

`scripts/test-beta-store.ts` runs `test/worker.test.mjs` under Miniflare (a devDependency of `slides/`, the `@gfx/zopfli` precedent): a local R2 bucket, RSA keys minted at run time, a stub JWKS the worker's outbound fetch is routed to, and a stub Plausible endpoint that records events. It pins the route contract, the Access refusals (missing, expired, wrong audience, wrong issuer, wrong email domain, unknown key id after one refresh, bad signature, service token off its routes), the write validation, byte-identical serving with the KTD9 headers, and the analytics payload. CI runs it in the `beta` job.
