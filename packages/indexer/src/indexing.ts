import { lexToJson, type LexValue } from '@atproto/lex'
import { AtUri } from '@atproto/syntax'
import { type Database, type DatabaseSchema, json } from '@speedrunledger/db'
import {
  type Collection,
  ids,
  isLedgerCollection,
  parseRecord,
  type RecordFor,
} from '@speedrunledger/lexicon'
import { sql, type Transaction } from 'kysely'
import type { Logger } from 'pino'
import { rebuildCategoryBoards } from './boards.js'
import { checkProposal } from './proposal-check.js'
import { checkRun } from './run-check.js'

export interface IndexerOptions {
  /** Keep leaderboards up to date as records change (on by default). */
  boards: boolean
}

type Tx = Transaction<DatabaseSchema>

export interface RecordWrite {
  did: string
  collection: string
  rkey: string
  cid: string
  /** The record in the atproto data model (as decoded from CBOR). */
  record: unknown
  rev: string
}

export interface RecordRef {
  did: string
  collection: string
  rkey: string
}

export type IndexOutcome = 'indexed' | 'unchanged' | 'invalid' | 'ignored'

/** A record that passed its lexicon but breaks a structural rule; it is not stored. */
class InvalidReference extends Error {}

const invalid = (reason: string): never => {
  throw new InvalidReference(reason)
}

/** Parses a strongRef URI and checks it names a record of the expected collection. */
const refTo = (uri: string, collection: Collection, field: string): AtUri => {
  let parsed: AtUri
  try {
    parsed = new AtUri(uri)
  } catch {
    return invalid(`${field} is not an at:// URI`)
  }
  if (parsed.collection !== collection) invalid(`${field} must point at a ${collection} record`)
  return parsed
}

const actionType = (action: { $type?: string }): string => {
  const type = action.$type ?? ''
  const hash = type.indexOf('#')
  return hash === -1 ? type : type.slice(hash + 1)
}

interface Ctx<C extends Collection> {
  uri: AtUri
  cid: string
  did: string
  record: RecordFor<C>
  indexedAt: Date
}

/** Work to run after the transaction commits, when other repos' records may have changed state. */
type AfterCommit = (indexer: Indexer) => Promise<void>

interface Handler<C extends Collection> {
  upsert(tx: Tx, ctx: Ctx<C>): Promise<AfterCommit | void>
  remove(tx: Tx, uri: string): Promise<AfterCommit | void>
}

type Handlers = { [C in Collection]: Handler<C> }

const handlers: Handlers = {
  [ids.run]: {
    async upsert(tx, { uri, cid, did, record, indexedAt }) {
      const category = refTo(record.category.uri, ids.category, 'category')
      const previous = await tx.selectFrom('run').select('category_uri').where('uri', '=', uri.toString()).executeTakeFirst()
      const variables: Record<string, string> = {}
      for (const v of record.variables ?? []) {
        if (v.variable in variables) invalid(`variable ${v.variable} is set twice`)
        variables[v.variable] = v.value
      }
      const row = {
        uri: uri.toString(),
        cid,
        runner_did: did,
        community_did: category.host,
        category_uri: record.category.uri,
        category_cid: record.category.cid,
        ruleset_uri: record.ruleset?.uri ?? null,
        variables: json(variables),
        platform: record.platform ?? null,
        emulated: record.emulated ?? null,
        real_time_ms: record.times.realTimeMs ?? null,
        real_time_no_loads_ms: record.times.realTimeNoLoadsMs ?? null,
        game_time_ms: record.times.gameTimeMs ?? null,
        videos: json(record.videos),
        comment: record.comment ?? null,
        co_runners: json(record.coRunners ?? []),
        performed_at: record.performedAt,
        created_at: record.createdAt,
        indexed_at: indexedAt,
        problems: json([]),
      }
      await tx
        .insertInto('run')
        .values({ ...row, first_indexed_at: indexedAt })
        .onConflict((oc) => oc.column('uri').doUpdateSet(row))
        .execute()
      return async (indexer) => {
        await indexer.recheckRuns({ uri: row.uri })
        await indexer.rebuildBoards({ categoryUris: [row.category_uri, previous?.category_uri] })
      }
    },
    async remove(tx, uri) {
      const row = await tx.deleteFrom('run').where('uri', '=', uri).returning('category_uri').executeTakeFirst()
      if (row) return (indexer) => indexer.rebuildBoards({ categoryUris: [row.category_uri] })
    },
  },

  [ids.runParticipant]: {
    async upsert(tx, { uri, cid, did, record, indexedAt }) {
      refTo(record.run.uri, ids.run, 'run')
      const row = {
        uri: uri.toString(),
        cid,
        participant_did: did,
        run_uri: record.run.uri,
        run_cid: record.run.cid,
        indexed_at: indexedAt,
      }
      await tx.insertInto('run_participant').values(row).onConflict((oc) => oc.column('uri').doUpdateSet(row)).execute()
      return (indexer) => indexer.rebuildBoards({ runUris: [row.run_uri] })
    },
    async remove(tx, uri) {
      const row = await tx.deleteFrom('run_participant').where('uri', '=', uri).returning('run_uri').executeTakeFirst()
      if (row) return (indexer) => indexer.rebuildBoards({ runUris: [row.run_uri] })
    },
  },

  [ids.game]: {
    async upsert(tx, { uri, cid, did, record, indexedAt }) {
      const row = {
        uri: uri.toString(),
        cid,
        community_did: did,
        title: record.title,
        release_year: record.releaseYear ?? null,
        platforms: json(record.platforms ?? []),
        indexed_at: indexedAt,
      }
      await tx.insertInto('game').values(row).onConflict((oc) => oc.column('uri').doUpdateSet(row)).execute()
    },
    async remove(tx, uri) {
      await tx.deleteFrom('game').where('uri', '=', uri).execute()
    },
  },

  [ids.category]: {
    async upsert(tx, { uri, cid, did, record, indexedAt }) {
      const game = refTo(record.game.uri, ids.game, 'game')
      if (game.host !== did) invalid('game must live in the same community repo')
      const variableIds = new Set<string>()
      for (const v of record.variables ?? []) {
        if (variableIds.has(v.id)) invalid(`variable id ${v.id} is used twice`)
        variableIds.add(v.id)
      }
      const timingMethods = new Set<string>(record.timingMethods ?? [])
      timingMethods.add(record.primaryTiming)
      const row = {
        uri: uri.toString(),
        cid,
        community_did: did,
        game_uri: record.game.uri,
        name: record.name,
        kind: record.kind,
        sort: record.sort,
        primary_timing: record.primaryTiming,
        timing_methods: json([...timingMethods]),
        variables: json(
          (record.variables ?? []).map((v) => ({
            id: v.id,
            name: v.name,
            values: v.values,
            subcategory: v.subcategory ?? false,
          })),
        ),
        requires_video: record.requiresVideo ?? true,
        required_approvals: record.requiredApprovals ?? 1,
        retired: record.retired ?? false,
        indexed_at: indexedAt,
      }
      await tx.insertInto('category').values(row).onConflict((oc) => oc.column('uri').doUpdateSet(row)).execute()
      return async (indexer) => {
        await indexer.recheckRuns({ categoryUri: row.uri })
        await indexer.rebuildBoards({ categoryUris: [row.uri] })
      }
    },
    async remove(tx, uri) {
      await tx.deleteFrom('category').where('uri', '=', uri).execute()
      return async (indexer) => {
        await indexer.recheckRuns({ categoryUri: uri })
        await indexer.rebuildBoards({ categoryUris: [uri] })
      }
    },
  },

  [ids.ruleset]: {
    async upsert(tx, { uri, cid, did, record, indexedAt }) {
      const category = refTo(record.category.uri, ids.category, 'category')
      if (category.host !== did) invalid('category must live in the same community repo')
      const row = {
        uri: uri.toString(),
        cid,
        community_did: did,
        category_uri: record.category.uri,
        text: record.text,
        created_at: record.createdAt,
        indexed_at: indexedAt,
      }
      await tx.insertInto('ruleset').values(row).onConflict((oc) => oc.column('uri').doUpdateSet(row)).execute()
    },
    async remove(tx, uri) {
      await tx.deleteFrom('ruleset').where('uri', '=', uri).execute()
    },
  },

  [ids.verification]: {
    async upsert(tx, { uri, cid, did, record, indexedAt }) {
      refTo(record.subject.uri, ids.run, 'subject')
      const membership = await tx
        .selectFrom('community_member')
        .select('uri')
        .where('community_did', '=', did)
        .where('member_did', '=', record.reviewer)
        .where('active', '=', true)
        .executeTakeFirst()
      const times = record.verifiedTimes
      const row = {
        uri: uri.toString(),
        cid,
        community_did: did,
        subject_uri: record.subject.uri,
        subject_cid: record.subject.cid,
        status: record.status,
        reviewer_did: record.reviewer,
        verified_real_time_ms: times?.realTimeMs ?? null,
        verified_real_time_no_loads_ms: times?.realTimeNoLoadsMs ?? null,
        verified_game_time_ms: times?.gameTimeMs ?? null,
        has_verified_times: times !== undefined,
        ruleset_uri: record.ruleset?.uri ?? null,
        reason: record.reason ?? null,
        reviewer_active: membership !== undefined,
        created_at: record.createdAt,
        indexed_at: indexedAt,
      }
      await tx.insertInto('verification').values(row).onConflict((oc) => oc.column('uri').doUpdateSet(row)).execute()
      return (indexer) => indexer.rebuildBoards({ runUris: [row.subject_uri] })
    },
    async remove(tx, uri) {
      const row = await tx.deleteFrom('verification').where('uri', '=', uri).returning('subject_uri').executeTakeFirst()
      if (row) return (indexer) => indexer.rebuildBoards({ runUris: [row.subject_uri] })
    },
  },

  [ids.communityRequest]: {
    async upsert(tx, { uri, cid, did, record, indexedAt }) {
      const row = {
        uri: uri.toString(),
        cid,
        requester_did: did,
        game_title: record.game.title,
        game: json(record.game),
        founders: json(record.founders),
        note: record.note ?? null,
        indexed_at: indexedAt,
      }
      await tx.insertInto('community_request').values(row).onConflict((oc) => oc.column('uri').doUpdateSet(row)).execute()
    },
    async remove(tx, uri) {
      await tx.deleteFrom('community_request').where('uri', '=', uri).execute()
    },
  },

  [ids.communityProfile]: {
    async upsert(tx, { uri, cid, did, record, indexedAt }) {
      if (uri.rkey !== 'self') invalid('a community profile must use the record key "self"')
      const row = {
        did,
        profile_uri: uri.toString(),
        profile_cid: cid,
        name: record.name,
        description: record.description ?? null,
        indexed_at: indexedAt,
      }
      await tx.insertInto('community').values(row).onConflict((oc) => oc.column('did').doUpdateSet(row)).execute()
    },
    async remove(tx, uri) {
      await tx.deleteFrom('community').where('profile_uri', '=', uri).execute()
    },
  },

  [ids.communityMember]: {
    async upsert(tx, { uri, cid, did, record, indexedAt }) {
      const row = {
        uri: uri.toString(),
        cid,
        community_did: did,
        member_did: record.subject,
        via_uri: record.via?.uri ?? null,
        created_at: record.createdAt,
        indexed_at: indexedAt,
      }
      await tx
        .insertInto('community_member')
        .values({ ...row, active: false, accept_uri: null })
        .onConflict((oc) => oc.column('uri').doUpdateSet(row))
        .execute()
      return (indexer) => indexer.recomputeMembership(row.uri)
    },
    async remove(tx, uri) {
      await tx.deleteFrom('community_member').where('uri', '=', uri).execute()
    },
  },

  [ids.communityMemberAccept]: {
    async upsert(tx, { uri, cid, did, record, indexedAt }) {
      refTo(record.member.uri, ids.communityMember, 'member')
      const previous = await tx.selectFrom('member_accept').select('grant_uri').where('uri', '=', uri.toString()).executeTakeFirst()
      const row = {
        uri: uri.toString(),
        cid,
        member_did: did,
        grant_uri: record.member.uri,
        indexed_at: indexedAt,
      }
      await tx.insertInto('member_accept').values(row).onConflict((oc) => oc.column('uri').doUpdateSet(row)).execute()
      return async (indexer) => {
        await indexer.recomputeMembership(row.grant_uri)
        if (previous && previous.grant_uri !== row.grant_uri) await indexer.recomputeMembership(previous.grant_uri)
      }
    },
    async remove(tx, uri) {
      const row = await tx.deleteFrom('member_accept').where('uri', '=', uri).returning('grant_uri').executeTakeFirst()
      if (row) return (indexer) => indexer.recomputeMembership(row.grant_uri)
    },
  },

  [ids.communityProposal]: {
    async upsert(tx, { uri, cid, did, record, indexedAt }) {
      const row = {
        uri: uri.toString(),
        cid,
        proposer_did: did,
        community_did: record.community,
        action_type: actionType(record.action as { $type?: string }),
        action: json(lexToJson(record.action as LexValue)),
        reason: record.reason,
        expires_at: record.expiresAt,
        created_at: record.createdAt,
        indexed_at: indexedAt,
      }
      // The electorate is fixed the first time the proposal is seen; an edit re-checks it.
      const previous = await tx
        .selectFrom('proposal')
        .select(['electorate', 'first_indexed_at'])
        .where('uri', '=', row.uri)
        .executeTakeFirst()
      const firstIndexedAt = previous?.first_indexed_at ?? indexedAt
      const check = await checkProposal(
        tx,
        { ...row, action: lexToJson(record.action as LexValue) as Record<string, unknown> },
        firstIndexedAt,
        previous?.electorate,
      )
      const full = { ...row, electorate: json(check.electorate), problems: json(check.problems) }
      await tx
        .insertInto('proposal')
        .values({ ...full, first_indexed_at: firstIndexedAt })
        .onConflict((oc) => oc.column('uri').doUpdateSet(full))
        .execute()
    },
    async remove(tx, uri) {
      await tx.deleteFrom('proposal').where('uri', '=', uri).execute()
    },
  },

  [ids.communityVote]: {
    async upsert(tx, { uri, cid, did, record, indexedAt }) {
      refTo(record.proposal.uri, ids.communityProposal, 'proposal')
      const row = {
        uri: uri.toString(),
        cid,
        voter_did: did,
        proposal_uri: record.proposal.uri,
        proposal_cid: record.proposal.cid,
        value: record.value,
        reason: record.reason ?? null,
        indexed_at: indexedAt,
      }
      await tx.insertInto('vote').values(row).onConflict((oc) => oc.column('uri').doUpdateSet(row)).execute()
    },
    async remove(tx, uri) {
      await tx.deleteFrom('vote').where('uri', '=', uri).execute()
    },
  },

  [ids.communityBan]: {
    async upsert(tx, { uri, cid, did, record, indexedAt }) {
      const row = {
        uri: uri.toString(),
        cid,
        community_did: did,
        subject_did: record.subject,
        moderator_did: record.moderator,
        reason: record.reason,
        indexed_at: indexedAt,
      }
      await tx.insertInto('ban').values(row).onConflict((oc) => oc.column('uri').doUpdateSet(row)).execute()
      return (indexer) => indexer.rebuildBoards({ communityDid: did })
    },
    async remove(tx, uri) {
      const row = await tx.deleteFrom('ban').where('uri', '=', uri).returning('community_did').executeTakeFirst()
      if (row) return (indexer) => indexer.rebuildBoards({ communityDid: row.community_did })
    },
  },

  [ids.communityIntervention]: {
    async upsert(tx, { uri, cid, did, record, indexedAt }) {
      if (record.action === 'appoint' && !record.subject) invalid('an appointment must name its subject')
      const row = {
        uri: uri.toString(),
        cid,
        community_did: did,
        action: record.action,
        subject_did: record.subject ?? null,
        reason: record.reason,
        sysadmin_did: record.sysadmin,
        created_at: record.createdAt,
        indexed_at: indexedAt,
      }
      await tx.insertInto('intervention').values(row).onConflict((oc) => oc.column('uri').doUpdateSet(row)).execute()
    },
    async remove(tx, uri) {
      await tx.deleteFrom('intervention').where('uri', '=', uri).execute()
    },
  },

  [ids.platformRequestDenial]: {
    async upsert(tx, { uri, cid, did, record, indexedAt }) {
      refTo(record.request.uri, ids.communityRequest, 'request')
      const row = {
        uri: uri.toString(),
        cid,
        owner_did: did,
        request_uri: record.request.uri,
        reason: record.reason,
        sysadmin_did: record.sysadmin,
        indexed_at: indexedAt,
      }
      await tx.insertInto('request_denial').values(row).onConflict((oc) => oc.column('uri').doUpdateSet(row)).execute()
    },
    async remove(tx, uri) {
      await tx.deleteFrom('request_denial').where('uri', '=', uri).execute()
    },
  },

  [ids.platformSysadmin]: {
    async upsert(tx, { uri, cid, did, record, indexedAt }) {
      if (uri.rkey !== record.subject) invalid('a sysadmin record must be keyed by the subject DID')
      const row = {
        uri: uri.toString(),
        cid,
        owner_did: did,
        subject_did: record.subject,
        indexed_at: indexedAt,
      }
      await tx.insertInto('sysadmin').values(row).onConflict((oc) => oc.column('uri').doUpdateSet(row)).execute()
    },
    async remove(tx, uri) {
      await tx.deleteFrom('sysadmin').where('uri', '=', uri).execute()
    },
  },
}

/**
 * Applies record writes and deletes to the index. Every method is idempotent,
 * keyed on record URI and CID, so replaying events is safe.
 */
export class Indexer {
  readonly opts: IndexerOptions

  constructor(
    readonly db: Database,
    readonly logger: Logger,
    opts: Partial<IndexerOptions> = {},
  ) {
    this.opts = { boards: true, ...opts }
  }

  async indexRecord(write: RecordWrite, indexedAt = new Date()): Promise<IndexOutcome> {
    const { did, collection, rkey, cid, rev } = write
    if (!isLedgerCollection(collection)) return 'ignored'
    const uri = AtUri.make(did, collection, rkey)

    const parsed = parseRecord(collection, write.record)
    if (!parsed.success) {
      this.logger.info({ uri: uri.toString(), error: parsed.error }, 'record failed lexicon validation')
      await this.deleteRecord({ did, collection, rkey })
      return 'invalid'
    }

    const existing = await this.db.selectFrom('record').select('cid').where('uri', '=', uri.toString()).executeTakeFirst()
    if (existing?.cid === cid) return 'unchanged'

    const handler = handlers[collection] as Handler<Collection>
    let after: AfterCommit | void
    try {
      after = await this.db.transaction().execute(async (tx) => {
        const raw = {
          uri: uri.toString(),
          cid,
          did,
          collection,
          rkey,
          json: json(lexToJson(write.record as LexValue)),
          rev,
          indexed_at: indexedAt,
        }
        await tx.insertInto('record').values(raw).onConflict((oc) => oc.column('uri').doUpdateSet(raw)).execute()
        return handler.upsert(tx, { uri, cid, did, record: parsed.value, indexedAt })
      })
    } catch (err) {
      if (!(err instanceof InvalidReference)) throw err
      this.logger.info({ uri: uri.toString(), error: err.message }, 'record has an invalid reference')
      await this.deleteRecord({ did, collection, rkey })
      return 'invalid'
    }
    if (after) await after(this)
    return 'indexed'
  }

  async deleteRecord(ref: RecordRef): Promise<boolean> {
    if (!isLedgerCollection(ref.collection)) return false
    const uri = AtUri.make(ref.did, ref.collection, ref.rkey).toString()
    const handler = handlers[ref.collection] as Handler<Collection>
    const { deleted, after } = await this.db.transaction().execute(async (tx) => {
      const row = await tx.deleteFrom('record').where('uri', '=', uri).returning('uri').executeTakeFirst()
      const after = await handler.remove(tx, uri)
      return { deleted: row !== undefined, after }
    })
    if (after) await after(this)
    return deleted
  }

  /** Re-evaluates the reference checks of runs, after a run or its category changed. */
  async recheckRuns(where: { uri: string } | { categoryUri: string }): Promise<void> {
    let query = this.db
      .selectFrom('run')
      .leftJoin('category', 'category.uri', 'run.category_uri')
      .select([
        'run.uri',
        'run.variables',
        'run.real_time_ms',
        'run.real_time_no_loads_ms',
        'run.game_time_ms',
        'run.problems',
        'category.uri as category_uri',
        'category.kind',
        'category.primary_timing',
        'category.variables as category_variables',
      ])
    query = 'uri' in where ? query.where('run.uri', '=', where.uri) : query.where('run.category_uri', '=', where.categoryUri)
    for (const row of await query.execute()) {
      const category =
        row.category_uri === null
          ? undefined
          : { kind: row.kind!, primary_timing: row.primary_timing!, variables: row.category_variables! }
      const problems = checkRun(row, category)
      if (JSON.stringify(problems) !== JSON.stringify(row.problems)) {
        await this.db.updateTable('run').set({ problems: json(problems) }).where('uri', '=', row.uri).execute()
      }
    }
  }

  /**
   * A membership is active when the community's grant and the moderator's
   * acceptance both exist. Runs after either side changes, outside the writing
   * transaction, so whichever side commits last sees both.
   */
  async recomputeMembership(grantUri: string): Promise<void> {
    const updated = await sql<{ community_did: string; member_did: string; active: boolean; created_at: string }>`
      UPDATE community_member AS cm
      SET accept_uri = acc.uri, active = acc.uri IS NOT NULL
      FROM (SELECT ${grantUri}::text AS grant_uri) AS g
      LEFT JOIN LATERAL (
        SELECT a.uri FROM member_accept a
        JOIN community_member m ON m.uri = a.grant_uri
        WHERE a.grant_uri = g.grant_uri AND a.member_did = m.member_did
        ORDER BY a.indexed_at
        LIMIT 1
      ) AS acc ON true
      WHERE cm.uri = g.grant_uri
      RETURNING cm.community_did, cm.member_did, cm.active, cm.created_at
    `.execute(this.db)
    const membership = updated.rows[0]
    if (membership?.active) {
      // Verdicts can be indexed before the membership they rely on (backfill
      // order is arbitrary). The community repo signs both, so its own
      // timestamps decide whether a verdict came after the grant.
      await this.db
        .updateTable('verification')
        .set({ reviewer_active: true })
        .where('community_did', '=', membership.community_did)
        .where('reviewer_did', '=', membership.member_did)
        .where('created_at', '>=', membership.created_at)
        .where('reviewer_active', '=', false)
        .execute()
      await this.rebuildBoards({ communityDid: membership.community_did })
    }
  }

  /** Rebuilds the boards of every category the given records can affect. */
  async rebuildBoards(scope: {
    categoryUris?: (string | null | undefined)[]
    runUris?: string[]
    communityDid?: string
    runnerDid?: string
  }): Promise<void> {
    if (!this.opts.boards) return
    const uris = this.deferredBoards ?? new Set<string>()
    for (const uri of scope.categoryUris ?? []) if (uri) uris.add(uri)
    if (scope.runUris?.length) {
      const rows = await this.db.selectFrom('run').select('category_uri').where('uri', 'in', scope.runUris).execute()
      for (const r of rows) uris.add(r.category_uri)
    }
    if (scope.communityDid) {
      const rows = await this.db.selectFrom('category').select('uri').where('community_did', '=', scope.communityDid).execute()
      for (const r of rows) uris.add(r.uri)
    }
    if (scope.runnerDid) {
      const rows = await this.db.selectFrom('run').select('category_uri').distinct().where('runner_did', '=', scope.runnerDid).execute()
      for (const r of rows) uris.add(r.category_uri)
    }
    if (this.deferredBoards) return
    for (const uri of uris) await rebuildCategoryBoards(this.db, uri)
  }

  private deferredBoards: Set<string> | null = null

  /**
   * Runs `fn` with board rebuilds collected instead of run one by one, then
   * rebuilds each affected category once. Used for backfill.
   */
  async withDeferredBoards<T>(fn: () => Promise<T>): Promise<T> {
    if (this.deferredBoards) return fn()
    const pending = new Set<string>()
    this.deferredBoards = pending
    try {
      return await fn()
    } finally {
      this.deferredBoards = null
      for (const uri of pending) await rebuildCategoryBoards(this.db, uri)
    }
  }

  /** Makes sure the actor row exists. */
  async ensureActor(did: string, fields: { handle?: string | null; pdsEndpoint?: string | null } = {}): Promise<void> {
    const now = new Date()
    const update: { updated_at: Date; handle?: string | null; pds_endpoint?: string | null } = { updated_at: now }
    if (fields.handle !== undefined) update.handle = fields.handle
    if (fields.pdsEndpoint !== undefined) update.pds_endpoint = fields.pdsEndpoint
    await this.db
      .insertInto('actor')
      .values({
        did,
        handle: fields.handle ?? null,
        pds_endpoint: fields.pdsEndpoint ?? null,
        repo_rev: null,
        status: null,
        indexed_at: now,
        updated_at: now,
      })
      .onConflict((oc) => (Object.keys(update).length > 1 ? oc.column('did').doUpdateSet(update) : oc.column('did').doNothing()))
      .execute()
  }

  async getRepoRev(did: string): Promise<string | null> {
    const row = await this.db.selectFrom('actor').select('repo_rev').where('did', '=', did).executeTakeFirst()
    return row?.repo_rev ?? null
  }

  async setRepoRev(did: string, rev: string): Promise<void> {
    await this.ensureActor(did)
    await this.db
      .updateTable('actor')
      .set({ repo_rev: rev, updated_at: new Date() })
      .where('did', '=', did)
      .where((eb) => eb.or([eb('repo_rev', 'is', null), eb('repo_rev', '<', rev)]))
      .execute()
  }

  async setAccountStatus(did: string, active: boolean, status: string | null): Promise<void> {
    await this.ensureActor(did)
    await this.db.updateTable('actor').set({ active, status, updated_at: new Date() }).where('did', '=', did).execute()
    await this.rebuildBoards({ runnerDid: did })
  }

  /** URIs of every indexed ledger record in a repo. */
  async listRepoRecords(did: string): Promise<{ uri: string; cid: string; collection: string; rkey: string }[]> {
    return this.db.selectFrom('record').select(['uri', 'cid', 'collection', 'rkey']).where('did', '=', did).execute()
  }
}
