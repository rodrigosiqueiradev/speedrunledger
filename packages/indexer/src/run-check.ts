import type { CategoryVariable } from '@speedrunledger/db'
import { timeField, type TimingMethod } from '@speedrunledger/lexicon'

export interface RunShape {
  variables: Record<string, string>
  real_time_ms: number | null
  real_time_no_loads_ms: number | null
  game_time_ms: number | null
}

export interface CategoryShape {
  kind: string
  primary_timing: string
  variables: CategoryVariable[]
}

const column = {
  realTimeMs: 'real_time_ms',
  realTimeNoLoadsMs: 'real_time_no_loads_ms',
  gameTimeMs: 'game_time_ms',
} as const

/**
 * Reference checks a run must pass beyond its lexicon: the category exists,
 * the category accepts the run's variable values, and the run carries the
 * time the category ranks by. Returns the failed checks; empty means valid.
 */
export function checkRun(run: RunShape, category: CategoryShape | undefined): string[] {
  if (!category) return ['category_not_found']
  const problems: string[] = []
  if (category.kind === 'time') {
    const field = timeField[category.primary_timing as TimingMethod]
    if (!field) {
      problems.push(`unknown_primary_timing:${category.primary_timing}`)
    } else if (run[column[field]] === null) {
      problems.push(`missing_time:${category.primary_timing}`)
    }
  } else {
    // Score categories are outside the prototype.
    problems.push(`unsupported_category_kind:${category.kind}`)
  }
  const defs = new Map(category.variables.map((v) => [v.id, v]))
  for (const [id, value] of Object.entries(run.variables)) {
    const def = defs.get(id)
    if (!def) problems.push(`unknown_variable:${id}`)
    else if (!def.values.includes(value)) problems.push(`invalid_variable_value:${id}`)
  }
  for (const def of category.variables) {
    if (def.subcategory && !(def.id in run.variables)) problems.push(`missing_subcategory:${def.id}`)
  }
  return problems
}
