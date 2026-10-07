---
title: "An idle tab follows the store: auto-reload without loops, stale recovery or self-races"
date: 2026-10-07
category: design-patterns
module: deck store client (slides/src/beta/store.ts, slides/src/editor/editor.ts)
problem_type: design_pattern
component: tooling
severity: medium
applies_when:
  - "A browser tab holds a document that another writer (Claude, a service token, a colleague) can replace in a store behind conditional saves"
  - "Adding a poll, probe or auto-reload next to an existing If-Match / 412 save path"
  - "The same document is also co-edited live through a sync room, so two tabs autosave over each other by design"
  - "A feature is gated on location.origin and cannot be exercised on localhost or file:// before a release"
  - "A race-condition test passes on the first run and has not been shown to fail against the broken code"
symptoms:
  - "A tab learned the store had changed only when its next save was refused with a 412, by which time it held edits that could not be saved in place"
  - "Two conflict banners in one day while Claude and a person edited the same stored deck"
  - "The first version of the overlap test passed against a probe that skipped the queue"
root_cause: async_timing
resolution_type: code_fix
related_components:
  - "server/deck-store (HEAD /d/<id>, x-bento-etag, x-bento-service-gen)"
  - "scripts/test-beta-store-client.ts"
  - "IndexedDB recovery snapshot (slides/src/autosave.ts)"
  - "sync relay live room"
tags: [auto-reload, deck-store, etag, conditional-save, live-collab, recovery-snapshot, playwright-route-interception, mutation-check]
---

# An idle store tab follows the store: the three traps, and how to test an origin-gated feature before a release

## Context

Claude can replace a deck in the deck store (`slides.betamobility.ai`) while a person has it open. Until betamobility/slides#37 the open tab learned this only when its next save was refused with a 412. By then it held edits that could not be saved in place. The tab latched (no further PUT for the life of the tab), showed "This deck changed in the store. Reload to get the latest version before saving.", and after the reload offered the person's work back only as a separate deck. On 2026-10-07 this happened twice in one day to the same person (around 11:03 and 14:30).

The conflict path itself was working as designed (`slides/src/beta/store.ts`, "CHANGED IN THE STORE"). What was missing was the cheap case: a tab with nothing unsaved has no reason to wait for a refused save to find out. The worker already answered `HEAD /d/<id>` with `x-bento-etag` and `x-bento-service-gen`, so the change is client-only.

The obvious rule, "the ETag changed and the tab is clean, so reload", is wrong in three separate ways. Each was caught in design review, not by a failing test, and one of the tests written for it passed against deliberately broken code. This doc records the rule that shipped, the three traps, and the two verification techniques that made it checkable before any release.

## Guidance

### 1. Split the feature: a pure probe and a pure rule in the store module, the timer and the gate in the editor

`store.ts` reports and decides; it starts no timer, because the node rig boots `installStoreHost()` many times and must not leave intervals running. The editor owns the 15 second interval, the `visibilitychange` and `focus` hooks, and the definition of "idle". The focus hook is what matters in practice: the person switches to the terminal, Claude writes, they switch back.

### 2. Trap one: the live-room reload loop

Two tabs in one sync room both autosave. Tab A edits and saves, the ETag moves; tab B received the edit through sync and is clean; B's probe sees a new ETag and reloads; A edits again; B reloads again. A person's save must not reload a live tab. A service write must, because Claude's store replace never travels through sync. The worker's `x-bento-service-gen` counter is what tells the two apart, since a 412 or a HEAD only names the latest version.

```ts
export function reloadChoice(o: { probe: StoreProbe; live: boolean }): boolean {
  if (o.probe === 'service') return true
  return o.probe === 'changed' && !o.live
}
```

`StoreProbe` is `'same' | 'changed' | 'service' | 'unknown'`. A worker that sends no generation yields `changed`, never `service`, which gives the right behaviour for free: a live tab does nothing (as before), a tab that is not live reloads because any change means it is stale.

### 3. Trap two: the probe racing the tab's own save

A HEAD that overlaps this tab's own PUT reads the PUT's new ETag before `putDeckNow` has adopted it, and that looks exactly like someone else's change. The probe therefore goes through the same per-deck queue as the PUTs, and it never changes the version the tab holds.

```ts
export function probeStore(id: string): Promise<StoreProbe> {
  const run = (queues.get(id) ?? Promise.resolve()).then(() => probeNow(id))
  const tail = run.then(() => {}, () => {})
  queues.set(id, tail)
  void tail.then(() => { if (queues.get(id) === tail) queues.delete(id) })
  return run
}
```

`probeNow` returns `unknown` for everything that is not a clean comparison: no held version, a latched tab, a rejected fetch, a status other than 200, no ETag. `unknown` never reloads. A failed probe must never reload a tab.

### 4. Trap three: the stale recovery snapshot

A clean tab's IndexedDB recovery snapshot equals the last document it autosaved. After Claude's write the store's document differs from that snapshot. No 412 ever happened, so there is no conflict marker, and on the next boot `recoveryChoice` returns `'restore'`: the person sees "Unsaved changes from 11:03 were found. Restore / Discard". Restore would then autosave the old snapshot over Claude's version with a fresh ETag and no 412. That is the exact hazard the conflict banner exists to prevent, reached by a different door.

The snapshot is cleared, and awaited, before the reload. Nothing is lost: a clean tab's snapshot holds nothing the store did not already have.

```ts
const probe = await probeStore(id)
if (!reloadChoice({ probe, live: onlineTransport()?.status === 'open' })) return
if (!this.idleForStoreReload()) return // the answer took a moment; look again
clearTimeout(this.autosaveTimer)
await clearRecovery(this.store.doc.docId)
try { sessionStorage.setItem(STORE_RELOADED_KEY, this.store.slide.id) } catch { /* private mode */ }
location.reload()
```

Reload the tab; do not `replaceDoc` in place. A `replaceDoc` schedules an autosave that PUTs the swapped content straight back as a person's write.

### 5. Define idle as "nothing a reload would cost", and check it twice

Unsaved edits are the obvious part. The rest is work that is not in the document yet, or a moment that must not be interrupted.

```ts
private idleForStoreReload(): boolean {
  if (document.visibilityState !== 'visible') return false
  if (this.store.dirty || this.storeConflict || this.presenting || isEncryptionActive()) return false
  if (this.canvas.isEditingText || this.canvas.isDrawing) return false
  const a = document.activeElement as HTMLElement | null
  if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return false
  return !document.querySelector('.ed-recover, .ed-about-overlay')
}
```

The gate runs before the probe and again after it, because the answer takes a moment and the person may have started typing. An encrypted deck is excluded because a reload asks for the password again. A tab with unsaved edits is untouched by all of this: its next save is refused as before.

### 6. Verify an origin-gated feature in a browser by serving the build under the real hostname

`isStoreOrigin()` requires `location.origin === storeHost`, so localhost and `file://` cannot exercise any of this, and the live store serves only the released build. Playwright route interception removes the need for a release: intercept every request in the context, fulfil the store's three routes from an in-script fake, abort every other origin. The real host is never contacted.

Two details decide whether the walk-through tests anything:

- **Give the fixture a fixed `docId`.** The recovery snapshot is keyed by it. A template (no `docId`) mints a new one on every boot, so the snapshot from before the reload is never found after it, and trap three becomes invisible.
- **Make the fake's version movable from outside**, with both an ETag and a generation, so "Claude wrote" is one function call.

### 7. Mutation-check a race test before trusting it

The first version of the overlap test passed against a `probeStore` that skipped the queue. The fake store answered the PUT instantly, and `putDeckNow` awaits the boot version check before sending, so the unqueued HEAD went out first and read the old ETag. The test only began to fail against the broken code once the fake held the PUT's answer back, so that the store already had the new version while the tab still believed in the old one. A race test that has never been seen to fail has not shown that it can.

## Why This Matters

- Each trap produces a symptom that looks like something else. The loop looks like a flaky page. The stale snapshot looks like the recovery feature doing its job. The racing probe looks like a colleague's save. None of them raises an error.
- Trap three silently destroys Claude's write through a path with no 412, which is the one guarantee the store's conditional save was built to give.
- Without the route-interception walk-through the editor half (the gate, the clear-before-reload order, the slide restore, the notice) was covered only by source regexes in the rig. The walk-through is what showed, on real boots, that no "unsaved changes" banner appears after the reload.
- Without the mutation check the rig would have carried a race test that could not fail.

## When to Apply

- Any change to how a store tab learns about, adopts or reacts to a newer store version (`slides/src/beta/store.ts`, the BETA FORK blocks in `slides/src/editor/editor.ts`).
- Any feature that reloads or replaces the open document automatically: check what the recovery snapshot will say on the next boot.
- Any client behaviour keyed on "the version changed" in a product where collaborators also save: separate writes that reach peers through sync from writes that do not.
- Any feature gated on the production origin that has to be exercised before a release exists.
- Any test of an ordering or overlap bug: break the code on purpose once and watch the test fail.

## Examples

### The route-interception skeleton

Run through the Playwright MCP's `browser_run_code_unsafe`. That sandbox has no dynamic `import()` and no `require`, so files are served with `route.fulfill({ path })` instead of being read in the script.

```js
async (page) => {
  const HOST = 'https://slides.betamobility.ai'
  const ID = 'fixture0001'                      // must match /^[A-Za-z0-9]+$/
  const st = { deck: { path: '<scratch>/deck-v1.html' }, n: 1, gen: 0, puts: [] }
  const ver = () => ({ 'x-bento-etag': `"v${st.n}"`, 'x-bento-service-gen': String(st.gen) })
  const claudeWrites = (deck) => { st.deck = deck; st.n++; st.gen++ }

  const ctx = page.context()
  await ctx.route('**/*', async (route) => {
    const req = route.request(), u = new URL(req.url()), m = req.method()
    if (u.origin !== HOST) return route.abort()   // nothing reaches the network
    if (u.pathname === `/d/${ID}` && m === 'GET')
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: ver(), ...st.deck })
    if (u.pathname === `/d/${ID}` && m === 'HEAD')
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: ver(), body: '' })
    if (u.pathname === `/api/decks/${ID}` && m === 'PUT') {
      const match = req.headers()['if-match']
      if (match && match !== `"v${st.n}"`) {
        st.puts.push(412)
        return route.fulfill({ status: 412, contentType: 'application/json', headers: ver(),
          body: JSON.stringify({ error: 'changed', writer: 'service' }) })
      }
      st.deck = { body: req.postData() ?? '' }; st.n++; st.puts.push(200)
      return route.fulfill({ status: 200, headers: ver(), body: '' })
    }
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(`${HOST}/d/${ID}`)
  // edit via window.bento.loadDoc(...), wait for the autosave, then:
  //   claudeWrites({ path: '<scratch>/deck-v2.html' })
  //   page.evaluate(() => window.dispatchEvent(new Event('focus')))
}
```

The fixture is this branch's built shell with a document spliced in by `spliceDoc` from `plugins/beta-slides/scripts/lib/bento-doc.mjs`: one of the Beta templates with `template` removed and a fixed `docId` set. Clear `localStorage`, `sessionStorage` and the `bento-autosave` IndexedDB database before the first real boot, or a previous run's snapshot leaks in.

The walk that passed (20 checks): the deck boots on the store origin and sends a HEAD; an edit autosaves and the dirty dot clears; a focus event with nothing changed sends one HEAD and reloads nothing; a simulated Claude write followed by focus reloads the tab once, onto the same slide, with the notice and with no `.ed-recover` bar; two more focus events reload nothing; the next edit saves in place and the stored bytes carry both Claude's title and the new edit; a tab made dirty before a second Claude write does not reload, its save gets the 412, and it shows the existing conflict message.

### The race test, before and after

Before (passes whether or not the probe is queued):

```ts
const racing = store.putDeck('abc123XYZ0', 'this tab is saving')
const during = store.probeStore('abc123XYZ0')
await racing
ok(await during === 'same', '…')
```

After (fails against an unqueued probe):

```ts
respond(async (c) => {
  const res = await fakeStore(c)
  if (c.init.method === 'PUT') await new Promise((r) => setTimeout(r, 30))
  return res
})
const racing = store.putDeck('abc123XYZ0', 'this tab is saving')
await new Promise((r) => setTimeout(r, 10)) // the PUT reached the store; its 200 is not back
const during = store.probeStore('abc123XYZ0')
await racing
ok(await during === 'same', 'a probe that overlaps this tab\'s own save waits for it and reports same')
```

### What was not verified

- **The live store.** The walk-through ran against a fake; the real `slides.betamobility.ai` serves the released build, and no release containing #37 had been cut when this was written.
- **Relay replay after a live tab reloads.** An idle tab in a live session now reloads onto Claude's version and rejoins its room. What the relay replays to it afterwards is existing behaviour and was not examined. A deck in a live session while Claude writes remains unsupported, as the skill says.
- **Safari and Firefox.** The "can't rewrite files in place" notice is an `.ed-recover` bar there, so the tab waits until it is dismissed. Read from the code, not exercised.
- **The screenshot.** The one taken 800 ms after the reload caught the boot splash; the DOM assertions are the evidence for that step, not the image.

## Related

- betamobility/slides#37 (the change), #30 and #31 (conditional store writes and `x-bento-etag`), #35 (pairing).
- `slides/src/beta/store.ts` header comment: "CHANGED IN THE STORE", "EXCEPT A PERSON'S SAVE IN A LIVE ROOM", "AFTER A CONFLICT", "BEFORE A CONFLICT".
- `scripts/test-beta-store-client.ts`, sections 6 and 6b.
- `docs/plans/2026-09-14-001-feat-runtime-slides-plan.md` (U10, KTD12) and `docs/DECISIONS.md` (2026-09-14, conditional writes; 2026-10-07, the idle tab): the conditional save this builds on. KTD12 accepted gap still stands: a change landing between the page GET and the boot HEAD is invisible to the probe too.
- `server/deck-store/README.md`: the HEAD contract (`x-bento-etag`, `x-bento-service-gen`) the probe depends on.
- In the shared Beta store (claude-config `docs/solutions/`): `integration-issues/cloudflare-edge-strips-strong-etag-on-compressed-responses.md` (why the probe reads `x-bento-etag` first) and `workflow-issues/agent-run-first-release-rollout-traps.md` (the Playwright sandbox has neither `require` nor dynamic import).
