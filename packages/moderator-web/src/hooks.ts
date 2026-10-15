import { useEffect, useState } from 'react'
import { api } from './api.js'

export { useAction, useRefresh } from '@speedrunledger/web-ui'

const handles = new Map<string, Promise<string | undefined>>()

/** The handle for a DID, looked up once per page load. */
export function useHandle(did: string | undefined, known?: string): string | undefined {
  const [handle, setHandle] = useState(known)
  useEffect(() => {
    if (known || !did) return
    if (!handles.has(did)) handles.set(did, api.resolve(did).then((r) => (r.handle === 'handle.invalid' ? undefined : r.handle), () => undefined))
    let live = true
    handles.get(did)!.then((h) => live && setHandle(h))
    return () => {
      live = false
    }
  }, [did, known])
  return handle
}
