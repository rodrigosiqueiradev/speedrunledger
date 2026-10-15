import { type Kysely, sql } from 'kysely'

/** Proposal snapshots, sysadmin interventions, request denials and proposal execution. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('proposal')
    .addColumn('electorate', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('problems', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('first_indexed_at', 'timestamptz')
    .execute()
  await sql`update proposal set first_indexed_at = indexed_at`.execute(db)

  await db.schema
    .createTable('intervention')
    .addColumn('uri', 'text', (c) => c.primaryKey())
    .addColumn('cid', 'text', (c) => c.notNull())
    .addColumn('community_did', 'text', (c) => c.notNull())
    .addColumn('action', 'text', (c) => c.notNull())
    .addColumn('subject_did', 'text')
    .addColumn('reason', 'text', (c) => c.notNull())
    .addColumn('sysadmin_did', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('indexed_at', 'timestamptz', (c) => c.notNull())
    .execute()
  await db.schema.createIndex('intervention_community_idx').on('intervention').columns(['community_did', 'indexed_at']).execute()

  await db.schema
    .createTable('request_denial')
    .addColumn('uri', 'text', (c) => c.primaryKey())
    .addColumn('cid', 'text', (c) => c.notNull())
    .addColumn('owner_did', 'text', (c) => c.notNull())
    .addColumn('request_uri', 'text', (c) => c.notNull())
    .addColumn('reason', 'text', (c) => c.notNull())
    .addColumn('sysadmin_did', 'text', (c) => c.notNull())
    .addColumn('indexed_at', 'timestamptz', (c) => c.notNull())
    .execute()
  await db.schema.createIndex('request_denial_request_idx').on('request_denial').column('request_uri').execute()

  // Owned by the community service.
  await db.schema
    .alterTable('community_credential')
    .addColumn('kind', 'text', (c) => c.notNull().defaultTo('community'))
    .execute()
  await db.schema
    .createTable('proposal_execution')
    .addColumn('proposal_uri', 'text', (c) => c.primaryKey())
    .addColumn('community_did', 'text', (c) => c.notNull())
    .addColumn('result_uri', 'text')
    .addColumn('error', 'text')
    .addColumn('executed_at', 'timestamptz')
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('proposal_execution').execute()
  await db.schema.alterTable('community_credential').dropColumn('kind').execute()
  await db.schema.dropTable('request_denial').execute()
  await db.schema.dropTable('intervention').execute()
  await db.schema.alterTable('proposal').dropColumn('electorate').dropColumn('problems').dropColumn('first_indexed_at').execute()
}
