import type {
  BanView,
  CategoryView,
  CommunityDetail,
  MembershipView,
  ModeratorView,
  ProposalView,
  QueueItem,
  RunTimes,
  RunView,
} from '@speedrunledger/lexicon'
import { call, postJson, query } from '@speedrunledger/web-ui'

export { ApiError } from '@speedrunledger/web-ui'

export interface VerdictInput {
  run: { uri: string; cid: string }
  status: 'verified' | 'rejected' | 'changesRequested'
  reason?: string
  verifiedTimes?: RunTimes
}

export interface StrongRef {
  uri: string
  cid: string
}

export type ProposalAction =
  | { $type: `${typeof P}#invite` | `${typeof P}#kick`; subject: string }
  | { $type: `${typeof P}#putRecord`; collection: string; rkey?: string; record: Record<string, unknown> }
  | { $type: `${typeof P}#liftBan`; ban: StrongRef }

export const P = 'app.speedrunledger-prototype.community.proposal'
export const CATEGORY = 'app.speedrunledger-prototype.category'
export const RULESET = 'app.speedrunledger-prototype.ruleset'

export const api = {
  me: () => call<{ did: string }>('/api/me'),
  logout: () => call('/api/logout', { method: 'POST' }),
  getRunner: (actor: string) => query<{ actor: { did: string; handle?: string } }>('getRunner', { actor, limit: '1' }),
  listMemberships: (actor: string) => query<{ memberships: MembershipView[] }>('listMemberships', { actor }),
  listReviewQueue: (community: string, cursor?: string) =>
    query<{ runs: QueueItem[]; cursor?: string }>('listReviewQueue', { community, cursor, limit: '50' }),
  getRun: (uri: string) => query<{ run: RunView }>('getRun', { uri }),
  getLeaderboard: (category: string) => query<{ category: CategoryView }>('getLeaderboard', { category, limit: '1' }),
  createVerdict: (input: VerdictInput) => postJson<StrongRef>('/api/verdicts', input),

  getCommunity: (community: string) => query<{ community: CommunityDetail }>('getCommunity', { community }),
  listProposals: (community: string, status: 'open' | 'closed') =>
    query<{ proposals: ProposalView[] }>('listProposals', { community, status, limit: '50' }),
  listModerators: (community: string) => query<{ moderators: ModeratorView[] }>('listModerators', { community }),
  listBans: (community: string) => query<{ bans: BanView[] }>('listBans', { community }),
  resolve: (actor: string) => call<{ did: string; handle: string }>(`/api/resolve?${new URLSearchParams({ actor })}`),

  accept: (grant: StrongRef) => postJson<StrongRef>('/api/accept', { grant }),
  propose: (input: { community: string; action: ProposalAction; reason: string }) => postJson<StrongRef>('/api/proposals', input),
  vote: (input: { proposal: StrongRef; value: 'yes' | 'no'; reason?: string }) => postJson<StrongRef>('/api/votes', input),
  createBan: (input: { community: string; subject: string; reason: string }) => postJson<StrongRef>('/api/bans', input),
  updateGame: (input: { game: string; title?: string; releaseYear?: number; platforms?: string[] }) =>
    postJson<StrongRef>('/api/games', input),
}
