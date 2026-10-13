import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// base './' so builds open from file:// or any static host.
// SINGLEFILE=1 → everything (JS, CSS, assets) inlined into one HTML file:
// that file IS the Bento document format.
// BETA FORK: pptxgenjs (the PowerPoint export) reaches for node:fs and
// node:https through dynamic imports it only takes under node. In a browser
// bundle vite wraps each in a helper that is handed `import.meta.url`, and
// that one token makes the whole bundle a module-only script. The shell's
// loader starts the runtime as an inline script first, then through
// new Function, and neither can run a module-only script: every boot fell
// through to the blob import, with an error in the console on each load and
// no boot at all where blob: is refused (SharePoint, the Teams pane). The
// imports are dead in a browser, so they are replaced where they stand.
const noNodeImports = {
  name: 'beta-pptxgenjs-no-node-imports',
  transform(code: string, id: string) {
    if (!/[\\/]pptxgenjs[\\/]/.test(id) || !code.includes("import('node:")) return null
    return { code: code.replace(/import\('node:[a-z/]+'\)/g, 'Promise.resolve({})'), map: null }
  },
}

export default defineConfig({
  base: './',
  // The app version baked into every shipped shell — what update checks
  // compare against the release manifest. Single source: package.json.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [noNodeImports, ...(process.env.SINGLEFILE ? [viteSingleFile()] : [])], // BETA FORK
  // Dev-only: allow serving ../kernel (shared TS-source kernel) — without a
  // workspace root, vite's fs allow-list stops at the app dir. Build output
  // is unaffected (rollup has no such restriction).
  server: { fs: { allow: ['..'] } },
  build: {
    // Keep asset inlining aggressive; a Bento file must have zero external requests.
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4096,
  },
})
