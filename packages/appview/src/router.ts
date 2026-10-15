import { LexRouter, LexServerError } from '@atproto/lex-server'
import { sql } from 'kysely'
import { boardKey, type CategoryVariable, type Database } from '@speedrunledger/db'
import { platformDid } from '@speedrunledger/db'
import { ledger, type MembershipView, type QueueItem, type RequestView, type RunView } from '@speedrunledger/lexicon'
import { Views } from './views.js'

const notFound = (message: string) => new LexServerError(404, { error: 'NotFound', message })
const invalid = (message: string) => new LexServerError(400, { error: 'InvalidRequest', message })

/** XRPC queries of the AppView, served from the indexer's database. */
export function createRouter(db: Database): LexRouter {
  const views = new Views(db)
  const requireCommunity = async (did: string) => {
    const row = await db.selectFrom('community').select('did').where('did', '=', did).executeTakeFirst()
    if (!row) throw notFound('Community not found')
  }

  return new LexRouter()
    .add(ledger.listCommunities, async ({ params }) => {
      const limit = params.limit ?? 50
      let query = db.selectFrom('community').selectAll().orderBy('name').orderBy('did').limit(limit + 1)
      if (params.cursor) query = query.where('did', '>', params.cursor)
      const rows = await query.execute()
      const page = rows.slice(0, limit)
      return {
        body: {
          communities: await views.communityDetails(page),
          cursor: rows.length > limit ? page[page.length - 1].did : undefined,
        },
      }
    })

    .add(ledger.getCommunity, async ({ params }) => {
      const row = await db.selectFrom('community').selectAll().where('did', '=', params.community).executeTakeFirst()
      if (!row) throw notFound('Community not found')
      const [community] = await views.communityDetails([row])
      return { body: { community } }
    })

    .add(ledger.getLeaderboard, async ({ params }) => {
      const category = await db.selectFrom('category').selectAll().where('uri', '=', params.category).executeTakeFirst()
      if (!category) throw notFound('Category not found')
      const [game, community, rulesets] = await Promise.all([
        db.selectFrom('game').selectAll().where('uri', '=', category.game_uri).executeTakeFirst(),
        db.selectFrom('community').selectAll().where('did', '=', category.community_did).executeTakeFirst(),
        views.currentRulesets([category.uri]),
      ])
      if (!game || !community) throw notFound('Category has no game or community')

      const requested = new Map<string, string>()
      for (const pair of params.variables ?? []) {
        const eq = pair.indexOf('=')
        if (eq <= 0) throw invalid(`variables must look like id=value, got "${pair}"`)
        requested.set(pair.slice(0, eq), pair.slice(eq + 1))
      }
      const subcategory: Record<string, string> = {}
      for (const v of category.variables as CategoryVariable[]) {
        if (!v.subcategory) continue
        const value = requested.get(v.id) ?? v.values[0]
        if (!v.values.includes(value)) throw invalid(`"${value}" is not a value of ${v.id}`)
        subcategory[v.id] = value
      }

      const entries = await db
        .selectFrom('board_entry')
        .selectAll()
        .where('board_key', '=', boardKey(category.uri, subcategory))
        .orderBy('rank')
        .orderBy('indexed_at')
        .limit(params.limit ?? 100)
        .execute()
      const runs = entries.length
        ? await db.selectFrom('run').selectAll().where('uri', 'in', entries.map((e) => e.run_uri)).execute()
        : []
      const runViews = new Map<string, RunView>((await views.runs(runs)).map((r) => [r.uri, r]))
      const communityViews = await views.communities([community])

      return {
        body: {
          category: views.category(category, rulesets.get(category.uri)),
          game: views.game(game),
          community: communityViews.get(community.did)!,
          subcategory: Object.entries(subcategory).map(([variable, value]) => ({ variable, value })),
          entries: entries.flatMap((e) => {
            const run = runViews.get(e.run_uri)
            return run ? [{ rank: e.rank, rankedMs: e.ranked_ms, run }] : []
          }),
        },
      }
    })

    .add(ledger.getRun, async ({ params }) => {
      const row = await db.selectFrom('run').selectAll().where('uri', '=', params.uri).executeTakeFirst()
      if (!row) throw notFound('Run not found')
      const [run] = await views.runs([row], { verdicts: true })
      return { body: { run } }
    })

    .add(ledger.listReviewQueue, async ({ params }) => {
      const community = await db.selectFrom('community').select('did').where('did', '=', params.community).executeTakeFirst()
      if (!community) throw notFound('Community not found')
      const limit = params.limit ?? 50
      // Waiting: well formed, runner not banned, no rejection or change request on the
      // current version, and fewer distinct approvals of it than the category requires.
      let query = db
        .selectFrom('run as r')
        .innerJoin('category as c', 'c.uri', 'r.category_uri')
        .leftJoinLateral(
          (eb) =>
            eb
              .selectFrom('verification as v')
              .select(['v.status', 'v.subject_cid'])
              .whereRef('v.subject_uri', '=', 'r.uri')
              .whereRef('v.community_did', '=', 'r.community_did')
              .where('v.reviewer_active', '=', true)
              .orderBy('v.indexed_at', 'desc')
              .orderBy('v.uri', 'desc')
              .limit(1)
              .as('latest'),
          (join) => join.onTrue(),
        )
        .leftJoinLateral(
          (eb) =>
            eb
              .selectFrom('verification as a')
              .select([
                sql<number>`count(distinct a.reviewer_did)::int`.as('n'),
                sql<string[]>`coalesce(array_agg(distinct a.reviewer_did), '{}')`.as('dids'),
              ])
              .whereRef('a.subject_uri', '=', 'r.uri')
              .whereRef('a.subject_cid', '=', 'r.cid')
              .whereRef('a.community_did', '=', 'r.community_did')
              .where('a.reviewer_active', '=', true)
              .where('a.status', '=', 'verified')
              .as('appr'),
          (join) => join.onTrue(),
        )
        .selectAll('r')
        .select(['appr.n as approvals', 'appr.dids as approved_by'])
        .where('r.community_did', '=', params.community)
        .where(sql<boolean>`r.problems = '[]'::jsonb`)
        .where((eb) =>
          eb.or([eb('latest.status', 'is', null), eb('latest.subject_cid', '!=', eb.ref('r.cid')), eb('latest.status', '=', 'verified')]),
        )
        .where(sql<boolean>`coalesce(appr.n, 0) < c.required_approvals`)
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('ban as b')
                .select('b.uri')
                .whereRef('b.community_did', '=', 'r.community_did')
                .whereRef('b.subject_did', '=', 'r.runner_did'),
            ),
          ),
        )
        .orderBy('r.first_indexed_at')
        .orderBy('r.uri')
        .limit(limit + 1)
      if (params.category) query = query.where('r.category_uri', '=', params.category)
      if (params.cursor) {
        const [at, uri] = [params.cursor.slice(0, params.cursor.indexOf('|')), params.cursor.slice(params.cursor.indexOf('|') + 1)]
        const after = new Date(at)
        if (Number.isNaN(after.getTime()) || !uri) throw invalid('Bad cursor')
        query = query.where((eb) =>
          eb.or([eb('r.first_indexed_at', '>', after), eb.and([eb('r.first_indexed_at', '=', after), eb('r.uri', '>', uri)])]),
        )
      }
      const rows = await query.execute()
      const page = rows.slice(0, limit)
      const categories = await db
        .selectFrom('category')
        .selectAll()
        .where('uri', 'in', page.length ? [...new Set(page.map((r) => r.category_uri))] : [''])
        .execute()
      const rulesets = await views.currentRulesets(categories.map((c) => c.uri))
      const categoryViews = new Map(categories.map((c) => [c.uri, views.category(c, rulesets.get(c.uri))]))
      const runViews = await views.runs(page)
      const last = page[page.length - 1]
      return {
        body: {
          runs: page.map(
            (row, i): QueueItem =>
              ({
                run: runViews[i],
                category: categoryViews.get(row.category_uri)!,
                approvals: row.approvals ?? 0,
                requiredApprovals: categoryViews.get(row.category_uri)!.requiredApprovals,
                approvedBy: row.approved_by ?? [],
              }) as QueueItem,
          ),
          cursor: rows.length > limit ? `${last.first_indexed_at.toISOString()}|${last.uri}` : undefined,
        },
      }
    })

    .add(ledger.listMemberships, async ({ params }) => {
      const actor = await db
        .selectFrom('actor')
        .select('did')
        .where(params.actor.startsWith('did:') ? 'did' : 'handle', '=', params.actor)
        .executeTakeFirst()
      if (!actor) return { body: { memberships: [] } }
      const rows = await db
        .selectFrom('community_member as m')
        .innerJoin('community as c', 'c.did', 'm.community_did')
        .selectAll('c')
        .select(['m.uri as grant_uri', 'm.cid as grant_cid', 'm.active'])
        .where('m.member_did', '=', actor.did)
        .orderBy('c.name')
        .execute()
      const communityViews = await views.communities(rows)
      return {
        body: {
          memberships: rows.map(
            (r): MembershipView =>
              ({
                community: communityViews.get(r.did)!,
                status: r.active ? 'active' : 'invited',
                grant: { uri: r.grant_uri, cid: r.grant_cid },
              }) as MembershipView,
          ),
        },
      }
    })

    .add(ledger.listProposals, async ({ params }) => {
      await requireCommunity(params.community)
      const rows = await db
        .selectFrom('proposal')
        .selectAll()
        .where('community_did', '=', params.community)
        .orderBy('first_indexed_at', 'desc')
        .limit(params.status ? 500 : (params.limit ?? 50))
        .execute()
      let proposals = await views.proposals(rows)
      if (params.status === 'open') proposals = proposals.filter((p) => p.status === 'open')
      if (params.status === 'closed') proposals = proposals.filter((p) => p.status !== 'open')
      return { body: { proposals: proposals.slice(0, params.limit ?? 50) } }
    })

    .add(ledger.getProposal, async ({ params }) => {
      const row = await db.selectFrom('proposal').selectAll().where('uri', '=', params.uri).executeTakeFirst()
      if (!row) throw notFound('Proposal not found')
      const [proposal] = await views.proposals([row])
      return { body: { proposal } }
    })

    .add(ledger.listModerators, async ({ params }) => {
      await requireCommunity(params.community)
      return { body: { moderators: await views.moderators(params.community) } }
    })

    .add(ledger.listBans, async ({ params }) => {
      await requireCommunity(params.community)
      return { body: { bans: await views.bans(params.community) } }
    })

    .add(ledger.listCommunityRequests, async ({ params }) => {
      let query = db.selectFrom('community_request').selectAll().orderBy('indexed_at').limit(params.limit ?? 50)
      if (params.requester) query = query.where('requester_did', '=', params.requester)
      const platform = await platformDid(db)
      if (params.status !== 'all') {
        query = query
          .where(({ not, exists, selectFrom }) =>
            not(exists(selectFrom('community_member as m').select('m.uri').whereRef('m.via_uri', '=', 'community_request.uri'))),
          )
          .where(({ not, exists, selectFrom }) =>
            not(
              exists(
                selectFrom('request_denial as d')
                  .select('d.uri')
                  .whereRef('d.request_uri', '=', 'community_request.uri')
                  .where('d.owner_did', '=', platform ?? ''),
              ),
            ),
          )
      }
      const rows = await query.execute()
      const uris = rows.map((r) => r.uri)
      const [grants, denials] = uris.length
        ? await Promise.all([
            db.selectFrom('community_member').select(['via_uri', 'community_did']).where('via_uri', 'in', uris).execute(),
            db
              .selectFrom('request_denial')
              .select(['request_uri', 'reason'])
              .where('request_uri', 'in', uris)
              .where('owner_did', '=', platform ?? '')
              .execute(),
          ])
        : [[], []]
      const actors = await views.actors(rows.flatMap((r) => [r.requester_did, ...r.founders]))
      return {
        body: {
          requests: rows.map((r): RequestView => {
            const grant = grants.find((g) => g.via_uri === r.uri)
            const denial = denials.find((d) => d.request_uri === r.uri)
            return {
              uri: r.uri,
              cid: r.cid,
              requester: actors.get(r.requester_did)!,
              game: r.game,
              founders: r.founders.map((did) => actors.get(did)!),
              note: r.note ?? undefined,
              status: grant ? 'approved' : denial ? 'denied' : 'pending',
              denialReason: grant ? undefined : denial?.reason,
              community: grant?.community_did,
              indexedAt: r.indexed_at.toISOString(),
            } as RequestView
          }),
        },
      }
    })

    .add(ledger.getRunner, async ({ params }) => {
      const actor = await db
        .selectFrom('actor')
        .select(['did', 'handle'])
        .where(params.actor.startsWith('did:') ? 'did' : 'handle', '=', params.actor)
        .executeTakeFirst()
      if (!actor) throw notFound('Runner not found')
      const rows = await db
        .selectFrom('run')
        .selectAll()
        .where('runner_did', '=', actor.did)
        .orderBy('indexed_at', 'desc')
        .limit(params.limit ?? 50)
        .execute()
      return {
        body: {
          actor: (await views.actors([actor.did])).get(actor.did)!,
          runs: await views.runs(rows),
        },
      }
    })
}
