import type { Kysely } from 'kysely'

/** Community account credentials held by the community service, encrypted at rest. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('community_credential')
    .addColumn('did', 'text', (c) => c.primaryKey())
    .addColumn('identifier', 'text', (c) => c.notNull())
    .addColumn('pds_url', 'text', (c) => c.notNull())
    .addColumn('secret', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('community_credential').execute()
}
