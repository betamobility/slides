#!/usr/bin/env node
// BETA FORK: U1 loader regression against the built bytes, not Vite config.
// node scripts/test-beta-merge-bundle.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { decode } from './lib/b86.mjs'
const shell = readFileSync('slides/dist-single/Bento_Slides.bento.html', 'utf8')
const blocks = [...shell.matchAll(/<script\b([^>]*type="bento\/deflate-b(64|86)"[^>]*)>([^<]+)<\/script>/g)]
assert(blocks.length >= 2, 'must inspect actual compressed payloads')
const payloads = blocks.map(m => inflateRawSync(m[2] === '86' ? decode(m[3].trim()) : Buffer.from(m[3].trim(), 'base64')).toString())
const runtime = payloads.find(s => s.includes('createElement') && s.includes('pptx'))
assert(runtime, 'the runtime carrying pptxgenjs was decoded')
assert(!runtime.includes('import.meta'), 'classic-script loader cannot parse import.meta')
assert.doesNotThrow(() => new Function(runtime), 'built runtime parses as a classic script')
// Failing-first negative control: the pre-fix Vite helper token is rejected.
assert.throws(() => new Function(runtime + '\nvoid import.meta.url'), SyntaxError)
console.log('PASSED: built runtime has no import.meta and parses as a classic script; negative control rejected')
