# Beta fork: smoke checklist and upstream runbook

What only the fork does, and how to keep it mergeable. `AGENTS.md` "Beta fork" has the rules; this is the list to walk.

## Merging an upstream release

1. Branch from `main`, tag the head, `git fetch upstream --tags`, `git merge vX.Y.Z` (a merge commit, never a rebase or a squash).
2. Generated files are never hand-merged: take upstream's `slides/src/modelkeys.generated.ts`, `slides/src/i18n/packed.ts`, `schema/*.json` and `slides/package-lock.json`, then run `npm install` in `slides/`, `node scripts/build-modelkeys.mjs`, `node scripts/build-i18n.mjs`, `node scripts/build-schema.mjs`.
3. Catalogues: keep both sides of each conflict; where both have a key, upstream's line wins.
4. `slides/package.json` keeps Beta's dated version. `CHANGELOG.md` and `docs/DECISIONS.md` keep both sections.
5. `git grep -n "BETA FORK"` is the list of hooks to re-seat. `node scripts/test-beta-markers.ts --list` prints each one against the old tag.
6. Change "Upstream base" in `AGENTS.md` to the new tag in the same commit, and re-sync the "Upstream CLAUDE.md (verbatim)" section if upstream's `CLAUDE.md` changed.
7. Run every step of the `beta` job locally, then load the built shell in a browser and walk the list below.
8. The pull request lands as a merge commit. Pushing a change to `.github/workflows/` needs a credential with the `workflow` scope, or SSH.

### Where the last merge (v1.2.7) went wrong, so the next one looks there first

- **Upstream turned an exception into an outcome.** The save queue returns a refused write as `out.kind === 'failed'`; the fork's store handling sat in a `catch` that no longer ran. Look for every place a Beta hook depends on how upstream reports a failure.
- **Upstream added a walk over the document that does not know `slide.runtime`.** Asset pruning walked elements only and would have deleted every scene. Any new walk (pruning, compression, export, a gate) needs the same question.
- **Upstream added a feature that steps through a slide.** Reveal steps and the broadcast show both met runtime scenes; a runtime slide has no reveal steps, and a scene's step rides the same wire field.
- **The bundle must stay a classic script.** One `import.meta` from a dependency makes the loader fall through to its last start path. `scripts/test-beta-merge-bundle.ts` reads the built bytes.
- **New menu entries can point at upstream's site.** `CONVERTER_LINKS` in `slides/src/editor/editor.ts` hides two that open bento.page.

## Smoke checklist (what only the fork does)

Walk it on the built shell (`cd slides && npm run build:single`, then serve `slides/dist-single/`), and on the store after a deploy.

| Area | Check | Covered by |
|---|---|---|
| Brand | The Beta wordmark in the top bar and on the splash; About says beta/slides and names no upstream link | `test-beta-marks.ts`, `test-beta-about.ts` |
| Starter and templates | A fresh shell opens Beta's starter deck; the five templates open and carry this build's runtime | `test-beta-templates-current.ts`, `build-beta-starter.mjs --check` |
| Runtime slides | A deck with a runtime slide opens with the scene's still; present mode runs the scene; arrows step it, then leave the slide; a save keeps the scene | `test-beta-runtime.ts`, `test-beta-assets.ts`, `test-beta-merge-*.ts` |
| Store save | From a store tab, an edit autosaves and ⌘S says Saved; a second tab that saved first makes the next save say the deck changed, and Reload gets the newer one | `test-beta-store-client.ts`, `test-beta-merge-store.ts` |
| Idle reload | An idle store tab reloads onto a version Claude wrote; a tab with unsaved edits does not | `docs/solutions/design-patterns/idle-tab-follows-the-store-auto-reload.md` |
| Publishing | `splice.mjs --read <id>` with no approval prints a link and waits; one click later it lists the deck | `test-beta-splice.ts` |
| PowerPoint | Export PPTX from the top bar writes a file and names what was simplified; a runtime slide exports as its still | `test-beta-pptx.ts`, `test-beta-merge-round5-export.ts` |
| Schema | A saved deck's first key is `$schema`, naming `slides.betamobility.ai/schema/slides.json`, and that URL answers without a login | `test-beta-schema.ts`, `test-slides-schema.ts`, `check-store-live.mjs` |
| Updates | The update chip appears on an older stored deck; accepting it writes the new shell in place | `test-release-channel.mjs`, `test-beta-merge-round5-update.ts` |
| Markers | Every hook in an upstream file carries `BETA FORK` | `test-beta-markers.ts` |

## Releasing after an upstream merge (maintainer)

1. Deploy the sync relay from the merged tree first (`server/sync-worker`, `wrangler deploy`), then run `node scripts/test-relay-protocol.ts`. A new shell must never meet an older relay.
2. Deploy the deck store worker if `server/deck-store/` changed, then `node scripts/check-store-live.mjs`.
3. Cut the release as the README's "Releasing" section says.
4. Open a stored deck in a store tab, accept the update chip, and confirm on the next read that the deck carries the new shell; an idle second tab reloads onto it.
5. After a release that includes upstream 1.2.7 or later for the first time: the owner of each shared deck runs **Reset access** once, as upstream asks. Downloaded copies and stale tabs of that deck drop out of the live session.
