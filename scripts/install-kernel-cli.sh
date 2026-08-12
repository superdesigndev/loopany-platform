#!/usr/bin/env bash
# Install a DEVELOPMENT loopany-kernel CLI globally (no npm -g). The wrapper
# points directly at this checkout's source launcher, so edits and branch
# switches take effect immediately without rebuilding or reinstalling.
#
#   bash scripts/install-kernel-cli.sh              # install/update
#   bash scripts/install-kernel-cli.sh --uninstall  # remove everything
#
# Layout:
#   ~/.local/bin/loopany-kernel                     # wrapper -> checkout source
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

# The source launcher uses the checkout's tsx runtime and workspace packages.
if ! ( cd "$ROOT/packages/cli" && node -e 'require.resolve("tsx/cli"); require.resolve("@loopany/kernel")' ) >/dev/null 2>&1; then
  echo "▶ workspace deps missing - installing (pnpm) ..."
  ( cd "$ROOT" && npx -y pnpm@8.15.0 install ) >/dev/null
fi

mkdir -p "$BIN"

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
exec node "$ROOT/packages/cli/bin/loopany-kernel.mjs" "\$@"
EOF
chmod 0755 "$BIN/loopany-kernel"
ln -sf loopany-kernel "$BIN/lk"

echo "✓ installed: $BIN/loopany-kernel (+ lk) -> $ROOT/packages/cli/bin/loopany-kernel.mjs"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "  NOTE: $BIN is not on PATH - add:  export PATH=\"$BIN:\$PATH\"" ;;
esac
echo
echo "next: bind a server globally, then call it from anywhere:"
echo "  lk connect https://loopany-kernel-testing.fly.dev --token dk_..."
echo "  lk list            # remote when no local .loopany is around"
echo "  lk list --remote   # force the global binding from inside a workspace"
