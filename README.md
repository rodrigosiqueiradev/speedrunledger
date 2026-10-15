# SpeedrunLedger

Speedrun leaderboards on the AT Protocol. Runners submit runs to their own
PDS, game communities review them with signed verdicts in the community's own
repo, and leaderboards are computed from those public records. Anyone can
rebuild the index and the boards from the network.

This is the prototype described in the "SpeedrunLedger: System Design"
document. It is being built in the doc's order; see [Status](#status).

## Layout

| Path | What it is |
| --- | --- |
| `packages/lexicon` | The 14 `app.speedrunledger-prototype.*` record lexicons (`lexicons/`) and TypeScript schemas generated from them with `@atproto/lex` (`pnpm --filter @speedrunledger/lexicon codegen`). |
| `packages/db` | Postgres schema and migrations (Kysely). |
| `packages/indexer` | Follows the repo event stream, validates records, and writes them to Postgres; backfills whole repos on first start. |
| `packages/testkit` | Helpers for integration tests against the local stack: accounts, records, a hand-built Super Mario 64 community. |
| `infra/` | Podman images for the local PDS and PLC directory, and `dev.yaml` for `podman kube play`. |
| `scripts/` | `podman-build.sh`, `dev-up.sh`, `dev-down.sh`. |

## Requirements

Node 22+, pnpm 10, and Podman (rootless works; no Docker).

## Local stack

```sh
pnpm install
pnpm infra:up      # builds images if needed, then starts the pods
pnpm infra:down    # stop; `scripts/dev-down.sh --volumes` also deletes data
```

`infra:up` runs `podman kube play infra/dev.yaml`, which starts two pods on
the host network:

- `ledger-pds`: a PDS on `localhost:2583` that accepts `.test` handles, and a
  PLC directory on `localhost:2582`, so DIDs and migrations work offline.
- `ledger-data`: Postgres on `localhost:5433`, and the indexer.

The first run generates random secrets into
`~/.local/share/speedrunledger/dev.env` and stores them as the `ledger-dev`
podman secret; nothing secret is baked into an image. `source` that file to
get `DATABASE_URL`, `PDS_URL` and `PLC_URL` in a shell.

The PDS and PLC images are built here from the official npm packages
(`@atproto/pds`, `@did-plc/server`) with the same entry point as the upstream
images, so the stack builds from npm and Docker Hub alone.

## Tests

```sh
pnpm infra:up
pnpm test
```

Unit tests need nothing. Integration tests run against the real PDS and PLC
directory in the local stack, with no mocks; each test file gets its own
throwaway Postgres database.

## Running the indexer outside a container

```sh
source ~/.local/share/speedrunledger/dev.env
pnpm --filter @speedrunledger/indexer dev
```

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (required). |
| `PDS_URL` | A PDS to follow and backfill from. |
| `FIREHOSE_URL` | Event stream to follow, if not the PDS (for example a relay). |
| `BACKFILL_SOURCES` | Comma-separated hosts to list repos from; defaults to `PDS_URL`. |
| `PLC_URL` | PLC directory; defaults to `https://plc.directory`. |
| `FORCE_BACKFILL` | `true` to backfill even when a cursor is stored. |
| `SKIP_BACKFILL` | `true` to only follow new events. |
| `DEV_MODE` | Allows plain-http identity lookups; on by default when `PLC_URL` is http. |

## Status

1. **Lexicons and indexer: done.** All 14 record types; the indexer stores
   hand-written records, verifies every commit's signature, backfills, and
   resumes from its cursor.
2. Runner app and boards: next.
3. Moderator app: review.
4. Moderator app: community management, plus the admin CLI.

## License

MIT
