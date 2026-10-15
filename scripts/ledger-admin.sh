#!/usr/bin/env bash
# Runs ledger-admin against the local stack, with the admin token and URLs
# from the dev.env that dev-up.sh wrote. Example: pnpm ledger-admin community list
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
# pnpm runs scripts from the repo root; keep relative paths (like --out) relative to where you ran it.
cd "${INIT_CWD:-$PWD}"
exec node --conditions=@speedrunledger/source --import "$root/node_modules/tsx/dist/esm/index.mjs" \
  "$root/packages/admin-cli/src/bin.ts" "$@"
