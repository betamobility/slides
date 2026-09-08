# Upstream PR: keep the layout picker inside the viewport

**Branch:** `upstream-pr/layout-picker-clamp` (cherry-picked from the fork's #12 onto `upstream/main`, `slides/src/editor/editor.ts` and `slides/src/styles.css` only, no attribution trailers)
**Target:** `nyblnet/bento` `main`
**Status:** open as [nyblnet/bento#425](https://github.com/nyblnet/bento/pull/425), from Johan's account, 2026-09-08, per his decision in the v1.1 plan (fix in the fork, offer upstream afterwards).

## What it fixes

The New-slide button at the bottom of the sidebar opened the layout picker upward from itself. Once a deck carries a few custom layouts the picker is taller than the space above the button and its top lands above the viewport: measured top = −7 px at a 600 px-tall window, with the first row of thumbnails clipped under the topbar. Beta hit it because every Beta template carries six layouts.

Every anchor now opens beside itself, clamped on-screen. The picker is appended first so the clamp uses its real height, and `.ed-layoutpick` caps at `calc(100vh - 16px)` (it already scrolls) so very short windows scroll inside the picker instead of losing rows.

## Measured

| Case | Before | After |
|---|---|---|
| Add button, 1280×600 | top −7, first row clipped | top 150, bottom 592, six layouts, no internal scroll |
| Add button, 1280×400 | not measured | top 8, bottom 392, scrolls internally |
| Insert gap, 1280×600 | not measured | inside the viewport |

The insert-gap and panel anchors keep their placement; only the clamp floor changes from a fixed 460 px to the measured height. Screenshots were taken through Playwright on the built shell; the fork's `docs/plans/2026-09-08-002-feat-beta-slides-v1-1-plan.md` U4 carries the scenarios.
