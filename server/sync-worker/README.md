# Beta relay (`beta-sync`)

Beta Mobility's deployment of upstream's blind sync relay: a Cloudflare Worker plus one Durable Object room per document, serving `wss://sync.betamobility.ai`. The worker source in `src/` is upstream's, unchanged. Only `wrangler.toml` differs: the worker name, the custom domain, and no R2 blob binding (the `/b/` routes answer 501 and clients inline small assets instead, which upstream documents as supported).

The relay stores ciphertext only. It has no Beta auth and needs none: the file is the capability (`docs/PLATFORM.md` §5, `docs/relay-design.md`).

## Deploy

```sh
cd server/sync-worker
npx wrangler deploy
```

Wrangler needs an identity with Workers rights on Beta's Cloudflare account (`a9f6…dca9`). The `CLOUDFLARE_API_TOKEN` Beta keeps for DNS work has only DNS Edit and Zone Read, so a deploy with it fails with `Authentication error [code: 10000]`. Either run `wrangler login` interactively (OAuth, expires) or use a token with **Workers Scripts: Edit**, **Workers Routes: Edit** and **Account Settings: Read**, and unset the DNS token for the command:

```sh
CLOUDFLARE_API_TOKEN=<workers-token> npx wrangler deploy
```

`custom_domain = true` makes wrangler create the `sync.betamobility.ai` DNS record in the zone itself; no manual CNAME.

Deploy the relay before the client whenever a handshake changes (`docs/PLATFORM.md` §5).

## Smoke

1. `curl -si https://sync.betamobility.ai/` returns a response from the worker (not a Cloudflare 1016/522 page).
2. Open one Beta deck in two browsers on two machines, share from the first, edit in the first; the edit appears in the second within seconds.
3. `node scripts/test-relay-protocol.ts` passes unchanged, proving the fork never touched the protocol.

## Local

```sh
npx wrangler dev --port 8787
```

Then set `localStorage['bento-sync-url'] = 'ws://localhost:8787'` in the deck; the dev override wins over the configured host (`kernel/src/sync/online.ts`).
