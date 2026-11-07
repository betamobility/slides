#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// Beta merge rig: slides/src/beta/merge.ts folds a newer cloud version (an
// agent's splice, a colleague's save) into a tab with unsaved edits.
//
//   node scripts/test-beta-merge.ts
//
// The cases are the ones an agent's write can produce under the ownership
// rule (content edits by element id, native and runtime slide inserts) plus
// what a colleague's save can add (deletes, reorders, deck-level edits), each
// against a person's concurrent edits in the tab.

import { mergeCloudVersion } from '../slides/src/beta/merge.ts'

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const el = (id: string, html: string, extra: Record<string, unknown> = {}) => ({ id, type: 'text', x: 96, y: 80, w: 1000, h: 90, html, ...extra })
const slide = (id: string, ...elements: any[]) => ({ id, background: '#ffffff', elements })
const deck = (slides: any[], extra: Record<string, unknown> = {}): any => ({
  format: 'bento/slides', v: 1, docId: 'dddddddd-0000-4000-8000-000000000001', title: 'Deck', size: { w: 1280, h: 720 },
  collab: { v: 2, room: 'wROOM', key: 'secret', on: true }, slides, ...extra,
})
const ids = (d: any) => d.slides.map((s: any) => s.id).join(',')
const html = (d: any, s: string, e: string) => d.slides.find((x: any) => x.id === s)?.elements.find((x: any) => x.id === e)?.html

const base = deck([
  slide('s1', el('title', 'Title one'), el('body', 'Body one')),
  slide('s2', el('title', 'Title two'), el('body', 'Body two')),
  slide('s3', el('title', 'Title three')),
])

console.log('§1 an agent edits content while the person edits other content')
{
  const theirs = clone(base); theirs.slides[1].elements[1].html = 'Claude body two'
  const ours = clone(base); ours.slides[0].elements[0].html = 'Person title one'
  const r = mergeCloudVersion(base, ours, theirs)
  ok(html(r.doc, 's2', 'body') === 'Claude body two', "Claude's content edit lands")
  ok(html(r.doc, 's1', 'title') === 'Person title one', "the person's unsaved edit stays")
  ok(r.conflicts.length === 0 && r.changed, 'no conflict, and the merge changed something')
  ok(ids(r.doc) === 's1,s2,s3', 'slide order unchanged')
  ok(JSON.stringify(base) === JSON.stringify(deck(base.slides)), 'inputs are not modified')
}

console.log('\n§2 an agent inserts native slides (the merge-two-decks path)')
{
  const theirs = clone(base)
  theirs.slides.splice(1, 0, slide('n1', el('title', 'Inserted after s1')))
  theirs.slides.push(slide('n2', el('title', 'Inserted at end')))
  const ours = clone(base); ours.slides[2].elements[0].html = 'Person three'
  ours.slides.push(slide('p1', el('title', 'Person added this')))
  const r = mergeCloudVersion(base, ours, theirs)
  const order = r.doc.slides.map((s: any) => s.id) as string[]
  ok(order.includes('n1') && order.includes('n2') && order.includes('p1'), `both sides' new slides survive (${order.join(',')})`)
  ok(order.indexOf('n1') === 1, `Claude's slide sits right after s1, where it was inserted (${order.join(',')})`)
  ok(order.indexOf('s3') < order.indexOf('n2') && order.indexOf('s3') < order.indexOf('p1'), 'both end inserts land after s3')
  ok(html(r.doc, 's3', 'title') === 'Person three', "the person's edit on s3 stays")
  ok(html(r.doc, 'n1', 'title') === 'Inserted after s1', "the inserted slide's content is whole")
}

console.log('\n§3 both sides changed the same element: the person wins, and it is reported')
{
  const theirs = clone(base); theirs.slides[0].elements[1].html = 'Claude body one'
  const ours = clone(base); ours.slides[0].elements[1].html = 'Person body one'
  const r = mergeCloudVersion(base, ours, theirs)
  ok(html(r.doc, 's1', 'body') === 'Person body one', 'the text on screen (the person\'s) is kept')
  ok(!/Claude/.test(html(r.doc, 's1', 'body')), 'not interleaved token by token')
  ok(r.conflicts.length === 1 && r.conflicts[0].slideId === 's1' && r.conflicts[0].elementId === 'body' && r.conflicts[0].key === 'html', `the conflict names s1/body/html (${JSON.stringify(r.conflicts)})`)
  const same = clone(base); same.slides[0].elements[1].html = 'Agreed'
  const r2 = mergeCloudVersion(base, clone(same), clone(same))
  ok(r2.conflicts.length === 0 && html(r2.doc, 's1', 'body') === 'Agreed', 'the same edit on both sides is agreement, not a conflict')
}

console.log('\n§4 the person moved an element; Claude changed its text')
{
  const theirs = clone(base); theirs.slides[1].elements[0].html = 'Claude two'
  const ours = clone(base); ours.slides[1].elements[0].x = 400; ours.slides[1].elements[0].w = 600
  const r = mergeCloudVersion(base, ours, theirs)
  const e = r.doc.slides[1].elements[0] as any
  ok(e.html === 'Claude two' && e.x === 400 && e.w === 600, 'different properties of one element both land')
  ok(r.conflicts.length === 0, 'no conflict')
}

console.log('\n§5 a colleague deleted a slide the person did not touch; the person deleted one too')
{
  const theirs = clone(base); theirs.slides.splice(2, 1)
  const ours = clone(base); ours.slides.splice(0, 1)
  const r = mergeCloudVersion(base, ours, theirs)
  ok(ids(r.doc) === 's2', `both deletions hold (${ids(r.doc)})`)
}

console.log('\n§6 a colleague reordered slides while the person edited')
{
  const theirs = clone(base); theirs.slides = [theirs.slides[2], theirs.slides[0], theirs.slides[1]]
  const ours = clone(base); ours.slides[0].elements[0].html = 'Person one'
  const r = mergeCloudVersion(base, ours, theirs)
  ok(ids(r.doc) === 's3,s1,s2', `the new order lands (${ids(r.doc)})`)
  ok(html(r.doc, 's1', 'title') === 'Person one', 'with the edit')
}

console.log('\n§7 deck-level: title and assets')
{
  const theirs = clone(base); theirs.title = 'Claude title'; theirs.assets = { img1: { mime: 'image/png', data: 'data:image/png;base64,AAAA' } }
  theirs.slides[0].elements.push({ id: 'pic', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'asset:img1' })
  const ours = clone(base); ours.slides[1].elements[1].html = 'Person two'
  const r = mergeCloudVersion(base, ours, theirs) as any
  ok(r.doc.title === 'Claude title', 'a deck title change lands')
  ok(r.doc.assets?.img1?.data?.startsWith('data:image/png'), 'an asset the cloud added comes along')
  ok(r.doc.slides[0].elements.some((e: any) => e.id === 'pic' && e.src === 'asset:img1'), '…with the element that uses it')
  const ours2 = clone(base); ours2.title = 'Person title'
  const r2 = mergeCloudVersion(base, ours2, theirs)
  ok(r2.doc.title === 'Person title' && r2.conflicts.some((c) => c.slideId === null && c.key === 'title'), 'both renamed the deck: the person\'s title stays, reported as a deck-level conflict')
}

console.log('\n§8 identity')
{
  const theirs = clone(base); theirs.docId = 'something-else'; theirs.collab = { v: 2, room: 'wOTHER', key: 'x', on: true }
  theirs.slides[0].elements[0].html = 'x'
  const r = mergeCloudVersion(base, clone(base), theirs) as any
  ok(r.doc.docId === base.docId, 'the open deck keeps its docId')
  ok(r.doc.collab.room === 'wROOM' && r.doc.collab.key === 'secret', '…and its collab, never the cloud copy\'s')
  const r2 = mergeCloudVersion(base, clone(base), clone(base))
  ok(!r2.changed && r2.conflicts.length === 0, 'an identical cloud version changes nothing')
}

console.log('\n§9 runtime slide insert (a scene) with the person editing')
{
  const theirs = clone(base)
  theirs.slides.splice(2, 0, { id: 'scene1', background: '#000', elements: [{ id: 'still', type: 'image', x: 0, y: 0, w: 1280, h: 720, src: 'data:image/svg+xml,<svg/>' }], runtime: { app: 'html', src: '<p>hi</p>', steps: 1 } })
  const ours = clone(base); ours.slides[1].elements[1].html = 'Person two'
  const r = mergeCloudVersion(base, ours, theirs) as any
  const sc = r.doc.slides.find((s: any) => s.id === 'scene1')
  ok(!!sc && sc.runtime?.app === 'html', `the runtime slide arrives with its runtime record (${ids(r.doc)})`)
  ok(ids(r.doc) === 's1,s2,scene1,s3', 'in place')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
