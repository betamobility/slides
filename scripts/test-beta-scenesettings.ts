#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Beta build: a scene's settings (slides/src/beta/scenesettings.ts).
//
//   slides/node_modules/.bin/esbuild scripts/test-beta-scenesettings.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-beta-scenesettings.mjs" \
//     && node --no-warnings "$TMPDIR/test-beta-scenesettings.mjs"
//
// WHAT THIS PROVES (2026-10-13-2236 plan, U10, KTD9, KTD10). The panel form,
// the gallery and the splice tool read and write a scene's settings through
// this one module, so its rules are the settings' rules:
//   1. the format hint grammar (bool, latlon, select, range), and that a hint
//      on the wrong kind, or one this build does not read, means the plain
//      control rather than an error;
//   2. a typed value is kept, held to its range with a note, or refused with
//      a note, never dropped in silence;
//   3. a preset sets every declared setting and nothing else, and the active
//      preset is recognised;
//   4. a web scene's settings are its address's query string: writing one
//      keeps the origin, path, fragment and every other parameter, starts from
//      the address as it is now, and a write that would make the address
//      longer than the shell keeps is refused.
// The form itself, undo and reader mode are scripts/test-beta-scenesettings-browser.mjs.

import type { RuntimeProp } from '../slides/src/model.ts'
import { isWebUrl } from '../slides/src/model.ts'
import * as ss from '../slides/src/beta/scenesettings.ts'

let failures = 0, checks = 0
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const props: RuntimeProp[] = [
  { key: 'place', label: 'Place', kind: 'text', default: 'Oslo' },
  { key: 'position', label: 'Position', kind: 'text', default: '59.9139, 10.7522', format: 'latlon' },
  { key: 'mode', label: 'Mode', kind: 'text', default: 'wide', format: 'select:wide|near' },
  { key: 'zoom', label: 'Zoom', kind: 'number', default: 5, format: 'range:2:9:1' },
  { key: 'grid', label: 'Grid', kind: 'number', default: 1, format: 'bool' },
  { key: 'accent', label: 'Accent', kind: 'color', default: '#C2410C' },
]
const P = (key: string) => props.find((p) => p.key === key)!

console.log('\nthe hint grammar')
{
  ok(same(ss.parseHint('bool', 'number'), { kind: 'bool' }) && same(ss.parseHint('latlon', 'text'), { kind: 'latlon' }), 'bool on a number, latlon on text')
  ok(same(ss.parseHint('select:a|b|c', 'text'), { kind: 'select', options: ['a', 'b', 'c'] }), 'select lists its options')
  ok(same(ss.parseHint('select:a||b|a', 'text'), { kind: 'select', options: ['a', 'b'] }), 'empty and repeated options are left out')
  ok(same(ss.parseHint('range:0.5:10:0.5', 'number'), { kind: 'range', min: 0.5, max: 10, step: 0.5, decimals: 1 }) && same(ss.parseHint('range:-5:5:1', 'number'), { kind: 'range', min: -5, max: 5, step: 1, decimals: 0 }), 'range reads min, max, step and the decimals it is written in')
  for (const [f, k, why] of [['bool', 'text', 'bool on text'], ['latlon', 'number', 'latlon on a number'], ['select:a', 'number', 'select on a number'], ['range:0:1:1', 'text', 'range on text'],
    ['range:5:1:1', 'number', 'a range whose min is not below its max'], ['range:0:1:0', 'number', 'a zero step'], ['range:a:b:c', 'number', 'a range that is not numbers'], ['select:', 'text', 'a select with no options'],
    ['colour', 'text', 'a hint this build does not read'], [undefined, 'text', 'no hint'], [7, 'number', 'a hint that is not text']] as [unknown, RuntimeProp['kind'], string][]) {
    ok(ss.parseHint(f, k) === null, `${why}: the plain control`)
  }
}

console.log('\nwhat a typed value becomes')
{
  ok(same(ss.coerce(P('zoom'), '7'), { value: 7 }), 'a number in range is kept')
  ok(same(ss.coerce(P('zoom'), 12), { value: 9, note: { says: 'Held at {value}: the scene allows {min} to {max}', value: 9, min: 2, max: 9 } }), 'past the top it is held at the top, and says so')
  ok(ss.coerce(P('zoom'), -3).value === 2 && !!ss.coerce(P('zoom'), -3).note, 'below the bottom, at the bottom')
  ok(ss.coerce(P('zoom'), 6.4).value === 6 && !!ss.coerce(P('zoom'), 6.4).note, 'between steps, on the nearest step')
  const half = { key: 'h', label: 'H', kind: 'number', default: 1, format: 'range:0.5:10:0.5' } as RuntimeProp
  ok(ss.coerce(half, '2,5').value === 2.5 && !ss.coerce(half, '2,5').note && ss.coerce(half, 0.1 + 0.2 + 2.2).value === 2.5, 'a decimal comma reads, and step arithmetic does not drift')
  ok(!('value' in ss.coerce(P('zoom'), 'seven')) && ss.coerce(P('zoom'), 'seven').note?.says === 'Not a number' && !('value' in ss.coerce(P('zoom'), '')), 'not a number is refused, with a note')
  ok(ss.coerce(P('grid'), true).value === 1 && ss.coerce(P('grid'), false).value === 0 && ss.coerce(P('grid'), '1').value === 1 && !('value' in ss.coerce(P('grid'), 3)), 'a bool is 1 or 0, nothing else')
  ok(same(ss.coerce(P('mode'), 'near'), { value: 'near' }) && ss.coerce(P('mode'), 'far').note?.says === 'Not one of the choices' && !('value' in ss.coerce(P('mode'), 'far')), 'a select takes one of its options and refuses the rest')
  ok(same(ss.coerce(P('position'), '55.6761, 12.5683'), { value: '55.6761, 12.5683' }) && ss.coerce(P('position'), '59,9 10,7').value === '59.9, 10.7', 'a position reads with a dot or a decimal comma')
  const pole = ss.coerce(P('position'), '95, 200')
  ok(pole.value === '90, 180' && pole.note?.says === 'Held at {value}: latitude is -90 to 90, longitude -180 to 180', 'a position off the globe is held at its edge, and says so')
  ok(!('value' in ss.coerce(P('position'), 'Oslo')) && !('value' in ss.coerce(P('position'), '1, 2, 3')) && !('value' in ss.coerce(P('position'), '1e3, 2')), 'something that is not latitude, longitude is refused')
  ok(ss.coerce(P('accent'), '#00FF00').value === '#00FF00' && ss.coerce(P('accent'), ' #00ff00 ').value === '#00ff00' && !('value' in ss.coerce(P('accent'), 'url(https://x/y)')), 'a colour is the gate\'s colour: trimmed, and never one that loads something')
  ok(ss.coerce(P('place'), 'Bergen').value === 'Bergen' && !('value' in ss.coerce(P('place'), 'x'.repeat(4001))) && ss.coerce(P('place'), 'x'.repeat(4001)).note?.says === 'Too long', 'plain text up to the gate\'s limit, refused past it')
}

console.log('\nvalues and presets')
{
  ok(same(ss.valuesOf(props, { zoom: 7, nope: 1 } as Record<string, ss.Value>), { place: 'Oslo', position: '59.9139, 10.7522', mode: 'wide', zoom: 7, grid: 1, accent: '#C2410C' }), 'current values: the chosen one or the default, and nothing undeclared')
  ok(ss.valuesOf(props, { zoom: 'seven' } as Record<string, ss.Value>).zoom === 5, 'a stored value of the wrong kind reads as the default')
  ok(ss.valuesOf(props, JSON.parse('{"__proto__": {"zoom": 8}}')).zoom === 5, 'a prototype key is not a value')
  const presets: ss.Preset[] = [{ name: 'Oslo', values: {} }, { name: 'Bergen', values: { place: 'Bergen', position: '60.39, 5.32', zoom: 6, extra: 'x' } }, { name: 'Wild', values: { zoom: 99, mode: 'far' } }]
  const bergen = ss.applyPreset(props, presets[1])
  ok(same(bergen, { place: 'Bergen', position: '60.39, 5.32', mode: 'wide', zoom: 6, grid: 1, accent: '#C2410C' }), 'a preset sets every declared setting: its own, and defaults for the rest')
  ok(!('extra' in bergen), 'and nothing it names that the scene does not declare')
  ok(same(ss.applyPreset(props, presets[2]), { place: 'Oslo', position: '59.9139, 10.7522', mode: 'wide', zoom: 9, grid: 1, accent: '#C2410C' }), 'a preset value outside its range is held; one that is not a choice falls back to the default')
  ok(ss.activePreset(props, {}, presets) === 'Oslo' && ss.activePreset(props, bergen, presets) === 'Bergen', 'the active preset is recognised')
  ok(ss.activePreset(props, { ...bergen, zoom: 7 }, presets) === null, 'one setting changed after a preset: custom')
}

console.log('\na web scene: settings in the page address')
{
  const base = 'https://slides.betamobility.ai/scenes/map/?zoom=4&theme=dark#top'
  ok(same(ss.readQuery(base, props), { place: 'Oslo', position: '59.9139, 10.7522', mode: 'wide', zoom: 4, grid: 1, accent: '#C2410C' }), 'the address\'s values, defaults for the rest; a parameter the scene does not declare is not a setting')
  // (changed after Codex round 2: the form shows what the page really gets)
  ok(ss.readQuery('https://x.test/?zoom=99', props).zoom === 99 && ss.readQuery('https://x.test/?mode=far', props).mode === 'far' && ss.readQuery('https://x.test/?zoom=abc', props).zoom === 5, 'a value in the address is shown as it is, even outside today\'s range or choices; one that is not of its kind is the default')
  ok(ss.readQuery('not a url', props).zoom === 5 && ss.readQuery(undefined, props).place === 'Oslo', 'no address, or not one: the defaults')
  const w = ss.writeQuery(base, 'place', 'Bergen & Co') as { url: string }
  const u = new URL(w.url), b = new URL(base)
  ok(u.origin === b.origin && u.pathname === b.pathname && u.hash === b.hash, `writing a setting keeps the origin, the path and the fragment (${w.url})`)
  ok(u.searchParams.get('place') === 'Bergen & Co' && u.searchParams.get('zoom') === '4' && u.searchParams.get('theme') === 'dark', 'sets that setting, encoded, and keeps every other parameter')
  // a colleague changed the zoom after the panel was drawn: the write starts from the address as it is now
  const remote = 'https://slides.betamobility.ai/scenes/map/?zoom=7&theme=dark#top'
  const after = new URL((ss.writeQuery(remote, 'place', 'Bergen') as { url: string }).url)
  ok(after.searchParams.get('zoom') === '7' && after.searchParams.get('place') === 'Bergen', 'a change made meanwhile to another setting is kept')
  const long = ss.writeQuery(base, 'place', 'x'.repeat(ss.MAX_WEB_URL))
  ok('error' in long && long.error === 'This makes the page address too long', 'a write that would make the address too long is refused, not left for the gate to drop')
  const fits = 'https://a.test/?' + 'k='.length
  const edge = ss.writeQuery('https://a.test/', 'k', 'x'.repeat(ss.MAX_WEB_URL - 'https://a.test/?k='.length))
  ok('url' in edge && edge.url.length === ss.MAX_WEB_URL && isWebUrl(edge.url), `an address of exactly the limit is written, and the shell keeps it (${fits.length})`)
  ok(!isWebUrl('https://a.test/?k=' + 'x'.repeat(ss.MAX_WEB_URL)), 'and one past it the shell would not: the limit is the shell\'s own')
  ok('error' in ss.writeQuery('javascript:alert(1)', 'k', 1) && 'error' in ss.writeQuery(undefined, 'k', 1), 'a write onto something that is not a web address is refused')
}

console.log('\na web scene\'s record')
{
  const rec = ss.webSceneOf({ library: { id: 'map', version: 2 }, props: [...props, { key: '__proto__', label: 'x', kind: 'text', default: '' }, { key: 'bad', kind: 'bool', default: true }, { key: 'zoom', label: 'Again', kind: 'number', default: 1 }] })
  ok(rec?.library.id === 'map' && rec.props.map((p) => p.key).join() === props.map((p) => p.key).join(), 'an embed\'s doc gives the scene\'s settings, the unusable ones left out')
  ok(rec?.props[3].format === 'range:2:9:1', 'with their hints')
  ok(ss.webSceneOf(null) === null && ss.webSceneOf({ props: [] }) === null && ss.webSceneOf({ library: { id: 'map' }, props: [] }) === null && ss.webSceneOf('map') === null, 'an embed that is not a library scene has none')
}

console.log('\nU10 independent adversarial regressions')
{
  const uneven: RuntimeProp = { key: 'n', label: 'N', kind: 'number', default: 0, format: 'range:0:10:3' }
  const above = ss.coerce(uneven, 10.1)
  ok(above.value === 10 && !!above.note,
    `U10 independent: out-of-range input clamps to the upper bound with an uneven step (got ${above.value}, expected 10)`)

  // Both the number and the format survive the runtime gate. A preset must
  // not silently erase precision that the scene explicitly declared.
  const tiny: RuntimeProp = { key: 'n', label: 'N', kind: 'number', default: 0, format: 'range:0:0.00000000009:0.00000000001' }
  const preset = ss.applyPreset([tiny], { name: 'Two steps', values: { n: 0.00000000002, extra: 42 } })
  ok(preset.n === 0.00000000002 && Object.keys(preset).join() === 'n',
    `U10 independent: preset preserves a declared sub-ten-decimal step and no extra key (got ${JSON.stringify(preset)})`)

  // checkRuntimeValue accepts numeric strings, so valuesOf must return the
  // normalised number, not the input string (checkboxes compare with === 1).
  const stored = ss.valuesOf([P('grid')], { grid: '1' })
  ok(stored.grid === 1 && ss.activePreset([P('grid')], stored, [{ name: 'On', values: { grid: 1 } }]) === 'On',
    `U10 independent: stored numeric bool agrees with its checkbox and active preset (got ${JSON.stringify(stored)})`)

  const address = 'https://user:pass@x.test:8443/a%2Fb?%70lace=Old&place=Older&keep=a%2Bb&keep=c#part%20one'
  const written = ss.writeQuery(address, 'place', 'Tromsø & 東京')
  const u = 'url' in written ? new URL(written.url) : null
  const before = new URL(address)
  ok(!!u && isWebUrl(u.href) && u.origin === before.origin && u.pathname === before.pathname
    && u.hash === before.hash && u.username === before.username && u.password === before.password
    && same(u.searchParams.getAll('place'), ['Tromsø & 東京']) && same(u.searchParams.getAll('keep'), ['a+b', 'c']),
    'U10 independent: encoded duplicate setting rewrites only that key and preserves address components')

  const inheritedNames: RuntimeProp[] = ['constructor', 'toString', 'hasOwnProperty'].map((key) => ({ key, label: key, kind: 'text', default: 'default' }))
  const applied = ss.applyPreset(inheritedNames, { name: 'Own keys', values: JSON.parse('{"constructor":"a","toString":"b","hasOwnProperty":"c","extra":"no"}') })
  ok(same(applied, { constructor: 'a', toString: 'b', hasOwnProperty: 'c' }),
    'U10 independent: preset writes every legal prototype-named key and no undeclared key')
}

console.log('\nU10 round 2 adversarial regressions')
{
  // Millisecond timestamps are finite, exactly representable integers. The
  // twelve-significant-digit repair must not erase a declared one-unit step.
  const timestamp: RuntimeProp = { key: 'time', label: 'Time', kind: 'number', default: 1700000000000,
    format: 'range:1700000000000:1700000000100:1' }
  const result = ss.applyPreset([timestamp], { name: 'One millisecond', values: { time: 1700000000001, extra: 3 } })
  ok(result.time === 1700000000001 && Object.keys(result).join() === 'time',
    `U10 round 2: preset preserves an exactly representable large-offset step (got ${JSON.stringify(result)})`)

  // The same older value is visible in a runtime select (controlFor even
  // inserts an option for it). Web settings must not silently claim the
  // default while the actual scene still receives mode=legacy in its URL.
  const mode: RuntimeProp = { key: 'mode', label: 'Mode', kind: 'text', default: 'wide', format: 'select:wide|near' }
  const old = ss.readQuery('https://slides.betamobility.ai/scenes/map/?mode=legacy', [mode])
  ok(old.mode === 'legacy' && ss.activePreset([mode], old, [{ name: 'Wide', values: { mode: 'wide' } }]) === null,
    `U10 round 2: web settings show a stored legacy choice instead of falsely activating a preset (got ${JSON.stringify(old)})`)

  // Unlike runtime.format, embed.doc is retained as plain JSON. The web
  // scene reader accepts this declaration; an overflowing numeric hint must
  // fall back or refuse, never manufacture NaN from a finite user input.
  const scene = ss.webSceneOf({ library: { id: 'huge-step', version: 1 }, props: [
    { key: 'n', label: 'N', kind: 'number', default: 0, format: `range:0:10:${'9'.repeat(309)}` },
  ] })!
  const held = ss.coerce(scene.props[0], 2)
  ok(held.value === undefined || (typeof held.value === 'number' && Number.isFinite(held.value)),
    `U10 round 2: overflowing range step refuses or yields a finite value (got ${String(held.value)})`)

  const remote = 'http://user:pass@slides.betamobility.ai:8080/other%2Fpath?place=Remote&zoom=8#section'
  const changed = ss.writeQuery(remote, 'place', 'Local')
  const u = 'url' in changed ? new URL(changed.url) : null
  const before = new URL(remote)
  ok(!!u && u.origin === before.origin && u.pathname === before.pathname && u.hash === before.hash
    && u.searchParams.get('zoom') === '8' && u.searchParams.get('place') === 'Local',
    'U10 round 2: a same-key local edit preserves the latest remote address and sibling setting')

  // Encoding, not the number of typed characters, determines the gate limit.
  const encoded = ss.writeQuery('https://slides.betamobility.ai/scenes/map/', 'place', '東京'.repeat(120))
  ok('error' in encoded && encoded.error === 'This makes the page address too long',
    'U10 round 2: URL limit counts percent-encoded Unicode bytes')
}

console.log('\nU10 round 3 adversarial regressions')
{
  // Decimal midpoint ties must use the same upward tie rule as Math.round;
  // binary division must not make 0.15 round down while 0.25 rounds up.
  const decimal: RuntimeProp = { key: 'n', label: 'N', kind: 'number', default: 0, format: 'range:0:1:0.1' }
  const midpoint = ss.coerce(decimal, '0.15')
  ok(midpoint.value === 0.2 && !!midpoint.note,
    `U10 round 3: decimal midpoint snapping is consistent (got ${midpoint.value}, expected 0.2)`)

  // Every bound and the desired value is a safe integer. Subtracting the
  // negative bound nevertheless leaves the safe-integer range before the
  // step is snapped. Rounding the final result's decimals cannot repair it.
  const offset: RuntimeProp = { key: 'n', label: 'N', kind: 'number', default: 0,
    format: 'range:-9007199254740991:100:1' }
  const applied = ss.applyPreset([offset], { name: 'Two', values: { n: 2, extra: 7 } })
  ok(applied.n === 2 && Object.keys(applied).join() === 'n',
    `U10 round 3: preset preserves an exact step across a large negative offset (got ${JSON.stringify(applied)})`)

  // All parsed operands are finite (unlike the round-2 non-finite bound).
  // The intermediate quotient overflows, so a small in-range input jumps
  // all the way to the maximum. Web doc.props keeps this valid JSON hint.
  const huge = '1' + '0'.repeat(308)
  const hugeScene = ss.webSceneOf({ library: { id: 'finite-range', version: 1 }, props: [
    { key: 'n', label: 'N', kind: 'number', default: 0, format: `range:0:${huge}:0.1` },
  ] })!
  const finiteInput = ss.coerce(hugeScene.props[0], 1e308 / 2)
  ok(finiteInput.value === 5e307,
    `U10 round 3: finite range arithmetic keeps an in-range step (got ${finiteInput.value}, expected 5e307)`)

  const remote = 'https://example.test/new%2Fpath?%6E=old&n=older&keep=a%2Bb&keep=c#remote'
  const changed = ss.writeQuery(remote, 'n', '東京')
  const u = 'url' in changed ? new URL(changed.url) : null
  const base = new URL(remote)
  ok(!!u && u.origin === base.origin && u.pathname === base.pathname && u.hash === base.hash
    && same(u.searchParams.getAll('n'), ['東京']) && same(u.searchParams.getAll('keep'), ['a+b', 'c']),
    'U10 round 3: latest remote URL retains its path, fragment and duplicate sibling keys')

  const prefix = 'https://example.test/?n='
  const fits = ss.writeQuery('https://example.test/', 'n', 'x'.repeat(ss.MAX_WEB_URL - prefix.length))
  const refused = ss.writeQuery('https://example.test/', 'n', 'x'.repeat(ss.MAX_WEB_URL - prefix.length + 1))
  ok('url' in fits && isWebUrl(fits.url) && 'error' in refused,
    'U10 round 3: adjacent URL lengths agree with the gate at the exact boundary')
}

console.log('\nU10 round 4 adversarial regressions')
{
  const tiny: RuntimeProp = { key: 'n', label: 'N', kind: 'number', default: 0,
    format: 'range:-0.00000000000000000002:0.00000000000000000002:0.00000000000000000001' }
  const low = ss.coerce(tiny, -1), high = ss.coerce(tiny, 1)
  ok(low.value === -2e-20 && high.value === 2e-20 && !!low.note && !!high.note
    && ss.coerce(tiny, -5e-21).value === 0 && ss.coerce(tiny, 5e-21).value === 1e-20,
    'U10 round 4: twenty-decimal bounds clamp with notes and signed midpoint ties go up')

  const choice: RuntimeProp = { key: 'mode', label: 'Mode', kind: 'text', default: 'New York',
    format: 'select:New York|東京| blå ' }
  const declared: RuntimeProp[] = [choice, { key: 'constructor', label: 'Constructor', kind: 'number', default: 3 }]
  const before = JSON.stringify(declared)
  const preset = ss.applyPreset(declared, { name: 'Unicode', values: { mode: '東京', constructor: 7, hidden: 'no' } })
  ok(same(preset, { mode: '東京', constructor: 7 }) && JSON.stringify(declared) === before
    && ss.coerce(choice, ' blå ').value === ' blå ' && ss.coerce(choice, 'New York').value === 'New York',
    'U10 round 4: Unicode and spaced preset choices preserve exactly the declared keys')

  const remote = 'http://user:pass@example.test:8080/new%2Fpath?%6Dode=old&mode=older&keep=a%2Bb&keep=c#new'
  const changed = ss.writeQuery(remote, 'mode', 'New York 東京')
  const base = new URL(remote), url = 'url' in changed ? new URL(changed.url) : null
  ok(!!url && url.origin === base.origin && url.pathname === base.pathname && url.hash === base.hash
    && url.username === base.username && url.password === base.password
    && same(url.searchParams.getAll('mode'), ['New York 東京']) && same(url.searchParams.getAll('keep'), ['a+b', 'c']),
    'U10 round 4: encoded duplicate target rewrites preserve remote address and duplicate siblings')

  const prefix = 'https://example.test/?mode='
  const old = prefix + 'x'.repeat(ss.MAX_WEB_URL - prefix.length)
  const refused = ss.writeQuery(old, 'mode', '東京'.repeat(120))
  const fits = ss.writeQueryAll(old, { mode: 'New York 東京' })
  ok('error' in refused && 'url' in fits && isWebUrl(fits.url)
    && new URL(fits.url).searchParams.get('mode') === 'New York 東京',
    'U10 round 4: encoded expansion refuses while an atomic shorter replacement fits')

  const original = { n: 99, mode: 'retired' }
  const legacyProps: RuntimeProp[] = [{ key: 'n', label: 'N', kind: 'number', default: 3, format: 'range:0:10:1' }, choice]
  ok(same(ss.valuesOf(legacyProps, original), original)
    && same(ss.readQuery('https://example.test/?n=99&mode=retired', legacyProps), original)
    && ss.activePreset(legacyProps, original, [{ name: 'Default', values: {} }]) === null,
    'U10 round 4: legacy out-of-range values stay visible and never falsely select the default preset')
}

console.log('\nU10 round 5 adversarial regressions')
{
  // An out-of-range finite input must clamp before any enormous quotient is
  // calculated, including a negative bound and a twenty-decimal step.
  const narrow: RuntimeProp = { key: 'n', label: 'N', kind: 'number', default: 0,
    format: 'range:-0.00000000000000000003:0.00000000000000000007:0.00000000000000000002' }
  const low = ss.coerce(narrow, -Number.MAX_VALUE), high = ss.coerce(narrow, Number.MAX_VALUE)
  ok(low.value === -3e-20 && high.value === 7e-20 && !!low.note && !!high.note
    && ss.coerce(narrow, Number.MIN_VALUE).value === 1e-20,
    'U10 round 5: extreme finite inputs clamp and a subnormal input snaps above the signed midpoint')

  const declared: RuntimeProp[] = [
    { key: 'constructor', label: 'Constructor', kind: 'text', default: 'default' },
    { key: 'n', label: 'N', kind: 'number', default: 4, format: 'range:-2:8:2' },
    { key: 'mode', label: 'Mode', kind: 'text', default: '東京', format: 'select:東京|New York' },
  ]
  const inherited = Object.assign(Object.create({ constructor: 'inherited', n: 8 }), { mode: 'New York', extra: 'discard' })
  const before = JSON.stringify(declared)
  const applied = ss.applyPreset(declared, { name: 'Own only', values: inherited })
  ok(same(applied, { constructor: 'default', n: 4, mode: 'New York' }) && JSON.stringify(declared) === before,
    'U10 round 5: preset ignores inherited values, fills every declared default, and leaves the schema untouched')

  const remote = 'http://u:p@example.test:8080/new%2Fpath?place=Remote&keep=a%2Bb&keep=c#東京'
  const changed = ss.writeQuery(remote, 'place', 'Local + & 東京')
  const u = 'url' in changed ? new URL(changed.url) : null, base = new URL(remote)
  ok(!!u && u.origin === base.origin && u.pathname === base.pathname && u.hash === base.hash
    && u.username === base.username && u.password === base.password
    && u.searchParams.get('place') === 'Local + & 東京' && same(u.searchParams.getAll('keep'), ['a+b', 'c'])
    && ss.readQuery(u.href, [P('place')]).place === 'Local + & 東京',
    'U10 round 5: latest same-key remote URL preserves address components and round-trips reserved Unicode text')

  // Replacing one ASCII character with é grows its serialized query value by
  // five characters. Measure the completed address, including its fragment.
  const prefix = 'https://example.test/?keep=1&place=', fragment = '#tail'
  const old = prefix + 'x'.repeat(ss.MAX_WEB_URL - prefix.length - fragment.length - 5) + fragment
  const oldValue = new URL(old).searchParams.get('place')!
  const fits = ss.writeQuery(old, 'place', oldValue.slice(0, -1) + 'é')
  const over = ss.writeQuery(old, 'place', oldValue + 'é')
  ok('url' in fits && fits.url.length === ss.MAX_WEB_URL && isWebUrl(fits.url)
    && 'error' in over && over.error === 'This makes the page address too long',
    'U10 round 5: encoded replacement fits exactly at URL limit and one extra character refuses')

  const emoji = '😀'.repeat(2000)
  ok(ss.coerce(P('place'), emoji).value === emoji
    && ss.coerce(P('place'), emoji + 'x').value === undefined
    && ss.coerce(P('place'), emoji + 'x').note?.says === 'Too long',
    'U10 round 5: text refusal counts UTF-16 units at the gate boundary')
}

console.log('\nU10 round 5: what a native slider can show')
{
  ok(ss.onStep('range:0:10:3', 9) && !ss.onStep('range:0:10:3', 10) && ss.onStep('range:0:1:0.1', 0.3) && !ss.onStep('range:0:1:0.1', 0.35),
    'onStep is exact on decimal steps (0.3 on a 0.1 step is on it)')
  ok(ss.onStep('range:-9007199254740991:100:1', 2) && !ss.onStep('range:0:10:1', -1) && !ss.onStep('range:0:10:1', Number.NaN),
    'onStep survives a large negative offset; below min or not a number is off it')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
