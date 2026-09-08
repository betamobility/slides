# Upstream PR: lift the signing key and relay host into `AppConfig`

**Branch:** `upstream-pr/appconfig-lift` (built from `upstream/main`, kernel files only, no attribution trailers)
**Target:** `nyblnet/bento` `main`
**Status:** open as [nyblnet/bento#423](https://github.com/nyblnet/bento/pull/423), from Johan's account, 2026-09-08. Was: prepared for Johan to open. Upstream's hard rule 10 declines agent-authored PRs, so the branch is his to offer, with the provenance that implies.

Open it with:

```sh
git push origin upstream-pr/appconfig-lift          # after the fork exists
gh pr create --repo nyblnet/bento --head betamobility:upstream-pr/appconfig-lift \
  --title "kernel: read the release public key and sync host from AppConfig" \
  --body-file docs/upstream-prs/appconfig-lift.md
```

---

## kernel: read the release public key and sync host from AppConfig

`kernel/src/update.ts` hardcodes `PUBLIC_KEY_JWK` and `kernel/src/sync/online.ts` hardcodes `DEFAULT_SYNC_HOST`. Both are per-publisher values, not per-kernel ones: a downstream build that runs its own signed release channel and its own relay has to patch the kernel to change them, and then carries that patch across every merge.

This adds two **optional** fields to `AppConfig`:

- `publicKeyJwk` — the P-256 public JWK manifests and pack indexes are verified against. Absent, `update.ts` uses the embedded platform key exactly as today.
- `syncHost` — the default relay host. Absent, `sync/online.ts` uses `DEFAULT_SYNC_HOST` exactly as today. The `bento-sync-url` localStorage dev override still wins over both.

Nothing changes for the apps in this repo: none of them set the fields, and every existing rig passes unchanged. `test-release-channel.mjs` still swaps the embedded constant by regex, because the constant is still there as the default.

Why optional and why in `AppConfig`: `app.ts` already says only three values are app-specific across the kernel. These two are publisher-specific, which is the same axis, and `configureApp()` is the one call every app already makes before any kernel module runs. `syncHost()` reads the config lazily and tolerates an unconfigured kernel, so rigs that never call `configureApp()` are unaffected.

Verified: `tsc -b`, `tsc -p ../kernel`, `npm run build:single`, `shell-gate.mjs`, `test-release-channel.mjs --app slides`, `test-sync-session.ts`, `test-relay-protocol.ts`, `test-offline.ts`, `test-storage.ts`, `test-autosave.ts`.
