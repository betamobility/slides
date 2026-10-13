#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// BETA FORK: a runtime slide's assets survive a save.
//
//   node scripts/test-beta-assets.ts
//
// WHAT THIS PROVES. Upstream prunes doc.assets at save time
// (slides/src/assets.ts, #442): every asset no ELEMENT refers to is dropped
// from the written file. A runtime slide's scene HTML (`runtime.src`) is named
// by the SLIDE, not by an element, and so is its still when the image element
// was removed. Without the fork's one hook in referencedAssetKeys the first
// save on a merged shell would delete every runtime slide's scene: the slide
// would open as its still and nothing else, with no error anywhere.
//
// (docs/plans/2026-10-13-2236-feat-upstream-merge-and-live-scenes-plan.md, U1,
// R23.)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pruneUnusedAssets, referencedAssetKeys } from '../slides/src/assets.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let checks = 0
let failures = 0
function ok(cond: unknown, what: string) {
  checks++
  if (!cond) failures++
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${what}`)
}

const el = (id: string, src: string) => ({ id, type: 'image', x: 0, y: 0, w: 1280, h: 720, rotation: 0, opacity: 1, src })
const doc = () => ({
  format: 'bento/slides', version: 1, docId: '00000000-0000-4000-8000-000000000001', title: 'Runtime deck',
  size: { width: 1280, height: 720 },
  assets: {
    'scene-html': 'data:text/html;base64,PHA+aGk8L3A+',
    'scene-still': 'data:image/svg+xml;base64,PHN2Zy8+',
    'only-the-record-names-it': 'data:image/svg+xml;base64,PHN2Zy8+',
    'layout-scene': 'data:text/html;base64,PHA+bGF5b3V0PC9wPg==',
    'photo': 'data:image/png;base64,AAAA',
    'orphan': 'data:image/png;base64,BBBB',
  },
  slides: [
    { id: 'cover', notes: '', elements: [el('p1', 'asset:photo')] },
    // the ordinary shape: the still is also the slide's full-bleed image element
    { id: 'live', notes: '', elements: [el('still', 'asset:scene-still')], runtime: { steps: 2, props: [], src: 'asset:scene-html', still: 'asset:scene-still' } },
    // a person deleted the image element; the record still names the still
    { id: 'bare', notes: '', elements: [], runtime: { steps: 0, props: [], src: 'asset:scene-html', still: 'asset:only-the-record-names-it' } },
    // a hosted scene has no src at all, and an inline (non-asset) value names nothing
    { id: 'hosted', notes: '', elements: [], runtime: { steps: 0, props: [], url: 'https://example.com/scene' } },
  ],
  layouts: [{ id: 'l1', notes: '', elements: [], runtime: { steps: 0, props: [], src: 'asset:layout-scene' } }],
}) as any

console.log('a runtime slide names assets no element does')
const used = referencedAssetKeys(doc())
ok(used.has('scene-html'), "the scene's HTML (runtime.src) counts as referenced")
ok(used.has('scene-still'), 'so does its still')
ok(used.has('only-the-record-names-it'), 'a still only the record names (its image element was deleted) is referenced too')
ok(used.has('layout-scene'), 'a layout is slide-shaped: its runtime record is walked as well')
ok(used.has('photo'), "an ordinary image's asset is still referenced (upstream's walk is intact)")
ok(!used.has('orphan'), 'and an asset nothing names is not')

console.log('\nwhat a save writes')
const before = doc()
const saved = pruneUnusedAssets(before)
ok(saved.assets['scene-html'] === before.assets['scene-html'], 'the saved deck keeps the scene HTML, byte for byte')
ok(saved.assets['scene-still'] === before.assets['scene-still'] && saved.assets['only-the-record-names-it'] !== undefined, 'and both stills')
ok(saved.assets['layout-scene'] !== undefined, "and a layout's scene")
ok(!('orphan' in saved.assets), 'an unreferenced asset is still pruned: the hook widens the walk, it does not switch pruning off')
ok('orphan' in before.assets, 'and the live document is not touched')
ok(JSON.stringify(saved.slides) === JSON.stringify(before.slides), 'no slide or runtime record changes in the saved copy')

console.log('\nthe save path goes through this walk, and the hook is marked')
const save = readFileSync(join(root, 'slides/src/save.ts'), 'utf8')
ok(/pruneUnusedAssets\(/.test(save), 'slides/src/save.ts prunes with pruneUnusedAssets, so the hook is on the path every save takes')
const assets = readFileSync(join(root, 'slides/src/assets.ts'), 'utf8')
ok(/BETA FORK[^\n]*\n[^\n]*runtime/.test(assets) || /runtime[^\n]*BETA FORK/.test(assets), 'the hook in slides/src/assets.ts carries the BETA FORK marker')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.log('\nA red here means the next save on this shell deletes the scene of every runtime slide in the deck.')
  process.exit(1)
}
