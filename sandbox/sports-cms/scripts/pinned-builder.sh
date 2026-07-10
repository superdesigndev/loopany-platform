#!/bin/sh
set -eu

action=${1:?create or remove is required}
name=${2:?builder name is required}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
image_dir=$(dirname "$script_dir")

case "$action" in
  create)
    buildkit=$(jq -r .supplyChain.buildkit "$image_dir/image.lock.json")
    docker buildx create --name "$name" --driver docker-container \
      --driver-opt "image=$buildkit" >/dev/null
    if ! docker buildx inspect "$name" --bootstrap >/dev/null; then
      docker buildx rm "$name" >/dev/null 2>&1 || true
      exit 1
    fi
    printf '%s\n' "$name"
    ;;
  remove) docker buildx rm "$name" >/dev/null ;;
  *) echo "pinned-builder: unsupported action" >&2; exit 64 ;;
esac
