# Credential-free SportsCMS sandbox image

This directory implements GitHub issue #30 and the accepted image contract in
issue #6. The release artifact is a single `linux/amd64` image named
`ghcr.io/maphilipps/adscaile-sportscms-sandbox`. Tags are discovery-only; trusted
profiles and Run evidence must use the platform manifest digest.

The image contains the exact Claude Code, Codex, OpenCode, PI, Playwright and
agent-browser versions in `image.lock.json`, the adScaile callback built from the
locked platform commit, a sanitized SportsCMS source seed with prebuilt Composer
dependencies, PHP/Composer/MariaDB/nginx tooling, and non-root wrappers. It never
contains credentials or an authenticated agent home. Runtime credentials are
external, Run-scoped inputs owned by the Runner.

## Local build and verification

Use a clean detached SportsCMS checkout at the commit pinned in
`image.lock.json`. The scripts reject dirty or mismatched inputs before Docker is
invoked.

```sh
node --test sandbox/sports-cms/scripts/contract.test.mjs
sandbox/sports-cms/scripts/build-image.sh /path/to/clean/adesso-sports-cms
sandbox/sports-cms/scripts/smoke-image.sh adscaile-sportscms-sandbox:issue-30
sandbox/sports-cms/scripts/scan-image.sh adscaile-sportscms-sandbox:issue-30
sandbox/sports-cms/scripts/verify-negative-control.sh /path/to/clean/adesso-sports-cms
sandbox/sports-cms/scripts/reproducible-build.sh /path/to/clean/adesso-sports-cms
```

`smoke-image.sh` runs with UID/GID 10001, a read-only root filesystem, all
capabilities dropped, fresh tmpfs home/workspace/tmp mounts, and no network. It
probes all four agent versions, browser tooling, callback/wrapper, PHP/Composer,
Git/MariaDB/nginx, Drupal installation from the synthetic seed, and a sandboxed
Chromium screenshot. Chromium uses the exact Playwright v1.61.1 seccomp profile;
the profile hash is part of `image.lock.json`.

`scan-image.sh` inspects image history and raw image bytes for canaries, exports
the final root filesystem, rejects forbidden auth/config homes and unsafe paths,
runs the redacted credential/PII policy over authored payload files in every raw
layer and the final filesystem, runs digest-pinned Trivy and Gitleaks scans over
the complete image, emits a Syft SPDX JSON SBOM, and applies the Grype
High/Critical vulnerability gate. Locked OS/npm/Composer dependency trees are
covered by the complete-image scanners and SBOM; authored project, callback and
runtime payloads are additionally covered by the exact-hash allowlist policy.
Scanner output records paths/rules/hashes, never matching secret text.

`verify-negative-control.sh` builds the never-published `negative-control` stage.
Its synthetic sentinels are added and deleted in separate layers; the raw-layer
scanner must still detect private-key, token, email, phone, and IBAN classes.

`reproducible-build.sh` uses two independent ephemeral builders running the
locked BuildKit image. Both cold, cache-disabled OCI builds must produce the same
platform manifest digest. CI repeats the source-revision build and retains the
digest, SBOM, provenance and scan evidence.

## Release contract

Pull requests run only the credential-free contract suite with read-only GitHub
permissions. Image builds run only after merge to `main` or by manual dispatch;
only that trusted job can read the read-only SportsCMS deploy key stored as the
`SPORTS_CMS_DEPLOY_KEY` Actions secret. Every build uses the digest-pinned
BuildKit. A publish dispatch compares the pushed linux/amd64 platform manifest
with the two cold reproducibility builds, then re-runs smoke and security gates
on the exact registry digest before attestation and signing. Credential rotation,
Worker selection, models, Linear intake and per-Run Git/provider tokens never
change this image and never enter its build context.
