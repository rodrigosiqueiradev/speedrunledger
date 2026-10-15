import type { CommunityRequest, CreatedCommunity, GameInput, ManagedCommunity, WriteResult } from '@speedrunledger/admin-client'
import type { CommunityDetail, ModeratorView } from '@speedrunledger/lexicon'
import { call, postJson, query } from '@speedrunledger/web-ui'

export type { CommunityRequest, GameInput, ManagedCommunity }

export interface Actor {
  did: string
  handle?: string
}

export interface WhoAmI extends Actor {
  /** The platform account exists and lists at least one sysadmin. */
  initialized: boolean
  sysadmin: boolean
}

const enc = encodeURIComponent

export const api = {
  whoami: () => call<WhoAmI>('/api/whoami'),
  logout: () => call('/api/logout', { method: 'POST' }),
  initPlatform: (input: { handle: string; setupCode: string }) => postJson<{ did: string; handle: string }>('/api/platform', input),

  listSysadmins: () => call<{ sysadmins: Actor[] }>('/api/sysadmins'),
  addSysadmin: (actor: string) => postJson<Actor>('/api/sysadmins', { actor }),
  removeSysadmin: (did: string) => postJson('/api/sysadmins/remove', { did }),

  listRequests: (status: 'pending' | 'all') => call<{ requests: CommunityRequest[] }>(`/api/requests?status=${status}`),
  denyRequest: (request: string, reason: string) => postJson<WriteResult>('/api/requests/deny', { request, reason }),

  listCommunities: () => call<{ communities: ManagedCommunity[] }>('/api/communities'),
  createCommunity: (input: {
    handle: string
    name: string
    description?: string
    request?: string
    game?: GameInput
    founders?: string[]
    recoveryKey?: string
  }) => postJson<CreatedCommunity>('/api/communities', input),
  registerCommunity: (identifier: string, password: string) =>
    postJson<{ did: string; handle: string }>('/api/communities/register', { identifier, password }),
  addGame: (community: string, game: GameInput) => postJson<WriteResult>(`/api/communities/${enc(community)}/games`, game),
  appoint: (community: string, actor: string, reason: string) =>
    postJson<{ subject: Actor }>(`/api/communities/${enc(community)}/appoint`, { actor, reason }),
  setFrozen: (community: string, frozen: boolean, reason: string) =>
    postJson<WriteResult>(`/api/communities/${enc(community)}/${frozen ? 'freeze' : 'unfreeze'}`, { reason }),
  exportHref: (community: string) => `/api/communities/${enc(community)}/export`,
  getCommunity: (community: string) => query<{ community: CommunityDetail }>('getCommunity', { community }),
  listModerators: (community: string) => query<{ moderators: ModeratorView[] }>('listModerators', { community }),

  executeProposals: () => postJson<{ executed: number }>('/api/jobs/proposals', {}),
  runAnnouncements: () => postJson<{ posted: number }>('/api/jobs/announcements', {}),
  checkVideos: () => postJson<{ checked: number; dead: number }>('/api/jobs/videos', {}),
}

/** "Super Mario 64 (1996) · N64, Wii VC" */
export const gameLabel = (g: GameInput) =>
  `${g.title}${g.releaseYear ? ` (${g.releaseYear})` : ''}${g.platforms?.length ? ` · ${g.platforms.join(', ')}` : ''}`

export const actorLabel = (a: Actor) => `@${a.handle ?? a.did}`
