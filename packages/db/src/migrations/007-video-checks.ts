import type { Kysely } from 'kysely'

/** Owned by the community service: the last check of each ranked run's video links. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('video_check')
    .addColumn('run_uri', 'text', (c) => c.notNull())
    .addColumn('url', 'text', (c) => c.notNull())
    .addColumn('community_did', 'text', (c) => c.notNull())
    // ok, dead (the host says it is gone), or unknown (we could not tell).
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('http_status', 'integer')
    .addColumn('detail', 'text')
    .addColumn('checked_at', 'timestamptz', (c) => c.notNull())
    .addPrimaryKeyConstraint('video_check_pkey', ['run_uri', 'url'])
    .execute()
  await db.schema.createIndex('video_check_community_idx').on('video_check').columns(['community_did', 'status']).execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('video_check').execute()
}
