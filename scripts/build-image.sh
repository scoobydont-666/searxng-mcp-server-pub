#!/usr/bin/env bash
# Build an immutable OCI candidate. Publishing requires the explicit --push flag.
set -euo pipefail

main() {
  local image="${1:?Usage: build-image.sh registry/owner/image [--push]}"
  local publish="${2:-}"
  local source_revision
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "${script_dir}/.."
  [[ "${image}" =~ ^[a-z0-9][a-z0-9./_-]+$ ]] || { echo 'Use an untagged registry image name' >&2; return 2; }
  [[ -z "${publish}" || "${publish}" == '--push' ]] || { echo 'Unknown option' >&2; return 2; }
  [[ -z "$(git status --porcelain)" ]] || { echo 'Commit reviewed source before building an identified artifact' >&2; return 1; }
  source_revision="$(git rev-parse HEAD)"
  command -v buildah >/dev/null
  [[ "$(buildah info --format '{{.host.rootless}}')" == 'true' ]] || {
    echo 'Run Buildah rootless on an isolated build worker' >&2; return 1;
  }
  buildah bud --format oci --layers=false --label "org.opencontainers.image.revision=${source_revision}" \
    --tag "${image}:${source_revision}" --file Containerfile .
  if [[ "${publish}" == '--push' ]]; then
    mkdir -p artifacts
    buildah push --digestfile "artifacts/image-${source_revision}.digest" \
      "${image}:${source_revision}" "docker://${image}:${source_revision}"
    printf 'Published %s:%s; digest in artifacts/image-%s.digest\n' "${image}" "${source_revision}" "${source_revision}"
  else
    printf 'Built local OCI candidate %s:%s\n' "${image}" "${source_revision}"
  fi
}

main "$@"
