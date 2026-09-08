// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// BETA FORK: the Beta mark — a charcoal rounded square carrying the cream "b"
// of the wordmark (the third glyph path of BETA_WORDMARK_SVG in
// editor/brand.ts, flipped and fitted into a 32 px box). This is the RUNTIME
// copy, for the About header. The same string sits as a literal in
// slides/index.html (favicon data URI + boot splash) and scripts/release.mjs
// (site/favicon.svg), because neither can import it; scripts/test-beta-marks.ts
// asserts the copies are byte-identical. Change it here first, then the others.
// Single-quoted attributes only: the favicon copy lives inside href="…".

export const BETA_MARK_SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='#1A1A1A'/><path fill='#F5F3EF' d='M19.9 18.7C19.9 16.1 18.1 14.3 16 14.3C13.8 14.3 12.1 16.1 12.1 18.8C12.1 21.4 13.8 23.2 16 23.2C18.1 23.2 19.9 21.4 19.9 18.7M12.2 24.6L12.2 26.7L7.6 26.7L7.6 5L12.2 5L12.2 13.1C13.3 11.6 14.8 10.5 17.1 10.5C20.8 10.5 24.4 13.4 24.4 18.8C24.4 24.1 20.9 27 17.1 27C14.7 27 13.2 25.9 12.2 24.6'/></svg>"
