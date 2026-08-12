#!/usr/bin/env bash
# Build, pack, and npm-install the @crewlet/loopany daemon GLOBALLY from this
# checkout - exactly the artifact an npm user would get (real bin links for
# `loopany` AND `loopany-kernel`, bundled kernel CLI + kanban TUI inside).
#
#   bash scripts/install-daemon.sh
#
# Refuses to clobber a global loopany that did NOT come from this script's
# package (@crewlet/loopany) - remove it yourself first if you mean it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON="$ROOT/packages/daemon"

existing="$(command -v loopany || true)"
if [ -n "$existing" ]; then
  # An existing global install of OUR package is fine to upgrade in place; a
  # foreign `loopany` is not ours to replace.
  if ! node -e "require('$(npm root -g)/@crewlet/loopany/package.json')" >/dev/null 2>&1; then
    echo "✗ a foreign \`loopany\` is already on PATH at $existing - refusing" >&2
    exit 1
  fi
fi

if [ ! -d "$DAEMON/node_modules" ]; then
  echo "▶ workspace deps missing - installing (pnpm) ..."
  ( cd "$ROOT" && npx -y pnpm@8.15.0 install ) >/dev/null
fi

echo "▶ building + packing the daemon ..."
( cd "$DAEMON" && npx -y pnpm@8.15.0 run build ) >/dev/null
TMP="$(mktemp -d -t loopany-daemon-install)"
trap 'rm -rf "$TMP"' EXIT
TARBALL="$(cd "$DAEMON" && npm pack --pack-destination "$TMP" --silent 2>/dev/null | tail -1)"

echo "▶ npm install -g $TARBALL ..."
npm install -g "$TMP/$TARBALL" --no-audit --no-fund >/dev/null

echo "✓ installed: $(command -v loopany) (+ loopany-kernel)"
loopany --version
