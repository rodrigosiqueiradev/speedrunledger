import type { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('board_entry')
    .addColumn('board_key', 'text', (c) => c.notNull())
    .addColumn('entrant_key', 'text', (c) => c.notNull())
    .addColumn('category_uri', 'text', (c) => c.notNull())
    .addColumn('subcategory', 'jsonb', (c) => c.notNull())
    .addColumn('rank', 'integer', (c) => c.notNull())
    .addColumn('runner_did', 'text', (c) => c.notNull())
    .addColumn('run_uri', 'text', (c) => c.notNull())
    .addColumn('run_cid', 'text', (c) => c.notNull())
    .addColumn('verification_uri', 'text', (c) => c.notNull())
    .addColumn('ranked_ms', 'bigint', (c) => c.notNull())
    .addColumn('indexed_at', 'timestamptz', (c) => c.notNull())
    .addPrimaryKeyConstraint('board_entry_pkey', ['board_key', 'entrant_key'])
    .execute()
  await db.schema.createIndex('board_entry_category_idx').on('board_entry').column('category_uri').execute()
  await db.schema.createIndex('board_entry_rank_idx').on('board_entry').columns(['board_key', 'rank']).execute()
  await db.schema.createIndex('board_entry_run_idx').on('board_entry').column('run_uri').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('board_entry').execute()
}
