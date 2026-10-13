#!/usr/bin/env node
// Round 2: execute Editor.save with the actual queue, rather than checking source spelling.
// slides/node_modules/.bin/esbuild scripts/test-beta-merge-manual-outcomes.ts --bundle --platform=node --format=esm --outfile=/tmp/beta-merge-manual-outcomes.mjs
// node /tmp/beta-merge-manual-outcomes.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { newDoc } from '../slides/src/model.ts'
import { createSaveQueue, saveRevision } from '../slides/src/saving.ts'
import { StoreConflictError, StoreSignedOutError } from '../slides/src/beta/store.ts'
const ts = createRequire(process.cwd() + '/slides/package.json')('typescript')
const ast = ts.createSourceFile('editor.ts', readFileSync('slides/src/editor/editor.ts', 'utf8'), ts.ScriptTarget.Latest, true)
const cls = ast.statements.find((n: any) => ts.isClassDeclaration(n) && n.name.text === 'Editor')
const body = cls.members.find((n: any) => n.name?.getText(ast) === 'save').body.getText(ast)
function compile(source: string, deps: Record<string, any>) {
  const js = ts.transpile('async function save(forcePicker) ' + source, { target: ts.ScriptTarget.ES2022 })
  return new Function(...Object.keys(deps), js + '; return save')(...Object.values(deps))
}
for (const error of [new StoreConflictError({ writer: 'service' }), new StoreSignedOutError('Sign in again')]) {
  for (const negative of [false, true]) {
    const store: any = { doc: newDoc(), revision: 0, dirty: true, setDirty(v: boolean) { this.dirty = v } }
    let marker = false, toast = '', always: boolean | undefined, textCommitted = false, stamped = false
    const ctx: any = { store, saveQueue: createSaveQueue(store), canvas: { commitTextEdit() { textCommitted = true } }, session: { stampInto() { stamped = true } }, noteStoreConflict(_: any, force: boolean) { marker = true; always = force }, toast(s: string) { toast = s } }
    const deps = { saveRevision, saveFile: async () => { assert(textCommitted && stamped); throw error }, StoreConflictError, StoreSignedOutError, t: (s: string) => s, console: { error() {} } }
    // Negative control models the missed outcome handling from the merge, without changing product code.
    const source = negative ? body.replace(/if \(out\.kind === 'failed'\) \{[\s\S]*?\n    \}/, "if (out.kind === 'failed') { this.toast('Save failed — see console'); return }") : body
    assert(!negative || source !== body, 'negative control must actually change the method')
    await compile(source, deps).call(ctx, false)
    const oracle = () => {
      assert.equal(store.dirty, true)
      if (error instanceof StoreConflictError) { assert(marker, 'conflict must mark recovery policy'); assert.equal(always, true) }
      else assert.equal(toast, error.message, 'expired login must tell the person how to recover')
    }
    if (negative) assert.throws(oracle, 'the regression control must fail')
    else oracle()
  }
}
console.log('PASSED: manual queue failures retain dirty work and route conflict/login outcomes; both missing-hook controls rejected')
