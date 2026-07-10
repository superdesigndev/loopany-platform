#!/bin/sh
set -eu

sports_source=${1:?SportsCMS checkout is required}
destination=${2:?destination is required}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
image_dir=$(dirname "$script_dir")
repo_root=$(CDPATH= cd -- "$image_dir/../.." && pwd)
lock=$image_dir/image.lock.json

node "$script_dir/verify-lock.mjs"
expected_sports=$(jq -r .sportsCms.commit "$lock")
expected_sports_archive=$(jq -r .sportsCms.archiveSha256 "$lock")
expected_callback=$(jq -r .callback.commit "$lock")
expected_callback_archive=$(jq -r .callback.daemonArchiveSha256 "$lock")

test "$(git -C "$sports_source" rev-parse HEAD)" = "$expected_sports"
test -z "$(git -C "$sports_source" status --porcelain --untracked-files=all)"
test "$(git -C "$sports_source" archive --format=tar "$expected_sports" | sha256sum | cut -d' ' -f1)" = "$expected_sports_archive"
test "$(git -C "$repo_root" archive --format=tar "$expected_callback" packages/daemon | sha256sum | cut -d' ' -f1)" = "$expected_callback_archive"

rm -rf "$destination"
mkdir -p "$destination/image" "$destination/platform" "$destination/project-source"
git -C "$sports_source" archive --format=tar "$expected_sports" | tar -xf - -C "$destination/project-source"
"$script_dir/sanitize-project.sh" "$destination/project-source"

git -C "$repo_root" archive --format=tar "$expected_callback" \
  package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json packages/daemon \
  | tar -xf - -C "$destination/platform"
find "$destination/platform/packages/daemon/src" -type f -name '*.test.ts' -delete
rsync -a --delete \
  --exclude node_modules --exclude output --exclude '.DS_Store' \
  "$image_dir/" "$destination/image/"

test "$(sha256sum "$destination/project-source/composer.json" | cut -d' ' -f1)" = "$(jq -r .sportsCms.composerJsonSha256 "$lock")"
test "$(sha256sum "$destination/project-source/composer.lock" | cut -d' ' -f1)" = "$(jq -r .sportsCms.composerLockSha256 "$lock")"
test "$(sha256sum "$destination/project-source/config/synthetic/system.site.yml" | cut -d' ' -f1)" = "$(jq -r .sportsCms.syntheticConfigSha256 "$lock")"
node "$script_dir/scan-tree.mjs" "$destination" --allowlist "$image_dir/scanner-allowlist.json"
printf '%s\n' "$destination"
