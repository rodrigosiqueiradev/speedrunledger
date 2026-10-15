/** Formats milliseconds as h:mm:ss.mmm (hours and minutes only when needed). */
export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '—'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const frac = String(ms % 1000).padStart(3, '0')
  const ss = String(s).padStart(h || m ? 2 : 1, '0')
  if (h) return `${h}:${String(m).padStart(2, '0')}:${ss}.${frac}`
  if (m) return `${m}:${ss}.${frac}`
  return `${ss}.${frac}`
}

/** Parses "1:02:03.456", "15:02.34" or "59.9" into milliseconds; undefined if malformed. */
export function parseTime(text: string): number | undefined {
  const match = /^\s*(?:(\d+):)?(?:(\d{1,2}):)?(\d{1,2})(?:\.(\d{1,3}))?\s*$/.exec(text)
  if (!match) return undefined
  let [, a, b] = match as (string | undefined)[]
  const [, , , sec, frac] = match
  // With a single colon the first group is minutes.
  if (a !== undefined && b === undefined) [a, b] = [undefined, a]
  const hours = Number(a ?? 0)
  const minutes = Number(b ?? 0)
  const seconds = Number(sec)
  if (minutes > 59 && a !== undefined) return undefined
  if (seconds > 59 && (a !== undefined || b !== undefined)) return undefined
  const ms = Number((frac ?? '').padEnd(3, '0') || 0)
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms
}
