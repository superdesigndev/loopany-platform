#!/bin/sh
set -eu

root=${1:?project root is required}
test -f "$root/composer.json"
test -f "$root/composer.lock"

for relative in \
  .adscaile .claude .codex .ddev .grok .opencode .pi .playwright-mcp \
  .mcp.json branding db docs vendor node_modules web/sites/default/files; do
  rm -rf "$root/$relative"
done
rm -f "$root/dashboard-app/public/roadmap-data.json"

find "$root" -depth \
  \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \
     -o -name '*.p12' -o -name '*.pfx' -o -name 'auth.json' \
     -o -name '.npmrc' -o -name '.netrc' -o -name '*.log' -o -name '*.pdf' \
     -o -name '*.sql' -o -name '*.sql.gz' -o -name '*.tar' -o -name '*.tar.gz' \
     -o -name '*.zip' \) -exec rm -rf {} +

rm -rf "$root/config/sync"
mkdir -p "$root/config/synthetic"
cat > "$root/config/synthetic/system.site.yml" <<'YAML'
uuid: 03276217-2579-4d04-bba1-f71c194c7a5a
name: 'Synthetic SportsCMS Fixture'
mail: factory@example.invalid
slogan: ''
page:
  403: ''
  404: ''
  front: /node
admin_compact_mode: false
weight_select_max: 100
default_langcode: de
mail_notification: null
YAML

find "$root" -type l -print | while IFS= read -r link; do
  target=$(readlink "$link")
  case "$target" in
    /*|*../*|../*|*/..|..) echo "project sanitizer: unsafe symbolic link" >&2; exit 1 ;;
  esac
  cp -L "$link" "$link.resolved"
  rm "$link"
  mv "$link.resolved" "$link"
done

find "$root" -exec touch -h -t 202607081336.48 {} +
find "$root" -type d -exec chmod 0755 {} +
find "$root" -type f -exec chmod 0644 {} +
find "$root" -type f -name '*.sh' -exec chmod 0755 {} +
