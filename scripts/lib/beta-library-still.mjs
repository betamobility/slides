// SPDX-License-Identifier: MIT
// BETA FORK: a library scene's still, captured from the scene itself
// (2026-10-30-001 roadmap, R8).
//
// A scene that draws into <svg id="scene"> draws its defaults before it is
// told anything, and that drawing, saved as a file, is its still: what
// thumbnails, print, the PowerPoint export and every slide without a running
// frame show. Capturing it, instead of drawing the still by hand, means the
// still cannot drift from the scene. The scene lays itself out by arithmetic
// (no measured text), so the capture is the same on every machine, and the
// browser rig (scripts/test-beta-library-browser.mjs) captures again and
// fails when the committed still is stale.
//
// No playwright import here: the caller passes a page, so this module stays
// loadable where playwright is not installed.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The frame a still is captured in: 16:9, the deck default. */
export const CAPTURE_VIEWPORT = { width: 1280, height: 720 }
const MARK = /<svg id="scene"[\s>]/

/** The ids of the scenes under `dir` whose still is captured (their page draws into svg#scene). */
export function capturedScenes(dir) {
  return readdirSync(dir).sort().filter((id) => {
    const f = join(dir, id, 'index.html')
    return !id.startsWith('.') && existsSync(f) && MARK.test(readFileSync(f, 'utf8'))
  })
}

/**
 * The still for a scene page: the page's own drawing of its defaults, as an
 * SVG file. `page` is a FRESH playwright page: setContent keeps the window,
 * so a second scene in the same page meets the first one's top-level
 * declarations and throws before it draws.
 */
export async function captureStill(page, html) {
  await page.setViewportSize(CAPTURE_VIEWPORT)
  await page.setContent(html, { waitUntil: 'load' })
  const svg = await page.evaluate(() => {
    const s = document.getElementById('scene')
    if (!s) return null
    const c = s.cloneNode(true)
    const [, , w, h] = c.getAttribute('viewBox').split(/\s+/)
    c.removeAttribute('id')
    c.setAttribute('width', w)
    c.setAttribute('height', h)
    return new XMLSerializer().serializeToString(c)
  })
  if (!svg) throw new Error('the page has no svg#scene to capture')
  return svg + '\n'
}
