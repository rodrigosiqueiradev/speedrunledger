import type { Kysely } from 'kysely'

/**
 * The account a proposal is about: an invite's or kick's subject, or the
 * runner whose ban it lifts. A lifted ban's record is deleted, so the runner
 * is kept here from when the proposal was first indexed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('proposal').addColumn('subject_did', 'text').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('proposal').dropColumn('subject_did').execute()
}
