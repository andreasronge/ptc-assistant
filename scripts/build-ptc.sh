#!/usr/bin/env bash
# Builds the ptc_runner commit named in PTC_RUNNER_SHA into releases/<sha>/ and
# repoints releases/current at it. Keeps the last three builds.
#
#   scripts/build-ptc.sh               # build (or reuse) the pinned commit
#   scripts/build-ptc.sh --rollback SHA  # repoint current at a kept build
#   scripts/build-ptc.sh --list          # show kept builds, * marks current
#
# PTC_RUNNER_REPO   clone source (default the public GitHub repository)
# PTC_RUNNER_SRC    build checkout (default ~/.cache/ptc-assistant/ptc_runner)
# PTC_RELEASES_DIR  release directory (default <repo>/releases, git-ignored)
#
# The release is built for this host only; ptc_runner's standalone packaging
# script is not needed (see SPEC.md, "ptc_runner build").
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
releases=${PTC_RELEASES_DIR:-$repo/releases}
source_dir=${PTC_RUNNER_SRC:-${XDG_CACHE_HOME:-$HOME/.cache}/ptc-assistant/ptc_runner}
upstream=${PTC_RUNNER_REPO:-https://github.com/andreasronge/ptc_runner.git}
keep=3

die() {
  echo "build-ptc: $*" >&2
  exit 1
}

current_sha() {
  [[ -L "$releases/current" ]] && basename "$(readlink "$releases/current")"
}

# Replaces the link in one rename, so a concurrent reader never sees it
# missing. Plain `mv` would follow a link to a directory and move the new link
# inside it: GNU needs -T and BSD needs -h to treat the target as a file.
point_current() {
  rm -f "$releases/.current.tmp"
  ln -s "$1" "$releases/.current.tmp"
  if mv --version >/dev/null 2>&1; then
    mv -fT "$releases/.current.tmp" "$releases/current"
  else
    mv -fh "$releases/.current.tmp" "$releases/current"
  fi
  echo "current -> $1"
}

# A build is usable when it reports exactly this commit, clean.
verify() {
  local sha=$1 dir=$2 version
  version=$("$dir/bin/ptc" --version 2>/dev/null) || return 1
  [[ "$version" == *"(${sha:0:8}, clean)"* ]] || {
    echo "build-ptc: $dir reports '$version', expected ${sha:0:8}, clean" >&2
    return 1
  }
  echo "$version"
}

list() {
  local current
  current=$(current_sha || true)
  for dir in "$releases"/*/; do
    [[ -d "$dir" && ! -L "${dir%/}" ]] || continue
    local sha
    sha=$(basename "$dir")
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || continue
    printf '%s %s\n' "$([[ "$sha" == "$current" ]] && echo '*' || echo ' ')" "$sha"
  done
}

# Removes all but the newest $keep builds, never the current one.
prune_builds() {
  local current dir kept=0
  current=$(current_sha || true)
  # shellcheck disable=SC2045 # build names are 40 hex digits, no spaces
  for dir in $(ls -1dt "$releases"/*/ 2>/dev/null); do
    dir=${dir%/}
    if [[ -L "$dir" || ! "$(basename "$dir")" =~ ^[0-9a-f]{40}$ ]]; then continue; fi
    kept=$((kept + 1))
    if ((kept > keep)) && [[ "$(basename "$dir")" != "$current" ]]; then
      echo "removing old build $(basename "$dir")"
      rm -rf "$dir"
    fi
  done
}

in_toolchain() {
  if command -v mise >/dev/null; then
    (cd "$source_dir" && mise exec -- "$@")
  else
    (cd "$source_dir" && "$@")
  fi
}

case "${1:-}" in
  --list)
    list
    exit 0
    ;;
  --rollback)
    sha=${2:-}
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "--rollback needs a full 40-digit SHA (see --list)"
    [[ -d "$releases/$sha" ]] || die "no kept build $sha"
    verify "$sha" "$releases/$sha" >/dev/null || die "kept build $sha does not verify"
    point_current "$sha"
    exit 0
    ;;
  "") ;;
  *) die "unknown argument $1" ;;
esac

sha=$(tr -d '[:space:]' <"$repo/PTC_RUNNER_SHA")
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "PTC_RUNNER_SHA must hold one full 40-digit commit SHA"
mkdir -p "$releases"

if [[ -d "$releases/$sha" ]] && verify "$sha" "$releases/$sha"; then
  point_current "$sha"
  prune_builds
  exit 0
fi

if [[ ! -d "$source_dir/.git" ]]; then
  mkdir -p "$(dirname "$source_dir")"
  git clone --quiet "$upstream" "$source_dir"
fi
git -C "$source_dir" fetch --quiet origin
git -C "$source_dir" cat-file -e "$sha^{commit}" 2>/dev/null || die "commit $sha not found in $upstream"
git -C "$source_dir" checkout --quiet --detach "$sha"
git -C "$source_dir" clean -fdxq -e _build -e deps
[[ -z "$(git -C "$source_dir" status --porcelain)" ]] || die "build checkout is not clean"

if command -v mise >/dev/null; then
  # We build and run this exact commit anyway, so its tool pins are trusted.
  mise trust --quiet "$source_dir/mise.toml"
  in_toolchain mise install --quiet
fi
staging="$releases/.build-$sha"
rm -rf "$staging"
# deps.get and release in one invocation: a separate prod deps.get skips the
# Viewer's dependencies (see ptc_runner scripts/package_standalone_release.sh).
# shellcheck disable=SC1010 # `mix do` is a Mix task, not the shell keyword
in_toolchain env PTC_SOURCE_REVISION="$sha" PTC_SOURCE_DIRTY=false MIX_ENV=prod \
  mix do deps.get --only prod --check-locked + release ptc_runner --overwrite --path "$staging"

verify "$sha" "$staging" || die "the new build does not report ${sha:0:8}, clean"
rm -rf "${releases:?}/$sha"
mv "$staging" "$releases/$sha"
point_current "$sha"
prune_builds
