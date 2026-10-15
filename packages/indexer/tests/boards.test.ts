import { boardKey } from '@speedrunledger/db'
import { ids } from '@speedrunledger/lexicon'
import {
  assertStackUp,
  createAccount,
  type DevEnv,
  loadDevEnv,
  now,
  putRecord,
  runRecord,
  setupCommunity,
  type TestAccount,
  type TestCommunity,
  waitFor,
  type WrittenRecord,
} from '@speedrunledger/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IndexerService } from '../src/index.js'
import { startIndexer } from './helpers.js'

// Leaderboards computed by the indexer, against the real local PDS.

let env: DevEnv
let service: IndexerService
let stop: () => Promise<void>

beforeAll(async () => {
  env = loadDevEnv()
  await assertStackUp(env)
  ;({ service, stop } = await startIndexer(env, { backfill: false }))
})

afterAll(async () => {
  await stop?.()
})

const verify = (community: TestCommunity, run: WrittenRecord, extra: Record<string, unknown> = {}, reviewer?: string) =>
  putRecord(community.account, ids.verification, {
    subject: run,
    status: 'verified',
    reviewer: reviewer ?? community.moderators[0].account.did,
    createdAt: now(),
    ...extra,
  })

const board = (categoryUri: string, subcategory: Record<string, string> = {}) =>
  service.db
    .selectFrom('board_entry')
    .selectAll()
    .where('board_key', '=', boardKey(categoryUri, subcategory))
    .orderBy('rank')
    .orderBy('indexed_at')
    .execute()

/**
 * Boards are rebuilt just after a record's own row commits, so poll until the
 * board matches (or the timeout passes) before asserting.
 */
const settledBoard = async <T>(categoryUri: string, pick: (e: Awaited<ReturnType<typeof board>>[number]) => T, expected: T[], subcategory: Record<string, string> = {}) => {
  let last: T[] = []
  await waitFor(async () => {
    last = (await board(categoryUri, subcategory)).map(pick)
    return JSON.stringify(last) === JSON.stringify(expected) ? true : undefined
  }).catch(() => undefined)
  expect(last).toEqual(expected)
}

/** Waits until a written record has been indexed, so later assertions see its effects. */
const indexed = (record: WrittenRecord) =>
  waitFor(() => service.db.selectFrom('record').select('uri').where('uri', '=', record.uri).where('cid', '=', record.cid).executeTakeFirst(), {
    message: `${record.uri} to be indexed`,
  })

const submit = async (runner: TestAccount, category: WrittenRecord, ms: number, overrides: Record<string, unknown> = {}) => {
  const run = await putRecord(runner, ids.run, runRecord(category, { times: { realTimeMs: ms }, ...overrides }))
  await indexed(run)
  return run
}

const activeMods = (community: TestCommunity) =>
  Promise.all(
    community.moderators.map((m) =>
      waitFor(() =>
        service.db.selectFrom('community_member').select('uri').where('uri', '=', m.grant.uri).where('active', '=', true).executeTakeFirst(),
      ),
    ),
  )

describe('leaderboards', () => {
  it('ranks verified runs, keeps each runner’s best, and shares ranks on ties', async () => {
    const community = await setupCommunity(env)
    await activeMods(community)
    const category = community.categories.sixteenStar
    const [alice, bob, carol, dave] = await Promise.all(['alice', 'bob', 'carol', 'dave'].map((p) => createAccount(env, p)))

    const aliceSlow = await submit(alice, category, 960_000)
    const aliceFast = await submit(alice, category, 900_000)
    const bobRun = await submit(bob, category, 930_000)
    const carolRun = await submit(carol, category, 930_000)
    await submit(dave, category, 800_000) // never reviewed

    for (const run of [aliceSlow, aliceFast, bobRun, carolRun]) await indexed(await verify(community, run))

    await settledBoard(category.uri, (e) => [e.rank, e.runner_did, e.ranked_ms, e.run_uri], [
      [1, alice.did, 900_000, aliceFast.uri],
      [2, bob.did, 930_000, bobRun.uri],
      [2, carol.did, 930_000, carolRun.uri],
    ])
  })

  it('uses a moderator’s retime and drops a run that is edited after verification', async () => {
    const community = await setupCommunity(env)
    await activeMods(community)
    const category = community.categories.seventyStar
    const runner = await createAccount(env, 'erin')
    const run = await submit(runner, category, 3_000_000)

    await indexed(await verify(community, run, { verifiedTimes: { realTimeMs: 2_999_500 } }))
    await settledBoard(category.uri, (e) => e.ranked_ms, [2_999_500])

    const rkey = run.uri.split('/').pop()!
    const edited = await putRecord(runner, ids.run, runRecord(category, { times: { realTimeMs: 2_000_000 } }), { rkey })
    await indexed(edited)
    await settledBoard(category.uri, (e) => e.run_uri, [])
  })

  it('ignores rejected runs and verdicts from non-moderators, and hides banned runners', async () => {
    const community = await setupCommunity(env)
    await activeMods(community)
    const category = community.categories.sixteenStar
    const [frank, gina, hank] = await Promise.all(['frank', 'gina', 'hank'].map((p) => createAccount(env, p)))
    const outsider = await createAccount(env, 'out')

    const rejected = await submit(frank, category, 910_000)
    await indexed(await verify(community, rejected, { status: 'rejected', reason: 'Video cuts out' }))
    const byOutsider = await submit(gina, category, 905_000)
    await indexed(await verify(community, byOutsider, {}, outsider.did))
    const hankRun = await submit(hank, category, 920_000)
    await indexed(await verify(community, hankRun))
    await settledBoard(category.uri, (e) => e.runner_did, [hank.did])

    const ban = await putRecord(community.account, ids.communityBan, {
      subject: hank.did,
      reason: 'Spliced video',
      moderator: community.moderators[0].account.did,
      createdAt: now(),
    })
    await indexed(ban)
    await settledBoard(category.uri, (e) => e.runner_did, [])
  })

  it('splits boards by subcategory variables', async () => {
    const community = await setupCommunity(env)
    await activeMods(community)
    const category = await putRecord(community.account, ids.category, {
      game: community.game,
      name: '120 Star',
      kind: 'time',
      sort: 'asc',
      primaryTiming: 'realTime',
      variables: [{ id: 'version', name: 'Version', values: ['JP', 'US'], subcategory: true }],
      createdAt: now(),
    })
    await indexed(category)
    const [ivy, jack] = await Promise.all(['ivy', 'jack'].map((p) => createAccount(env, p)))
    const jp = await submit(ivy, category, 6_000_000, { variables: [{ variable: 'version', value: 'JP' }] })
    const us = await submit(jack, category, 6_100_000, { variables: [{ variable: 'version', value: 'US' }] })
    await indexed(await verify(community, jp))
    await indexed(await verify(community, us))

    await settledBoard(category.uri, (e) => e.runner_did, [ivy.did], { version: 'JP' })
    await settledBoard(category.uri, (e) => e.runner_did, [jack.did], { version: 'US' })
  })

  it('needs as many distinct approvals as the category requires', async () => {
    const community = await setupCommunity(env, { moderators: 2 })
    await activeMods(community)
    const category = await putRecord(community.account, ids.category, {
      game: community.game,
      name: '0 Star',
      kind: 'time',
      sort: 'asc',
      primaryTiming: 'realTime',
      requiredApprovals: 2,
      createdAt: now(),
    })
    await indexed(category)
    const runner = await createAccount(env, 'kim')
    const run = await submit(runner, category, 420_000, { variables: [] })
    await indexed(await verify(community, run))
    await settledBoard(category.uri, (e) => e.runner_did, [])
    await indexed(await verify(community, run, {}, community.moderators[1].account.did))
    await settledBoard(category.uri, (e) => e.runner_did, [runner.did])
  })
})

describe('world records', () => {
  it('records each new first place that beats the old one, and nothing else', async () => {
    const community = await setupCommunity(env)
    await activeMods(community)
    const category = community.categories.sixteenStar
    const [ann, ben] = await Promise.all(['ann', 'ben'].map((p) => createAccount(env, p)))
    const records = () =>
      service.db
        .selectFrom('world_record')
        .select(['run_uri', 'runner_did', 'ranked_ms', 'previous_runner_did', 'quiet'])
        .where('category_uri', '=', category.uri)
        .orderBy('id')
        .execute()

    const first = await submit(ann, category, 950_000)
    await indexed(await verify(community, first))
    await settledBoard(category.uri, (e) => e.run_uri, [first.uri])

    // Slower runs and ties don't take first place.
    const slower = await submit(ben, category, 960_000)
    await indexed(await verify(community, slower))
    await settledBoard(category.uri, (e) => e.run_uri, [first.uri, slower.uri])

    const faster = await submit(ben, category, 940_000)
    await indexed(await verify(community, faster))
    await settledBoard(category.uri, (e) => e.run_uri, [faster.uri, first.uri])

    expect(await records()).toEqual([
      { run_uri: first.uri, runner_did: ann.did, ranked_ms: 950_000, previous_runner_did: null, quiet: false },
      { run_uri: faster.uri, runner_did: ben.did, ranked_ms: 940_000, previous_runner_did: ann.did, quiet: false },
    ])

    // Losing first place to a ban doesn't make the next run a record.
    await indexed(
      await putRecord(community.account, ids.communityBan, {
        subject: ben.did,
        moderator: community.moderators[0].account.did,
        reason: 'Spliced',
        createdAt: now(),
      }),
    )
    await settledBoard(category.uri, (e) => e.run_uri, [first.uri])
    expect(await records()).toHaveLength(2)
  })
})
