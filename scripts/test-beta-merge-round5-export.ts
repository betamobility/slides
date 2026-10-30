#!/usr/bin/env node
// Round 5: actual editor export handler and skill CLI, including mapper failure.
// slides/node_modules/.bin/esbuild scripts/test-beta-merge-round5-export.ts --bundle --platform=node --format=esm --outfile=/tmp/beta-merge-round5-export.mjs
// node /tmp/beta-merge-round5-export.mjs
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mapDeck } from '../slides/src/export/pptx.ts'
import { stripEmbeddedEnvelopes } from '../slides/src/envelope.ts'
import { defaultImage } from '../slides/src/model.ts'
const require = createRequire(process.cwd() + '/slides/package.json'), ts = require('typescript'), JSZip = require('jszip')
const src = readFileSync('slides/src/editor/editor.ts', 'utf8')
const ast = ts.createSourceFile('editor.ts', src, ts.ScriptTarget.Latest, true)
const cls = ast.statements.find((n: any) => ts.isClassDeclaration(n) && n.name.text === 'Editor')
const body = cls.members.find((n: any) => n.name?.getText(ast) === 'exportPptx').body.getText(ast)
const strip = ast.statements.find((n: any) => ts.isFunctionDeclaration(n) && n.name?.text === 'stripCollabSecrets').getText(ast)
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='
const template = readFileSync('beta/templates/general.bento.html', 'utf8')
const doc = JSON.parse(template.match(/id="bento-doc">\s*([\s\S]*?)\s*<\/script>/)![1])
delete doc.template
const originalCount = doc.slides.length
const still = defaultImage('asset:round5still')
doc.assets = { ...doc.assets, round5still: png, round5scene: 'data:text/html;base64,' + Buffer.from('<p>DO-NOT-EXPORT-SCENE-CODE</p>').toString('base64') }
doc.slides.push({ ...structuredClone(doc.slides[0]), id: 'round5scene', elements: [still], notes: 'Runtime speaker notes survive export', runtime: { src: 'asset:round5scene', still: 'asset:round5still', steps: 3, props: [] } })
doc.collab = { room: 'SECRET-ROOM', key: 'SECRET-KEY', ownerPriv: 'SECRET-OWNER' }
const pristine = JSON.stringify(doc)
let blob: Blob | undefined, clicked = 0, removed = 0, committed = false
const toasts: string[] = []
function handler(fail: boolean) {
  const deps = {
    stripEmbeddedEnvelopes,
    mapDeck: async (d: any, opts: any) => { assert(committed); assert.equal(d.collab, undefined); if (fail) throw new Error('round5 mapper refusal'); return mapDeck(d, opts) },
    rasterizeSvg: async () => png,
    URL: { createObjectURL(b: Blob) { blob = b; return 'blob:round5' }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() { clicked++ }, remove() { removed++ } }), body: { appendChild() {} } },
    fileBase: (s: string) => s, suggestedFileName: () => 'round5', setTimeout() {},
    t: (s: string, args: any) => s.replace('{msg}', args?.msg ?? ''), console: { error() {}, table() {} },
  }
  const js = ts.transpile(strip + '\nasync function run() ' + body, { target: ts.ScriptTarget.ES2022 })
  return new Function(...Object.keys(deps), js + ';return run')(...Object.values(deps))
}
// R7: the editor asks before writing; the rig answers through this stand-in
// and records what it was shown.
let asked: any[] | null = null, answer = true
const ctx = { store: { doc }, canvas: { commitTextEdit() { committed = true } }, toast: (s: string) => toasts.push(s), confirmPptxSimplifications: async (report: any[]) => { asked = report; return answer } }
// Failure first: no phantom download or success message when mapper rejects.
await handler(true).call(ctx)
assert.equal(clicked, 0); assert.equal(blob, undefined); assert.match(toasts.at(-1)!, /PPTX export failed: round5 mapper refusal/)
assert.equal(asked, null, 'a mapper failure never reaches the question')
// Cancel at the question: nothing is written.
answer = false
await handler(false).call(ctx)
assert(asked && asked.some((r: any) => r.reason === 'runtime' || r.reason === 'svg'), 'the question lists what PowerPoint simplifies, before writing')
assert.equal(clicked, 0); assert.equal(blob, undefined)
answer = true
await handler(false).call(ctx)
assert(blob); assert.equal(clicked, 1); assert.equal(removed, 1)
assert.equal(JSON.stringify(doc), pristine, 'export must leave live identity/content intact')
async function oracle(bytes: any) {
  const zip = await JSZip.loadAsync(bytes)
  const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  assert.equal(slides.length, originalCount + 1)
  assert.match(await zip.file(`ppt/slides/slide${originalCount + 1}.xml`).async('string'), /<p:pic>/)
  let notes = ''
  for (const name of Object.keys(zip.files).filter(n => n.endsWith('.xml'))) {
    const xml = await zip.file(name).async('string')
    assert(!xml.includes('SECRET-')); assert(!xml.includes('DO-NOT-EXPORT-SCENE-CODE'))
    if (name.startsWith('ppt/notesSlides/')) notes += xml
  }
  assert(notes.includes('Runtime speaker notes survive export'))
}
// Failing-first archive control ensures the oracle cannot pass empty/bad exports.
await assert.rejects(() => oracle(Buffer.from('not a pptx')))
await oracle(Buffer.from(await blob.arrayBuffer()))
const dir = mkdtempSync(join(tmpdir(), 'beta-merge-r5-export-'))
try {
  const deck = join(dir, 'round5.bento.html'), output = join(dir, 'round5.pptx')
  writeFileSync(deck, template.replace(/(<script type="application\/bento\+json" id="bento-doc">)[\s\S]*?(<\/script>)/, (_m, a, b) => a + JSON.stringify(doc).replace(/</g, '\\u003c') + b))
  execFileSync(process.execPath, ['scripts/export-pptx.mjs', deck, '--out', output], { stdio: 'pipe' })
  await oracle(readFileSync(output))
} finally { rmSync(dir, { recursive: true, force: true }) }
console.log('PASSED: editor and CLI export Beta template plus runtime still/notes; mapper failure reports honestly; no credentials or scene HTML in PPTX')
