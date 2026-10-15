import { randomBytes } from 'node:crypto'
import { IndexerService, readConfig as readIndexerConfig } from '@speedrunledger/indexer'
import { assertStackUp, createTestDatabase, type DevEnv, loadDevEnv, type TestAccount } from '@speedrunledger/testkit'
import { pino } from 'pino'
import { CommunityServiceServer } from '../src/index.js'

export const SERVICE_DID = 'did:web:localhost%3A2586'
export const ADMIN_TOKEN = 'test-admin-token'

export interface Harness {
  env: DevEnv
  indexer: IndexerService
  server: CommunityServiceServer
  db: IndexerService['indexer']['db']
  stop: () => Promise<void>
}

/** An indexer and a community service (executor off; tests run it) on a fresh database. */
export async function startHarness(): Promise<Harness> {
  const env = loadDevEnv()
  await assertStackUp(env)
  const database = await createTestDatabase(env)
  const indexer = IndexerService.create(
    readIndexerConfig({ DATABASE_URL: database.url, PDS_URL: env.pdsUrl, PLC_URL: env.plcUrl, SKIP_BACKFILL: 'true' }),
    pino({ level: 'silent' }),
  )
  await indexer.migrate()
  await indexer.start()
  const server = new CommunityServiceServer(
    {
      port: 0,
      databaseUrl: database.url,
      serviceDid: SERVICE_DID,
      secretKey: randomBytes(32),
      adminToken: ADMIN_TOKEN,
      plcUrl: env.plcUrl,
      pdsUrl: env.pdsUrl,
      executorIntervalMs: 0,
      devMode: true,
    },
    pino({ level: process.env.LOG_LEVEL ?? 'silent' }),
  )
  await server.start()
  await new Promise((resolve) => setTimeout(resolve, 500))
  return {
    env,
    indexer,
    server,
    db: indexer.indexer.db,
    stop: async () => {
      await server.destroy()
      await indexer.destroy()
      await database.drop()
    },
  }
}

/** Calls a community service procedure as `as`, with a service-auth JWT their PDS signed. */
export async function callAs(
  server: CommunityServiceServer,
  as: TestAccount,
  nsid: string,
  body: unknown,
  opts: { aud?: string; lxm?: string } = {},
) {
  const { data } = await as.agent.com.atproto.server.getServiceAuth({ aud: opts.aud ?? SERVICE_DID, lxm: opts.lxm ?? nsid })
  const res = await fetch(`${server.url}/xrpc/${nsid}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${data.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as any }
}

/** Calls an admin endpoint the way ledger-admin does. */
export async function admin(server: CommunityServiceServer, method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as any }
}
