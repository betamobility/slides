// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// The two pages the deck store serves itself: the index (every deck in the
// store) and /new (the handoff target for a deck on file://). Template
// strings, no framework; every value that came from a deck or a person is
// escaped on the way in, because a deck title is untrusted text (KTD7).
//
// Styling follows Beta's design system with the eight semantic tokens
// inlined: cream surface, charcoal ink, Playfair Display for the one
// headline, Inter for body, DM Mono for numbers and tags.

export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const PLAUSIBLE = '<script defer data-domain="betamobility.ai" src="https://plausible.io/js/script.js"></script>'

const CSS = `
:root{--color-surface:#F5F3EF;--color-surface-alt:#F0EDE8;--color-surface-emphasis:#1A1A1A;--color-on-surface:#1A1A1A;--color-on-surface-muted:#666666;--color-on-surface-subtle:#999999;--color-on-emphasis:#FFFFFF;--color-border:rgba(26,26,26,0.15);--font-serif:'Playfair Display',Georgia,'Times New Roman',serif;--font-sans:'Neue Montreal',Inter,'Helvetica Neue',Arial,sans-serif;--font-mono:'DM Mono',ui-monospace,Menlo,Consolas,monospace;--radius-md:8px;--radius-full:999px}
*{box-sizing:border-box}
html{background:var(--color-surface);color:var(--color-on-surface)}
body{margin:0;font-family:var(--font-sans);font-size:1rem;line-height:1.5;-webkit-font-smoothing:antialiased}
main{max-width:64rem;margin:0 auto;padding:3rem 1.5rem 4rem}
header{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:2rem}
.mark{font-family:var(--font-mono);font-size:.75rem;letter-spacing:.02em;color:var(--color-on-surface-muted)}
h1{font-family:var(--font-serif);font-weight:500;font-size:clamp(1.75rem,4vw,2.625rem);line-height:1.15;margin:.25rem 0 0}
.who{font-family:var(--font-mono);font-size:.75rem;color:var(--color-on-surface-muted)}
p{margin:0 0 1rem;max-width:40rem}
.muted{color:var(--color-on-surface-muted)}
table{width:100%;border-collapse:collapse;font-size:.875rem}
th,td{text-align:left;padding:.65rem .5rem;border-bottom:1px solid var(--color-border);vertical-align:top}
th{font-weight:500;color:var(--color-on-surface-muted);font-size:.75rem;font-family:var(--font-mono);letter-spacing:.02em}
td.num,td.tag,td.time{font-family:var(--font-mono);font-size:.8125rem;white-space:nowrap}
td.tag span{border:1px solid var(--color-border);border-radius:var(--radius-full);padding:.05rem .5rem;font-size:.75rem}
a{color:inherit;text-decoration:underline;text-underline-offset:.15em}
a.deck{font-weight:500;text-decoration:none}
a.deck:hover{text-decoration:underline}
.wrap{overflow-x:auto}
.empty{border:1px solid var(--color-border);border-radius:var(--radius-md);padding:1.5rem;color:var(--color-on-surface-muted)}
.card{border:1px solid var(--color-border);border-radius:var(--radius-md);padding:1.5rem;background:var(--color-surface-alt);max-width:36rem}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.35rem 1.25rem;margin:0 0 1.25rem}
dt{font-family:var(--font-mono);font-size:.75rem;color:var(--color-on-surface-muted);padding-top:.15rem}
dd{margin:0;overflow-wrap:anywhere}
dd.num{font-family:var(--font-mono)}
button{font:inherit;font-weight:500;border:1px solid var(--color-on-surface);background:var(--color-surface-emphasis);color:var(--color-on-emphasis);border-radius:var(--radius-full);padding:.55rem 1.25rem;cursor:pointer}
button:disabled{opacity:.45;cursor:default}
button.secondary{background:transparent;color:var(--color-on-surface)}
.row{display:flex;gap:.75rem;align-items:center;flex-wrap:wrap}
.status{font-family:var(--font-mono);font-size:.8125rem;color:var(--color-on-surface-muted);min-height:1.5rem}
.link{font-family:var(--font-mono);font-size:.8125rem;overflow-wrap:anywhere}
footer{margin-top:3rem;font-size:.875rem;color:var(--color-on-surface-subtle)}
`

const head = (title) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500&family=Inter:wght@400;500&family=DM+Mono:wght@400&display=swap">
<style>${CSS}</style>
${PLAUSIBLE}
</head>`

function fmtSize(n) {
  n = Number(n) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
function fmtTime(iso) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}

/**
 * The index: every deck in the store, newest first. `decks` is the list the
 * API returns; `who` is the signed-in identity.
 */
export function indexPage(decks, who) {
  const rows = decks.map((d) => `<tr>
<td><a class="deck" href="${esc(d.url)}">${esc(d.title) || '<span class="muted">Untitled</span>'}</a></td>
<td class="tag"><span>${esc(d.kind)}</span></td>
<td>${esc(d.owner)}</td>
<td>${esc(d.writer)}</td>
<td class="time">${esc(fmtTime(d.updated))}</td>
<td class="num">${esc(fmtSize(d.size))}</td>
</tr>`).join('\n')
  const body = decks.length
    ? `<div class="wrap"><table>
<thead><tr><th>Deck</th><th>Kind</th><th>Owner</th><th>Last writer</th><th>Updated</th><th>Size</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`
    : `<div class="empty">No decks yet. Open a deck and pick <strong>Save to Beta</strong> in its Share panel.</div>`
  return `${head('Beta decks')}
<body>
<main>
<header>
<div><div class="mark">bento/slides · Beta</div><h1>Decks</h1></div>
<div class="who">${esc(who)}</div>
</header>
<p class="muted">Every deck saved to Beta, newest first. Anyone signed in here can open and edit any of them; the link is the invitation.</p>
${body}
<footer>Stored at decks.betamobility.ai. A deck opened from a link saves back here with ⌘S.</footer>
</main>
</body>
</html>
`
}

/**
 * /new: the handoff target. A deck on file:// opens this page in a tab and
 * posts its serialized document once the page announces itself. The page
 * shows the title and size and uploads ONLY when the person clicks Save.
 * Nothing is stored on message receipt; one document is accepted, from the
 * opener only, and later ones are discarded.
 */
export function newPage(who) {
  return `${head('Save to Beta')}
<body>
<main>
<header>
<div><div class="mark">bento/slides · Beta</div><h1>Save to Beta</h1></div>
<div class="who">${esc(who)}</div>
</header>
<div class="card">
<p id="intro" class="muted">Waiting for the deck. Keep this tab open; the deck sends its document here.</p>
<dl>
<dt>Deck</dt><dd id="title">…</dd>
<dt>Size</dt><dd id="size" class="num">…</dd>
</dl>
<div class="row">
<button id="save" disabled>Save to Beta</button>
<button id="close" class="secondary" type="button">Close</button>
</div>
<p id="status" class="status"></p>
<p id="result" class="link" hidden></p>
</div>
<footer>The document stays in this tab until you click Save.</footer>
</main>
<script>
(function () {
  var doc = null, received = false, title = '', bytes = 0
  var $ = function (id) { return document.getElementById(id) }
  var saveBtn = $('save'), statusEl = $('status')

  function size(n) { return n < 1024 * 1024 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB' }
  function titleOf(html) {
    var m = /<script[^>]*\\bid=["']?bento-doc["']?[^>]*>([\\s\\S]*?)<\\/script>/i.exec(html)
    if (!m) return ''
    try { var d = JSON.parse(m[1]); return d.format === 'bento/enc' ? 'Encrypted deck' : String(d.title || '') } catch (e) { return '' }
  }

  // One document, from the opener only, and only the first one.
  window.addEventListener('message', function (e) {
    if (!window.opener || e.source !== window.opener) return
    if (!e.data || e.data.type !== 'bento-store-save' || typeof e.data.html !== 'string') return
    if (received) return
    received = true
    doc = e.data.html
    bytes = new TextEncoder().encode(doc).length
    title = typeof e.data.title === 'string' && e.data.title ? e.data.title : titleOf(doc)
    $('title').textContent = title || 'Untitled'
    $('size').textContent = size(bytes)
    $('intro').textContent = 'The deck is here. Save it to Beta, or close this tab to keep it on disk only.'
    saveBtn.disabled = false
  })

  function save() {
    if (!doc) return
    saveBtn.disabled = true
    statusEl.textContent = 'Saving…'
    fetch('/api/decks', { method: 'POST', body: doc, credentials: 'same-origin', redirect: 'manual',
      headers: { 'content-type': 'text/html; charset=utf-8' } })
      .then(function (r) {
        if (r.type === 'opaqueredirect' || r.status === 401) throw new Error('Signed out. Reload this tab to sign in, then try again.')
        if (!r.ok) return r.text().then(function (t) { throw new Error('The store refused the deck (' + r.status + (t ? ': ' + t : '') + ').') })
        return r.json()
      })
      .then(function (j) {
        statusEl.textContent = 'Saved.'
        var res = $('result')
        res.hidden = false
        res.innerHTML = ''
        var a = document.createElement('a'); a.href = j.url; a.textContent = j.url; res.appendChild(a)
        if (window.opener) window.opener.postMessage({ type: 'bento-store-saved', url: j.url }, '*')
      })
      .catch(function (err) {
        statusEl.textContent = err && err.message ? err.message : 'Save failed.'
        saveBtn.disabled = false
      })
  }
  saveBtn.addEventListener('click', save)
  $('close').addEventListener('click', function () { window.close() })

  // Announce readiness. The opener is a file:// deck with a null origin, so
  // the target must be '*'; the deck checks event.origin and event.source.
  if (window.opener) window.opener.postMessage({ type: 'bento-store-ready' }, '*')
  else $('intro').textContent = 'Open this page from a deck: Share panel, Save to Beta.'
})()
</script>
</body>
</html>
`
}
