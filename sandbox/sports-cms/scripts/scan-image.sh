#!/bin/sh
set -eu

image=${1:-adscaile-sportscms-sandbox:issue-30}
output=${2:-$(pwd)/sandbox/sports-cms/output/security}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
image_dir=$(dirname "$script_dir")
lock=$image_dir/image.lock.json
mkdir -p "$output"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/adscaile-image-scan.XXXXXX")
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT INT TERM

docker history --no-trunc --format '{{json .}}' "$image" > "$output/history.jsonl"
if grep -Eqi '(authorization:|password=|token=|api[_-]?key=|-----BEGIN .*PRIVATE KEY-----)' "$output/history.jsonl"; then
  echo "image scan: credential-shaped history entry" >&2
  exit 1
fi

docker save "$image" --output "$tmp/image.tar"
"$script_dir/scan-layers.sh" "$image" "$tmp/image.tar" > "$output/raw-layer-scan.txt"
for sentinel in \
  'SYNTHETIC-ONLY-NEVER-A-CREDENTIAL' \
  'adscaile_canary_secret_value_000000000000' \
  'canary.person@not-a-real-company.invalid'; do
  if grep -aFq "$sentinel" "$tmp/image.tar"; then
    echo "image scan: negative-control sentinel found in release layers" >&2
    exit 1
  fi
done

container=$(docker create "$image")
trap 'docker rm -f "$container" >/dev/null 2>&1 || true; cleanup' EXIT INT TERM
docker export "$container" --output "$tmp/rootfs.tar"
docker rm "$container" >/dev/null
container=
mkdir "$tmp/rootfs"
tar -xf "$tmp/rootfs.tar" -C "$tmp/rootfs"
cmp "$tmp/rootfs/opt/agent-tools/package-lock.json" "$image_dir/package-lock.json"
test "$(sha256sum "$tmp/rootfs/opt/project-golden/composer.lock" | cut -d' ' -f1)" = \
  "$(jq -r .sportsCms.composerLockSha256 "$lock")"
node "$script_dir/scan-tree.mjs" "$tmp/rootfs" \
  --allowlist "$image_dir/scanner-allowlist.json" --payload-only \
  > "$output/final-payload-scan.txt"

for forbidden in \
  root/.ssh root/.claude root/.codex root/.config/opencode root/.pi \
  home/factory/.ssh home/factory/.claude home/factory/.codex \
  home/factory/.config/opencode home/factory/.pi; do
  test ! -e "$tmp/rootfs/$forbidden"
done
if find "$tmp/rootfs" -xdev -type f \( -perm -4000 -o -perm -2000 \) -print -quit | grep -q .; then
  echo "image scan: setuid/setgid file found" >&2
  exit 1
fi
if find "$tmp/rootfs/opt/project-golden" -type f \
  \( -name '.env*' -o -name '*.pem' -o -name '*.key' -o -name 'auth.json' -o -name '.npmrc' \) \
  -print -quit | grep -q .; then
  echo "image scan: forbidden project seed path found" >&2
  exit 1
fi

trivy=$(jq -r .supplyChain.trivy "$lock")
gitleaks=$(jq -r .supplyChain.gitleaks "$lock")
syft=$(jq -r .supplyChain.syft "$lock")
grype=$(jq -r .supplyChain.grype "$lock")

docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$trivy" image \
  --scanners secret --exit-code 1 --no-progress "$image" \
  > "$output/trivy-secret.txt"
docker run --rm -v "$tmp/rootfs:/scan:ro" "$gitleaks" detect \
  --source=/scan --no-banner --redact --exit-code=1 \
  > "$output/gitleaks.txt"
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$syft" \
  "docker:$image" -o spdx-json > "$output/sbom.syft.spdx.json"
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$grype" \
  "docker:$image" --fail-on high -o json > "$output/grype.json"

test -s "$output/sbom.syft.spdx.json"
jq -e '.packages | length > 0' "$output/sbom.syft.spdx.json" >/dev/null
printf '%s\n' 'image security scan: ok'
