import type { Kysely } from 'kysely'

/** Storage for the web apps' atproto OAuth clients. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('oauth_state')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'jsonb', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .execute()
  await db.schema
    .createTable('oauth_session')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'jsonb', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('oauth_session').execute()
  await db.schema.dropTable('oauth_state').execute()
}
