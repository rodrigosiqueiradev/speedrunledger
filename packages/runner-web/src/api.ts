import type { BoardEntry, CategoryView, CommunityDetail, CommunityView, GameView, RunView } from '@speedrunledger/lexicon'

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
  deleteRun: (rkey: string) => call('/api/runs/' + encodeURIComponent(rkey), { method: 'DELETE' }),
}
