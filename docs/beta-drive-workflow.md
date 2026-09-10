# Decks in Google Drive (Beta fork)

How Beta decks live in Google Drive, what Drive does and does not give us, and
the parts that were measured rather than assumed. This is the **file** route:
the deck is an ordinary `.bento.html` in a Drive-synced folder. It is the
companion of the deck store at `slides.betamobility.ai`, not a replacement for
it (see "The two routes" below).

Colleague-facing instructions live at `dashboard.betamobility.com/tools/slides`.
This file is the reasoning behind them; that page is the version to send people.

## The convention

- **Templates:** `Beta Mobility Consulting / 07 Resources / Presentations /
  00 bento templates/` on the Shared drive. Four files, copied verbatim from
  `beta/templates/`, which is byte-identical to what
  `slides.betamobility.ai/templates/` serves. A colleague starts a deck by
  opening one of these and saving a copy.
- **Finished decks:** wherever the work lives. In the project folder for
  client work, under `07 Resources / Presentations / …` for the decks that
  belong to the company rather than to a project. Nothing in the app
  constrains this: the save dialog is the ordinary macOS one, so any
  Drive-synced folder is a legal target.
- **Shared drives, not My Drive.** A deck in a Shared drive is owned by the
  org, so it survives someone leaving and needs no per-person sharing to be
  reachable.

## What was measured (2026-09-10)

Run against a real saved deck (1,035,646 bytes, carrying a first-page preview)
in `johan@betamobility.io`'s Drive.

1. **Copying into the Drive for desktop mount uploads the file**, stored as
   `text/html` at full size with no conversion to a Google type.
2. **Chrome's in-place write survives the mount.** The File System Access API
   does not overwrite the target directly: it writes a `.crswap` file beside it
   and renames over the top. That pattern works on Drive's virtual filesystem.
   This is the single mechanic that would have sunk the whole route, so it is
   pinned here.
3. **A rewrite is a new revision of the same file, not a duplicate.** Probed by
   writing twice through swap-and-rename: one file id, `createdTime`
   18:43:01, `modifiedTime` 18:43:18. The deck keeps its Drive identity, and
   Drive's own version history accumulates alongside the deck's internal one.
4. **Drive's file viewer shows raw source code.** Clicking a deck in Drive web
   renders a monospace wall of HTML beginning at `<!DOCTYPE html>`. It is not a
   sanitized render and not a preview. Third-party write-ups claiming Drive
   renders a stripped snapshot of HTML are wrong; this was checked directly.
   **This is why the guide tells people to open decks from Finder.**
5. **Drive's grid thumbnail runs JavaScript and boots the app.** The thumbnail
   shows editor chrome, the slide rail, the properties panel and the title
   slide. It is not the static first-page preview from `slides/src/preview.ts`,
   which is what iOS and QuickLook use. Treat it as observed behaviour of
   Google's renderer, not as a feature: it is a screenshot of the editor, we do
   not control it, and it may change without notice.
6. **Drive indexes the file but sees JSON.** Gemini's overview of the deck
   described it as "template and configuration ... metadata and size settings".
   Drive finds a deck by its title; it does not find it by the words on slide
   three. Same limit `DECISIONS.md` records for Spotlight (2026-07-27), on a
   different indexer.
7. **First save opens a picker; every later save is silent.** From
   `kernel/src/save.ts`: a `file://` deck holds no handle, so the first ⌘S goes
   through `pickHandle`, pre-filled with the opened file's own name. Confirm the
   overwrite once and the handle is retained, after which ⌘S and the 2.5s
   autosave write-back run with no dialog.

8. **A template opened from the folder is a genuinely new deck.** All four
   carry `template: true` and no `docId` and no `collab`, and `parseDoc`
   (`slides/src/model.ts`) treats that flag as instantiation: it deletes the
   flag, mints a fresh `docId` and deletes `collab`. So the file route needs no
   equivalent of the store's `/new`, and two people starting from the same
   template never end up sharing an identity or a live room.

   **The hazard is the picker, not the identity.** `pickHandle` pre-fills the
   opened file's own name and the browser remembers the last directory per
   picker id, so a first ⌘S straight from `Blank.bento.html` offers to write
   back over the template, in a Shared drive folder everyone can write to. The
   guide therefore tells people to change both name and folder on that first
   save. Worth revisiting if `saveFile` ever grows a template-aware default.

9. **Live co-editing does not mean two people opening one Drive file.** Off the
   store origin, "Invite to edit…" saves a *copy* to send
   (`editor.ts inviteToEdit`); the recipient's copy joins the same relay room
   and both edit live. That is the flow to teach, and it sidesteps the unrun
   case below entirely.

### Not measured

**Two machines editing the same Drive-synced deck at once.** The reasoning
below is from the code and has not been run. It is the first thing to test if
people start co-editing this way.

## Why the file route degrades better than a Drive API integration would

Three properties get conflated when comparing this to Google Slides. They come
apart:

- **Collaboration** is the relay, and it is unaffected by where the file sits.
  The file carries the room credentials, so any copy anywhere joins the same
  session. This is not a differentiator between storage routes.
- **Offline** is a property of bytes on disk. Drive for desktop gives it. An
  "Open with → fetch over the Drive API" integration would not: that is a
  network flow, and it would inherit Google Slides' weakness rather than keep
  our strength.
- **Divergence** is where the file route wins, which is the counter-intuitive
  part. Two people in one live session converge in the browser and both write
  the same document, so Drive is not what saves them. The interesting case is
  two people editing the same deck *outside* a session, typically one of them
  offline. A file route yields a Drive conflict copy, and a conflict copy is a
  fork, which this format already knows how to rejoin two-way (a copy edited
  offline "rejoins as a true fork", `CLAUDE.md`, sync section). A Drive API
  route yields last-write-wins: silent loss the app cannot see. Adding a
  revision precondition converts that into a rejected save with no merge path,
  which is not better.

So the file is the right unit of storage here for the same reason it is the
right unit everywhere else in this format.

## What Drive does not do, and what we do about it

| Gap | Response |
|---|---|
| Clicking a deck in Drive web shows source code | Guide says: open from Finder. Not fixable from our side. |
| Drive search does not reach slide content | Title discipline. The deck store's list is the other index. |
| No "New → bento/slides" in Drive | Templates folder. A Drive UI integration would fix it and is **not** scheduled, see below. |
| Safari cannot write in place | Chrome. Safari turns every ⌘S into a download. |

## The two routes

| | Deck store (`slides.betamobility.ai`) | Drive (this document) |
|---|---|---|
| Getting in | sign in, click the deck | open the file from Finder |
| Saving | ⌘S saves back to the store | ⌘S saves back to the file |
| Sharing | any signed-in Beta identity can edit any deck | Drive's own permissions, per deck |
| Filing | one flat shelf, newest first | wherever the work already lives |
| Offline | no | yes |

Both are the same deck format and both self-update. Use the store when the deck
is the thing being worked on; use Drive when the deck belongs beside the rest of
a project's material.

## The Drive UI integration, and why it is not scheduled

Google's "Open with" and "New" menus can be extended by a Workspace app
(`drive.file`, an internal Marketplace listing). That would close the two real
gaps: clicking a deck in Drive web would open the editor, and decks could be
created in place. It was costed and deliberately deferred, because:

- It contradicts fork rule 7 (`AGENTS.md`): the app knows exactly one store
  host. A Drive host would be a second one, and that is a `DECISIONS.md` entry
  before it is a feature.
- It would create a second shelf, and the store exists precisely to avoid decks
  scattering.
- It buys two things over what exists today: finding a deck where the project
  lives, and sharing one deck with one person. It buys nothing for editing
  together.

Revisit only if those two turn out to be the actual complaint after this route
has run for a while. The seam it would attach to is `slides/src/beta/store.ts`,
which is already a kernel *host* (`window.__bentoHost`, a polyfilled save picker
and an adopted file handle). A Drive host is the same shape: roughly one new
file beside it, not a rewrite.
