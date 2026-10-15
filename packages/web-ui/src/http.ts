/** An XRPC or API error with its HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly error?: string,
  ) {
    super(message)
  }
}

/** fetch() that parses JSON and throws ApiError on a non-2xx status. */
export async function call<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.message ?? body.error ?? res.statusText, body.error)
  return body as T
}

export const postJson = <T>(path: string, body: unknown, method = 'POST') =>
  call<T>(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Calls an app.speedrunledger-prototype query through the app's /xrpc proxy. */
export function query<T>(method: string, params: Record<string, string | string[] | undefined>): Promise<T> {
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) for (const item of [v ?? []].flat()) search.append(k, item)
  return call<T>(`/xrpc/app.speedrunledger-prototype.${method}?${search}`)
}
