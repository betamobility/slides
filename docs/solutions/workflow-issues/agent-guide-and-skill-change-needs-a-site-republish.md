---
title: "A merged change to the agent guide or the skill is not live until the site is republished, and that does not need a release"
date: 2026-10-15
category: workflow-issues
module: site publishing (scripts/release.mjs, scripts/publish-site.mjs, betamobility/slides-site)
problem_type: workflow_issue
component: tooling
severity: medium
applies_when:
  - "docs/agents.md or plugins/beta-slides/skills/beta-slides/SKILL.md changed on main and slides.betamobility.ai should serve it"
  - "Someone asks why slides.betamobility.ai/agents.md still shows the old text after a merge"
  - "publish-site.mjs refuses because gh is logged in as a personal account"
symptoms:
  - "After the merge, slides.betamobility.ai/agents.md and /skills/beta-slides/SKILL.md still serve the text from the last release"
  - "publish-site.mjs stops at the gh account gate before mirroring anything"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
tags: [site, agents-md, skill, publish-site, wrangler, cloudflare-pages, release]
---

# A merged change to the agent guide or the skill is not live until the site is republished, and that does not need a release

## Context

PR #65 rewrote `docs/agents.md` (the guide served at
`slides.betamobility.ai/agents.md` and `/slides/agents.md`) and the
`beta-slides` `SKILL.md` (served at `/skills/beta-slides/SKILL.md` and inside
`/skills/beta-slides.zip`). Merging changed nothing on the site. Nothing in
CI or on Pages builds these files from `main`. `scripts/release.mjs` writes
them into the gitignored `site/` during a release: it replaces
`__APP_VERSION__` in the guide (`scripts/release.mjs:163`), copies the guide
to the root (`:373`), and copies and zips the skill (`:381-383`).
`publish-site.mjs` mirrors that tree into `betamobility/slides-site`, and a
manual `wrangler pages deploy` uploads it (README, "Releasing (Beta)").

A full release would mean a new version, the signing key and the 1Password
click (see `release-signing-key-waits-on-a-1password-click.md`) for a change
to four text files. None of that is needed.

## Guidance

Republish the last release's `site/` with only the changed files swapped in.

1. **Confirm the last release can serve the new text.** The guide must not
   describe behaviour newer than the shell it ships beside. Check that what
   the text names exists at the release tag (here, `v2026.10.11` already
   had `beta/library/`, `--library` and `libraryrules.ts`). Also check that
   `git diff v<tag> origin/main -- slides kernel` is empty, or contains
   nothing the new text describes.
2. **Start from that release's site tree, in a worktree off `main`.**
   `site/` is gitignored (`.gitignore:30`) and `publish-site.mjs` reads it
   from the repo root (`scripts/publish-site.mjs:38`). The tree from the
   release worktree has the signed shell and manifest. Never rebuild them.

   ```sh
   rm -rf site && cp -R ../release-<version>/site site
   sed 's/__APP_VERSION__/<version>/g' docs/agents.md > site/slides/agents.md
   cp site/slides/agents.md site/agents.md
   cp plugins/beta-slides/skills/beta-slides/SKILL.md site/skills/beta-slides/SKILL.md
   (cd site/skills && rm -f beta-slides.zip && zip -q -X -o beta-slides.zip beta-slides/SKILL.md)
   ```

   Stamp the guide with the **release** version, not a new one. The guide
   declares which shell it matches.
3. **Prove the change is exactly those files** before publishing:
   `diff -rq -x .git -x .bento-release.json site ../../slides-site` must list
   only the four paths. A fifth path means the release tree is not the one
   that is live.
4. **Publish.** `publish-site.mjs` gates the active `gh` account against the
   repo owner (`scripts/publish-site.mjs:330-340`). A personal account with
   admin rights on `betamobility/slides` passes through the documented
   allow-list rather than by switching accounts:

   ```sh
   BENTO_RELEASE_ACCOUNTS=<login> BENTO_SITE_DIR="…/slides-site" \
     node scripts/publish-site.mjs "docs: <what changed> (slides#<pr>)"
   ```

   It ends with "GitHub release v<version> already published". That is
   expected: the release step finds the existing tag and creates nothing.
5. **Deploy, then verify.** Pages is not wired to the `slides-site` repo, so
   the push alone serves nothing:

   ```sh
   cd ../slides-site && env -u CLOUDFLARE_API_TOKEN npx wrangler pages deploy . \
     --project-name beta-slides-site --branch main --commit-dirty=true
   ```

   Then compare the live files with `main`: `curl` the guide and look for
   the new heading and the `Guide version` stamp, then `cmp` the live
   `SKILL.md` and the unzipped skill against
   `plugins/beta-slides/skills/beta-slides/SKILL.md`. Finally run
   `BENTO_SITE_DIR=… node scripts/check-store-live.mjs`. It must still report
   every published path reachable without a login, so the republish did not
   drop a route.

## Why This Matters

The guide is what a Claude session reads after it loads the skill. A merged
guide that is not live misleads agents: before #65 was deployed, the served
intro still sent agents to upstream's `nyblnet/bento` skill and to
`bento.page`. The obvious fixes are both wrong. One is cutting a release,
which needs the key, a 1Password approval and a new version number for a text
change. The other is rebuilding `site/` from `main`, which would rebuild an
unsigned shell or leave the manifest out of step with it.

## When to Apply

- Only `docs/agents.md`, `SKILL.md` or other copied text changed.
- The shell, kernel, templates and manifest are unchanged since the last
  release, or unchanged in any way the new text depends on.

If the text describes a feature that only exists on `main`, cut a release
instead (`docs/RELEASING.md` and the README's "Releasing (Beta)").

## Examples

On 2026-10-15, after #65 merged, the republish on top of `v2026.10.11` did
the following:

- `slides-site` got a commit that touched 4 files.
- Wrangler uploaded 4 files.
- The live `/agents.md` and `/slides/agents.md` carried the new start block
  at guide version `2026.10.11`.
- The live `SKILL.md` and zip were byte-identical to `main`.
- `check-store-live.mjs` reported 51/51 paths reachable without a login.

No version bump, no signing and no 1Password approval were needed.
