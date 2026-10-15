import { CredentialSession } from '@atproto/api'
import { type AtUriString, Client } from '@atproto/lex'
import { LexServerError } from '@atproto/lex-server'
import { createDb, type Database, freezeIntervals, isFrozen, migrateToLatest } from '@speedrunledger/db'
import { type GameRecord, ledger, type RunTimes } from '@speedrunledger/lexicon'
import type { Logger } from 'pino'
import type { CommunityServiceConfig } from './config.js'
import { decrypt, encrypt } from './secrets.js'

export type VerdictStatus = 'verified' | 'rejected' | 'changesRequested'

export interface VerdictInput {
  run: { uri: string; cid: string }
  status: string
  reason?: string
  verifiedTimes?: RunTimes
}

export interface GameUpdate {
  game: string
  title?: string
  releaseYear?: number
  platforms?: string[]
}

export type WriteOutput = { uri: AtUriString; cid: string }
export type AccountKind = 'community' | 'platform'

export const fail = (status: number, error: string, message: string) => new LexServerError(status, { error, message })

/**
 * Holds the community accounts' sessions (and the platform account's) and
 * writes official records into their repos on behalf of moderators and
 * sysadmins, after checking in the index that they may. Moderators never see
 * these credentials.
 */
export class CommunityService {
  readonly db: Database
  private clients = new Map<string, Promise<Client>>()
  private fetchHandlers = new Map<string, (path: string, init: RequestInit) => Promise<Response>>()

  constructor(
    readonly config: CommunityServiceConfig,
    readonly logger: Logger,
  ) {
    this.db = createDb(config.databaseUrl, { max: 5 })
  }

  async migrate(): Promise<void> {
    await migrateToLatest(this.db)
  }

  /** Stores an account's credentials after checking they work. */
  async registerAccount(
    input: { identifier: string; password: string; pdsUrl: string },
    kind: AccountKind = 'community',
  ): Promise<{ did: string; handle: string }> {
    const session = new CredentialSession(new URL(input.pdsUrl))
    const { data } = await session.login({ identifier: input.identifier, password: input.password })
    if (kind === 'platform') {
      const existing = await this.db.selectFrom('community_credential').select('did').where('kind', '=', 'platform').executeTakeFirst()
      if (existing && existing.did !== data.did) throw new Error(`a different platform account is registered: ${existing.did}`)
    }
    const now = new Date()
    const values = {
      did: data.did,
      identifier: input.identifier,
      pds_url: input.pdsUrl,
      secret: encrypt(this.config.secretKey, input.password),
      kind,
      updated_at: now,
    }
    await this.db
      .insertInto('community_credential')
      .values({ ...values, created_at: now })
      .onConflict((oc) => oc.column('did').doUpdateSet(values))
      .execute()
    this.clients.set(data.did, Promise.resolve(this.clientFor(session)))
    this.logger.info({ did: data.did, handle: data.handle, kind }, 'account registered')
    return { did: data.did, handle: data.handle }
  }

  async listCommunities(): Promise<{ did: string; identifier: string; pdsUrl: string }[]> {
    const rows = await this.db
      .selectFrom('community_credential')
      .select(['did', 'identifier', 'pds_url'])
      .where('kind', '=', 'community')
      .orderBy('did')
      .execute()
    return rows.map((r) => ({ did: r.did, identifier: r.identifier, pdsUrl: r.pds_url }))
  }

  /** A client writing to the account's repo, or undefined when this service holds no session for it. */
  async communityClient(did: string): Promise<Client | undefined> {
    let client = this.clients.get(did)
    if (!client) {
      const row = await this.db.selectFrom('community_credential').selectAll().where('did', '=', did).executeTakeFirst()
      if (!row) return undefined
      client = (async () => {
        const session = new CredentialSession(new URL(row.pds_url))
        await session.login({ identifier: row.identifier, password: decrypt(this.config.secretKey, row.secret) })
        return this.clientFor(session)
      })()
      client.catch(() => this.clients.delete(did))
      this.clients.set(did, client)
    }
    return client
  }

  async requireClient(did: string): Promise<Client> {
    const client = await this.communityClient(did)
    if (!client) throw fail(503, 'CommunityNotManaged', 'This service does not hold a session for the community')
    return client
  }

  private clientFor(session: CredentialSession): Client {
    const fetchHandler = (path: string, init: RequestInit) => session.fetchHandler(path, init)
    this.fetchHandlers.set(session.did!, fetchHandler)
    return new Client({ did: session.did as `did:${string}:${string}`, fetchHandler })
  }

  /**
   * Writes a record of a collection outside our lexicons (a Bluesky post, a
   * feed generator declaration) into an account's repo; the PDS validates it.
   */
  async putForeignRecord(did: string, collection: string, rkey: string, record: Record<string, unknown>): Promise<WriteOutput> {
    await this.requireClient(did)
    const res = await this.fetchHandlers.get(did)!('/xrpc/com.atproto.repo.putRecord', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: did, collection, rkey, record: { $type: collection, ...record } }),
    })
    const body = (await res.json().catch(() => ({}))) as { uri?: string; cid?: string; message?: string; error?: string }
    if (!res.ok || !body.uri || !body.cid) throw new Error(`putRecord ${collection} failed: ${body.error ?? res.status} ${body.message ?? ''}`)
    return { uri: body.uri as WriteOutput['uri'], cid: body.cid }
  }

  /** Whether a record exists in an account's repo. */
  async hasRecord(pdsUrl: string, did: string, collection: string, rkey: string): Promise<boolean> {
    const url = new URL('/xrpc/com.atproto.repo.getRecord', pdsUrl)
    url.search = new URLSearchParams({ repo: did, collection, rkey }).toString()
    return (await fetch(url)).ok
  }

  async isFrozen(community: string): Promise<boolean> {
    return isFrozen((await freezeIntervals(this.db, [community])).get(community))
  }

  /** Throws unless `did` is an active, unbanned moderator of an unfrozen `community`. */
  async requireModerator(did: string, community: string): Promise<void> {
    const [member, ban, frozen] = await Promise.all([
      this.db
        .selectFrom('community_member')
        .select('uri')
        .where('community_did', '=', community)
        .where('member_did', '=', did)
        .where('active', '=', true)
        .executeTakeFirst(),
      this.db.selectFrom('ban').select('uri').where('community_did', '=', community).where('subject_did', '=', did).executeTakeFirst(),
      this.isFrozen(community),
    ])
    if (!member) throw fail(403, 'NotModerator', 'You are not an active moderator of this community')
    if (ban) throw fail(403, 'Banned', 'You are banned from this community')
    if (frozen) throw fail(403, 'CommunityFrozen', 'A sysadmin has frozen this community; it accepts no changes for now')
  }

  /**
   * Writes a verdict on a run into its community's repo, with the moderator
   * as reviewer. Refuses unless the moderator is active in that community,
   * not banned there, and not a runner on the run.
   */
  async createVerdict(moderatorDid: string, input: VerdictInput): Promise<WriteOutput> {
    const status = input.status as VerdictStatus
    if (!['verified', 'rejected', 'changesRequested'].includes(status)) {
      throw fail(400, 'InvalidRequest', `Unknown verdict status "${input.status}"`)
    }
    const reason = input.reason?.trim() || undefined
    if (status !== 'verified' && !reason) throw fail(400, 'InvalidRequest', 'Say why when rejecting or requesting changes')
    if (status !== 'verified' && input.verifiedTimes) throw fail(400, 'InvalidRequest', 'Only a verified run can be retimed')

    const run = await this.db.selectFrom('run').selectAll().where('uri', '=', input.run.uri).executeTakeFirst()
    if (!run) throw fail(404, 'RunNotFound', 'The run is not in the index')
    if (run.cid !== input.run.cid) throw fail(409, 'RunChanged', 'The runner changed this run after you opened it; review the new version')
    if (status === 'verified' && run.problems.length > 0) {
      throw fail(400, 'RunInvalid', `The run fails its category's checks: ${run.problems.join(', ')}`)
    }

    const community = run.community_did
    await this.requireModerator(moderatorDid, community)
    if (run.runner_did === moderatorDid || run.co_runners.includes(moderatorDid)) {
      throw fail(403, 'OwnRun', 'You cannot judge a run you ran in')
    }
    const client = await this.requireClient(community)

    const ruleset = run.ruleset_uri
      ? await this.db.selectFrom('ruleset').select(['uri', 'cid']).where('uri', '=', run.ruleset_uri).executeTakeFirst()
      : undefined
    const record = ledger.verification.$parse({
      $type: ledger.verification.$type,
      subject: { uri: run.uri, cid: run.cid },
      status,
      reviewer: moderatorDid,
      reason,
      verifiedTimes: status === 'verified' ? input.verifiedTimes : undefined,
      ruleset: ruleset ? { uri: ruleset.uri, cid: ruleset.cid } : undefined,
      createdAt: new Date().toISOString(),
    })
    const { $type: _type, ...body } = record
    const out = await client.create(ledger.verification, body)
    this.logger.info({ community, run: run.uri, status, reviewer: moderatorDid, verdict: out.uri }, 'verdict written')
    return { uri: out.uri, cid: out.cid }
  }

  /** Bans a DID from a community's boards. Any single active moderator may; lifting takes a vote. */
  async createBan(moderatorDid: string, input: { community: string; subject: string; reason: string }): Promise<WriteOutput> {
    const reason = input.reason.trim()
    if (!reason) throw fail(400, 'InvalidRequest', 'Say why')
    if (input.subject === moderatorDid) throw fail(400, 'InvalidRequest', 'You cannot ban yourself')
    await this.requireModerator(moderatorDid, input.community)
    const existing = await this.db
      .selectFrom('ban')
      .select('uri')
      .where('community_did', '=', input.community)
      .where('subject_did', '=', input.subject)
      .executeTakeFirst()
    if (existing) throw fail(409, 'AlreadyBanned', 'That account is already banned here')
    const client = await this.requireClient(input.community)
    const { $type: _type, ...body } = ledger.community.ban.$parse({
      $type: ledger.community.ban.$type,
      subject: input.subject,
      reason,
      moderator: moderatorDid,
      createdAt: new Date().toISOString(),
    })
    const out = await client.create(ledger.community.ban, body)
    this.logger.info({ community: input.community, subject: input.subject, moderator: moderatorDid }, 'ban written')
    return { uri: out.uri, cid: out.cid }
  }

  /** Edits a game's details. Any active moderator may, without a vote. */
  async updateGame(moderatorDid: string, input: GameUpdate): Promise<WriteOutput> {
    const game = await this.db.selectFrom('game').select(['uri', 'community_did']).where('uri', '=', input.game).executeTakeFirst()
    const raw = game ? await this.db.selectFrom('record').select('json').where('uri', '=', game.uri).executeTakeFirst() : undefined
    if (!game || !raw) throw fail(404, 'GameNotFound', 'No such game in the index')
    await this.requireModerator(moderatorDid, game.community_did)
    const client = await this.requireClient(game.community_did)
    const current = raw.json as unknown as GameRecord
    const record = ledger.game.$parse({
      ...current,
      $type: ledger.game.$type,
      title: input.title?.trim() || current.title,
      releaseYear: input.releaseYear ?? current.releaseYear,
      platforms: input.platforms ?? current.platforms,
    })
    const { $type: _type, ...body } = record
    const out = await client.put(ledger.game, body, { rkey: game.uri.split('/').pop()! })
    this.logger.info({ game: game.uri, moderator: moderatorDid }, 'game updated')
    return { uri: out.uri, cid: out.cid }
  }

  async destroy(): Promise<void> {
    await this.db.destroy()
  }
}
