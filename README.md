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
| `packages/lexicon` | The 16 `app.speedrunledger-prototype.*` record lexicons, the AppView queries and the community service procedures (`lexicons/`) and TypeScript schemas generated from them with `@atproto/lex` (`pnpm --filter @speedrunledger/lexicon codegen`). |
| `packages/db` | Postgres schema and migrations (Kysely), and the governance rules (proposal tallies, freezes) that the indexer, AppView and community service share. |
| `packages/indexer` | Follows the repo event stream, validates records, and writes them to Postgres; backfills whole repos on first start; keeps leaderboards up to date. |
| `packages/appview` | Read-only XRPC queries over the index: `listCommunities`, `getCommunity`, `getLeaderboard`, `getRun`, `getRunner`, `listReviewQueue`, `listMemberships`, `listProposals`, `getProposal`, `listModerators`, `listBans`, `listCommunityRequests`, `listWorldRecords`, `listNotifications`; and a Bluesky feed generator with a world-record feed per game. |
| `packages/community-service` | The only service holding community accounts' sessions. Writes verdicts, bans and game edits into a community's repo for moderators who prove their DID with a service-auth JWT; carries out passed proposals; announces world records on Bluesky; runs a labeler for suspected-cheating flags; serves the sysadmins' admin endpoints. |
| `packages/web-auth` | Server code shared by the web apps: atproto OAuth sign-in (sessions stored in Postgres), the AppView proxy and client serving. |
| `packages/web-ui` | Browser code shared by the web apps: router, time formatting, API helpers, styles. |
| `packages/runner-web` | The Runner app: browse boards, sign in, submit, edit and delete runs in your own repo, share runs to Bluesky, see notifications and world record history, and ask for a new community. React + Vite with a small Express backend. |
| `packages/moderator-web` | The Moderator app: your communities and invitations, the review queue and verdicts (verify, retime, request changes, reject), flags for suspected cheating, proposals waiting for your vote, and community management: proposals and votes, the moderator roster, bans, games, categories and rules, and repo export. |
| `packages/admin-cli` | `ledger-admin`, the sysadmins' command line, and the demo seed. |
| `packages/testkit` | Helpers for integration tests against the local stack: accounts, records, a hand-built Super Mario 64 community. |
| `infra/` | Podman images for the local PDS and PLC directory, and `dev.yaml` for `podman kube play`. |
| `scripts/` | `podman-build.sh`, `dev-up.sh`, `dev-down.sh`, `ledger-admin.sh`, `seed-demo.sh`. |

## Requirements

Node 22+, pnpm 10, and Podman (rootless works; no Docker).

The repo pins pnpm in `packageManager`; `corepack enable` gives you that
version.

### Windows (WSL)

Work inside WSL with the clone in the Linux filesystem (`~/…`, not
`/mnt/c/…`), and install Node and Podman inside WSL too. WSL appends the
Windows `PATH` to yours, so a Node or pnpm installed on Windows can be picked
up instead; Windows pnpm then fails with `current dir is an absolute path with
drive letter` or similar. Check with `which -a node pnpm`: the first entry of
each must not start with `/mnt/c/`. To fix it:

```sh
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
exec $SHELL -l
nvm install 22
corepack enable
hash -r
which pnpm         # should be under ~/.nvm, not /mnt/c
pnpm install
```

To keep Windows tools out of WSL for good, put `[interop]` and
`appendWindowsPath = false` in `/etc/wsl.conf`, then run `wsl --shutdown`
from Windows.

## Local stack

```sh
pnpm install
pnpm infra:up      # builds images if needed, then starts the pods
pnpm infra:down    # stop; `scripts/dev-down.sh --volumes` also deletes data
```

`infra:up` runs `podman kube play infra/dev.yaml`, which starts four pods on
the host network:

- `ledger-pds`: a PDS on `localhost:2583` that accepts `.test` handles, and a
  PLC directory on `localhost:2582`, so DIDs and migrations work offline.
- `ledger-data`: Postgres on `localhost:5433`, and the indexer.
- `ledger-web`: the AppView on `localhost:2584`, the Runner app on
  `http://127.0.0.1:2585` and the Moderator app on `http://127.0.0.1:2587`.
- `ledger-community`: the community service on `localhost:2586`, alone in its
  pod because it holds the community accounts' sessions.

Images are built the first time; after changing code, `scripts/dev-up.sh
--build` rebuilds our services' images.

Open the apps at `127.0.0.1`, not `localhost`: in development they sign in as
OAuth loopback clients, which atproto only allows on the loopback IP.

### Demo data

```sh
pnpm seed
```

seeds a Super Mario 64 community (`sm64.test`) created from a request by its
founding moderators `peach.test`, `luigi.test` and `toad.test`, who then vote
in the 16 Star and 70 Star categories and their rules; five runners
(`bobomb.test`, `koopa.test`, `goomba.test`, `boo.test`, `lakitu.test`) with
verified, retimed, pending and sent-back runs; a sysadmin `rosalina.test`; and a
pending request for a Super Mario Sunshine community. One of `boo.test`'s
runs is flagged as suspected cheating, and the world records are announced
from `sm64.test` as Bluesky posts. Every password is
`demo-password`. Seeding twice does nothing; start over with
`scripts/dev-down.sh --volumes`.

To make your own account on the local PDS instead:

```sh
source ~/.local/share/speedrunledger/dev.env
curl -s -X POST "$PDS_URL/xrpc/com.atproto.server.createAccount" \
  -H 'content-type: application/json' \
  -d '{"handle":"alice.test","email":"alice@example.test","password":"alice-pass"}'
```

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
throwaway Postgres database. The Runner app's end-to-end test drives Chromium
through the PDS's real sign-in and consent pages; it uses `playwright-core`
and looks for the browser at `CHROMIUM_PATH` (default
`/opt/pw-browsers/chromium`).

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

## Running the web services outside a container

Stop the container you are replacing first (`podman pod stop ledger-web`), then:

```sh
source ~/.local/share/speedrunledger/dev.env
pnpm --filter @speedrunledger/appview dev      # http://localhost:2584
pnpm --filter @speedrunledger/runner-web dev   # http://127.0.0.1:2585, with Vite hot reload
```

| Variable | Service | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | both | The indexer's Postgres (required). |
| `APPVIEW_PORT` | AppView | Port, default 2584. |
| `RUNNER_PORT` | Runner app | Port, default 2585. |
| `RUNNER_PUBLIC_URL` | Runner app | URL people open; default `http://127.0.0.1:<port>`. With any other host the app serves `/oauth-client-metadata.json` as its client id. |
| `APPVIEW_URL` | Runner app | Where `/xrpc/*` reads are proxied; default `http://localhost:2584`. |
| `COOKIE_SECRET` | Runner app | At least 32 characters; signs the session cookie (required). |
| `PDS_URL`, `PLC_URL` | Runner app | Development: resolve handles through this PDS and allow plain-http OAuth. `DEV_MODE=false` turns this off. |

The Moderator app (`pnpm --filter @speedrunledger/moderator-web dev`) takes
the same variables with `MODERATOR_PORT` (2587) and `MODERATOR_PUBLIC_URL`,
plus `COMMUNITY_SERVICE_URL` (default `http://localhost:2586`) and
`COMMUNITY_SERVICE_DID` (default `did:web:localhost%3A2586`).

## The community service

`pnpm --filter @speedrunledger/community-service dev` runs it outside a container.

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | The indexer's Postgres (required); it reads memberships, bans and runs from the index, and keeps encrypted community credentials in `community_credential`. |
| `COMMUNITY_SECRET_KEY` | 32 bytes of hex that encrypt those credentials (required). |
| `COMMUNITY_ADMIN_TOKEN` | Bearer token for the admin endpoints (required). |
| `COMMUNITY_SERVICE_PORT` | Port, default 2586. |
| `COMMUNITY_SERVICE_DID` | The audience moderators' tokens must name; default `did:web:localhost%3A<port>`. |
| `PLC_URL` | Where moderators' DIDs are resolved to check their tokens' signatures. |

Moderators call `app.speedrunledger-prototype.moderation.createVerdict` with a
service-auth JWT that their own PDS signs (`com.atproto.server.getServiceAuth`,
audience the service's DID, `lxm` the method). The Moderator app asks for that
token with the OAuth scope `rpc:app.speedrunledger-prototype.moderation.createVerdict?aud=*`.
The service then checks in the index that the caller is an active moderator of
the run's community, is not banned there, and did not run in the run, and that
the run is unchanged since it was opened.

It also serves `moderation.createBan` (any single moderator) and
`moderation.updateGame` (any moderator edits a game's title, year and
platforms), with the same checks. Frozen communities accept none of them.

Passed proposals are carried out every `EXECUTOR_INTERVAL_MS` (default 2000;
0 turns it off): invites become membership grants, kicks delete grants,
category and ruleset changes are written exactly as proposed, and lifted bans
are deleted. Record keys are derived from the proposal, so carrying one out
twice rewrites the same record.

| Variable | Meaning |
| --- | --- |
| `PDS_URL` | Where new community and platform accounts are created. |
| `PDS_ADMIN_PASSWORD` | Optional: lets the service mint invite codes on a PDS that requires them. |
| `EXECUTOR_INTERVAL_MS` | How often passed proposals are carried out and new world records announced. |
| `RUNNER_PUBLIC_URL` | The Runner app's URL, for links in world-record posts; default `http://127.0.0.1:2585`. |
| `FEED_SERVICE_DID` | The feed generator named in feed declarations; default `did:web:localhost%3A2584`. |
| `LABELER_SIGNING_KEY` | Hex secp256k1 key that signs labels; flagging is off without it. |
| `VIDEO_CHECK_INTERVAL_MS` | How often each ranked run's video links are rechecked; default a week, 0 turns it off. |

## Bluesky reach

Everything below works on the local PDS; nothing touches Bluesky's network
in development. Pointed at the real network, the same records show up in
Bluesky clients.

- **World records.** When a verified run takes first place on a board and
  beats the old time, the indexer records it (`world_record`; records found
  while backfilling are kept quiet). The Runner app shows each board's world
  record history (`listWorldRecords`).
- **Announcements.** The community service posts each new record from the
  community's own account as an `app.bsky.feed.post`, mentioning the new
  holder and the runner they beat, which notifies both on Bluesky, and
  linking to the run in the Runner app (`RUNNER_PUBLIC_URL`).
- **Feeds.** For every game it also writes an `app.bsky.feed.generator`
  declaration (same record key as the game) pointing at the AppView
  (`FEED_SERVICE_DID`, default `did:web:localhost%3A2584`), which serves
  `app.bsky.feed.getFeedSkeleton`, `describeFeedGenerator` and its did:web
  document: a feed of the game's world-record posts.
- **Share to Bluesky.** Runners can post a run from their own account, when
  submitting or later from the run page.
- **Notifications.** `listNotifications` collects verdicts on your runs,
  world records you set or lost, flags on your runs, invitations, and
  proposals waiting for your vote. The Runner app shows them with an unread
  count; the Moderator app lists the proposals waiting for you.
- **Suspected-cheating labels.** Any moderator can flag a run
  (`moderation.flagRun`); the community service signs a `suspected-cheating`
  atproto label with `LABELER_SIGNING_KEY` (secp256k1, hex) and serves it as
  a labeler: `com.atproto.label.queryLabels`, the `subscribeLabels` stream,
  and `#atproto_label`/`#atproto_labeler` entries in its DID document. A
  flag is a warning, not a verdict; boards don't change. Without the key,
  flagging is off.

## Hardening

- **Several approvals.** A category can require more than one approval
  (`requiredApprovals` on the category, changed by proposal like any other
  category field). Each moderator's `verified` verdict counts once
  (`AlreadyApproved` otherwise); the run ranks when enough approvals stand on
  its current version, and any edit sends it back to review. A moderator's
  retime carries forward to later approvals that don't give their own. The
  Moderator app shows approvals so far in the queue and on the review page.
- **Video link checks.** The community service checks the video links of
  every ranked run (`VIDEO_CHECK_INTERVAL_MS`, weekly by default; `ledger-admin
  videos check` runs it now). YouTube is asked through its oEmbed endpoint,
  which errors for deleted and private videos; other hosts get HEAD, then GET.
  Only "not found" and "gone" count as dead; timeouts and other errors are
  left alone. Dead links show on the run in both apps, in the Moderator app's
  Video links tab (`listVideoProblems`), and as a notification to the runner.
  The run keeps its place; what to do is the moderators' call.

Admin endpoints (`Authorization: Bearer $COMMUNITY_ADMIN_TOKEN`) back
`ledger-admin`; every sysadmin action names the acting sysadmin, who must be
listed in the platform account's repo.

## ledger-admin

```sh
pnpm ledger-admin --help
pnpm ledger-admin --as rosalina.test requests list
pnpm ledger-admin --as rosalina.test community create --request at://… --handle sm64.test --name "Super Mario 64"
pnpm ledger-admin --as rosalina.test community freeze sm64.test --reason "Leaderboard vandalism"
pnpm ledger-admin community export sm64.test --out sm64.car
pnpm ledger-admin videos check
```

`scripts/ledger-admin.sh` reads the admin token and URLs from `dev.env`.
Sysadmins set up the platform account (`platform init`), add sysadmins, answer
community requests (create or deny with a reason), add games, appoint a
moderator only when a community has none active, freeze and unfreeze, and
export a community's repo as a CAR file. They never touch verdicts or boards.
Outside the dev stack it needs `COMMUNITY_ADMIN_TOKEN` and takes
`COMMUNITY_SERVICE_URL`, `APPVIEW_URL`, `PDS_URL`, `PLC_URL` and
`LEDGER_SYSADMIN`.

## Status

1. **Lexicons and indexer: done.** All 14 record types; the indexer stores
   hand-written records, verifies every commit's signature, backfills, and
   resumes from its cursor.
2. **Runner app and boards: done.** OAuth sign-in, run submission, edits and
   deletes in the runner's repo, leaderboards computed from verdicts, and the
   AppView queries. A browser test takes a run from sign-in to a ranked entry.
3. **Moderator app, review: done.** The review queue, and verdicts written by
   the community service into the community's repo. A browser test takes a
   run from submission through review to a ranked entry.
4. **Community management and `ledger-admin`: done.** Community requests,
   sysadmin interventions, proposals and majority votes for invites, kicks,
   categories, rules and lifting bans, single-moderator bans, game edits, and
   repo export. Browser tests cover an invite voted in and accepted, a ban and
   a game edit, and a community request.
5. **Bluesky reach: done.** World records detected as boards change and
   announced from the community's account, a world-record feed per game,
   Share to Bluesky, notifications, and suspected-cheating labels from a
   labeler.
6. **Hardening: done.** Several approvals per run where a category asks for
   them, and weekly checks for dead video links. Co-signed reviews and the
   import tool are out of scope for the prototype.

## License

MIT
