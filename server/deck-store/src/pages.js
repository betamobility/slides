// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Beta Mobility
// The two pages the deck store serves itself: the index (every deck in the
// store) and /new. Template strings, no framework; every value that came from
// a deck or a person is escaped on the way in, because a deck title is
// untrusted text (KTD7).
//
// /new serves TWO audiences from one page, told apart by `window.opener`
// (2026-09-10 plan, KTD6/KTD9). A deck on file:// opens it and hands over its
// document — that protocol is shipped code on the other side and does not
// change. A person opening it directly gets a blank deck made for them: the
// page fetches the public blank template, mints a docId into it and posts the
// result, so the stored bytes are a real deck with one stable identity from
// the outset, rather than a template that would mint a different docId on
// every open.
//
// Styling follows Beta's design system with the eight semantic tokens
// inlined: cream surface, charcoal ink, Playfair Display for the one
// headline, Inter for body, DM Mono for numbers and tags.

export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/**
 * Put `docId` into a template's #bento-doc block and clear the template flag,
 * returning the whole file. This is the ONE piece of logic a blank-deck create
 * runs over bytes.
 *
 * It used to be inlined into /new verbatim (via `.toString()`), because the
 * browser did the minting; `GET /new/blank` does it in the worker now and
 * imports this directly. It stays ES5-plain and free of template-literal
 * interpolation anyway: the cost is nil and the constraint is one edit away
 * from mattering again if anything is ever inlined back into a page.
 *
 * The re-serialized JSON escapes `<` the way every builder in this repo does,
 * and the function refuses rather than emit a block a browser would cut short
 * (AGENTS.md hard rule 1).
 */
export function mintDocIntoBlock(html, docId) {
  var re = /(<script\b[^>]*\bid=["']?bento-doc["']?[^>]*>)([\s\S]*?)(<\/script>)/i
  var m = re.exec(html)
  if (!m) throw new Error('no #bento-doc block in the template')
  var doc = JSON.parse(m[2])
  if (!doc || doc.format !== 'bento/slides') throw new Error('the template is not a bento/slides document')
  delete doc.template
  delete doc.collab
  doc.docId = docId
  var json = JSON.stringify(doc).replace(/</g, '\\u003c')
  if (json.indexOf('</scr' + 'ipt') !== -1) throw new Error('a literal closing script tag survived escaping')
  return html.slice(0, m.index) + m[1] + json + m[3] + html.slice(m.index + m[0].length)
}

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
.kind{font-family:var(--font-mono);font-size:.6875rem;color:var(--color-on-surface-muted);border:1px solid var(--color-border);border-radius:var(--radius-full);padding:.05rem .45rem;margin-left:.4rem;white-space:nowrap}
.lede{display:flex;align-items:flex-start;justify-content:space-between;gap:1.5rem;flex-wrap:wrap;margin-bottom:1.75rem}
.lede p{margin:0}
a.cta{background:var(--color-surface-emphasis);color:var(--color-on-emphasis);border-radius:var(--radius-full);padding:.55rem 1.25rem;text-decoration:none;font-weight:500;white-space:nowrap;flex:none}
a.cta:hover{opacity:.88}
footer p{margin:0 0 .5rem}
footer pre{font-family:var(--font-mono);font-size:.8125rem;background:var(--color-surface-alt);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:.75rem 1rem;overflow-x:auto;color:var(--color-on-surface-muted);margin:0}
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
 * The index: every deck in the store, newest first, and the place a colleague
 * starts work (2026-09-10 plan, U4/R1/R10). `decks` is the list the API
 * returns; `who` is the signed-in identity; `create` is the NEW_ENABLED flag,
 * which is the only thing that decides whether New deck is offered.
 *
 * What leads is what someone came for: the New deck action, then the deck's
 * title and when it last changed. Owner, last writer and size are still here
 * — that is how you find your own — but they are not the first thing read.
 * `kind` is shown only when it is worth knowing, i.e. not an ordinary deck.
 */
export function indexPage(decks, who, { create = false } = {}) {
  const rows = decks.map((d) => `<tr>
<td><a class="deck" href="${esc(d.url)}">${esc(d.title) || '<span class="muted">Untitled</span>'}</a>${
    d.kind && d.kind !== 'deck' ? ` <span class="kind">${esc(d.kind)}</span>` : ''}</td>
<td class="time">${esc(fmtTime(d.updated))}</td>
<td class="muted">${esc(d.owner)}</td>
<td class="muted">${esc(d.writer)}</td>
<td class="num muted">${esc(fmtSize(d.size))}</td>
</tr>`).join('\n')
  const newLink = create
    ? '<a class="cta" href="/new/blank">New deck</a>'
    : ''
  const body = decks.length
    ? `<div class="wrap"><table>
<thead><tr><th>Deck</th><th>Updated</th><th>Owner</th><th>Last writer</th><th>Size</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`
    : `<div class="empty">No decks yet. ${create
        ? 'Start one with <strong><a href="/new/blank">New deck</a></strong>, or open a deck you already have and pick <strong>Save to Beta</strong> in its Share panel.'
        : 'Open a deck and pick <strong>Save to Beta</strong> in its Share panel.'}</div>`
  return `${head('Beta decks')}
<body>
<main>
<header>
<div><div class="mark">beta/slides</div><h1>Decks</h1></div>
<div class="who">${esc(who)}</div>
</header>
<div class="lede">
<p class="muted">Every deck saved to Beta, newest first. Anyone signed in here can open and edit any of them; the link is the invitation.</p>
${newLink}
</div>
${body}
<footer>
<p>A deck opened from a link saves back here with ⌘S.</p>
<p>To make decks with Claude Code, install the plugin:</p>
<pre>/plugin marketplace add betamobility/slides
/plugin install beta-slides@beta-slides</pre>
</footer>
</main>
</body>
</html>
`
}

/**
 * /new, for both audiences.
 *
 * · WITH AN OPENER — the handoff. A deck on file:// opens this page in a tab
 *   and posts its serialized document once the page announces itself. The
 *   page shows the title and size and uploads ONLY when the person clicks
 *   Save. Nothing is stored on message receipt; one document is accepted,
 *   from the opener only, and later ones are discarded. This half is a
 *   contract with slides/src/beta/store.ts in files already on disk: do not
 *   change it, add beside it.
 *
 * · WITHOUT ONE, and with `create` on — a person typed the URL. Fetch the
 *   public blank template, mint a docId into it, post it, go to its link.
 *
 * `create` is the NEW_ENABLED flag. It gates only the second branch, never
 * the route: between the cutover and the release, a 2026.9.3 shell's Share
 * flow must still find a handoff page here, and the reason the create branch
 * waits is only that it clones a published template that would still name the
 * old store host.
 */
export function newPage(who, { create = false } = {}) {
  return `${head('Save to Beta')}
<body>
${create ? `<script>
// THE BRANCH IS DECIDED BEFORE THE CARD IS PARSED, and that placement is the
// whole point of this script existing separately from the one at the end.
//
// A person arriving at /new with no opener is going to /new/blank, and the
// card below is not for them. Deciding that at the BOTTOM of the body — where
// the rest of the page's script lives — means the browser has already parsed
// and PAINTED the card by the time the redirect fires: heading, Deck and Size
// rows, a Save button, a Close button, and a footer about keeping the tab
// open, all of it addressed to the other audience, on screen for as long as
// the redirect and the create take. That flash is what it looked like when
// this was still doing the work in the browser, so it read as "not fixed".
//
// Same trick as the preview remover in kernel/src/save.ts: a parser-blocking
// inline script placed BEFORE the markup it concerns, so the markup never
// reaches the screen.
//
// Emitted ONLY when the create branch is on, so "is this page willing to make
// a deck" stays answerable by reading the bytes, which is how the rig and the
// retired host's behaviour are both checked.
(function () {
  if (window.opener) return  // the handoff: the card IS for them
  location.replace('/new/blank')
})()
</script>
` : ''}<main>
<header>
<div><div class="mark">beta/slides</div><h1 id="heading">Save to Beta</h1></div>
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
    upload(doc, false)
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

  // The ONE upload. Both branches end here, so the create route is named once
  // and neither branch can drift from the other's error handling. \`fresh\`
  // only tells the worker which analytics event this was.
  function upload(html, fresh) {
    return fetch('/api/decks' + (fresh ? '?new=1' : ''), { method: 'POST', body: html, credentials: 'same-origin', redirect: 'manual',
      headers: { 'content-type': 'text/html; charset=utf-8' } })
      .then(function (r) {
        if (r.type === 'opaqueredirect' || r.status === 401) throw new Error('Signed out. Reload this tab to sign in, then try again.')
        if (!r.ok) return r.text().then(function (t) { throw new Error('The store refused the deck (' + r.status + (t ? ': ' + t : '') + ').') })
        return r.json()
      })
  }

  saveBtn.addEventListener('click', save)
  $('close').addEventListener('click', function () { window.close() })

  // Announce readiness. The opener is a file:// deck with a null origin, so
  // the target must be '*'; the deck checks event.origin and event.source.
  //
  // The no-opener case was handled at the TOP of the body, before any of this
  // markup was parsed — see the script up there. Reaching here without an
  // opener therefore means the create branch is off, and the card needs to say
  // what it is for.
  if (window.opener) window.opener.postMessage({ type: 'bento-store-ready' }, '*')
  else $('intro').textContent = 'Open this page from a deck: Share panel, Save to Beta.'
})()
</script>
</body>
</html>
`
}
