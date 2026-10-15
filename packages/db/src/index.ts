import { Kysely, PostgresDialect } from 'kysely'
import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration'
import pg from 'pg'
import * as init from './migrations/001-init.js'
import * as boards from './migrations/002-boards.js'
import * as oauth from './migrations/003-oauth.js'
import type { DatabaseSchema } from './schema.js'

export * from './schema.js'

export type Database = Kysely<DatabaseSchema>

// bigint columns hold millisecond times, which fit comfortably in a JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10))

export function createDb(connectionString: string, opts: { max?: number } = {}): Database {
  return new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: opts.max ?? 10 }),
    }),
  })
}

const migrations: Record<string, Migration> = {
  '001-init': init,
  '002-boards': boards,
  '003-oauth': oauth,
}

class StaticMigrationProvider implements MigrationProvider {
  async getMigrations() {
    return migrations
  }
}

export async function migrateToLatest(db: Kysely<any>): Promise<void> {
  // Pin the bookkeeping tables to public: the dev PLC directory keeps its own
  // Kysely migration tables in the same database under the plc schema.
  const migrator = new Migrator({ db, provider: new StaticMigrationProvider(), migrationTableSchema: 'public' })
  const { error, results } = await migrator.migrateToLatest()
  for (const r of results ?? []) {
    if (r.status === 'Error') throw new Error(`migration ${r.migrationName} failed`, { cause: error })
  }
  if (error) throw error
}

/** Encodes a value for a jsonb column. */
export const json = (value: unknown): string => JSON.stringify(value)

/**
 * Identifies one board: a category plus one value for each of its
 * subcategory variables, e.g. `at://…/category/3k…?version=JP`.
 */
export function boardKey(categoryUri: string, subcategory: Record<string, string>): string {
  const params = Object.keys(subcategory)
    .sort()
    .map((id) => `${encodeURIComponent(id)}=${encodeURIComponent(subcategory[id])}`)
  return params.length === 0 ? categoryUri : `${categoryUri}?${params.join('&')}`
}
