import type { Event } from '@atproto/sync'
import { ids } from '@speedrunledger/lexicon'
import {
  assertStackUp,
  createAccount,
  createTestDatabase,
  type DevEnv,
  loadDevEnv,
  now,
  putRecord,
  waitFor,
} from '@speedrunledger/testkit'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IndexerService, readConfig } from '../src/index.js'

// Stopping the indexer while repo events are still waiting in its queue.

let env: DevEnv
let database: { url: string; drop: () => Promise<void> }
const running: IndexerService[] = []

const create = () => {
  const service = IndexerService.create(
    readConfig({ DATABASE_URL: database.url, PDS_URL: env.pdsUrl, PLC_URL: env.plcUrl, SKIP_BACKFILL: 'true' }),
    pino({ level: process.env.LOG_LEVEL ?? 'silent' }),
  )
  running.push(service)
  return service
}

/** Resolves with `fallback` if `promise` has not settled within `ms`. */
const within = <T, F>(promise: Promise<T>, ms: number, fallback: F) =>
  Promise.race([promise, new Promise<F>((resolve) => setTimeout(() => resolve(fallback), ms))])

beforeAll(async () => {
  env = loadDevEnv()
  await assertStackUp(env)
  database = await createTestDatabase(env)
})

afterAll(async () => {
  // A hung destroy must not hang the file; the database drop is forced anyway.
  for (const service of running) await within(service.destroy(), 5_000, undefined)
  await database?.drop()
})

describe('shutdown', () => {
  it('stops promptly with events still queued, and picks them up again on restart', async () => {
    const first = create()
    await first.migrate()
    await first.start()
    await new Promise((resolve) => setTimeout(resolve, 500))

    const runner = await createAccount(env, 'sd')
    await waitFor(() => first.db.selectFrom('actor').select('did').where('did', '=', runner.did).executeTakeFirst())

    // Hold the runner's first record event in the handler, so the next ones wait behind it.
    let entered!: () => void
    const handling = new Promise<void>((resolve) => (entered = resolve))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const handleEvent = first.handleEvent.bind(first)
    first.handleEvent = async (evt: Event) => {
      if (evt.did === runner.did && evt.event === 'create') {
        entered()
        await gate
      }
      return handleEvent(evt)
    }

    const game = (title: string) => putRecord(runner, ids.game, { title, platforms: ['PC'], createdAt: now() })
    const games = [await game('First'), await game('Second'), await game('Third')]
    await handling
    // Give the stream time to deliver the later events into the queue.
    await new Promise((resolve) => setTimeout(resolve, 1_000))

    const stopped = first.destroy().then(() => 'stopped' as const)
    setTimeout(release, 200)
    expect(await within(stopped, 10_000, 'hung' as const)).toBe('stopped')

    // The event being handled finished; the two queued behind it were skipped.
    const second = create()
    const gamesIndexed = () => second.db.selectFrom('game').select('uri').where('community_did', '=', runner.did).execute()
    expect((await gamesIndexed()).map((r) => r.uri)).toEqual([games[0].uri])

    // They were not counted as done: the next start replays them from the saved cursor.
    await second.start()
    const indexed = await waitFor(async () => {
      const rows = await gamesIndexed()
      return rows.length === games.length ? rows.map((r) => r.uri).sort() : undefined
    })
    expect(indexed).toEqual(games.map((g) => g.uri).sort())
    expect(await within(second.destroy().then(() => 'stopped' as const), 10_000, 'hung' as const)).toBe('stopped')
  }, 60_000)
})
