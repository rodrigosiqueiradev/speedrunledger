import { createTestDatabase, type DevEnv } from '@speedrunledger/testkit'
import { pino } from 'pino'
import { IndexerService, readConfig } from '../src/index.js'

/** Starts an indexer on a fresh database against the local stack; returns it with its cleanup. */
export async function startIndexer(
  env: DevEnv,
  opts: { backfill?: boolean } = {},
): Promise<{ service: IndexerService; stop: () => Promise<void> }> {
  const database = await createTestDatabase(env)
  const service = IndexerService.create(
    readConfig({
      DATABASE_URL: database.url,
      PDS_URL: env.pdsUrl,
      PLC_URL: env.plcUrl,
      SKIP_BACKFILL: opts.backfill === false ? 'true' : 'false',
    }),
    pino({ level: process.env.LOG_LEVEL ?? 'silent' }),
  )
  await service.migrate()
  await service.start()
  // Without backfill the stream starts live; wait until it is connected.
  if (opts.backfill === false) await new Promise((resolve) => setTimeout(resolve, 500))
  return {
    service,
    stop: async () => {
      await service.destroy()
      await database.drop()
    },
  }
}
