#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// BETA FORK: every Beta hook inside an upstream file says so.
//
//   node scripts/test-beta-markers.ts            the rig (needs the upstream tag; fetches it when absent)
//   node scripts/test-beta-markers.ts --list     print every hook, marked or not
//
// WHAT THIS PROVES (upstream-merge plan U4, R22, AE12). The fork lives inside
// upstream's files as small hooks. At the next upstream merge each hook is a
// conflict, or worse, a hunk git merges without one, and the only way to find
// them all is to have marked them. Two spellings had grown ("BETA FORK",
// "Beta build") and about ninety hooks carried neither. This rig diffs the
// fork against the upstream tag AGENTS.md names, in the files upstream owns,
// and fails on a hook with no `BETA FORK` in it or on the three lines above it
// (a marked comment directly over the code it explains covers that code).
//
// It also fails on a marker upstream now carries byte for byte: code upstream
// took is upstream's, and a stale marker sends the next merge looking for a
// hook that is not there.
//
// Not covered, each for a stated reason (EXEMPT below): generated files and
// catalogues (regenerated or merged by key, never by hook), JSON (no comment
// syntax), and kernel/src/charts.ts, whose hooks predate this rig and cannot
// be marked without a kernel-zone edit.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// the compiler the build installs (slides/node_modules); this rig runs after `npm ci` there
const ts = createRequire(join(root, 'slides/package.json'))('typescript') as typeof import('typescript')
const TOKEN = 'BETA FORK'
const NEAR = 3
const UPSTREAM = 'https://github.com/nyblnet/bento.git'

/** Files upstream owns where a Beta change is a hook, not a regenerated or merged-by-key file. */
const IN_SCOPE = /^(slides\/src\/|kernel\/src\/|scripts\/|slides\/index\.html$|slides\/vite\.config\.ts$|server\/sync-worker\/|\.github\/workflows\/)/
const EXEMPT: Array<[RegExp, string]> = [
  [/\/i18n\//, 'catalogues merge by key (scripts/build-i18n.mjs repacks them)'],
  [/\.generated\./, 'generated'],
  [/\.json$/, 'JSON has no comment to carry a marker'],
  [/^kernel\/src\/charts\.ts$/, 'horizontal bars and bar corners (#39) predate the marker rule; marking them is itself a kernel-zone edit, see AGENTS.md "Rules for the fork"'],
]
/**
 * A hook that is PURE PARAMETERISATION needs no marker of its own: the added
 * lines are upstream's removed lines with a literal swapped for a build flag,
 * and the marker is on the flag's definition. These lines are text inside
 * template literals (the shipped tooling comment, the loader), where a comment
 * would become bytes in every file. The test is equality after substituting
 * each flag's upstream default back, so nothing else on the line rides through.
 */
const PARAMS: Array<[string, string]> = [
  ["${llmsUrl === 'none' ? '' : `; agent index: ${llmsUrl}`}", '; agent index: https://bento.page/llms.txt'],
  ['${schemaUrl}', 'https://bento.page/schema/slides.json'],
  ['${agentsUrl}', 'https://bento.page/agents.md'],
  ['${failName}', 'bento/dash spreadsheet'],
]
const deparam = (line: string) => PARAMS.reduce((l, [from, to]) => l.split(from).join(to), line)

/**
 * The 1-based lines of `text` on which a COMMENT carries the token. A marker
 * is a comment: a string, a template literal or a regex that happens to say
 * `// BETA FORK` is data.
 *
 * JavaScript cannot be lexed a line at a time (a regex literal, a template
 * literal and a block comment all change what `/*` and a quote mean), and two
 * rounds of an independent tester showed every line-level rule has a one-line
 * counterexample. So for script files this asks the TypeScript compiler, which
 * the build already installs, for the file's real comment ranges. The other
 * languages here have no such ambiguity, and a small scanner reads each
 * comment only as far as its closing delimiter.
 */
export function markerLines(file: string, text: string): Set<number> {
  const out = new Set<number>()
  const mark = (from: number, to: number) => {
    const body = text.slice(from, to)
    let at = body.indexOf(TOKEN)
    while (at >= 0) {
      out.add(text.slice(0, from + at).split('\n').length)
      at = body.indexOf(TOKEN, at + 1)
    }
  }
  const ext = file.slice(file.lastIndexOf('.') + 1)
  if (['ts', 'tsx', 'mts', 'js', 'mjs', 'cjs'].includes(ext)) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /*setParentNodes*/ false, ext.startsWith('ts') || ext === 'mts' ? ts.ScriptKind.TS : ts.ScriptKind.JS)
    const seen = new Set<number>()
    const take = (ranges: readonly { pos: number; end: number }[] | undefined) => {
      for (const r of ranges ?? []) if (!seen.has(r.pos)) { seen.add(r.pos); mark(r.pos, r.end) }
    }
    const walk = (node: import('typescript').Node) => {
      // every token's leading and trailing trivia, which is where comments live
      take(ts.getLeadingCommentRanges(text, node.getFullStart()))
      take(ts.getTrailingCommentRanges(text, node.getEnd()))
      // getChildren, not forEachChild: punctuation is a token too, and a
      // comment after a comma or an opening brace trails THAT token
      for (const child of node.getChildren(sf)) walk(child)
    }
    walk(sf)
    take(ts.getLeadingCommentRanges(text, sf.endOfFileToken.getFullStart()))
    return out
  }
  // The other languages. No comment DETECTION here: a marker counts only in a
  // form a string cannot take.
  //   css, html   the line OPENS with the comment, or ENDS with a complete
  //               one that has no quote in it (a string would have to close
  //               after it, so the line could not end there)
  //   toml, yaml  a `#` comment outside quotes, on a line that is not content
  //               of a multi-line string (TOML triple quotes) or of a block
  //               scalar (YAML `|` and `>`), which this tracks line by line
  const lines = text.split('\n')
  const css = [/^\s*\/\*[^\n]*BETA FORK/, /\/\*[^*"'\n]*BETA FORK[^*"'\n]*\*\/\s*$/]
  const html = [/^\s*<!--[^\n]*BETA FORK/, /<!--[^"'>\n]*BETA FORK[^"'>\n]*-->\s*$/, ...css]
  const hashComment = (l: string) => {
    // drop single-line quoted strings, then the comment is everything after a # that starts a word
    const bare = l.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')
    const at = bare.search(/(^|\s)#/)
    return at >= 0 && bare.slice(at).includes(TOKEN)
  }
  if (ext === 'css') lines.forEach((l, i) => { if (css.some((r) => r.test(l))) out.add(i + 1) })
  else if (ext === 'html') lines.forEach((l, i) => { if (html.some((r) => r.test(l))) out.add(i + 1) })
  else if (ext === 'toml') {
    let inString = false
    lines.forEach((l, i) => {
      const fences = (l.match(/"""|'''/g) ?? []).length
      if (!inString && fences === 0 && hashComment(l)) out.add(i + 1)
      if (fences % 2 === 1) inString = !inString
    })
  } else if (['yml', 'yaml'].includes(ext)) {
    let block = -1 // indent of the key that opened a block scalar, or -1
    lines.forEach((l, i) => {
      const indent = l.search(/\S/)
      if (block >= 0) {
        if (indent < 0 || indent > block) return // blank, or the scalar's content
        block = -1
      }
      if (hashComment(l)) out.add(i + 1)
      if (/(?::|^\s*-)\s*[|>][+-]?\d*\s*(?:#.*)?$/.test(l.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""'))) block = indent
    })
  }
  return out
}

export interface Hook { file: string; line: number; text: string; marked: boolean }

/** Every added hunk of a unified -U0 diff of ONE file, with whether it is marked. `after` is the fork's file. */
export function hooksOf(file: string, diff: string, after: string[]): Hook[] {
  const out: Hook[] = []
  const markers = markerLines(file, after.join('\n'))
  const re = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@.*\n((?:[-+\\].*\n?)*)/gm
  for (let m; (m = re.exec(diff)); ) {
    const added = m[3].split('\n').filter((l) => l.startsWith('+')).map((l) => l.slice(1))
    const removed = m[3].split('\n').filter((l) => l.startsWith('-')).map((l) => l.slice(1))
    if (!added.length) continue
    const line = Number(m[1])
    // One contiguous run of added lines is ONE hook (it is one region at the
    // next merge), and its marker heads it: on one of its first lines or just
    // above. A marker further down does not reach back, and one in a string
    // is not a marker.
    const parameterised = added.length === removed.length && added.some((l) => PARAMS.some(([from]) => l.includes(from)))
      && added.every((l, i) => deparam(l) === removed[i])
    // lines line-NEAR .. line+NEAR of the fork's file: just above the hook, or its head
    let marked = parameterised
    for (let n = Math.max(1, line - NEAR); n <= line + Math.min(NEAR, added.length - 1) && !marked; n++) marked = markers.has(n)
    out.push({ file, line, text: added[0].trim().slice(0, 100), marked })
  }
  return out
}

const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] })

let checks = 0
let failures = 0
function ok(cond: unknown, what: string) {
  checks++
  if (!cond) failures++
  if (!cond || !process.argv.includes('--quiet')) console.log(`${cond ? '  ok  ' : '  FAIL'}  ${what}`)
}

console.log('the rule itself (no git needed)')
{
  const after = ['a', 'b', 'c', 'const x = 1', 'e', 'f', '// BETA FORK: why', 'g', 'h', 'i', 'j', 'k']
  const diff = ['@@ -3,0 +4 @@', '+const x = 1', '@@ -6,0 +8,2 @@', '+g', '+h', '@@ -9,0 +12 @@', '+k', ''].join('\n')
  const hooks = hooksOf('slides/src/editor/editor.ts', diff, after)
  ok(hooks.length === 3 && hooks[0].marked === false && hooks[0].line === 4, 'a hook with no marker in it or just above it is unmarked, with its line (AE12)')
  ok(hooks[1].marked === true, 'a hook under a marked comment is marked')
  ok(hooks[2].marked === false, `and a marker more than ${NEAR} lines above does not reach`)
  ok(hooksOf('x.ts', '@@ -1 +1 @@\n-old\n+new // BETA FORK\n', ['new // BETA FORK'])[0].marked, 'a marker on the changed line itself counts')
  ok(hooksOf('x.ts', '@@ -1,2 +0,0 @@\n-gone\n-gone\n', []).length === 0, 'a pure deletion is not a hook to mark')
}

// From the independent break round (U4): these must fail closed, not merely find a token.
{
  const file = 'slides/src/editor/editor.ts'
  const stringLine = 'const caption = "BETA FORK"; enableNewFeature()'
  const stringHook = hooksOf(file, '@@ -0,0 +1 @@\n+' + stringLine + '\n', [stringLine])[0]
  ok(!stringHook.marked && stringHook.file === file && stringHook.line === 1, 'a string that says BETA FORK does not mark a hook: the marker is a comment')
  // a contiguous run of added lines is one hook, and its marker heads it
  const late = ['firstFeature()', '', '', '', '', '// BETA FORK: too late', 'second()']
  ok(!hooksOf(file, '@@ -0,0 +1,7 @@\n' + late.map((l) => '+' + l).join('\n') + '\n', late)[0].marked, `a marker more than ${NEAR} lines into a hook does not reach back to its head`)
  const headed = ['// BETA FORK: one feature', 'a()', '', '', '', 'b()']
  ok(hooksOf(file, '@@ -0,0 +1,6 @@\n' + headed.map((l) => '+' + l).join('\n') + '\n', headed)[0].marked, 'a hook headed by its marker is marked as a whole, however long')
  const escaped = 'sendSecret(`${schemaUrl}`)'
  ok(!hooksOf('scripts/postbuild-compress.mjs', '@@ -0,0 +1 @@\n+' + escaped + '\n', [escaped])[0].marked, 'code that merely uses schemaUrl is not the tooling-comment line and is not exempt')
}

// From break round 2: comment syntax inside a literal is still data, not a marker.
{
  const file = 'slides/src/editor/editor.ts'
  for (const line of ['const caption = "// BETA FORK"; enableNewFeature()',
    'const caption = "# BETA FORK"; enableNewFeature()',
    'const caption = `<!-- BETA FORK -->`; enableNewFeature()']) {
    const hook = hooksOf(file, '@@ -0,0 +1 @@\n+' + line + '\n', [line])[0]
    ok(!hook.marked && hook.file === file && hook.line === 1, `comment syntax inside a string is not a marker: ${line}`)
  }
  const line = "    fail('<b>This is a ${failName}.</b><br>Opening it needs a browser released in 2023 or later '); enableNewFeature()"
  ok(!hooksOf('scripts/postbuild-compress.mjs', '@@ -0,0 +1 @@\n+' + line + '\n', [line])[0].marked,
    'code appended to an exempt template line is not exempt')
}

// From break round 3: lexical boundaries a line-level rule gets wrong.
{
  const file = 'slides/src/editor/editor.ts'
  const cases = [
    ['a closed ordinary comment cannot lend comment status to a later string', '/* ordinary note */ const caption = "BETA FORK"; enableNewFeature()'],
    ['a regex character class is not a block comment', 'const pattern = /[/*]BETA FORK/; enableNewFeature()'],
  ]
  for (const [name, line] of cases) {
    const hook = hooksOf(file, '@@ -0,0 +1 @@\n+' + line + '\n', [line])[0]
    ok(!hook.marked && hook.file === file && hook.line === 1, `${name}; the unmarked hook names ${file}:1`)
  }
  const line = '/* ordinary note */ enableNewFeature() // BETA FORK: deliberate hook'
  ok(hooksOf(file, '@@ -0,0 +1 @@\n+' + line + '\n', [line])[0].marked,
    'a real marker after a closed ordinary comment still counts')
}

// From break round 4: the other languages have strings too, and none of these is a comment.
{
  const fixtures = [
    { file: 'slides/src/styles.css', lines: ['.sample::after { content: "/* BETA FORK */"; color: red; }'] },
    { file: 'slides/index.html', lines: ['<div title="<!-- BETA FORK -->" class="new-feature">Hello</div>'] },
    { file: 'server/sync-worker/wrangler.toml', lines: ['[vars]', 'CAPTION = \"\"\"', '# BETA FORK', '\"\"\"'] },
    { file: '.github/workflows/ci.yml', lines: ['env:', '  CAPTION: |', '    # BETA FORK', '    this is scalar data'] },
  ]
  for (const { file, lines } of fixtures) {
    const diff = `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => '+' + l).join('\n')}\n`
    const hook = hooksOf(file, diff, lines)[0]
    ok(!hook.marked && hook.file === file && hook.line === 1,
      `comment syntax inside a string or scalar does not mark ${file}:1 (marked=${hook.marked})`)
  }
  const lines = ['/* BETA FORK: the actual CSS hook */', '.sample { color: red; }']
  ok(hooksOf('slides/src/styles.css', '@@ -0,0 +1,2 @@\n' + lines.map((l) => '+' + l).join('\n') + '\n', lines)[0].marked,
    'a real CSS comment still marks the hook')
}

console.log('\nthe upstream this fork tracks')
const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
const tag = /Upstream base: `(v\d+\.\d+\.\d+)`/.exec(agents)?.[1]
ok(!!tag, `AGENTS.md names the upstream tag the fork is merged up to (${tag ?? 'missing: add "Upstream base: `vX.Y.Z`" to the Beta fork section'})`)
if (tag) {
  let have = false
  try { git('rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`); have = true } catch { /* fetched below */ }
  if (!have) {
    // CI checks out one commit of the fork and no tags: ask upstream for this one.
    try { git('fetch', '--quiet', '--depth', '1', UPSTREAM, `refs/tags/${tag}:refs/tags/${tag}`); have = true } catch (e) { console.log(`  (could not fetch ${tag} from ${UPSTREAM}: ${String((e as Error).message).split('\n')[0]})`) }
  }
  ok(have, `the upstream tag ${tag} is available to diff against`)
  if (have) {
    // against the working tree, so a hook is caught before it is committed (in CI the two are the same)
    const changed = git('diff', '--name-only', '--diff-filter=M', tag).split('\n').filter(Boolean)
    const scoped = changed.filter((f) => IN_SCOPE.test(f) && !EXEMPT.some(([r]) => r.test(f)))
    const all: Hook[] = []
    const stale: string[] = []
    for (const file of scoped) {
      const after = readFileSync(join(root, file), 'utf8').split('\n')
      all.push(...hooksOf(file, git('diff', '-U0', tag, '--', file), after))
      const theirs = new Set(git('show', `${tag}:${file}`).split('\n').filter((l) => l.includes(TOKEN)))
      for (const l of after) if (theirs.has(l)) stale.push(`${file}: ${l.trim().slice(0, 90)}`)
    }
    if (process.argv.includes('--list')) for (const h of all) console.log(`    ${h.marked ? 'marked  ' : 'UNMARKED'} ${h.file}:${h.line}  ${h.text}`)
    const unmarked = all.filter((h) => !h.marked)
    console.log(`\n${all.length} Beta hooks in ${scoped.length} upstream files`)
    ok(all.length > 50, 'the diff found the fork (a rig that finds no hooks is checking nothing)')
    ok(unmarked.length === 0, `every hook carries ${TOKEN}${unmarked.length ? `; ${unmarked.length} do not:` : ''}`)
    for (const h of unmarked) console.log(`        ${h.file}:${h.line}  ${h.text}`)
    ok(stale.length === 0, `no marker sits on a line upstream carries byte for byte${stale.length ? ': ' + stale.slice(0, 5).join(' | ') : ''}`)
    const old = scoped.filter((f) => /\bBeta build\b/.test(readFileSync(join(root, f), 'utf8')))
    // "Beta build" still reads fine in prose (the Beta build of slides); as a HOOK marker it is retired.
    const oldMarkers = old.flatMap((f) => readFileSync(join(root, f), 'utf8').split('\n').map((l, i) => [f, i + 1, l] as const).filter(([, , l]) => /(\/\/|\/\*|\*|#)\s*Beta build\b[^.]*[:(,]/.test(l) && !l.includes(TOKEN)))
    ok(oldMarkers.length === 0, `no hook is still marked with the old spelling "Beta build"${oldMarkers.length ? ': ' + oldMarkers.slice(0, 5).map(([f, n]) => `${f}:${n}`).join(', ') : ''}`)
    for (const [r, why] of EXEMPT) console.log(`    exempt ${r}: ${why}`)
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.log(`\nA Beta change inside an upstream file with no ${TOKEN} marker is a hook the next upstream merge will not find.\nMark it where it stands (a comment on the line or directly above), or move the code into a Beta-owned file.`)
  process.exit(1)
}
