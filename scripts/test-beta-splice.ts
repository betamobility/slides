#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// The splice tool (plugins/beta-slides/scripts/splice.mjs) end to end against
// the real deck store worker under Miniflare.
//
//   node scripts/test-beta-splice.ts        (after npm ci in slides/ and
//                                            node scripts/build-beta-templates.mjs)
//
// Plan: docs/plans/2026-09-14-001-feat-runtime-slides-plan.md, U7 (KTD8,
// KTD11; R12 to R14, R16 to R19, R21; AE1 to AE3, AE6, AE8 to AE10), plus the
// code-review follow-ups: timeouts, the deck-wide asset name rule, the
// extra-elements refusal, --title, the dropped-values report and the url
// framing check (a throwaway openssl certificate serves the https pages).
//
// WHAT THIS PROVES. The tool is run the way Claude runs it: as a child process
// with CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET and SLIDES_STORE_URL in
// its environment. In production Cloudflare Access turns those two headers
// into a signed assertion before the worker sees the request; here a small
// node:http proxy plays Access (checks the headers, signs a service-token
// assertion with keys minted at run time) and forwards into Miniflare. The
// same proxy records every request, so "wrote nothing" is asserted as "no PUT
// reached the store", and it can land a person's save between the tool's read
// and its write, which is how the 412 retries are exercised.
//
// Every refusal is checked for three things: a non-zero exit, the offending
// id named on stderr, and no write at the store.

import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { webcrypto } from 'node:crypto'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = join(root, 'plugins', 'beta-slides', 'scripts', 'splice.mjs')
if (!existsSync(join(root, 'slides', 'node_modules'))) {
  console.log('FAIL  slides/node_modules is missing: run `npm ci` in slides/ first (miniflare lives there)')
  process.exit(1)
}
const require = createRequire(join(root, 'slides', 'package.json'))
const { Miniflare } = await import(pathToFileURL(require.resolve('miniflare')).href)

let checks = 0, failures = 0
const ok = (cond: unknown, msg: string) => {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}
const eq = (a: unknown, b: unknown, msg: string) => ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// ---- Access, as in server/deck-store/test/worker.test.mjs -------------------
const subtle = webcrypto.subtle
const TEAM_DOMAIN = 'beta-test.cloudflareaccess.com'
const ISS = `https://${TEAM_DOMAIN}`
const CERTS_URL = `${ISS}/cdn-cgi/access/certs`
const HUMAN_AUD = 'a'.repeat(64)
const SERVICE_AUD = 'b'.repeat(64)
const PAGES_ORIGIN = 'beta-site-stub.pages.dev'
const ORIGIN = 'https://slides.betamobility.ai'
const CLIENT_ID = 'rig-client.access'
const CLIENT_SECRET = 'rig-secret-' + 'x'.repeat(20)

const b64u = (bytes: ArrayBuffer | Uint8Array | Buffer) => Buffer.from(bytes as ArrayBuffer).toString('base64url')
const b64uJson = (o: unknown) => b64u(Buffer.from(JSON.stringify(o)))
const now = () => Math.floor(Date.now() / 1000)
const pair = await subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']) as CryptoKeyPair
const pub = await subtle.exportKey('jwk', pair.publicKey)
const jwks = { keys: [{ kid: 'k1', kty: pub.kty, n: pub.n, e: pub.e, alg: 'RS256', use: 'sig' }] }
async function sign(claims: Record<string, unknown>) {
  const head = b64uJson({ alg: 'RS256', kid: 'k1', typ: 'JWT' })
  const body = b64uJson(claims)
  const sig = await subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(`${head}.${body}`))
  return `${head}.${body}.${b64u(sig)}`
}
const serviceToken = await sign({ aud: [SERVICE_AUD], common_name: CLIENT_ID, exp: now() + 3600, iat: now(), nbf: now() - 5, iss: ISS, type: 'app', sub: '' })
const robertToken = await sign({ aud: [HUMAN_AUD], email: 'robert@betamobility.io', exp: now() + 3600, iat: now(), nbf: now() - 5, iss: ISS, type: 'app', sub: 'sub-robert' })

// ---- fixtures ---------------------------------------------------------------
const builtBlank = join(root, 'beta', 'templates', 'blank.bento.html')
const blankTemplate = () => existsSync(builtBlank)
  ? readFileSync(builtBlank, 'utf8')
  : `<!doctype html><html><body><script type="application/bento+json" id="bento-doc">\n${JSON.stringify({
      format: 'bento/slides', version: 1, template: true, title: 'Blank deck', size: { width: 1280, height: 720 },
      collab: { on: true, room: 'inherited-should-be-dropped' }, slides: [{ id: 'cover', elements: [] }],
    })}\n</script></body></html>`

/** A stored deck the way the kernel writes one: `<` escaped, newline-wrapped block. */
function deckHtml(doc: unknown) {
  const json = JSON.stringify(doc).replace(/</g, '\\u003c')
  return `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>` +
    `<script type="application/bento+json" id="bento-doc">\n${json}\n</script>` +
    `<script>/* runtime */</script></body></html>`
}
function docOf(html: string) {
  const m = /<script\b[^>]*\bid="bento-doc"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  return JSON.parse(m![1])
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('still')])
const DOC_ID = '6f1c2d4e-0000-4000-8000-00000000abcd'
const img = (id: string, src: string, over = {}) => ({ id, type: 'image', x: 0, y: 0, w: 1280, h: 720, rotation: 0, opacity: 1, src, fit: 'cover', radius: 0, ...over })

/** Robert's deck: native slides, a placeholder for the map, a live demo with presenter values. */
function robertsDoc() {
  return {
    format: 'bento/slides', version: 1, docId: DOC_ID, title: 'Frokost', size: { width: 1280, height: 720 },
    // Distinct from PNG: interning dedupes by value, so an old still equal to a
    // new one would rightly be reused rather than pruned.
    assets: { 'old-still': 'data:image/png;base64,' + Buffer.from('an older still').toString('base64'), 'old-src': 'data:text/html;base64,' + Buffer.from('<p>old</p>').toString('base64') },
    slides: [
      { id: 's1', background: '#F5F3EF', notes: 'hello <b>', elements: [
        { id: 't-04', type: 'text', x: 120, y: 80, w: 600, h: 80, rotation: 0, opacity: 1, html: 'Mobilty typo' },
        { id: 'logo', type: 'image', x: 900, y: 40, w: 200, h: 80, rotation: 0, opacity: 1, src: 'data:image/png;base64,AAAA', fit: 'contain', radius: 0 },
      ] },
      { id: 'map', notes: 'Robert wrote these notes', elements: [img('ph', 'data:image/png;base64,AAAA')], runtime: { steps: 0, props: [] } },
      { id: 'demo', elements: [img('still', 'asset:old-still')], runtime: {
        src: 'asset:old-src', still: 'asset:old-still', steps: 2,
        props: [{ key: 'title', label: 'Title', kind: 'text', default: 'Oslo' }], values: { title: 'Bergen' },
      } },
      { id: 'numbers', elements: [
        { id: 'c1', type: 'chart', x: 100, y: 100, w: 500, h: 400, rotation: 0, opacity: 1, option: { series: [{ type: 'bar', data: [1, 2] }] } },
        { id: 'tb', type: 'table', x: 700, y: 100, w: 400, h: 200, rotation: 0, opacity: 1, columns: [1, 1], header: true, rows: [{ cells: [{ html: 'a' }, { html: 'b' }] }] },
      ] },
    ],
  }
}

/** Robert's deck as it is today: native slides only, no runtime slide. */
function plainDoc() {
  const d: any = robertsDoc()
  d.slides = d.slides.filter((s: { runtime?: unknown }) => !s.runtime)
  delete d.assets
  return d
}

/** A project folder: scenes/<id>/{index.html, still.png|svg, scene.json, assets/}. */
function project(scenes: Record<string, { html?: string | Buffer; still?: Buffer | string; stillExt?: string; manifest?: unknown; assets?: Record<string, Buffer | string> }>, deckJson?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'splice-project-'))
  temps.push(dir)
  if (deckJson !== undefined) writeFileSync(join(dir, 'deck.json'), JSON.stringify(deckJson))
  for (const [id, s] of Object.entries(scenes)) {
    const sd = join(dir, 'scenes', id)
    mkdirSync(sd, { recursive: true })
    writeFileSync(join(sd, 'index.html'), s.html ?? `<!doctype html><title>${id}</title><p>scene ${id}</p><script>if (1 < 2) {}</script>`)
    writeFileSync(join(sd, `still.${s.stillExt ?? 'png'}`), s.still ?? PNG)
    writeFileSync(join(sd, 'scene.json'), JSON.stringify(s.manifest ?? { steps: 3, props: [{ key: 'title', label: 'Title', kind: 'text', default: 'Norge' }] }))
    if (s.assets) {
      mkdirSync(join(sd, 'assets'))
      for (const [n, b] of Object.entries(s.assets)) writeFileSync(join(sd, 'assets', n), b)
    }
  }
  return dir
}
const temps: string[] = []

// ---- the store, and Access in front of it -------------------------------------
const mf = new Miniflare({
  modules: true,
  modulesRoot: join(root, 'server', 'deck-store', 'src'),
  scriptPath: join(root, 'server', 'deck-store', 'src', 'worker.js'),
  modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
  compatibilityDate: '2026-07-01',
  r2Buckets: ['DECKS'],
  bindings: {
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUDS: `${HUMAN_AUD},${SERVICE_AUD}`,
    PAGES_ORIGIN, NEW_ENABLED: 'on', STORE_HOST: 'slides.betamobility.ai',
  },
  outboundService: async (req: Request) => {
    if (req.url === CERTS_URL) return new Response(JSON.stringify(jwks), { headers: { 'content-type': 'application/json' } })
    if (req.url.startsWith('https://plausible.io/')) return new Response('ok', { status: 202 })
    if (req.url === `https://${PAGES_ORIGIN}/templates/blank.bento.html`) return new Response(blankTemplate(), { status: 200 })
    throw new Error(`unexpected outbound fetch: ${req.url}`)
  },
})

type Logged = { method: string; path: string; status: number; service: boolean }
let log: Logged[] = []
/** How many times a person saves the deck just before the tool's next PUT lands. */
// stripEtag: behave like the Cloudflare edge, which drops a strong etag from
// any response it compresses (every deck read is HTML).
let stripEtag = false
let bumps = 0
let bumpX = 300
/** How many of the tool's next asset uploads get no answer at all. */
let hangAssets = 0
/** Requests the proxy is deliberately never answering, ended at teardown. */
const hung: import('node:http').ServerResponse[] = []

const store = (method: string, path: string, { as = 'service', body, headers = {} }: { as?: 'service' | 'robert'; body?: string | Buffer; headers?: Record<string, string> } = {}) =>
  mf.dispatchFetch(ORIGIN + path, { method, body, headers: { 'cf-access-jwt-assertion': as === 'service' ? serviceToken : robertToken, ...headers }, redirect: 'manual' })

/** Robert drags t-04 and saves from the editor, which sends no If-Match. */
async function robertSaves(id: string) {
  const r = await store('GET', `/api/harness/decks/${id}`)
  const doc = docOf(await r.text())
  const t = doc.slides.find((s: { id: string }) => s.id === 's1')?.elements.find((e: { id: string }) => e.id === 't-04')
  if (t) t.x = bumpX++
  const w = await store('PUT', `/api/decks/${id}`, { as: 'robert', body: deckHtml(doc) })
  if (w.status !== 200) throw new Error(`robert's save failed: ${w.status}`)
}

const proxy = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    let path = req.url || '/'
    const method = req.method || 'GET'
    // /hang/… is a store that accepts the connection and never answers.
    if (path.startsWith('/hang/')) { log.push({ method, path, status: 0, service: false }); hung.push(res); return }
    // /moved/… plays the retired host: reads pass, every write is a 301.
    if (path.startsWith('/moved/')) {
      path = path.slice('/moved'.length)
      if (method !== 'GET') {
        log.push({ method, path, status: 301, service: false })
        res.writeHead(301, { location: path }); res.end(); return
      }
    }
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'host' && k !== 'connection') headers[k] = v
    // Access: the two client headers become an assertion, and are not forwarded.
    const service = headers['cf-access-client-id'] === CLIENT_ID && headers['cf-access-client-secret'] === CLIENT_SECRET
    delete headers['cf-access-client-id']; delete headers['cf-access-client-secret']
    if (service) headers['cf-access-jwt-assertion'] = serviceToken
    const deckPut = /^\/api\/harness\/decks\/([0-9A-Za-z]{10})$/.exec(path)
    if (service && method === 'PUT' && deckPut && bumps > 0) { bumps--; await robertSaves(deckPut[1]) }
    if (service && method === 'PUT' && /\/assets\//.test(path) && hangAssets > 0) { hangAssets--; log.push({ method, path, status: 0, service }); hung.push(res); return }
    const r = await mf.dispatchFetch(ORIGIN + path, { method, headers, body, redirect: 'manual' })
    log.push({ method, path, status: r.status, service })
    const out = Buffer.from(await r.arrayBuffer())
    const h: Record<string, string> = {}
    r.headers.forEach((v: string, k: string) => { if (k !== 'content-length' && k !== 'transfer-encoding' && !(stripEtag && k === 'etag' && /text\/html/.test(r.headers.get('content-type') || ''))) h[k] = v })
    res.writeHead(r.status, h)
    res.end(out)
  } catch (err) {
    res.writeHead(599); res.end(String(err))
  }
})
await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
const STORE_URL = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`

function runTool(args: string[], { tool = TOOL, env = {} as Record<string, string | undefined> } = {}): Promise<{ code: number; out: string; err: string }> {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('CF_ACCESS_') && k !== 'SLIDES_STORE_URL') e[k] = v
  Object.assign(e, { CF_ACCESS_CLIENT_ID: CLIENT_ID, CF_ACCESS_CLIENT_SECRET: CLIENT_SECRET, SLIDES_STORE_URL: STORE_URL })
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete e[k]; else e[k] = v }
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [tool, ...args], { env: e, cwd: tmpdir() })
    let out = '', err = ''
    // A tool that hangs fails its case instead of hanging the rig.
    const kill = setTimeout(() => { err += '\n[rig] killed after 60 s'; p.kill('SIGKILL') }, 60_000)
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => { clearTimeout(kill); resolve({ code: code ?? -1, out, err }) })
  })
}

async function seed(doc: unknown = robertsDoc()) {
  const r = await store('POST', '/api/harness/decks', { body: deckHtml(doc) })
  return (await r.json() as { id: string }).id
}
async function readDeck(id: string) {
  const r = await store('GET', `/api/harness/decks/${id}`)
  const html = await r.text()
  return { html, etag: r.headers.get('etag'), doc: docOf(html) }
}
const putsTo = (id: string) => log.filter((l) => l.method === 'PUT' && l.path === `/api/harness/decks/${id}`)
const slideOf = (doc: { slides: { id: string }[] }, id: string) => doc.slides.find((s) => s.id === id) as any
const decode = (uri: string) => Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64')

let rt: typeof import('../slides/src/runtime.ts') | null = null
let rtError = ''
try { rt = await import('../slides/src/runtime.ts') } catch (e) { rtError = (e as Error).message }

try {
  ok(existsSync(TOOL), 'plugins/beta-slides/scripts/splice.mjs exists')
  // Not a soft skip: without it every "survives checkRuntime" check below
  // would vanish and the rig would stay green.
  ok(rt !== null, `slides/src/runtime.ts loads, so records are checked against the real sanitiser${rtError ? ` (${rtError})` : ''}`)

  // ------------------------------------------------------------ happy path
  console.log('\nupdate: two scenes replace two runtime slides, one typo fixed (F2, AE1, AE3, R14)')
  {
    const id = await seed()
    const before = await readDeck(id)
    const dir = project({
      map: { manifest: { steps: 5, props: [{ key: 'city', label: 'City', kind: 'text', default: 'Oslo' }] } },
      demo: { still: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9"/></svg>', stillExt: 'svg' },
    })
    const edits = join(dir, 'edits.json')
    writeFileSync(edits, JSON.stringify([{ slideId: 's1', elementId: 't-04', html: 'Mobility <i>fixed</i>' }]))
    log = []
    const r = await runTool([id, dir, '--edits', edits])
    eq(r.code, 0, `the run exits 0${r.code ? `: ${r.err}` : ''}`)
    eq(putsTo(id).length, 1, 'one conditional PUT reached the store')
    const after = await readDeck(id)
    eq(after.doc.docId, DOC_ID, 'docId unchanged')
    ok(!after.html.includes('</script><script>/* runtime */') || after.html.split('</script>').length === before.html.split('</script>').length, 'no extra </script> in the written file')
    ok(!/<\/script/i.test(/<script\b[^>]*id="bento-doc"[^>]*>([\s\S]*?)<\/script>/.exec(after.html)![1]), 'the block holds no literal </script (< escaped)')
    ok(after.html.includes('type="application/bento+json" id="bento-doc"'), 'the block keeps its type and id')
    eq(after.doc.slides.map((s: { id: string }) => s.id).join(','), 's1,map,demo,numbers', 'slide order unchanged')
    ok(same(slideOf(after.doc, 'numbers'), slideOf(before.doc, 'numbers')), 'the untouched native slide is byte-identical')
    const t04 = slideOf(after.doc, 's1').elements[0]
    eq(t04.html, 'Mobility <i>fixed</i>', 't-04 html changed')
    eq(t04.x, 120, 't-04 x stays as read (AE1)')
    ok(same(slideOf(after.doc, 's1').elements[1], slideOf(before.doc, 's1').elements[1]), 'the other element on s1 is untouched')
    const map = slideOf(after.doc, 'map')
    eq(map.notes, 'Robert wrote these notes', 'the replaced slide keeps its notes')
    eq(map.runtime.steps, 5, 'map steps from scene.json')
    ok(typeof map.runtime.src === 'string' && map.runtime.src.startsWith('asset:'), 'map src is an asset ref')
    eq(decode(after.doc.assets[map.runtime.src.slice(6)]).toString(), readFileSync(join(dir, 'scenes/map/index.html'), 'utf8'), 'map src asset decodes to index.html')
    eq(map.elements.length, 1, 'map carries one element, the still')
    const still = map.elements[0]
    ok(still.type === 'image' && still.x === 0 && still.y === 0 && still.w === 1280 && still.h === 720 && still.rotation === 0 && still.src === map.runtime.still,
      'the still is a full-bleed image carrying runtime.still')
    eq(still.id, 'ph', 'the still keeps the placeholder image id')
    ok(decode(after.doc.assets[map.runtime.still.slice(6)]).equals(PNG), 'the still asset is still.png')
    const demo = slideOf(after.doc, 'demo')
    eq(demo.runtime.values, undefined, 'presenter values on the replaced slide are gone (AE3)')
    ok(/demo[^\n]*presenter values dropped[^\n]*title[^\n]*Bergen/.test(r.out), `the run reports the dropped presenter values by slide, key and value (${r.out.split('\n').find((l) => /values/.test(l)) ?? 'no line'})`)
    ok(!/map[^\n]*presenter values dropped/.test(r.out), 'and names no slide that had none')
    ok(after.doc.assets[demo.runtime.still.slice(6)].startsWith('data:image/svg+xml;base64,'), 'an svg still is interned as image/svg+xml')
    ok(!('old-src' in after.doc.assets) && !('old-still' in after.doc.assets), 'the replaced record\'s orphaned assets are pruned')
    if (rt) {
      for (const sid of ['map', 'demo']) {
        const s = slideOf(after.doc, sid)
        ok(same(rt.checkRuntime(s.runtime, after.doc.assets), s.runtime), `${sid}: the record survives checkRuntime unchanged`)
      }
    }

    console.log('\nre-running the same project is stable')
    log = []
    const again = await runTool([id, dir])
    eq(again.code, 0, 'a second run exits 0')
    const third = await readDeck(id)
    ok(same(third.doc.assets, after.doc.assets), 'assets dedupe by value: no new keys on a re-run')
    ok(same(slideOf(third.doc, 'map'), map), 'the map slide is identical on a re-run')
  }

  // --------------------------------------------------------------- dry run
  console.log('\n--dry-run reports the plan and writes nothing')
  {
    const id = await seed()
    const before = await readDeck(id)
    const dir = project({ map: {}, demo: {} })
    log = []
    const r = await runTool([id, dir, '--dry-run'])
    eq(r.code, 0, 'dry run exits 0')
    ok(/map/.test(r.out), 'the plan names the map slide')
    ok(/demo[^\n]*presenter values dropped[^\n]*title[^\n]*Bergen/.test(r.out), 'the dry-run plan reports the presenter values the replace would drop')
    eq(log.filter((l) => l.method !== 'GET').length, 0, 'no write reached the store')
    eq((await readDeck(id)).etag, before.etag, 'the ETag is unchanged')
  }

  // ------------------------------------------------------------ refusals
  const refuses = async (label: string, id: string, args: string[], name: RegExp, env: Record<string, string | undefined> = {}) => {
    const before = await readDeck(id)
    log = []
    const r = await runTool(args, { env })
    ok(r.code !== 0, `${label}: exits non-zero`)
    ok(name.test(r.err), `${label}: stderr names it (${r.err.trim().split('\n')[0]})`)
    eq(log.filter((l) => l.method === 'PUT' || l.method === 'POST').length, 0, `${label}: nothing written`)
    eq((await readDeck(id)).etag, before.etag, `${label}: ETag unchanged`)
  }
  console.log('\nrefusals write nothing (AE8, AE9, AE10, KTD8)')
  {
    const id = await seed()
    await refuses('a scene for a slide not in the deck (AE8)', id, [id, project({ map: {}, nope: {} })], /nope/)
    await refuses('a scene for a native slide (AE10)', id, [id, project({ s1: {} })], /s1/)
    const dup = robertsDoc()
    dup.slides.push({ ...structuredClone(dup.slides[1]) })
    const dupId = await seed(dup)
    await refuses('a scene whose id two slides share (AE9)', dupId, [dupId, project({ map: {} })], /map/)
    const dir = project({ map: {} })
    const w = join(dir, 'w.json')
    writeFileSync(w, JSON.stringify([{ slideId: 's1', elementId: 't-04', html: 'x', w: 999 }]))
    await refuses('an edit that changes w', id, [id, dir, '--edits', w], /t-04/)
    const miss = join(dir, 'miss.json')
    writeFileSync(miss, JSON.stringify([{ slideId: 's1', elementId: 'ghost', html: 'x' }]))
    await refuses('an edit naming an element that is not there', id, [id, dir, '--edits', miss], /ghost/)
    const onRuntime = join(dir, 'rt.json')
    writeFileSync(onRuntime, JSON.stringify([{ slideId: 'demo', elementId: 'still', src: 'data:image/png;base64,AAAA' }]))
    await refuses('an edit on a runtime slide', id, [id, dir, '--edits', onRuntime], /demo/)
    const wrongKey = join(dir, 'wk.json')
    writeFileSync(wrongKey, JSON.stringify([{ slideId: 'numbers', elementId: 'c1', html: 'x' }]))
    await refuses('an edit with a content key the element type does not have', id, [id, dir, '--edits', wrongKey], /c1/)
    await refuses('scene source over 256 KB', id, [id, project({ map: { html: '<p>' + 'x'.repeat(256 * 1024) + '</p>' } })], /map[\s\S]*256|256[\s\S]*map/)
    await refuses('a still over 200 KB', id, [id, project({ map: { still: Buffer.alloc(200 * 1024 + 1, 1) } })], /map[\s\S]*200|200[\s\S]*map/)
    await refuses('an asset with a type the store does not accept', id, [id, project({ map: { manifest: { steps: 0, props: [], assets: ['clip.mp4'] }, assets: { 'clip.mp4': 'x' } } })], /clip\.mp4/)
    await refuses('an asset scene.json names but the folder lacks', id, [id, project({ map: { manifest: { steps: 0, props: [], assets: ['gone.svg'] } } })], /gone\.svg/)
    await refuses('a scene folder with no still', id, [id, (() => { const d = project({ map: {} }); rmSync(join(d, 'scenes/map/still.png')); return d })()], /map[\s\S]*still|still[\s\S]*map/)

    await refuses('a text prop whose default is a number', id, [id, project({ map: { manifest: { steps: 0, props: [{ key: 'title', kind: 'text', default: 5 }] } } })], /map[\s\S]*title/)
    await refuses('a color prop whose default smuggles url()', id, [id, project({ map: { manifest: { steps: 0, props: [{ key: 'tint', kind: 'color', default: 'url(x)' }] } } })], /map[\s\S]*tint/)
    await refuses('a prop label over 200 characters', id, [id, project({ map: { manifest: { steps: 0, props: [{ key: 't', kind: 'text', label: 'L'.repeat(201) }] } } })], /map[\s\S]*label/)

    log = []
    const moved = await runTool([id, project({ map: {} })], { env: { SLIDES_STORE_URL: `${STORE_URL}/moved` } })
    ok(moved.code !== 0 && /redirect/i.test(moved.err), `a store that redirects the write: exits non-zero, never reports success (${moved.err.trim().split('\n')[0]})`)
    eq(log.filter((l) => l.method === 'PUT' && l.status !== 301).length, 0, 'a redirected write: no PUT reached the store')

    // Finding J: the store's asset route is per deck, not per scene.
    await refuses('two scenes listing one asset name with different bytes', id,
      [id, project({ map: { manifest: { steps: 0, props: [], assets: ['data.csv'] }, assets: { 'data.csv': 'a\n1\n' } }, demo: { manifest: { steps: 0, props: [], assets: ['data.csv'] }, assets: { 'data.csv': 'a\n2\n' } } })],
      /data\.csv[\s\S]*(map[\s\S]*demo|demo[\s\S]*map)/)
    eq(log.length, 0, 'the asset name clash is refused before any request')
    {
      const twin = await seed()
      log = []
      const r = await runTool([twin, project({ map: { manifest: { steps: 0, props: [], assets: ['data.csv'] }, assets: { 'data.csv': 'a\n1\n' } }, demo: { manifest: { steps: 0, props: [], assets: ['data.csv'] }, assets: { 'data.csv': 'a\n1\n' } } })])
      eq(r.code, 0, `two scenes listing one asset name with identical bytes run${r.code ? `: ${r.err}` : ''}`)
      eq(log.filter((l) => l.method === 'PUT' && /\/assets\/data\.csv$/.test(l.path)).length, 1, 'and the shared asset is uploaded once')
    }

    // Finding N: a runtime slide holding more than its still.
    const crowded = robertsDoc()
    ;(crowded.slides[2].elements as any[]).push({ id: 'pasted-note', type: 'text', x: 10, y: 10, w: 100, h: 40, rotation: 0, opacity: 1, html: 'pasted' })
    const crowdedId = await seed(crowded)
    await refuses('replacing a runtime slide that holds elements besides its still', crowdedId, [crowdedId, project({ demo: {} })], /demo[\s\S]*pasted-note|pasted-note[\s\S]*demo/)

    const enc = await seed({ format: 'bento/enc', v: 1, it: 600000, salt: 'c2FsdA==', iv: 'aXZpdml2aXZpdg==', data: 'Y2lwaGVy' })
    await refuses('an encrypted deck', enc, [enc, project({ map: {} })], /encrypt/i)

    log = []
    const nocreds = await runTool([id, project({ map: {} })], { env: { CF_ACCESS_CLIENT_SECRET: undefined } })
    ok(nocreds.code !== 0 && /CF_ACCESS_CLIENT_SECRET/.test(nocreds.err), 'missing credentials: exits non-zero naming the variable')
    eq(log.length, 0, 'missing credentials: no request made')
  }

  // ------------------------------------------------------- edits only
  console.log('\nedits only: a typo fixed on a deck with no runtime slides (AE1, R13)')
  {
    const id = await seed(plainDoc())
    const before = await readDeck(id)
    const dir = mkdtempSync(join(tmpdir(), 'splice-edits-'))
    temps.push(dir)
    const edits = join(dir, 'edits.json')
    writeFileSync(edits, JSON.stringify([{ slideId: 's1', elementId: 't-04', html: 'Mobility' }]))
    log = []
    const r = await runTool([id, '--edits', edits])
    eq(r.code, 0, `<deckId> --edits exits 0${r.code ? `: ${r.err}` : ''}`)
    eq(putsTo(id).length, 1, 'one conditional PUT reached the store')
    const after = await readDeck(id)
    ok(after.etag !== before.etag, 'the ETag changed')
    const t04 = slideOf(after.doc, 's1').elements[0]
    eq(t04.html, 'Mobility', 't-04 html changed')
    eq(t04.x, 120, 't-04 x stays as read (AE1)')
    const expect = structuredClone(before.doc)
    expect.slides[0].elements[0].html = 'Mobility'
    ok(same(after.doc, expect), 'nothing else in the document changed')

    writeFileSync(edits, JSON.stringify([{ slideId: 's1', elementId: 't-04', html: 'Mobility again' }]))
    const r2 = await runTool([id, dir, '--edits', edits])
    eq(r2.code, 0, `<deckId> <projectDir> --edits with no scenes/ exits 0${r2.code ? `: ${r2.err}` : ''}`)
    eq(slideOf((await readDeck(id)).doc, 's1').elements[0].html, 'Mobility again', 'and the edit landed')

    const empty = mkdtempSync(join(tmpdir(), 'splice-empty-'))
    temps.push(empty)
    await refuses('neither scenes nor edits', id, [id, empty], /nothing to do/i)
  }

  // ----------------------------------------------------------- insertAfter
  console.log('\ninsertAfter: a new runtime slide in an existing deck (R17, AE8, AE10)')
  {
    const id = await seed()
    const before = await readDeck(id)
    const dir = project({ live: { manifest: { steps: 1, props: [], insertAfter: 's1' } } })
    log = []
    const r = await runTool([id, dir])
    eq(r.code, 0, `insertAfter an existing id exits 0${r.code ? `: ${r.err}` : ''}`)
    eq(putsTo(id).length, 1, 'one conditional PUT reached the store')
    const after = await readDeck(id)
    eq(after.doc.slides.map((s: { id: string }) => s.id).join(','), 's1,live,map,demo,numbers', 'the new slide sits right after s1')
    for (const sid of ['s1', 'map', 'demo', 'numbers']) ok(same(slideOf(after.doc, sid), slideOf(before.doc, sid)), `${sid} is byte-identical`)
    const live = slideOf(after.doc, 'live')
    ok(live.runtime && live.runtime.steps === 1 && live.elements.length === 1 && live.elements[0].src === live.runtime.still, 'live is a runtime slide carrying its still')
    eq(live.background, '#F5F3EF', 'the new slide takes its neighbour\'s background')
    if (rt) ok(same(rt.checkRuntime(live.runtime, after.doc.assets), live.runtime), 'the record survives checkRuntime unchanged')
    const again = await runTool([id, dir])
    eq(again.code, 0, 're-running replaces the inserted slide instead of inserting again')
    eq((await readDeck(id)).doc.slides.length, 5, 'still five slides')
  }
  {
    const id = await seed()
    const r = await runTool([id, project({ tail: { manifest: { steps: 0, props: [], insertAfter: 'end' } } })])
    eq(r.code, 0, `insertAfter "end" exits 0${r.code ? `: ${r.err}` : ''}`)
    eq((await readDeck(id)).doc.slides.map((s: { id: string }) => s.id).join(','), 's1,map,demo,numbers,tail', 'the new slide is appended')
    await refuses('insertAfter an unknown id', id, [id, project({ other: { manifest: { steps: 0, props: [], insertAfter: 'ghost' } } })], /ghost/)
    await refuses('a folder named for a native slide with insertAfter set (AE10)', id, [id, project({ s1: { manifest: { steps: 0, props: [], insertAfter: 'map' } } })], /s1/)
    await refuses('insertAfter that is not a string', id, [id, project({ odd: { manifest: { steps: 0, props: [], insertAfter: 3 } } })], /odd/)
  }
  {
    const withStates = robertsDoc()
    withStates.slides.splice(1, 0, { id: 's1-zoom', stateOf: 's1', elements: [] } as any)
    const id = await seed(withStates)
    const r = await runTool([id, project({ live: { manifest: { steps: 0, props: [], insertAfter: 's1' } } })])
    eq(r.code, 0, `insertAfter a slide with states exits 0${r.code ? `: ${r.err}` : ''}`)
    eq((await readDeck(id)).doc.slides.map((s: { id: string }) => s.id).join(','), 's1,s1-zoom,live,map,demo,numbers', 'the new slide goes after the anchor\'s states, never between them')
  }
  console.log('\ninsert and a 412 once: the insert is re-derived, not duplicated (R19)')
  {
    const id = await seed()
    bumps = 1; bumpX = 500
    log = []
    const r = await runTool([id, project({ live: { manifest: { steps: 0, props: [], insertAfter: 'map' } } })])
    eq(r.code, 0, `exits 0${r.code ? `: ${r.err}` : ''}`)
    eq(putsTo(id).map((l) => l.status).join(','), '412,200', 'the first PUT is 412, the second 200')
    const doc = (await readDeck(id)).doc
    eq(doc.slides.map((s: { id: string }) => s.id).join(','), 's1,map,live,demo,numbers', 'exactly one inserted slide, after map')
    eq(slideOf(doc, 's1').elements[0].x, 500, 'Robert\'s move survives')
    bumps = 0
  }

  console.log('\nthe ownership diff itself (a read doc mutated by hand)')
  {
    let mod: any = null
    try { mod = await import(pathToFileURL(TOOL).href) } catch (e) { console.log(`  (splice.mjs not importable: ${(e as Error).message})`) }
    ok(typeof mod?.checkOwnership === 'function', 'splice.mjs exports checkOwnership')
    if (typeof mod?.checkOwnership === 'function') {
      const cases: [string, (d: any) => void, RegExp][] = [
        ['x moved', (d) => { d.slides[0].elements[0].x = 300 }, /t-04/],
        ['rotation changed', (d) => { d.slides[3].elements[1].rotation = 5 }, /tb/],
        ['slide order changed', (d) => { d.slides.reverse() }, /order|count/],
        ['a native slide background changed', (d) => { d.slides[0].background = '#000' }, /s1/],
        ['docId changed', (d) => { d.docId = 'other' }, /docId/],
        ['a slide added that no scene inserts', (d) => { d.slides.push({ id: 'extra', elements: [], runtime: { steps: 0, props: [] } }) }, /order|count/],
        ['the title changed without --title', (d) => { d.title = 'Other' }, /title/],
      ]
      for (const [label, mutate, name] of cases) {
        const read = robertsDoc(), out = robertsDoc()
        mutate(out)
        let msg = ''
        try { mod.checkOwnership(read, out, { scenes: new Set(), edits: new Map() }) } catch (e) { msg = (e as Error).message }
        ok(name.test(msg), `${label} is refused naming it (${msg})`)
      }
      let clean = ''
      try { mod.checkOwnership(robertsDoc(), robertsDoc(), { scenes: new Set(), edits: new Map() }) } catch (e) { clean = (e as Error).message }
      eq(clean, '', 'an unchanged doc passes')
    }
  }

  // --------------------------------------------------------------- assets
  console.log('\na 7 MB SVG is uploaded, never inlined (AE6)')
  {
    const id = await seed()
    const big = '<svg xmlns="http://www.w3.org/2000/svg">' + '<path d="M0 0L1 1"/>'.repeat(Math.ceil(7 * 1024 * 1024 / 20)) + '</svg>'
    const dir = project({ map: { manifest: { steps: 0, props: [], assets: ['norway.svg', 'data.csv'] }, assets: { 'norway.svg': big, 'data.csv': 'a,b\n1,2\n' } } })
    log = []
    const r = await runTool([id, dir])
    eq(r.code, 0, `exits 0${r.code ? `: ${r.err}` : ''}`)
    const after = await readDeck(id)
    ok(after.html.length < 1024 * 1024, `the deck stays small (${Math.round(after.html.length / 1024)} KB)`)
    ok(!after.html.includes('M0 0L1 1'), 'the svg body is not in the deck')
    ok(same(slideOf(after.doc, 'map').runtime.assets, ['norway.svg', 'data.csv']), 'the record lists the assets')
    const a = await store('GET', `/d/${id}/assets/norway.svg`, { as: 'robert' })
    eq(a.status, 200, 'the svg is on the asset route')
    eq(a.headers.get('content-type'), 'image/svg+xml', 'as image/svg+xml')
    eq((await a.arrayBuffer()).byteLength, Buffer.byteLength(big), 'with all its bytes')
    const c = await store('GET', `/d/${id}/assets/data.csv`, { as: 'robert' })
    eq(c.headers.get('content-type'), 'text/csv', 'the csv went up as text/csv')
    const puts = log.filter((l) => l.method === 'PUT')
    ok(puts.length === 3 && puts[puts.length - 1].path === `/api/harness/decks/${id}`, 'assets upload before the deck write')
  }

  // -------------------------------------------------------------- retries
  console.log('\na 412 once: re-read, re-derive, succeed (AE2, R19, F3)')
  {
    const id = await seed()
    const dir = project({ map: {} })
    const edits = join(dir, 'edits.json')
    writeFileSync(edits, JSON.stringify([{ slideId: 's1', elementId: 't-04', html: 'After the conflict' }]))
    bumps = 1; bumpX = 300
    log = []
    const r = await runTool([id, dir, '--edits', edits])
    eq(r.code, 0, `exits 0${r.code ? `: ${r.err}` : ''}`)
    eq(putsTo(id).map((l) => l.status).join(','), '412,200', 'the first PUT is 412, the second 200')
    const t04 = slideOf((await readDeck(id)).doc, 's1').elements[0]
    eq(t04.x, 300, 'Robert\'s move, saved between read and write, survives')
    eq(t04.html, 'After the conflict', 'and the edit landed on top of it')
  }
  console.log('\nfour 412s: stop, say the owner probably has it open (R19)')
  {
    const id = await seed()
    bumps = 4; bumpX = 400
    log = []
    const r = await runTool([id, project({ map: {} })])
    ok(r.code !== 0, 'exits non-zero')
    ok(/owner probably has the deck open/i.test(r.err), `says the owner probably has the deck open (${r.err.trim().split('\n').pop()})`)
    eq(putsTo(id).map((l) => l.status).join(','), '412,412,412,412', 'exactly four attempts, all refused')
    eq(slideOf((await readDeck(id)).doc, 'map').runtime.src, undefined, 'the deck holds Robert\'s last save, not the splice')
    bumps = 0
  }
  console.log('\nthe edge strips etag from the deck read: the tool writes with x-bento-etag')
  {
    const id = await seed()
    const dir = project({})
    const edits = join(dir, 'edits.json')
    writeFileSync(edits, JSON.stringify([{ slideId: 's1', elementId: 't-04', html: 'Edge fixed' }]))
    stripEtag = true
    log = []
    const r = await runTool([id, '--edits', edits])
    stripEtag = false
    eq(r.code, 0, `exits 0 with only x-bento-etag${r.code ? `: ${r.err}` : ''}`)
    eq(putsTo(id).map((l) => l.status).join(','), '200', 'one conditional PUT, accepted')
  }
  console.log('\nfour 412s after the assets went up: the message says which assets stay uploaded')
  {
    const id = await seed()
    bumps = 4; bumpX = 600
    const r = await runTool([id, project({ map: { manifest: { steps: 0, props: [], assets: ['pts.json'] }, assets: { 'pts.json': '[1]' } } })])
    bumps = 0
    ok(r.code !== 0 && /owner probably has the deck open/i.test(r.err), 'exits non-zero on the conflict')
    ok(/pts\.json[^\n]*uploaded|uploaded[^\n]*pts\.json/.test(r.err), `names the asset that was uploaded (${r.err.trim().split('\n').pop()})`)
    ok(/the deck itself was not changed/i.test(r.err), 'and says the deck itself was not changed')
  }

  // --------------------------------------------------------------- create
  console.log('\n--create: two native slides and one scene become a new deck (F1, R21)')
  {
    const nativeSlides = [
      { id: 'intro', elements: [{ id: 'h', type: 'text', x: 96, y: 96, w: 800, h: 100, rotation: 0, opacity: 1, html: 'Frokost' }] },
      { id: 'close', elements: [] },
    ]
    const dir = project({ live: { manifest: { steps: 2, props: [], assets: ['pts.json'] }, assets: { 'pts.json': '[1,2]' } } }, { title: 'Frokostmøte', slides: nativeSlides })
    log = []
    const r = await runTool(['--create', dir])
    eq(r.code, 0, `exits 0${r.code ? `: ${r.err}` : ''}`)
    const m = /\/d\/([0-9A-Za-z]{10})/.exec(r.out)
    ok(!!m, `prints the deck link (${r.out.trim().split('\n').pop()})`)
    if (m) {
      const got = await readDeck(m[1])
      const tpl = docOf(blankTemplate())
      eq(got.doc.slides.length, 3, 'the deck has three slides')
      eq(got.doc.slides.filter((s: { runtime?: unknown }) => s.runtime).length, 1, 'one of them a runtime slide')
      eq(got.doc.slides.map((s: { id: string }) => s.id).join(','), 'intro,close,live', 'native slides first, then the scene')
      ok(/^[0-9a-f-]{36}$/.test(got.doc.docId) && got.doc.docId !== tpl.docId, `a fresh docId (${got.doc.docId})`)
      eq(got.doc.template, undefined, 'no template flag')
      eq(got.doc.collab, undefined, 'no collab')
      eq(got.doc.title, 'Frokostmøte', 'the title from deck.json')
      ok(same(got.doc.layouts, tpl.layouts) && same(got.doc.theme, tpl.theme), 'theme and layouts from the blank template')
      const live = slideOf(got.doc, 'live')
      eq(live.elements[0].w, got.doc.size?.width ?? 1280, 'the still spans the deck width')
      if (rt) ok(same(rt.checkRuntime(live.runtime, got.doc.assets), live.runtime), 'the record survives checkRuntime unchanged')
      const a = await store('GET', `/d/${m[1]}/assets/pts.json`, { as: 'robert' })
      eq(a.status, 200, 'the scene asset was uploaded against the new id')
      const second = await runTool(['--create', dir])
      const m2 = /\/d\/([0-9A-Za-z]{10})/.exec(second.out)
      ok(!!m2 && docOf((await readDeck(m2[1])).html).docId !== got.doc.docId, 'a second create mints another docId')
    }
    log = []
    const dry = await runTool(['--create', dir, '--dry-run'])
    ok(dry.code === 0 && log.every((l) => l.method === 'GET'), '--create --dry-run exits 0 and writes nothing')
    const nodeck = project({ live: {} })
    log = []
    const nd = await runTool(['--create', nodeck])
    ok(nd.code !== 0 && /deck\.json/.test(nd.err) && !log.some((l) => l.method === 'POST'), '--create without deck.json refuses and posts nothing')
  }

  // ------------------------------------------------------------ --title
  console.log('\n--title renames a deck and changes nothing else (finding Q1)')
  {
    const id = await seed()
    const before = await readDeck(id)
    log = []
    const r = await runTool([id, '--title', 'Frokost i Bergen'])
    eq(r.code, 0, `<deckId> --title alone exits 0${r.code ? `: ${r.err}` : ''}`)
    eq(putsTo(id).length, 1, 'one conditional PUT reached the store')
    ok(/Frokost i Bergen/.test(r.out), 'the plan names the new title')
    const after = await readDeck(id)
    const expect = structuredClone(before.doc)
    expect.title = 'Frokost i Bergen'
    ok(same(after.doc, expect), 'only doc.title changed')
    const r2 = await runTool([id, project({ map: {} }), '--title', 'Frokost igjen'])
    eq(r2.code, 0, `--title beside a scene exits 0${r2.code ? `: ${r2.err}` : ''}`)
    eq((await readDeck(id)).doc.title, 'Frokost igjen', 'and the title landed with the scene')
    const dry = await runTool([id, '--title', 'Never', '--dry-run'])
    ok(dry.code === 0 && /Never/.test(dry.out), '--title --dry-run prints the rename')
    eq((await readDeck(id)).doc.title, 'Frokost igjen', 'and writes nothing')
    await refuses('an empty --title', id, [id, '--title', '  '], /title/)
    const usage = await runTool([id, '--title'])
    eq(usage.code, 2, '--title with no value is a usage error')
    const withCreate = await runTool(['--create', project({}, { slides: [{ id: 'a', elements: [] }] }), '--title', 'x'])
    eq(withCreate.code, 2, '--create --title is a usage error (deck.json carries the title)')
  }

  // ----------------------------------------------------------- timeouts
  console.log('\na store that never answers: the run stops within the timeout (finding E)')
  {
    const id = await seed()
    const started = Date.now()
    const r = await runTool([id, project({ map: {} })], { env: { SLIDES_STORE_URL: `${STORE_URL}/hang`, SPLICE_TIMEOUT_MS: '400' } })
    const took = Date.now() - started
    eq(r.code, 1, 'exits 1')
    ok(took < 10000, `within the timeout, not hanging (${took} ms)`)
    ok(/timed out/i.test(r.err) && r.err.includes(`GET ${STORE_URL}/hang/api/harness/decks/${id}`), `names the request that timed out (${r.err.trim().split('\n').pop()})`)
    const c = await runTool(['--create', project({}, { slides: [{ id: 'a', elements: [] }] })], { env: { SLIDES_STORE_URL: `${STORE_URL}/hang`, SPLICE_TIMEOUT_MS: '400' } })
    ok(c.code === 1 && /timed out/i.test(c.err) && /templates\/blank\.bento\.html/.test(c.err), `--create: the template fetch times out naming it (${c.err.trim().split('\n').pop()})`)
  }
  console.log('\n--create, and an asset upload that never answers: the new deck is not lost (finding E, correctness b)')
  {
    hangAssets = 1
    const r = await runTool(['--create', project({ live: { manifest: { steps: 0, props: [], assets: ['pts.json'] }, assets: { 'pts.json': '[1]' } } }, { title: 'Tapt', slides: [] })], { env: { SPLICE_TIMEOUT_MS: '2000' } })
    hangAssets = 0
    const m = /\/d\/([0-9A-Za-z]{10})/.exec(r.out)
    eq(r.code, 1, 'exits 1')
    ok(!!m, `the created deck's link is printed before the uploads (${r.out.trim().split('\n')[0]})`)
    ok(/timed out/i.test(r.err) && /pts\.json/.test(r.err), `the error names the upload that timed out (${r.err.trim().split('\n').pop()})`)
    if (m) {
      ok(r.err.includes(m[1]), 'and carries the new deck id')
      eq((await store('GET', `/api/harness/decks/${m[1]}`)).status, 200, 'the deck exists in the store')
    }
  }

  // ----------------------------------------------------- URL framing check
  console.log('\nscene.json url: a page that refuses framing is refused at authoring time (finding L)')
  {
    const cert = mkdtempSync(join(tmpdir(), 'splice-cert-'))
    temps.push(cert)
    const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
      '-keyout', join(cert, 'key.pem'), '-out', join(cert, 'cert.pem')], { stdio: 'pipe' })
    ok(gen.status === 0, `a throwaway self-signed certificate is minted with openssl${gen.status ? `: ${gen.stderr}` : ''}`)
    const hits: string[] = []
    const pages: Record<string, [number, Record<string, string>]> = {
      '/deny': [200, { 'x-frame-options': 'DENY' }],
      '/sameorigin': [200, { 'x-frame-options': 'sameorigin' }],
      '/none': [200, { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }],
      '/self': [200, { 'content-security-policy': "frame-ancestors 'self'" }],
      '/other': [200, { 'content-security-policy': 'frame-ancestors https://example.com https://intra.example.com' }],
      '/ours': [200, { 'content-security-policy': "script-src 'self'; frame-ancestors 'self' https://slides.betamobility.ai" }],
      '/star': [200, { 'content-security-policy': 'frame-ancestors *' }],
      '/scheme': [200, { 'content-security-policy': 'frame-ancestors https:' }],
      '/report-only': [200, { 'content-security-policy-report-only': "frame-ancestors 'none'" }],
      '/plain': [200, {}],
      '/hop': [302, { location: '/deny' }],
      '/hop-ok': [302, { location: '/plain' }],
      '/hop-hop': [302, { location: '/hop-ok' }],
    }
    const https = gen.status === 0 ? createHttpsServer({ key: readFileSync(join(cert, 'key.pem')), cert: readFileSync(join(cert, 'cert.pem')) }, (req, res) => {
      hits.push(`${req.method} ${req.url}`)
      const [status, headers] = pages[req.url || ''] ?? [404, {}]
      res.writeHead(status, headers); res.end('<p>page</p>')
    }) : null
    if (https) {
      await new Promise<void>((r) => https.listen(0, '127.0.0.1', () => r()))
      const base = `https://127.0.0.1:${(https.address() as { port: number }).port}`
      // The rig's certificate is self-signed; only the child process is told to accept it.
      const tls = { NODE_TLS_REJECT_UNAUTHORIZED: '0' }
      const withUrl = (path: string) => project({ map: { manifest: { steps: 0, props: [], url: base + path } } })
      const id = await seed()
      for (const [path, what] of [['/deny', 'X-Frame-Options DENY'], ['/sameorigin', 'X-Frame-Options SAMEORIGIN'], ['/none', "frame-ancestors 'none'"],
        ['/self', "frame-ancestors 'self'"], ['/other', 'frame-ancestors without slides.betamobility.ai'], ['/hop', 'one redirect to a DENY page']]) {
        await refuses(`a url page with ${what}`, id, [id, withUrl(path)], /scene "map"[^\n]*(X-Frame-Options|frame-ancestors)/, tls)
      }
      for (const [path, what] of [['/ours', 'frame-ancestors naming slides.betamobility.ai'], ['/star', 'frame-ancestors *'], ['/scheme', 'frame-ancestors https:'],
        ['/report-only', 'a report-only policy'], ['/plain', 'no framing headers'], ['/hop-ok', 'one redirect to a plain page']]) {
        const r = await runTool([id, withUrl(path)], { env: tls })
        eq(r.code, 0, `a url page with ${what} is accepted${r.code ? `: ${r.err}` : ''}`)
      }
      eq(slideOf((await readDeck(id)).doc, 'map').runtime.url, `${base}/hop-ok`, 'and the url lands in the record')
      const twoHops = await runTool([id, withUrl('/hop-hop')], { env: tls })
      ok(twoHops.code === 0 && /^warning: scene "map"[^\n]*redirected more than once/m.test(twoHops.err), `two redirects are not followed: a warning, not a refusal (${twoHops.err.trim().split('\n').find((l) => /^warning:/.test(l)) ?? ''})`)
      // A port that was free a moment ago: connection refused, a real network failure.
      const closed = createServer()
      await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()))
      const closedPort = (closed.address() as { port: number }).port
      await new Promise((r) => closed.close(r))
      const down = await runTool([id, project({ map: { manifest: { steps: 0, props: [], url: `https://127.0.0.1:${closedPort}/` } } })], { env: tls })
      ok(down.code === 0 && new RegExp(`^warning: scene "map"[^\\n]*127\\.0\\.0\\.1:${closedPort}/`, 'm').test(down.err), `an unreachable url is a warning, not a refusal (${down.err.trim().split('\n').find((l) => /^warning:/.test(l)) ?? ''})`)
      hits.length = 0
      const skipped = await runTool([id, withUrl('/deny'), '--skip-url-check'], { env: tls })
      eq(skipped.code, 0, `--skip-url-check bypasses the check${skipped.code ? `: ${skipped.err}` : ''}`)
      eq(hits.length, 0, '--skip-url-check sends no request to the page')
      const dry = await runTool([id, withUrl('/deny'), '--dry-run'], { env: tls })
      ok(dry.code !== 0 && /scene "map"[^\n]*X-Frame-Options/.test(dry.err), 'the check runs on --dry-run too')
      https.close()
    }
  }

  // ----------------------------------------------------- the plugin alone
  console.log('\nthe tool runs from a copy of plugins/beta-slides/ alone (R18, KTD11)')
  {
    const copy = mkdtempSync(join(tmpdir(), 'beta-slides-plugin-'))
    temps.push(copy)
    cpSync(join(root, 'plugins', 'beta-slides'), join(copy, 'beta-slides'), { recursive: true })
    const id = await seed()
    const r = await runTool([id, project({ map: {} })], { tool: join(copy, 'beta-slides', 'scripts', 'splice.mjs') })
    eq(r.code, 0, `the copied tool exits 0${r.code ? `: ${r.err}` : ''}`)
    ok(typeof slideOf((await readDeck(id)).doc, 'map').runtime.src === 'string', 'and the splice landed')
    const sources = ['splice.mjs', 'lib/bento-doc.mjs'].map((f) => readFileSync(join(root, 'plugins/beta-slides/scripts', f), 'utf8'))
    const specifiers = sources.flatMap((s) => [...s.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] || m[2]))
    const bad = specifiers.filter((s) => !s.startsWith('node:') && !s.startsWith('./'))
    ok(specifiers.length > 0 && bad.length === 0, `only node: built-ins and ./ imports (${bad.join(', ') || 'none foreign'})`)
  }
} finally {
  for (const res of hung) res.destroy()
  proxy.closeAllConnections()
  proxy.close()
  await mf.dispose()
  for (const t of temps) rmSync(t, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.log(`
The splice tool is the only way the beta-slides skill changes an existing deck
(KTD8). A red here means it can write over a person's layout, write part of a
change, or give up on a conflict it should have retried.`)
  process.exit(1)
}
