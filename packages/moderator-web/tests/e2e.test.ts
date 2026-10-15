import { randomBytes } from 'node:crypto'
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
  putRecord,
  runRecord,
  setupCommunity,
  type TestCommunity,
  waitFor,
} from '@speedrunledger/testkit'
import { chromiumPath, freePort, signInWithOAuth } from '@speedrunledger/testkit/browser'
import { type Browser, chromium, type Page } from 'playwright-core'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ModeratorWeb } from '../server/index.js'

// Build stage 3's finish line: a submitted run goes through the Moderator
// app's queue and review page, the community service writes the verdict into
// the community's repo, and the run is ranked on the board.

const SERVICE_DID = 'did:web:localhost%3A2586'

let env: DevEnv
let indexer: IndexerService
let appview: AppViewServer
let communityService: CommunityServiceServer
let moderatorWeb: ModeratorWeb
let browser: Browser
let dropDb: () => Promise<void>
let community: TestCommunity

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
  communityService = new CommunityServiceServer(
    {
      port: 0,
      databaseUrl: database.url,
      serviceDid: SERVICE_DID,
      secretKey: randomBytes(32),
      adminToken: 'e2e-admin',
      plcUrl: env.plcUrl,
      devMode: true,
    },
    pino({ level: 'silent' }),
  )
  await communityService.start()
  const port = await freePort()
  moderatorWeb = new ModeratorWeb({
    port,
    publicUrl: `http://127.0.0.1:${port}`,
    databaseUrl: database.url,
    appviewUrl: appview.url,
    communityServiceUrl: communityService.url,
    communityServiceDid: SERVICE_DID,
    cookieSecret: 'e2e-cookie-secret-that-is-at-least-32-chars',
    devPdsUrl: env.pdsUrl,
    plcUrl: env.plcUrl,
    viteDev: true,
  })
  await moderatorWeb.start()
  browser = await chromium.launch({ executablePath: chromiumPath })
  await new Promise((resolve) => setTimeout(resolve, 500))
  community = await setupCommunity(env, { moderators: 2 })
  await communityService.service.registerCommunity({
    identifier: community.account.handle,
    password: community.account.password,
    pdsUrl: env.pdsUrl,
  })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await moderatorWeb?.destroy()
  await communityService?.destroy()
  await appview?.destroy()
  await indexer?.destroy()
  await dropDb?.()
})

const xrpc = async (nsid: string, params: Record<string, string>) =>
  (await fetch(new URL(`/xrpc/app.speedrunledger-prototype.${nsid}?${new URLSearchParams(params)}`, appview.url))).json() as Promise<any>

/** Reloads `url` until `ready` finds what the indexer has caught up to. */
async function reloadUntil(page: Page, url: string, ready: () => Promise<boolean>) {
  await expect
    .poll(
      async () => {
        await page.goto(url)
        await page.locator('h1, .error').first().waitFor()
        return ready()
      },
      { timeout: 20_000, interval: 500 },
    )
    .toBe(true)
}

describe('moderator app', () => {
  it('takes a submitted run through review to a ranked board entry', async () => {
    const runner = await createAccount(env, 'mr')
    const run = await putRecord(runner, ids.run, runRecord(community.categories.sixteenStar, { times: { realTimeMs: 905_120 } }))
    const mod = community.moderators[0].account

    const page = await browser.newPage()
    await signInWithOAuth(page, { appUrl: moderatorWeb.config.publicUrl, pdsUrl: env.pdsUrl, handle: mod.handle, password: mod.password })

    // Home lists the community once the moderator's acceptance is indexed.
    await reloadUntil(page, moderatorWeb.config.publicUrl, async () => (await page.getByText('Review queue').count()) > 0)
    await page.click('text=Review queue')
    await reloadUntil(page, page.url(), async () => (await page.getByText(runner.handle).count()) > 0)
    expect(await page.locator('table.queue tbody tr').allInnerTexts()).toEqual([
      expect.stringMatching(new RegExp(`16 Star\\s+${runner.handle.replace(/\./g, '\\.')}\\s+15:05\\.120`)),
    ])

    await page.click(`text=${runner.handle}`)
    await page.getByText('Record verdict').waitFor()
    await page.check('input[value=verified]')
    await page.fill('input[name=retime-realTime]', '15:04.990')
    await page.click('button:has-text("Record verdict")')
    await page.getByText('Verdict recorded').waitFor()

    const board = await waitFor(async () => {
      const res = await xrpc('getLeaderboard', { category: community.categories.sixteenStar.uri })
      return res.entries?.length === 1 ? res : undefined
    })
    expect(board.entries[0]).toMatchObject({ rank: 1, rankedMs: 904_990, run: { uri: run.uri, status: 'verified' } })
    const { run: view } = await xrpc('getRun', { uri: run.uri })
    expect(view.verdicts[0]).toMatchObject({ reviewer: { did: mod.did }, current: true })

    // The queue is empty now.
    await reloadUntil(page, page.url(), async () => (await page.getByText('Nothing to review').count()) > 0)
    await page.close()
  }, 120_000)

  it('sends a run back to the runner with a reason, and keeps moderators off their own runs', async () => {
    const runner = await createAccount(env, 'mr')
    const run = await putRecord(runner, ids.run, runRecord(community.categories.seventyStar))
    const mod = community.moderators[1].account
    const ownRun = await putRecord(mod, ids.run, runRecord(community.categories.seventyStar))

    const page = await browser.newPage()
    await signInWithOAuth(page, { appUrl: moderatorWeb.config.publicUrl, pdsUrl: env.pdsUrl, handle: mod.handle, password: mod.password })

    await reloadUntil(page, `${moderatorWeb.config.publicUrl}/review?${new URLSearchParams({ uri: ownRun.uri })}`, async () =>
      (await page.getByText('another moderator has to review it').count()) > 0,
    )

    await reloadUntil(page, `${moderatorWeb.config.publicUrl}/review?${new URLSearchParams({ uri: run.uri })}`, async () =>
      (await page.getByText('Record verdict').count()) > 0,
    )
    await page.check('input[value=changesRequested]')
    await page.click('button:has-text("Record verdict")')
    await page.getByText('Tell the runner why').waitFor()
    await page.fill('textarea[name=reason]', 'The timer is cut off at the end of the video')
    await page.click('button:has-text("Record verdict")')
    await page.getByText('Verdict recorded').waitFor()

    const view = await waitFor(async () => {
      const res = await xrpc('getRun', { uri: run.uri })
      return res.run?.status === 'changesRequested' ? res.run : undefined
    })
    expect(view.verdicts[0].reason).toBe('The timer is cut off at the end of the video')
    await page.close()
  }, 120_000)
})
