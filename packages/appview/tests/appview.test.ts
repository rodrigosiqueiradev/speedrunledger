import { IndexerService, readConfig as readIndexerConfig } from '@speedrunledger/indexer'
import { ids } from '@speedrunledger/lexicon'
import {
  assertStackUp,
  createAccount,
  createTestDatabase,
  type DevEnv,
  loadDevEnv,
  now,
  putRecord,
  runRecord,
  setupCommunity,
  type TestCommunity,
  waitFor,
} from '@speedrunledger/testkit'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppViewServer } from '../src/index.js'

// The AppView's XRPC queries over HTTP, fed by a real indexer following the local PDS.

let env: DevEnv
let indexer: IndexerService
let appview: AppViewServer
let dropDb: () => Promise<void>
let community: TestCommunity

const xrpc = async (nsid: string, params: Record<string, string | string[]>) => {
  const url = new URL(`/xrpc/${nsid}`, appview.url)
  for (const [k, v] of Object.entries(params)) for (const item of [v].flat()) url.searchParams.append(k, item)
  const res = await fetch(url)
  return { status: res.status, body: (await res.json()) as any }
}

beforeAll(async () => {
  env = loadDevEnv()
  await assertStackUp(env)
  const database = await createTestDatabase(env)
  dropDb = database.drop
  indexer = IndexerService.create(
    readIndexerConfig({ DATABASE_URL: database.url, PDS_URL: env.pdsUrl, PLC_URL: env.plcUrl, SKIP_BACKFILL: 'true' }),
    pino({ level: 'silent' }),
  )
  await indexer.migrate()
  await indexer.start()
  appview = new AppViewServer({ databaseUrl: database.url, port: 0 })
  await appview.start()
  await new Promise((resolve) => setTimeout(resolve, 500))
  community = await setupCommunity(env)
})

afterAll(async () => {
  await appview?.destroy()
  await indexer?.destroy()
  await dropDb?.()
})

describe('appview', () => {
  it('serves a community with its games and categories', async () => {
    const { body } = await waitFor(async () => {
      const res = await xrpc('app.speedrunledger-prototype.getCommunity', { community: community.account.did })
      return res.body.community?.games?.[0]?.categories?.length === 2 ? res : undefined
    })
    expect(body.community.community.name).toBe('Super Mario 64')
    expect(body.community.community.handle).toBe(community.account.handle)
    expect(body.community.games[0].game.title).toBe('Super Mario 64')
    expect(body.community.games[0].categories.map((c: any) => c.name).sort()).toEqual(['16 Star', '70 Star'])

    const list = await xrpc('app.speedrunledger-prototype.listCommunities', { limit: '100' })
    expect(list.body.communities.some((c: any) => c.community.did === community.account.did)).toBe(true)
  })

  it('serves a leaderboard, run statuses and a runner’s history', async () => {
    const category = community.categories.sixteenStar
    const runner = await createAccount(env, 'lb')
    const pending = await putRecord(runner, ids.run, runRecord(category, { times: { realTimeMs: 950_000 } }))
    const fast = await putRecord(runner, ids.run, runRecord(category, { times: { realTimeMs: 901_000 } }))
    await waitFor(async () => {
      const res = await xrpc('app.speedrunledger-prototype.getRun', { uri: fast.uri })
      return res.status === 200 && res.body.run.problems.length === 0 ? true : undefined
    })
    await putRecord(community.account, ids.verification, {
      subject: fast,
      status: 'verified',
      reviewer: community.moderators[0].account.did,
      verifiedTimes: { realTimeMs: 900_900 },
      createdAt: now(),
    })

    const board = await waitFor(async () => {
      const res = await xrpc('app.speedrunledger-prototype.getLeaderboard', { category: category.uri })
      return res.body.entries?.length === 1 ? res.body : undefined
    })
    expect(board.category.name).toBe('16 Star')
    expect(board.game.title).toBe('Super Mario 64')
    expect(board.entries[0]).toMatchObject({
      rank: 1,
      rankedMs: 900_900,
      run: { uri: fast.uri, status: 'verified', runner: { did: runner.did, handle: runner.handle }, rank: 1 },
    })
    expect(board.entries[0].run.verifiedTimes).toEqual({ realTimeMs: 900_900 })

    const run = await xrpc('app.speedrunledger-prototype.getRun', { uri: fast.uri })
    expect(run.body.run.verdicts).toHaveLength(1)
    expect(run.body.run.verdicts[0]).toMatchObject({ status: 'verified', current: true })

    const history = await xrpc('app.speedrunledger-prototype.getRunner', { actor: runner.handle })
    expect(history.body.runs.map((r: any) => [r.uri, r.status])).toEqual([
      [fast.uri, 'verified'],
      [pending.uri, 'pending'],
    ])
  })

  it('lists the review queue and a moderator’s memberships', async () => {
    const category = community.categories.seventyStar
    const runner = await createAccount(env, 'q')
    const first = await putRecord(runner, ids.run, runRecord(category, { times: { realTimeMs: 2_900_000 } }))
    const second = await putRecord(runner, ids.run, runRecord(category, { times: { realTimeMs: 2_800_000 } }))
    const broken = await putRecord(runner, ids.run, runRecord(category, { times: {} }))
    const queue = async () =>
      (await xrpc('app.speedrunledger-prototype.listReviewQueue', { community: community.account.did, category: category.uri }))
        .body.runs.map((item: any) => item.run.uri)
    // Oldest first; the run missing its primary time is not reviewable.
    await waitFor(async () => ((await queue()).length === 2 ? true : undefined))
    expect(await queue()).toEqual([first.uri, second.uri])
    expect(broken.uri).not.toBe(first.uri)

    const page = await xrpc('app.speedrunledger-prototype.listReviewQueue', {
      community: community.account.did,
      category: category.uri,
      limit: '1',
    })
    expect(page.body.runs[0]).toMatchObject({ approvals: 0, requiredApprovals: 1, category: { name: '70 Star' } })
    const next = await xrpc('app.speedrunledger-prototype.listReviewQueue', {
      community: community.account.did,
      category: category.uri,
      limit: '1',
      cursor: page.body.cursor,
    })
    expect(next.body.runs.map((item: any) => item.run.uri)).toEqual([second.uri])

    // A verdict takes a run out of the queue, whatever it says.
    await putRecord(community.account, ids.verification, {
      subject: first,
      status: 'changesRequested',
      reason: 'No timer visible',
      reviewer: community.moderators[0].account.did,
      createdAt: now(),
    })
    await waitFor(async () => ((await queue()).length === 1 ? true : undefined))
    expect(await queue()).toEqual([second.uri])

    const memberships = await xrpc('app.speedrunledger-prototype.listMemberships', {
      actor: community.moderators[0].account.did,
    })
    expect(memberships.body.memberships).toEqual([
      expect.objectContaining({ status: 'active', community: expect.objectContaining({ did: community.account.did }) }),
    ])
    const none = await xrpc('app.speedrunledger-prototype.listMemberships', { actor: runner.did })
    expect(none.body.memberships).toEqual([])
  })

  it('returns XRPC errors for unknown records and bad parameters', async () => {
    const missing = await xrpc('app.speedrunledger-prototype.getLeaderboard', {
      category: `at://${community.account.did}/${ids.category}/3mzzzzzzzzz2b`,
    })
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('NotFound')

    const bad = await xrpc('app.speedrunledger-prototype.getLeaderboard', {
      category: community.categories.sixteenStar.uri,
      variables: 'nonsense',
    })
    expect(bad.status).toBe(400)
  })
})
