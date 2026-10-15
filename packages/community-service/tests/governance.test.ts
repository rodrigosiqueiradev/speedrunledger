import { ids, ledger } from '@speedrunledger/lexicon'
import { createAccount, now, putRecord, runRecord, type TestAccount, waitFor, type WrittenRecord } from '@speedrunledger/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { admin, callAs, type Harness, startHarness } from './helpers.js'

// Sysadmin endpoints, proposals and votes, bans, game edits and freezes,
// end to end through the local PDS, the indexer and the community service.

let h: Harness
let sysadmin: TestAccount
let founders: TestAccount[]
let community: { did: string; handle: string; game: string }

const DAY = 24 * 60 * 60 * 1000
const inAWeek = () => new Date(Date.now() + 7 * DAY).toISOString()

beforeAll(async () => {
  h = await startHarness()
  sysadmin = await createAccount(h.env, 'admin')
  const platform = await admin(h.server, 'POST', '/admin/platform', { handle: `platform${Date.now() % 1e6}.test`, sysadmin: sysadmin.did })
  expect(platform.status).toBe(200)
  founders = [await createAccount(h.env, 'fa'), await createAccount(h.env, 'fb'), await createAccount(h.env, 'fc')]
}, 60_000)

afterAll(async () => {
  await h?.stop()
})

const accept = (who: TestAccount, grantUri: string) =>
  waitFor(async () => {
    const grant = await h.db.selectFrom('community_member').select(['uri', 'cid']).where('uri', '=', grantUri).executeTakeFirst()
    return grant ? putRecord(who, ids.communityMemberAccept, { member: grant, createdAt: now() }) : undefined
  })

const activeModerators = async (did: string) =>
  (
    await h.db.selectFrom('community_member').select('member_did').where('community_did', '=', did).where('active', '=', true).execute()
  ).map((r) => r.member_did)

const propose = (who: TestAccount, action: Record<string, unknown>, reason = 'Discussed in chat') =>
  putRecord(who, ids.communityProposal, { community: community.did, action, reason, expiresAt: inAWeek(), createdAt: now() })

const vote = (who: TestAccount, proposal: WrittenRecord, value: 'yes' | 'no') =>
  putRecord(who, ids.communityVote, { proposal, value, createdAt: now() })

/** Waits for the proposal (and its votes) to be indexed with the given status, then lets the executor run. */
async function settle(proposal: WrittenRecord, status: string) {
  const { tallyProposals } = await import('@speedrunledger/db')
  await waitFor(async () => {
    const row = await h.db.selectFrom('proposal').selectAll().where('uri', '=', proposal.uri).where('cid', '=', proposal.cid).executeTakeFirst()
    if (!row) return undefined
    const tally = (await tallyProposals(h.db, [row])).get(row.uri)
    return tally?.status === status ? tally : undefined
  })
  return admin(h.server, 'POST', '/admin/proposals/execute')
}

describe('sysadmins', () => {
  it('create a community from a request, with founders who accept', async () => {
    const requester = founders[0]
    const request = await putRecord(requester, ids.communityRequest, {
      game: { title: 'Super Mario 64', releaseYear: 1996, platforms: ['N64'] },
      founders: founders.map((f) => f.did),
      note: 'We run the SM64 Discord',
      createdAt: now(),
    })
    await waitFor(async () => h.db.selectFrom('community_request').select('uri').where('uri', '=', request.uri).executeTakeFirst())

    const notAdmin = await admin(h.server, 'POST', '/admin/communities/create', {
      sysadmin: requester.did,
      handle: `nope${Date.now() % 1e6}.test`,
      name: 'Nope',
      request: request.uri,
    })
    expect(notAdmin.body.error).toBe('NotSysadmin')

    const created = await admin(h.server, 'POST', '/admin/communities/create', {
      sysadmin: sysadmin.did,
      handle: `sm64x${Date.now() % 1e6}.test`,
      name: 'Super Mario 64',
      request: request.uri,
    })
    expect(created.status).toBe(200)
    community = created.body
    expect(created.body.grants).toHaveLength(3)
    for (const [i, f] of founders.entries()) await accept(f, created.body.grants[i])
    await waitFor(async () => ((await activeModerators(community.did)).length === 3 ? true : undefined))

    const grant = await h.db.selectFrom('community_member').select('via_uri').where('uri', '=', created.body.grants[0]).executeTakeFirstOrThrow()
    expect(grant.via_uri).toBe(request.uri)
  })

  it('deny requests with a reason, and only sysadmins can add sysadmins', async () => {
    const someone = await createAccount(h.env, 'rq')
    const request = await putRecord(someone, ids.communityRequest, {
      game: { title: 'Super Mario 64' },
      founders: [someone.did],
      createdAt: now(),
    })
    await waitFor(async () => h.db.selectFrom('community_request').select('uri').where('uri', '=', request.uri).executeTakeFirst())
    const denied = await admin(h.server, 'POST', '/admin/requests/deny', {
      sysadmin: sysadmin.did,
      request: request.uri,
      reason: 'Super Mario 64 already has a community',
    })
    expect(denied.status).toBe(200)
    await waitFor(async () => h.db.selectFrom('request_denial').select('uri').where('request_uri', '=', request.uri).executeTakeFirst())

    expect((await admin(h.server, 'POST', '/admin/sysadmins', { sysadmin: someone.did, subject: someone.did })).body.error).toBe(
      'NotSysadmin',
    )
    const second = await createAccount(h.env, 'admin')
    expect((await admin(h.server, 'POST', '/admin/sysadmins', { sysadmin: sysadmin.did, subject: second.did })).status).toBe(200)
    expect((await admin(h.server, 'GET', '/admin/sysadmins')).body.sysadmins).toEqual(expect.arrayContaining([sysadmin.did, second.did]))
  })
})

describe('proposals', () => {
  it('invite a moderator by majority vote; the invitee becomes active after accepting', async () => {
    const [a, b] = founders
    const invitee = await createAccount(h.env, 'inv')
    const proposal = await propose(a, { $type: `${ids.communityProposal}#invite`, subject: invitee.did })
    await vote(b, proposal, 'yes')
    const executed = await settle(proposal, 'passed')
    expect(executed.body.executed).toBe(1)

    const grant = await waitFor(async () =>
      h.db.selectFrom('community_member').select(['uri', 'via_uri']).where('member_did', '=', invitee.did).executeTakeFirst(),
    )
    expect(grant.via_uri).toBe(proposal.uri)
    await accept(invitee, grant.uri)
    await waitFor(async () => ((await activeModerators(community.did)).includes(invitee.did) ? true : undefined))
    // Running the executor again changes nothing.
    expect((await admin(h.server, 'POST', '/admin/proposals/execute')).body.executed).toBe(0)
  })

  it('create a category exactly as proposed, and refuse a second open proposal from the same person', async () => {
    const [a, b, c] = founders
    const record = {
      game: await h.db.selectFrom('game').select(['uri', 'cid']).where('uri', '=', community.game).executeTakeFirstOrThrow(),
      name: '120 Star',
      kind: 'time',
      sort: 'asc',
      primaryTiming: 'realTime',
      createdAt: now(),
    }
    const proposal = await propose(c, { $type: `${ids.communityProposal}#putRecord`, collection: ids.category, record })
    const second = await propose(c, { $type: `${ids.communityProposal}#invite`, subject: a.did })
    await waitFor(async () => {
      const row = await h.db.selectFrom('proposal').select('problems').where('uri', '=', second.uri).executeTakeFirst()
      return row?.problems.includes('proposer_has_open_proposal') ? true : undefined
    })
    // 4 moderators now: the proposer and two more make 3 of 4.
    await vote(a, proposal, 'yes')
    await vote(b, proposal, 'yes')
    await settle(proposal, 'passed')
    const category = await waitFor(async () =>
      h.db.selectFrom('category').selectAll().where('community_did', '=', community.did).where('name', '=', '120 Star').executeTakeFirst(),
    )
    expect(category.primary_timing).toBe('realTime')
  })

  it('fail once a majority is impossible, and never carry out', async () => {
    const [a, b, c] = founders
    const target = await createAccount(h.env, 'x')
    const proposal = await propose(a, { $type: `${ids.communityProposal}#invite`, subject: target.did })
    await vote(b, proposal, 'no')
    await vote(c, proposal, 'no')
    const run = await settle(proposal, 'failed')
    expect(run.body.executed).toBe(0)
  })
})

describe('moderator actions', () => {
  it('ban by any one moderator, lifted by vote', async () => {
    const [a, b, c] = founders
    const cheater = await createAccount(h.env, 'ch')
    const ban = await callAs(h.server, a, ledger.moderation.createBan.$nsid, {
      community: community.did,
      subject: cheater.did,
      reason: 'Spliced video',
    })
    expect(ban.status).toBe(200)
    await waitFor(async () => h.db.selectFrom('ban').select('uri').where('uri', '=', ban.body.uri).executeTakeFirst())
    const again = await callAs(h.server, b, ledger.moderation.createBan.$nsid, { community: community.did, subject: cheater.did, reason: 'x' })
    expect(again.body.error).toBe('AlreadyBanned')

    const banRow = await h.db.selectFrom('ban').select(['uri', 'cid']).where('subject_did', '=', cheater.did).executeTakeFirstOrThrow()
    const proposal = await propose(b, { $type: `${ids.communityProposal}#liftBan`, ban: banRow })
    await vote(a, proposal, 'yes')
    await vote(c, proposal, 'yes')
    await settle(proposal, 'passed')
    await waitFor(async () =>
      (await h.db.selectFrom('ban').select('uri').where('subject_did', '=', cheater.did).executeTakeFirst()) ? undefined : true,
    )
  })

  it('edit game details without a vote', async () => {
    const res = await callAs(h.server, founders[1], ledger.moderation.updateGame.$nsid, {
      game: community.game,
      platforms: ['N64', 'Wii VC', 'Wii U VC'],
    })
    expect(res.status).toBe(200)
    await waitFor(async () => {
      const game = await h.db.selectFrom('game').select('platforms').where('uri', '=', community.game).executeTakeFirst()
      return game?.platforms.length === 3 ? true : undefined
    })
    const outsider = await createAccount(h.env, 'x')
    expect((await callAs(h.server, outsider, ledger.moderation.updateGame.$nsid, { game: community.game })).body.error).toBe('NotModerator')
  })
})

describe('interventions', () => {
  it('freeze a community: no verdicts, bans or new proposals until it is unfrozen', async () => {
    const [a, b] = founders
    const runner = await createAccount(h.env, 'fr')
    const category = await h.db.selectFrom('category').select(['uri', 'cid']).where('community_did', '=', community.did).executeTakeFirstOrThrow()
    const run = await putRecord(runner, ids.run, runRecord(category, { variables: [] }))
    await waitFor(async () => h.db.selectFrom('run').select('uri').where('uri', '=', run.uri).executeTakeFirst())

    expect((await admin(h.server, 'POST', `/admin/communities/${community.did}/freeze`, { sysadmin: sysadmin.did, reason: 'Vote brigading' })).status).toBe(200)
    await waitFor(async () => h.db.selectFrom('intervention').select('uri').where('community_did', '=', community.did).executeTakeFirst())

    const verdict = await callAs(h.server, a, ledger.moderation.createVerdict.$nsid, { run, status: 'verified' })
    expect(verdict.body.error).toBe('CommunityFrozen')
    const proposal = await propose(b, { $type: `${ids.communityProposal}#migrate`, pdsEndpoint: 'https://pds.example.com' })
    await waitFor(async () => {
      const row = await h.db.selectFrom('proposal').select('problems').where('uri', '=', proposal.uri).executeTakeFirst()
      return row?.problems.includes('community_frozen') ? true : undefined
    })

    expect((await admin(h.server, 'POST', `/admin/communities/${community.did}/unfreeze`, { sysadmin: sysadmin.did, reason: 'Resolved' })).status).toBe(200)
    await waitFor(async () => {
      const rows = await h.db.selectFrom('intervention').select('action').where('community_did', '=', community.did).execute()
      return rows.some((r) => r.action === 'unfreeze') ? true : undefined
    })
    expect((await callAs(h.server, a, ledger.moderation.createVerdict.$nsid, { run, status: 'verified' })).status).toBe(200)
  })

  it('appoint a moderator only when none is active', async () => {
    const lonely = await admin(h.server, 'POST', `/admin/communities/${community.did}/appoint`, {
      sysadmin: sysadmin.did,
      subject: founders[0].did,
      reason: 'test',
    })
    expect(lonely.body.error).toBe('HasModerators')

    const empty = await admin(h.server, 'POST', '/admin/communities/create', {
      sysadmin: sysadmin.did,
      handle: `empty${Date.now() % 1e6}.test`,
      name: 'Empty',
      game: { title: 'Celeste' },
      founders: [founders[2].did],
    })
    expect(empty.status).toBe(200)
    // The founder never accepted, so nobody is active.
    const appointee = await createAccount(h.env, 'ap')
    const appointed = await admin(h.server, 'POST', `/admin/communities/${empty.body.did}/appoint`, {
      sysadmin: sysadmin.did,
      subject: appointee.did,
      reason: 'The founder never accepted',
    })
    expect(appointed.status).toBe(200)
    await accept(appointee, appointed.body.grant)
    await waitFor(async () => ((await activeModerators(empty.body.did)).includes(appointee.did) ? true : undefined))
  })
})
