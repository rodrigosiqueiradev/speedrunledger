import { describe, expect, it } from 'vitest'
import { checkRun } from '../src/run-check.js'

const category = {
  kind: 'time',
  primary_timing: 'realTime',
  variables: [
    { id: 'platform', name: 'Platform', values: ['N64', 'VC'], subcategory: false },
    { id: 'version', name: 'Version', values: ['JP', 'US'], subcategory: true },
  ],
}
const run = (overrides = {}) => ({
  variables: { version: 'JP' },
  real_time_ms: 900_000,
  real_time_no_loads_ms: null,
  game_time_ms: null,
  ...overrides,
})

describe('checkRun', () => {
  it('passes a run that matches its category', () => {
    expect(checkRun(run(), category)).toEqual([])
    expect(checkRun(run({ variables: { version: 'US', platform: 'VC' } }), category)).toEqual([])
  })

  it('flags a missing category', () => {
    expect(checkRun(run(), undefined)).toEqual(['category_not_found'])
  })

  it('requires the time the category ranks by', () => {
    expect(checkRun(run({ real_time_ms: null, game_time_ms: 1 }), category)).toEqual(['missing_time:realTime'])
  })

  it('checks variables against the category', () => {
    expect(checkRun(run({ variables: { version: 'EU' } }), category)).toEqual(['invalid_variable_value:version'])
    expect(checkRun(run({ variables: { version: 'JP', glitch: 'yes' } }), category)).toEqual(['unknown_variable:glitch'])
    expect(checkRun(run({ variables: {} }), category)).toEqual(['missing_subcategory:version'])
  })
})
