#!/bin/sh
set -eu

sports_source=${1:?SportsCMS checkout is required}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
image_dir=$(dirname "$script_dir")
context=${TMPDIR:-/tmp}/adscaile-sportscms-negative-context
image=adscaile-sportscms-sandbox:negative-control
tmp=$(mktemp -d "${TMPDIR:-/tmp}/adscaile-negative-scan.XXXXXX")
builder=adscaile-negative-$$
cleanup() {
  "$script_dir/pinned-builder.sh" remove "$builder" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

"$script_dir/prepare-context.sh" "$sports_source" "$context"
"$script_dir/pinned-builder.sh" create "$builder" >/dev/null
docker buildx build \
  --builder "$builder" \
  --platform linux/amd64 \
  --target negative-control \
  --file "$context/image/Dockerfile" \
  --build-arg SOURCE_DATE_EPOCH=1783510608 \
  --provenance=false --sbom=false --load --tag "$image" "$context"
docker save "$image" --output "$tmp/image.tar"
report=$tmp/production-layer-scan.jsonl
"$script_dir/scan-layers.sh" "$image" "$tmp/image.tar" >"$report" 2>/dev/null && {
  echo "negative control: production layer scanner did not fail" >&2
  exit 1
}
for rule in PRIVATE_KEY TOKEN_ASSIGNMENT EMAIL PHONE IBAN; do
  grep -Fq "\"rule\":\"$rule\",\"path\":\"opt/adscaile-negative-control.txt\"" "$report"
done
tar -xf "$tmp/image.tar" -C "$tmp"

found=0
index=0
for layer in $(jq -r '.[0].Layers[]' "$tmp/manifest.json"); do
  layer_dir=$tmp/layer-$index
  mkdir "$layer_dir"
  tar -xf "$tmp/$layer" -C "$layer_dir"
  if test -f "$layer_dir/opt/adscaile-negative-control.txt"; then
    node "$script_dir/scan-tree.mjs" "$layer_dir" --expect-canary
    found=1
    break
  fi
  index=$((index + 1))
done
test "$found" = 1
printf '%s\n' 'negative-control layer scan: ok'
