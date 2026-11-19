#!/usr/bin/env bash
# Check, bump, commit and tag a release locally; never pushes. scripts/release.sh X.Y.Z [--dry-run] [-m msg]
set -euo pipefail

die() { printf 'release: %s\n' "$*" >&2; exit 1; }
ok() { printf '  ok  %s\n' "$*"; }

version='' dry=0 message=''
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) dry=1 ;;
    -m) shift; message=${1:-} ;;
    -*) die "unknown flag $1" ;;
    *) [ -z "$version" ] || die "one version only"; version=$1 ;;
  esac
  shift
done
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: scripts/release.sh X.Y.Z [--dry-run] [-m message]"
tag="v$version"
cd "$(git rev-parse --show-toplevel)"

echo "checks for $tag"
[ "$(git branch --show-current)" = main ] || die "not on main"
# Untracked notes (PLAN.md, proposals/) stay local; only tracked changes block a release.
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "the working tree has uncommitted changes (git status)"
ok "on a clean main"

git fetch --quiet origin main --tags
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || die "main and origin/main differ: push or pull first ($(git rev-list --left-right --count HEAD...origin/main | tr '\t' ' ') ahead/behind)"
ok "main is even with origin"

git rev-parse --quiet --verify "refs/tags/$tag" > /dev/null && die "tag $tag exists locally (git tag -d $tag if it was never pushed)"
[ -z "$(git ls-remote --tags origin "refs/tags/$tag")" ] || die "tag $tag is already on origin"
ok "$tag is new"

current=$(jq -r .version package.json)
name=$(jq -r .name package.json)
[ "$current" != "$version" ] || die "package.json is already $version"
[ "$(printf '%s\n%s\n' "$current" "$version" | sort -V | tail -n 1)" = "$version" ] || die "$version is not after $current"
# The publish job would fail on a version npm already has, after the tag is public.
npm view "$name@$version" version 2> /dev/null | grep -q . && die "$name@$version is already on npm"
ok "$current -> $version"

# The npmjs.com trusted publisher names this file; a rename breaks publishing.
[ -f .github/workflows/publish.yml ] || die ".github/workflows/publish.yml is missing (npm's trusted publisher names it)"
ok "publish.yml is in place"

echo "checks CI runs"
log=$(mktemp -t optilint-release)
for step in typecheck test lint:self bundle; do
  bun run "$step" > "$log" 2>&1 || die "bun run $step failed (see $log)"
done
ok "typecheck, tests, self-lint and bundle pass"

if [ "$dry" = 1 ]; then
  echo "dry run: all checks pass; nothing changed"
  exit 0
fi

npm pkg set "version=$version"
git commit --quiet -m "build(release): bump version to $version" -- package.json
git tag -a "$tag" -m "${message:-$tag}"
ok "committed $(git rev-parse --short HEAD) and tagged $tag"

cat <<EOF

Push in this order; the tag push starts validation and the npm publish:
  git push origin main
  git push origin $tag
EOF
