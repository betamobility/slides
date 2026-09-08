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

export const CANVAS = { width: 1280, height: 720 }
const M = 96            // side margin
const BAND = 1088       // content band
const RIGHT = M + BAND  // 1184

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

const HEADING = "'Playfair Display', Georgia, serif"
const BODY = "'Inter', system-ui, sans-serif"
const MONO = "'DM Mono', 'Courier New', monospace"

const text = (pal, id, placeholder, frame, o = {}) => {
  const colorSlot = o.colorSlot ?? 'tx1'
  const el = {
    id, type: 'text', ...frame, rotation: 0, opacity: 1,
    html: o.html ?? '', fontSize: o.fontSize ?? 24,
    fontFamily: o.fontFamily ?? BODY, fontWeight: o.fontWeight ?? 400,
    color: pal[colorSlot], align: o.align ?? 'left', valign: o.valign ?? 'top',
    lineHeight: o.lineHeight ?? 1.3, role: o.role,
    themeRefs: { color: colorSlot },
  }
  if (placeholder) el.placeholder = placeholder
  if (o.letterSpacing != null) el.letterSpacing = o.letterSpacing
  if (o.fx) el.fx = o.fx
  return el
}
const rect = (pal, id, frame, o = {}) => {
  const fillSlot = o.fillSlot ?? 'accent1'
  const el = {
    id, type: 'shape', shape: o.shape ?? 'rect', ...frame, rotation: 0, opacity: o.opacity ?? 1,
    fill: pal[fillSlot], stroke: 'none', strokeWidth: 0, radius: o.radius ?? 0,
    themeRefs: { fill: fillSlot },
  }
  if (o.fx) el.fx = o.fx
  return el
}
const chart = (pal, id, frame) => ({
  id, type: 'chart', ...frame, rotation: 0, opacity: 1, preset: 'bar',
  option: {
    xAxis: { type: 'category', data: ['2024', '2025', '2026'] },
    yAxis: { type: 'value' },
    series: [{ type: 'bar', name: 'Series', data: [4, 7, 9], itemStyle: { color: pal.accent1, borderRadius: 4 } }],
  },
})

/** Footer chrome shared by every content layout: same ids, so it morphs. */
const footer = (pal) => [
  rect(pal, 'beta-foot-rule', { x: M, y: 640, w: BAND, h: 1 }, { fillSlot: 'tx2', opacity: 0.25 }),
  text(pal, 'beta-foot-company', '', { x: M, y: 652, w: 540, h: 28 },
    { html: '{{company}}', fontSize: 13, fontFamily: MONO, colorSlot: 'accent4', valign: 'middle', role: 'kicker' }),
  text(pal, 'beta-foot-page', '', { x: RIGHT - 200, y: 652, w: 200, h: 28 },
    { html: '{{page:2}}', fontSize: 13, fontFamily: MONO, colorSlot: 'accent4', align: 'right', valign: 'middle', role: 'kicker' }),
]

export function betaLayouts(theme) {
  const pal = paletteFrom(theme)
  return [
    {
      id: 'beta-title', name: 'Beta title', background: pal.bg1, transition: 'fade', notes: '',
      themeRefs: { background: 'bg1' },
      elements: [
        rect(pal, 'beta-orbit', { x: 1000, y: 96, w: 120, h: 120 },
          { shape: 'ellipse', fillSlot: 'accent1', fx: { loop: { type: 'motion-path', path: 'M0,0 C40,-30 80,30 0,60 C-60,80 -40,-40 0,0', duration: 14, ease: 'none' } } }),
        text(pal, 'beta-kicker', 'Event or date', { x: M, y: 232, w: 640, h: 32 },
          { fontSize: 14, fontFamily: MONO, colorSlot: 'accent4', letterSpacing: 1, valign: 'middle', role: 'kicker' }),
        text(pal, 'beta-title-h', 'Deck title', { x: M, y: 272, w: 860, h: 200 },
          { fontSize: 72, fontFamily: HEADING, fontWeight: 700, lineHeight: 1.05, valign: 'top', role: 'title' }),
        text(pal, 'beta-title-sub', 'One sentence on what this deck is for', { x: M, y: 488, w: 720, h: 72 },
          { fontSize: 24, colorSlot: 'accent4', lineHeight: 1.4, role: 'subtitle' }),
        text(pal, 'beta-title-byline', '', { x: M, y: 620, w: 720, h: 28 },
          { html: '{{company}} · {{date}}', fontSize: 13, fontFamily: MONO, colorSlot: 'accent4', valign: 'middle', role: 'kicker' }),
      ],
    },
    {
      id: 'beta-section', name: 'Beta section', background: pal.tx1, transition: 'morph', notes: '',
      themeRefs: { background: 'tx1' },
      elements: [
        text(pal, 'beta-kicker', 'Part 1', { x: M, y: 272, w: 640, h: 32 },
          { fontSize: 14, fontFamily: MONO, colorSlot: 'accent2', letterSpacing: 1, valign: 'middle', role: 'kicker' }),
        text(pal, 'beta-title-h', 'Section title', { x: M, y: 312, w: 960, h: 160 },
          { fontSize: 60, fontFamily: HEADING, fontWeight: 700, lineHeight: 1.05, colorSlot: 'bg1', role: 'title' }),
        text(pal, 'beta-title-sub', 'What this part answers', { x: M, y: 488, w: 720, h: 60 },
          { fontSize: 22, colorSlot: 'accent5', lineHeight: 1.4, role: 'subtitle' }),
      ],
    },
    {
      id: 'beta-two-col', name: 'Beta two columns', background: pal.bg1, transition: 'morph', notes: '',
      themeRefs: { background: 'bg1' },
      elements: [
        text(pal, 'beta-title-h', 'Slide title', { x: M, y: 72, w: BAND, h: 84 },
          { fontSize: 40, fontFamily: HEADING, fontWeight: 700, lineHeight: 1.1, valign: 'middle', role: 'title' }),
        text(pal, 'beta-col-left', 'Left column', { x: M, y: 208, w: 528, h: 400 },
          { fontSize: 22, lineHeight: 1.5, role: 'body' }),
        text(pal, 'beta-col-right', 'Right column', { x: 656, y: 208, w: 528, h: 400 },
          { fontSize: 22, lineHeight: 1.5, role: 'body' }),
        ...footer(pal),
      ],
    },
    {
      id: 'beta-chart-text', name: 'Beta chart + text', background: pal.bg1, transition: 'morph', notes: '',
      themeRefs: { background: 'bg1' },
      elements: [
        text(pal, 'beta-title-h', 'What the numbers say', { x: M, y: 72, w: BAND, h: 84 },
          { fontSize: 40, fontFamily: HEADING, fontWeight: 700, lineHeight: 1.1, valign: 'middle', role: 'title' }),
        chart(pal, 'beta-chart', { x: M, y: 208, w: 624, h: 400 }),
        text(pal, 'beta-col-right', 'The point the chart makes, in two sentences', { x: 752, y: 208, w: 432, h: 340 },
          { fontSize: 22, lineHeight: 1.5, role: 'body' }),
        text(pal, 'beta-asof', 'Data as of YYYY-MM-DD', { x: 752, y: 568, w: 432, h: 28 },
          { fontSize: 13, fontFamily: MONO, colorSlot: 'accent4', valign: 'middle', role: 'kicker' }),
        ...footer(pal),
      ],
    },
    {
      id: 'beta-hero', name: 'Beta hero', background: pal.tx1, transition: 'fade', notes: '',
      themeRefs: { background: 'tx1' },
      elements: [
        rect(pal, 'beta-hero-band', { x: 0, y: 0, w: CANVAS.width, h: 456 }, { fillSlot: 'accent3' }),
        text(pal, 'beta-title-h', 'One big statement', { x: M, y: 496, w: BAND, h: 120 },
          { fontSize: 48, fontFamily: HEADING, fontWeight: 700, lineHeight: 1.1, colorSlot: 'bg1', valign: 'top', role: 'title' }),
        text(pal, 'beta-foot-company', '', { x: M, y: 652, w: 540, h: 28 },
          { html: '{{company}}', fontSize: 13, fontFamily: MONO, colorSlot: 'accent5', valign: 'middle', role: 'kicker' }),
        text(pal, 'beta-foot-page', '', { x: RIGHT - 200, y: 652, w: 200, h: 28 },
          { html: '{{page:2}}', fontSize: 13, fontFamily: MONO, colorSlot: 'accent5', align: 'right', valign: 'middle', role: 'kicker' }),
      ],
    },
    {
      id: 'beta-closing', name: 'Beta closing', background: pal.bg1, transition: 'morph', notes: '',
      themeRefs: { background: 'bg1' },
      elements: [
        rect(pal, 'beta-orbit', { x: 1000, y: 96, w: 120, h: 120 }, { shape: 'ellipse', fillSlot: 'accent1' }),
        text(pal, 'beta-title-h', 'Thank you', { x: M, y: 272, w: 860, h: 120 },
          { fontSize: 60, fontFamily: HEADING, fontWeight: 700, lineHeight: 1.05, role: 'title' }),
        text(pal, 'beta-title-sub', 'Next step, and who to contact', { x: M, y: 412, w: 720, h: 96 },
          { fontSize: 22, colorSlot: 'accent4', lineHeight: 1.5, role: 'subtitle' }),
        text(pal, 'beta-title-byline', '', { x: M, y: 620, w: 720, h: 28 },
          { html: '{{company}} · {{author}}', fontSize: 13, fontFamily: MONO, colorSlot: 'accent4', valign: 'middle', role: 'kicker' }),
      ],
    },
  ]
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

/** The three starter decks (plan R7). Each is `template: true`, no docId, no collab. */
export function betaTemplates(fragment) {
  const layouts = betaLayouts(fragment.theme)
  const base = (title, subject, slides) => ({
    format: 'bento/slides', version: 1, title, template: true,
    meta: { ...fragment.meta, author: '', subject },
    size: { ...CANVAS },
    theme: fragment.theme, fonts: fragment.fonts, assets: fragment.assets, beta: fragment.beta,
    layouts, slides,
  })
  const S = (layoutId, id, fill, notes) => slideFrom(layouts, layoutId, id, fill, notes)
  return {
    'client-pitch': base('Client pitch', 'Client pitch', [
      S('beta-title', 'cover', { 'beta-kicker': 'Proposal', 'beta-title-h': 'A better way to run the network', 'beta-title-sub': 'What we propose, what it costs, and what changes for riders.' }, 'Open with the one thing the client already wants to be true.'),
      S('beta-section', 'why', { 'beta-kicker': 'Part 1', 'beta-title-h': 'Why now', 'beta-title-sub': 'The pressure the client is under this year.' }, ''),
      S('beta-two-col', 'situation', { 'beta-title-h': 'Where the network stands', 'beta-col-left': '<b>What works</b><br>Two or three lines.', 'beta-col-right': '<b>What does not</b><br>Two or three lines.' }, 'Keep both columns to three lines each.'),
      S('beta-chart-text', 'evidence', { 'beta-title-h': 'What the numbers say', 'beta-col-right': 'The point the chart makes, in two sentences.' }, 'Refresh the figures at edit time and keep the as-of date.'),
      S('beta-two-col', 'proposal', { 'beta-title-h': 'What we propose', 'beta-col-left': '<b>Scope</b><br>Three bullets.', 'beta-col-right': '<b>Timeline and price</b><br>Three bullets.' }, ''),
      S('beta-closing', 'close', { 'beta-title-h': 'Next step', 'beta-title-sub': 'A decision meeting within two weeks.' }, ''),
    ]),
    'insight-brief': base('Insight brief', 'Insight brief', [
      S('beta-title', 'cover', { 'beta-kicker': 'Insight brief', 'beta-title-h': 'One finding, well argued', 'beta-title-sub': 'The claim in one sentence.' }, 'State the finding on the cover; the rest is evidence.'),
      S('beta-chart-text', 'finding-1', { 'beta-title-h': 'The finding', 'beta-col-right': 'What the chart shows and why it matters.' }, ''),
      S('beta-two-col', 'context', { 'beta-title-h': 'Context', 'beta-col-left': '<b>What we compared</b><br>Sources and period.', 'beta-col-right': '<b>What we excluded</b><br>And why.' }, ''),
      S('beta-section', 'so-what', { 'beta-kicker': 'So what', 'beta-title-h': 'What it means for the client', 'beta-title-sub': 'Two implications, one recommendation.' }, ''),
      S('beta-closing', 'close', { 'beta-title-h': 'Recommendation', 'beta-title-sub': 'The one thing to do next.' }, ''),
    ]),
    'workshop': base('Workshop', 'Workshop', [
      S('beta-title', 'cover', { 'beta-kicker': '{{date}}', 'beta-title-h': 'Workshop title', 'beta-title-sub': 'Who is in the room and what we leave with.' }, ''),
      S('beta-section', 'agenda', { 'beta-kicker': 'Agenda', 'beta-title-h': 'Three blocks, one outcome', 'beta-title-sub': 'Framing, working session, decisions.' }, ''),
      S('beta-hero', 'question', { 'beta-title-h': 'The question we are here to answer' }, 'Leave this on screen while groups work.'),
      S('beta-two-col', 'exercise', { 'beta-title-h': 'Exercise', 'beta-col-left': '<b>Task</b><br>What each group does.', 'beta-col-right': '<b>Output</b><br>What they bring back.' }, ''),
      S('beta-two-col', 'decisions', { 'beta-title-h': 'Decisions', 'beta-col-left': '<b>Decided</b><br>Fill in live.', 'beta-col-right': '<b>Parked</b><br>Fill in live.' }, ''),
      S('beta-closing', 'close', { 'beta-title-h': 'Thank you', 'beta-title-sub': 'Notes go out within two days.' }, ''),
    ]),
  }
}

/**
 * What a bare Beta shell opens with (no `#bento-doc` on disk): a short deck in
 * the design system that shows the layouts and says how to use the thing.
 * NOT a template: the app mints its docId at boot (slides/src/betastarter.ts).
 */
export function betaStarter(fragment) {
  const layouts = betaLayouts(fragment.theme)
  const S = (layoutId, id, fill, notes) => slideFrom(layouts, layoutId, id, fill, notes)
  return {
    format: 'bento/slides', version: 1, title: 'Beta Slides',
    meta: { ...fragment.meta, author: '', subject: 'Beta Slides' },
    size: { ...CANVAS },
    theme: fragment.theme, fonts: fragment.fonts, assets: fragment.assets, beta: fragment.beta,
    layouts,
    slides: [
      S('beta-title', 'cover', { 'beta-kicker': 'Beta Slides', 'beta-title-h': 'The deck is one file.', 'beta-title-sub': 'Deck, viewer and editor in one HTML file, in the Beta design system. Press Esc to edit, or ask Claude.' },
        'This is the starter deck a fresh Beta shell opens with. Save it under the deck\'s own name.'),
      S('beta-two-col', 'how', { 'beta-title-h': 'How this works', 'beta-col-left': '<b>Edit here</b><br>Esc opens the editor. Apply a Beta layout from the slide panel; text rides across by role.', 'beta-col-right': '<b>Or ask Claude</b><br>Install the beta-slides plugin and describe the deck. It starts from a Beta template and exports PowerPoint.' },
        'The two ways a deck gets made. Both end in the same file.'),
      S('beta-chart-text', 'numbers', { 'beta-title-h': 'Numbers are charts', 'beta-col-right': 'A chart element, in the theme\'s palette. Refresh figures when you edit and keep the date.' },
        'Replace the placeholder series with the real figures and update the as-of date.'),
      S('beta-closing', 'close', { 'beta-title-h': 'Start writing', 'beta-title-sub': 'Delete these slides, keep the layouts. Export PPTX sits beside Export PDF.' }, ''),
    ],
  }
}
