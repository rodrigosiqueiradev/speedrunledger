import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  type TestAccount,
  waitFor,
} from '@speedrunledger/testkit'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LedgerAdmin, UsageError } from '../src/index.js'

// ledger-admin against a real indexer, AppView and community service on the local PDS.

const ADMIN_TOKEN = 'cli-test-token'
let env: DevEnv
let indexer: IndexerService
let appview: AppViewServer
let service: CommunityServiceServer
let dropDb: () => Promise<void>
let sysadmin: TestAccount
let founder: TestAccount
let dir: string

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
      serviceDid: 'did:web:localhost%3A2586',
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
  founder = await createAccount(env, 'fnd')
  dir = await mkdtemp(join(tmpdir(), 'ledger-admin-'))
}, 60_000)

afterAll(async () => {
  await service?.destroy()
  await appview?.destroy()
  await indexer?.destroy()
  await dropDb?.()
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('ledger-admin', () => {
  it('sets up the platform with handles, and lists sysadmins', async () => {
    const out = await cli(['platform', 'init', '--handle', `plat${Date.now() % 1e6}.test`, '--sysadmin', sysadmin.handle])
    expect(out).toContain(`sysadmin ${sysadmin.did}`)
    expect(await json(['sysadmin', 'list'])).toEqual([sysadmin.did])
    await expect(cli(['platform', 'init', '--handle', 'again.test', '--sysadmin', sysadmin.did])).rejects.toThrow(/AlreadyInitialized/)
  })

  it('needs to know which sysadmin is acting', async () => {
    await expect(cli(['community', 'freeze', founder.did, '--reason', 'x'])).rejects.toThrow(UsageError)
    await expect(cli(['sysadmin', 'add', founder.did], founder.did)).rejects.toThrow(/NotSysadmin/)
  })

  it('lists and answers requests, creates, freezes, unfreezes and exports a community', async () => {
    const request = await putRecord(founder, ids.communityRequest, {
      game: { title: 'Super Mario 64', releaseYear: 1996, platforms: ['N64'] },
      founders: [founder.did],
      note: 'From the SM64 Discord',
      createdAt: now(),
    })
    const pending = await waitFor(async () => {
      const out = await cli(['requests', 'list'])
      return out.includes(request.uri) ? out : undefined
    })
    expect(pending).toContain('Super Mario 64 (1996)')
    expect(pending).toContain(`@${founder.handle}`)

    const created = await json(
      ['community', 'create', '--handle', `sm64c${Date.now() % 1e6}.test`, '--name', 'Super Mario 64', '--request', request.uri],
      sysadmin.handle,
    )
    expect(created.did).toMatch(/^did:plc:/)
    expect(created.grants).toHaveLength(1)

    const listed = await waitFor(async () => {
      const out = await cli(['community', 'list'])
      return out.includes('Super Mario 64: Super Mario 64') ? out : undefined
    })
    expect(listed).toContain(created.did)

    // An answered request is no longer pending.
    await waitFor(async () => ((await cli(['requests', 'list'])).includes(request.uri) ? undefined : true))

    await cli(['community', 'freeze', created.handle, '--reason', 'Leaderboard vandalism'], sysadmin.did)
    await waitFor(async () => ((await cli(['community', 'list'])).includes('[frozen]') ? true : undefined))
    await expect(cli(['community', 'freeze', created.did, '--reason', 'again'], sysadmin.did)).rejects.toThrow(/NoChange/)
    await cli(['community', 'unfreeze', created.did, '--reason', 'Cleaned up'], sysadmin.did)
    await waitFor(async () => ((await cli(['community', 'list'])).includes('[frozen]') ? undefined : true))

    const file = join(dir, 'community.car')
    const exported = await json(['community', 'export', created.did, '--out', file])
    const car = await readFile(file)
    expect(car.length).toBe(exported.bytes)
    expect(car.length).toBeGreaterThan(100)
  })

  it('denies a request with a reason the requester sees', async () => {
    const request = await putRecord(founder, ids.communityRequest, {
      game: { title: 'Not a real game' },
      founders: [founder.did],
      createdAt: now(),
    })
    await waitFor(async () => ((await cli(['requests', 'list'])).includes(request.uri) ? true : undefined))
    await cli(['requests', 'deny', request.uri, '--reason', 'Please link the game'], sysadmin.did)
    const all = await waitFor(async () => {
      const out = await cli(['requests', 'list', '--all'])
      return out.includes('Please link the game') ? out : undefined
    })
    expect(all).toContain('status: denied')
  })

  it('prints usage for unknown commands', async () => {
    expect(await cli([])).toContain('ledger-admin: run SpeedrunLedger')
    await expect(cli(['nope'])).rejects.toThrow(/unknown command/)
  })
})
