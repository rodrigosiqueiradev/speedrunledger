#!/usr/bin/env bash
# Starts the local stack (Postgres, indexer, PLC directory, PDS) with podman kube play.
#
# First run generates random dev secrets into $LEDGER_DEV_DIR/dev.env
# (default ~/.local/share/speedrunledger) and stores them as the `ledger-dev`
# podman secret. Delete that file and run `pnpm infra:down --volumes` to start over.
set -euo pipefail
cd "$(dirname "$0")/.."

dev_dir="${LEDGER_DEV_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/speedrunledger}"
env_file="$dev_dir/dev.env"
mkdir -p "$dev_dir"
chmod 700 "$dev_dir"

if [[ ! -f "$env_file" ]]; then
  umask 077
  pg_password=$(openssl rand -hex 16)
  cat > "$env_file" <<ENV
POSTGRES_PASSWORD=$pg_password
PDS_JWT_SECRET=$(openssl rand -hex 32)
PDS_ADMIN_PASSWORD=$(openssl rand -hex 16)
PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=$(openssl rand -hex 32)
DATABASE_URL=postgres://ledger:$pg_password@localhost:5433/ledger
PDS_URL=http://localhost:2583
PLC_URL=http://localhost:2582
ENV
  echo "generated dev secrets in $env_file"
fi
# shellcheck disable=SC1090
source "$env_file"

b64() { printf '%s' "$1" | base64 -w0; }
secret_yaml=$(cat <<YAML
apiVersion: v1
kind: Secret
metadata:
  name: ledger-dev
data:
  postgresPassword: $(b64 "$POSTGRES_PASSWORD")
  databaseUrl: $(b64 "$DATABASE_URL")
  plcDatabaseUrl: $(b64 "$DATABASE_URL")
  pdsJwtSecret: $(b64 "$PDS_JWT_SECRET")
  pdsAdminPassword: $(b64 "$PDS_ADMIN_PASSWORD")
  pdsRotationKeyHex: $(b64 "$PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX")
YAML
)
podman secret rm ledger-dev >/dev/null 2>&1 || true
printf '%s\n' "$secret_yaml" | podman kube play - >/dev/null

for image in plc pds indexer appview; do
  if ! podman image exists "localhost/speedrunledger/$image:dev"; then
    scripts/podman-build.sh "$image"
  fi
done

podman kube play --replace infra/dev.yaml

wait_for() {
  local name=$1 url=$2
  for _ in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then echo "$name is up"; return 0; fi
    sleep 1
  done
  echo "$name did not come up; see: podman pod logs" >&2
  return 1
}
wait_for plc http://localhost:2582/_health
wait_for pds http://localhost:2583/xrpc/_health
wait_for appview "http://localhost:2584/xrpc/app.speedrunledger-prototype.listCommunities"
echo "env for tools and tests: source $env_file"
