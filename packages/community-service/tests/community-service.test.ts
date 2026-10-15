import { randomBytes } from 'node:crypto'
import { IndexerService, readConfig as readIndexerConfig } from '@speedrunledger/indexer'
import { ids, ledger } from '@speedrunledger/lexicon'
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
} from '@speedrunledger/testkit'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CommunityServiceServer } from '../src/index.js'

// The community service against the local PDS: moderators authenticate with
// service-auth JWTs minted by their own PDS, and verdicts land in the
// community's repo.

const SERVICE_DID = 'did:web:localhost%3A2586'
const LXM = ledger.moderation.createVerdict.$nsid
const ADMIN_TOKEN = 'test-admin-token'

let env: DevEnv
let indexer: IndexerService
let server: CommunityServiceServer
let dropDb: () => Promise<void>
let community: TestCommunity
let db: IndexerService['indexer']['db']

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
  db = indexer.indexer.db
  server = new CommunityServiceServer(
    {
      port: 0,
      databaseUrl: database.url,
      serviceDid: SERVICE_DID,
      secretKey: randomBytes(32),
      adminToken: ADMIN_TOKEN,
      plcUrl: env.plcUrl,
      devMode: true,
    },
    pino({ level: 'silent' }),
  )
  await server.start()
  await new Promise((resolve) => setTimeout(resolve, 500))
  community = await setupCommunity(env, { moderators: 2 })
  const res = await fetch(`${server.url}/admin/communities`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: community.account.handle, password: community.account.password, pdsUrl: env.pdsUrl }),
  })
  expect(res.status).toBe(200)
})

afterAll(async () => {
  await server?.destroy()
  await indexer?.destroy()
  await dropDb?.()
})

/** Calls createVerdict as `as`, with a JWT their PDS signed. */
async function createVerdict(as: TestAccount, body: unknown, opts: { aud?: string; lxm?: string } = {}) {
  const { data } = await as.agent.com.atproto.server.getServiceAuth({ aud: opts.aud ?? SERVICE_DID, lxm: opts.lxm ?? LXM })
  const res = await fetch(`${server.url}/xrpc/${LXM}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${data.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as any }
}

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
    const list = await fetch(`${server.url}/admin/communities`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })
    expect(((await list.json()) as any).communities.map((c: any) => c.did)).toContain(community.account.did)
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
