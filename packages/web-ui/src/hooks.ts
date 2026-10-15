import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A counter to put in effect dependencies, and a function that bumps it now
 * and a few more times over the next seconds: writes reach the AppView only
 * once the indexer has seen them.
 */
export function useRefresh(): [number, () => void] {
  const [version, setVersion] = useState(0)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])
  const refresh = useCallback(() => {
    timers.current.forEach(clearTimeout)
    timers.current = [0, 700, 1500, 3000, 6000].map((ms) => setTimeout(() => setVersion((v) => v + 1), ms))
  }, [])
  return [version, refresh]
}

/** Runs an action, tracking busy state and the error message. */
export function useAction(): {
  busy: boolean
  error?: string
  setError: (e?: string) => void
  run: (fn: () => Promise<unknown>) => Promise<boolean>
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
      return true
    } catch (err) {
      setError((err as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, error, setError, run }
}
