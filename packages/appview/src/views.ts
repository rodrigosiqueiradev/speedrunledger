import type { CategoryVariable, Database } from '@speedrunledger/db'
import type { DatabaseSchema } from '@speedrunledger/db'
import type {
  ActorView,
  CategoryView,
  CommunityDetail,
  CommunityView,
  GameView,
  RunView,
} from '@speedrunledger/lexicon'
import type { Selectable } from 'kysely'

// Plain-object views matching app.speedrunledger-prototype.defs.

type Row<T extends keyof DatabaseSchema> = Selectable<DatabaseSchema[T]>
type Times = { realTimeMs?: number; realTimeNoLoadsMs?: number; gameTimeMs?: number }

export type RunStatus = 'pending' | 'verified' | 'rejected' | 'changesRequested' | 'invalid'

const iso = (d: Date) => d.toISOString()
const compact = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as T

const times = (real: number | null, noLoads: number | null, game: number | null): Times =>
  compact({ realTimeMs: real ?? undefined, realTimeNoLoadsMs: noLoads ?? undefined, gameTimeMs: game ?? undefined })

export class Views {
  constructor(readonly db: Database) {}

  async actors(dids: string[]): Promise<Map<string, ActorView>> {
    const map = new Map<string, ActorView>(dids.map((did) => [did, { did } as ActorView]))
    if (dids.length === 0) return map
    const rows = await this.db.selectFrom('actor').select(['did', 'handle']).where('did', 'in', [...new Set(dids)]).execute()
    for (const r of rows) map.set(r.did, compact({ did: r.did, handle: r.handle ?? undefined }) as ActorView)
    return map
  }

  community(row: Row<'community'>, handle?: string | null): CommunityView {
    return compact({ did: row.did, handle: handle ?? undefined, name: row.name, description: row.description ?? undefined }) as CommunityView
  }

  game(row: Row<'game'>): GameView {
    return compact({
      uri: row.uri,
      cid: row.cid,
      title: row.title,
      releaseYear: row.release_year ?? undefined,
      platforms: row.platforms,
    }) as GameView
  }

  category(row: Row<'category'>, ruleset?: Row<'ruleset'>): CategoryView {
    return compact({
      uri: row.uri,
      cid: row.cid,
      game: row.game_uri,
      name: row.name,
      kind: row.kind,
      sort: row.sort,
      primaryTiming: row.primary_timing,
      timingMethods: row.timing_methods,
      variables: (row.variables as CategoryVariable[]).map((v) => ({ ...v })),
      requiresVideo: row.requires_video,
      requiredApprovals: row.required_approvals,
      retired: row.retired,
      ruleset: ruleset
        ? { uri: ruleset.uri, cid: ruleset.cid, text: ruleset.text, createdAt: ruleset.created_at }
        : undefined,
    }) as CategoryView
  }

  /** Newest ruleset of each category. */
  async currentRulesets(categoryUris: string[]): Promise<Map<string, Row<'ruleset'>>> {
    const map = new Map<string, Row<'ruleset'>>()
    if (categoryUris.length === 0) return map
    const rows = await this.db
      .selectFrom('ruleset')
      .selectAll()
      .distinctOn('category_uri')
      .where('category_uri', 'in', categoryUris)
      .orderBy('category_uri')
      .orderBy('indexed_at', 'desc')
      .execute()
    for (const r of rows) map.set(r.category_uri, r)
    return map
  }

  /** Communities with their games and categories. */
  async communityDetails(communities: Row<'community'>[]): Promise<CommunityDetail[]> {
    const dids = communities.map((c) => c.did)
    if (dids.length === 0) return []
    const [games, categories, actors] = await Promise.all([
      this.db.selectFrom('game').selectAll().where('community_did', 'in', dids).orderBy('title').execute(),
      this.db.selectFrom('category').selectAll().where('community_did', 'in', dids).orderBy('indexed_at').execute(),
      this.actors(dids),
    ])
    const rulesets = await this.currentRulesets(categories.map((c) => c.uri))
    return communities.map((community) => ({
      community: this.community(community, actors.get(community.did)?.handle),
      games: games
        .filter((g) => g.community_did === community.did)
        .map((game) => ({
          game: this.game(game),
          categories: categories
            .filter((c) => c.game_uri === game.uri)
            .map((c) => this.category(c, rulesets.get(c.uri))),
        })),
    }))
  }

  /** Runs with their status (and, optionally, every verdict). */
  async runs(rows: Row<'run'>[], opts: { verdicts?: boolean } = {}): Promise<RunView[]> {
    if (rows.length === 0) return []
    const uris = rows.map((r) => r.uri)
    const [verdicts, ranks] = await Promise.all([
      this.db
        .selectFrom('verification')
        .selectAll()
        .where('subject_uri', 'in', uris)
        .where('reviewer_active', '=', true)
        .orderBy('indexed_at', 'desc')
        .orderBy('uri', 'desc')
        .execute(),
      this.db.selectFrom('board_entry').select(['run_uri', 'rank']).where('run_uri', 'in', uris).execute(),
    ])
    const actors = await this.actors([...rows.map((r) => r.runner_did), ...verdicts.map((v) => v.reviewer_did)])
    const rankByRun = new Map(ranks.map((r) => [r.run_uri, r.rank]))
    return rows.map((run) => {
      const own = verdicts.filter((v) => v.subject_uri === run.uri && v.community_did === run.community_did)
      const latest = own[0]
      let status: RunStatus = 'pending'
      if (run.problems.length > 0) status = 'invalid'
      else if (latest && latest.subject_cid === run.cid) status = latest.status as RunStatus
      const verifiedTimes =
        status === 'verified' && latest?.has_verified_times
          ? times(latest.verified_real_time_ms, latest.verified_real_time_no_loads_ms, latest.verified_game_time_ms)
          : undefined
      return compact({
        uri: run.uri,
        cid: run.cid,
        runner: actors.get(run.runner_did)!,
        category: run.category_uri,
        community: run.community_did,
        status,
        times: times(run.real_time_ms, run.real_time_no_loads_ms, run.game_time_ms),
        verifiedTimes,
        videos: run.videos,
        variables: Object.entries(run.variables).map(([variable, value]) => ({ variable, value })),
        platform: run.platform ?? undefined,
        emulated: run.emulated ?? undefined,
        comment: run.comment ?? undefined,
        problems: run.problems,
        rank: rankByRun.get(run.uri),
        verdicts: opts.verdicts
          ? own.map((v) =>
              compact({
                uri: v.uri,
                status: v.status,
                reviewer: actors.get(v.reviewer_did)!,
                reason: v.reason ?? undefined,
                verifiedTimes: v.has_verified_times
                  ? times(v.verified_real_time_ms, v.verified_real_time_no_loads_ms, v.verified_game_time_ms)
                  : undefined,
                subjectCid: v.subject_cid,
                current: v.subject_cid === run.cid,
                createdAt: v.created_at,
                indexedAt: iso(v.indexed_at),
              }),
            )
          : undefined,
        performedAt: run.performed_at,
        createdAt: run.created_at,
        indexedAt: iso(run.indexed_at),
      }) as RunView
    })
  }
}

