#!/usr/bin/env node
// U1: actual template builder -> base86 shell -> publish stale-deck gate.
// node scripts/test-beta-merge-round6-templates.ts
// Only writes a temporary directory; does not rebuild or publish the shell.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'
import { decode } from './lib/b86.mjs'
import { readBlock, writeBlock } from '../plugins/beta-slides/scripts/lib/bento-doc.mjs'
import { embeddedShellDecks, staleEmbeddedDecks } from './lib/beta-shell-payload.mjs'
const shell = 'slides/dist-single/Bento_Slides.bento.html'
const carrier = readFileSync(shell, 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'beta-r6-templates-'))
const block = /(<script\b[^>]*type="bento\/deflate-b86"[^>]*>)([^<]+)(<\/script>)/g
function runtime(html: string) {
  const blocks = [...html.matchAll(block)]
  assert.equal(blocks.length, 2, 'read real CSS and JS payloads')
  const payloads = blocks.map(m => inflateRawSync(decode(m[2].trim())).toString())
  const js = payloads.find(p => p.includes('createElement') && p.includes('pptx'))!
  assert(js, 'decoded the exporter-carrying runtime')
  assert(!js.includes('import.meta'))
  assert.doesNotThrow(() => new Function(js))
  return js
}
try {
  // Failure first: absent payloads must never pass as mutually-current shells.
  const empty = join(dir, 'empty.html'); writeFileSync(empty, '<html></html>')
  assert.throws(() => staleEmbeddedDecks(empty, [empty]), /no runtime payload/)
  execFileSync(process.execPath, ['scripts/build-beta-templates.mjs', '--shell', shell, '--out', join(dir, 'templates')], { stdio: 'pipe' })
  const decks = embeddedShellDecks(dir)
  assert(decks.length >= 4, 'all Beta templates were actually built and enumerated')
  assert.deepEqual(staleEmbeddedDecks(shell, decks), [])
  const js = runtime(carrier)
  assert.throws(() => new Function(js + '\nvoid import.meta.url'), SyntaxError)
  for (const file of decks) {
    const html = readFileSync(file, 'utf8'), doc = readBlock(html)
    assert.equal(doc.template, true); assert(!doc.docId); assert(!doc.collab)
    assert(doc.slides.length); assert(doc.layouts.length); assert.equal(runtime(html), js)
    // Replacing only content cannot change the publish verdict, even with raw-tag text.
    const edited = writeBlock(html, { ...doc, title: '</script><script>sentinel</script>' })
    assert.equal(readBlock(edited).title, '</script><script>sentinel</script>')
    writeFileSync(file, edited)
    assert.deepEqual(staleEmbeddedDecks(shell, decks), [])
    // Mutating either payload must be noticed; catches JS-only fingerprints.
    for (const index of [0, 1]) {
      let i = 0
      writeFileSync(file, edited.replace(block, (_m, a, b, c) => a + (i++ === index ? b.slice(0, -1) : b) + c))
      assert.deepEqual(staleEmbeddedDecks(shell, decks), [file])
    }
    writeFileSync(file, edited)
  }
  assert.equal(decks.length, readdirSync('beta/templates').filter(f => f.endsWith('.bento.html')).length)
  console.log(`PASSED: ${decks.length} rebuilt templates retain the classic-script runtime; CSS/JS corruption and empty shell refused; document splice stays safe`)
} finally { rmSync(dir, { recursive: true, force: true }) }
