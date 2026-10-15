import { LexRouter, LexServerError } from '@atproto/lex-server'
import { boardKey, type CategoryVariable, type Database } from '@speedrunledger/db'
import { ledger, type RunView } from '@speedrunledger/lexicon'
import { Views } from './views.js'

const notFound = (message: string) => new LexServerError(404, { error: 'NotFound', message })
const invalid = (message: string) => new LexServerError(400, { error: 'InvalidRequest', message })

/** XRPC queries of the AppView, served from the indexer's database. */
export function createRouter(db: Database): LexRouter {
  const views = new Views(db)

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
      const handles = await views.actors([community.did])

      return {
        body: {
          category: views.category(category, rulesets.get(category.uri)),
          game: views.game(game),
          community: views.community(community, handles.get(community.did)?.handle),
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
