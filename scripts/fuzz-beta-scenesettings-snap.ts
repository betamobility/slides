// Fuzz the range snapping (U10) against an independent reference: the
// reference ENUMERATES the steps (or, for wide ranges, checks the three steps
// around a coarse estimate) and picks the nearest by exact decimal distance,
// a tie going up. FUZZ_N sets the count (default 20000), FUZZ_SEED the seed.
import * as ss from '../slides/src/beta/scenesettings.ts'
import type { RuntimeProp } from '../slides/src/model.ts'

let seed = Number(process.env.FUZZ_SEED ?? 1)
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1))
const digits = (n: number) => Array.from({ length: n }, () => int(0, 9)).join('').replace(/^0+(?=\d)/, '')

// a decimal string scaled to S decimals, as a BigInt
function scaled(s: string, S: number): bigint {
  const neg = s.startsWith('-'); const [i, f = ''] = s.replace('-', '').split('.')
  const v = BigInt(i + f.padEnd(S, '0').slice(0, S)); return neg ? -v : v
}
const toStr = (v: bigint, S: number) => {
  const neg = v < 0n; let a = (neg ? -v : v).toString().padStart(S + 1, '0')
  return (neg ? '-' : '') + (S ? a.slice(0, -S) + '.' + a.slice(-S) : a)
}

function reference(minS: string, maxS: string, stepS: string, xS: string): number {
  const S = Math.max(...[minS, maxS, stepS, xS].map((x) => (x.split('.')[1] ?? '').length))
  const [min, max, step, x] = [minS, maxS, stepS, xS].map((s) => scaled(s, S))
  if (x >= max) return Number(maxS)
  if (x <= min) return Number(minS)
  const count = (max - min) / step
  let ks: bigint[]
  if (count <= 3000n) { ks = []; for (let k = 0n; k <= count + 1n; k++) ks.push(k) }
  else { const k0 = (x - min) / step; ks = [k0 - 1n, k0, k0 + 1n, k0 + 2n].filter((k) => k >= 0n) }
  let best: bigint | null = null, bestD = 0n
  for (const k of ks) {
    let c = min + k * step; if (c > max) c = max
    const d = c > x ? c - x : x - c
    if (best === null || d < bestD || (d === bestD && c > best)) { best = c; bestD = d }
  }
  return Number(toStr(best!, S))
}

const N = Number(process.env.FUZZ_N ?? 20000)
let bad = 0
for (let i = 0; i < N; i++) {
  const wide = rnd() < 0.3
  const dm = int(0, 3), ds = int(0, 3), dx = int(0, 4)
  const sign = () => (rnd() < 0.5 ? '-' : '')
  const frac = (d: number) => (d ? '.' + Array.from({ length: d }, () => int(0, 9)).join('') : '')
  const minS = sign() + (wide ? digits(int(1, 22)) : String(int(0, 50))) + frac(dm)
  const span = wide ? digits(int(1, 22)) : String(int(1, 100))
  let stepS = (wide && rnd() < 0.5 ? digits(int(1, 8)) : String(int(0, 5))) + frac(ds)
  if (/^[0.]+$/.test(stepS)) stepS = '1'
  const maxS = toStr(scaled(minS, 3) + scaled(span, 3) + scaled(frac(dm) ? '0' + frac(dm) : '0', 3), 3).replace(/\.?0+$/, '') || '0'
  if (scaled(maxS, 3) <= scaled(minS, 3)) continue
  // the input: near the range, written to at most 15 significant digits so its shortest spelling is what was written
  const xS0 = sign() + (wide ? digits(int(1, 15)) : String(int(0, 160))) + frac(dx)
  const xn = Number(xS0); if (!Number.isFinite(xn)) continue
  const xS = String(xn); if (/e/.test(xS)) continue
  const format = `range:${minS}:${maxS}:${stepS}`
  const prop: RuntimeProp = { key: 'n', label: 'N', kind: 'number', default: 0, format }
  if (!ss.parseHint(format, 'number')) continue
  const want = reference(minS, maxS, stepS, xS)
  const got = ss.coerce(prop, xn).value
  const viaPreset = ss.applyPreset([prop], { name: 'p', values: { n: xn } }).n
  if (got !== want || viaPreset !== want) {
    if (bad++ < 10) console.log(`MISMATCH ${format} x=${xS}: got ${got}, preset ${viaPreset}, want ${want}`)
  }
}
console.log(`${N} cases, ${bad} mismatches`)
if (bad) process.exit(1)
