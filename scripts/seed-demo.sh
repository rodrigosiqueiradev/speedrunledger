#!/usr/bin/env bash
# Seeds the local stack with the demo community, moderators, runners and runs.
# Run after `pnpm infra:up`: pnpm seed
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dev_dir="${LEDGER_DEV_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/speedrunledger}"
if [[ -f "$dev_dir/dev.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$dev_dir/dev.env"
  set +a
fi
export APPVIEW_URL="${APPVIEW_URL:-http://localhost:2584}"
exec node --conditions=@speedrunledger/source --import "$root/node_modules/tsx/dist/esm/index.mjs" \
  "$root/packages/admin-cli/src/seed-bin.ts" "$@"
