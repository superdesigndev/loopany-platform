#!/bin/sh
set -eu

sports_source=${1:?SportsCMS checkout is required}
tag=${2:-adscaile-sportscms-sandbox:issue-30}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
image_dir=$(dirname "$script_dir")
repo_root=$(CDPATH= cd -- "$image_dir/../.." && pwd)
context=${TMPDIR:-/tmp}/adscaile-sportscms-context
platform_sha=$(git -C "$repo_root" rev-parse HEAD)
builder=adscaile-candidate-$$
cleanup() { "$script_dir/pinned-builder.sh" remove "$builder" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

"$script_dir/prepare-context.sh" "$sports_source" "$context"
"$script_dir/pinned-builder.sh" create "$builder" >/dev/null
docker buildx build \
  --builder "$builder" \
  --platform linux/amd64 \
  --target sandbox \
  --file "$context/image/Dockerfile" \
  --build-arg SOURCE_DATE_EPOCH=1783510608 \
  --build-arg "PLATFORM_GIT_SHA=$platform_sha" \
  --provenance=false \
  --sbom=false \
  --output type=docker \
  --tag "$tag" \
  "$context"

docker image inspect "$tag" --format '{{.Id}}' | tee "$image_dir/image-id.txt"
