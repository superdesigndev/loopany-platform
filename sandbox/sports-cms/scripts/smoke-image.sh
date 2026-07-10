#!/bin/sh
set -eu

image=${1:-adscaile-sportscms-sandbox:issue-30}
output=${2:-$(pwd)/sandbox/sports-cms/output/smoke}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
seccomp=$(dirname "$script_dir")/playwright-seccomp.json
mkdir -p "$output"
chmod 0777 "$output"

run() {
  docker run --rm --platform linux/amd64 \
    --user 10001:10001 \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --security-opt "seccomp=$seccomp" \
    --tmpfs /tmp:rw,nosuid,nodev,size=2g,uid=10001,gid=10001 \
    --tmpfs /home/factory:rw,nosuid,nodev,size=1g,uid=10001,gid=10001 \
    --tmpfs /workspace:rw,exec,nosuid,nodev,size=12g,uid=10001,gid=10001 \
    --network none \
    "$image" "$@"
}

run sh -lc 'test "$(id -u)" = 10001; test "$(id -g)" = 10001; test "$(awk "/^CapEff:/ { print \$2 }" /proc/self/status)" = 0000000000000000'
run sh -lc 'claude --version 2>&1 | grep -Eq "^2[.]1[.]206 "'
run sh -lc 'codex --version 2>&1 | grep -Eq "0[.]144[.]1$"'
run sh -lc 'opencode --version 2>&1 | grep -Eq "^1[.]17[.]18$"'
run sh -lc 'pi --version 2>&1 | grep -Eq "^0[.]73[.]1$"'
run sh -lc 'agent-browser --version 2>&1 | grep -Eq "0[.]31[.]1$"; playwright --version 2>&1 | grep -Eq "1[.]61[.]1$"'
run sh -lc 'adscaile --version; run-agent claude-code --version 2>&1 | grep -Eq "^2[.]1[.]206 "; run-agent codex --version 2>&1 | grep -Eq "0[.]144[.]1$"; run-agent opencode --version 2>&1 | grep -Eq "^1[.]17[.]18$"; run-agent pi --version 2>&1 | grep -Eq "^0[.]73[.]1$"; test "$(run-agent unsupported 2>/dev/null; printf %s $?)" = 64'
run sh -lc 'f=/home/factory/askpass-token; printf %s synthetic-test-only-token > "$f"; chmod 0600 "$f"; ADSCAILE_GIT_TOKEN_FILE="$f" adscaile-git-askpass Password >/dev/null; chmod 0644 "$f"; ! ADSCAILE_GIT_TOKEN_FILE="$f" adscaile-git-askpass Password >/dev/null 2>&1; rm "$f"; ln -s /dev/null "$f"; ! ADSCAILE_GIT_TOKEN_FILE="$f" adscaile-git-askpass Password >/dev/null 2>&1'
run sh -lc 'php --version; composer --version --no-ansi; git --version; mariadb --version; nginx -v; test -x /opt/project-golden/vendor/bin/drush'

docker run --rm --platform linux/amd64 \
  --user 10001:10001 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --security-opt "seccomp=$seccomp" \
  --tmpfs /tmp:rw,nosuid,nodev,size=2g,uid=10001,gid=10001 \
  --tmpfs /home/factory:rw,nosuid,nodev,size=1g,uid=10001,gid=10001 \
  --tmpfs /workspace:rw,exec,nosuid,nodev,size=12g,uid=10001,gid=10001 \
  --network none \
  --volume "$output:/evidence" \
  "$image" /usr/local/libexec/adscaile/drupal-smoke.sh /workspace /evidence

test -s "$output/drupal-smoke.png"
sha256sum "$output/drupal-smoke.png" > "$output/drupal-smoke.png.sha256"
printf '%s\n' 'image smoke: ok'
