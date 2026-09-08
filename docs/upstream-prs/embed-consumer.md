# Upstream PR: the `embed` element, consumer side, in slides

**Branch:** `upstream-pr/embed-consumer` (built from `upstream/main`, app-zone files only, no attribution trailers)
**Target:** `nyblnet/bento` `main`
**Status:** open as [nyblnet/bento#424](https://github.com/nyblnet/bento/pull/424), from Johan's account, 2026-09-08. Was: prepared for Johan to open. Upstream's hard rule 10 declines agent-authored PRs, so the branch is his to offer, with the provenance that implies. The rig is `scripts/test-embed.ts` (the fork's `test-beta-embed.ts`), registered in `validate`.

Open it with:

```sh
git push origin upstream-pr/embed-consumer          # after the fork exists
gh pr create --repo nyblnet/bento --head betamobility:upstream-pr/embed-consumer \
  --title "slides: add the embed element to the bento/embed shape" \
  --body-file docs/upstream-prs/embed-consumer.md
```

---

## slides: add the `embed` element to the bento/embed shape

`docs/DECISIONS.md` (2026-08-19) settled `bento/embed` as one shape for every app: a static `view` always present, the `doc` source always present, a sandboxed `live` iframe opt-in. `type/` has the consumer side; `slides/` does not. This adds it to slides, written to that shape so lifting it into the kernel later is a move, not a redesign.

- `model.ts`: `EmbedElement { type:'embed', app, view, doc?, url?, live?, w, h }` in the `SlideElement` union; `modelkeys.generated.ts` regenerated (`build-modelkeys.mjs` learns the interface name).
- `render.ts`: one `case 'embed'`. `view` (inline `<svg>` or an `asset:` key) paints through `sanitizeSvg`, the svg element's path. The live frame exists only on a live surface (`liveMedia`, which present mode already passes), so the editor canvas paints the view and a repaint never re-navigates the author's URL. When `live` is true, `app` is `web`, `url` is http(s), `remoteSrcBlocked(url)` is false and `navigator.onLine` is true, a `sandbox="allow-scripts allow-forms"` iframe with `referrerPolicy="no-referrer"` is layered over the view; its error handler removes it. Both kinds of offline (the privacy switch and network absence) therefore show the view, and `test-offline.ts` stays green because the only network decision goes through `kernel/src/net.ts`.
- `validate.ts`: `embed-missing-view` (error), `embed-remote-view` and `embed-live-no-url` (warnings).
- `untrusted.ts`, `clipboard.ts`: paste and CRDT shape gates; asset views travel and remap on key collision.
- `panels.ts`: an Embed section with `url`, `live`, and a "Capture view" picker that interns an SVG, or a raster wrapped as `<svg><image href="data:…">`, as the view. A sandboxed cross-origin frame cannot be screenshotted, which is the point of the sandbox, so the view is supplied, not captured.
- Eleven UI strings in every catalog.

Why now: today an unknown element type loads, survives a round trip and renders as an empty, correctly positioned box, with no finding from `validate()` and a silent drop on paste (`render.ts` `renderElement` has no default; `validate.ts` looks the type up in `MODEL_KEYS.element` and finds nothing). A deck authored in a build that has this element degrades silently in this one. With the element known, it paints its view everywhere.

Verified: `tsc -b`, `build-modelkeys.mjs --check`, `build-i18n.mjs --check` and coverage, `test-offline.ts`, `test-sanitize.ts` (two added cases), `test-validate.ts`, `test-clipboard.ts`, `test-sync.ts`, `test-ci-registered.ts`, `npm run build:single`, `shell-gate.mjs`, and `scripts/test-embed.ts` (59 checks: node half plus headless Chrome with a request log proving the frame is requested only when allowed).
