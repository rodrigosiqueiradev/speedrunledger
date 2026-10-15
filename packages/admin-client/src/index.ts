/**
 * What a sysadmin can do, as typed calls: the community service's admin
 * endpoints (with the admin token) and the AppView reads they need. Both
 * `ledger-admin` and the Admin app go through this, so they stay the same.
 */

export interface AdminClientEnv {
  /** The community service; admin endpoints live under /admin. */
  communityServiceUrl: string
  adminToken: string
  appviewUrl: string
  /** Resolves .test handles locally, and is where new accounts are created. */
  pdsUrl?: string
  plcUrl: string
}

/** An error answered by the community service or the AppView, with its status and error name. */
export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    /** The message without the error name, for people. */
    readonly detail: string,
  ) {
    super(`${error}: ${detail}`)
  }
}

export interface GameInput {
  title: string
  releaseYear?: number
  platforms?: string[]
}

export interface ActorRef {
  did: string
  handle?: string
}

export interface CommunityRequest {
  uri: string
  cid: string
  requester: ActorRef
  game: GameInput
  founders: ActorRef[]
  note?: string
  status: 'pending' | 'approved' | 'denied' | string
  denialReason?: string
  community?: string
  indexedAt: string
}

export interface ManagedCommunity {
  did: string
  identifier: string
  /** From the AppView; missing until the indexer has seen the community. */
  detail?: {
    community: { did: string; handle?: string; name: string; description?: string; frozen?: boolean }
    games: { game: { uri: string; title: string; releaseYear?: number; platforms?: string[] } }[]
  }
}

export interface CreateCommunityInput {
  sysadmin: string
  handle: string
  name: string
  description?: string
  /** Take the game and founders from this community request. */
  request?: string
  game?: GameInput
  founders?: string[]
  /** Founders' PLC rotation key, so they can migrate without us. */
  recoveryKey?: string
}

export interface CreatedCommunity {
  did: string
  handle: string
  game: string
  grants: string[]
}

export interface WriteResult {
  uri: string
  cid: string
}

export class AdminClient {
  constructor(readonly env: AdminClientEnv) {}

  private async admin<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(path, this.env.communityServiceUrl), {
      method,
      headers: { authorization: `Bearer ${this.env.adminToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as any
    if (!res.ok) throw new AdminApiError(res.status, data.error ?? String(res.status), data.message ?? res.statusText)
    return data as T
  }

  private async appview<T>(nsid: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`/xrpc/app.speedrunledger-prototype.${nsid}`, this.env.appviewUrl)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    const res = await fetch(url)
    if (!res.ok) throw new AdminApiError(res.status, 'AppViewError', `AppView ${nsid} returned ${res.status}`)
    return (await res.json()) as T
  }

  /** A DID for a DID or handle: the local PDS knows .test handles; anything else uses the handle's well-known file. */
  async resolve(actor: string): Promise<string> {
    if (actor.startsWith('did:')) return actor
    const handle = actor.trim().replace(/^@/, '')
    if (this.env.pdsUrl) {
      const res = await fetch(new URL(`/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`, this.env.pdsUrl))
      if (res.ok) return ((await res.json()) as { did: string }).did
    }
    const res = await fetch(`https://${handle}/.well-known/atproto-did`).catch(() => undefined)
    const did = res?.ok ? (await res.text()).trim() : ''
    if (!did.startsWith('did:')) throw new AdminApiError(404, 'NotFound', `could not resolve handle ${handle}`)
    return did
  }

  /** The PDS hosting a DID, from its DID document. */
  async pdsOf(did: string): Promise<string> {
    const url = did.startsWith('did:web:')
      ? `https://${decodeURIComponent(did.slice('did:web:'.length))}/.well-known/did.json`
      : new URL(`/${did}`, this.env.plcUrl).toString()
    const res = await fetch(url)
    if (!res.ok) throw new AdminApiError(404, 'NotFound', `could not resolve ${did}`)
    const doc = (await res.json()) as { service?: { id: string; serviceEndpoint: string }[] }
    const pds = doc.service?.find((s) => s.id.endsWith('#atproto_pds'))?.serviceEndpoint
    if (!pds) throw new AdminApiError(404, 'NotFound', `${did} names no PDS`)
    return pds
  }

  /** Where a community's whole repo can be downloaded as a signed CAR file. */
  async exportUrl(community: string): Promise<string> {
    const pds = await this.pdsOf(community)
    return new URL(`/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(community)}`, pds).toString()
  }

  initPlatform(input: { handle: string; sysadmin: string }) {
    return this.admin<{ did: string; handle: string }>('POST', '/admin/platform', input)
  }

  async listSysadmins(): Promise<string[]> {
    return (await this.admin<{ sysadmins: string[] }>('GET', '/admin/sysadmins')).sysadmins
  }

  addSysadmin(sysadmin: string, subject: string) {
    return this.admin<WriteResult>('POST', '/admin/sysadmins', { sysadmin, subject })
  }

  async removeSysadmin(sysadmin: string, subject: string): Promise<void> {
    await this.admin('POST', '/admin/sysadmins/remove', { sysadmin, subject })
  }

  async listRequests(status: 'pending' | 'all' = 'pending'): Promise<CommunityRequest[]> {
    return (await this.appview<{ requests: CommunityRequest[] }>('listCommunityRequests', { status })).requests
  }

  denyRequest(sysadmin: string, request: string, reason: string) {
    return this.admin<WriteResult>('POST', '/admin/requests/deny', { sysadmin, request, reason })
  }

  /** The communities the community service writes for, with what the AppView knows about each. */
  async listCommunities(): Promise<ManagedCommunity[]> {
    const { communities } = await this.admin<{ communities: { did: string; identifier: string }[] }>('GET', '/admin/communities')
    return Promise.all(
      communities.map(async (m) => ({
        ...m,
        detail: await this.appview<{ community: ManagedCommunity['detail'] }>('getCommunity', { community: m.did }).then(
          (r) => r.community,
          () => undefined,
        ),
      })),
    )
  }

  createCommunity(input: CreateCommunityInput) {
    return this.admin<CreatedCommunity>('POST', '/admin/communities/create', input)
  }

  /** Hands an existing community account to the community service. */
  registerCommunity(identifier: string, password: string) {
    if (!this.env.pdsUrl) throw new AdminApiError(400, 'InvalidRequest', 'PDS_URL is required')
    return this.admin<{ did: string; handle: string }>('POST', '/admin/communities', { identifier, password, pdsUrl: this.env.pdsUrl })
  }

  addGame(sysadmin: string, community: string, game: GameInput) {
    return this.admin<WriteResult>('POST', `/admin/communities/${encodeURIComponent(community)}/games`, { sysadmin, ...game })
  }

  /** Only when the community has no active moderator; they become one once they accept. */
  appoint(sysadmin: string, community: string, subject: string, reason: string) {
    return this.admin<{ intervention: string; grant: string }>('POST', `/admin/communities/${encodeURIComponent(community)}/appoint`, {
      sysadmin,
      subject,
      reason,
    })
  }

  setFrozen(sysadmin: string, community: string, frozen: boolean, reason: string) {
    return this.admin<WriteResult>('POST', `/admin/communities/${encodeURIComponent(community)}/${frozen ? 'freeze' : 'unfreeze'}`, {
      sysadmin,
      reason,
    })
  }

  executeProposals() {
    return this.admin<{ executed: number }>('POST', '/admin/proposals/execute', {})
  }

  runAnnouncements() {
    return this.admin<{ posted: number }>('POST', '/admin/announcements/run', {})
  }

  checkVideos() {
    return this.admin<{ checked: number; dead: number }>('POST', '/admin/videos/check', {})
  }
}
