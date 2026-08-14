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
#   ~/.local/bin/lk-runtime                         # this checkout's DAEMON half
#
# TWO isolation guarantees are baked into the wrappers, so a user never has to
# remember an env var in every shell:
#
#  1. LOOPANY_HOME defaults to ~/.loopany-kernel-live, NOT the production
#     ~/.loopany. The kernel CLI and the daemon deliberately share ONE
#     credential home, so an unpinned `lk setup` against another server
#     rewrites the production `server-url` + machine key in place and points
#     the user's real daemon at the wrong environment.
#  2. LOOPANY_RUNTIME_BIN points at lk-runtime. `lk setup` enrolls the machine
#     by shelling out to a runtime binary; it looks for a bundled `cli.js` next
#     to the launcher (published layout only) and otherwise falls back to bare
#     `loopany` on PATH. In a source install that fallback can be an unrelated
#     older checkout whose daemon knows neither `--runtime-only` nor `mk_`
#     enrollment, which hangs setup at "starting daemon…" against a 401.
#
# Both are `${VAR:-default}` so an explicit env var still wins.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="${LOOPANY_KERNEL_LIB:-$HOME/.local/lib/loopany-kernel}"
BIN="${LOOPANY_KERNEL_BIN:-$HOME/.local/bin}"
HOME_DEFAULT="${LOOPANY_KERNEL_LIVE_HOME:-$HOME/.loopany-kernel-live}"
MARKER="# loopany-kernel installed by scripts/install-kernel-cli.sh"

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$LIB"
  for f in "$BIN/loopany-kernel" "$BIN/lk" "$BIN/lk-runtime"; do
    # Only remove OUR wrapper/symlink - never a foreign binary of the same name.
    if [ -L "$f" ] || { [ -f "$f" ] && grep -q "$MARKER" "$f" 2>/dev/null; }; then rm -f "$f"; fi
  done
  echo "uninstalled loopany-kernel (lib + wrappers removed)"
  exit 0
fi

# The source launcher uses the checkout's tsx runtime and workspace packages.
# lk-runtime additionally runs the daemon from source, so check both trees.
if ! ( cd "$ROOT/packages/cli" && node -e 'require.resolve("tsx/cli"); require.resolve("@loopany/kernel")' ) >/dev/null 2>&1 \
  || ! ( cd "$ROOT/packages/daemon" && node -e 'require.resolve("tsx/cli")' ) >/dev/null 2>&1; then
  echo "▶ workspace deps missing - installing (pnpm) ..."
  ( cd "$ROOT" && npx -y pnpm@8.15.0 install ) >/dev/null
fi

mkdir -p "$BIN"

# Refuse to clobber a foreign `loopany-kernel`/`lk`/`lk-runtime` (ours carries
# the marker; an npm bin symlink is ours to replace).
for name in loopany-kernel lk lk-runtime; do
  f="$BIN/$name"
  if [ -e "$f" ] && ! [ -L "$f" ] && ! grep -q "$MARKER" "$f" 2>/dev/null; then
    echo "✗ $f exists and is not ours - refusing to overwrite" >&2
    exit 1
  fi
done

cat > "$BIN/loopany-kernel" <<EOF
#!/bin/sh
$MARKER
# Isolated credential home + a runtime pinned to THIS checkout. See the header
# of scripts/install-kernel-cli.sh for why both defaults exist.
LOOPANY_HOME="\${LOOPANY_HOME:-$HOME_DEFAULT}"
LOOPANY_RUNTIME_BIN="\${LOOPANY_RUNTIME_BIN:-$BIN/lk-runtime}"
export LOOPANY_HOME LOOPANY_RUNTIME_BIN
exec node "$ROOT/packages/cli/bin/loopany-kernel.mjs" "\$@"
EOF
chmod 0755 "$BIN/loopany-kernel"
ln -sf loopany-kernel "$BIN/lk"

# The daemon half. `lk setup` calls this to enroll the machine, and the user
# calls it directly to inspect or stop the kernel-live daemon - so that
# production `loopany` never has to be aimed at another environment.
cat > "$BIN/lk-runtime" <<EOF
#!/bin/sh
$MARKER
LOOPANY_HOME="\${LOOPANY_HOME:-$HOME_DEFAULT}"
export LOOPANY_HOME
exec node "$ROOT/packages/daemon/node_modules/tsx/dist/cli.mjs" \\
  "$ROOT/packages/daemon/src/cli.ts" "\$@"
EOF
chmod 0755 "$BIN/lk-runtime"

echo "✓ installed: $BIN/loopany-kernel (+ lk) -> $ROOT/packages/cli/bin/loopany-kernel.mjs"
echo "✓ installed: $BIN/lk-runtime -> $ROOT/packages/daemon/src/cli.ts"
echo "  credential home: $HOME_DEFAULT (production ~/.loopany is left alone)"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "  NOTE: $BIN is not on PATH - add:  export PATH=\"$BIN:\$PATH\"" ;;
esac
echo
echo "next: one command signs you in, enrolls this machine, and starts its daemon:"
echo "  lk setup /<workspace> --server https://loopany-kernel-live.fly.dev"
echo "  lk list              # the shared task tree"
echo "  lk-runtime status    # the kernel-live daemon (never touches production)"
