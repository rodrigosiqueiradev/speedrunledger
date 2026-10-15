import type { BoardEntry, CategoryView, CommunityDetail, CommunityView, GameView, RequestView, RunView } from '@speedrunledger/lexicon'

import { call, postJson, query } from '@speedrunledger/web-ui'

export { ApiError } from '@speedrunledger/web-ui'

export const api = {
  listCommunities: () => query<{ communities: CommunityDetail[] }>('listCommunities', { limit: '100' }),
  getLeaderboard: (category: string, variables: string[]) =>
    query<{ category: CategoryView; game: GameView; community: CommunityView; subcategory: { variable: string; value: string }[]; entries: BoardEntry[] }>(
      'getLeaderboard',
      { category, variables },
    ),
  getRun: (uri: string) => query<{ run: RunView }>('getRun', { uri }),
  getRunner: (actor: string) => query<{ actor: { did: string; handle?: string }; runs: RunView[] }>('getRunner', { actor }),
  me: () => call<{ did: string }>('/api/me'),
  logout: () => call('/api/logout', { method: 'POST' }),
  submitRun: (run: unknown) => postJson<{ uri: string; cid: string }>('/api/runs', run),
  updateRun: (rkey: string, run: unknown) => postJson<{ uri: string; cid: string }>(`/api/runs/${encodeURIComponent(rkey)}`, run, 'PUT'),
  listMyRequests: (requester: string) =>
    query<{ requests: RequestView[] }>('listCommunityRequests', { requester, status: 'all', limit: '100' }),
  requestCommunity: (input: { game: { title: string; releaseYear?: number; platforms?: string[] }; founders: string[]; note?: string }) =>
    postJson<{ uri: string; cid: string }>('/api/requests', input),
  deleteRun: (rkey: string) => call('/api/runs/' + encodeURIComponent(rkey), { method: 'DELETE' }),
}
