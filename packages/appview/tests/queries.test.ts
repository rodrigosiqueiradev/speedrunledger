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
  randomId,
  runRecord,
  setupCommunity,
  type TestAccount,
  type TestCommunity,
  waitFor,
  type WrittenRecord,
} from '@speedrunledger/testkit'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppViewServer, feedUriForGame } from '../src/index.js'

// Governance, moderation and reach queries of the AppView, and its feed
// generator, fed by a real indexer following the local PDS. Tables only the
// community service writes (announcements, video checks, its platform
// credential) are filled in directly.

const NS = 'app.speedrunledger-prototype'
const FEED_DID = 'did:web:feeds.speedrunledger.test'

let env: DevEnv
let indexer: IndexerService
let appview: AppViewServer
let dropDb: () => Promise<void>

const xrpc = async (nsid: string, params: Record<string, string | string[]> = {}) => {
  const url = new URL(`/xrpc/${nsid}`, appview.url)
  for (const [k, v] of Object.entries(params)) for (const item of [v].flat()) url.searchParams.append(k, item)
  const res = await fetch(url)
  return { status: res.status, body: (await res.json()) as any }
}

/** Polls a query until `ready` accepts its body. */
const until = (nsid: string, params: Record<string, string | string[]>, ready: (body: any) => boolean) =>
  waitFor(
    async () => {
      const res = await xrpc(nsid, params)
      return res.status === 200 && ready(res.body) ? res.body : undefined
    },
    { message: `${nsid} ${JSON.stringify(params)}` },
  )

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

const proposeInvite = (proposer: TestAccount, community: TestCommunity, subject: string, reason: string) =>
  putRecord(proposer, ids.communityProposal, {
    community: community.account.did,
    action: { $type: `${ids.communityProposal}#invite`, subject },
    reason,
    expiresAt: inDays(3),
    createdAt: now(),
  })

const vote = (voter: TestAccount, proposal: WrittenRecord, value: 'yes' | 'no', reason?: string) =>
  putRecord(voter, ids.communityVote, { proposal, value, ...(reason ? { reason } : {}), createdAt: now() })

/** Waits until the community's moderators are all active in the index. */
const moderatorsActive = (community: TestCommunity) =>
  until(`${NS}.listModerators`, { community: community.account.did }, (b) =>
    community.moderators.every((m) => b.moderators?.some((v: any) => v.actor.did === m.account.did && v.status === 'active')),
  )

/** Submits a run and verifies it from the community, waiting until it is ranked. */
async function verifiedRun(community: TestCommunity, runner: TestAccount, ms: number, overrides: Record<string, unknown> = {}) {
  const category = community.categories.sixteenStar
  const run = await putRecord(runner, ids.run, runRecord(category, { times: { realTimeMs: ms }, ...overrides }))
  await until(`${NS}.getRun`, { uri: run.uri }, (b) => b.run.problems.length === 0)
  await putRecord(community.account, ids.verification, {
    subject: run,
    status: 'verified',
    reviewer: community.moderators[0].account.did,
    createdAt: now(),
  })
  await until(`${NS}.getRun`, { uri: run.uri }, (b) => b.run.status === 'verified' && b.run.rank !== undefined)
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
  appview = new AppViewServer({ databaseUrl: database.url, port: 0, feedServiceDid: FEED_DID })
  await appview.start()
  await new Promise((resolve) => setTimeout(resolve, 500))
})

afterAll(async () => {
  await appview?.destroy()
  await indexer?.destroy()
  await dropDb?.()
})

describe('communities', () => {
  it('lists communities by name with their descriptions and games', async () => {
    const [x, y] = [await createAccount(env, 'ca'), await createAccount(env, 'cb')]
    await putRecord(x, ids.communityProfile, { name: 'Zz Celeste', description: 'Celeste runs', createdAt: now() }, { rkey: 'self' })
    await putRecord(y, ids.communityProfile, { name: 'Aa Celeste', createdAt: now() }, { rkey: 'self' })
    const game = await putRecord(y, ids.game, { title: 'Celeste', releaseYear: 2018, platforms: ['PC'], createdAt: now() })

    const mine = (body: any) => body.communities.filter((c: any) => [x.did, y.did].includes(c.community.did))
    const body = await until(`${NS}.listCommunities`, { limit: '100' }, (b) => mine(b).length === 2 && mine(b)[0].games.length === 1)
    expect(mine(body)).toEqual([
      {
        community: { did: y.did, handle: y.handle, name: 'Aa Celeste' },
        games: [{ game: { uri: game.uri, cid: game.cid, title: 'Celeste', releaseYear: 2018, platforms: ['PC'] }, categories: [] }],
      },
      { community: { did: x.did, handle: x.handle, name: 'Zz Celeste', description: 'Celeste runs' }, games: [] },
    ])

    const page = await xrpc(`${NS}.listCommunities`, { limit: '1' })
    expect(page.body.communities).toHaveLength(1)
    expect(page.body.cursor).toEqual(expect.any(String))
  })

  it('pages through every community exactly once when names and DIDs sort differently', async () => {
    // The first community by name has the larger DID, so paging by DID alone would skip the other.
    const [low, high] = [await createAccount(env, 'pa'), await createAccount(env, 'pb')].sort((a, b) => a.did.localeCompare(b.did))
    await putRecord(high, ids.communityProfile, { name: 'Aaa Paging', createdAt: now() }, { rkey: 'self' })
    await putRecord(low, ids.communityProfile, { name: 'Zzz Paging', createdAt: now() }, { rkey: 'self' })
    const listed = (b: any) => b.communities.map((c: any) => c.community.did)
    await until(`${NS}.listCommunities`, { limit: '100' }, (b) => listed(b).includes(low.did) && listed(b).includes(high.did))

    const walked: string[] = []
    let cursor: string | undefined
    do {
      const { status, body } = await xrpc(`${NS}.listCommunities`, { limit: '1', ...(cursor ? { cursor } : {}) })
      expect(status).toBe(200)
      walked.push(...listed(body))
      cursor = body.cursor
    } while (cursor && walked.length < 500)
    expect(walked.filter((did) => did === high.did)).toHaveLength(1)
    expect(walked.filter((did) => did === low.did)).toHaveLength(1)
    expect(walked.indexOf(high.did)).toBeLessThan(walked.indexOf(low.did))
    expect(new Set(walked).size).toBe(walked.length)

    const bad = await xrpc(`${NS}.listCommunities`, { cursor: 'not-a-cursor' })
    expect(bad).toMatchObject({ status: 400, body: { error: 'InvalidRequest' } })
  })
})

describe('moderators and proposals', () => {
  it('lists active and invited moderators with when each was last active', async () => {
    const community = await setupCommunity(env, { moderators: 2 })
    const [first, second] = community.moderators
    const invitee = await createAccount(env, 'inv')
    const invite = await putRecord(community.account, ids.communityMember, { subject: invitee.did, createdAt: now() })

    const { moderators } = await until(`${NS}.listModerators`, { community: community.account.did }, (b) =>
      // The invitee's handle comes from its own identity event, which can trail the grant.
      b.moderators?.length === 3 && b.moderators.filter((m: any) => m.status === 'active').length === 2 && b.moderators.every((m: any) => m.actor.handle),
    )
    // Oldest grant first.
    expect(moderators.map((m: any) => [m.actor.did, m.actor.handle, m.status, m.grant.uri])).toEqual([
      [first.account.did, first.account.handle, 'active', first.grant.uri],
      [second.account.did, second.account.handle, 'active', second.grant.uri],
      [invitee.did, invitee.handle, 'invited', invite.uri],
    ])
    expect(moderators.every((m: any) => m.lastActiveAt === undefined)).toBe(true)

    // A verdict counts as activity for its reviewer only.
    const runner = await createAccount(env, 'ma')
    const run = await putRecord(runner, ids.run, runRecord(community.categories.sixteenStar))
    await until(`${NS}.getRun`, { uri: run.uri }, () => true)
    await putRecord(community.account, ids.verification, {
      subject: run,
      status: 'rejected',
      reason: 'Wrong category',
      reviewer: second.account.did,
      createdAt: now(),
    })
    const after = await until(`${NS}.listModerators`, { community: community.account.did }, (b) =>
      b.moderators.some((m: any) => m.lastActiveAt),
    )
    expect(after.moderators.map((m: any) => [m.actor.did, typeof m.lastActiveAt])).toEqual([
      [first.account.did, 'undefined'],
      [second.account.did, 'string'],
      [invitee.did, 'undefined'],
    ])

    // The invitee sees the invitation among their notifications and memberships.
    const { body: notes } = await xrpc(`${NS}.listNotifications`, { actor: invitee.did })
    expect(notes.notifications).toEqual([
      expect.objectContaining({ reason: 'invited', subject: invite.uri, community: expect.objectContaining({ did: community.account.did }) }),
    ])
    const { body: memberships } = await xrpc(`${NS}.listMemberships`, { actor: invitee.handle })
    expect(memberships.memberships).toEqual([
      { community: expect.objectContaining({ did: community.account.did }), status: 'invited', grant: { uri: invite.uri, cid: invite.cid } },
    ])

    expect((await xrpc(`${NS}.listModerators`, { community: invitee.did })).status).toBe(404)
  })

  it('tallies a proposal’s votes until it passes, and asks the other moderators to vote', async () => {
    const community = await setupCommunity(env, { moderators: 3 })
    const [proposer, against, decider] = community.moderators.map((m) => m.account)
    await moderatorsActive(community)
    const candidate = await createAccount(env, 'cand')

    const proposal = await proposeInvite(proposer, community, candidate.did, 'Runs every category, knows the timing rules')
    const open = await until(`${NS}.getProposal`, { uri: proposal.uri }, () => true)
    expect(open.proposal).toMatchObject({
      uri: proposal.uri,
      cid: proposal.cid,
      community: community.account.did,
      proposer: { did: proposer.did, handle: proposer.handle },
      actionType: 'invite',
      action: { subject: candidate.did },
      reason: 'Runs every category, knows the timing rules',
      status: 'open',
      executed: false,
      electorateSize: 3,
      needed: 2,
      yes: 1,
      no: 0,
      problems: [],
    })
    expect(open.proposal.votes).toEqual([
      { voter: { did: proposer.did, handle: proposer.handle }, value: 'yes', indexedAt: open.proposal.indexedAt },
    ])
    expect(new Date(open.proposal.expiresAt).getTime()).toBeGreaterThan(Date.now())

    // Only the moderators who have not voted are asked to.
    const waiting = async (actor: TestAccount) =>
      (await xrpc(`${NS}.listNotifications`, { actor: actor.did })).body.notifications.filter((n: any) => n.reason === 'vote')
    expect(await waiting(against)).toEqual([
      expect.objectContaining({
        subject: proposal.uri,
        text: 'Runs every category, knows the timing rules',
        author: { did: proposer.did, handle: proposer.handle },
        community: expect.objectContaining({ did: community.account.did }),
      }),
    ])
    expect(await waiting(proposer)).toEqual([])

    const listed = async (status?: string) =>
      (await xrpc(`${NS}.listProposals`, { community: community.account.did, ...(status ? { status } : {}) })).body.proposals.map(
        (p: any) => p.uri,
      )
    expect(await listed('open')).toEqual([proposal.uri])
    expect(await listed('closed')).toEqual([])

    await vote(against, proposal, 'no', 'Not active enough yet')
    const contested = await until(`${NS}.getProposal`, { uri: proposal.uri }, (b) => b.proposal.no === 1)
    expect(contested.proposal).toMatchObject({ status: 'open', yes: 1, no: 1 })
    expect(contested.proposal.votes).toContainEqual(
      expect.objectContaining({ voter: { did: against.did, handle: against.handle }, value: 'no', reason: 'Not active enough yet' }),
    )
    expect(await waiting(against)).toEqual([])
    expect(await waiting(decider)).toHaveLength(1)

    await vote(decider, proposal, 'yes')
    const passed = await until(`${NS}.getProposal`, { uri: proposal.uri }, (b) => b.proposal.status !== 'open')
    expect(passed.proposal).toMatchObject({ status: 'passed', yes: 2, no: 1, executed: false })
    expect(await waiting(decider)).toEqual([])
    expect(await listed('open')).toEqual([])
    expect(await listed('closed')).toEqual([proposal.uri])
    expect(await listed()).toEqual([proposal.uri])

    // Voting counts as moderator activity.
    const { body } = await xrpc(`${NS}.listModerators`, { community: community.account.did })
    expect(body.moderators.every((m: any) => typeof m.lastActiveAt === 'string')).toBe(true)
  })

  it('lists proposals newest first, marking ones that do not count as invalid', async () => {
    const community = await setupCommunity(env, { moderators: 1 })
    const mod = community.moderators[0].account
    await moderatorsActive(community)
    const outsider = await createAccount(env, 'out')

    // With one moderator, the proposer's own yes passes it at once.
    const own = await proposeInvite(mod, community, outsider.did, 'We need help')
    await until(`${NS}.getProposal`, { uri: own.uri }, () => true)
    const foreign = await proposeInvite(outsider, community, outsider.did, 'Let me in')
    await until(`${NS}.getProposal`, { uri: foreign.uri }, () => true)

    const { body } = await xrpc(`${NS}.listProposals`, { community: community.account.did })
    expect(body.proposals.map((p: any) => [p.uri, p.status, p.problems])).toEqual([
      [foreign.uri, 'invalid', ['not_moderator']],
      [own.uri, 'passed', []],
    ])
    const { body: page } = await xrpc(`${NS}.listProposals`, { community: community.account.did, limit: '1' })
    expect(page.proposals.map((p: any) => p.uri)).toEqual([foreign.uri])
    const { body: closed } = await xrpc(`${NS}.listProposals`, { community: community.account.did, status: 'closed' })
    expect(closed.proposals.map((p: any) => p.uri)).toEqual([foreign.uri, own.uri])

    // An invalid proposal asks nobody to vote.
    const { body: notes } = await xrpc(`${NS}.listNotifications`, { actor: mod.did })
    expect(notes.notifications.filter((n: any) => n.reason === 'vote')).toEqual([])

    const missing = await xrpc(`${NS}.getProposal`, { uri: `at://${mod.did}/${ids.communityProposal}/3mzzzzzzzzz2b` })
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('NotFound')
    expect((await xrpc(`${NS}.listProposals`, { community: outsider.did })).status).toBe(404)
  })
})

describe('bans', () => {
  it('lists a community’s bans newest first and keeps banned runners out of the queue', async () => {
    const community = await setupCommunity(env)
    const mod = community.moderators[0].account
    const [cheater, spammer] = [await createAccount(env, 'ch'), await createAccount(env, 'sp')]
    const run = await putRecord(cheater, ids.run, runRecord(community.categories.seventyStar))
    await until(`${NS}.listReviewQueue`, { community: community.account.did }, (b) => b.runs.some((r: any) => r.run.uri === run.uri))

    const first = await putRecord(community.account, ids.communityBan, {
      subject: cheater.did,
      reason: 'Spliced run',
      moderator: mod.did,
      createdAt: now(),
    })
    await until(`${NS}.listBans`, { community: community.account.did }, (b) => b.bans.length === 1)
    const second = await putRecord(community.account, ids.communityBan, {
      subject: spammer.did,
      reason: 'Spam submissions',
      moderator: mod.did,
      createdAt: now(),
    })
    const { bans } = await until(`${NS}.listBans`, { community: community.account.did }, (b) => b.bans.length === 2 && b.bans.every((ban: any) => ban.subject.handle))
    expect(bans).toEqual([
      {
        uri: second.uri,
        cid: second.cid,
        subject: { did: spammer.did, handle: spammer.handle },
        moderator: { did: mod.did, handle: mod.handle },
        reason: 'Spam submissions',
        indexedAt: expect.any(String),
      },
      {
        uri: first.uri,
        cid: first.cid,
        subject: { did: cheater.did, handle: cheater.handle },
        moderator: { did: mod.did, handle: mod.handle },
        reason: 'Spliced run',
        indexedAt: expect.any(String),
      },
    ])

    const { body: queue } = await xrpc(`${NS}.listReviewQueue`, { community: community.account.did })
    expect(queue.runs.map((r: any) => r.run.uri)).not.toContain(run.uri)

    const other = await setupCommunity(env)
    await until(`${NS}.getCommunity`, { community: other.account.did }, () => true)
    expect((await xrpc(`${NS}.listBans`, { community: other.account.did })).body.bans).toEqual([])
    expect((await xrpc(`${NS}.listBans`, { community: cheater.did })).status).toBe(404)
  })
})

describe('community requests', () => {
  it('shows each request as pending, approved or denied by the platform', async () => {
    const requester = await createAccount(env, 'rq')
    const friend = await createAccount(env, 'rf')
    const platform = await createAccount(env, 'plat')
    const impostor = await createAccount(env, 'imp')
    // The community service registers the platform account; here we stand in for it.
    await appview.db
      .insertInto('community_credential')
      .values({ did: platform.did, identifier: platform.handle, pds_url: env.pdsUrl, secret: 'unused', kind: 'platform', created_at: new Date(), updated_at: new Date() })
      .execute()

    const request = (title: string, note?: string) =>
      putRecord(requester, ids.communityRequest, {
        game: { title, releaseYear: 2018, platforms: ['PC'] },
        founders: [requester.did, friend.did],
        ...(note ? { note } : {}),
        createdAt: now(),
      })
    const pending = await request('Celeste', 'We run the Celeste Discord')
    const approved = await request('Hollow Knight')
    const denied = await request('Tetris')
    const all = (body: any) => body.requests?.length === 3
    await until(`${NS}.listCommunityRequests`, { requester: requester.did, status: 'all' }, all)

    // A community made from the request names it as the founder's grant; a denial counts only from the platform's repo.
    const community = await setupCommunity(env)
    await putRecord(community.account, ids.communityMember, { subject: requester.did, via: approved, createdAt: now() })
    await putRecord(impostor, ids.platformRequestDenial, { request: pending, reason: 'Not a sysadmin', sysadmin: impostor.did, createdAt: now() })
    await putRecord(platform, ids.platformRequestDenial, { request: denied, reason: 'Already exists', sysadmin: platform.did, createdAt: now() })

    const { requests } = await until(`${NS}.listCommunityRequests`, { requester: requester.did, status: 'all' }, (b) =>
      b.requests.filter((r: any) => r.status !== 'pending').length === 2 && b.requests[0].founders.every((f: any) => f.handle),
    )
    expect(requests).toEqual([
      {
        uri: pending.uri,
        cid: pending.cid,
        requester: { did: requester.did, handle: requester.handle },
        game: { title: 'Celeste', releaseYear: 2018, platforms: ['PC'] },
        founders: [
          { did: requester.did, handle: requester.handle },
          { did: friend.did, handle: friend.handle },
        ],
        note: 'We run the Celeste Discord',
        status: 'pending',
        indexedAt: expect.any(String),
      },
      expect.objectContaining({ uri: approved.uri, status: 'approved', community: community.account.did }),
      expect.objectContaining({ uri: denied.uri, status: 'denied', denialReason: 'Already exists' }),
    ])
    expect(requests[1].denialReason).toBeUndefined()
    expect(requests[2].community).toBeUndefined()

    // By default only requests still waiting for a sysadmin.
    const { body } = await xrpc(`${NS}.listCommunityRequests`, { requester: requester.did })
    expect(body.requests.map((r: any) => r.uri)).toEqual([pending.uri])
    const { body: page } = await xrpc(`${NS}.listCommunityRequests`, { requester: requester.did, status: 'all', limit: '1' })
    expect(page.requests.map((r: any) => r.uri)).toEqual([pending.uri])
    const { body: none } = await xrpc(`${NS}.listCommunityRequests`, { requester: friend.did, status: 'all' })
    expect(none.requests).toEqual([])
  })
})

describe('world records, video problems and the feed', () => {
  let community: TestCommunity
  let slow: TestAccount
  let fast: TestAccount
  let runA: WrittenRecord
  let runB: WrittenRecord

  beforeAll(async () => {
    community = await setupCommunity(env)
    ;[slow, fast] = [await createAccount(env, 'wa'), await createAccount(env, 'wb')]
    runA = await verifiedRun(community, slow, 960_000, {
      videos: [{ url: 'https://videos.example.test/a-gone' }, { url: 'https://videos.example.test/a-ok' }],
    })
    runB = await verifiedRun(community, fast, 950_250)
  }, 60_000)

  it('lists the world record progression by category and community', async () => {
    const category = community.categories.sixteenStar
    const { records } = await until(`${NS}.listWorldRecords`, { category: category.uri }, (b) => b.records.length === 2)
    expect(records.map((r: any) => [r.run.uri, r.run.runner.did, r.rankedMs, r.previous?.did, r.previousRankedMs])).toEqual([
      [runB.uri, fast.did, 950_250, slow.did, 960_000],
      [runA.uri, slow.did, 960_000, undefined, undefined],
    ])
    expect(records[0]).toMatchObject({
      category: { uri: category.uri, name: '16 Star' },
      game: { uri: community.game.uri, title: 'Super Mario 64' },
      community: { did: community.account.did, handle: community.account.handle, name: 'Super Mario 64' },
      subcategory: [],
      run: { status: 'verified', rank: 1 },
    })
    expect(records[0].announcement).toBeUndefined()
    expect(Date.parse(records[0].setAt)).toBeGreaterThanOrEqual(Date.parse(records[1].setAt))

    const byCommunity = await xrpc(`${NS}.listWorldRecords`, { community: community.account.did })
    expect(byCommunity.body.records.map((r: any) => r.run.uri)).toEqual([runB.uri, runA.uri])
    const limited = await xrpc(`${NS}.listWorldRecords`, { community: community.account.did, limit: '1' })
    expect(limited.body.records.map((r: any) => r.run.uri)).toEqual([runB.uri])
    const otherCategory = await xrpc(`${NS}.listWorldRecords`, { category: community.categories.seventyStar.uri })
    expect(otherCategory.body.records).toEqual([])
  })

  it('notifies runners of verdicts and of world records won and lost', async () => {
    const forSlow = (await xrpc(`${NS}.listNotifications`, { actor: slow.did })).body.notifications
    expect(forSlow.map((n: any) => n.reason).sort()).toEqual(['verified', 'worldRecord', 'worldRecordBeaten'])
    expect(forSlow.find((n: any) => n.reason === 'verified')).toMatchObject({
      subject: runA.uri,
      text: 'Your 16 Star run',
      author: { did: community.moderators[0].account.did },
      community: { did: community.account.did },
    })
    expect(forSlow.find((n: any) => n.reason === 'worldRecord')).toMatchObject({ subject: runA.uri, text: '16 Star in 16:00.000' })
    expect(forSlow.find((n: any) => n.reason === 'worldRecordBeaten')).toMatchObject({
      subject: runB.uri,
      author: { did: fast.did, handle: fast.handle },
      text: '16 Star in 15:50.250',
    })
    // Newest first.
    const times = forSlow.map((n: any) => n.indexedAt)
    expect(times).toEqual([...times].sort().reverse())

    const forFast = (await xrpc(`${NS}.listNotifications`, { actor: fast.did, limit: '1' })).body.notifications
    expect(forFast).toHaveLength(1)
    expect((await xrpc(`${NS}.listNotifications`, { actor: (await createAccount(env, 'nn')).did })).body.notifications).toEqual([])
  })

  it('lists dead video links only while the run still carries them', async () => {
    const t = Date.now()
    const at = (s: number) => new Date(t - s * 1000)
    await appview.db
      .insertInto('video_check')
      .values([
        { run_uri: runA.uri, url: 'https://videos.example.test/a-gone', community_did: community.account.did, status: 'dead', http_status: 404, detail: 'Not Found', checked_at: at(30) },
        { run_uri: runA.uri, url: 'https://videos.example.test/a-ok', community_did: community.account.did, status: 'ok', http_status: 200, detail: null, checked_at: at(20) },
        // A link since replaced on the run.
        { run_uri: runA.uri, url: 'https://videos.example.test/a-old', community_did: community.account.did, status: 'dead', http_status: 410, detail: null, checked_at: at(10) },
      ])
      .execute()

    const { body } = await xrpc(`${NS}.listVideoProblems`, { community: community.account.did })
    expect(body.problems).toEqual([
      {
        run: expect.objectContaining({ uri: runA.uri, deadVideos: ['https://videos.example.test/a-gone'] }),
        url: 'https://videos.example.test/a-gone',
        httpStatus: 404,
        detail: 'Not Found',
        checkedAt: at(30).toISOString(),
      },
    ])
    expect((await xrpc(`${NS}.getRun`, { uri: runA.uri })).body.run.deadVideos).toEqual(['https://videos.example.test/a-gone'])
    expect((await xrpc(`${NS}.getRun`, { uri: runB.uri })).body.run.deadVideos).toBeUndefined()

    const notes = (await xrpc(`${NS}.listNotifications`, { actor: slow.did })).body.notifications
    expect(notes.filter((n: any) => n.reason === 'deadVideo').map((n: any) => [n.subject, n.text])).toEqual([
      [runA.uri, 'https://videos.example.test/a-gone'],
    ])

    const other = await setupCommunity(env)
    await until(`${NS}.getCommunity`, { community: other.account.did }, () => true)
    expect((await xrpc(`${NS}.listVideoProblems`, { community: other.account.did })).body.problems).toEqual([])
    expect((await xrpc(`${NS}.listVideoProblems`, { community: slow.did })).status).toBe(404)
  })

  it('serves a feed per game of the announcement posts, newest first and paged', async () => {
    const records = await appview.db
      .selectFrom('world_record')
      .select(['id', 'run_uri'])
      .where('community_did', '=', community.account.did)
      .orderBy('id')
      .execute()
    expect(records.map((r) => r.run_uri)).toEqual([runA.uri, runB.uri])
    const post = (n: number) => `at://${community.account.did}/app.bsky.feed.post/3m${randomId(5)}${n}`
    const [postA, postB] = [post(1), post(2)]
    const t = Date.now()
    await appview.db
      .insertInto('announcement')
      .values([
        { world_record_id: records[0].id, community_did: community.account.did, game_uri: community.game.uri, post_uri: postA, post_cid: 'bafy-a', error: null, posted_at: new Date(t - 2000) },
        { world_record_id: records[1].id, community_did: community.account.did, game_uri: community.game.uri, post_uri: postB, post_cid: 'bafy-b', error: null, posted_at: new Date(t - 1000) },
      ])
      .execute()

    const feed = feedUriForGame(community.game.uri)
    expect(feed).toBe(`at://${community.account.did}/app.bsky.feed.generator/${community.game.uri.split('/').pop()}`)
    const skeleton = (params: Record<string, string>) => xrpc('app.bsky.feed.getFeedSkeleton', { feed, ...params })

    const whole = await skeleton({})
    expect(whole.status).toBe(200)
    expect(whole.body).toEqual({ feed: [{ post: postB }, { post: postA }] })

    const first = await skeleton({ limit: '1' })
    expect(first.body.feed).toEqual([{ post: postB }])
    expect(first.body.cursor).toEqual(expect.any(String))
    const second = await skeleton({ limit: '1', cursor: first.body.cursor })
    expect(second.body.feed).toEqual([{ post: postA }])
    const third = await skeleton({ limit: '1', cursor: second.body.cursor })
    expect(third.body).toEqual({ feed: [] })

    // The progression links each record to its post.
    const { body } = await xrpc(`${NS}.listWorldRecords`, { community: community.account.did })
    expect(body.records.map((r: any) => r.announcement)).toEqual([postB, postA])

    // Another game's feed is empty; unknown and malformed feeds are errors.
    const other = await setupCommunity(env)
    await until(`${NS}.getCommunity`, { community: other.account.did }, (b) => b.community.games.length === 1)
    expect((await xrpc('app.bsky.feed.getFeedSkeleton', { feed: feedUriForGame(other.game.uri) })).body).toEqual({ feed: [] })
    const unknown = await xrpc('app.bsky.feed.getFeedSkeleton', { feed: `at://${community.account.did}/app.bsky.feed.generator/3mzzzzzzzzz2b` })
    expect(unknown).toMatchObject({ status: 400, body: { error: 'UnknownFeed' } })
    const malformed = await xrpc('app.bsky.feed.getFeedSkeleton', { feed: community.game.uri })
    expect(malformed).toMatchObject({ status: 400, body: { error: 'InvalidRequest' } })
  })

  it('describes its feeds and serves its did:web document', async () => {
    const { status, body } = await xrpc('app.bsky.feed.describeFeedGenerator')
    expect(status).toBe(200)
    expect(body.did).toBe(FEED_DID)
    expect(body.feeds).toContainEqual({ uri: feedUriForGame(community.game.uri) })

    const res = await fetch(new URL('/.well-known/did.json', appview.url))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: FEED_DID,
      service: [{ id: '#bsky_fg', type: 'BskyFeedGenerator', serviceEndpoint: new URL(appview.url).origin }],
    })
  })
})
