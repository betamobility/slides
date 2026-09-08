# Beta mark

Vendored unchanged from `Tools/design-system/public/logo/` (the design system, `DESIGN.md` §10 "Logo & Favicon") at commit `599f91a0`, 2026-09-08. Copy, never edit; `scripts/test-beta-marks.ts` pins each file's SHA-256, so a re-vendor updates the files, the hashes in that rig and this line together.

| File | Use in this fork |
|---|---|
| `favicon-32.png` | the tab icon of every deck, inlined as a base64 data URI in `slides/index.html` and `slides/src/beta/marks.ts` |
| `favicon-16.png`, `favicon-32.png`, `apple-touch-icon.png` | linked by the release site's pages; `scripts/release.mjs` copies them to `site/logo/` |
| `wordmark.svg` | the recolorable wordmark (`currentColor`); its `<svg>` element is inlined in the boot splash and exported from `marks.ts` |

The favicon is the dark wordmark on transparent, not the social-avatar square, as `DESIGN.md` prescribes for browser tabs.
