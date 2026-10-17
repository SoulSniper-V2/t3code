# Maintaining the Hoplite fork

The Hoplite integration lives on `SoulSniper-V2/t3code:feat/hoplite-provider`. Its upstream is `pingdotgg/t3code:main`; it does not require changes on the fork's default branch.

## Upstream sync

Run `bash scripts/sync-hoplite-upstream.sh` from a checkout with `origin` pointing to the fork and `upstream` pointing to the original repository. Node 24 and Vite Plus must be available on `PATH`.

The script fetches both branches and merges upstream in a temporary detached worktree. It leaves the current checkout, including uncommitted changes, alone. Conflicts, lockfile drift, failing affected-package typechecks, or failing focused Hoplite tests stop the sync without pushing. A successful sync uses an ordinary push; a concurrent remote update is rejected rather than force-pushed.

Pass `--dry-run` to perform the merge and validation without publishing it. A branch that already contains upstream exits without installing dependencies. The daily Capy automation invokes the same script and reports conflicts or failed checks for manual resolution.

## Local Mac nightly

Use a nightly version so the app installs beside the regular T3 build, and point updates at the fork so an upstream release cannot replace the integration:

```sh
T3CODE_DESKTOP_UPDATE_REPOSITORY=SoulSniper-V2/t3code \
  node scripts/build-desktop-artifact.ts \
  --platform mac --arch arm64 --target dmg \
  --build-version 0.1.0-nightly.YYYYMMDD.1
```

The packaging command builds the desktop, server, and web bundles. It does not publish a release. A local unsigned build is not notarized; distributing a signed build needs the fork owner's signing configuration.
