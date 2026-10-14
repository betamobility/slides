#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// BETA FORK: run every `run:` step of the `beta` job in .github/workflows/ci.yml
// locally, in order, the way a pull request must pass before it opens.
//
//   node scripts/run-beta-job-locally.mjs "$PWD" [--skip "step name substring,..."]
//
// Not a rig (no `test-` prefix): it runs the rigs. `npm ci` is skipped; run it
// in slides/ first.
import { readFileSync, mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const repo = process.argv[2]
const skip = (process.argv[4] || '').split(',').filter(Boolean)
const lines = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8').split('\n')
const start = lines.findIndex((l) => /^  beta:/.test(l))
let end = lines.findIndex((l, i) => i > start && /^  [a-z][\w-]*:/.test(l)); if (end < 0) end = lines.length
const steps = []
let cur = null
for (let i = start; i < end; i++) {
  const l = lines[i]
  let m
  if ((m = /^      - (name|uses): (.*)$/.exec(l))) { cur = { name: m[2], run: '', wd: '.', env: {} }; steps.push(cur); continue }
  if (!cur) continue
  if ((m = /^        working-directory: (.*)$/.exec(l))) cur.wd = m[1].trim()
  else if ((m = /^        run: \|/.exec(l))) { const b = []; while (i + 1 < end && (/^          /.test(lines[i + 1]) || lines[i + 1].trim() === '')) b.push(lines[++i].replace(/^          /, '')); cur.run = b.join('\n') }
  else if ((m = /^        run: (.*)$/.exec(l))) cur.run = m[1]
  else if (/^        env:/.test(l)) { while (i + 1 < end && /^          \S/.test(lines[i + 1])) { const e = /^          ([A-Z_0-9]+): (.*)$/.exec(lines[++i]); if (e) cur.env[e[1]] = e[2].replace(/^['"]|['"]$/g, '') } }
}
const RUNNER_TEMP = mkdtempSync(join(tmpdir(), 'beta-ci-'))
let failed = 0
for (const s of steps.filter((s) => s.run)) {
  if (/^npm ci$/.test(s.run.trim())) { console.log(`SKIP  ${s.name} (installed)`); continue }
  if (skip.some((k) => s.name.includes(k))) { console.log(`SKIP  ${s.name} (deferred)`); continue }
  const t = Date.now()
  const r = spawnSync('bash', ['-eo', 'pipefail', '-c', s.run], { cwd: join(repo, s.wd), env: { ...process.env, ...s.env, RUNNER_TEMP, CI: 'true' }, encoding: 'utf8', maxBuffer: 1 << 28 })
  const okk = r.status === 0
  if (!okk) failed++
  console.log(`${okk ? 'ok   ' : 'FAIL '} ${s.name} (${Math.round((Date.now() - t) / 1000)}s)`)
  if (!okk) console.log((r.stdout + r.stderr).split('\n').filter((l) => !/^\s*ok\b/.test(l)).slice(-25).join('\n'))
}
console.log(failed ? `${failed} step(s) failed` : 'all steps passed')
process.exit(failed ? 1 : 0)
