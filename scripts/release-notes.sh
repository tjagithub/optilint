#!/usr/bin/env bash
# Release notes for a tag from the conventional commit headers since the tag before it. scripts/release-notes.sh vX.Y.Z
set -euo pipefail

tag=$1
prev=$(git describe --tags --abbrev=0 --match 'v*' "$tag^" 2>/dev/null || true)
range=${prev:+$prev..}$tag
version=${tag#v}

section() {
  local title=$1 pattern=$2 lines
  lines=$(git log --reverse --format=%s "$range" | grep -E "^$pattern(\(.+\))?!?: " | sed -E 's/^[a-z]+(\([^)]*\))?!?: /- /' || true)
  [ -z "$lines" ] || printf '### %s\n\n%s\n\n' "$title" "$lines"
}

section Features feat
section Fixes fix
section Performance perf
printf 'npm: [@optilint/cli@%s](https://www.npmjs.com/package/@optilint/cli/v/%s)' "$version" "$version"
[ -z "$prev" ] || printf ' · [changes since %s](https://github.com/tjagithub/optilint/compare/%s...%s)' "$prev" "$prev" "$tag"
printf '\n'
