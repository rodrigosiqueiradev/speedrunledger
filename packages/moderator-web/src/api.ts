import type { CategoryView, MembershipView, QueueItem, RunTimes, RunView } from '@speedrunledger/lexicon'
import { call, postJson, query } from '@speedrunledger/web-ui'

export { ApiError } from '@speedrunledger/web-ui'

export interface VerdictInput {
  run: { uri: string; cid: string }
  status: 'verified' | 'rejected' | 'changesRequested'
  reason?: string
  verifiedTimes?: RunTimes
}

export const api = {
  me: () => call<{ did: string }>('/api/me'),
  logout: () => call('/api/logout', { method: 'POST' }),
  getRunner: (actor: string) => query<{ actor: { did: string; handle?: string } }>('getRunner', { actor, limit: '1' }),
  listMemberships: (actor: string) => query<{ memberships: MembershipView[] }>('listMemberships', { actor }),
  listReviewQueue: (community: string, cursor?: string) =>
    query<{ runs: QueueItem[]; cursor?: string }>('listReviewQueue', { community, cursor, limit: '50' }),
  getRun: (uri: string) => query<{ run: RunView }>('getRun', { uri }),
  getLeaderboard: (category: string) => query<{ category: CategoryView }>('getLeaderboard', { category, limit: '1' }),
  createVerdict: (input: VerdictInput) => postJson<{ uri: string; cid: string }>('/api/verdicts', input),
}
