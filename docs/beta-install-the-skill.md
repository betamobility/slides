# Install the Beta Slides skill — paste this whole file into Claude Code

> **What this file is.** Everything below is addressed to somebody's Claude
> Code, not to them: send the whole thing and let their agent run it. It exists
> because "the skill does not exist" was reported twice, and both times the
> cause was the install rather than the plugin — see *If it still does not
> appear*. Keep it paste-ready when editing; the reader is a machine with a
> Bash tool.
>
> If nothing is wrong, the entire procedure is two commands and a restart:
> `claude plugin marketplace add betamobility/slides`, then
> `claude plugin install beta-slides@beta-slides`.

You are being asked to install a Claude Code plugin for a colleague at Beta
Mobility. Do the work yourself with the Bash tool; only the last step needs a
human. Report what each command actually printed, not what it should print.

## Background you need

The skill is `beta-slides`. It lives in a **public** GitHub repo,
`betamobility/slides`, so no login, no GitHub org membership and no Beta
credentials are needed to install it.

**The most likely reason it "does not exist" is that adding the marketplace was
mistaken for installing the plugin. They are two separate steps.** Adding a
marketplace only tells Claude Code where to look.

## Step 1 — add the marketplace

```sh
claude plugin marketplace add betamobility/slides
```

Then confirm it is registered:

```sh
claude plugin marketplace list
```

Expect a marketplace named `beta-slides` sourced from `betamobility/slides`.

## Step 2 — install the plugin

```sh
claude plugin install beta-slides@beta-slides
```

The `@beta-slides` suffix names the marketplace, which happens to share the
plugin's name. The default scope is `user`, which is what you want: the skill
then works in every folder, not just the current project. If you install with
`--scope project` it will appear to vanish the moment they open another
directory — that is a real cause of "the skill does not exist".

## Step 3 — verify, before telling anyone it worked

```sh
claude plugin list
```

Expect a line like:

```
  ❯ beta-slides@beta-slides
    Version: 0.1.0
    Scope: user
    Status: ✔ enabled
```

`Status: ✘ disabled` means it installed but is switched off — fix with
`claude plugin enable beta-slides@beta-slides`.

Then check the skill itself is inside the plugin:

```sh
claude plugin details beta-slides@beta-slides
```

Expect `Skills (1)  beta-slides` under the component inventory. If the plugin
installed but the inventory shows `Skills (0)`, stop and report that — it is a
packaging problem on our side, not theirs.

## Step 4 — the one human step

**Skills load when a session starts, so the person must quit Claude Code and
open it again.** You cannot do this for them. Say so plainly and wait.

After the restart, the skill is not something they run. It fires on what they
ask. Have them type something like:

> Make me a Beta deck about the Kolumbus workshop from this note.

If it fired, Claude announces it is using the `beta-slides` skill and then
fetches `https://slides.betamobility.ai/agents.md` before authoring.

## If it still does not appear

Work through these in order and report which one it was.

1. **Claude Code too old for plugins.** `claude --version`. If plugin
   subcommands are missing entirely, update Claude Code first.
2. **Marketplace added but not installed.** `claude plugin marketplace list`
   shows it, `claude plugin list` does not. Re-run step 2.
3. **Installed at the wrong scope.** `claude plugin list` shows
   `Scope: project`. Reinstall with `--scope user`.
4. **No network to GitHub.** `claude plugin marketplace update beta-slides`
   fails. The repo is public, so this is their network or proxy, not access.
5. **Installed and enabled, but never fires.** The skill triggers on deck and
   presentation wording. Ask for "a deck" or "a presentation" explicitly rather
   than "some slides about X".

## What the skill does once it works

It authors Beta decks as single self-contained `.bento.html` files: the Beta
design system, the right shell, and editable-PowerPoint export. It downloads
the shell and templates from `slides.betamobility.ai`, whose `/templates/` and
`/releases/` paths are public and need no login.

If their machine cannot reach that host, the same four templates are on the
Shared drive at:

```
Beta Mobility Consulting / 07 Resources / Presentations / 00 bento templates
```

They can be opened and edited directly, no Claude required.
