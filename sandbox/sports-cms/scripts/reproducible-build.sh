#!/bin/sh
set -eu

sports_source=${1:?SportsCMS checkout is required}
output=${2:-$(pwd)/sandbox/sports-cms/output/reproducibility}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
image_dir=$(dirname "$script_dir")
repo_root=$(CDPATH= cd -- "$image_dir/../.." && pwd)
context=${TMPDIR:-/tmp}/adscaile-sportscms-repro-context
platform_sha=$(git -C "$repo_root" rev-parse HEAD)
mkdir -p "$output"
"$script_dir/prepare-context.sh" "$sports_source" "$context"

builders=""
cleanup() {
  for builder in $builders; do "$script_dir/pinned-builder.sh" remove "$builder" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT INT TERM

build_once() {
  index=$1
  builder=adscaile-repro-$index-$$
  builders="$builders $builder"
  "$script_dir/pinned-builder.sh" create "$builder" >/dev/null
  docker buildx build \
    --builder "$builder" \
    --platform linux/amd64 \
    --target sandbox \
    --file "$context/image/Dockerfile" \
    --build-arg SOURCE_DATE_EPOCH=1783510608 \
    --build-arg "PLATFORM_GIT_SHA=$platform_sha" \
    --no-cache \
    --provenance=false --sbom=false \
    --output "type=oci,dest=$output/build-$index.tar,rewrite-timestamp=true" \
    "$context"
  tar -xOf "$output/build-$index.tar" index.json \
    | jq -r '.manifests[0].digest' > "$output/build-$index.digest"
  rm "$output/build-$index.tar"
}

build_once 1
build_once 2
cmp "$output/build-1.digest" "$output/build-2.digest"
cp "$output/build-1.digest" "$output/platform-manifest-digest.txt"
printf 'reproducible image digest: %s\n' "$(cat "$output/platform-manifest-digest.txt")"
