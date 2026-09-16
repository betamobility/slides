---
title: One-Click Publish From Cowork - Plan
type: feat
date: 2026-09-15
topic: one-click-publish-pairing
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
deepened: 2026-09-16
---

# One-Click Publish From Cowork - Plan

## Goal Capsule

**Objective.** A partner working in Cowork gets a deck published to the store with one click in a browser tab they already have open. No file changes hands, no secret is pasted, and no administrator is involved.

**Authority.** `docs/PLATFORM.md` over this plan; this plan's Product Contract over its Planning Contract; Johan's decisions of 2026-09-15 and 2026-09-16 (pairing, 8-hour grants, KV, live scenes in, tool-run pairing, person-level reach) over the defaults below. The store's premise stands: Beta is four partners with equal access, every writer is a signed-in `@betamobility.io` identity, and a grant only ever acts as one.

**Stop conditions.** Stop and ask when: a change would touch `kernel/src/` or `slides/src/` (none is planned); a grant would need to reach list or delete; the shipped editor's `412` contract (`writer: 'person' | 'service'`, the generation header) would change; or the Cowork sandbox turns out unable to run Node or reach the store (U7), which changes the tool's shape rather than its routes.

**Execution profile.** Server-side worker plus one Node tool plus docs. Test-first on the worker rig for every new route and refusal; the rig already mints Access assertions and runs under Miniflare. The two new pages are the same server-rendered HTML the index already is.

**Tail ownership.** Creating the KV namespace, deploying the worker, adding two Bypass destinations in Access, checking the human application's cookie attributes, and running the live checks are the maintainer's (U7). A partner's first real run from Cowork is the acceptance.

**Product Contract preservation.** Changed after review: R3 (the approval page cannot know who started the pairing, so it says what a grant is and when this one was started), R8 (reach spelled out: any deck by id, as a signed-in person), R11 (a delegated read drops the whole `collab` block, not only its private keys, because the remainder is a permanent reader capability); added R19 to R21 and AE7 to AE9 from the security review. Flows unchanged.

---

## Product Contract

### Summary

The agent asks the store to start a pairing, shows the person a link, and the person approves in one click from the session they are already signed into. The store hands the agent a short-lived grant bound to that person, and the agent publishes as them.

### Problem Frame

Half of all decks now begin outside a terminal. Cowork cannot hold `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`: its cloud sandbox holds only session-scoped credentials, and connector tokens are handled server-side and never reach the shell. KTD13 assumed otherwise and recorded that "the worker needs no change".

So the agent authors a complete deck and then stops. The only route to a store link is a person downloading the file, opening it, and using Share to Save to Beta. A colleague hit exactly this on 2026-09-14.

Every design that keeps a credential in the picture fails the bar. Handing over the existing service token is unsafe: it runs to 2027-09-14, and `docs/DECISIONS.md` (2026-09-14) records that a harness read returns the whole file including `doc.collab.ownerPriv`. Minting a short-lived token per request is safe but puts an administrator in the loop for half of all decks. Both ask a partner to handle a secret, which is the thing the product must never do.

Chat needs nothing built. A chat AI cannot call an endpoint at all, but New deck plus About to Replace from JSON already lands a document in the store in two steps.

### Key Decisions

**The agent borrows the person's session; it never holds a credential of its own.** Pairing is the only mechanism that is simultaneously self-service, administrator-free, and free of secret handling. Every token-based alternative fails at least one of the three.

**The person approves in the browser, where they are already signed in.** Access still guards the approval page, so the store learns who is approving without implementing any login of its own.

**A grant has the reach of a signed-in partner, minus list and delete.** Beta is four partners with equal access to every deck from every surface; an agent acting for one of them inherits that. Risk is bounded by lifetime and by what a read returns, not by ownership.

**A delegated read carries no `collab` block at all, and a delegated replace restores the stored one.** The private keys are owner access to the live session; the rest (room, symmetric key, public keys) is a reader capability that would outlive the grant. The tool never reads `collab`, so dropping it costs nothing. Restoring it on write is what keeps a read-modify-write from destroying the keys.

**The publish endpoint is verified by the worker, not by Access.** The agent has no cookie, so Access cannot gate it. `server/deck-store/README.md` already states the worker verifies every assertion itself regardless of Access, so this narrows an existing property rather than introducing one.

**Decks are owned by the approving person.** Ownership follows the grant, so a published deck is deletable by the person who asked for it. A token-owned deck cannot be deleted once its token is gone; the store already holds one such orphan (`/d/NjUTLPOcTq`).

**Chat is out of scope because it is already served**, not because it is hard.

### Actors

- A1. The partner — a signed-in `@betamobility.io` identity who wants a deck and a link back, and who is never asked to handle a secret.
- A2. The Cowork agent — authors the deck, starts the pairing, waits, publishes.
- A3. The store worker — issues pairing codes, verifies the approval, mints and verifies the grant, strips and restores `collab`.
- A4. Cloudflare Access — guards the approval page, which is how the worker learns who approved.

### Requirements

**Pairing**

- R1. The agent starts a pairing without any credential and receives a code for the approval URL and a separate polling handle.
- R2. The person approves at a stable URL by clicking once, from the session they are already signed into.
- R3. The approval page says what is being granted (publish decks as you), for how long, and when this pairing was started, with the agent's label shown as untrusted text; it cannot know who started the pairing and does not pretend to.
- R4. A pairing code expires quickly if nobody approves it, and is single-use.
- R5. The pairing-start endpoint is public and therefore rate-limited and body-capped; an unapproved pairing grants nothing.
- R19. The approve action is accepted only from the store's own page: a cross-site request carrying the person's session is refused, and the pages cannot be framed.

**The grant**

- R6. The grant is bound to the approving person's identity and carries their id, not a token's.
- R7. The grant is short-lived and expires without anyone revoking it.
- R8. The grant reaches create, read, replace and scene-asset upload on any deck by id, the reach of a signed-in person, and nothing else.
- R9. The grant may not list decks and may not delete a deck.
- R10. A person can see and revoke their active grants.
- R21. The raw grant is never stored: the store holds a hash, and the token exists in the open only in the agent's hands.

**Key protection**

- R11. A delegated read returns the document with the `collab` block removed.
- R12. A delegated replace writes the stored `collab` block, not the one in the request body.
- R13. A deck created under a grant is owned by the approving person and is theirs to delete.
- R20. A delegated replace changes only the `#bento-doc` block; a request whose shell differs from the stored one is refused.

**Experience**

- R14. From the person's side the whole flow is: read one line, click one button, receive one link.
- R15. A second deck in the same Cowork session does not require a second approval while the grant is alive.
- R16. When the grant expires mid-session the agent says so plainly and offers to re-pair, rather than falling back to a hand-written replace or asking for a token.

**Operations**

- R17. `scripts/check-store-live.mjs` covers the new public endpoints and asserts that the publish path refuses an unapproved or expired grant.
- R18. The `beta-slides` skill documents the pairing flow and supersedes the Save to Beta hand-back it currently prescribes for Cowork.

### Key Flows

- F1. First publish from Cowork
  - **Trigger:** A1 asks A2 for a deck; A2 has authored it.
  - **Steps:** A2 starts a pairing and shows A1 the link. A1 opens it, sees what is being granted, and approves. A2's poll returns the grant. A2 creates the deck. The store records A1 as owner. A2 returns the link.
  - **Outcome:** A1 clicked once and has a store link.

- F2. Revision in the same session
  - **Trigger:** A1 asks A2 to change content in a deck, its own or a partner's.
  - **Steps:** A2 reuses the live grant. It reads the deck without `collab`, changes content under the ownership rule, and replaces with `If-Match`. The worker restores the stored `collab` block.
  - **Outcome:** The deck changes with no further approval; keys and layout survive.

- F3. The grant expires
  - **Trigger:** A2 attempts a write after the grant's lifetime.
  - **Steps:** The store refuses. A2 tells A1 the approval lapsed and offers to re-pair.
  - **Outcome:** No partial write, and nobody is asked for a credential.

- F4. Nobody approves
  - **Trigger:** A2 starts a pairing; A1 never clicks.
  - **Steps:** The code expires. A2 reports that the deck is built and unpublished, and that the file is a complete deck on its own.
  - **Outcome:** A1 has lost nothing.

### Acceptance Examples

- AE1. **Covers R14.** Given a finished deck in Cowork, when A1 follows the flow, then A1 has performed exactly one click in the browser and typed no secret.
- AE2. **Covers R6, R13.** Given A1 approves a pairing and the agent creates a deck, when A1 opens the store index, then the deck is listed as theirs and is deletable by them.
- AE3. **Covers R11, R12.** Given a deck carrying a `collab` block with `writerPriv`, `ownerPriv`, `invite`, `key` and `room`, when a grant reads it, then the document has no `collab` key; and when that document is written back with one text element changed, then the stored deck still carries its original `collab` block, byte for byte.
- AE4. **Covers R5.** Given an unapproved pairing code or a polling handle, when either is used as a bearer against the publish path, then the store refuses and no deck is created.
- AE5. **Covers R9.** Given a live grant, when it calls the list or delete route, then the store refuses.
- AE6. **Covers R15.** Given one approval, when the agent publishes a second deck before the grant expires, then no second approval is requested.
- AE7. **Covers R19.** Given a valid session, when the approve request arrives from another site, then it is refused and the code stays pending.
- AE8. **Covers R20.** Given a grant replace whose bytes outside the `#bento-doc` block differ from the stored deck, then the store refuses and the stored bytes are untouched.
- AE9. **Covers R21.** Given a pairing approved but not yet polled, when the grant store is dumped, then it contains no usable token.

### Scope Boundaries

- Access service tokens as the delegated credential. Rejected: they cannot be bound to a person, and every variant makes someone handle a secret.
- Administrator-minted per-request credentials. Rejected on the same grounds; it also puts one person in the loop for half of all decks.
- Owner-scoped grants. Rejected on 2026-09-16: partners have equal access to every deck from every surface.
- Chat. Served by New deck plus Replace from JSON.
- Import-from-link. A cheaper first-publish path with no update loop; not part of this.
- Any change to the relay, the release channel, `kernel/src/` or `slides/src/`. The editor needs no change: a grant-created deck has no `collab` until a person opens it, and the editor already mints one then.

#### Deferred to Follow-Up Work

- A `--revoke` flag on the splice tool. Revocation lives on the index page in v1.
- A grant that survives across Cowork sessions for the same person. The sandbox is temporary, so the grant dies with it; a fresh session pairs again.
- Retiring the existing Cowork service token in Access once the pairing flow has carried a real deck.

### Dependencies and Assumptions

- The approval page sits behind the existing Access application, so the worker reads the approver's identity from the assertion it already verifies.
- The splice tool's ownership check is unaffected by stripping `collab`: it diffs what it derived against what it read, and `derive` never touches `collab` (`plugins/beta-slides/scripts/splice.mjs`).
- The worker takes no secret. A grant is an opaque random token; the store holds its hash. `wrangler.toml` stays `[vars]` only, and `README.md`'s "none of these are secrets" stays true.
- The Cowork sandbox can run Node and reach `slides.betamobility.ai` over HTTPS. Unverified until U7; the risk section says what changes if not.
- A shipped editor compares `x-bento-service-gen` and reads the `412` body's `writer` as `'person' | 'service'` (`slides/src/beta/store.ts`). That contract is frozen by files already on disk.

### Outstanding Questions

**Deferred to implementation**

- OQ1. Whether Miniflare supports the Workers Rate Limiting binding. If not, the rig covers single-use, expiry and body caps, and the live check covers the limit.
- OQ2. Where the grant file lives in the Cowork sandbox. The tool tries the home directory, then the working directory, and prints which.

### Sources

- `server/deck-store/src/access.js` `verifyAccess` — the only place identity is derived; a person is an `@betamobility.io` email, a service is a `common_name`.
- `server/deck-store/src/worker.js` router (`fetch`), `replace`, `harnessRead`, `storeBytes`, `inspect`, `putAsset`, `deckHeaders`, `track` — the handlers the publish path reuses, and the two `who.kind === 'service'` branches a grant must take.
- `server/deck-store/src/pages.js` `indexPage`, `newPage`, `mintDocIntoBlock` — the server-rendered pages and the one existing block rewrite.
- `server/deck-store/test/worker.test.mjs` — the Miniflare rig, with `human()`/`service()` claim builders and the `call()` dispatcher every new scenario follows.
- `scripts/test-beta-splice.ts` — the splice rig: a `node:http` proxy playing Access in front of Miniflare; `runTool()` sets the tool's environment.
- `slides/src/editor/editor.ts` `stripCollabSecrets` and `saveReaderCopy` — why room plus symmetric key is a reader capability.
- `slides/src/beta/store.ts` — the shipped reader of `x-bento-service-gen` and the `412` body.
- `kernel/src/sync/session.ts` `attach`/`ensureCollab` — a deck with no `collab` gets one minted on open, so the store never has to.
- `server/deck-store/README.md` "Setup, in order" — how Bypass destinations are added, that a destination is a bare prefix, and why their AUDs stay out of `ACCESS_AUDS`.
- `docs/PLATFORM.md` section 2 — the splice contract a server-side block rewrite must stay inside.
- `docs/DECISIONS.md` 2026-09-14 (service token reads by id; KTD13) and 2026-09-10 (destination-path scoping).
- Cloudflare Workers Rate Limiting binding docs — `simple.limit` with `period` 10 or 60 seconds, `limit({key})` returning `{success}`, per-location and eventually consistent.
- Cloudflare create-service-token API — checked and set aside: `duration` exists, but a service token cannot be bound to a person.

---

## Planning Contract

### Key Technical Decisions

**KTD1. Pairing is the device-authorization shape, with the code in the URL and the start route inside the Bypass prefix.** The agent posts to `POST /api/link/start` and gets two values: a `code` for the approval URL and a `handle` that only the agent knows. The person opens `/link/<code>` (gated by the human Access application) and clicks Approve. The agent polls `GET /api/link/<handle>`. Two values, not one, so anyone who sees the URL cannot collect the grant. The start route lives under `/api/link/` because both the worker's prefix-boundary allowlist and an Access destination match `startsWith('/api/link/')`, which a bare `/api/link` would miss. The code is a fresh `mintId()` (ten base62 characters), single-use, expiring after ten minutes.

**KTD2. A grant is an opaque random token, minted at first poll, never stored.** Approval records consent only: the handle's entry becomes `{state: 'approved', email, exp}`. The first poll after that mints 32 random bytes, stores `sha256(token)` in KV with the person's email, expiry and label under an eight-hour `expirationTtl`, returns the raw token once, and marks the handle delivered. The handle is deleted on the following poll or at its own expiry, so a dropped connection can re-poll once. No signing, no worker secret, and a KV dump between approve and poll holds nothing usable.

**KTD3. Grants live in a new KV namespace, `GRANTS`.** KV has native expiry and per-key reads; R2 has neither, and the deck bucket's `customMetadata` is full. It is the account's first KV namespace. A second entry keyed `person:<email>:<hash>` (trailing colon included in every list prefix) lists the grants for the index page; both are written together and deleted together. Eventual consistency (up to a minute) is acceptable for revocation of an eight-hour grant.

**KTD4. The publish path is `/api/publish/`, a Bypass destination, verified by the worker, fail-closed.** Access bypasses `/api/link/` and `/api/publish/` the way it bypasses the release channel, so requests arrive with no assertion. In the router these two prefixes are dispatched after the old-host `301` branch and beside `isPublicPath`, before `verifyAccess`, which would otherwise answer `401` to every one of them. On those prefixes an Access assertion, if present, is ignored: a person's cookie with no bearer is `401`. Anything under the two prefixes that is not an exact routed method and path is `401` with no body, never `404`, and the bearer is verified before any R2 read so a bad bearer looks the same with a real id and a fake one. Neither prefix joins `PUBLIC_PREFIXES`: that list is pass-through to Pages. Both Bypass AUDs stay out of `ACCESS_AUDS`.

**KTD5. A grant identity is a third `kind`, and every "is this a service write" branch becomes one predicate.** `verifyGrant(req, env)` in a new `src/grant.js` returns `{ kind: 'grant', id: <email>, grant: <hash> }`; `verifyAccess` is untouched. The worker today branches on `who.kind === 'service'` in `storeBytes` (`sg: '1'`), in `replace` (generation bump) and at the asset route, and on `who.kind !== 'user'` at the person gate. A grant must take the service side of all of them, or a shipped editor retries over its write. So those sites become one `agentWrite(who)` predicate (`kind !== 'user'`), and the shared handlers take option flags (`stripCollab`, `restoreCollab`) rather than a parallel handler set that would duplicate the shape check and the `412` logic. `putAsset` takes no identity; admitting a grant is a router change only.

**KTD6. A grant read strips the whole `collab` block, through one shared block rewriter.** `mintDocIntoBlock` in `pages.js` already holds the pattern: one case-insensitive block regex, `JSON.stringify` with `<` escaped as `<`, a refusal on a stray `</scr`. It is lifted into `src/block.js` as `rewriteBlock(html, fn)`, and `mintDocIntoBlock`, the strip and the restore become one-line callers. Deleting `collab` outright, rather than its three private fields, is the security review's finding: room plus symmetric key is what `saveReaderCopy` produces, a reader capability that would outlive the grant. An encrypted deck (`bento/enc`) is served unchanged: its keys are inside the ciphertext. Re-serialising stays inside `docs/PLATFORM.md` section 2 (same id, plaintext, `<` escaped, one block). `content-length` is computed from the rewritten bytes, not `obj.size`; the `ETag` is the stored object's, so `If-Match` keeps working.

**KTD7. A grant replace restores `collab`, then runs the normal checks on the rewritten bytes, and refuses a changed shell.** The handler reads the stored object (a `get`, not the `head` the person path uses), parses its `collab`, sets `incoming.collab` to it (deleting the key when the stored deck has none, `sync` state included), and only then runs `inspect` and the conditional put on the rewritten bytes. Before any of that, the bytes outside the `#bento-doc` block must equal the stored ones, else `400 shell`: `inspect` checks only the block, and a shell swap would run first-party on the store origin for every partner who opens the deck. Create cannot be pinned this way; that stays accepted, as it is for the service token.

**KTD8. Ownership follows the person; the writer is marked as an agent; the `412` contract is frozen.** `owner` is the approving email, so the deck is theirs on the index and deletable by them. `writer` is `grant:<email>`; `rowOf` and the index render it unchanged as the last writer. The `412` body's `writer` field stays `'person' | 'service'` because shipped files read exactly that enum, and a grant write reports `'service'`. The person test becomes "contains `@` and does not start with `grant:`". A grant write bumps the service generation.

**KTD9. Rate limiting is the Workers binding, required in production, plus body caps.** `LINK_LIMIT` (`simple`, 10 requests per 60 seconds, keyed by `cf-connecting-ip`) guards pairing start and polling. With `LINK_LIMIT_REQUIRED` on (production), an absent binding answers `503` on the public routes; off (the rig, `wrangler dev`), the worker runs without it. `POST /api/link/start` requires `application/json`, a body of at most 1 KB and a label of at most 80 characters, answering `400` otherwise; the 32 MB deck cap does not apply here. Single-use codes and the ten-minute expiry are enforced regardless.

**KTD10. The splice tool runs the pairing itself, remembers the grant in a file pinned to one origin, and prefers the service token when both exist.** `splice.mjs --link` starts a pairing, prints the URL with a one-line instruction, polls every two seconds until delivered (or the code expires), and writes `{grant, owner, expires, store}` with mode `0600` to `~/.bento/slides-grant.json`, falling back to `./.bento-grant.json`, both overridable by `SLIDES_GRANT_FILE`. Credential resolution: `CF_ACCESS_*` first (the higher-capability credential, so a stale grant on a developer machine never reroutes a production run), then the grant file, then a refusal naming both. The bearer is sent only to the `store` origin recorded in the grant file; a differing `SLIDES_STORE_URL` is refused. `cfg.api` is `/api/harness` or `/api/publish`; public paths (`/templates/`) and `/d/` links stay on `cfg.store`. `failed()` names the credential that was refused. A `401` on the publish path becomes "the approval lapsed; run `--link` again", and the grant file is deleted.

**KTD11. The approval page and the grant list are server-rendered in `pages.js`, and the label is untrusted.** Same head, same CSS, same `esc()`, no Plausible script on `/link/` pages (the path would carry the code to a third party). Fixed copy carries the meaning: "Whoever started this pairing will be able to publish decks as you for 8 hours. Approve only if you asked an agent to publish in the last few minutes." The label is rendered quoted, as what the agent called itself, and the pairing's start time is shown. The index gains an "Agent access" section listing active grants with a Revoke button each.

**KTD12. No new rig; three existing rigs grow.** The worker rig gains the pairing, grant, strip and restore scenarios; the splice rig's proxy learns to pass a bearer through and to play the approval; the skill rig's Cowork assertions are rewritten. No new `test-*` file means no CI registration change.

**KTD13. Approve and revoke are same-origin, nonce-bound, unframeable.** Both pages sit under the human Access application, so Access injects the assertion on any request carrying the session cookie, including a cross-site auto-submitting form. The worker therefore requires `Sec-Fetch-Site: same-origin` (or an `Origin` equal to the request origin) on `POST /link/<code>/approve` and on revoke, plus a per-code nonce stored in `link:<code>` and rendered into the form. `/link/*` and `/` carry `content-security-policy: frame-ancestors 'none'` and `x-frame-options: DENY`. U7 checks the human application's cookie `SameSite` attribute, but the worker check is required regardless.

### High-Level Technical Design

```mermaid
sequenceDiagram
    participant A as Cowork agent (splice.mjs --link)
    participant S as Store worker
    participant P as Person (browser, signed in)
    participant CF as Cloudflare Access
    A->>S: POST /api/link/start {label}  (Bypass, rate-limited, 1 KB)
    S-->>A: {code, handle, url, expires}
    A->>P: "Open <url> and click Approve"
    P->>CF: GET /link/<code>
    CF->>S: + Cf-Access-Jwt-Assertion
    S-->>P: approval page (fixed copy, quoted label, start time, nonce)
    P->>S: POST /link/<code>/approve  (same-origin + nonce)
    S->>S: handle := approved by <email>; delete link:<code>
    S-->>P: "Done, you can close this tab"
    loop until delivered or code expired
        A->>S: GET /api/link/<handle>
        S-->>A: 202 pending | 200 {grant, owner, expires} (mint now, store hash) | 410 gone
    end
    A->>S: POST /api/publish/decks  (Bearer grant)
    S-->>A: 201 {id, url}  owner=person, writer=grant:person, sg=1
    A->>S: GET /api/publish/decks/:id
    S-->>A: document without collab, recomputed content-length, stored ETag
    A->>S: PUT /api/publish/decks/:id  If-Match
    S->>S: shell bytes == stored? incoming.collab := stored.collab; inspect; put
    S-->>A: 200 + new ETag + generation
```

Router order, top to bottom: the old-host `301` branch; the public release-channel pass-through; the two Bypass prefixes `/api/link/` and `/api/publish/` (bearer or nothing, assertions ignored, fail-closed `401`); then `verifyAccess` and everything that exists today.

Identity and reach, after the change:

| Caller | How the worker knows | Reaches |
|---|---|---|
| Person | Access assertion, email | everything under the human app, plus own grants |
| Service token | Access assertion, `common_name` | `/api/harness/` create, read (unstripped), replace, assets |
| Grant | Bearer, hash lookup in KV | `/api/publish/` create, read (no `collab`), replace (collab restored, shell pinned), assets; any deck by id |

### Sequencing

U1 (grant store) and U2 (pairing) are the foundation and can be built together. U3 (publish routes and identity threading) depends on U1. U8 (block rewriting: strip, restore, shell pin) depends on U3 and is the only unit that changes the "streams the stored bytes" posture. U4 (grant list) depends on U1. U5 (tool) depends on U2, U3 and U8 being reachable under Miniflare. U6 (docs) depends on U5's final flags. U7 (rollout) last, and it is the only unit with maintainer steps.

### Implementation Constraints

- Node built-ins only in `plugins/beta-slides/` (KTD11 of the runtime-slides plan). The pairing client is `fetch` and `node:fs`.
- Every response that carries a deck body carries `ETag` and `x-bento-etag` both, and `x-bento-service-gen`.
- The `412` body's `writer` enum and the generation header are shipped contracts and do not change.
- `docs/DECISIONS.md` gets one entry superseding KTD13's "Cowork has its own service token".
- Prose that names the Access AUDs or the Bypass destinations is copied from `wrangler.toml` and `README.md`, never restated from memory.

---

## Implementation Units

### U1. Grant store, verification, and the fail-closed prefixes

**Goal:** A module that mints, verifies, lists and revokes grants in KV, and a router that recognises a bearer on the two Bypass prefixes and refuses everything else there.

**Requirements:** R6, R7, R9, R10, R21.

**Dependencies:** none.

**Files:**
- `server/deck-store/src/grant.js` (new)
- `server/deck-store/src/worker.js` (router: the two prefixes dispatched before `verifyAccess`; `agentWrite(who)` replacing the `=== 'service'` sites)
- `server/deck-store/wrangler.toml` (`[[kv_namespaces]]` binding `GRANTS`)
- `server/deck-store/test/worker.test.mjs` (`kvNamespaces: ['GRANTS']`, new scenarios)

**Approach:** `mintGrant(env, email, label)` writes `grant:<hash>` and `person:<email>:<hash>` with the same value and TTL and returns the raw token once. `verifyGrant(req, env)` reads the bearer, hashes it, looks it up, checks `exp` against the clock, and returns the grant identity or null. `listGrants(env, email)` lists the `person:<email>:` prefix; `revokeGrant(env, email, hash)` deletes both keys. The bearer never appears in a log, an error body or an analytics event.

**Patterns to follow:** `verifyAccess` in `src/access.js` for shape and fail-closed defaults; `mintId` for randomness.

**Test scenarios:**
- Happy path: a minted grant verifies and yields `{ kind: 'grant', id: email }`.
- A tampered bearer (one character changed) does not verify.
- A revoked grant does not verify, and no longer appears in the person's list.
- Expiry: a grant whose stored `exp` is in the past does not verify even if KV still holds it.
- Listing returns only the caller's grants; `alice@` must not match `alice@betamobility.io` by prefix accident.
- Covers AE4 / AE5. A person's assertion with no bearer on `/api/publish/decks` is `401`; a bearer on `/api/decks` is `401`; anonymous `GET /api/publish/decks/<real id>` is `401` with no body; an unrouted path under either prefix is `401`; bare `/api/link` is `401`.
- A malformed `Authorization` header is `401`, no body.

**Verification:** `node scripts/test-beta-store.ts` green with the new checks, and the bearer appears in no recorded Plausible event or response body.

### U2. Pairing endpoints and the approval page

**Goal:** The device-authorization flow: start, approve, poll, expire, with the approve action protected against cross-site requests.

**Requirements:** R1, R2, R3, R4, R5, R19, R21.

**Dependencies:** U1.

**Files:**
- `server/deck-store/src/worker.js` (`POST /api/link/start`, `GET /api/link/:handle`, `GET /link/:code`, `POST /link/:code/approve`)
- `server/deck-store/src/pages.js` (`linkPage`, `linkDonePage`, frame headers)
- `server/deck-store/wrangler.toml` (rate-limit binding `LINK_LIMIT`, `LINK_LIMIT_REQUIRED = "on"`)
- `server/deck-store/test/worker.test.mjs`

**Approach:** Start requires `application/json` and at most 1 KB, takes an optional `label` (80 characters), mints `code`, `handle` and a nonce, stores `link:<code>` → `{handle, label, nonce, created}` and `handle:<handle>` → `{state: 'pending'}` with a ten-minute TTL, and answers `{code, handle, url, expires}`. `GET /link/<code>` (person) renders the page with the fixed copy, the quoted label, the start time and the nonce, or `410`. Approve (person) requires same-origin and the nonce, records consent on the handle, deletes `link:<code>`, and renders the done page. Poll answers `202` while pending, mints and returns the grant once on the first poll after approval, marks the handle delivered, deletes it on the next poll or at expiry, and answers `410` when unknown or expired. Rate limiting per KTD9 on start and poll.

**Patterns to follow:** `newPage` for page structure; `createBlank` for the redirect-after-write shape.

**Test scenarios:**
- Covers F1. Start, approve as alice, poll: first poll `200` with a grant that verifies as alice; second poll `410`.
- Poll before approval: `202`, no grant material in the body.
- Covers AE9. Between approve and the first poll, no KV value contains a token that verifies.
- A dropped delivery: after the first `200`, one more poll is still answered (the handle is deleted on that poll), a third is `410`.
- Covers F4 / R4. A code approved twice: `410`; a code polled after expiry: `410`.
- Covers AE4. A handle sent as a bearer to the publish path is `401`.
- Covers AE7. Approve with a valid assertion and `Sec-Fetch-Site: cross-site` (or a foreign `Origin`) is `403` and the code stays pending; approve without the nonce is `403`.
- The approval page carries the fixed copy, "8 hours", the start time, and the label as quoted text; a label containing `<script>` renders inert; the page carries `frame-ancestors 'none'` and `x-frame-options: DENY`; no Plausible script is present.
- Approve without an assertion is `401`; with a service token, `403`.
- Start with a 2 KB body, a non-JSON body, or a 200-character label: `400`.
- With `LINK_LIMIT_REQUIRED` on and no binding: start is `503`; with it off and no binding: start succeeds; with a stub limiter that refuses: `429`.

**Verification:** rig green; the approval page opened under `wrangler dev` with a pasted assertion renders the copy, the label and one button.

### U3. Publish routes and identity threading

**Goal:** A grant can create, read, replace and upload assets on the publish path as the person, with every service-side branch taken.

**Requirements:** R8, R9, R13.

**Dependencies:** U1.

**Files:**
- `server/deck-store/src/worker.js` (`/api/publish/` routes calling `create`, `harnessRead`, `replace`, `putAsset`; `agentWrite(who)`; writer classification in `replace`; `storeBytes` owner/writer for a grant)
- `server/deck-store/test/worker.test.mjs`

**Approach:** Routes mirror `/api/harness/` one-to-one. `storeBytes` records `owner = who.id` and `writer = grant:<id>` for a grant, `sg = 1`. `replace` bumps the generation for any `agentWrite(who)`. The `412` body's person test excludes a `grant:` writer. `putAsset` is admitted for a grant at the router. List and delete are not routed under `/api/publish/`. The strip and restore flags exist here but do nothing until U8 lands.

**Patterns to follow:** `harnessRead`/`replace`/`putAsset` as they stand; the harness route block in the router.

**Test scenarios:**
- Covers AE2 / R13. A grant-created deck lists with `owner` alice and `writer` `grant:alice@…`, is deletable by alice (`204`) and not by bob (`403`).
- A grant replace on a deck bob created in the browser succeeds (any deck by id).
- A grant replace without `If-Match` is `428`; a stale one is `412` with `writer: 'service'` in the body and the generation header.
- Integration: after a grant write, a person's editor-style save without `If-Match` still succeeds and carries the generation forward; a person's save between a grant read and its write makes the grant write `412`.
- Asset upload with a grant: `200`; with a person: `403` (unchanged); the SVG strip still applies.
- Covers AE5. Grant on `DELETE /api/decks/:id`: `401` (the prefix never reaches it).

**Verification:** rig green; every existing harness scenario unchanged.

### U8. Block rewriting: strip on read, restore and pin on write

**Goal:** A grant never receives `collab`, never destroys it, and never changes the shell.

**Requirements:** R11, R12, R20.

**Dependencies:** U3.

**Files:**
- `server/deck-store/src/block.js` (new: `rewriteBlock(html, fn)`, `splitShell(html)` for the outside-the-block comparison)
- `server/deck-store/src/pages.js` (`mintDocIntoBlock` becomes a caller of `rewriteBlock`)
- `server/deck-store/src/worker.js` (`harnessRead` with `stripCollab`; `replace` with `restoreCollab` and the shell pin; `content-length` from the rewritten bytes)
- `server/deck-store/test/worker.test.mjs`

**Approach:** The strip deletes `collab` and re-serialises. The restore runs before `inspect`: `get` the stored object, compare the bytes outside the block with the incoming ones (`400 shell` on any difference), parse the stored `collab`, set it on the incoming document, re-serialise, then `inspect` and put the rewritten bytes. `bento/enc` decks skip both rewrites. `deckHeaders` takes an explicit length for the stripped body.

**Patterns to follow:** `mintDocIntoBlock` for the rewrite and the `</scr` refusal; `docs/PLATFORM.md` section 2 for what must survive.

**Test scenarios:**
- Covers AE3. Store a deck with a full `collab` (`writerPriv`, `ownerPriv`, `invite`, `key`, `room`, `writerPub`, `sync`); a grant read has no `collab` key; write it back with one text element changed and `If-Match`; the stored bytes carry the original `collab` byte for byte and the changed text.
- `content-length` on a stripped read equals the served body; a person's read of the same deck is byte-identical to the upload.
- A deck with no stored `collab`: a grant read has none; the write back stores none; no `collab` key is invented.
- Covers AE8. A grant replace whose shell differs by one byte outside the block is `400`, and the stored bytes are untouched.
- An encrypted deck: a grant read returns the stored bytes unchanged; a grant replace neither parses nor restores `collab`.
- The served bytes for a grant read differ from the stored bytes only inside the `#bento-doc` block; `mintDocIntoBlock`'s existing `/new/blank` scenarios still pass.

**Verification:** rig green; `node scripts/shell-gate.mjs` over a stripped read of a real built deck passes the splice-contract checks.

### U4. Grant list and revoke on the index

**Goal:** A person sees their active grants and can end one.

**Requirements:** R10, R19.

**Dependencies:** U1.

**Files:**
- `server/deck-store/src/pages.js` (`indexPage` gains an "Agent access" section)
- `server/deck-store/src/worker.js` (`POST /api/grants/:hash/revoke`, person-only, own grants only, same-origin)
- `server/deck-store/test/worker.test.mjs`

**Approach:** `indexPage(decks, who, { create, grants })` renders label, created and expires, and one Revoke form each. Revoke requires same-origin, deletes both KV keys and redirects to `/`. A hash that is not the caller's is `403`. The index carries the frame headers from KTD13.

**Patterns to follow:** the deck rows in `indexPage`; `remove` for the owner check shape.

**Test scenarios:**
- Alice with two grants sees two rows; bob sees none of them.
- Revoking one leaves the other; a bearer for the revoked one is `401` on the publish path afterwards.
- Bob revoking alice's grant is `403` and the grant still verifies.
- Revoke from a cross-site request is `403`.
- The index with no grants shows no section.

**Verification:** rig green; the section renders under `wrangler dev`.

### U5. The splice tool pairs and publishes

**Goal:** `splice.mjs --link` runs the pairing end to end; every other command works with a grant.

**Requirements:** R1, R14, R15, R16.

**Dependencies:** U2, U3, U8.

**Files:**
- `plugins/beta-slides/scripts/splice.mjs` (`--link`, grant file, `config()` resolution and `cfg.api`, origin pin, `failed()` wording, expiry message)
- `scripts/test-beta-splice.ts` (proxy passes `Authorization` through and plays the approval; `runTool()` sets `SLIDES_GRANT_FILE` to a rig-owned temp path unconditionally; new cases)

**Approach:** `link()` posts to `/api/link/start` with label `Claude (Cowork)`, prints the URL preceded by one line ("Open this link and click Approve; I'll continue when you have."), polls every two seconds until `200`, `410` or ten minutes, and writes the grant file with mode `0600`. `config(env)` resolves `CF_ACCESS_*` first, then the grant file (only when unexpired and its `store` equals the effective store URL), then refuses naming both. Every API URL is built from `cfg.api`; the template fetch and printed `/d/` links from `cfg.store`. A `401` on the publish path maps to a `Refusal` saying the approval lapsed and to run `--link` again, and deletes the grant file.

**Execution note:** start with the rig case for `--link` against the proxy, then make the tool pass it; the resolution order and `SLIDES_GRANT_FILE` isolation are the parts most likely to regress the existing service-token cases.

**Patterns to follow:** `harness()` for redirect-manual fetches with timeouts; the existing `config()` refusal wording; `runTool()` for child-process runs.

**Test scenarios:**
- Covers F1 / AE6. `--link` prints a URL, the rig approves it, the tool exits 0 having written the grant file; `--create` then `--edits` both succeed with no second approval, both against `/api/publish/`.
- Covers AE1 in the rig's terms: the tool's stdout contains no token, and the grant file is `0600`.
- Covers F4. `--link` when nobody approves: exits non-zero after the code expires, says the deck is unpublished and the file is complete.
- Covers F3 / R16. A grant the rig has revoked: the next run exits non-zero naming `--link`, and deletes the grant file.
- Grant file present and service token present: the service token wins and requests go to `/api/harness/`.
- Grant file whose `store` differs from `SLIDES_STORE_URL`: refused before any request.
- Neither present: the existing refusal names both.
- Every existing service-token case still passes unchanged, with a real grant file present in the developer's home directory.

**Verification:** `node scripts/test-beta-splice.ts` green (needs `cd slides && npm ci` and `node scripts/build-beta-templates.mjs` first).

### U6. Docs, skill, decision, live checker

**Goal:** Every document an agent or maintainer reads says the pairing flow, and the live checker asserts it.

**Requirements:** R17, R18.

**Dependencies:** U5.

**Files:**
- `plugins/beta-slides/skills/beta-slides/SKILL.md` (the Cowork section becomes the pairing recipe; Save to Beta stays as the fallback when the tool cannot run)
- `docs/agents.md` (same, one paragraph)
- `server/deck-store/README.md` (routes table with the fail-closed prefixes, bindings and flags, "Setup, in order" steps for the KV namespace, the two Bypass destinations and the cookie check, verification curls)
- `docs/DECISIONS.md` (entry superseding KTD13)
- `scripts/check-store-live.mjs` (a `--routes` pass: `POST /api/link/start` answers without a login; bare `/api/link` and a bad bearer on `/api/publish/decks` are `401`; `/link/x` is a login redirect; the frame headers are present on `/`)
- `scripts/test-beta-skill.mjs` (assertions for the new text)

**Approach:** The skill's recipe is four lines: run `--link`, relay the printed line to the user, wait, run `--create`. It states that an expired approval means running `--link` again, that the tool never asks for a token, and what the approval page will say so the agent can tell the user what to expect. The README's setup step names the destinations exactly as `wrangler.toml` and the worker spell them.

**Patterns to follow:** the existing "Publishing without a service token" section's structure; `check-store-live.mjs --selftest` for adding a self-tested case.

**Test scenarios:**
- Skill rig: the skill names `--link`, says the approval lasts 8 hours, and no longer tells Cowork to hand the file back as the primary path.
- Skill rig: the skill still gives both splice commands and the ownership rule (existing assertions unchanged).
- `test-doc-index.mjs` still passes.
- `check-store-live.mjs --selftest` covers the new route assertions.

**Verification:** `node scripts/test-beta-skill.mjs`, `node scripts/test-doc-index.mjs`, `node scripts/check-store-live.mjs --selftest` green.

### U7. Rollout and live acceptance

**Goal:** The flow works for a partner from a real Cowork session.

**Requirements:** R5, R14, R17, R19.

**Dependencies:** U1 to U6 and U8 merged.

**Files:** none in the repo beyond `wrangler.toml` (namespace id) and the toolkit regeneration in `betamobility/skills`.

**Approach:** Maintainer steps, in order: create the KV namespace (`env -u CLOUDFLARE_API_TOKEN npx wrangler kv namespace create GRANTS`) and put its id in `wrangler.toml`; deploy; add `/api/link/` and `/api/publish/` as destinations on the existing Bypass application, and confirm a bare prefix matches `/api/link/start`; check the human application's cookie attributes (`SameSite`) in Zero Trust; run `check-store-live.mjs` (inventory sweep and `--routes`); pair from a terminal once; then a partner pairs from Cowork and publishes a deck. Regenerate the toolkit skill (`node scripts/build-beta-toolkit-skill.mjs`) into `betamobility/skills` and merge.

**Test expectation:** none in the rigs; this unit is the live verification.

**Verification:** a deck in the index owned by the partner, created with one click; the live checker green; the grant visible and revocable on their index page; a cross-site approve attempt against the live host refused.

---

## Verification Contract

Run from the repo root after `cd slides && npm ci` and `node scripts/build-beta-templates.mjs`:

- `node scripts/test-beta-store.ts` — the worker rig, every scenario in U1 to U4 and U8.
- `node scripts/test-beta-splice.ts` — the tool rig, U5.
- `node scripts/test-beta-skill.mjs` and `node scripts/test-doc-index.mjs` — U6.
- `node scripts/check-store-live.mjs --selftest` — U6's checker logic.
- `node scripts/test-ci-registered.ts` — no new rig, so it must stay green without a workflow change.
- CI: the `beta` job in `.github/workflows/ci.yml` runs all of the above and must be green on the PR.
- After deploy: `node scripts/check-store-live.mjs` (inventory sweep) and `--routes`; a terminal pairing; a Cowork pairing.

Quality gates: no bearer, code, handle or grant in any log, response body or Plausible event (U1, U2); no raw token in KV at any point (U2); grant reads differ from stored bytes only inside `#bento-doc` and carry no `collab` (U8); a grant write cannot change the shell (U8); every existing rig case unchanged and green.

---

## Definition of Done

- Every rig in the Verification Contract green locally and in CI; PR merged with squash.
- Worker deployed; KV namespace created; the two Bypass destinations added; cookie attributes checked; live checker green.
- One deck created from a real Cowork session by a partner, with one click and no pasted secret; visible as theirs on the index; a grant listed and revocable there.
- `docs/DECISIONS.md` carries the superseding entry; the store README's setup and routes are current; the skill and `docs/agents.md` teach the pairing flow; the toolkit skill is regenerated and merged in `betamobility/skills`.
- Per unit: the scenarios listed under that unit pass, and no scenario from before the unit regressed.
- Cleanup: no fallback code from abandoned approaches (no HMAC signing, no service-token minting, no per-field redaction) left in the worker or the tool.

---

## System-Wide Impact

- **Auth boundary.** A third identity kind exists. Every `who.kind` branch was reviewed and collapsed into `agentWrite(who)`; the person gate stays `kind !== 'user'`, so an unknown kind is `403`.
- **Fail-closed on the two Bypass prefixes.** Access no longer answers there, so the worker does what Access did: `401` with no body for anything not exactly routed, bearer verified before any storage read, assertions ignored. Neither prefix is a pass-through.
- **The store's "streams the stored bytes" posture** now has one exception, confined to U8: grant reads are rewritten inside the `#bento-doc` block, and `content-length` is recomputed. Person and service reads are unchanged.
- **First public non-GET endpoint** on the host (`POST /api/link/start`). It writes a ten-minute KV entry, is body-capped at 1 KB, and is rate-limited or `503`.
- **Shipped contracts untouched.** The `412` body's `writer` enum and `x-bento-service-gen` keep their meaning; a grant write is a service write to every file already on disk.
- **Bypass drift is still silent.** The two new destinations live in the same dashboard-only application as the release channel; the live checker's `--routes` pass is the only thing that notices if they go missing.
- **Revocation lag.** KV is eventually consistent; a revoked grant may verify for up to a minute at another location. Two concurrent first polls may both be answered; only the agent holds the handle, so this is accepted.

## Risks and Dependencies

- **Cowork cannot run Node or reach the store.** Then the tool cannot run there. Mitigation in U6: the skill also carries a `curl` recipe for pairing and create (no live scenes), which is enough for a native deck. Decided at U7, not before.
- **Miniflare and the rate-limit binding.** Unverified. With `LINK_LIMIT_REQUIRED` off the rig runs without it and proves body caps, single use and expiry; the live check proves `429`.
- **A leaked grant.** Eight hours of create, read (no `collab`), replace (block only) and asset upload as the person, on any deck whose id the holder knows; no keys, no list, no delete, no shell; revocable from the index. Acceptable against the alternative it replaces (a year-long token with keys and a free shell).
- **A phished approval.** The page cannot know who started the pairing; the fixed copy and the start time are the defence, and the grant's reach is the leaked-grant case above.
- **Access application edits are dashboard-only for agents.** U7's Bypass step and the cookie check are Johan's, as every Access change has been.

## Documentation and Operational Notes

- README "Setup, in order" gains a KV step, extends the Bypass destination list, adds the cookie check, and the verification curls gain a pairing round-trip and a cross-site approve refusal.
- Memory: the project memory's KTD13 line is superseded by this plan once U7 lands.
