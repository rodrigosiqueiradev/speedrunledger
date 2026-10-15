import { type CategoryVariable, type Database, freezeIntervals, isFrozen, type ProposalRow, tallyProposals } from '@speedrunledger/db'
import type { DatabaseSchema } from '@speedrunledger/db'
import type {
  ActorView,
  BanView,
  ModeratorView,
  ProposalView,
  CategoryView,
  CommunityDetail,
  CommunityView,
  GameView,
  LabelView,
  RunView,
  VideoProblemView,
  WorldRecordView,
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

  community(row: Row<'community'>, handle?: string | null, frozen?: boolean): CommunityView {
    return compact({
      did: row.did,
      handle: handle ?? undefined,
      name: row.name,
      description: row.description ?? undefined,
      frozen: frozen || undefined,
    }) as CommunityView
  }

  /** Community views with handles and freeze state. */
  async communities(rows: Row<'community'>[]): Promise<Map<string, CommunityView>> {
    const dids = rows.map((r) => r.did)
    const [handles, frozen] = await Promise.all([this.actors(dids), freezeIntervals(this.db, dids)])
    return new Map(rows.map((r) => [r.did, this.community(r, handles.get(r.did)?.handle, isFrozen(frozen.get(r.did)))]))
  }

  /** Proposals with their tallies, counted votes and whether the community service carried them out. */
  async proposals(rows: ProposalRow[]): Promise<ProposalView[]> {
    if (rows.length === 0) return []
    const [tallies, executions] = await Promise.all([
      tallyProposals(this.db, rows),
      this.db.selectFrom('proposal_execution').selectAll().where('proposal_uri', 'in', rows.map((r) => r.uri)).execute(),
    ])
    const actors = await this.actors([
      ...rows.map((r) => r.proposer_did),
      ...rows.flatMap((r) => (r.subject_did ? [r.subject_did] : [])),
      ...[...tallies.values()].flatMap((t) => t.votes.map((v) => v.voter)),
    ])
    const executed = new Map(executions.map((e) => [e.proposal_uri, e]))
    return rows.map((p) => {
      const tally = tallies.get(p.uri)!
      const execution = executed.get(p.uri)
      return compact({
        uri: p.uri,
        cid: p.cid,
        community: p.community_did,
        proposer: actors.get(p.proposer_did)!,
        actionType: p.action_type,
        action: p.action,
        subject: p.subject_did ? actors.get(p.subject_did) : undefined,
        reason: p.reason,
        status: tally.status,
        executed: Boolean(execution?.executed_at),
        result: execution?.result_uri ?? undefined,
        electorateSize: tally.electorateSize,
        needed: tally.needed,
        yes: tally.yes,
        no: tally.no,
        votes: tally.votes.map((v) =>
          compact({ voter: actors.get(v.voter)!, value: v.value, reason: v.reason ?? undefined, indexedAt: iso(v.indexedAt) }),
        ),
        problems: p.problems,
        createdAt: p.created_at,
        expiresAt: iso(tally.expiresAt),
        indexedAt: iso(p.first_indexed_at),
      }) as ProposalView
    })
  }

  /** A community's moderators with when each last wrote a verdict (as reviewer), proposal or vote. */
  async moderators(communityDid: string): Promise<ModeratorView[]> {
    const members = await this.db
      .selectFrom('community_member')
      .selectAll()
      .where('community_did', '=', communityDid)
      .orderBy('created_at')
      .execute()
    if (members.length === 0) return []
    const dids = members.map((m) => m.member_did)
    const [actors, verdicts, proposals, votes] = await Promise.all([
      this.actors(dids),
      this.db
        .selectFrom('verification')
        .select(['reviewer_did as did', (eb) => eb.fn.max('indexed_at').as('at')])
        .where('community_did', '=', communityDid)
        .where('reviewer_did', 'in', dids)
        .groupBy('reviewer_did')
        .execute(),
      this.db
        .selectFrom('proposal')
        .select(['proposer_did as did', (eb) => eb.fn.max('indexed_at').as('at')])
        .where('community_did', '=', communityDid)
        .where('proposer_did', 'in', dids)
        .groupBy('proposer_did')
        .execute(),
      this.db
        .selectFrom('vote')
        .innerJoin('proposal', 'proposal.uri', 'vote.proposal_uri')
        .select(['vote.voter_did as did', (eb) => eb.fn.max('vote.indexed_at').as('at')])
        .where('proposal.community_did', '=', communityDid)
        .where('vote.voter_did', 'in', dids)
        .groupBy('vote.voter_did')
        .execute(),
    ])
    const last = new Map<string, Date>()
    for (const { did, at } of [...verdicts, ...proposals, ...votes]) {
      const when = new Date(at as Date)
      if (!last.has(did) || last.get(did)! < when) last.set(did, when)
    }
    return members.map((m) =>
      compact({
        actor: actors.get(m.member_did)!,
        status: m.active ? 'active' : 'invited',
        grant: { uri: m.uri, cid: m.cid },
        since: m.created_at,
        lastActiveAt: last.has(m.member_did) ? iso(last.get(m.member_did)!) : undefined,
      }) as ModeratorView,
    )
  }

  async bans(communityDid: string): Promise<BanView[]> {
    const rows = await this.db.selectFrom('ban').selectAll().where('community_did', '=', communityDid).orderBy('indexed_at', 'desc').execute()
    const actors = await this.actors(rows.flatMap((r) => [r.subject_did, r.moderator_did]))
    return rows.map(
      (r) =>
        ({
          uri: r.uri,
          cid: r.cid,
          subject: actors.get(r.subject_did)!,
          moderator: actors.get(r.moderator_did)!,
          reason: r.reason,
          indexedAt: iso(r.indexed_at),
        }) as BanView,
    )
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
      description: row.description ?? undefined,
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
    const frozen = await freezeIntervals(this.db, dids)
    return communities.map((community) => ({
      community: this.community(community, actors.get(community.did)?.handle, isFrozen(frozen.get(community.did))),
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
    const [verdicts, ranks, labels, dead] = await Promise.all([
      this.db
        .selectFrom('verification')
        .selectAll()
        .where('subject_uri', 'in', uris)
        .where('reviewer_active', '=', true)
        .orderBy('indexed_at', 'desc')
        .orderBy('uri', 'desc')
        .execute(),
      this.db.selectFrom('board_entry').select(['run_uri', 'rank']).where('run_uri', 'in', uris).execute(),
      this.labels(uris),
      this.db.selectFrom('video_check').select(['run_uri', 'url']).where('run_uri', 'in', uris).where('status', '=', 'dead').execute(),
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
        labels: labels.get(run.uri)?.length ? labels.get(run.uri) : undefined,
        deadVideos: deadVideos(run, dead),
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

  /** Video problems: dead links on runs that still carry them, newest check first. */
  async videoProblems(communityDid: string): Promise<VideoProblemView[]> {
    const checks = await this.db
      .selectFrom('video_check')
      .selectAll()
      .where('community_did', '=', communityDid)
      .where('status', '=', 'dead')
      .orderBy('checked_at', 'desc')
      .execute()
    if (checks.length === 0) return []
    const runs = await this.runs(await this.db.selectFrom('run').selectAll().where('uri', 'in', checks.map((c) => c.run_uri)).execute())
    return checks.flatMap((c) => {
      const run = runs.find((r) => r.uri === c.run_uri)
      if (!run?.deadVideos?.some((u) => u === c.url)) return []
      return [compact({ run, url: c.url, httpStatus: c.http_status ?? undefined, detail: c.detail ?? undefined, checkedAt: iso(c.checked_at) }) as VideoProblemView]
    })
  }

  /** Labels currently on each URI: the newest label per value, unless it was a negation. */
  async labels(uris: string[]): Promise<Map<string, LabelView[]>> {
    const map = new Map<string, LabelView[]>()
    if (uris.length === 0) return map
    const rows = await this.db
      .selectFrom('label')
      .select(['uri', 'src', 'val', 'neg', 'cts', 'moderator_did', 'reason'])
      .distinctOn(['uri', 'src', 'val'])
      .where('uri', 'in', uris)
      .orderBy('uri')
      .orderBy('src')
      .orderBy('val')
      .orderBy('seq', 'desc')
      .execute()
    const current = rows.filter((r) => !r.neg)
    const actors = await this.actors(current.map((r) => r.moderator_did))
    for (const r of current) {
      const list = map.get(r.uri) ?? []
      list.push(compact({ val: r.val, src: r.src, cts: r.cts, moderator: actors.get(r.moderator_did), reason: r.reason ?? undefined }) as LabelView)
      map.set(r.uri, list)
    }
    return map
  }

  /** World records with their runs, categories, games and communities. */
  async worldRecords(rows: Row<'world_record'>[]): Promise<WorldRecordView[]> {
    if (rows.length === 0) return []
    const [runs, categories, announcements] = await Promise.all([
      this.db.selectFrom('run').selectAll().where('uri', 'in', rows.map((r) => r.run_uri)).execute(),
      this.db.selectFrom('category').selectAll().where('uri', 'in', rows.map((r) => r.category_uri)).execute(),
      this.db
        .selectFrom('announcement')
        .select(['world_record_id', 'post_uri'])
        .where('world_record_id', 'in', rows.map((r) => r.id))
        .execute(),
    ])
    const [games, communities, runViews, previous] = await Promise.all([
      categories.length ? this.db.selectFrom('game').selectAll().where('uri', 'in', categories.map((c) => c.game_uri)).execute() : [],
      this.db.selectFrom('community').selectAll().where('did', 'in', rows.map((r) => r.community_did)).execute(),
      this.runs(runs),
      this.actors(rows.flatMap((r) => (r.previous_runner_did ? [r.previous_runner_did] : []))),
    ])
    const communityViews = await this.communities(communities)
    const out: WorldRecordView[] = []
    for (const r of rows) {
      const run = runViews.find((v) => v.uri === r.run_uri)
      const category = categories.find((c) => c.uri === r.category_uri)
      const game = category && games.find((g) => g.uri === category.game_uri)
      const community = communityViews.get(r.community_did)
      // A run deleted since keeps its place in history only while it exists.
      if (!run || !category || !game || !community) continue
      const subcategoryVars = (category.variables as CategoryVariable[]).filter((v) => v.subcategory).map((v) => v.id)
      out.push(
        compact({
          run,
          category: this.category(category),
          game: this.game(game),
          community,
          subcategory: run.variables.filter((v) => subcategoryVars.includes(v.variable)),
          rankedMs: r.ranked_ms,
          previous: r.previous_runner_did ? previous.get(r.previous_runner_did) : undefined,
          previousRankedMs: r.previous_ranked_ms ?? undefined,
          announcement: announcements.find((a) => a.world_record_id === r.id)?.post_uri ?? undefined,
          setAt: iso(r.set_at),
        }) as WorldRecordView,
      )
    }
    return out
  }
}

/** The run's links a check found dead, if they are still on the run. */
function deadVideos(run: Row<'run'>, dead: { run_uri: string; url: string }[]): string[] | undefined {
  const urls = (run.videos as { url: string }[]).map((v) => v.url)
  const found = dead.filter((d) => d.run_uri === run.uri && urls.includes(d.url)).map((d) => d.url)
  return found.length ? found : undefined
}
