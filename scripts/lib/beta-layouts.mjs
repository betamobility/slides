// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
//
// Beta layouts and starter decks (plan U4, KTD5). Layouts live in each
// template's `doc.layouts`, never in builtinLayouts(), so upstream merges
// never touch them. Geometry follows the agent guide's column arithmetic on
// the 1280x720 canvas: 96 px margins, a 1088 px band, rows flush at x = 1184.
//
// Every text element carries `role` so content rides across layouts, and
// `placeholder` rather than `html` so the editor dims the prompt. Colours are
// literals with `themeRefs` provenance, so the palette can be re-pointed from
// one place (slides/src/palette.ts).
//
// Consumed by scripts/build-beta-templates.mjs and scripts/test-beta-layouts.ts.

import { generalTemplate } from './beta-general.mjs'

export const CANVAS = { width: 1280, height: 720 }

/** Slot name -> literal, from a generated beta/theme.json. */
export function paletteFrom(theme) {
  const p = theme.palette ?? {}
  return {
    bg1: theme.background, tx1: theme.color, accent1: theme.accent,
    bg2: p.bg2, tx2: p.tx2, accent2: p.accent2, accent3: p.accent3,
    accent4: p.accent4, accent5: p.accent5, accent6: p.accent6,
    hlink: p.hlink, folHlink: p.folHlink,
  }
}

// Every layout's transition, so every slide made from one starts with it.
// 'none': the layouts share element ids (title, footer), so 'morph' as the
// default made every slide change animate, wanted or not. The ids stay, and a
// person or Claude sets 'morph' on the slides where the movement is the point.
export const DEFAULT_TRANSITION = 'none'
/**
 * The Beta layouts every deck carries: the general template's 35, on design
 * system v1.5.0 (64 px margins, 46 px working titles, 28 px body, no labels
 * above titles and no slide numbers). Since 2026-10-14 the blank deck, the
 * starter deck and the older templates are built on these too, so a new deck
 * starts in the same look the general template shows. `theme` is accepted for
 * the old signature and not read: the palette comes from the same snapshot.
 */
export function betaLayouts(_theme) {
  return generalTemplate().layouts
}

/**
 * The image the layouts' photo slots show in a deck that is not the general
 * template: a quiet placeholder in the palette's second surface, with a
 * picture glyph in its subtle ink. The general template carries two sample
 * photographs (about 616 KB as data URIs); the blank deck, the starter deck
 * (compiled into every shell) and the older templates take this instead, under
 * the same asset keys, so every image layout still works and says "a picture
 * goes here".
 */
export function placeholderImage(theme) {
  const bg = theme.palette?.bg2 ?? '#F7F7F7', ink = theme.palette?.accent5 ?? '#767676'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="${bg}"/><g fill="none" stroke="${ink}" stroke-width="6" stroke-linejoin="round"><rect x="700" y="380" width="200" height="140" rx="12"/><path d="M712 508l56-60 40 40 28-28 52 48"/></g><circle cx="852" cy="416" r="14" fill="${ink}"/></svg>`
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
}

/**
 * A chart slide's source line is where its date lives (the skill's as-of rule):
 * a placeholder, never a live value, in a shipped deck. The author, or Claude
 * refreshing the figures, writes "Data as of YYYY-MM-DD · source" there.
 */
function asOf(slide) {
  if (!slide.elements.some((e) => e.type === 'chart')) return slide
  const src = slide.elements.find((e) => e.type === 'text' && e.role === 'source')
  if (src) { src.html = ''; src.placeholder = 'Data as of YYYY-MM-DD · source' }
  return slide
}

/** A slide instantiated from a layout: same ids (so chrome morphs), html filled by id. */
export function slideFrom(layouts, layoutId, slideId, fill = {}, notes = '') {
  const ly = layouts.find((l) => l.id === layoutId)
  if (!ly) throw new Error(`no layout ${layoutId}`)
  const s = JSON.parse(JSON.stringify(ly))
  s.id = slideId
  s.name = undefined
  delete s.name
  s.notes = notes
  for (const el of s.elements) {
    if (el.type === 'text' && fill[el.id] !== undefined) { el.html = fill[el.id]; delete el.placeholder }
    if (el.type === 'chart' && fill[el.id]) el.option = fill[el.id]
  }
  return s
}

/** The starter decks (plan R7) plus `blank` (2026-09-10 plan, U2), on the
 * general template's layouts and the v1.5.0 foundation (2026-10-14). Each is
 * `template: true`, no docId, no collab. Element ids are the general layouts'
 * (`title`, `subtitle`, `byline`, `left-heading`, `left`, `right-heading`,
 * `right`, `body`), so content rides across them by role. */
export function betaTemplates(fragment) {
  const general = generalTemplate()
  const layouts = general.layouts
  const base = (title, subject, slides) => ({
    format: 'bento/slides', version: 1, title, template: true,
    meta: { ...fragment.meta, author: '', subject },
    size: { ...CANVAS },
    theme: fragment.theme, fonts: fragment.fonts,
    // the layouts' photo slots take a placeholder here; only the general template carries sample photographs
    assets: { ...fragment.assets, street: placeholderImage(fragment.theme), workshop: placeholderImage(fragment.theme) },
    beta: fragment.beta,
    layouts, slides,
  })
  const S = (layoutId, id, fill, notes) => asOf(slideFrom(layouts, layoutId, id, fill, notes))
  const cols = (left, leftBody, right, rightBody) => ({ 'left-heading': left, left: leftBody, 'right-heading': right, right: rightBody })
  return {
    // The one /new clones (2026-09-10 plan, U2). One cover slide with every
    // placeholder intact, so a colleague lands on a deck that is theirs to
    // fill; it carries the 35 layouts, so the first "＋ Slide" offers them all.
    blank: base('Untitled deck', '', [
      S('title', 'cover', {}, 'Give the deck a title, then add slides from the Beta layouts.'),
    ]),
    'client-pitch': base('Client pitch', 'Client pitch', [
      S('title', 'cover', { title: 'A better way to run the network', subtitle: 'What we propose, what it costs, and what changes for riders.', byline: 'Proposal · Month year' }, 'Open with the one thing the client already wants to be true.'),
      S('chapter', 'why', { title: 'Why now', subtitle: 'The pressure the client is under this year.' }, ''),
      S('two-columns', 'situation', { title: 'Where the network stands', ...cols('What works', 'Two or three lines.', 'What does not', 'Two or three lines.') }, 'Keep both columns to three lines each.'),
      S('chart', 'evidence', { title: 'What the numbers say', body: 'The point the chart makes, in two sentences.' }, 'Refresh the figures at edit time and keep the as-of date.'),
      S('two-columns', 'proposal', { title: 'What we propose', ...cols('Scope', 'Three short points.', 'Timeline and price', 'Three short points.') }, ''),
      S('thank-you', 'close', { title: 'Next step', subtitle: 'A decision meeting within two weeks.' }, ''),
    ]),
    'insight-brief': base('Insight brief', 'Insight brief', [
      S('title', 'cover', { title: 'One finding, well argued', subtitle: 'The claim in one sentence.', byline: 'Insight brief · Month year' }, 'State the finding on the cover; the rest is evidence.'),
      S('chart', 'finding-1', { title: 'The finding', body: 'What the chart shows and why it matters.' }, ''),
      S('two-columns', 'context', { title: 'Context', ...cols('What we compared', 'Sources and period.', 'What we excluded', 'And why.') }, ''),
      S('chapter', 'so-what', { title: 'What it means for the client', subtitle: 'Two implications, one recommendation.' }, ''),
      S('thank-you', 'close', { title: 'Recommendation', subtitle: 'The one thing to do next.' }, ''),
    ]),
    'workshop': base('Workshop', 'Workshop', [
      S('title', 'cover', { title: 'Workshop title', subtitle: 'Who is in the room and what we leave with.', byline: '{{date}}' }, ''),
      S('chapter', 'agenda', { title: 'Three blocks, one outcome', subtitle: 'Framing, working session, decisions.' }, ''),
      S('statement', 'question', { title: 'The question we are here to answer' }, 'Leave this on screen while groups work.'),
      S('two-columns', 'exercise', { title: 'Exercise', ...cols('Task', 'What each group does.', 'Output', 'What they bring back.') }, ''),
      S('two-columns', 'decisions', { title: 'Decisions', ...cols('Decided', 'Fill in live.', 'Parked', 'Fill in live.') }, ''),
      S('thank-you', 'close', { title: 'Thank you', subtitle: 'Notes go out within two days.' }, ''),
    ]),
  }
}

/**
 * What a bare Beta shell opens with (no `#bento-doc` on disk): a short deck in
 * the design system that shows the layouts and says how to use the thing.
 * NOT a template: the app mints its docId at boot (slides/src/betastarter.ts).
 */
export function betaStarter(fragment) {
  const general = generalTemplate()
  const layouts = general.layouts
  const S = (layoutId, id, fill, notes) => asOf(slideFrom(layouts, layoutId, id, fill, notes))
  return {
    format: 'bento/slides', version: 1, title: 'Beta Slides',
    meta: { ...fragment.meta, author: '', subject: 'Beta Slides' },
    size: { ...CANVAS },
    theme: fragment.theme, fonts: fragment.fonts,
    assets: { ...fragment.assets, street: placeholderImage(fragment.theme), workshop: placeholderImage(fragment.theme) },
    beta: fragment.beta,
    layouts,
    slides: [
      S('title', 'cover', { title: 'The deck is one file.', subtitle: 'Deck, viewer and editor in one HTML file, in the Beta design system. Press Esc to edit, or ask Claude.', byline: 'Beta Slides' },
        'This is the starter deck a fresh Beta shell opens with. Save it under the deck\'s own name.'),
      S('two-columns', 'how', { title: 'How this works', 'left-heading': 'Edit here', left: 'Esc opens the editor. Apply a Beta layout from the slide panel; text rides across by role.', 'right-heading': 'Or ask Claude', right: 'Install the beta-slides plugin and describe the deck. It starts from a Beta template and exports PowerPoint.' },
        'The two ways a deck gets made. Both end in the same file.'),
      S('chart', 'numbers', { title: 'Numbers are charts', body: 'A chart element, in the theme\'s palette. Refresh figures when you edit and keep the date.' },
        'Replace the placeholder series with the real figures and update the as-of date.'),
      S('thank-you', 'close', { title: 'Start writing', subtitle: 'Delete these slides, keep the layouts. Export PPTX sits beside Export PDF.' }, ''),
    ],
  }
}
