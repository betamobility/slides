// Imported FIRST by a node rig whose subject reaches the i18n module: that
// module reads the shell's language packs from `document` when it loads. In
// node there is no shell, so it finds none and falls back to English, which
// is what the rig's assertions are written in.
const g = globalThis as Record<string, unknown>
g.document ??= { querySelectorAll: () => [], querySelector: () => null, documentElement: { lang: 'en' } }
export {}
