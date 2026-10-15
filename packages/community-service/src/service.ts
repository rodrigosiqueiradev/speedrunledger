import { CredentialSession } from '@atproto/api'
import { type AtUriString, Client } from '@atproto/lex'
import { LexServerError } from '@atproto/lex-server'
import { createDb, type Database, migrateToLatest } from '@speedrunledger/db'
import { ledger, type RunTimes } from '@speedrunledger/lexicon'
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

const fail = (status: number, error: string, message: string) => new LexServerError(status, { error, message })

/**
 * Holds the community accounts' sessions and writes official records into
 * community repos on behalf of moderators, after checking in the index that
 * they may. Moderators never see these credentials.
 */
export type VerdictOutput = { uri: AtUriString; cid: string }

export class CommunityService {
  readonly db: Database
  private clients = new Map<string, Promise<Client>>()

  constructor(
    readonly config: CommunityServiceConfig,
    readonly logger: Logger,
  ) {
    this.db = createDb(config.databaseUrl, { max: 5 })
  }

  async migrate(): Promise<void> {
    await migrateToLatest(this.db)
  }

  /** Stores a community account's credentials after checking they work. Returns the account's DID. */
  async registerCommunity(input: { identifier: string; password: string; pdsUrl: string }): Promise<{ did: string; handle: string }> {
    const session = new CredentialSession(new URL(input.pdsUrl))
    const { data } = await session.login({ identifier: input.identifier, password: input.password })
    const now = new Date()
    const values = {
      did: data.did,
      identifier: input.identifier,
      pds_url: input.pdsUrl,
      secret: encrypt(this.config.secretKey, input.password),
      updated_at: now,
    }
    await this.db
      .insertInto('community_credential')
      .values({ ...values, created_at: now })
      .onConflict((oc) => oc.column('did').doUpdateSet(values))
      .execute()
    this.clients.set(data.did, Promise.resolve(this.clientFor(session)))
    this.logger.info({ did: data.did, handle: data.handle }, 'community registered')
    return { did: data.did, handle: data.handle }
  }

  async listCommunities(): Promise<{ did: string; identifier: string; pdsUrl: string }[]> {
    const rows = await this.db.selectFrom('community_credential').select(['did', 'identifier', 'pds_url']).orderBy('did').execute()
    return rows.map((r) => ({ did: r.did, identifier: r.identifier, pdsUrl: r.pds_url }))
  }

  /** A client writing to the community's repo, or undefined when this service holds no session for it. */
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

  private clientFor(session: CredentialSession): Client {
    return new Client({ did: session.did as `did:${string}:${string}`, fetchHandler: (path, init) => session.fetchHandler(path, init) })
  }

  /**
   * Writes a verdict on a run into its community's repo, with the moderator
   * as reviewer. Refuses unless the moderator is active in that community,
   * not banned there, and not a runner on the run.
   */
  async createVerdict(moderatorDid: string, input: VerdictInput): Promise<VerdictOutput> {
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
    const [member, ban] = await Promise.all([
      this.db
        .selectFrom('community_member')
        .select('uri')
        .where('community_did', '=', community)
        .where('member_did', '=', moderatorDid)
        .where('active', '=', true)
        .executeTakeFirst(),
      this.db
        .selectFrom('ban')
        .select('uri')
        .where('community_did', '=', community)
        .where('subject_did', '=', moderatorDid)
        .executeTakeFirst(),
    ])
    if (!member) throw fail(403, 'NotModerator', 'You are not an active moderator of this community')
    if (ban) throw fail(403, 'Banned', 'You are banned from this community')
    if (run.runner_did === moderatorDid || run.co_runners.includes(moderatorDid)) {
      throw fail(403, 'OwnRun', 'You cannot judge a run you ran in')
    }

    const client = await this.communityClient(community)
    if (!client) throw fail(503, 'CommunityNotManaged', 'This service does not hold a session for the community')

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

  async destroy(): Promise<void> {
    await this.db.destroy()
  }
}
