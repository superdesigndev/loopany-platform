#!/usr/bin/env bash
# Install the SELF-CONTAINED loopany-kernel CLI globally (no npm -g, no repo
# dependency at run time): esbuild-bundle the CLI + the kanban TUI chunk (the
# same bundles the published daemon ships), land them under ~/.local/lib, and
# expose `loopany-kernel` + the short `lk` via wrapper scripts in ~/.local/bin.
#
#   bash scripts/install-kernel-cli.sh              # install/update
#   bash scripts/install-kernel-cli.sh --uninstall  # remove everything
#
# Layout (the .mjs files must keep their extension - node derives the module
# type from it, so the bin entries are tiny sh wrappers, not renamed bundles):
#   ~/.local/lib/loopany-kernel/kernel-cli.mjs      # the CLI (kanban-free)
#   ~/.local/lib/loopany-kernel/kernel-kanban.mjs   # lazy TUI chunk (sibling
#                                                   #   lookup by kernel-cli)
#   ~/.local/bin/loopany-kernel                     # wrapper -> node kernel-cli.mjs
#   ~/.local/bin/lk                                 # symlink -> loopany-kernel
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="${LOOPANY_KERNEL_LIB:-$HOME/.local/lib/loopany-kernel}"
BIN="${LOOPANY_KERNEL_BIN:-$HOME/.local/bin}"
MARKER="# loopany-kernel installed by scripts/install-kernel-cli.sh"

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$LIB"
  for f in "$BIN/loopany-kernel" "$BIN/lk"; do
    # Only remove OUR wrapper/symlink - never a foreign binary of the same name.
    if [ -L "$f" ] || { [ -f "$f" ] && grep -q "$MARKER" "$f" 2>/dev/null; }; then rm -f "$f"; fi
  done
  echo "uninstalled loopany-kernel (lib + wrappers removed)"
  exit 0
fi

# 1. Bundle (the daemon's own build script: kernel-cli.mjs + the kanban chunk).
if [ ! -d "$ROOT/packages/daemon/node_modules" ]; then
  echo "▶ workspace deps missing - installing (pnpm) ..."
  ( cd "$ROOT" && npx -y pnpm@8.15.0 install ) >/dev/null
fi
echo "▶ bundling kernel CLI + kanban TUI ..."
( cd "$ROOT/packages/daemon" && node scripts/bundle-kernel-cli.mjs )

# 2. Land the bundles + wrappers.
mkdir -p "$LIB" "$BIN"
install -m 0644 "$ROOT/packages/daemon/dist/kernel-cli.mjs" "$LIB/kernel-cli.mjs"
install -m 0644 "$ROOT/packages/daemon/dist/kernel-kanban.mjs" "$LIB/kernel-kanban.mjs"

# Refuse to clobber a foreign `loopany-kernel`/`lk` (ours carries the marker).
for name in loopany-kernel lk; do
  f="$BIN/$name"
  if [ -e "$f" ] && ! [ -L "$f" ] && ! grep -q "$MARKER" "$f" 2>/dev/null; then
    echo "✗ $f exists and is not ours - refusing to overwrite" >&2
    exit 1
  fi
done

cat > "$BIN/loopany-kernel" <<EOF
#!/bin/sh
$MARKER
exec node "$LIB/kernel-cli.mjs" "\$@"
EOF
chmod 0755 "$BIN/loopany-kernel"
ln -sf loopany-kernel "$BIN/lk"

echo "✓ installed: $BIN/loopany-kernel (+ lk)"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "  NOTE: $BIN is not on PATH - add:  export PATH=\"$BIN:\$PATH\"" ;;
esac
echo
echo "next: bind a server globally, then call it from anywhere:"
echo "  lk connect https://loopany-kernel-testing.fly.dev --token dk_..."
echo "  lk list            # remote when no local .loopany is around"
echo "  lk list --remote   # force the global binding from inside a workspace"
