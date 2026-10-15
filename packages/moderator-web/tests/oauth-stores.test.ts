import { createDb, type Database, migrateToLatest } from '@speedrunledger/db'
import { createTestDatabase, loadDevEnv } from '@speedrunledger/testkit'
import { createStores } from '@speedrunledger/web-auth'
import { afterAll, beforeAll, expect, it } from 'vitest'

// The Runner and Moderator apps share the OAuth tables and the client keys
// sessions by DID; each app must see only its own session (and its scopes).

let db: Database
let drop: () => Promise<void>

beforeAll(async () => {
  const test = await createTestDatabase(loadDevEnv())
  drop = test.drop
  db = createDb(test.url)
  await migrateToLatest(db)
})

afterAll(async () => {
  await db?.destroy()
  await drop?.()
})

it('keeps each app’s session for the same account apart', async () => {
  const runner = createStores(db, 'http://127.0.0.1:2585').sessionStore
  const moderator = createStores(db, 'http://127.0.0.1:2587').sessionStore
  const did = 'did:plc:samesamesamesamesame'
  await moderator.set(did, { scope: 'moderator' } as never)
  await runner.set(did, { scope: 'runner' } as never)
  expect(await moderator.get(did)).toEqual({ scope: 'moderator' })
  expect(await runner.get(did)).toEqual({ scope: 'runner' })
  await runner.del(did)
  expect(await runner.get(did)).toBeUndefined()
  expect(await moderator.get(did)).toEqual({ scope: 'moderator' })
})
