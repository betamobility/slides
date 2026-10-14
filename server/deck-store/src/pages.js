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

import { rewriteBlock } from './block.js'
import { GRANT_TTL_S } from './grant.js'

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
 * imports this directly.
 *
 * The block surgery itself moved to `block.js rewriteBlock` when a grant's
 * read needed the same rewrite (one-click publish plan, KTD6): one place
 * escapes `<`, refuses a block a browser would cut short (AGENTS.md hard rule
 * 1), and keeps the block's own opening tag. If anything is ever inlined back
 * into a page, it is that function that has to stay ES5-plain.
 */
export function mintDocIntoBlock(html, docId) {
  return rewriteBlock(html, (doc) => {
    if (doc.format !== 'bento/slides') throw new Error('the template is not a bento/slides document')
    delete doc.template
    delete doc.collab
    doc.docId = docId
    return doc
  })
}

const PLAUSIBLE = '<script defer data-domain="betamobility.ai" src="https://plausible.io/js/script.js"></script>'

const CSS = `
:root{color-scheme:light dark;--color-surface:#FFFFFF;--color-surface-alt:#F7F7F7;--color-surface-emphasis:#1A1A1A;--color-emphasis-hover:#333333;--color-on-surface:#1A1A1A;--color-on-surface-muted:#666666;--color-on-emphasis:#FFFFFF;--color-border:rgba(26,26,26,0.10);--color-border-control:#767676;--color-focus:#1A1A1A;--font-sans:'Geist','Helvetica Neue',Helvetica,Arial,sans-serif;--font-mono:'DM Mono','Courier New',monospace;--radius-small:8px;--radius-medium:12px;--radius-full:9999px}
@media (prefers-color-scheme:dark){:root{--color-surface:#0D0D0D;--color-surface-alt:#1A1A1A;--color-surface-emphasis:#F7F7F7;--color-emphasis-hover:#FFFFFF;--color-on-surface:#F7F7F7;--color-on-surface-muted:rgba(247,247,247,0.7);--color-on-emphasis:#1A1A1A;--color-border:rgba(247,247,247,0.12);--color-border-control:#999999;--color-focus:#F7F7F7}}
*{box-sizing:border-box}
html{background:var(--color-surface);color:var(--color-on-surface)}
body{margin:0;font-family:var(--font-sans);font-size:1rem;line-height:1.5;letter-spacing:-0.01em;-webkit-font-smoothing:antialiased}
.site{display:flex;align-items:center;justify-content:space-between;gap:1rem;max-width:64rem;margin:0 auto;padding:1rem 1.5rem}
.home{display:inline-flex;align-items:center;min-height:44px;color:var(--color-on-surface);border-radius:var(--radius-small)}
.home svg{display:block;height:20px;width:auto}
.who{font-size:.75rem;line-height:1.5;color:var(--color-on-surface-muted);overflow-wrap:anywhere;text-align:right}
main{max-width:64rem;margin:0 auto;padding:1.5rem 1.5rem 4rem}
h1{font-weight:500;font-size:2rem;line-height:2.5rem;letter-spacing:-0.02em;margin:0}
h2{font-weight:500;font-size:1.25rem;line-height:1.625rem;margin:2.5rem 0 .5rem}
p{margin:0 0 1rem;max-width:40rem}
.muted{color:var(--color-on-surface-muted)}
.lede{display:flex;flex-direction:column;align-items:flex-start;gap:1rem;margin:.25rem 0 2rem}
.lede p{margin:0;color:var(--color-on-surface-muted)}
td form{margin:0}
td button{min-height:36px;padding:.25rem .875rem;font-size:.875rem}
/* On a phone the grants table would push Revoke out of the scroll container,
   and that button is the only reason the section exists. When it is Approved
   or the action, the action wins: Ends is the column that says the same thing. */
@media (max-width:560px){.grants th:nth-child(2),.grants td:nth-child(2){display:none}}
table{width:100%;border-collapse:collapse;font-size:.875rem;line-height:1.3125rem}
th,td{text-align:left;padding:.75rem .5rem;border-bottom:1px solid var(--color-border);vertical-align:top}
th{font-weight:500;color:var(--color-on-surface-muted);font-size:.75rem}
td.num,td.tag,td.time{font-family:var(--font-mono);font-size:.8125rem;letter-spacing:0;white-space:nowrap}
.kind{font-family:var(--font-mono);font-size:.75rem;letter-spacing:0;color:var(--color-on-surface-muted);border:1px solid var(--color-border);border-radius:var(--radius-full);padding:0 .5rem;margin-left:.4rem;white-space:nowrap}
a{color:inherit;text-decoration:underline;text-underline-offset:.15em}
a.deck{font-weight:500;text-decoration:none}
a.deck:hover{text-decoration:underline}
a.cta,button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;font:inherit;font-weight:500;border:1px solid var(--color-surface-emphasis);background:var(--color-surface-emphasis);color:var(--color-on-emphasis);border-radius:var(--radius-small);padding:.5rem 1.25rem;cursor:pointer;text-decoration:none;white-space:nowrap}
a.cta:hover,button:hover{background:var(--color-emphasis-hover);border-color:var(--color-emphasis-hover)}
button:disabled{opacity:.45;cursor:default}
button.secondary{background:transparent;color:var(--color-on-surface);border-color:var(--color-border-control)}
button.secondary:hover{background:var(--color-surface-alt)}
a:focus-visible,button:focus-visible{outline:2px solid var(--color-focus);outline-offset:2px}
.wrap{overflow-x:auto}
.empty{color:var(--color-on-surface-muted);max-width:40rem}
.card{border:1px solid var(--color-border);border-radius:var(--radius-medium);padding:1.5rem;background:var(--color-surface-alt);max-width:36rem}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.375rem 1.25rem;margin:0 0 1.25rem}
dt{font-size:.75rem;color:var(--color-on-surface-muted);padding-top:.15rem}
dd{margin:0;overflow-wrap:anywhere}
dd.num{font-family:var(--font-mono);letter-spacing:0}
.row{display:flex;gap:.75rem;align-items:center;flex-wrap:wrap}
.status{font-size:.875rem;color:var(--color-on-surface-muted);min-height:1.5rem}
.link{font-family:var(--font-mono);font-size:.8125rem;letter-spacing:0;overflow-wrap:anywhere}
footer{margin-top:3rem;font-size:.875rem;color:var(--color-on-surface-muted)}
footer p{margin:0 0 .5rem}
footer pre{font-family:var(--font-mono);font-size:.8125rem;letter-spacing:0;background:var(--color-surface-alt);border-radius:var(--radius-small);padding:.75rem 1rem;overflow-x:auto;color:var(--color-on-surface);margin:0}
@media (max-width:720px){.site{padding:.75rem 1rem}.home svg{height:18px}main{padding:1rem 1rem 3rem}}
`

// `analytics: false` for the pairing pages: their URL carries the pairing
// code, and a third-party script on the page would send that path to
// plausible.io. Nothing else about the pages differs.
const head = (title, { analytics = true } = {}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500&family=DM+Mono:wght@400&display=swap">
<style>${CSS}</style>
${analytics ? PLAUSIBLE : ''}
</head>`

// The approved wordmark (beta/logo/wordmark.svg), inline so it takes the
// surface's ink in both themes; design system v1.5.0, standard logo placement.
const WORDMARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="140 185 215 82" fill="currentColor" role="img" aria-label="Beta"> <g transform="matrix(1, 0, 0, -1, -49.3461, 868.292)"> <g transform="translate(318.3633 620.9612)"> <path d="M 0 0 L 0 26.582 L -6.699 26.582 L -6.699 40.193 L 0 40.193 L 0 54.532 L 15.912 54.532 L 15.912 40.193 L 29.096 40.193 L 29.096 26.582 L 15.912 26.582 L 15.912 2.616 C 15.912 -1.048 17.48 -2.829 21.034 -2.829 C 23.966 -2.829 26.582 -2.097 28.892 -0.839 L 28.892 -13.611 C 25.542 -15.596 21.665 -16.853 16.329 -16.853 C 6.597 -16.853 0 -12.98 0 0"/> </g> <g transform="translate(387.3595 624.8306)"> <path d="M 0 0 L 0 2.829 C -2.727 4.082 -6.281 4.922 -10.159 4.922 C -16.96 4.922 -21.145 2.199 -21.145 -3.034 C -21.145 -7.325 -17.591 -9.839 -12.46 -9.839 C -5.028 -9.839 0 -5.757 0 0 M -36.536 -3.452 C -36.536 8.795 -27.221 14.446 -13.926 14.446 C -8.275 14.446 -4.193 13.504 -0.213 12.145 L -0.213 13.086 C -0.213 19.679 -4.295 23.343 -12.247 23.343 C -18.324 23.343 -22.611 22.193 -27.741 20.305 L -31.721 32.45 C -25.542 35.169 -19.474 36.95 -9.946 36.95 C -1.261 36.95 5.02 34.644 9 30.669 C 13.184 26.484 15.068 20.305 15.068 12.771 L 15.068 -19.781 L -0.315 -19.781 L -0.315 -13.709 C -4.193 -18 -9.528 -20.829 -17.275 -20.829 C -27.843 -20.829 -36.536 -14.757 -36.536 -3.452"/> </g> <g transform="translate(235.8703 633.1508)"> <path d="M 0 0 C 0 9.315 -6.281 15.494 -13.713 15.494 C -21.145 15.494 -27.315 9.315 -27.315 -0.209 C -27.315 -9.524 -21.145 -15.699 -13.713 -15.699 C -6.281 -15.699 0 -9.626 0 0 M -27.11 -20.829 L -27.11 -28.154 L -43.022 -28.154 L -43.022 48.255 L -27.11 48.255 L -27.11 19.888 C -23.233 25.12 -17.898 28.994 -9.631 28.994 C 3.452 28.994 15.912 18.737 15.912 -0.209 C 15.912 -18.942 3.665 -29.203 -9.631 -29.203 C -18.111 -29.203 -23.343 -25.329 -27.11 -20.829"/> </g> <g transform="translate(295.1933 637.4419)"> <path d="M 0 0 C -0.946 7.121 -5.131 11.932 -11.829 11.932 C -18.426 11.932 -22.713 7.223 -23.974 0 Z M -39.562 -4.5 C -39.562 11.514 -28.159 24.703 -11.829 24.703 C 6.903 24.703 15.486 10.155 15.486 -5.757 C 15.486 -7.01 15.383 -8.476 15.281 -9.942 L -23.761 -9.942 C -22.193 -17.165 -17.165 -20.932 -10.048 -20.932 C -4.713 -20.932 -0.835 -19.257 3.554 -15.175 L 12.665 -23.233 C 7.432 -29.723 -0.102 -33.703 -10.261 -33.703 C -27.11 -33.703 -39.562 -21.873 -39.562 -4.5"/> </g> </g> </svg>'

/** The page header: the wordmark as the link home at the top left, the signed-in identity at the right. No eyebrow above the heading. */
const siteHeader = (who) => `<header class="site">
<a class="home" href="/" aria-label="Beta decks, home">${WORDMARK}</a>
<div class="who">${esc(who)}</div>
</header>`

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
/**
 * "Agent access": the live grants of the person reading the page (U4, R10).
 *
 * A grant ends by itself after seven days, so this is not the safety net —
 * it is how someone SEES that an agent can currently publish as them, which
 * a background capability has to be. Absent entirely when there are none: an
 * empty table would be a question nobody asked.
 *
 * Each row's Revoke is a form post, same-origin-checked at the worker, not a
 * link: a GET that revokes would fire from any image tag anyone could plant.
 */
function grantsSection(grants) {
  if (!grants.length) return ''
  const rows = grants.map((g) => `<tr>
<td>${g.label ? `&quot;${esc(g.label)}&quot;` : '<span class="muted">unnamed</span>'}</td>
<td class="time">${esc(fmtTime(g.created))}</td>
<td class="time">${esc(fmtTime(new Date(g.exp * 1000).toISOString()))}</td>
<td><form method="post" action="/api/grants/${esc(g.hash)}/revoke"><button class="secondary" type="submit">Revoke</button></form></td>
</tr>`).join('\n')
  return `<h2>Agent access</h2>
<p class="muted">Agents you approved can create decks and change any deck by its link, as you, until these times. They cannot list the store or delete anything.</p>
<div class="wrap"><table class="grants">
<thead><tr><th>Asked for by</th><th>Approved</th><th>Ends</th><th></th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`
}

export function indexPage(decks, who, { create = false, grants = [] } = {}) {
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
${siteHeader(who)}
<main>
<h1>Decks</h1>
<div class="lede">
<p class="muted">Every deck saved to Beta, newest first. Anyone signed in here can open and edit any of them; the link is the invitation.</p>
${newLink}
</div>
${body}
${grantsSection(grants)}
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
` : ''}${siteHeader(who)}
<main>
<h1 id="heading">Save to Beta</h1>
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

// How long a grant lasts, as the pages say it: whole days, from the one
// constant, so a week never reads as "168 hours".
const LIFETIME = `${Math.round(GRANT_TTL_S / 86400)} days`

/**
 * `GET /link/<code>` — the one click (one-click publish plan, KTD11, R2/R3).
 *
 * THE PAGE CANNOT KNOW WHO STARTED THE PAIRING and does not pretend to. A
 * pairing is started with no credential at all, so the only honest things to
 * show are what a grant reaches, how long it lasts, when this pairing was
 * started, and what the agent called itself — the last as quoted, escaped
 * text, because a label is a string a caller chose.
 *
 * So the copy is fixed and carries the meaning. "Approve only if you asked an
 * agent to publish in the last few minutes" is the defence against a phished
 * approval, together with the start time: the whole flow is a person clicking
 * seconds after they asked for a deck.
 *
 * The form's nonce is the pairing's own, stored beside the code, and the
 * worker takes the POST only from this origin (KTD13) — an Access session
 * cookie travels on a cross-site form submission, so same-origin is the check
 * that makes the click a consent rather than a forgery.
 */
export function linkPage(who, code, { label = '', created = '', nonce = '' } = {}) {
  return `${head('Approve agent access', { analytics: false })}
<body>
${siteHeader(who)}
<main>
<h1>Approve agent access</h1>
<div class="card">
<p>Whoever started this pairing will be able to publish decks as you for ${LIFETIME}. Approve only if you asked an agent to publish in the last few minutes.</p>
<dl>
<dt>Asked for by</dt><dd>${label ? `&quot;${esc(label)}&quot;` : '<span class="muted">an agent that gave no name</span>'}</dd>
<dt>Started</dt><dd class="num">${esc(fmtTime(created))}</dd>
<dt>Can</dt><dd>create decks, and read and change any deck by its link</dd>
<dt>Cannot</dt><dd>list the store, delete a deck, or read a deck's live-session keys</dd>
</dl>
<form method="post" action="/link/${esc(code)}/approve">
<input type="hidden" name="nonce" value="${esc(nonce)}">
<div class="row">
<button type="submit">Approve for ${LIFETIME}</button>
<span class="muted">Close this tab to refuse.</span>
</div>
</form>
</div>
<footer>You can end this access at any time from <a href="/">the deck list</a>.</footer>
</main>
</body>
</html>
`
}

/** The page after the click. Nothing to do here, and it says so. */
export function linkDonePage(who, { label = '' } = {}) {
  return `${head('Approved', { analytics: false })}
<body>
${siteHeader(who)}
<main>
<h1>Approved</h1>
<div class="card">
<p>${label ? `&quot;${esc(label)}&quot;` : 'The agent'} can publish decks as you for the next ${LIFETIME}. Go back to where you asked for the deck; you can close this tab.</p>
<p class="muted">End this access at any time from <a href="/">the deck list</a>.</p>
</div>
</main>
</body>
</html>
`
}
