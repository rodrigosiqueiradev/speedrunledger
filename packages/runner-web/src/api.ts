import type { BoardEntry, CategoryView, CommunityDetail, CommunityView, GameView, RunView } from '@speedrunledger/lexicon'

const NS = 'app.speedrunledger-prototype'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.message ?? body.error ?? res.statusText)
  return body as T
}

const query = <T>(method: string, params: Record<string, string | string[] | undefined>) => {
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) for (const item of [v ?? []].flat()) search.append(k, item)
  return call<T>(`/xrpc/${NS}.${method}?${search}`)
}

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
  submitRun: (run: unknown) =>
    call<{ uri: string; cid: string }>('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(run),
    }),
  updateRun: (rkey: string, run: unknown) =>
    call<{ uri: string; cid: string }>('/api/runs/' + encodeURIComponent(rkey), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(run),
    }),
  deleteRun: (rkey: string) => call('/api/runs/' + encodeURIComponent(rkey), { method: 'DELETE' }),
}
