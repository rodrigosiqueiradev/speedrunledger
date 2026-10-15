import type { Kysely } from 'kysely'

/** A category's description, which the category record has always carried but the index dropped. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('category').addColumn('description', 'text').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('category').dropColumn('description').execute()
}
