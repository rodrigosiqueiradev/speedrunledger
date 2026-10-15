import { ids } from '@speedrunledger/lexicon'
import {
  assertStackUp,
  createAccount,
  deleteRecord,
  type DevEnv,
  loadDevEnv,
  now,
  putRecord,
  runRecord,
  setupCommunity,
  waitFor,
} from '@speedrunledger/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IndexerService } from '../src/index.js'
import { startIndexer as start } from './helpers.js'

// Integration tests: a real PDS and PLC directory under Podman (`pnpm infra:up`).

let env: DevEnv
const cleanups: (() => Promise<void>)[] = []

async function startIndexer(opts: { backfill?: boolean } = {}): Promise<IndexerService> {
  const { service, stop } = await start(env, opts)
  cleanups.push(stop)
  return service
}

beforeAll(async () => {
  env = loadDevEnv()
  await assertStackUp(env)
})

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
})

describe('indexer', () => {
  it('backfills records written before it started', async () => {
    const community = await setupCommunity(env)
    const runner = await createAccount(env, 'runner')
    const run = await putRecord(runner, ids.run, runRecord(community.categories.sixteenStar))

    const service = await startIndexer()
    const { db } = service

    const row = await db.selectFrom('run').selectAll().where('uri', '=', run.uri).executeTakeFirstOrThrow()
    expect(row.cid).toBe(run.cid)
    expect(row.runner_did).toBe(runner.did)
    expect(row.community_did).toBe(community.account.did)
    expect(row.real_time_ms).toBe(902_340)
    expect(row.variables).toEqual({ platform: 'N64' })
    expect(row.problems).toEqual([])

    const communityRow = await db.selectFrom('community').selectAll().where('did', '=', community.account.did).executeTakeFirstOrThrow()
    expect(communityRow.name).toBe('Super Mario 64')
    const categories = await db.selectFrom('category').select('name').where('community_did', '=', community.account.did).orderBy('name').execute()
    expect(categories.map((c) => c.name)).toEqual(['16 Star', '70 Star'])

    const membership = await db.selectFrom('community_member').selectAll().where('uri', '=', community.moderators[0].grant.uri).executeTakeFirstOrThrow()
    expect(membership.active).toBe(true)
    expect(membership.accept_uri).toBe(community.moderators[0].accept.uri)

    const actor = await db.selectFrom('actor').selectAll().where('did', '=', runner.did).executeTakeFirstOrThrow()
    expect(actor.handle).toBe(runner.handle)
  })

  describe('live stream', () => {
    let service: IndexerService

    beforeAll(async () => {
      service = await startIndexer({ backfill: false })
    })

    const findRun = (uri: string) => service.db.selectFrom('run').selectAll().where('uri', '=', uri).executeTakeFirst()

    it('indexes runs and verdicts as they are written', async () => {
      const community = await setupCommunity(env)
      const [mod] = community.moderators
      const runner = await createAccount(env, 'runner')
      const run = await putRecord(runner, ids.run, runRecord(community.categories.seventyStar))

      // The run and its category live in different repos, so either can be indexed first.
      await waitFor(
        async () => {
          const row = await findRun(run.uri)
          return row?.problems.length === 0 ? row : undefined
        },
        { message: 'run to be indexed with no problems' },
      )

      await waitFor(
        () =>
          service.db
            .selectFrom('community_member')
            .select('active')
            .where('uri', '=', mod.grant.uri)
            .where('active', '=', true)
            .executeTakeFirst(),
        { message: 'membership to become active' },
      )

      const verdict = await putRecord(community.account, ids.verification, {
        subject: run,
        status: 'verified',
        reviewer: mod.account.did,
        verifiedTimes: { realTimeMs: 902_300 },
        createdAt: now(),
      })
      const verdictRow = await waitFor(
        () => service.db.selectFrom('verification').selectAll().where('uri', '=', verdict.uri).executeTakeFirst(),
        { message: 'verdict to be indexed' },
      )
      expect(verdictRow.subject_cid).toBe(run.cid)
      expect(verdictRow.reviewer_active).toBe(true)
      expect(verdictRow.verified_real_time_ms).toBe(902_300)
    })

    it('flags a verdict from someone who is not a moderator', async () => {
      const community = await setupCommunity(env, { moderators: 0 })
      const outsider = await createAccount(env, 'out')
      const runner = await createAccount(env, 'runner')
      const run = await putRecord(runner, ids.run, runRecord(community.categories.sixteenStar))
      // A grant the outsider never accepted does not make them a moderator.
      await putRecord(community.account, ids.communityMember, { subject: outsider.did, createdAt: now() })
      const verdict = await putRecord(community.account, ids.verification, {
        subject: run,
        status: 'verified',
        reviewer: outsider.did,
        createdAt: now(),
      })
      const verdictRow = await waitFor(
        () => service.db.selectFrom('verification').selectAll().where('uri', '=', verdict.uri).executeTakeFirst(),
        { message: 'verdict to be indexed' },
      )
      expect(verdictRow.reviewer_active).toBe(false)
    })

    it('tracks edits by CID and removes deleted runs', async () => {
      const community = await setupCommunity(env, { moderators: 0 })
      const runner = await createAccount(env, 'runner')
      const run = await putRecord(runner, ids.run, runRecord(community.categories.sixteenStar))
      const first = await waitFor(() => findRun(run.uri), { message: 'run to be indexed' })

      const rkey = run.uri.split('/').pop()!
      const edited = await putRecord(
        runner,
        ids.run,
        runRecord(community.categories.sixteenStar, { comment: 'added a mirror', times: { realTimeMs: 900_000 } }),
        { rkey },
      )
      const second = await waitFor(
        async () => {
          const row = await findRun(run.uri)
          return row?.cid === edited.cid ? row : undefined
        },
        { message: 'edit to be indexed' },
      )
      expect(second.real_time_ms).toBe(900_000)
      expect(second.first_indexed_at).toEqual(first.first_indexed_at)
      expect(second.indexed_at.getTime()).toBeGreaterThan(first.indexed_at.getTime())

      await deleteRecord(runner, run.uri)
      await waitFor(async () => ((await findRun(run.uri)) ? undefined : true), { message: 'delete to be indexed' })
    })

    it('marks a run whose category does not exist yet, and clears it once the category appears', async () => {
      const community = await setupCommunity(env, { moderators: 0 })
      const runner = await createAccount(env, 'runner')
      // The runner points at a category rkey the community has not written yet.
      const futureRkey = '3mzzzzzzzzz2a'
      const futureCategory = {
        uri: `at://${community.account.did}/${ids.category}/${futureRkey}`,
        cid: community.categories.sixteenStar.cid,
      }
      const run = await putRecord(runner, ids.run, runRecord(futureCategory))
      const row = await waitFor(() => findRun(run.uri), { message: 'run to be indexed' })
      expect(row.problems).toEqual(['category_not_found'])

      await putRecord(
        community.account,
        ids.category,
        { game: community.game, name: 'Any%', kind: 'time', sort: 'asc', primaryTiming: 'realTime', createdAt: now() },
        { rkey: futureRkey },
      )
      // The new category has no "platform" variable, so the run's value is now unknown.
      const rechecked = await waitFor(
        async () => {
          const r = await findRun(run.uri)
          return r && r.problems[0] !== 'category_not_found' ? r : undefined
        },
        { message: 'run to be rechecked' },
      )
      expect(rechecked.problems).toEqual(['unknown_variable:platform'])
    })

    it('does not store records that break their lexicon or point at the wrong repo', async () => {
      const community = await setupCommunity(env, { moderators: 0 })
      const runner = await createAccount(env, 'runner')
      const broken = await putRecord(runner, ids.run, { category: community.categories.sixteenStar, createdAt: now() }, { validate: false })
      // A category must belong to a game in the same community repo.
      const otherCommunity = await setupCommunity(env, { moderators: 0 })
      const stolen = await putRecord(community.account, ids.category, {
        game: otherCommunity.game,
        name: 'Stolen',
        kind: 'time',
        sort: 'asc',
        primaryTiming: 'realTime',
        createdAt: now(),
      })
      // A marker written afterwards to the same repo tells us the earlier events were processed.
      const marker = await putRecord(runner, ids.run, runRecord(community.categories.sixteenStar))
      await waitFor(() => findRun(marker.uri), { message: 'marker run' })
      const otherMarker = await putRecord(community.account, ids.game, { title: 'Marker', createdAt: now() })
      await waitFor(
        () => service.db.selectFrom('game').select('uri').where('uri', '=', otherMarker.uri).executeTakeFirst(),
        { message: 'marker game' },
      )

      expect(await findRun(broken.uri)).toBeUndefined()
      expect(
        await service.db.selectFrom('category').select('uri').where('uri', '=', stolen.uri).executeTakeFirst(),
      ).toBeUndefined()
      expect(await service.db.selectFrom('record').select('uri').where('uri', 'in', [broken.uri, stolen.uri]).execute()).toEqual([])
    })

    it('stores the cursor so a restart resumes where it stopped', async () => {
      const cursor = await waitFor(() => service.getCursor(), { message: 'cursor to be saved' })
      expect(cursor).toBeGreaterThan(0)
    })
  })
})
