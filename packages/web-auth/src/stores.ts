import type { NodeSavedSession, NodeSavedSessionStore, NodeSavedState, NodeSavedStateStore } from '@atproto/oauth-client-node'
import { type Database, json } from '@speedrunledger/db'

/** OAuth state and session stores in Postgres, so sessions survive restarts and replicas share them. */
export function createStores(db: Database): { stateStore: NodeSavedStateStore; sessionStore: NodeSavedSessionStore } {
  return {
    stateStore: {
      async get(key) {
        const row = await db.selectFrom('oauth_state').select('value').where('key', '=', key).executeTakeFirst()
        return row?.value as NodeSavedState | undefined
      },
      async set(key, value) {
        const row = { key, value: json(value), created_at: new Date() }
        await db.insertInto('oauth_state').values(row).onConflict((oc) => oc.column('key').doUpdateSet(row)).execute()
      },
      async del(key) {
        await db.deleteFrom('oauth_state').where('key', '=', key).execute()
      },
    },
    sessionStore: {
      async get(key) {
        const row = await db.selectFrom('oauth_session').select('value').where('key', '=', key).executeTakeFirst()
        return row?.value as NodeSavedSession | undefined
      },
      async set(key, value) {
        const row = { key, value: json(value), updated_at: new Date() }
        await db.insertInto('oauth_session').values(row).onConflict((oc) => oc.column('key').doUpdateSet(row)).execute()
      },
      async del(key) {
        await db.deleteFrom('oauth_session').where('key', '=', key).execute()
      },
    },
  }
}
