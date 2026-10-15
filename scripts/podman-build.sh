#!/usr/bin/env bash
# Builds every SpeedrunLedger image with Podman.
#
# Behind an HTTPS proxy that re-signs TLS, set HTTPS_PROXY and
# BUILD_CA_BUNDLE (a PEM file); both are passed to the build only and never
# end up in an image.
set -euo pipefail
cd "$(dirname "$0")/.."

build_args=(--network=host)
if [[ -n "${HTTPS_PROXY:-}" ]]; then
  build_args+=(--build-arg "HTTPS_PROXY=${HTTPS_PROXY}" --build-arg "https_proxy=${HTTPS_PROXY}")
fi
if [[ -n "${BUILD_CA_BUNDLE:-}" ]]; then
  build_args+=(-v "${BUILD_CA_BUNDLE}:/etc/build-ca.pem:ro"
    --build-arg NODE_EXTRA_CA_CERTS=/etc/build-ca.pem
    --build-arg npm_config_cafile=/etc/build-ca.pem)
fi

build() {
  local name=$1 context=$2 file=${3:-$2/Containerfile}
  shift 3 || shift $#
  echo "==> building localhost/speedrunledger/${name}"
  podman build "${build_args[@]}" "$@" -t "localhost/speedrunledger/${name}:dev" -f "$file" "$context"
}

service() { build "$1" . infra/service.Containerfile --build-arg "PACKAGE=$1"; }

targets=("$@")
if [[ ${#targets[@]} -eq 0 ]]; then targets=(plc pds indexer appview runner-web); fi
for t in "${targets[@]}"; do
  case "$t" in
    plc) build plc infra/plc ;;
    pds) build pds infra/pds ;;
    indexer | appview | runner-web) service "$t" ;;
    *) echo "unknown image: $t" >&2; exit 1 ;;
  esac
done
