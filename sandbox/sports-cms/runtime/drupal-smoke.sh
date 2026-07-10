#!/bin/sh
set -eu

workspace=${1:-/workspace}
evidence=${2:-$workspace}
rm -rf "$workspace/project"
mkdir -p "$workspace/project"
rsync -a --chmod=Du+w,Fu+w /opt/project-golden/ "$workspace/project/"
cd "$workspace/project"

mkdir -p web/sites/default/files runtime
cp web/sites/default/default.settings.php web/sites/default/settings.php
cat >> web/sites/default/settings.php <<'PHP'
$databases['default']['default'] = [
  'driver' => 'sqlite',
  'database' => dirname(__DIR__, 3) . '/runtime/synthetic.sqlite',
  'prefix' => '',
];
$settings['hash_salt'] = 'sports-cms-synthetic-fixture-v1';
$settings['config_sync_directory'] = dirname(__DIR__, 3) . '/config/synthetic';
PHP
chmod 0600 web/sites/default/settings.php

vendor/bin/drush site:install minimal -y \
  --site-name='Synthetic SportsCMS Fixture' \
  --account-name='factory-admin' \
  --account-mail='factory@example.invalid' \
  --account-pass='synthetic-test-only'
vendor/bin/drush config:set system.site uuid 03276217-2579-4d04-bba1-f71c194c7a5a -y
vendor/bin/drush status --fields=bootstrap,db-status,drupal-version --format=json
test "$(vendor/bin/drush config:get system.site uuid --format=string)" = 03276217-2579-4d04-bba1-f71c194c7a5a

php -S 127.0.0.1:8080 -t web >"$workspace/drupal-http.log" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT INT TERM
attempt=0
until curl --fail --silent http://127.0.0.1:8080/ >/dev/null; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 30
  sleep 1
done
node /usr/local/libexec/adscaile/browser-smoke.mjs http://127.0.0.1:8080/ "$evidence/drupal-smoke.png"
