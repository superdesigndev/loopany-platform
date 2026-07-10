# syntax=docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d
FROM mcr.microsoft.com/playwright:v1.61.1-noble@sha256:cf0daee9b994042e011bc29f20cdff1a9f682a039b43fcd738f7d8a9d3bcd9d6 AS sandbox

ARG SOURCE_DATE_EPOCH=1783510608
ARG PLATFORM_GIT_SHA=unknown
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} \
    DEBIAN_FRONTEND=noninteractive \
    HOME=/home/factory \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    COMPOSER_HOME=/tmp/composer \
    COMPOSER_CACHE_DIR=/tmp/composer-cache

COPY image/apt-packages.lock /tmp/apt-packages.lock
RUN rm -f /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources \
    && printf '%s\n' \
      'deb [check-valid-until=no signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://snapshot.ubuntu.com/ubuntu/20260710T000000Z noble main universe' \
      'deb [check-valid-until=no signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://snapshot.ubuntu.com/ubuntu/20260710T000000Z noble-updates main universe' \
      'deb [check-valid-until=no signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://snapshot.ubuntu.com/ubuntu/20260710T000000Z noble-security main universe' \
      > /etc/apt/sources.list \
    && apt-get update \
    && xargs -r apt-get install -y --no-install-recommends < /tmp/apt-packages.lock \
    && apt-get purge -y sudo openssh-server \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /tmp/apt-packages.lock

RUN curl --fail --silent --show-error --location \
      https://getcomposer.org/download/2.10.2/composer.phar \
      --output /usr/local/bin/composer \
    && echo '5ee7125f8a30a34d246cefdc0bc85b8a783b28f2aec968994118512350d28027  /usr/local/bin/composer' | sha256sum -c - \
    && chmod 0755 /usr/local/bin/composer \
    && composer --version --no-ansi

COPY image/package.json image/package-lock.json /opt/agent-tools/
RUN cd /opt/agent-tools \
    && npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && rm -rf /home/factory/.npm /home/factory/.cache /home/factory/.config \
    && ln -s /opt/agent-tools/node_modules/.bin/claude /usr/local/bin/claude \
    && ln -s /opt/agent-tools/node_modules/.bin/codex /usr/local/bin/codex \
    && ln -s /opt/agent-tools/node_modules/.bin/opencode /usr/local/bin/opencode \
    && ln -s /opt/agent-tools/node_modules/.bin/pi /usr/local/bin/pi \
    && ln -s /opt/agent-tools/node_modules/.bin/playwright /usr/local/bin/playwright \
    && ln -s /opt/agent-tools/node_modules/.bin/agent-browser /usr/local/bin/agent-browser

COPY platform/ /tmp/platform/
RUN cd /tmp/platform \
    && /opt/agent-tools/node_modules/.bin/pnpm install --filter @crewlet/adscaile... --frozen-lockfile \
    && /opt/agent-tools/node_modules/.bin/pnpm --filter @crewlet/adscaile build \
    && /opt/agent-tools/node_modules/.bin/pnpm --filter @crewlet/adscaile deploy --prod /opt/adscaile \
    && rm -rf /tmp/platform /root/.local/share/pnpm /root/.cache /home/factory/.local /tmp/composer /tmp/composer-cache

COPY project-source/ /opt/project-golden/
RUN cd /opt/project-golden \
    && test "$(sha256sum composer.json | cut -d' ' -f1)" = '2a594012428be97d33c605c5b6d983b471950f05c2e65913bc1fad88b2dd4a95' \
    && test "$(sha256sum composer.lock | cut -d' ' -f1)" = '15c8997b374c52efd5c0b358141c61fa0dea0498903ec4e7f792e60a8dac7fce' \
    && composer install --no-interaction --no-progress --prefer-dist --optimize-autoloader \
    && test -x vendor/bin/drush \
    && composer clear-cache \
    && rm -rf /tmp/composer /tmp/composer-cache

COPY image/runtime/ /usr/local/libexec/adscaile/
RUN chmod 0555 /usr/local/libexec/adscaile/* \
    && ln -s /usr/local/libexec/adscaile/adscaile /usr/local/bin/adscaile \
    && ln -s /usr/local/libexec/adscaile/run-agent /usr/local/bin/run-agent \
    && ln -s /usr/local/libexec/adscaile/git-askpass /usr/local/bin/adscaile-git-askpass \
    && ln -s /usr/local/libexec/adscaile/sandbox-entrypoint /usr/local/bin/sandbox-entrypoint \
    && mkdir -p /opt/adscaile/image \
    && find /opt/project-golden -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > /opt/adscaile/image/project-files.sha256 \
    && jq -n \
      --arg fixtureGeneratorCommit '82b66a4c5b567fe4212337ce47d6ee46351bef0e' \
      --arg drupalSourceCommit 'fc2454212b2a975d7b8f706ec58eef11365f9e14' \
      --arg configRevision '5e2e496e0a8a9c41a53cd38c6a58a326c53f2f217377aa06f3ac464a402c4d43' \
      --arg syntheticConfigSha256 'fcdfd7546b4b8b9f65bffd15be2f1e541af9dc23c06ef414ba7a912b848a264e' \
      --arg fixtureSeed 'sports-cms-synthetic-v1' \
      --arg locale 'de-DE' \
      --arg projectFilesSha256 "$(sha256sum /opt/adscaile/image/project-files.sha256 | cut -d' ' -f1)" \
      '{schemaVersion:1,fixtureGeneratorCommit:$fixtureGeneratorCommit,drupalSourceCommit:$drupalSourceCommit,sourceConfigRevision:$configRevision,syntheticConfigSha256:$syntheticConfigSha256,fixtureSeed:$fixtureSeed,locale:$locale,inputs:{projectFilesSha256:$projectFilesSha256,database:null,filesArchive:null}}' \
      > /opt/adscaile/image/seed-manifest.json \
    && find /opt/project-golden -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} + \
    && chmod -R a-w /opt/project-golden /opt/agent-tools /opt/adscaile \
    && find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod a-s {} +

RUN groupadd --gid 10001 factory \
    && useradd --no-log-init --uid 10001 --gid 10001 --home-dir /home/factory --create-home --shell /bin/bash factory \
    && chage --lastday 0 factory \
    && mkdir -p /workspace /run/adscaile/credentials \
    && chown 10001:10001 /workspace /home/factory \
    && chmod 0755 /workspace /home/factory \
    && chmod 0555 /run/adscaile /run/adscaile/credentials \
    && rm -rf /root/.npm /root/.config /root/.cache /home/pwuser \
    && test ! -e /usr/bin/sudo \
    && test ! -e /usr/sbin/sshd \
    && test "$(awk -F: '$1 == "factory" { print $3 }' /etc/shadow)" = 0

LABEL org.opencontainers.image.source="https://github.com/maphilipps/adscaile-platform" \
      org.opencontainers.image.revision="${PLATFORM_GIT_SHA}" \
      org.opencontainers.image.title="adScaile SportsCMS credential-free sandbox" \
      dev.adscaile.callback.revision="82b66a4c5b567fe4212337ce47d6ee46351bef0e"

USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint"]
CMD ["sleep", "infinity"]

FROM sandbox AS negative-control
USER 0:0
COPY image/test-fixtures/negative-control.txt /opt/adscaile-negative-control.txt
RUN rm /opt/adscaile-negative-control.txt
USER 10001:10001
