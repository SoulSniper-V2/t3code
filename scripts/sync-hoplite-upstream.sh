#!/usr/bin/env bash
set -euo pipefail

dry_run=false
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
  shift
fi
if [[ $# -ne 0 ]]; then
  printf 'Usage: %s [--dry-run]\n' "$0" >&2
  exit 2
fi

root=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
branch=feat/hoplite-provider
origin=$(git -C "$root" remote get-url origin)
upstream=$(git -C "$root" remote get-url upstream)
case "$origin" in
  https://github.com/SoulSniper-V2/t3code|https://github.com/SoulSniper-V2/t3code.git|git@github.com:SoulSniper-V2/t3code.git) ;;
  *) printf 'Refusing to sync an unexpected fork remote.\n' >&2; exit 1 ;;
esac
case "$upstream" in
  https://github.com/pingdotgg/t3code|https://github.com/pingdotgg/t3code.git|git@github.com:pingdotgg/t3code.git) ;;
  *) printf 'Refusing to sync an unexpected upstream remote.\n' >&2; exit 1 ;;
esac

git -C "$root" fetch origin "$branch"
git -C "$root" fetch upstream main
head=$(git -C "$root" rev-parse "origin/$branch")
if git -C "$root" merge-base --is-ancestor upstream/main "$head"; then
  printf 'The Hoplite branch already contains upstream/main.\n'
  exit 0
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/t3code-hoplite-sync.XXXXXX")
checkout="$scratch/checkout"
cleanup() {
  if [[ -d "$checkout" ]]; then
    git -C "$checkout" merge --abort >/dev/null 2>&1 || true
    git -C "$root" worktree remove "$checkout" || true
  fi
  rmdir "$scratch" 2>/dev/null || true
}
trap cleanup EXIT
git -C "$root" worktree add --detach "$checkout" "$head"
cd "$checkout"
if ! git merge --no-ff --no-edit upstream/main; then
  printf 'Upstream conflicts with Hoplite. Nothing was pushed; manual resolution is required.\n' >&2
  exit 1
fi

export PATH="$checkout/node_modules/.bin:$PATH"
vp install --frozen-lockfile
vp run --filter @t3tools/provider-hoplite --filter @t3tools/contracts --filter @t3tools/client-runtime --filter t3 --filter @t3tools/web typecheck
vp test run packages/provider-hoplite/src apps/server/src/hoplite packages/contracts/src/hoplite.test.ts packages/client-runtime/src/state/commandPermissions.test.ts apps/server/src/orchestration-v2/RunExecutionService.test.ts apps/server/src/orchestration-v2/ThreadLaunchService.test.ts apps/web/src/components/settings/HopliteProviderSettings.test.ts apps/web/src/components/settings/hopliteWorkspace.logic.test.ts
if [[ "$dry_run" == true ]]; then
  printf 'The upstream merge passed validation. Dry run: nothing was pushed.\n'
  exit 0
fi
git push origin "HEAD:$branch"
printf 'Merged upstream/main into %s after focused validation.\n' "$branch"
