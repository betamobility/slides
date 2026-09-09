// Build "Danmarks Mobilitetsatlas — an introduction for municipalities".
//
// Generated rather than hand-written so every figure comes from the published
// 0.4.0 artifacts (data/published/) and every screenshot from a capture script
// in this folder. Re-run it and the deck rebuilds from the same sources.
//
// The shell is the Beta insight-brief template, whose #bento-doc block carries
// the Beta theme, the three embedded faces and the six beta-* layouts. Only the
// document is replaced; the runtime around it is untouched.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'Mobilitetsatlas-introduktion.bento.html');
const ASOF = '2026-09-09';
// Point the live embeds at a local atlas to verify the chain end to end:
//   ATLAS=http://localhost:3411 node build-deck.mjs
// Absent, the deck is built against the real hosts, which is what ships.
// The embed route ships to staging first (dk-mobility merges features there and
// promotes to production separately), and byvisning's city artifact is staging-
// only anyway — so the live surfaces point at staging until a promotion puts
// /embed on mobilitetsatlas.dk. The embed surface carries no chrome, so nothing
// on it says "Testversion"; the difference is the data edition, not the look.
const ATLAS = process.env.ATLAS || 'https://staging.mobilitetsatlas.dk';
const ATLAS_STAGING = process.env.ATLAS || 'https://staging.mobilitetsatlas.dk';
const EDITION = 'Edition 0.4.0 · 22 August 2026';

// ---------------------------------------------------------------------------
// Palette. The atlas ships Beta's tokens verbatim (site/app/globals.css is the
// inlined token file), so the template's palette IS the atlas palette and is
// left alone. What the atlas adds is the A–G ramp, and that is DATA-ENCODING
// colour: it means a grade, it is not decoration, and the palette has a
// fixed twelve slots with no room for seven more. So grade fills are literals
// from the app's own SATURATED_GRADE_HEX (the ramp on municipality pages, which
// is the ramp in this deck's screenshots) and carry no themeRefs.
// ---------------------------------------------------------------------------
const GRADES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const GRADE_HEX = {
  A: '#1A9850', B: '#66BD63', C: '#A6D96A', D: '#FEE08B',
  E: '#F46D43', F: '#D73027', G: '#A50026',
};
const CHARCOAL = '#1A1A1A';
const CREAM = '#F5F3EF';

/** The app's own rule: charcoal above 0.18 relative luminance, cream below. */
function inkOn(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.18 ? CHARCOAL : CREAM;
}

const SANS = "'Inter', system-ui, sans-serif";
const SERIF = "'Playfair Display', Georgia, serif";
const MONO = "'DM Mono', 'Courier New', monospace";
const SAGE = '#4A7C59';   // accent1
const MUTED = '#666666';  // accent4
const SUBTLE = '#999999'; // accent5
const BG2 = '#F0EDE8';    // accent6 / bg2

// ---------------------------------------------------------------------------
// Element helpers. Every element carries the full field set the guide asks for.
// ---------------------------------------------------------------------------
const base = (id, x, y, w, h) => ({ id, x, y, w, h, rotation: 0, opacity: 1 });

function text(id, x, y, w, h, html, o = {}) {
  const { size = 22, weight = 400, color = CHARCOAL, ref = 'tx1', family = SANS,
    align = 'left', valign = 'top', lh = 1.5, role, fx, link, ls, morphId, opacity } = o;
  const el = {
    ...base(id, x, y, w, h), type: 'text', html,
    fontSize: size, fontFamily: family, fontWeight: weight, color,
    align, valign, lineHeight: lh,
  };
  if (opacity !== undefined) el.opacity = opacity;
  if (ls !== undefined) el.letterSpacing = ls;
  if (role) el.role = role;
  if (ref) el.themeRefs = { color: ref };
  if (fx) el.fx = fx;
  if (link) el.link = link;
  if (morphId) el.morphId = morphId;
  return el;
}

function rect(id, x, y, w, h, fill, o = {}) {
  const { ref, radius = 0, opacity = 1, link, stroke = 'none', strokeWidth = 0,
    strokeStyle, fx, morphId } = o;
  const el = {
    ...base(id, x, y, w, h), opacity, type: 'shape', shape: 'rect',
    fill, stroke, strokeWidth, radius,
  };
  if (strokeStyle) el.strokeStyle = strokeStyle;
  if (ref) el.themeRefs = { fill: ref };
  if (fx) el.fx = fx;
  if (link) el.link = link;
  if (morphId) el.morphId = morphId;
  return el;
}

function ellipse(id, x, y, w, h, fill, o = {}) {
  const el = { ...base(id, x, y, w, h), type: 'shape', shape: 'ellipse', fill,
    stroke: o.stroke ?? 'none', strokeWidth: o.strokeWidth ?? 0, radius: 0 };
  if (o.ref) el.themeRefs = { fill: o.ref };
  if (o.fx) el.fx = o.fx;
  if (o.link) el.link = o.link;
  return el;
}

function line(id, x, y, w, fill, o = {}) {
  // A line shape takes its colour from `fill` and draws horizontally across the
  // box; dash-march needs a stroke AND a dash pattern to have anything to move.
  const el = {
    ...base(id, x, y, w, o.h ?? 4), type: 'shape', shape: 'line', fill,
    stroke: o.stroke ?? fill, strokeWidth: o.strokeWidth ?? 2, radius: 0,
    strokeStyle: o.strokeStyle ?? 'dashed',
  };
  if (o.fx) el.fx = o.fx;
  if (o.lineEnd) el.lineEnd = o.lineEnd;
  return el;
}

/**
 * Footer chrome, OFF (Johan, slide-by-slide review): no rule, no company line,
 * no page number. Kept as a no-op rather than deleted from twelve call sites,
 * so it is one edit to bring back. The provenance those lines carried lives in
 * the speaker notes.
 */
const footer = (_onDark = false) => [];
const _footerWas = (onDark = false) => [
  rect('beta-foot-rule', 96, 640, 1088, 1, onDark ? '#333333' : '#333333',
    { ref: 'tx2', opacity: 0.25 }),
  text('beta-foot-company', 96, 652, 540, 28, 'Danmarks Mobilitetsatlas · {{company}}',
    { size: 13, family: MONO, color: onDark ? SUBTLE : MUTED, ref: onDark ? 'accent5' : 'accent4',
      valign: 'middle', lh: 1.3, role: 'kicker' }),
  text('beta-foot-page', 984, 652, 200, 28, '{{page:2}}',
    { size: 13, family: MONO, color: onDark ? SUBTLE : MUTED, ref: onDark ? 'accent5' : 'accent4',
      align: 'right', valign: 'middle', lh: 1.3, role: 'kicker' }),
];

const title = (html, o = {}) => text('beta-title-h', 96, 72, 1088, 84, html,
  { size: o.size ?? 40, weight: 700, family: SERIF, valign: 'middle', lh: 1.1,
    role: 'title', color: o.color ?? CHARCOAL, ref: o.ref ?? 'tx1' });

/** Source/as-of kicker, OFF for the same reason. Same no-op shape. */
const asOf = (_id, _x, _y, _label, _w) => [];
const _asOfWas = (id, x, y, label, w = 1088) => text(id, x, y, w, 30, label,
  { size: 13, family: MONO, color: MUTED, ref: 'accent4', valign: 'middle', lh: 1.3, role: 'kicker' });

// ---------------------------------------------------------------------------
// The A–G ramp: the deck's morph thread. Seven rects with stable ids, so the
// scale glides from the slide that introduces it, to the slide that highlights
// E–F–G, to the slide that highlights Aarhus's B.
// ---------------------------------------------------------------------------
function ramp({ y, h = 76, dim = () => 1, scale = () => 1, letters = true, labelSize = 20 }) {
  const w = 148, gap = 8, out = [];
  GRADES.forEach((g, i) => {
    const s = scale(g);
    const gh = Math.round(h * s);
    const gy = y + Math.round((h - gh) / 2);
    out.push(rect(`grade-${g.toLowerCase()}`, 96 + i * (w + gap), gy, w, gh, GRADE_HEX[g],
      { radius: 4, opacity: dim(g) }));
    if (letters) {
      out.push(text(`grade-${g.toLowerCase()}-l`, 96 + i * (w + gap), gy, w, gh, g,
        { size: Math.round(labelSize * s), weight: 700, family: MONO, color: inkOn(GRADE_HEX[g]),
          ref: null, align: 'center', valign: 'middle', lh: 1, opacity: dim(g) }));
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Assets: the four captures. A raster view goes into an embed as
// <svg viewBox="0 0 W H"><image href="data:…"/></svg>, which is the shape the
// guide specifies and which the svg sanitiser accepts.
// ---------------------------------------------------------------------------
const b64 = (f) => readFileSync(join(HERE, 'captures', f)).toString('base64');
const dataUri = (f) => `data:image/jpeg;base64,${b64(f)}`;
const svgView = (f, w, h) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
  `<image href="${dataUri(f)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/></svg>`;

// ---------------------------------------------------------------------------
// The scatter: 98 municipalities, latest DST "families with a car" against the
// published mobility-freedom composite. Seven series, one per grade, so the
// cloud carries the grade ramp and the legend doubles as the scale — charts-lite
// colours by series, never per point.
// ---------------------------------------------------------------------------
const scatter = JSON.parse(readFileSync(join(HERE, 'scatter.json'), 'utf8'));
const scatterSeries = GRADES.map((g) => ({
  type: 'scatter',
  name: g,
  symbolSize: 13,
  itemStyle: { color: GRADE_HEX[g] },
  data: scatter.filter((p) => p.grade === g).map((p) => [p.x, p.y]),
})).filter((s) => s.data.length);

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------
const slides = [];

// 1 — cover ------------------------------------------------------------------
slides.push({
  id: 'cover', background: CHARCOAL, transition: 'none',
  themeRefs: { background: 'tx1' },
  notes: 'Danmarks Mobilitetsatlas gives every place in Denmark one comparable A–G grade for mobility. Twenty minutes: what the grade measures, how we calculate it, and what it says about your municipality. The map behind me is the 29 municipalities graded E, F or G. Every figure in the deck is the published 0.4.0 edition of 22 August 2026, built on Rejseplanen GTFS (CC BY 4.0), OpenStreetMap and Danmarks Statistik. Full source list on mobilitetsatlas.dk/en/metode.',
  elements: [
    { ...base('hero-map', 0, 0, 1280, 720), type: 'image', src: 'asset:cover-map',
      fit: 'cover', radius: 0,
      fx: { ambient: 'kenburns', ken: { dir: 'drift', scale: 1.08, duration: 26 } } },
    rect('hero-scrim', 0, 0, 1280, 720, 'rgba(26,26,26,0.62)'),
    text('beta-kicker', 96, 264, 900, 32, 'AN INTRODUCTION FOR DANISH MUNICIPALITIES',
      { size: 14, family: MONO, color: CREAM, ref: 'bg1', valign: 'middle', lh: 1.3,
        role: 'kicker', ls: 2 }),
    text('beta-title-h', 96, 306, 940, 180, 'Danmarks\nMobilitetsatlas'.replace('\n', '<br>'),
      { size: 72, weight: 700, family: SERIF, color: CREAM, ref: 'bg1', lh: 1.05, role: 'title' }),
    text('beta-title-sub', 96, 500, 820, 80,
      'One comparable A–G grade for how freely people can move, with and without a car.',
      { size: 24, color: CREAM, ref: 'bg1', lh: 1.4, role: 'subtitle' }),
    text('beta-title-byline', 96, 620, 900, 28, '{{company}} · {{author}} · {{date}}',
      { size: 13, family: MONO, color: CREAM, ref: 'bg1', valign: 'middle', lh: 1.3,
        role: 'kicker' }),
  ],
});

// 2 — what it measures -------------------------------------------------------
slides.push({
  id: 'backbone', background: CREAM, transition: 'fade',
  themeRefs: { background: 'bg1' },
  notes: 'Denmark has a real public transport backbone. These are counted figures from the Rejseplanen feed, not estimates. But a stop outside your door is not the same as getting to work, school or the doctor. That gap is what the atlas measures.',
  elements: [
    title('Denmark has the network. The question is what it reaches.'),
    ...[['36,204', 'stops', 'n-stops'], ['1,574', 'routes', 'n-routes'], ['20', 'operators', 'n-ops']]
      .flatMap(([v, label, id], i) => {
        const x = 96 + i * 374;
        return [
          text(`${id}-v`, x, 214, 340, 96, v,
            { size: 76, weight: 700, family: SERIF, lh: 1, ref: 'tx1',
              fx: { countUp: true, enter: 'fade-up', order: i } }),
          text(`${id}-l`, x, 312, 340, 32, label,
            { size: 16, family: MONO, color: MUTED, ref: 'accent4', lh: 1.3, role: 'kicker',
              fx: { enter: 'fade-up', order: i } }),
        ];
      }),
    rect('rule-1', 96, 372, 1088, 1, '#333333', { ref: 'tx2', opacity: 0.2 }),
    text('backbone-body', 96, 408, 528, 200,
      'That is the supply side, and it is the number most reports stop at.',
      { size: 24, lh: 1.5, role: 'body', ref: 'tx1', fx: { enter: 'fade-up', order: 3 } }),
    text('backbone-body-2', 656, 408, 528, 200,
      'A departure board is not access. What decides whether a car is a choice is how much of everyday life you can reach in a reasonable travel time: work, groceries, school, health, social.',
      { size: 22, color: MUTED, ref: 'accent4', lh: 1.5, role: 'body',
        fx: { enter: 'fade-up', order: 4 } }),
    asOf('backbone-asof', 96, 596, `Beta · Rejseplanen GTFS (CC BY 4.0) · Data as of ${ASOF}`),
    ...footer(),
  ],
});

// 3 — the grade --------------------------------------------------------------
slides.push({
  id: 'grade-scale', background: CREAM, transition: 'morph',
  themeRefs: { background: 'bg1' },
  notes: 'One comparable grade, built from two measured reaches. Public transport quality is how much of everyday life you reach without a car. Transport choice is how much further the car gets you. Their average is mobility freedom, 0 to 100, and that becomes the letter. People remember the letter. The score is the part you can move.',
  elements: [
    title('One comparable grade, A to G'),
    text('grade-lede', 96, 186, 1088, 60,
      'Mobility freedom, 0 to 100, for every place in Denmark. Then a letter.',
      { size: 24, color: MUTED, ref: 'accent4', lh: 1.4, role: 'body' }),
    ...ramp({ y: 288 }),
    text('ramp-hi', 96, 378, 400, 28, 'high mobility freedom',
      { size: 14, family: MONO, color: MUTED, ref: 'accent4', lh: 1.3, role: 'kicker' }),
    text('ramp-lo', 784, 378, 400, 28, 'low mobility freedom',
      { size: 14, family: MONO, color: MUTED, ref: 'accent4', align: 'right', lh: 1.3,
        role: 'kicker' }),
    rect('formula-box', 96, 442, 1088, 96, BG2, { ref: 'accent6', radius: 8 }),
    text('formula', 128, 442, 1024, 96,
      'mobility freedom  =  ½ public transport quality  +  ½ transport choice',
      { size: 22, family: MONO, valign: 'middle', lh: 1.4, ref: 'tx1',
        fx: { enter: 'fade-up', order: 1 } }),
    asOf('grade-asof', 96, 570, `Beta · Danmarks Mobilitetsatlas · ${EDITION}`),
    ...footer(),
  ],
});

// 4 — E, F, G ----------------------------------------------------------------
slides.push({
  id: 'efg', background: CREAM, transition: 'morph',
  themeRefs: { background: 'bg1' },
  notes: 'Watch the scale: the three weakest bands step forward. Twenty-nine of the ninety-eight municipalities are graded E, F or G. That is 1.15 million people, about one Dane in five, living where the car is not really a choice. If your municipality is in that group, this is your slide. If it is not, some of your neighbours are.',
  elements: [
    title('Nearly one municipality in three sits in E, F or G'),
    ...ramp({
      y: 200, h: 88,
      dim: (g) => ('EFG'.includes(g) ? 1 : 0.22),
      scale: (g) => ('EFG'.includes(g) ? 1 : 0.55),
    }),
    ...[['29', 'of 98 municipalities', 'k-1'], ['1.15', 'million people', 'k-2'],
        ['19', 'per cent of the population', 'k-3']]
      .flatMap(([v, label, id], i) => {
        const x = 96 + i * 374;
        return [
          text(`${id}-v`, x, 344, 340, 92, v,
            { size: 72, weight: 700, family: SERIF, lh: 1, ref: 'tx1',
              fx: { countUp: true, enter: 'fade-up', order: i } }),
          text(`${id}-l`, x, 438, 340, 32, label,
            { size: 16, family: MONO, color: MUTED, ref: 'accent4', lh: 1.3, role: 'kicker',
              fx: { enter: 'fade-up', order: i } }),
        ];
      }),
    text('efg-body', 96, 492, 1088, 76,
      'In the lowest bands, walking and public transport cover only a small part of everyday life. The car is in practice necessary, including for the people who cannot drive.',
      { size: 22, color: MUTED, ref: 'accent4', lh: 1.5, role: 'body',
        fx: { enter: 'fade-up', order: 3 } }),
    asOf('efg-asof', 96, 586, `Beta · league table, ${EDITION} · Data as of ${ASOF}`),
    ...footer(),
  ],
});

// 5 — the five DST groups ----------------------------------------------------
slides.push({
  id: 'groups', background: CREAM, transition: 'morph',
  themeRefs: { background: 'bg1' },
  notes: 'Grouped by Statistics Denmark\'s own municipal classification, public transport quality falls from 80 in the capital municipalities to 25 in the rural ones. A factor of 3.2, population-weighted, so this counts people rather than map area. No municipality chose this. It is what density and distance do. It does mean a national average is useless to you.',
  elements: [
    title('Five kinds of municipality, five kinds of service'),
    // Vertical bars: charts-lite reads a CATEGORY x-axis and a VALUE y-axis. A
    // first pass put the categories on y for a horizontal bar chart and the
    // engine drew one bar on a 0–30 axis — it has no horizontal-bar mode, and
    // it ignores what it does not implement in silence.
    { ...base('groups-chart', 96, 200, 624, 392), type: 'chart', preset: 'bar',
      option: {
        color: [SAGE],
        grid: { left: 46, right: 12, top: 16, bottom: 52 },
        xAxis: { type: 'category',
          data: ['Capital', 'Large city', 'Provincial', 'Commuter', 'Rural'],
          axisLabel: { fontSize: 13, color: CHARCOAL } },
        yAxis: { type: 'value', min: 0, max: 100, axisLabel: { fontSize: 12, color: MUTED } },
        series: [{ type: 'bar', name: 'Public transport quality', data: [80.1, 64.6, 46.1, 39.1, 25.2],
          itemStyle: { color: SAGE, borderRadius: 3 }, barWidth: 62 }],
        tooltip: { trigger: 'item', formatter: '{b}: {c}' },
      },
      fx: { enter: 'fade-up' } },
    text('groups-axis', 96, 596, 624, 26, 'Public transport quality, 0–100 · population-weighted',
      { size: 12, family: MONO, color: MUTED, ref: 'accent4', align: 'center', lh: 1.2,
        role: 'kicker' }),
    text('groups-body', 752, 200, 432, 300,
      'Public transport quality, population-weighted, by Statistics Denmark\'s municipal grouping.<br><br>The capital municipalities score 80.1. The rural municipalities score 25.2. A difference of 3.2 times.',
      { size: 21, lh: 1.55, role: 'body', ref: 'tx1' }),
    rect('groups-mark', 752, 520, 432, 64, BG2, { ref: 'accent6', radius: 8 }),
    text('groups-mark-t', 776, 520, 384, 64,
      'A national average describes no municipality.',
      { size: 18, weight: 700, valign: 'middle', lh: 1.35, ref: 'tx1' }),
    asOf('beta-asof', 752, 596, `DST grouping 2018 · ${EDITION}`, 432),
    ...footer(),
  ],
});

// 6 — section: method --------------------------------------------------------
slides.push({
  id: 'sec-method', background: CHARCOAL, transition: 'morph',
  themeRefs: { background: 'tx1' },
  notes: 'Before any municipality accepts a letter grade, it wants to know how the letter was produced. Four steps, then the parts we do not yet capture.',
  elements: [
    text('beta-kicker', 96, 272, 640, 32, 'PART 2',
      { size: 14, family: MONO, color: '#40916C', ref: 'accent2', valign: 'middle', lh: 1.3,
        role: 'kicker', ls: 2 }),
    text('beta-title-h', 96, 312, 960, 160, 'How the grade is calculated',
      { size: 60, weight: 700, family: SERIF, color: CREAM, ref: 'bg1', lh: 1.05, role: 'title' }),
    text('beta-title-sub', 96, 488, 900, 76,
      'Same method, same sources, every municipality. That is what makes the comparison fair.',
      { size: 22, color: SUBTLE, ref: 'accent5', lh: 1.4, role: 'subtitle' }),
    ...footer(true),
  ],
});

// 7 — the four steps ---------------------------------------------------------
const STEPS = [
  ['1', 'Two measured reaches', 'Rejseplanen timetables and the OpenStreetMap road network: what you reach by public transport, and by car. Trips over 90 minutes do not count.'],
  ['2', 'Everyday destinations', 'Five kinds: workplaces, groceries, schools, health, social. The first destinations within reach count most.'],
  ['3', 'Two scores', 'Public transport quality is how much of everyday life you reach without a car. Transport choice is how much further the car gets you.'],
  ['4', 'The grade', 'Their average is mobility freedom, and that determines the letter, A to G.'],
];
slides.push({
  id: 'method', background: CREAM, transition: 'morph',
  themeRefs: { background: 'bg1' },
  notes: 'About 75,000 points across all 98 municipalities, roughly every neighbourhood in the country. For each one we compute what is reachable twice, once by public transport and once by car. Over 20 billion journeys in total. Destinations score on a saturating curve, so the tenth supermarket adds less than the first. Click the box at the bottom if anyone asks what is missing. Someone always does, which is why it has its own slide.',
  elements: [
    title('From analysis to grade'),
    ...STEPS.flatMap(([n, head, body], i) => {
      const x = 96 + i * 278;
      return [
        ellipse(`step-${n}-dot`, x, 196, 56, 56, SAGE, { ref: 'accent1' }),
        text(`step-${n}-num`, x, 196, 56, 56, n,
          { size: 22, weight: 700, family: MONO, color: CREAM, ref: 'bg1', align: 'center',
            valign: 'middle', lh: 1 }),
        text(`step-${n}-head`, x, 274, 254, 60, head,
          { size: 20, weight: 700, lh: 1.25, ref: 'tx1', fx: { enter: 'fade-up', order: i } }),
        text(`step-${n}-body`, x, 340, 254, 180, body,
          { size: 15, color: MUTED, ref: 'accent4', lh: 1.5, role: 'body',
            fx: { enter: 'fade-up', order: i } }),
      ];
    }),
    // Three dashed connectors marching left to right between the step dots.
    ...[0, 1, 2].map((i) => line(`step-link-${i}`, 96 + 56 + i * 278 + 12, 222, 278 - 56 - 24,
      SAGE, { strokeWidth: 2, strokeStyle: 'dashed', lineEnd: 'arrow',
        fx: { loop: { type: 'dash-march', distance: 16, duration: 1.6 } } })),
    rect('limits-hit', 96, 546, 520, 60, BG2,
      { ref: 'accent6', radius: 30, link: 'state-limits' }),
    text('limits-label', 128, 546, 472, 60,
      '→  What the atlas does not capture (yet)',
      { size: 17, weight: 700, family: MONO, valign: 'middle', lh: 1.3, ref: 'tx1' }),
    asOf('method-asof', 640, 552, `~75,000 points · 98 municipalities · ${EDITION}`, 544),
    ...footer(),
  ],
});

// 7b — state: limits ---------------------------------------------------------
const LIMITS = [
  ['Congestion', 'Car times are computed without queues, so the car\'s advantage is overstated where congestion is worst.'],
  ['Flextrafik', 'Flextur and Plustur are not in the Rejseplanen feed, so sparsely populated municipalities get no credit for them.'],
  ['The bicycle', 'Walking counts as access to the network; cycling is not yet a mode of its own. In Denmark that is the most noticeable omission.'],
  ['Journey quality', 'A seat, a safe interchange at night, a platform that works with a pram. We measure travel time and reach, not how it feels.'],
  ['Timetable, not reality', 'Delays and missed connections are not included. This is what the timetable promises.'],
  ['Supply, not behaviour', 'What can be reached, not what people do. Two municipalities with the same grade can travel very differently.'],
];
slides.push({
  id: 'state-limits', stateOf: 'method', transition: 'morph', name: 'Limits',
  background: CREAM, themeRefs: { background: 'bg1' },
  notes: 'Say this one plainly. The two that matter most to a Danish municipality are Flextrafik and the bicycle. Both work against exactly the municipalities that score lowest. Press ← or click anywhere to go back.',
  elements: [
    title('What the atlas does not capture (yet)'),
    ...LIMITS.flatMap(([head, body], i) => {
      const x = 96 + (i % 3) * 374;
      const y = 200 + Math.floor(i / 3) * 216;
      return [
        rect(`lim-${i}-bar`, x, y, 48, 4, SAGE, { ref: 'accent1' }),
        text(`lim-${i}-h`, x, y + 22, 340, 36, head,
          { size: 20, weight: 700, lh: 1.25, ref: 'tx1' }),
        text(`lim-${i}-b`, x, y + 66, 340, 130, body,
          { size: 15, color: MUTED, ref: 'accent4', lh: 1.5, role: 'body' }),
      ];
    }),
    text('lim-back', 96, 604, 700, 28, '←  back to the method',
      { size: 14, family: MONO, color: MUTED, ref: 'accent4', valign: 'middle', lh: 1.3,
        role: 'kicker' }),
    rect('lim-dismiss', 0, 0, 1280, 720, 'rgba(0,0,0,0)', { link: 'method' }),
  ],
});

// 8 — the A–G table ----------------------------------------------------------
const BANDS = [
  ['A', '70–100', '22', '27%'], ['B', '55–70', '9', '16%'], ['C', '45–55', '4', '6%'],
  ['D', '30–45', '34', '31%'], ['E', '22–30', '17', '11%'], ['F', '15–22', '9', '6%'],
  ['G', '0–15', '3', '2%'],
];
slides.push({
  id: 'scale-table', background: CREAM, transition: 'morph',
  themeRefs: { background: 'bg1' },
  notes: 'The whole distribution on one slide. The shape is not a bell curve. Denmark is bimodal: a large A group, a large D group, very little in between. Roskilde on the right is the worked example from the method page. 70.7 and 66.3 average to 68.5, which is a B.',
  elements: [
    title('The A–G scale, and where Denmark sits'),
    { ...base('bands-table', 96, 192, 624, 400), type: 'table', header: true,
      columns: [{ w: 0.8 }, { w: 1.3 }, { w: 1.5 }, { w: 1.4 }],
      rows: [
        { cells: [{ html: 'Grade' }, { html: 'Score' }, { html: 'Municipalities', align: 'right' },
          { html: 'Population', align: 'right' }] },
        ...BANDS.map(([g, r, n, p]) => ({
          cells: [
            { html: g, bold: true, bg: GRADE_HEX[g], color: inkOn(GRADE_HEX[g]), align: 'center' },
            { html: r }, { html: n, align: 'right' }, { html: p, align: 'right' },
          ],
        })),
      ],
      style: {
        headerBg: CHARCOAL, headerColor: CREAM, borderColor: 'rgba(26,26,26,0.14)',
        borderWidth: 1, cellPadX: 14, cellPadY: 10, fontSize: 17, color: CHARCOAL, radius: 8,
      },
      fx: { enter: 'fade-up' } },
    text('roskilde-k', 752, 192, 432, 28, 'WORKED EXAMPLE · ROSKILDE',
      { size: 13, family: MONO, color: MUTED, ref: 'accent4', valign: 'middle', lh: 1.3,
        role: 'kicker', ls: 1.5 }),
    ...[['70.7', 'Public transport quality', 'rk-1'], ['66.3', 'Transport choice', 'rk-2']]
      .flatMap(([v, l, id], i) => [
        text(`${id}-v`, 752, 236 + i * 104, 200, 56, v,
          { size: 44, weight: 700, family: SERIF, lh: 1, ref: 'tx1',
            fx: { countUp: true, enter: 'fade-up', order: i } }),
        text(`${id}-l`, 752, 294 + i * 104, 432, 28, l,
          { size: 14, family: MONO, color: MUTED, ref: 'accent4', lh: 1.3, role: 'kicker' }),
      ]),
    rect('rk-rule', 752, 452, 432, 1, '#333333', { ref: 'tx2', opacity: 0.25 }),
    text('rk-total', 752, 476, 260, 64, '68.5',
      { size: 56, weight: 700, family: SERIF, lh: 1, ref: 'tx1',
        fx: { countUp: true, enter: 'fade-up', order: 2 } }),
    rect('rk-chip', 1004, 480, 72, 56, GRADE_HEX.B, { radius: 6 }),
    text('rk-chip-l', 1004, 480, 72, 56, 'B',
      { size: 28, weight: 700, family: MONO, color: inkOn(GRADE_HEX.B), ref: null,
        align: 'center', valign: 'middle', lh: 1 }),
    text('rk-total-l', 752, 546, 432, 28, 'their average is mobility freedom',
      { size: 14, family: MONO, color: MUTED, ref: 'accent4', lh: 1.3, role: 'kicker' }),
    asOf('scale-asof', 96, 604, `Beta · ${EDITION} · Data as of ${ASOF}`),
    ...footer(),
  ],
});

// 9 — section: your municipality ---------------------------------------------
slides.push({
  id: 'sec-kommune', background: CHARCOAL, transition: 'morph',
  themeRefs: { background: 'tx1' },
  notes: 'What this looks like for one municipality. Aarhus as the worked example, then the live site, then street level in København.',
  elements: [
    text('beta-kicker', 96, 272, 640, 32, 'PART 3',
      { size: 14, family: MONO, color: '#40916C', ref: 'accent2', valign: 'middle', lh: 1.3,
        role: 'kicker', ls: 2 }),
    text('beta-title-h', 96, 312, 960, 160, 'What it looks like for your municipality',
      { size: 60, weight: 700, family: SERIF, color: CREAM, ref: 'bg1', lh: 1.05, role: 'title' }),
    text('beta-title-sub', 96, 500, 900, 76,
      'Every municipality has a page: the grade, the two pillars, the trend, the plans behind it.',
      { size: 22, color: SUBTLE, ref: 'accent5', lh: 1.4, role: 'subtitle' }),
    ...footer(true),
  ],
});

// 10 — Aarhus ----------------------------------------------------------------
slides.push({
  id: 'aarhus', background: CREAM, transition: 'morph',
  themeRefs: { background: 'bg1' },
  notes: 'Aarhus scores 68.6, a B, twenty-fourth of ninety-eight. Read the two pillars as well as the letter: 70.5 for public transport quality against 66.7 for transport choice. That balance is unusual, and it is good news. Public transport competes with the car here. In most municipalities the second number is far larger than the first, and that gap is the car dependency.',
  elements: [
    title('Aarhus, at municipal level'),
    ...ramp({
      y: 178, h: 56, labelSize: 17,
      dim: (g) => (g === 'B' ? 1 : 0.25),
      scale: (g) => (g === 'B' ? 1 : 0.7),
    }),
    text('aa-score', 96, 268, 400, 130, '68.6',
      { size: 116, weight: 700, family: SERIF, lh: 1, ref: 'tx1',
        fx: { countUp: true, enter: 'fade-up', order: 0 } }),
    rect('aa-chip', 400, 288, 96, 96, GRADE_HEX.B, { radius: 8 }),
    text('aa-chip-l', 400, 288, 96, 96, 'B',
      { size: 44, weight: 700, family: MONO, color: inkOn(GRADE_HEX.B), ref: null,
        align: 'center', valign: 'middle', lh: 1 }),
    text('aa-rank', 96, 406, 500, 32, 'No. 24 of 98 municipalities · high mobility freedom',
      { size: 16, family: MONO, color: MUTED, ref: 'accent4', lh: 1.3, role: 'kicker' }),
    rect('aa-div', 624, 268, 1, 240, '#333333', { ref: 'tx2', opacity: 0.2 }),
    ...[['70.5', 'Public transport quality', 'aa-p1'], ['66.7', 'Transport choice', 'aa-p2']]
      .flatMap(([v, l, id], i) => [
        text(`${id}-v`, 688 + i * 260, 268, 240, 70, v,
          { size: 56, weight: 700, family: SERIF, lh: 1, ref: 'tx1',
            fx: { countUp: true, enter: 'fade-up', order: i + 1 } }),
        text(`${id}-l`, 688 + i * 260, 344, 240, 56, l,
          { size: 14, family: MONO, color: MUTED, ref: 'accent4', lh: 1.35, role: 'kicker' }),
      ]),
    text('aa-note', 688, 424, 496, 90,
      'The two pillars sit close together. Public transport competes with the car here. In most municipalities the second number is far larger than the first.',
      { size: 17, color: MUTED, ref: 'accent4', lh: 1.5, role: 'body',
        fx: { enter: 'fade-up', order: 3 } }),
    rect('aa-facts', 96, 460, 464, 128, BG2, { ref: 'accent6', radius: 8 }),
    text('aa-facts-t', 120, 460, 416, 128,
      '378,295 residents · 465.87 km²<br>1,174 DKK per resident for public transport (2025)<br>Transport authority: Midttrafik',
      { size: 16, family: MONO, valign: 'middle', lh: 1.7, ref: 'tx1' }),
    asOf('aarhus-asof', 96, 604, `Beta · ${EDITION} · Data as of ${ASOF}`),
    ...footer(),
  ],
});

// 11 — Aarhus live -----------------------------------------------------------
slides.push({
  id: 'aarhus-live', background: CREAM, transition: 'morph',
  themeRefs: { background: 'bg1' },
  notes: 'This map is live in the slide. Drag it, zoom, toggle the routes and the frequency. Three things to point at: the detailed map with cell-level grades, the five-year trend from Statistics Denmark, and "Ask about mobility", which answers from your own municipal and regional plans with the source documents linked. All of it CC BY-SA: screenshot it, quote it, put it in your own papers.',
  elements: [
    title('Aarhus, live on the map'),
// LIVE MAPS. These three embeds run the real atlas, not a picture of it.
// `/embed/kommune/<slug>` is a route built for this: the DetailMap alone, no
// header, no consent banner, no visitor cookie, sized by whatever frames it
// (betamobility/dk-mobility#230).
//
// The chrome had to go for more than tidiness. A sandboxed frame has an opaque
// origin, where `document.cookie` THROWS rather than returning "", and two
// chrome components read it — so the ordinary kommune page dies on boot inside
// a frame and the browser paints its own "This page couldn't load", which the
// deck cannot recover from (it restores the view on `error`, and a
// crashed-but-loaded page fires `load`).
//
// NO SHELL CHANGE IS NEEDED. An earlier pass added `allow-same-origin` for
// these origins, on a measurement that Mapbox GL renders nothing without it.
// That measurement came from a DEV build: `next dev` serves the GL worker in a
// form an opaque origin refuses, and a production build does not. Re-measured
// against `next build` output, the map paints under Bento's default sandbox
// flags — so the sandbox stays shut, which is where an untrusted deck wants it.
// `check-sandbox-gl.mjs` is that comparison; point it at a production server.
//
// Each embed still carries its `view`, so offline, in print, in a thumbnail and
// in PowerPoint the deck shows a real screenshot instead of a hole.
    { ...base('aarhus-embed', 96, 176, 1088, 424), type: 'embed', app: 'web',
      url: `${ATLAS}/en/embed/kommune/aarhus?bare=1`, live: true,
      view: 'asset:view-aarhus' },
    rect('how-hit', 96, 616, 400, 44, BG2, { ref: 'accent6', radius: 22, link: 'state-how-to-read' }),
    text('how-label', 120, 616, 360, 44, '→  How to read A–G',
      { size: 15, weight: 700, family: MONO, valign: 'middle', lh: 1.3, ref: 'tx1' }),
    text('live-note', 528, 616, 656, 44,
      'mobilitetsatlas.dk/en/kommune/aarhus  ·  CC BY-SA 4.0',
      { size: 13, family: MONO, color: MUTED, ref: 'accent4', align: 'right', valign: 'middle',
        lh: 1.3, role: 'kicker' }),
  ],
});

// 11b — state: how to read ---------------------------------------------------
const BAND_TEXT = {
  A: 'Walking and public transport cover practically as much of everyday life as the car.',
  B: 'Walking and public transport cover most of everyday life, close to what the car does.',
  C: 'Walking and public transport cover a large part of everyday life, helped by short distances.',
  D: 'Walking and public transport cover part of everyday life, but far from what the car reaches.',
  E: 'Walking and public transport cover only a smaller part; the car reaches clearly further.',
  F: 'Walking and public transport cover few everyday journeys; the car is in practice necessary.',
  G: 'Walking and public transport cover almost none of everyday life; the car is the only real option.',
};
slides.push({
  id: 'state-how-to-read', stateOf: 'aarhus-live', transition: 'morph', name: 'How to read A–G',
  background: CREAM, themeRefs: { background: 'bg1' },
  notes: 'The band descriptions come out of the published league table itself, so they cannot drift from the thresholds.',
  elements: [
    title('How to read A–G'),
    ...GRADES.flatMap((g, i) => {
      const y = 172 + i * 64;
      return [
        rect(`grade-${g.toLowerCase()}`, 96, y, 64, 52, GRADE_HEX[g], { radius: 4 }),
        text(`grade-${g.toLowerCase()}-l`, 96, y, 64, 52, g,
          { size: 24, weight: 700, family: MONO, color: inkOn(GRADE_HEX[g]), ref: null,
            align: 'center', valign: 'middle', lh: 1 }),
        text(`band-${g}-t`, 180, y, 1004, 52, BAND_TEXT[g],
          { size: 17, valign: 'middle', lh: 1.4, ref: 'tx1' }),
      ];
    }),
    text('how-back', 96, 630, 700, 28, '←  back',
      { size: 14, family: MONO, color: MUTED, ref: 'accent4', valign: 'middle', lh: 1.3,
        role: 'kicker' }),
    rect('how-dismiss', 0, 0, 1280, 720, 'rgba(0,0,0,0)', { link: 'aarhus-live' }),
  ],
});

// 12 — explore ---------------------------------------------------------------
slides.push({
  id: 'explore', background: CREAM, transition: 'morph',
  themeRefs: { background: 'bg1' },
  notes: 'Every municipality, one dot, coloured by grade. Horizontally the share of families owning a car, from Statistics Denmark. Vertically mobility freedom. The correlation is minus 0.66 across all 98, and the spread at any given level of car ownership is the interesting part. Say the caveat out loud: a pattern between two numbers is not a cause. Click through for the live version, where the horizontal axis is a dropdown.',
  elements: [
    title('Compare municipalities'),
    // Legend on TOP: at the bottom it landed on the x-axis labels. The grade
    // ramp IS the legend here, so it wants to be read before the cloud.
    { ...base('explore-chart', 96, 184, 656, 396), type: 'chart', preset: 'scatter',
      option: {
        grid: { left: 46, right: 14, top: 46, bottom: 34 },
        xAxis: { type: 'value', axisLabel: { fontSize: 12, color: MUTED } },
        yAxis: { type: 'value', min: 0, max: 100, axisLabel: { fontSize: 12, color: MUTED } },
        legend: { show: true, top: 0, textStyle: { fontSize: 12 } },
        tooltip: { trigger: 'item' },
        series: scatterSeries,
      },
      fx: { enter: 'fade-up' } },
    text('exp-x', 96, 584, 656, 26, 'Families with a car (%)  →   ·   ↑ mobility freedom',
      { size: 12, family: MONO, color: MUTED, ref: 'accent4', align: 'center', lh: 1.2,
        role: 'kicker' }),
    text('exp-r', 784, 184, 400, 76, 'r = −0.664',
      { size: 56, weight: 700, family: SERIF, lh: 1, ref: 'tx1', fx: { enter: 'fade-up', order: 0 } }),
    text('exp-r-l', 784, 264, 400, 28, 'n = 98 municipalities',
      { size: 14, family: MONO, color: MUTED, ref: 'accent4', lh: 1.3, role: 'kicker' }),
    text('exp-body', 784, 312, 400, 240,
      'Each dot is one municipality, coloured by its grade. Vertical: mobility freedom. Horizontal: the share of families with a car.<br><br>Where public transport reaches less, more families keep a car. The spread at any given level is wide, and that spread is where policy lives.<br><br>A pattern between two numbers is not a cause.',
      { size: 16, color: MUTED, ref: 'accent4', lh: 1.55, role: 'body' }),
    rect('exp-hit', 784, 568, 400, 44, BG2, { ref: 'accent6', radius: 22, link: 'state-explore' }),
    text('exp-label', 808, 568, 360, 44, '→  Every measure on the site',
      { size: 15, weight: 700, family: MONO, valign: 'middle', lh: 1.3, ref: 'tx1' }),
    asOf('exp-asof', 96, 618, `Beta · DST families with a car, 2026 · ${EDITION} · Data as of ${ASOF}`),
  ],
});

// 12b — state: live explore --------------------------------------------------
slides.push({
  id: 'state-explore', stateOf: 'explore', transition: 'morph', name: 'Explore, live',
  background: CREAM, themeRefs: { background: 'bg1' },
  notes: 'The chart itself, live, so hovering a dot names the municipality. The horizontal axis is a dropdown: spending per resident, car ownership, population density, road casualties. The table underneath sorts on both measures. Worth opening in a browser tab when the room starts asking about one specific number.',
  elements: [
    title('Explore, live'),
    { ...base('explore-embed', 96, 176, 1088, 456), type: 'embed', app: 'web',
      url: `${ATLAS}/en/embed/udforsk?x=families_with_car_pct`, live: true,
      view: 'asset:view-explore' },
    text('exp-live-note', 96, 646, 1088, 28,
      'mobilitetsatlas.dk/en/udforsk  ·  hover a dot for the municipality  ·  ←  back',
      { size: 13, family: MONO, color: MUTED, ref: 'accent4', valign: 'middle', lh: 1.3,
        role: 'kicker' }),
    rect('exp-dismiss', 0, 640, 1280, 80, 'rgba(0,0,0,0)', { link: 'explore' }),
  ],
});

// 13 — byvisning -------------------------------------------------------------
slides.push({
  id: 'byvisning', background: CHARCOAL, transition: 'fade',
  themeRefs: { background: 'tx1' },
  notes: 'The last zoom level: København, street by street. Press Byvisning on any of the four largest municipalities and the map tilts into the buildings, with the day\'s scheduled services moving across it. Planned timetable, not live vehicles, and the panel says so. The green wash on the massing is the same A–G scale as the rest of the deck, now at building resolution. This is where a planner stops nodding at a national average and starts pointing at a street.',
  elements: [
    { ...base('by-embed', 96, 168, 1088, 434), type: 'embed', app: 'web',
      url: `${ATLAS_STAGING}/en/embed/kommune/koebenhavn?view=city&bare=1`
        + '&zoom=15.4&pitch=60&bearing=-20&lng=12.5750&lat=55.6810', live: true,
      view: 'asset:view-byvisning' },
    text('beta-title-h', 96, 72, 1088, 84, 'København, at street level',
      { size: 40, weight: 700, family: SERIF, color: CREAM, ref: 'bg1', valign: 'middle',
        lh: 1.1, role: 'title' }),
    text('by-note', 96, 618, 700, 56,
      'Live, and already at street level. Drag it, and the day\'s scheduled services keep moving across the buildings.',
      { size: 15, color: SUBTLE, ref: 'accent5', lh: 1.45, role: 'body' }),
    text('by-src', 812, 618, 372, 56, 'staging.mobilitetsatlas.dk<br>planned timetable · not live vehicles',
      { size: 13, family: MONO, color: SUBTLE, ref: 'accent5', align: 'right', lh: 1.5,
        role: 'kicker' }),
  ],
});

// 14 — what moves the grade --------------------------------------------------
const LEVERS = [
  ['Shorter travel times', 'to everyday destinations. The most direct lever there is.'],
  ['Fewer or faster interchanges', 'a connection saved counts twice: once each way.'],
  ['Service where there was none', 'the largest gains are at the bottom of the scale.'],
  ['Stops closer to housing', 'the walk to the stop is part of the journey time.'],
  ['Housing near destinations', 'urban development moves the grade as much as timetables do.'],
  ['New destinations', 'a school, a health centre, a grocery shop shortens the trip for every area around it.'],
];
slides.push({
  id: 'improve', background: CREAM, transition: 'morph',
  themeRefs: { background: 'bg1' },
  notes: 'The slide to leave on screen during questions. Two of these six are not transport measures at all: housing near destinations, and new destinations. That is the argument for having the planning department in the room when the timetable is discussed. The grade is recomputed each edition, so a change in service shows up in the letter.',
  elements: [
    title('What moves the grade'),
    ...LEVERS.flatMap(([head, body], i) => {
      const x = 96 + (i % 2) * 560;
      const y = 190 + Math.floor(i / 2) * 140;
      return [
        rect(`lev-${i}-bar`, x, y + 6, 4, 84, SAGE, { ref: 'accent1' }),
        text(`lev-${i}-h`, x + 24, y, 504, 34, head,
          { size: 21, weight: 700, lh: 1.25, ref: 'tx1', fx: { enter: 'fade-up', order: i } }),
        text(`lev-${i}-b`, x + 24, y + 40, 504, 56, body,
          { size: 16, color: MUTED, ref: 'accent4', lh: 1.5, role: 'body',
            fx: { enter: 'fade-up', order: i } }),
      ];
    }),
    asOf('improve-asof', 96, 604, 'Beta · mobilitetsatlas.dk/en/metode'),
    ...footer(),
  ],
});

// 15 — closing ---------------------------------------------------------------
slides.push({
  id: 'close', background: CREAM, transition: 'morph',
  themeRefs: { background: 'bg1' },
  notes: 'Three ways in: look up your own municipality tonight, send us the plans we have missed, or sit down with us and go through your grade cell by cell. The atlas is CC BY-SA. Take it, quote it, put it in your own papers.',
  elements: [
    ellipse('beta-orbit', 1000, 96, 120, 120, SAGE, { ref: 'accent1',
      fx: { loop: { type: 'motion-path', path: 'M0,0 C40,-30 80,30 0,60 C-60,80 -40,-40 0,0',
        duration: 14, ease: 'none' } } }),
    text('beta-title-h', 96, 252, 860, 130, 'Where would you like to start?',
      { size: 60, weight: 700, family: SERIF, lh: 1.05, role: 'title', ref: 'tx1' }),
    text('beta-title-sub', 96, 396, 800, 120,
      'Look up your municipality on mobilitetsatlas.dk · Send us the plans we have missed · Or go through your grade with us, cell by cell.',
      { size: 22, color: MUTED, ref: 'accent4', lh: 1.5, role: 'subtitle' }),
    text('close-licence', 96, 536, 800, 56,
      'Danmarks Mobilitetsatlas is published under CC BY-SA 4.0. Screenshot it, quote it, build on it, with credit to Beta Mobility.',
      { size: 15, color: SUBTLE, ref: 'accent5', lh: 1.5, role: 'body' }),
    text('beta-title-byline', 96, 620, 900, 28, '{{company}} · {{author}} · {{date}}',
      { size: 13, family: MONO, color: MUTED, ref: 'accent4', valign: 'middle', lh: 1.3,
        role: 'kicker' }),
  ],
});

// ---------------------------------------------------------------------------
// Assemble: keep the template's theme, fonts, faces and layouts; replace the
// document around them.
// ---------------------------------------------------------------------------
// TWO FILES, TWO JOBS. The theme, the three embedded faces and the six beta-*
// layouts are read from the TEMPLATE; the document is spliced into the SHELL.
// They are usually the same file, but the shell has to be one that carries
// `trustedFrameOrigins` (Beta v1.1+) or the live maps frame under the old
// sandbox and paint nothing — and a freshly built shell ships with an EMPTY
// document block, so it cannot be the source of the theme.
// The footer and as-of helpers are switched off and return [], and they are
// called unspread inside the element arrays. Flatten and drop the empties, so a
// disabled helper leaves nothing behind rather than an empty array where an
// element should be.
for (const slide of slides) slide.elements = slide.elements.flat().filter(Boolean);

const shell = readFileSync(
  join(HERE, existsSync(join(HERE, 'template-shell.bento.html'))
    ? 'template-shell.bento.html' : 'template.bento.html'), 'utf8');
const templateHtml = readFileSync(join(HERE, 'template.bento.html'), 'utf8');
const BLOCK = /(<script type="application\/bento\+json" id="bento-doc">)([\s\S]*?)(<\/script>)/;
const m = templateHtml.match(BLOCK);
if (!m?.[2]?.trim()) throw new Error('template.bento.html has no #bento-doc document to take the theme from');
const tpl = JSON.parse(m[2].replace(/\\u003c/g, '<'));

const doc = {
  format: 'bento/slides',
  version: 1,
  title: 'Danmarks Mobilitetsatlas — an introduction for municipalities',
  meta: {
    author: 'Robert Martin',
    company: 'Beta Mobility',
    subject: 'Danmarks Mobilitetsatlas',
    event: 'Introduction for municipalities',
    keywords: 'mobility, Denmark, municipalities, public transport, A–G grade',
  },
  size: tpl.size,
  theme: {
    ...tpl.theme,
    // The atlas's sanctioned data-viz accents, for chart series only. The base
    // palette is the template's (= the atlas's own tokens) and is untouched.
    chartPalette: [SAGE, '#2563EB', '#B45309', '#0D9488', '#475569'],
  },
  fonts: tpl.fonts,
  assets: {
    ...tpl.assets,
    'cover-map': dataUri('view-cover-s.jpeg'),
    'view-aarhus': svgView('view-aarhus-s.jpeg', 1500, 634),
    'view-explore': svgView('view-explore-s.jpeg', 1500, 745),
    'view-byvisning': svgView('view-byvisning-s.jpeg', 1500, 599),
  },
  beta: tpl.beta,
  layouts: tpl.layouts,
  slides,
};

const json = JSON.stringify(doc, null, 1).replace(/</g, '\\u003c');
if (json.includes('</script')) throw new Error('unescaped script close in the document block');
writeFileSync(OUT, shell.replace(BLOCK, (_all, open, _body, close) => open + '\n' + json + '\n' + close));

const linear = slides.filter((s) => !s.stateOf);
console.log(`wrote ${OUT}`);
console.log(`${linear.length} linear slides, ${slides.length - linear.length} state slides`);
console.log(`document block ${(json.length / 1024).toFixed(0)}KB, file ${(readFileSync(OUT).length / 1024 / 1024).toFixed(2)}MB`);
console.log('scatter series:', scatterSeries.map((s) => `${s.name}:${s.data.length}`).join(' '));
