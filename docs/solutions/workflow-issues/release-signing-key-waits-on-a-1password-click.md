---
title: "An agent-run release waits on one 1Password click, and the click expires in about a minute"
date: 2026-10-14
category: workflow-issues
module: release (scripts/release.mjs, scripts/publish-site.mjs)
problem_type: workflow_issue
component: tooling
severity: medium
applies_when:
  - "An agent cuts a Beta Slides release and needs the signing key"
  - "~/.bento/release-key.json is absent on the machine doing the release"
  - "Someone asks why 1Password keeps coming up around Beta Slides"
  - "A colleague's agent asks for a 1Password item while building or publishing a deck"
symptoms:
  - "`op document get` ends with `[ERROR] … authorization timeout` after roughly a minute, twice in a row"
  - "A background watcher waited an hour for a key file that never arrived because nobody was at the Mac"
  - "Colleagues building decks with Claude were shown 1Password prompts"
  - "`authorization timeout` with the maintainer at the Mac and no prompt on screen, also for a `!` run (2026-11-09: the session ran under herdr)"
  - "`release.mjs` stops at `derive-pins.mjs` with `Cannot find package 'playwright'`"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
tags: [release, signing-key, 1password, op-cli, pairing, grant, beta-toolkit, herdr, playwright]
---

# An agent-run release waits on one 1Password click, and the click expires in about a minute

## Context

Release 2026.10.11 was merged, tagged and ready, and then stalled for over an
hour on its signing key.

`docs/RELEASING.md` (One-time setup, step 1) assumes the key lives at
`~/.bento/release-key.json` with a password-manager backup. On the Mac that
ran this release the file does not exist. The only copy is the 1Password
document in the Development vault (item `ebxugmep5htwldxetpdsmkkyiy`), so
every release has to fetch it.

`op` fetches through the 1Password desktop app, and the app asks a person to
approve each request. If nobody approves, `op` gives up on its own after
roughly a minute with `authorization timeout`. Wrapping it in a longer
`alarm` changes nothing.

In this session that cost the following:
- Two attempts timed out back to back, the second wrapped in a 600-second `alarm`.
- A one-hour watcher for the key file then expired with nothing to show.
- The release went out minutes after the maintainer said "I'm back": the
  fetch was started while he was at the Mac, and it succeeded on the first try.

Johan then asked why 1Password is there at all, and whether colleagues hit it
too. They had, but for a different reason (see below). Answering that took a
search through two repositories.

## Guidance

**The release key is the maintainer's prompt, and only the maintainer's.**
Johan said on 2026-10-14 that he is fine doing the signing himself, so the key stays in 1Password. An
agent doing a release should:

1. Do everything that needs no key first: the release PR, the merge, tag
   `vX.Y.Z` pushed, a clean worktree at the tag, `slides/node_modules` in
   place, and `slides-site` pulled.
2. Ask for the key only once the person is present ("I'm back", or a direct
   answer within the last minute or two). Run the fetch in the foreground and
   say "approve the 1Password prompt now":

   ```sh
   umask 077; op document get ebxugmep5htwldxetpdsmkkyiy \
     --out-file <scratchpad>/secrets/release-key.json --force
   ```

3. Do not retry blindly after an `authorization timeout`. Each retry is
   another minute that only a person's click can end. Two timeouts mean
   nobody is there, or the session cannot reach the person's screen (next
   section). Check that first, then hand over the one command.
4. Sign with `node scripts/release.mjs --key <file>`, then delete the key
   (`rm -P`) before publishing. Nothing after signing needs it.

**A session outside the login session can never get the prompt.** Release
2026.11.3 (2026-11-09) timed out four times with the maintainer sitting at
the mini, and a `!` run timed out too. The session had been started by
`herdr`, whose daemon `herdr-core` is a child of `launchd`, not of a
terminal the maintainer opened. 1Password shows its approval prompt only to
processes in the logged-in GUI session, so it never appeared, and `op`
timed out silently. `op whoami` saying "account is not signed in" was a red
herring. Opening Terminal from the session (`open -a Terminal x.command`)
did not help either: the AppleEvent timed out and no window appeared.

Check before the first fetch:

```sh
p=$$; while [ "$p" -gt 1 ]; do ps -o pid=,comm= -p "$p"; p=$(ps -o ppid= -p "$p" | tr -d ' '); done
```

If the chain ends in `herdr-core` → `launchd` (or tmux started outside the
GUI), do not run `op` from the session. Write the fetch to a script in the
scratchpad and ask the person to run it from a terminal **they open on the
Mac**. It succeeded on the first try that way. A `!` command does not help,
because it runs in the session's own shell.

**Signing also needs Playwright.** `release.mjs` runs
`scripts/derive-pins.mjs`, which boots the shell in Chromium. If no
`playwright` package resolves, install CI's version outside the repo and
point it at the installed Chrome:

```sh
npm install --prefix <scratchpad>/bento-browser --no-package-lock --ignore-scripts playwright@1.61.1
PLAYWRIGHT_MODULE=<scratchpad>/bento-browser/node_modules/playwright/index.mjs \
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
BENTO_SITE_DIR=<site clone> node scripts/release.mjs --key <file>
```

Do this before the key fetch, so a fetched key does not sit on disk while
the tooling is fixed. The version is the one in `.github/workflows/ci.yml`.

**Colleagues should never meet 1Password at all.** Their prompts came from
agent-facing text, not from the release. Until 2026-10-14 the beta-slides
skill said that publishing needs `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET` "in 1Password, Development", and an agent
following that text runs `op`, which prompts whoever is at the keyboard. `docs/DECISIONS.md` (2026-10-13
entry) records the cause and the fix:
- People publish by pairing: one browser click and no secret
  (`### Publishing: one click in a browser` in the skill).
- The service token is for CI only (`### Machines and CI: the service
  token`), and the skill tells the agent never to ask a person for it.
- `scripts/test-beta-splice.ts` fails if the tool's output mentions
  1Password (lines 594, 1085 and 1115).

That entry set a grant at 7 days. The 2026-10-14 entry raised it to 30
(`GRANT_TTL_S`, `server/deck-store/src/grant.js:32`, #63).

A fixed skill only reaches a colleague's Claude through several steps:
1. Regenerate the toolkit copy with `scripts/build-beta-toolkit-skill.mjs`.
2. Merge it into betamobility/skills.
3. The claude.ai org plugin sync picks it up.
4. The colleague restarts Claude Code.

Merged in this repo is not delivered to them. See claude-config's
`shipping-a-skill-to-the-team-means-the-beta-toolkit.md`.

## Why This Matters

A key fetch that needs a person turns an agent's release into a wait of
unknown length. Without the steps above, the agent either polls into a
timeout it cannot extend, or reports "blocked" with no clue about timing.
Each fetch started while nobody is at the Mac fails within a minute.

Doing every key-free step first means the person's one click is the last
step. Once they approve, the release goes live within minutes.

The colleague half matters more. Naming a secret store in agent-facing text
is an instruction every reader's agent carries out. Someone without access
to that vault gets a prompt they cannot satisfy, and someone with access
gets trained to approve prompts they do not understand.

## When to Apply

- Before any Beta Slides release run by an agent. Check whether
  `~/.bento/release-key.json` exists; if it does not, plan the release around
  the key click.
- Whenever a skill, guide or tool message you write would tell an agent where
  a secret lives. Agent-facing text should name a path that needs no secret
  (pairing). A credential belongs only in a section scoped to CI.
- When someone reports a 1Password prompt they did not expect. Look for
  agent-facing text that names a vault, item or `op` command, then check
  whether their plugin copy is current.

## Examples

What went wrong in this session:

```text
op document get … --out-file …/release-key.json   → authorization timeout (≈1 min)
perl -e 'alarm 600; exec @ARGV' op document get …  → authorization timeout (≈1 min)
until [ -s release-key.json ]; do sleep 2; done    → TIMEOUT after 1 h
```

What worked, the next time the maintainer was present:

```text
op document get … (foreground, person told to approve)   → rc=0
node scripts/release.mjs --key …/release-key.json        → signed
rm -P …/release-key.json
BENTO_RELEASE_ACCOUNTS=johanhal node scripts/publish-site.mjs "release v2026.10.11"
env -u CLOUDFLARE_API_TOKEN npx -y wrangler@4 pages deploy . --project-name beta-slides-site --branch main
```

## Related

- `docs/RELEASING.md`, One-time setup step 1: the key location this
  machine does not follow.
- `docs/DECISIONS.md`, 2026-10-13: why people publish by pairing, and why
  a person is never sent to a password manager.
- claude-config `docs/solutions/workflow-issues/shipping-a-skill-to-the-team-means-the-beta-toolkit.md`:
  how a skill fix reaches colleagues.
- claude-config `docs/solutions/workflow-issues/deck-store-cloudflare-access-r2-deploy-and-release.md`:
  where the deck-store service token came from (now for CI only).
