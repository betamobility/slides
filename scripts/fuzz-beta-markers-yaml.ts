// The marker rig's YAML reading (scripts/test-beta-markers.ts markerLines)
// against a real YAML parser, Ruby's Psych, as the reference: random workflow-
// shaped documents with block scalars in every header form (tags, anchors,
// indicator orders, a header on its own line, sequence items, nesting) and
// numbered `# BETA FORK` lines at random depths. Ruby says which of them are
// string data; the rig must count exactly the others.
//
//   node scripts/fuzz-beta-markers-yaml.ts [seed] [documents]
//
// Local, not a CI rig (it needs Ruby and is not a test-* file). Added after
// Codex U3+U4 rounds 7 to 9 each found a hole in a hand-written rule; the
// rule before this one fails it (131 counted though string data on seed 1).
import { execFileSync } from 'node:child_process'
const { markerLines } = await import(new URL('./test-beta-markers.ts', import.meta.url).href)
let seed = Number(process.argv[2] ?? 1)
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]
const props = ['', '!!str ', '&a ', '!!str &b ', '&c !!str ', '!<tag:yaml.org,2002:str> ', '!<x>y> ']
const inds = ['|', '>', '|-', '|+', '>-', '>+', '|2', '>1', '|2-', '|-2', '>+3', '|1+']
const N = Number(process.argv[3] ?? 400)
const docs: string[][] = []
for (let d = 0; d < N; d++) {
  const lines: string[] = []
  let m = 0
  const marker = (ind: number) => lines.push(' '.repeat(ind) + `# BETA FORK m${m++}`)
  const block = (keyCol: number, prefix: string) => {
    const own = rnd() < 0.25
    const hdr = pick(props) + pick(inds)
    const digit = Number(/[1-9]/.exec(hdr.replace(/^.*[|>]/, ''))?.[0] ?? 0)
    if (own) { lines.push(prefix); lines.push(' '.repeat(keyCol + 2) + hdr) } else lines.push(prefix + ' ' + hdr)
    const content = digit ? keyCol + digit : keyCol + 2 + Math.floor(rnd() * 3)
    const n = 1 + Math.floor(rnd() * 3)
    for (let i = 0; i < n; i++) {
      const r = rnd()
      if (r < 0.3) marker(content + Math.floor(rnd() * 2))
      else if (r < 0.4) lines.push('')
      else if (r < 0.5) lines.push(' '.repeat(content) + pick(['\u00a0', '\t']) + 'text ' + i) // content starting with a non-space blank
      else lines.push(' '.repeat(content) + 'text ' + i)
    }
    if (rnd() < 0.5) marker(Math.max(0, keyCol - Math.floor(rnd() * 2) * 2))
  }
  const entries = 1 + Math.floor(rnd() * 3)
  for (let e = 0; e < entries; e++) {
    const shape = rnd()
    if (shape < 0.15) { lines.push(`q${e}:`); const items = 1 + Math.floor(rnd() * 2); for (let it = 0; it < items; it++) block(2, `  -`) } // entries whose value is the header
    else if (shape < 0.4) block(0, `k${e}:`)
    else if (shape < 0.7) { lines.push(`s${e}:`); const items = 1 + Math.floor(rnd() * 2); for (let it = 0; it < items; it++) block(4, `  - run${it}:`) }
    else { lines.push(`n${e}:`); block(2, `  inner${e}:`) }
    if (rnd() < 0.3) marker(0)
  }
  docs.push(lines)
}
// Ruby: for each doc, which marker numbers appear inside a string value (or null when it does not parse)
const rb = `require 'yaml'
require 'json'
def strs(v, out)
  case v
  when Hash then v.each { |k, x| strs(k, out); strs(x, out) }
  when Array then v.each { |x| strs(x, out) }
  when String then out << v
  end
  out
end
docs = JSON.parse(STDIN.read)
res = docs.map do |d|
  begin
    s = strs(YAML.load(d.join("\\n") + "\\n"), []).join("\\n")
    s.scan(/BETA FORK m(\\d+)/).flatten.map(&:to_i)
  rescue Exception
    nil
  end
end
puts JSON.generate(res)
`
const ruby = JSON.parse(execFileSync('ruby', ['-e', rb], { input: JSON.stringify(docs), maxBuffer: 1 << 26 }).toString())
let parsed = 0, markers = 0, falseMark = 0, falseRefuse = 0
const shown: string[] = []
docs.forEach((lines, d) => {
  if (ruby[d] === null) return
  parsed++
  const marked = markerLines('.github/workflows/x.yml', lines.join('\n'))
  const inText = new Set<number>(ruby[d])
  lines.forEach((l, i) => {
    const mm = /# BETA FORK m(\d+)/.exec(l); if (!mm) return
    markers++
    const n = Number(mm[1]), counts = marked.has(i + 1)
    if (counts && inText.has(n)) { falseMark++; if (shown.length < 3) shown.push('FALSE MARK\n' + lines.join('\n') + `\n(line ${i + 1})`) }
    if (!counts && !inText.has(n)) { falseRefuse++; if (shown.length < 3) shown.push('FALSE REFUSE\n' + lines.join('\n') + `\n(line ${i + 1})`) }
  })
})
console.log(`YAMLFUZZ seed ${process.argv[2] ?? 1}: ${parsed}/${N} documents parsed by Ruby, ${markers} marker lines, ${falseMark} counted though string data, ${falseRefuse} refused though a comment`)
for (const x of shown) console.log(x + '\n---')
if (falseMark || falseRefuse) process.exit(1)
