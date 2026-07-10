#!/bin/sh
set -eu

image=${1:?image is required}
archive=${2:?docker image archive is required}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
image_dir=$(dirname "$script_dir")
root=$(mktemp -d "${TMPDIR:-/tmp}/adscaile-layer-scan.XXXXXX")
cleanup() { rm -rf "$root"; }
trap cleanup EXIT INT TERM

tar -xf "$archive" -C "$root"
index=0
for layer in $(jq -r '.[0].Layers[]' "$root/manifest.json"); do
  layer_dir=$root/layer-$index
  mkdir "$layer_dir"
  tar -xf "$root/$layer" -C "$layer_dir"
  node "$script_dir/scan-tree.mjs" "$layer_dir" \
    --allowlist "$image_dir/scanner-allowlist.json" --payload-only
  index=$((index + 1))
done
printf 'raw layer payload scan: ok (%s layers)\n' "$index"
