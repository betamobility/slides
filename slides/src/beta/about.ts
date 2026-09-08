// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// BETA FORK (plan 2026-09-08-002, U2, KTD2 + KTD3): every Beta literal of the
// About dialog, the help overlay and the post-update banner. `openAbout` in
// editor/editor.ts stays upstream's and calls these in place of its own
// literals, so the next upstream merge conflicts on a handful of marked lines
// and nothing else. Guarded by scripts/test-beta-about.ts.
//
// Strings go through t() at call time (never in a module-level const) and
// every key is in all catalogues under slides/src/i18n/.

// t() comes from the kernel directly (slides/src/i18n.ts re-exports the same
// function but reads `document` at import, which the node rig has none of).
import { t } from '../../../kernel/src/i18n.ts'
import type { UpdateCheck } from '../update'
import { BETA_LOGO_WORDMARK_SVG } from './marks.ts'

/** The product site: the signed release channel, templates and the agent guide. */
export const BETA_SLIDES_HOME = 'https://slides.betamobility.ai'
/** The fork's repository. */
export const BETA_SLIDES_REPO = 'https://github.com/betamobility/slides'
/** The fork's changelog on GitHub; "What's new" links point at a version heading in it. */
export const BETA_CHANGELOG_URL = `${BETA_SLIDES_REPO}/blob/main/CHANGELOG.md`

/** The dialog header: the design-system wordmark (marks.ts, verbatim), the
 *  product name, and the app + format versions. Keeps upstream's
 *  `.ed-about-logo` hook so the existing styles apply; the mark itself is
 *  sized by `.ed-about-mark` (styles.css). */
export function aboutHeaderHtml(appVersion: string, formatVersion: number | string): string {
  return (
    `<a class="ed-about-logo" href="${BETA_SLIDES_HOME}" target="_blank" rel="noopener">` +
    `<span class="ed-about-mark" aria-hidden="true">${BETA_LOGO_WORDMARK_SVG}</span>` +
    `<div><b>beta/slides</b><span>v${appVersion} · format v${formatVersion}</span></div>` +
    `</a>`
  )
}

export function aboutHeaderTitle(): string {
  return t('Visit slides.betamobility.ai (opens in a new tab)')
}

/** The line under the header: where the templates and the agent guide live,
 *  and where the source and changelog are. */
export function aboutPromoHtml(): string {
  return t('Templates and the agent guide live at {home}; the source and changelog are on {gh}.', {
    home: `<a href="${BETA_SLIDES_HOME}" target="_blank" rel="noopener">slides.betamobility.ai</a>`,
    gh: `<a href="${BETA_SLIDES_REPO}" target="_blank" rel="noopener">GitHub</a>`,
  })
}

/** GitHub's heading anchor for a Markdown heading's text: lowercase, keep
 *  only letters, digits, spaces and hyphens, spaces become hyphens. So
 *  `## [2026.9.2]` anchors as `#202692`. */
export function changelogAnchor(headingText: string): string {
  return headingText
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .replace(/ /g, '-')
}

/** The "What's new" link for a version: the fork changelog at that
 *  version's `## [<version>]` heading. */
export function whatsNewUrl(version: string): string {
  return `${BETA_CHANGELOG_URL}#${changelogAnchor(`[${version}]`)}`
}

/** The licence line: the MIT libraries upstream credits, and the three OFL
 *  faces the Beta deck embeds (beta/fonts/). */
export function aboutCreditsText(): string {
  return t('Includes reveal.js, Moveable, Selecto (MIT) · Inter, Playfair Display and DM Mono typefaces (OFL-1.1) — full notices travel in this file’s source.')
}

/** What the update section shows for a check result (KTD3).
 *  `line` is the status text; `showCheck` keeps the manual "Check for
 *  updates" button; `showActions` is the newer-release branch, where
 *  upstream's notes card and both update buttons render. A current file is
 *  one line and nothing else. */
export function updateStatus(check: UpdateCheck | null | undefined, appVersion?: string): { line: string; showCheck: boolean; showActions: boolean } {
  if (!check) return { line: t('This file carries its own app — it works offline, forever, as is.'), showCheck: true, showActions: false }
  if (check.status === 'current') return { line: t('Up to date, {v}', { v: check.version || appVersion || '' }), showCheck: false, showActions: false }
  if (check.status === 'error') return { line: t('The update check did not run ({m}). Check manually below.', { m: check.message }), showCheck: true, showActions: false }
  return { line: t('Version {v} is available.', { v: check.release.version }), showCheck: true, showActions: true }
}

/** Apply `updateStatus` to the dialog's status block and its button row. */
export function applyUpdateStatus(status: HTMLElement, row: HTMLElement, check: UpdateCheck | null | undefined, appVersion?: string): void {
  const s = updateStatus(check, appVersion)
  status.textContent = s.line
  row.style.display = s.showCheck ? '' : 'none'
}
