import { AppViewServer } from '@speedrunledger/appview'
import { tallyProposals } from '@speedrunledger/db'
import { ids, ledger } from '@speedrunledger/lexicon'
import {
  createAccount,
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
import { admin, callAs, type Harness, startHarness } from './helpers.js'

// What the community service does with proposals once the votes are in:
// kicks, category and ruleset changes written exactly as proposed, deadlines,
// and what a freeze stops (and does not stop), against the local PDS with a
// real indexer, AppView and community service.

const NS = 'app.speedrunledger-prototype'
const DAY = 24 * 60 * 60 * 1000
const inAWeek = () => new Date(Date.now() + 7 * DAY).toISOString()

let h: Harness
let appview: AppViewServer
let community: TestCommunity
let mods: TestAccount[]

beforeAll(async () => {
  h = await startHarness()
  appview = new AppViewServer({ databaseUrl: h.server.config.databaseUrl, port: 0 })
  await appview.start()
  community = await setupCommunity(h.env, { moderators: 3 })
  mods = community.moderators.map((m) => m.account)
  await h.server.service.registerAccount({ identifier: community.account.handle, password: community.account.password, pdsUrl: h.env.pdsUrl })
  await waitFor(async () => ((await activeModerators()).length === 3 ? true : undefined))
}, 60_000)

afterAll(async () => {
  await appview?.destroy()
  await h?.stop()
})

const activeModerators = async () =>
  (
    await h.db
      .selectFrom('community_member')
      .select('member_did')
      .where('community_did', '=', community.account.did)
      .where('active', '=', true)
      .execute()
  ).map((r) => r.member_did)

const xrpc = async (nsid: string, params: Record<string, string>) => {
  const res = await fetch(new URL(`/xrpc/${nsid}?${new URLSearchParams(params)}`, appview.url))
  return { status: res.status, body: (await res.json()) as any }
}

const getRecord = async (uri: string) => {
  const [repo, collection, rkey] = uri.replace('at://', '').split('/')
  const url = new URL('/xrpc/com.atproto.repo.getRecord', h.env.pdsUrl)
  url.search = new URLSearchParams({ repo, collection, rkey }).toString()
  const res = await fetch(url)
  return res.ok ? ((await res.json()) as { uri: string; cid: string; value: any }) : undefined
}

const propose = (who: TestAccount, action: Record<string, unknown>, opts: { expiresAt?: string } = {}) =>
  putRecord(who, ids.communityProposal, {
    community: community.account.did,
    action,
    reason: 'Discussed in chat',
    expiresAt: opts.expiresAt ?? inAWeek(),
    createdAt: now(),
  })

const vote = (who: TestAccount, proposal: WrittenRecord, value: 'yes' | 'no') =>
  putRecord(who, ids.communityVote, { proposal, value, createdAt: now() })

/** Waits until the proposal (and its votes) are indexed and tally to `status`, without running the executor. */
async function tallied(proposal: WrittenRecord, status: string) {
  return waitFor(async () => {
    const row = await h.db.selectFrom('proposal').selectAll().where('uri', '=', proposal.uri).where('cid', '=', proposal.cid).executeTakeFirst()
    if (!row) return undefined
    const tally = (await tallyProposals(h.db, [row])).get(row.uri)
    return tally?.status === status ? tally : undefined
  })
}

/** Waits for the tally, then runs the executor once. */
async function settle(proposal: WrittenRecord, status: string) {
  await tallied(proposal, status)
  return admin(h.server, 'POST', '/admin/proposals/execute')
}

const categoryRow = (uri: string) => h.db.selectFrom('category').selectAll().where('uri', '=', uri).executeTakeFirstOrThrow()
const rkeyOf = (uri: string) => uri.split('/').pop()!

describe('proposals carried out', () => {
  it('change an existing category, written exactly as proposed', async () => {
    const [a, b] = mods
    const sixteen = community.categories.sixteenStar
    const record = {
      game: community.game,
      name: '16 Star',
      description: 'Collect 16 stars and beat Bowser in the Sky.',
      kind: 'time',
      sort: 'asc',
      primaryTiming: 'realTime',
      timingMethods: ['realTime', 'gameTime'],
      requiresVideo: true,
      requiredApprovals: 2,
      // `retired` is left out on purpose: the executor must not add the lexicon's default.
      createdAt: now(),
    }
    const proposal = await propose(a, {
      $type: `${ids.communityProposal}#putRecord`,
      collection: ids.category,
      rkey: rkeyOf(sixteen.uri),
      record,
    })
    await vote(b, proposal, 'yes')
    expect((await settle(proposal, 'passed')).body.executed).toBe(1)

    // The same record key, so runs and boards keep pointing at it; the value is the proposal's record.
    const written = await waitFor(async () => {
      const r = await getRecord(sixteen.uri)
      return r && r.cid !== sixteen.cid ? r : undefined
    })
    expect(written.value).toEqual({ $type: ids.category, ...record })
    const execution = await h.db.selectFrom('proposal_execution').selectAll().where('proposal_uri', '=', proposal.uri).executeTakeFirstOrThrow()
    expect(execution).toMatchObject({ result_uri: sixteen.uri, error: null })
    const row = await waitFor(async () => {
      const r = await categoryRow(sixteen.uri)
      return r.cid === written.cid ? r : undefined
    })
    expect(row).toMatchObject({ timing_methods: ['realTime', 'gameTime'], required_approvals: 2, retired: false })
    // Still exactly one 16 Star category.
    const named = await h.db.selectFrom('category').select('uri').where('community_did', '=', community.account.did).where('name', '=', '16 Star').execute()
    expect(named).toHaveLength(1)
  })

  it("set a category's ruleset by majority vote, then change it", async () => {
    const [a, b, c] = mods
    const seventy = community.categories.seventyStar
    const category = await categoryRow(seventy.uri)
    const firstRules = { category: { uri: category.uri, cid: category.cid }, text: 'Timing starts on file select.', createdAt: now() }
    const first = await propose(b, { $type: `${ids.communityProposal}#putRecord`, collection: ids.ruleset, record: firstRules })
    await vote(c, first, 'yes')
    expect((await settle(first, 'passed')).body.executed).toBe(1)

    const execution = await h.db.selectFrom('proposal_execution').selectAll().where('proposal_uri', '=', first.uri).executeTakeFirstOrThrow()
    expect(execution.result_uri).toMatch(new RegExp(`^at://${community.account.did}/${ids.ruleset}/`))
    expect((await getRecord(execution.result_uri!))!.value).toEqual({ $type: ids.ruleset, ...firstRules })
    const board = await waitFor(async () => {
      const { body } = await xrpc(`${NS}.getLeaderboard`, { category: seventy.uri })
      return body.category?.ruleset ? body : undefined
    })
    expect(board.category.ruleset).toMatchObject({ uri: execution.result_uri, text: firstRules.text })

    // A new version is a new record; the newest is current.
    const secondRules = { ...firstRules, text: 'Timing starts on file select and ends on the final Bowser key grab.', createdAt: now() }
    const second = await propose(c, { $type: `${ids.communityProposal}#putRecord`, collection: ids.ruleset, record: secondRules })
    await vote(a, second, 'yes')
    expect((await settle(second, 'passed')).body.executed).toBe(1)
    const again = await h.db.selectFrom('proposal_execution').selectAll().where('proposal_uri', '=', second.uri).executeTakeFirstOrThrow()
    expect(again.result_uri).not.toBe(execution.result_uri)
    await waitFor(async () => {
      const { body } = await xrpc(`${NS}.getLeaderboard`, { category: seventy.uri })
      return body.category?.ruleset?.text === secondRules.text ? true : undefined
    })
    const rulesets = await h.db.selectFrom('ruleset').select('uri').where('category_uri', '=', seventy.uri).execute()
    expect(rulesets).toHaveLength(2)
  })

  it('never carry out a proposal that reaches its deadline without a majority', async () => {
    const [a, b] = mods
    const seventy = await categoryRow(community.categories.seventyStar.uri)
    const before = await getRecord(seventy.uri)
    const record = { game: community.game, name: '70 Star (renamed)', kind: 'time', sort: 'asc', primaryTiming: 'realTime', createdAt: now() }
    const proposal = await propose(
      a,
      { $type: `${ids.communityProposal}#putRecord`, collection: ids.category, rkey: rkeyOf(seventy.uri), record },
      { expiresAt: new Date(Date.now() + 3000).toISOString() },
    )
    // Only the proposer's own yes before the deadline: 1 of the 2 needed.
    await tallied(proposal, 'open')
    await tallied(proposal, 'expired')
    // A yes after the deadline would have made the majority, but does not count.
    const late = await vote(b, proposal, 'yes')
    await waitFor(() => h.db.selectFrom('vote').select('uri').where('uri', '=', late.uri).executeTakeFirst())
    const tally = await tallied(proposal, 'expired')
    expect(tally.yes).toBe(1)

    expect((await admin(h.server, 'POST', '/admin/proposals/execute')).body.executed).toBe(0)
    expect(await h.db.selectFrom('proposal_execution').select('proposal_uri').where('proposal_uri', '=', proposal.uri).executeTakeFirst()).toBeUndefined()
    expect((await getRecord(seventy.uri))!.cid).toBe(before!.cid)
    expect((await categoryRow(seventy.uri)).name).toBe('70 Star')
  }, 30_000)
})

describe('frozen communities', () => {
  let sysadmin: TestAccount
  let runner: TestAccount
  let ranked: WrittenRecord

  beforeAll(async () => {
    sysadmin = await createAccount(h.env, 'admin')
    const platform = await admin(h.server, 'POST', '/admin/platform', { handle: `platform${Date.now() % 1e6}.test`, sysadmin: sysadmin.did })
    expect(platform.status).toBe(200)
    runner = await createAccount(h.env, 'fz')
    ranked = await putRecord(runner, ids.run, runRecord(community.categories.seventyStar, { times: { realTimeMs: 48 * 60_000 } }))
    await waitFor(() => h.db.selectFrom('run').select('uri').where('uri', '=', ranked.uri).executeTakeFirst())
    expect((await callAs(h.server, mods[0], ledger.moderation.createVerdict.$nsid, { run: ranked, status: 'verified' })).status).toBe(200)
    await waitFor(() => h.db.selectFrom('board_entry').select('run_uri').where('run_uri', '=', ranked.uri).executeTakeFirst())
  }, 60_000)

  const freeze = async (action: 'freeze' | 'unfreeze', reason: string) => {
    const res = await admin(h.server, 'POST', `/admin/communities/${community.account.did}/${action}`, { sysadmin: sysadmin.did, reason })
    expect(res.status).toBe(200)
    await waitFor(() => h.db.selectFrom('intervention').select('uri').where('uri', '=', res.body.uri).executeTakeFirst())
  }

  it('keep their leaderboard readable while refusing changes, and take changes again once unfrozen', async () => {
    const [a, b] = mods
    // Boards keep each runner's best run, so the faster run comes from someone else.
    const challenger = await createAccount(h.env, 'fy')
    const pending = await putRecord(challenger, ids.run, runRecord(community.categories.seventyStar, { times: { realTimeMs: 47 * 60_000 } }))
    await waitFor(() => h.db.selectFrom('run').select('uri').where('uri', '=', pending.uri).executeTakeFirst())

    await freeze('freeze', 'Vote brigading')

    // The board is still served, marked frozen.
    const board = await xrpc(`${NS}.getLeaderboard`, { category: community.categories.seventyStar.uri })
    expect(board.status).toBe(200)
    expect(board.body.community.frozen).toBe(true)
    expect(board.body.entries.map((e: any) => [e.rank, e.run.uri])).toEqual([[1, ranked.uri]])
    expect((await xrpc(`${NS}.getRun`, { uri: ranked.uri })).status).toBe(200)

    // No verdicts, bans or game edits.
    expect((await callAs(h.server, a, ledger.moderation.createVerdict.$nsid, { run: pending, status: 'verified' })).body.error).toBe('CommunityFrozen')
    const cheater = await createAccount(h.env, 'ch')
    expect(
      (await callAs(h.server, b, ledger.moderation.createBan.$nsid, { community: community.account.did, subject: cheater.did, reason: 'x' })).body
        .error,
    ).toBe('CommunityFrozen')
    expect((await callAs(h.server, a, ledger.moderation.updateGame.$nsid, { game: community.game.uri, platforms: ['N64'] })).body.error).toBe(
      'CommunityFrozen',
    )

    await freeze('unfreeze', 'Resolved')
    expect((await callAs(h.server, a, ledger.moderation.createVerdict.$nsid, { run: pending, status: 'verified' })).status).toBe(200)
    const after = await waitFor(async () => {
      const { body } = await xrpc(`${NS}.getLeaderboard`, { category: community.categories.seventyStar.uri })
      return body.entries.length === 2 ? body : undefined
    })
    expect(after.community.frozen).toBeUndefined()
    expect(after.entries.map((e: any) => e.run.uri)).toEqual([pending.uri, ranked.uri])
  }, 60_000)

  it('hold a proposal that passed before the freeze until the community is unfrozen', async () => {
    const [a, b] = mods
    const invitee = await createAccount(h.env, 'inv')
    const proposal = await propose(b, { $type: `${ids.communityProposal}#invite`, subject: invitee.did })
    await vote(a, proposal, 'yes')
    await tallied(proposal, 'passed')

    await freeze('freeze', 'Investigating')
    expect((await admin(h.server, 'POST', '/admin/proposals/execute')).body.executed).toBe(0)
    expect(await h.db.selectFrom('community_member').select('uri').where('member_did', '=', invitee.did).executeTakeFirst()).toBeUndefined()

    await freeze('unfreeze', 'Nothing found')
    expect((await admin(h.server, 'POST', '/admin/proposals/execute')).body.executed).toBe(1)
    const grant = await waitFor(() =>
      h.db.selectFrom('community_member').select(['uri', 'via_uri']).where('member_did', '=', invitee.did).executeTakeFirst(),
    )
    expect(grant.via_uri).toBe(proposal.uri)
  }, 60_000)
})

describe('kicks', () => {
  it('kick a moderator by majority vote', async () => {
    const [a, b, c] = mods
    expect(await activeModerators()).toContain(c.did)
    const proposal = await propose(a, { $type: `${ids.communityProposal}#kick`, subject: c.did })
    // The target does not vote: a and b are the electorate, and both must agree.
    const row = await waitFor(() => h.db.selectFrom('proposal').select(['electorate', 'problems']).where('uri', '=', proposal.uri).executeTakeFirst())
    expect(row.problems).toEqual([])
    expect([...row.electorate].sort()).toEqual([a.did, b.did].sort())
    await tallied(proposal, 'open')
    await vote(b, proposal, 'yes')
    expect((await settle(proposal, 'passed')).body.executed).toBe(1)

    // The grant is deleted from the community's repo, and they stop being active.
    const grant = community.moderators[2].grant
    await waitFor(async () => ((await getRecord(grant.uri)) ? undefined : true))
    await waitFor(async () => ((await activeModerators()).includes(c.did) ? undefined : true))
    expect((await activeModerators()).sort()).toEqual([a.did, b.did].sort())
    expect(await h.db.selectFrom('community_member').select('uri').where('member_did', '=', c.did).executeTakeFirst()).toBeUndefined()
    const runner = await createAccount(h.env, 'kr')
    const run = await putRecord(runner, ids.run, runRecord(community.categories.sixteenStar))
    await waitFor(() => h.db.selectFrom('run').select('uri').where('uri', '=', run.uri).executeTakeFirst())
    expect((await callAs(h.server, c, ledger.moderation.createVerdict.$nsid, { run, status: 'verified' })).body.error).toBe('NotModerator')
    const { body } = await xrpc(`${NS}.listModerators`, { community: community.account.did })
    expect(JSON.stringify(body)).not.toContain(c.did)
  }, 60_000)
})
