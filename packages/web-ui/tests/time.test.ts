import { describe, expect, it } from 'vitest'
import { formatMs, parseTime } from '../src/time.js'

describe('times', () => {
  it('formats with hours and minutes only when needed', () => {
    expect(formatMs(59_900)).toBe('59.900')
    expect(formatMs(902_340)).toBe('15:02.340')
    expect(formatMs(3_723_456)).toBe('1:02:03.456')
    expect(formatMs(undefined)).toBe('—')
  })

  it('parses what it formats', () => {
    for (const ms of [0, 59_900, 902_340, 3_723_456, 36_000_001]) expect(parseTime(formatMs(ms))).toBe(ms)
    expect(parseTime('15:02.34')).toBe(902_340)
  })

  it('rejects malformed times', () => {
    for (const text of ['', 'abc', '1:60.000', '1:61:00', '12.3456']) expect(parseTime(text)).toBeUndefined()
  })
})
