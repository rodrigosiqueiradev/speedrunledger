import { randomBytes } from 'node:crypto'
import { AtpAgent } from '@atproto/api'
import { platformDid } from '@speedrunledger/db'
import { ledger } from '@speedrunledger/lexicon'
import { type CommunityService, fail, type WriteOutput } from './service.js'

export interface GameInput {
  title: string
  releaseYear?: number
  platforms?: string[]
}

export interface CreateCommunityInput {
  sysadmin: string
  /** Full handle for the new account, e.g. sm64.communities.example (locally sm64.test). */
  handle: string
  name: string
  description?: string
  /** Defaults to the request's game. */
  game?: GameInput
  /** Founding moderators' DIDs; defaults to the request's founders. */
  founders?: string[]
  /** The community.request this community answers. */
  request?: string
  /** A did:key the founders hold, added to the DID's rotation keys so they can migrate without us. */
  recoveryKey?: string
  email?: string
}

type Did = `did:${string}:${string}`
const now = () => new Date().toISOString()
const strip = <T extends { $type?: unknown }>(record: T): Omit<T, '$type'> => {
  const { $type: _type, ...rest } = record
  return rest
}

/**
 * What sysadmins do through `ledger-admin`: set up the platform account,
 * list sysadmins, answer community requests, create communities, and
 * intervene (appoint a moderator, freeze, unfreeze). Every write is a public
 * record naming the sysadmin.
 */
export class AdminService {
  constructor(
    private readonly service: CommunityService,
    private readonly pds: { url: string; adminPassword?: string },
  ) {}

  private get db() {
    return this.service.db
  }

  /** Creates an account on the PDS and returns an app password for this service to keep. */
  private async createAccount(handle: string, opts: { email?: string; recoveryKey?: string }) {
    const agent = new AtpAgent({ service: this.pds.url })
    let inviteCode: string | undefined
    if (this.pds.adminPassword) {
      const res = await fetch(new URL('/xrpc/com.atproto.server.createInviteCode', this.pds.url), {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`admin:${this.pds.adminPassword}`).toString('base64')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ useCount: 1 }),
      })
      if (res.ok) inviteCode = ((await res.json()) as { code: string }).code
    }
    await agent.createAccount({
      handle,
      email: opts.email ?? `${handle}@accounts.invalid`,
      password: randomBytes(24).toString('base64url'),
      inviteCode,
      recoveryKey: opts.recoveryKey,
    })
    const { data } = await agent.com.atproto.server.createAppPassword({ name: 'speedrunledger-community-service' })
    return { did: agent.session!.did, handle: agent.session!.handle, appPassword: data.password }
  }

  /** The DIDs listed as sysadmins in the platform repo, read from the PDS so there is no indexing lag. */
  async listSysadmins(): Promise<string[]> {
    const platform = await this.platform()
    if (!platform) return []
    const url = new URL('/xrpc/com.atproto.repo.listRecords', platform.pdsUrl)
    url.searchParams.set('repo', platform.did)
    url.searchParams.set('collection', ledger.platform.sysadmin.$nsid)
    url.searchParams.set('limit', '100')
    const res = await fetch(url)
    if (!res.ok) throw new Error(`listRecords returned ${res.status}`)
    const { records } = (await res.json()) as { records: { value: { subject: string } }[] }
    return records.map((r) => r.value.subject)
  }

  private async platform() {
    const did = await platformDid(this.db)
    if (!did) return undefined
    const row = await this.db.selectFrom('community_credential').select('pds_url').where('did', '=', did).executeTakeFirstOrThrow()
    return { did, pdsUrl: row.pds_url }
  }

  async requireSysadmin(did: string): Promise<void> {
    if (!(await this.listSysadmins()).includes(did)) throw fail(403, 'NotSysadmin', `${did} is not a sysadmin`)
  }

  /** Creates the platform account and lists the first sysadmin. Only works once. */
  async initPlatform(input: { handle: string; sysadmin: string; email?: string }): Promise<{ did: string; handle: string }> {
    if (await this.platform()) throw fail(409, 'AlreadyInitialized', 'The platform account already exists')
    const account = await this.createAccount(input.handle, { email: input.email })
    await this.service.registerAccount({ identifier: account.did, password: account.appPassword, pdsUrl: this.pds.url }, 'platform')
    await this.writeSysadmin(account.did, input.sysadmin)
    return { did: account.did, handle: account.handle }
  }

  async addSysadmin(actingSysadmin: string, subject: string): Promise<WriteOutput> {
    await this.requireSysadmin(actingSysadmin)
    const platform = await this.platform()
    return this.writeSysadmin(platform!.did, subject)
  }

  private async writeSysadmin(platform: string, subject: string): Promise<WriteOutput> {
    const client = await this.service.requireClient(platform)
    const record = strip(ledger.platform.sysadmin.$parse({ $type: ledger.platform.sysadmin.$type, subject, createdAt: now() }))
    return client.put(ledger.platform.sysadmin, record, { rkey: subject })
  }

  async denyRequest(sysadmin: string, requestUri: string, reason: string): Promise<WriteOutput> {
    await this.requireSysadmin(sysadmin)
    if (!reason.trim()) throw fail(400, 'InvalidRequest', 'Give the requester a reason')
    const request = await this.db.selectFrom('community_request').select(['uri', 'cid']).where('uri', '=', requestUri).executeTakeFirst()
    if (!request) throw fail(404, 'NotFound', 'No such request in the index')
    const platform = await this.platform()
    const client = await this.service.requireClient(platform!.did)
    const record = strip(
      ledger.platform.requestDenial.$parse({
        $type: ledger.platform.requestDenial.$type,
        request: { uri: request.uri, cid: request.cid },
        reason: reason.trim(),
        sysadmin,
        createdAt: now(),
      }),
    )
    return client.create(ledger.platform.requestDenial, record)
  }

  /**
   * Creates a community: its account (with the founders' rotation key, when
   * given), its profile and game, and a membership grant per founder. Founders
   * become moderators once they accept.
   */
  async createCommunity(input: CreateCommunityInput) {
    await this.requireSysadmin(input.sysadmin)
    let game = input.game
    let founders = input.founders
    let via: { uri: string; cid: string } | undefined
    if (input.request) {
      const request = await this.db.selectFrom('community_request').selectAll().where('uri', '=', input.request).executeTakeFirst()
      if (!request) throw fail(404, 'NotFound', 'No such request in the index')
      via = { uri: request.uri, cid: request.cid }
      game ??= request.game as GameInput
      founders ??= request.founders
    }
    if (!game?.title) throw fail(400, 'InvalidRequest', 'A community needs a game')
    if (!founders?.length) throw fail(400, 'InvalidRequest', 'A community needs at least one founding moderator')

    const account = await this.createAccount(input.handle, { email: input.email, recoveryKey: input.recoveryKey })
    await this.service.registerAccount({ identifier: account.did, password: account.appPassword, pdsUrl: this.pds.url }, 'community')
    const client = await this.service.requireClient(account.did)

    const profile = strip(
      ledger.community.profile.$parse({
        $type: ledger.community.profile.$type,
        name: input.name,
        description: input.description,
        createdAt: now(),
      }),
    )
    await client.put(ledger.community.profile, profile, { rkey: 'self' })
    const gameOut = await this.writeGame(account.did, game)
    const grants: string[] = []
    for (const founder of founders) {
      const grant = strip(
        ledger.community.member.$parse({ $type: ledger.community.member.$type, subject: founder, via, createdAt: now() }),
      )
      grants.push((await client.create(ledger.community.member, grant)).uri)
    }
    this.service.logger.info({ did: account.did, handle: account.handle, sysadmin: input.sysadmin }, 'community created')
    return { did: account.did, handle: account.handle, game: gameOut.uri, grants }
  }

  async addGame(sysadmin: string, community: string, game: GameInput): Promise<WriteOutput> {
    await this.requireSysadmin(sysadmin)
    return this.writeGame(community, game)
  }

  private async writeGame(community: string, game: GameInput): Promise<WriteOutput> {
    const client = await this.service.requireClient(community)
    const record = strip(
      ledger.game.$parse({
        $type: ledger.game.$type,
        title: game.title,
        releaseYear: game.releaseYear,
        platforms: game.platforms ?? [],
        createdAt: now(),
      }),
    )
    return client.create(ledger.game, record)
  }

  /** Appoints a moderator in a community that has none active, recording why. */
  async appoint(sysadmin: string, community: string, subject: string, reason: string) {
    await this.requireSysadmin(sysadmin)
    const active = await this.db
      .selectFrom('community_member')
      .select('member_did')
      .where('community_did', '=', community)
      .where('active', '=', true)
      .execute()
    if (active.length > 0) throw fail(409, 'HasModerators', 'The community has active moderators; they invite new ones by vote')
    const intervention = await this.intervene(sysadmin, community, { action: 'appoint', subject, reason })
    const client = await this.service.requireClient(community)
    const grant = strip(
      ledger.community.member.$parse({
        $type: ledger.community.member.$type,
        subject,
        via: { uri: intervention.uri, cid: intervention.cid },
        createdAt: now(),
      }),
    )
    const out = await client.create(ledger.community.member, grant)
    return { intervention: intervention.uri, grant: out.uri }
  }

  async setFrozen(sysadmin: string, community: string, frozen: boolean, reason: string): Promise<WriteOutput> {
    await this.requireSysadmin(sysadmin)
    if ((await this.service.isFrozen(community)) === frozen) {
      throw fail(409, 'NoChange', frozen ? 'The community is already frozen' : 'The community is not frozen')
    }
    return this.intervene(sysadmin, community, { action: frozen ? 'freeze' : 'unfreeze', reason })
  }

  private async intervene(sysadmin: string, community: string, what: { action: string; subject?: string; reason: string }) {
    if (!what.reason.trim()) throw fail(400, 'InvalidRequest', 'An intervention needs a public reason')
    const client = await this.service.requireClient(community)
    const record = strip(
      ledger.community.intervention.$parse({
        $type: ledger.community.intervention.$type,
        action: what.action,
        subject: what.subject as Did | undefined,
        reason: what.reason.trim(),
        sysadmin,
        createdAt: now(),
      }),
    )
    return client.create(ledger.community.intervention, record)
  }
}
