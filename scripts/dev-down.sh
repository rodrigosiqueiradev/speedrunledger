#!/usr/bin/env bash
# Stops the local stack. Pass --volumes to also delete its data.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${1:-}" == "--volumes" ]]; then
  podman kube down --force infra/dev.yaml || true
else
  podman kube down infra/dev.yaml || true
fi
