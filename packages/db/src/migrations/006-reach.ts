import { type Kysely, sql } from 'kysely'

/** World records as boards change, the posts announcing them, and moderators' labels. */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Written by the indexer whenever a board gets a new first place that beats the old one.
  await db.schema
    .createTable('world_record')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('board_key', 'text', (c) => c.notNull())
    .addColumn('category_uri', 'text', (c) => c.notNull())
    .addColumn('community_did', 'text', (c) => c.notNull())
    .addColumn('run_uri', 'text', (c) => c.notNull())
    .addColumn('runner_did', 'text', (c) => c.notNull())
    .addColumn('ranked_ms', 'bigint', (c) => c.notNull())
    .addColumn('previous_run_uri', 'text')
    .addColumn('previous_runner_did', 'text')
    .addColumn('previous_ranked_ms', 'bigint')
    // Found while catching up (backfill); never announced.
    .addColumn('quiet', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('set_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('world_record_board_run_key', ['board_key', 'run_uri'])
    .execute()
  await db.schema.createIndex('world_record_runner_idx').on('world_record').columns(['runner_did', 'set_at']).execute()
  await db.schema.createIndex('world_record_previous_idx').on('world_record').columns(['previous_runner_did', 'set_at']).execute()
  await db.schema.createIndex('world_record_community_idx').on('world_record').columns(['community_did', 'set_at']).execute()

  // Owned by the community service: the Bluesky post announcing a world record.
  await db.schema
    .createTable('announcement')
    .addColumn('world_record_id', 'bigint', (c) => c.primaryKey())
    .addColumn('community_did', 'text', (c) => c.notNull())
    .addColumn('game_uri', 'text', (c) => c.notNull())
    .addColumn('post_uri', 'text')
    .addColumn('post_cid', 'text')
    .addColumn('error', 'text')
    .addColumn('posted_at', 'timestamptz')
    .execute()
  await db.schema.createIndex('announcement_game_idx').on('announcement').columns(['game_uri', 'posted_at']).execute()

  // Owned by the community service: atproto labels it signs as a labeler.
  await db.schema
    .createTable('label')
    .addColumn('seq', 'bigserial', (c) => c.primaryKey())
    .addColumn('src', 'text', (c) => c.notNull())
    .addColumn('uri', 'text', (c) => c.notNull())
    .addColumn('cid', 'text')
    .addColumn('val', 'text', (c) => c.notNull())
    .addColumn('neg', 'boolean', (c) => c.notNull())
    .addColumn('cts', 'text', (c) => c.notNull())
    .addColumn('sig', 'bytea', (c) => c.notNull())
    .addColumn('community_did', 'text', (c) => c.notNull())
    .addColumn('moderator_did', 'text', (c) => c.notNull())
    .addColumn('reason', 'text')
    .execute()
  await db.schema.createIndex('label_uri_idx').on('label').columns(['uri', 'val', 'seq']).execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('label').execute()
  await db.schema.dropTable('announcement').execute()
  await db.schema.dropTable('world_record').execute()
}
