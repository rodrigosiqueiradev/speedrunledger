import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AppViewServer } from '@speedrunledger/appview'
import { CommunityServiceServer } from '@speedrunledger/community-service'
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
  type TestAccount,
  type TestCommunity,
  waitFor,
  type WrittenRecord,
} from '@speedrunledger/testkit'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LedgerAdmin } from '../src/index.js'

// The rest of ledger-admin: adding sysadmins, registering existing community
// accounts, adding games, appointing moderators, and running the community
// service's jobs on demand, against a real indexer, AppView and community
// service on the local PDS.

const ADMIN_TOKEN = 'cli-more-test-token'
const SERVICE_DID = 'did:web:localhost%3A2586'
const NS = 'app.speedrunledger-prototype'
let env: DevEnv
let indexer: IndexerService
let appview: AppViewServer
let service: CommunityServiceServer
let dropDb: () => Promise<void>
let sysadmin: TestAccount
let community: TestCommunity
let videos: Server
let videoBase: string

/** Runs one command and returns what it printed. */
async function cli(argv: string[], as?: string) {
  const lines: string[] = []
  const tool = new LedgerAdmin(
    {
      communityServiceUrl: service.url,
      adminToken: ADMIN_TOKEN,
      sysadmin: as,
      appviewUrl: appview.url,
      pdsUrl: env.pdsUrl,
      plcUrl: env.plcUrl,
    },
    (line) => lines.push(line),
  )
  await tool.run(argv)
  return lines.join('\n')
}

const json = async (argv: string[], as?: string) => JSON.parse(await cli([...argv, '--json'], as))

const db = () => indexer.indexer.db

const activeModerators = async (did: string) =>
  (await db().selectFrom('community_member').select('member_did').where('community_did', '=', did).where('active', '=', true).execute()).map(
    (r) => r.member_did,
  )

const xrpc = async (nsid: string, params: Record<string, string>) => {
  const res = await fetch(new URL(`/xrpc/${nsid}?${new URLSearchParams(params)}`, appview.url))
  return (await res.json()) as any
}

/** Calls a community service procedure as a moderator, with a service-auth JWT from their PDS. */
async function callAs(as: TestAccount, nsid: string, body: unknown) {
  const { data } = await as.agent.com.atproto.server.getServiceAuth({ aud: SERVICE_DID, lxm: nsid })
  const res = await fetch(`${service.url}/xrpc/${nsid}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${data.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as any }
}

/** Submits a run and has a moderator verify it, waiting until it is ranked. */
async function rankedRun(runner: TestAccount, overrides: Record<string, unknown>) {
  const run = await putRecord(runner, ids.run, runRecord(community.categories.sixteenStar, overrides))
  await waitFor(() => db().selectFrom('run').select('uri').where('uri', '=', run.uri).executeTakeFirst())
  const verdict = await callAs(community.moderators[0].account, `${NS}.moderation.createVerdict`, { run, status: 'verified' })
  expect(verdict.status).toBe(200)
  await waitFor(() => db().selectFrom('board_entry').select('run_uri').where('run_uri', '=', run.uri).executeTakeFirst())
  return run
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
  service = new CommunityServiceServer(
    {
      port: 0,
      databaseUrl: database.url,
      serviceDid: SERVICE_DID,
      secretKey: randomBytes(32),
      adminToken: ADMIN_TOKEN,
      plcUrl: env.plcUrl,
      pdsUrl: env.pdsUrl,
      executorIntervalMs: 0,
      videoCheckIntervalMs: 0,
      devMode: true,
    },
    pino({ level: 'silent' }),
  )
  await service.start()
  sysadmin = await createAccount(env, 'sys')
  await cli(['platform', 'init', '--handle', `plat${Date.now() % 1e6}.test`, '--sysadmin', sysadmin.did])
  community = await setupCommunity(env, { moderators: 2 })

  // A video host for the runs: /ok plays, anything else was deleted.
  videos = createServer((req, res) => res.writeHead(req.url === '/ok' ? 200 : 404).end())
  await new Promise<void>((resolve) => videos.listen(0, '127.0.0.1', resolve))
  videoBase = `http://127.0.0.1:${(videos.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  if (videos) await new Promise((resolve) => videos.close(resolve))
  await service?.destroy()
  await appview?.destroy()
  await indexer?.destroy()
  await dropDb?.()
})

describe('ledger-admin', () => {
  it('adds a sysadmin by handle', async () => {
    const second = await createAccount(env, 'sys')
    expect(await cli(['sysadmin', 'add', second.handle], sysadmin.handle)).toBe(`${second.did} is now a sysadmin`)
    expect(await json(['sysadmin', 'list'])).toEqual(expect.arrayContaining([sysadmin.did, second.did]))
    // The new sysadmin can act straight away.
    const third = await createAccount(env, 'sys')
    await cli(['sysadmin', 'add', third.did], second.did)
    expect(await json(['sysadmin', 'list'])).toContain(third.did)
  })

  it('registers an existing community account with the community service', async () => {
    const out = await cli(['community', 'register', '--identifier', community.account.handle, '--password', community.account.password])
    expect(out).toBe(`the community service now writes for ${community.account.handle} (${community.account.did})`)
    const listed = await waitFor(async () => {
      const text = await cli(['community', 'list'])
      return text.includes(`${community.account.did}  Super Mario 64: Super Mario 64`) ? text : undefined
    })
    expect(listed).toContain(community.account.did)
    await expect(cli(['community', 'register', '--identifier', community.account.handle, '--password', 'wrong-password'])).rejects.toThrow()
  })

  it('adds a game to a community', async () => {
    const out = await json(
      ['community', 'add-game', community.account.handle, '--game', 'Super Mario 64 DS', '--year', '2004', '--platform', 'DS', '--platform', 'Wii U VC'],
      sysadmin.did,
    )
    expect(out.uri).toMatch(new RegExp(`^at://${community.account.did}/${ids.game}/`))
    const game = await waitFor(() => db().selectFrom('game').selectAll().where('uri', '=', out.uri).executeTakeFirst())
    expect(game).toMatchObject({ title: 'Super Mario 64 DS', release_year: 2004, platforms: ['DS', 'Wii U VC'] })
    await waitFor(async () => ((await cli(['community', 'list'])).includes('Super Mario 64, Super Mario 64 DS') ? true : undefined))

    const outsider = await createAccount(env, 'x')
    await expect(cli(['community', 'add-game', community.account.did, '--game', 'Nope'], outsider.did)).rejects.toThrow(/NotSysadmin/)
    await expect(cli(['community', 'add-game', community.account.did], sysadmin.did)).rejects.toThrow(/--game is required/)
  })

  it('appoints a moderator only in a community with none active', async () => {
    const absent = await createAccount(env, 'ab')
    const created = await json(
      ['community', 'create', '--handle', `cel${Date.now() % 1e6}.test`, '--name', 'Celeste', '--game', 'Celeste', '--founder', absent.handle],
      sysadmin.did,
    )
    // The founder never accepts, so nobody is active.
    const appointee = await createAccount(env, 'ap')
    const out = await cli(['community', 'appoint', created.handle, appointee.handle, '--reason', 'The founder never accepted'], sysadmin.did)
    expect(out).toContain(`appointed ${appointee.did}; they become a moderator once they accept`)
    const intervention = out.match(/intervention: (\S+)/)![1]
    const row = await waitFor(() => db().selectFrom('intervention').selectAll().where('uri', '=', intervention).executeTakeFirst())
    expect(row).toMatchObject({ community_did: created.did, action: 'appoint', sysadmin_did: sysadmin.did })

    const grant = await waitFor(() =>
      db().selectFrom('community_member').select(['uri', 'cid', 'via_uri']).where('member_did', '=', appointee.did).executeTakeFirst(),
    )
    expect(grant.via_uri).toBe(intervention)
    await putRecord(appointee, ids.communityMemberAccept, { member: { uri: grant.uri, cid: grant.cid }, createdAt: now() })
    await waitFor(async () => ((await activeModerators(created.did)).includes(appointee.did) ? true : undefined))

    // Now it has one, so moderators invite the rest by vote.
    const another = await createAccount(env, 'ap')
    await expect(cli(['community', 'appoint', created.did, another.did, '--reason', 'More help'], sysadmin.did)).rejects.toThrow(/HasModerators/)
    await expect(cli(['community', 'appoint', created.did, another.did], sysadmin.did)).rejects.toThrow(/--reason is required/)
  })

  it('carries out passed proposals on demand', async () => {
    const [a, b] = community.moderators.map((m) => m.account)
    await waitFor(async () => ((await activeModerators(community.account.did)).length === 2 ? true : undefined))
    const invitee = await createAccount(env, 'inv')
    const proposal: WrittenRecord = await putRecord(a, ids.communityProposal, {
      community: community.account.did,
      action: { $type: `${ids.communityProposal}#invite`, subject: invitee.did },
      reason: 'Helps with the Discord',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      createdAt: now(),
    })
    await putRecord(b, ids.communityVote, { proposal, value: 'yes', createdAt: now() })
    await waitFor(async () => ((await xrpc(`${NS}.getProposal`, { uri: proposal.uri })).proposal?.status === 'passed' ? true : undefined))

    expect(await cli(['proposals', 'execute'])).toBe('carried out 1 proposal(s)')
    const grant = await waitFor(() =>
      db().selectFrom('community_member').select('via_uri').where('member_did', '=', invitee.did).executeTakeFirst(),
    )
    expect(grant.via_uri).toBe(proposal.uri)
    expect(await json(['proposals', 'execute'])).toEqual({ executed: 0 })
    await waitFor(async () => ((await xrpc(`${NS}.getProposal`, { uri: proposal.uri })).proposal.executed ? true : undefined))
  })

  it('posts new world records on demand', async () => {
    const runner = await createAccount(env, 'wr')
    await rankedRun(runner, { times: { realTimeMs: 15 * 60_000 }, videos: [{ url: `${videoBase}/ok` }] })
    expect(await cli(['announcements', 'run'])).toBe('posted 1 world record(s)')
    const row = await waitFor(() => db().selectFrom('announcement').selectAll().where('post_uri', 'is not', null).executeTakeFirst())
    expect(row.post_uri).toMatch(new RegExp(`^at://${community.account.did}/app.bsky.feed.post/`))
    expect(await json(['announcements', 'run'])).toEqual({ posted: 0 })
  }, 60_000)

  it('checks video links on demand', async () => {
    const runner = await createAccount(env, 'vd')
    const run = await rankedRun(runner, { times: { realTimeMs: 16 * 60_000 }, videos: [{ url: `${videoBase}/ok` }, { url: `${videoBase}/gone` }] })
    // The world-record run's one link, and this run's two.
    expect(await cli(['videos', 'check'])).toBe('checked 3 link(s), 1 dead')
    expect((await xrpc(`${NS}.getRun`, { uri: run.uri })).run.deadVideos).toEqual([`${videoBase}/gone`])
    expect(await json(['videos', 'check'])).toEqual({ checked: 3, dead: 1 })
  }, 60_000)
})
