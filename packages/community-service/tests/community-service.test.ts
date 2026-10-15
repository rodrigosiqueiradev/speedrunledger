import { ids, ledger } from '@speedrunledger/lexicon'
import {
  createAccount,
  type DevEnv,
  now,
  putRecord,
  runRecord,
  setupCommunity,
  type TestAccount,
  type TestCommunity,
  waitFor,
} from '@speedrunledger/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { admin, callAs, type Harness, SERVICE_DID, startHarness } from './helpers.js'

// The community service against the local PDS: moderators authenticate with
// service-auth JWTs minted by their own PDS, and verdicts land in the
// community's repo.

const LXM = ledger.moderation.createVerdict.$nsid

let h: Harness
let env: DevEnv
let server: Harness['server']
let db: Harness['db']
let community: TestCommunity

beforeAll(async () => {
  h = await startHarness()
  ;({ env, server, db } = h)
  community = await setupCommunity(env, { moderators: 2 })
  const res = await admin(server, 'POST', '/admin/communities', {
    identifier: community.account.handle,
    password: community.account.password,
    pdsUrl: env.pdsUrl,
  })
  expect(res.status).toBe(200)
})

afterAll(async () => {
  await h?.stop()
})

const createVerdict = (as: TestAccount, body: unknown, opts: { aud?: string; lxm?: string } = {}) =>
  callAs(server, as, LXM, body, { ...opts, lxm: opts.lxm ?? LXM })

async function indexedRun(runner: TestAccount, overrides: Record<string, unknown> = {}) {
  const run = await putRecord(runner, ids.run, runRecord(community.categories.sixteenStar, overrides))
  await waitFor(async () => {
    const row = await db.selectFrom('run').select('problems').where('uri', '=', run.uri).where('cid', '=', run.cid).executeTakeFirst()
    return row && row.problems.length === 0 ? true : undefined
  })
  // Moderators are active once their acceptance is indexed.
  await waitFor(async () => {
    const rows = await db.selectFrom('community_member').select('active').where('community_did', '=', community.account.did).execute()
    return rows.length === 2 && rows.every((r) => r.active) ? true : undefined
  })
  return run
}

describe('community service', () => {
  it('writes a verdict into the community repo with the moderator as reviewer', async () => {
    const runner = await createAccount(env, 'cs')
    const run = await indexedRun(runner)
    const mod = community.moderators[0].account

    const res = await createVerdict(mod, { run, status: 'verified', verifiedTimes: { realTimeMs: 899_000 } })
    expect(res.status).toBe(200)
    expect(res.body.uri).toMatch(new RegExp(`^at://${community.account.did}/${ids.verification}/`))

    const { data } = await community.account.agent.com.atproto.repo.getRecord({
      repo: community.account.did,
      collection: ids.verification,
      rkey: res.body.uri.split('/').pop(),
    })
    expect(data.value).toMatchObject({
      subject: { uri: run.uri, cid: run.cid },
      status: 'verified',
      reviewer: mod.did,
      verifiedTimes: { realTimeMs: 899_000 },
    })

    // The indexer picks it up and the run is ranked.
    await waitFor(async () =>
      db.selectFrom('board_entry').select('rank').where('run_uri', '=', run.uri).executeTakeFirst(),
    )
  })

  it('refuses anyone who is not an active moderator, and moderators judging their own runs', async () => {
    const runner = await createAccount(env, 'cs')
    const run = await indexedRun(runner)

    const stranger = await createAccount(env, 'x')
    expect((await createVerdict(stranger, { run, status: 'verified' })).body.error).toBe('NotModerator')
    expect((await createVerdict(runner, { run, status: 'verified' })).body.error).toBe('NotModerator')

    const mod = community.moderators[1].account
    const ownRun = await indexedRun(mod)
    expect((await createVerdict(mod, { run: ownRun, status: 'verified' })).body.error).toBe('OwnRun')
  })

  it('refuses stale versions, missing reasons and bad tokens', async () => {
    const runner = await createAccount(env, 'cs')
    const run = await indexedRun(runner)
    const mod = community.moderators[0].account

    const edited = await putRecord(runner, ids.run, runRecord(community.categories.sixteenStar, { comment: 'edited' }), {
      rkey: run.uri.split('/').pop(),
    })
    await waitFor(async () => db.selectFrom('run').select('uri').where('cid', '=', edited.cid).executeTakeFirst())
    expect((await createVerdict(mod, { run, status: 'verified' })).body.error).toBe('RunChanged')

    const noReason = await createVerdict(mod, { run: edited, status: 'rejected' })
    expect(noReason.status).toBe(400)

    const changes = await createVerdict(mod, { run: edited, status: 'changesRequested', reason: 'Video is private' })
    expect(changes.status).toBe(200)

    const wrongAudience = await createVerdict(mod, { run: edited, status: 'verified' }, { aud: 'did:web:elsewhere.test' })
    expect(wrongAudience.status).toBe(401)
    const wrongMethod = await createVerdict(mod, { run: edited, status: 'verified' }, { lxm: 'app.example.other' })
    expect(wrongMethod.status).toBe(401)

    const noToken = await fetch(`${server.url}/xrpc/${LXM}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run: edited, status: 'verified' }),
    })
    expect(noToken.status).toBe(401)
  })

  it('protects the admin endpoints and serves its DID document', async () => {
    const denied = await fetch(`${server.url}/admin/communities`)
    expect(denied.status).toBe(401)
    const list = await admin(server, 'GET', '/admin/communities')
    expect(list.body.communities.map((c: any) => c.did)).toContain(community.account.did)
    // Credentials are stored encrypted.
    const stored = await db.selectFrom('community_credential').select('secret').where('did', '=', community.account.did).executeTakeFirstOrThrow()
    expect(stored.secret).not.toContain(community.account.password)

    const doc = (await (await fetch(`${server.url}/.well-known/did.json`)).json()) as any
    expect(doc.id).toBe(SERVICE_DID)
  })

  it('refuses verdicts from banned moderators', async () => {
    const runner = await createAccount(env, 'cs')
    const run = await indexedRun(runner)
    const mod = community.moderators[1].account
    await putRecord(community.account, ids.communityBan, {
      subject: mod.did,
      reason: 'test',
      moderator: community.moderators[0].account.did,
      createdAt: now(),
    })
    await waitFor(async () =>
      db.selectFrom('ban').select('uri').where('subject_did', '=', mod.did).executeTakeFirst(),
    )
    expect((await createVerdict(mod, { run, status: 'verified' })).body.error).toBe('Banned')
  })
})

describe('several approvals', () => {
  it('takes each moderator once, and keeps an earlier approver’s retime', async () => {
    const own = await setupCommunity(env, { moderators: 2 })
    await admin(server, 'POST', '/admin/communities', { identifier: own.account.handle, password: own.account.password, pdsUrl: env.pdsUrl })
    const [a, b] = own.moderators.map((m) => m.account)
    await waitFor(async () => {
      const rows = await db.selectFrom('community_member').select('active').where('community_did', '=', own.account.did).execute()
      return rows.length === 2 && rows.every((r) => r.active) ? true : undefined
    })
    // A category that needs two moderators to verify.
    const strict = await putRecord(own.account, ids.category, {
      game: own.game,
      name: '120 Star',
      kind: 'time',
      sort: 'asc',
      primaryTiming: 'realTime',
      requiredApprovals: 2,
      createdAt: now(),
    })
    await waitFor(() => db.selectFrom('category').select('uri').where('uri', '=', strict.uri).executeTakeFirst())
    const runner = await createAccount(env, 'ma')
    const run = await putRecord(runner, ids.run, runRecord(strict, { times: { realTimeMs: 6_000_000 }, variables: [] }))
    await waitFor(() => db.selectFrom('run').select('uri').where('uri', '=', run.uri).executeTakeFirst())

    const first = await createVerdict(a, { run, status: 'verified', verifiedTimes: { realTimeMs: 5_999_100 } })
    expect(first.status).toBe(200)
    await waitFor(() => db.selectFrom('verification').select('uri').where('uri', '=', first.body.uri).executeTakeFirst())
    expect((await createVerdict(a, { run, status: 'verified' })).body.error).toBe('AlreadyApproved')
    // Not on the board with one approval of two.
    expect(await db.selectFrom('board_entry').select('run_uri').where('run_uri', '=', run.uri).executeTakeFirst()).toBeUndefined()

    const second = await createVerdict(b, { run, status: 'verified' })
    expect(second.status).toBe(200)
    const entry = await waitFor(() => db.selectFrom('board_entry').select('ranked_ms').where('run_uri', '=', run.uri).executeTakeFirst())
    expect(entry.ranked_ms).toBe(5_999_100)
  })
})
