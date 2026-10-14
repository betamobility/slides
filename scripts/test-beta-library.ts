#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Beta build: the scene library's manifest (scripts/lib/beta-library.mjs,
// scripts/build-beta-library.mjs, beta/library/).
//
//   node scripts/test-beta-library.ts
//
// WHAT THIS PROVES (2026-10-13-2236 plan, U8, KTD8, KTD13, KTD14). The
// manifest is generated from folders, never written by hand, and it is the one
// thing the gallery, the skill and the splice tool will read. So the build
// has to refuse what none of them could use, and say which file is at fault:
//   1. the two seed scenes build, with ids, versions, defaults and presets;
//   2. a still over 64 KB, or one that is not a plain picture, fails naming
//      the file;
//   3. a web scene whose url is not https, or whose host Beta does not
//      control, fails naming the host;
//   4. settings and presets are held to the shell's own rules, so a scene that
//      builds is one a deck can carry;
//   5. the manifest's bytes are stable and inert;
//   6. the command: --check writes and uploads nothing; --upload refuses
//      without the service token, and with it sends exactly the manifest to
//      PUT /api/harness/library.json.
// That the store accepts it and serves it to the right three readers is
// server/deck-store/test/worker.test.mjs (scripts/test-beta-store.ts).

import { spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as lib from './lib/beta-library.mjs'

let failures = 0, checks = 0
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`) }
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const script = join(root, 'scripts/build-beta-library.mjs')

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9" fill="#fff"/></svg>'
const HTML = '<!doctype html><script>addEventListener("message",function(e){if(e.data.type==="bento:init"){}});parent.postMessage({type:"bento:ready"},"*")</' + 'script>'
const scene = (over: Record<string, unknown> = {}) => JSON.stringify({
  name: 'Sample', version: 1, steps: 1,
  props: [{ key: 'title', label: 'Title', kind: 'text', default: 'Hello' }, { key: 'n', label: 'N', kind: 'number', default: 3, format: 'range:0:10:1' }, { key: 'ink', label: 'Ink', kind: 'color', default: '#112233' }],
  presets: [{ name: 'Default', values: {} }, { name: 'Loud', values: { title: 'HELLO', n: 9 } }],
  ...over,
})
const files = (over: Record<string, string | undefined> = {}, json: Record<string, unknown> = {}) => {
  const f: Record<string, string | undefined> = { 'scene.json': scene(json), 'index.html': HTML, 'still.svg': SVG, ...over }
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k]
  return f as Record<string, string>
}
/** The refusal for these inputs, or '' when the scene builds. */
const refusal = (f: Record<string, string>, id = 'sample'): string => {
  try { lib.validateScene(id, f); return '' } catch (e) { if (e instanceof lib.LibraryError) return e.message; throw e }
}
const refused = (f: Record<string, string>, ...words: string[]) => { const m = refusal(f); return !!m && words.every((w) => m.includes(w)) }

console.log('\nthe seed scenes')
{
  const m = lib.buildManifest(join(root, 'beta/library'))
  ok(m.format === 'beta/library' && m.v === 1, 'the manifest says what it is')
  ok(m.scenes.map((s: { id: string; version: number }) => `${s.id}@${s.version}`).join(',') === 'counter@1,map@1', `it lists both seed scenes, sorted, with ids and versions (${m.scenes.map((s: { id: string }) => s.id)})`)
  for (const s of m.scenes) {
    ok(s.kind === 'runtime' && typeof s.html === 'string' && s.html.includes('bento:ready') && s.html.includes('bento:init'), `${s.id}: a runtime scene with its page inlined, speaking the scene contract`)
    ok(typeof s.still === 'string' && s.still.includes('<svg') && s.stillType === 'image/svg+xml' && Buffer.byteLength(s.still) <= 64 * 1024, `${s.id}: its still inlined, an SVG under 64 KB (${Buffer.byteLength(s.still)} bytes)`)
    ok(s.props.length > 0 && s.props.every((p: { default: unknown; label: string }) => p.default !== undefined && !!p.label), `${s.id}: every setting has a label and a default`)
    ok(s.presets.length >= 1 && Object.keys(s.presets[0].values).length === 0, `${s.id}: the first preset is the defaults`)
    ok(Number.isInteger(s.steps) && typeof s.name === 'string' && typeof s.description === 'string', `${s.id}: name, description and steps`)
    // the page must run with no network: nothing in it may point at another host
    ok(!/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i.test(s.html) && !/\bfetch\s*\(|XMLHttpRequest|WebSocket|import\s*\(/.test(s.html), `${s.id}: the page loads nothing from anywhere`)
  }
  const map = m.scenes.find((s: { id: string }) => s.id === 'map'), counter = m.scenes.find((s: { id: string }) => s.id === 'counter')
  ok(map.props.some((p: { format?: string }) => p.format === 'latlon') && counter.props.some((p: { format?: string }) => p.format === 'bool') && counter.props.some((p: { format?: string }) => /^range:/.test(p.format ?? '')),
    'between them the seeds carry a latlon, a bool and a range hint, on kinds the shipped shell knows')
  ok(m.scenes.every((s: { props: { kind: string }[] }) => s.props.every((p) => ['text', 'number', 'color'].includes(p.kind))), 'and no setting kind an older shell would strip')
  ok(lib.manifestShape(m) === true, 'the manifest passes the shape check the store applies')
  ok(lib.serialize(m) === lib.serialize(lib.buildManifest(join(root, 'beta/library'))), 'two builds give the same bytes')
  ok(!lib.serialize(m).includes('<') && lib.serialize(m).endsWith('\n') && JSON.stringify(JSON.parse(lib.serialize(m))) === JSON.stringify(m), 'the bytes carry no "<" and parse back to the same manifest')
}

console.log('\na scene that builds')
{
  const s = lib.validateScene('sample', files())
  ok(s.id === 'sample' && s.kind === 'runtime' && s.steps === 1 && s.html === HTML && s.still === SVG, 'a well-formed folder becomes a manifest entry with its files as text')
  ok(JSON.stringify(s.props[1]) === JSON.stringify({ key: 'n', label: 'N', kind: 'number', default: 3, format: 'range:0:10:1' }), 'a format hint is carried as written')
  ok(!('format' in s.props[0]), 'and absent where the folder has none')
  ok(JSON.stringify(s.presets[1]) === JSON.stringify({ name: 'Loud', values: { title: 'HELLO', n: 9 } }), 'a preset keeps only what it sets')
}

console.log('\nthe still')
{
  ok(refused(files({ 'still.svg': SVG.replace('</svg>', '<!--' + 'x'.repeat(64 * 1024) + '--></svg>') }), 'beta/library/sample/still.svg', '64 KB'), 'a still over 64 KB fails the build naming the file')
  ok(refusal(files({ 'still.svg': SVG.replace('</svg>', '<!--' + 'x'.repeat(64 * 1024 - SVG.length - 7) + '--></svg>') })) === '', 'one at exactly 64 KB builds')
  ok(refused(files({ 'still.svg': undefined }), 'still.svg', 'missing'), 'a missing still fails naming the file')
  ok(refused(files({ 'still.svg': '<html><svg/></html>' }), 'still.svg', 'not an SVG'), 'a still that is not an SVG document fails')
  for (const [bad, what] of [
    ['<script>alert(1)</' + 'script>', 'a script'], ['<foreignObject><p>x</p></foreignObject>', 'a foreignObject'],
    ['<rect onload="x()"/>', 'a handler'], ['<image href="https://example.com/x.png"/>', 'a remote image'], ['<a href="javascript:x()"><rect/></a>', 'a javascript link'],
  ]) ok(refused(files({ 'still.svg': SVG.replace('</svg>', bad + '</svg>') }), 'still.svg', 'a still is a picture'), `a still carrying ${what} fails`)
  ok(refusal(files({ 'still.svg': SVG.replace('<rect', '<linearGradient id="g"/><rect fill="url(#g)"') })) === '', 'a gradient referenced inside the file is still a picture')
}

console.log('\na web scene')
{
  const web = (url: unknown, over: Record<string, string | undefined> = {}) => files({ 'index.html': undefined, ...over }, { kind: 'web', url })
  const s = lib.validateScene('sample', web('https://slides.betamobility.ai/scenes/x?a=1'))
  ok(s.kind === 'web' && s.url === 'https://slides.betamobility.ai/scenes/x?a=1' && s.view === SVG && !('html' in s), 'an https url on a Beta host builds, with its still as the view and no page')
  ok(refused(web('http://slides.betamobility.ai/x'), 'https', 'slides.betamobility.ai'), 'a url that is not https fails naming the host')
  ok(refused(web('https://example.com/x'), 'example.com', 'not one Beta controls'), 'a host off the allowlist fails naming the host')
  for (const [url, why] of [
    ['https://slides.betamobility.ai.example.com/x', 'a look-alike suffix'], ['https://evil.betamobility.ai/x', 'a subdomain not on the list'],
    ['https://slides.betamobility.ai:8443/x', 'another port'], ['https://user:pw@slides.betamobility.ai/x', 'a login in the url'],
    ['https://slides.betamobility.ai@example.com/x', 'a host hidden behind an @'], ['//slides.betamobility.ai/x', 'no scheme'],
    ['javascript:alert(1)', 'a javascript url'], ['', 'an empty url'], [undefined, 'no url'], [7, 'a number'],
  ] as [unknown, string][]) ok(refusal(web(url)) !== '', `${why} fails (${JSON.stringify(url)})`)
  ok(refused(web('https://slides.betamobility.ai/x', { 'index.html': HTML }), 'index.html', 'web scene has no page'), 'a web scene with an index.html fails')
  ok(refused(files({}, { url: 'https://slides.betamobility.ai/x' }), 'only a web scene has a url'), 'a runtime scene with a url fails')
  ok(lib.WEB_HOSTS.every((h: string) => /^[a-z0-9-]+\.betamobility\.ai$/.test(h)), `the allowlist is exact Beta hosts (${lib.WEB_HOSTS.join(', ')})`)
}

console.log('\nthe page')
{
  ok(refused(files({ 'index.html': undefined }), 'index.html', 'missing'), 'a runtime scene with no page fails naming the file')
  ok(refused(files({ 'index.html': HTML + '<!--' + 'x'.repeat(256 * 1024) + '-->' }), 'index.html', '256 KB'), 'a page over 256 KB fails naming the file')
  ok(refused(files({ 'index.html': '<p>static</p>' }), 'index.html', 'bento:init'), 'a page that never mentions the scene contract fails')
}

console.log('\nscene.json')
{
  ok(refused(files({ 'scene.json': undefined }), 'scene.json', 'missing'), 'missing')
  ok(refused(files({ 'scene.json': '{' }), 'scene.json', 'does not parse'), 'not JSON')
  ok(refused(files({ 'scene.json': '[]' }), 'must be an object'), 'not an object')
  const bad = (over: Record<string, unknown>, ...words: string[]) => refused(files({}, over), 'scene.json', ...words)
  ok(bad({ name: '' }, 'name') && bad({ name: 'x'.repeat(81) }, 'name') && bad({ name: 7 }, 'name'), 'a name of 1 to 80 characters')
  ok(bad({ version: 0 }, 'version') && bad({ version: 1.5 }, 'version') && bad({ version: '1' }, 'version') && bad({ version: undefined }, 'version'), 'a whole-number version from 1')
  ok(bad({ kind: 'script' }, 'kind') && bad({ steps: -1 }, 'steps') && bad({ steps: 10001 }, 'steps') && bad({ description: 'x'.repeat(201) }, 'description'), 'kind, steps and description are held to their ranges')
  ok(bad({ insertAfter: 'end' }, 'does not know', 'insertAfter') && bad({ html: '<p>' }, 'does not know'), 'a key the build does not know fails, naming it')
  const prop = (p: unknown) => ({ props: [p], presets: [{ name: 'D', values: {} }] })
  ok(bad(prop({ key: '__proto__', label: 'x', kind: 'text', default: '' }), 'prop key') && bad(prop({ key: '1x', label: 'x', kind: 'text', default: '' }), 'prop key') && bad(prop(null), 'prop key'), 'a setting key is a plain identifier')
  ok(bad({ props: [{ key: 'a', label: 'A', kind: 'text', default: '' }, { key: 'a', label: 'A', kind: 'text', default: '' }], presets: [{ name: 'D' }] }, 'repeated'), 'and not repeated')
  ok(bad(prop({ key: 'a', label: 'A', kind: 'bool', default: true }), 'kind must be text, number or color'), 'a kind the shell does not know fails: it rides on text or number with a format hint')
  ok(bad(prop({ key: 'a', kind: 'text', default: '' }), 'label') && bad(prop({ key: 'a', label: 'A', kind: 'number', default: '3' }), 'default') && bad(prop({ key: 'a', label: 'A', kind: 'number' }), 'default'), 'a label and a default of the right kind are required')
  ok(bad(prop({ key: 'a', label: 'A', kind: 'color', default: 'url(https://x/y)' }), 'default') && bad(prop({ key: 'a', label: 'A', kind: 'number', default: Number.NaN }), 'default'), 'a colour that reaches out, or a number that is not one, fails')
  ok(bad(prop({ key: 'a', label: 'A', kind: 'text', default: '', format: 'a\nb' }), 'format') && bad(prop({ key: 'a', label: 'A', kind: 'text', default: '', format: '' }), 'format') && bad(prop({ key: 'a', label: 'A', kind: 'text', default: '', format: 7 }), 'format'), 'a format hint is one printable line')
  ok(bad(prop({ key: 'a', label: 'A', kind: 'text', default: '', onchange: 'x' }), 'does not know'), 'a setting key the build does not know fails')
  ok(bad({ presets: [] }, 'presets') && bad({ presets: undefined }, 'presets') && bad({ presets: Array.from({ length: 25 }, (_, i) => ({ name: 'p' + i })) }, 'presets'), 'there is at least one preset and at most 24')
  ok(bad({ presets: [{ name: 'A' }, { name: 'A' }] }, 'preset name') && bad({ presets: [{ name: '' }] }, 'preset name'), 'preset names are distinct and not empty')
  ok(bad({ presets: [{ name: 'A', values: { nope: 1 } }] }, 'not one of the scene\'s props') && bad({ presets: [{ name: 'A', values: { n: 'nine' } }] }, 'not a valid number') && bad({ presets: [{ name: 'A', values: [] }] }, 'values'), 'a preset sets only declared settings, to values of their kind')
  ok(bad({ presets: [{ name: 'A', values: {}, url: 'x' }] }, 'does not know'), 'a preset key the build does not know fails')
  for (const id of ['Sample', '1map', 'a_b', '', 'x'.repeat(41), '../x']) ok(refusal(files(), id) !== '', `a folder named ${JSON.stringify(id)} is refused`)
}

console.log('\nfolders on disk, and the manifest as a whole')
{
  const dir = mkdtempSync(join(tmpdir(), 'beta-library-'))
  const put = (id: string, f: Record<string, string>) => { mkdirSync(join(dir, id), { recursive: true }); for (const [n, t] of Object.entries(f)) writeFileSync(join(dir, id, n), t) }
  const tryBuild = (): string => { try { lib.buildManifest(dir); return '' } catch (e) { return (e as Error).message } }
  ok(tryBuild().includes('no scene folder'), 'an empty library fails')
  put('b-scene', files()); put('a-scene', files())
  writeFileSync(join(dir, 'README.md'), '# notes'); mkdirSync(join(dir, '.out')); writeFileSync(join(dir, '.out', 'library.json'), '{}')
  const m = lib.buildManifest(dir)
  ok(m.scenes.map((s: { id: string }) => s.id).join(',') === 'a-scene,b-scene', 'folders are read in id order; a README beside them and the generated .out are not scenes')
  put('a-scene', { 'notes.txt': 'x' })
  ok(tryBuild().includes('beta/library/a-scene/notes.txt') && tryBuild().includes('nothing else'), 'a file that is not part of a scene fails the build naming it: nothing rides along unseen')
  let msg = ''
  try { lib.manifestOf([lib.validateScene('same', files()), lib.validateScene('same', files())]) } catch (e) { msg = (e as Error).message }
  ok(msg.includes('share this id'), 'two scenes with one id are refused')
  ok(!lib.manifestShape({ format: 'beta/library', v: 1 }) && !lib.manifestShape(null) && !lib.manifestShape({ format: 'beta/library', v: 1, scenes: [{ id: 'A', version: 1, kind: 'runtime' }] }), 'the shape check refuses what is not a manifest')

  console.log('\nthe command')
  const run = (args: string[], env: Record<string, string | undefined> = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, CF_ACCESS_CLIENT_ID: undefined, CF_ACCESS_CLIENT_SECRET: undefined, SLIDES_STORE_URL: undefined, ...env } as NodeJS.ProcessEnv })
  const out = join(dir, 'out', 'library.json')
  let r = run(['--check', '--out', out])
  ok(r.status === 0 && /2 scenes/.test(r.stdout) && r.stdout.includes('counter') && r.stdout.includes('map') && !existsSync(out), `--check validates the real library, lists it and writes nothing (${r.status})`)
  r = run(['--out', out])
  ok(r.status === 0 && existsSync(out) && readFileSync(out, 'utf8') === lib.serialize(lib.buildManifest(join(root, 'beta/library'))), 'without --check it writes the manifest where asked')
  r = run(['--check', '--dir', dir])
  ok(r.status === 1 && r.stderr.includes('beta/library/a-scene/notes.txt') && r.stdout === '', `a library that does not validate exits 1 naming the file (${r.status})`)
  r = run(['--chekc'])
  ok(r.status === 2 && r.stderr.includes('unknown argument'), 'a misspelt flag is refused, not ignored')
  r = run(['--upload', '--out', out])
  ok(r.status === 1 && r.stderr.includes('CF_ACCESS_CLIENT_ID') && r.stderr.includes('nothing was uploaded'), '--upload with no service token refuses')
  r = run(['--upload', '--out', out], { CF_ACCESS_CLIENT_ID: 'id.access' })
  ok(r.status === 1 && r.stderr.includes('nothing was uploaded'), 'and with half of one')
  ok(readFileSync(join(root, '.gitignore'), 'utf8').split('\n').includes('beta/library/.out/'), 'the generated manifest is ignored by git')
  const ignored = spawnSync('git', ['-C', root, 'ls-files', 'beta/library/.out'], { encoding: 'utf8' })
  ok(ignored.stdout.trim() === '', 'and none is committed')

  // a stand-in store: what does the upload send?
  const seen: { method?: string; url?: string; headers: Record<string, unknown>; body: string }[] = []
  let answer = 200
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      res.writeHead(answer, answer === 200 ? { etag: '"abc"' } : {}); res.end(answer === 400 ? 'shape' : '')
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const store = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const upload = (env: Record<string, string>) => new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const c = spawn(process.execPath, [script, '--upload', '--out', out], { env: { ...process.env, CF_ACCESS_CLIENT_ID: 'id.access', CF_ACCESS_CLIENT_SECRET: 'shhh', SLIDES_STORE_URL: store + '/', ...env } })
    let stdout = '', stderr = ''
    c.stdout.on('data', (d) => { stdout += d }); c.stderr.on('data', (d) => { stderr += d })
    c.on('close', (status) => done({ status, stdout, stderr }))
  })
  let u = await upload({})
  const sent = seen[0]
  ok(u.status === 0 && seen.length === 1 && sent.method === 'PUT' && sent.url === '/api/harness/library.json', `--upload with the token PUTs to /api/harness/library.json (${sent?.method} ${sent?.url})`)
  ok(sent?.body === lib.serialize(lib.buildManifest(join(root, 'beta/library'))) && sent.headers['content-type'] === 'application/json', 'exactly the manifest, as JSON')
  ok(sent?.headers['cf-access-client-id'] === 'id.access' && sent.headers['cf-access-client-secret'] === 'shhh' && !('authorization' in sent.headers) && !('cookie' in sent.headers), 'with the service token in the two Access headers and no other credential')
  ok(u.stdout.includes('uploaded to') && !u.stdout.includes('shhh') && !u.stderr.includes('shhh'), 'and says so without printing the secret')
  for (const [status, words] of [[404, 'deploy server/deck-store first'], [403, 'service token was not accepted'], [401, 'service token was not accepted'], [302, 'service token was not accepted'], [400, 'shape']] as [number, string][]) {
    answer = status
    u = await upload({})
    ok(u.status === 1 && u.stderr.includes(String(status)) && u.stderr.includes(words), `the store answering ${status} fails the command and says why (${words})`)
  }
  await new Promise<void>((done) => server.close(() => done()))
  u = await upload({ SLIDES_STORE_URL: 'http://127.0.0.1:1' })
  ok(u.status === 1 && u.stderr.includes('could not reach'), 'a store that cannot be reached fails the command')
}

console.log('\nwhere the library goes')
{
  const src = readFileSync(script, 'utf8') + readFileSync(join(root, 'scripts/lib/beta-library.mjs'), 'utf8')
  ok(!/bento\.page|pages\.dev|github\.io/.test(src), 'the build names no public origin')
  ok((src.match(/https?:\/\/[a-z0-9.-]+/g) ?? []).every((u) => /^https:\/\/slides\.betamobility\.ai$|^http:\/\/www\.w3\.org$/.test(u)), 'the only host it can upload to by default is the store')
  ok(!/--upload/.test(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')), 'CI never uploads')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
