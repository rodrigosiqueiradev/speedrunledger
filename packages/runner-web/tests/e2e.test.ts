import { AppViewServer } from '@speedrunledger/appview'
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
  setupCommunity,
  type TestCommunity,
  waitFor,
} from '@speedrunledger/testkit'
import { chromiumPath, freePort, signInWithOAuth } from '@speedrunledger/testkit/browser'
import { type Browser, chromium } from 'playwright-core'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RunnerWeb } from '../server/index.js'

// A runner signs in through the local PDS's OAuth pages, submits a run from
// the browser, a moderator verifies it, and it shows up ranked on the board.

let env: DevEnv
let indexer: IndexerService
let appview: AppViewServer
let runnerWeb: RunnerWeb
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
  const port = await freePort()
  runnerWeb = new RunnerWeb({
    port,
    publicUrl: `http://127.0.0.1:${port}`,
    databaseUrl: database.url,
    appviewUrl: appview.url,
    cookieSecret: 'e2e-cookie-secret-that-is-at-least-32-chars',
    devPdsUrl: env.pdsUrl,
    plcUrl: env.plcUrl,
    viteDev: true,
  })
  await runnerWeb.start()
  browser = await chromium.launch({ executablePath: chromiumPath })
  await new Promise((resolve) => setTimeout(resolve, 500))
  community = await setupCommunity(env)
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await runnerWeb?.destroy()
  await appview?.destroy()
  await indexer?.destroy()
  await dropDb?.()
})

describe('runner app', () => {
  it('takes a run from sign-in to a ranked board entry', async () => {
    const runner = await createAccount(env, 'e2e')
    const page = await browser.newPage()
    await signInWithOAuth(page, { appUrl: runnerWeb.config.publicUrl, pdsUrl: env.pdsUrl, handle: runner.handle, password: runner.password })

    const category = community.categories.sixteenStar
    const boardUrl = `${runnerWeb.config.publicUrl}/board?category=${encodeURIComponent(category.uri)}`
    // The category reaches the AppView through the firehose; retry until it is served.
    await expect
      .poll(
        async () => {
          await page.goto(boardUrl)
          await page.locator('h1, .error').first().waitFor()
          return page.getByText('Submit a run').count()
        },
        { timeout: 20_000, interval: 500 },
      )
      .toBeGreaterThan(0)
    await page.click('text=Submit a run')

    await page.fill('input[name=realTime]', '14:58.200')
    await page.fill('input[name=video]', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    await page.selectOption('select[name=platform]', 'N64')
    // First submission: the "runs are public" notice must be acknowledged.
    await page.check('input[name=acknowledge]')
    await page.click('button:has-text("Submit run")')
    await page.waitForURL(/\/run\?/)
    const runUri = new URL(page.url()).searchParams.get('uri')!
    expect(runUri).toMatch(new RegExp(`^at://${runner.did}/${ids.run}/`))
    await page.getByText('Waiting for review').waitFor({ timeout: 20_000 })

    // A moderator's verdict, written by the community account (the Moderator app does this in stage 3).
    const run = await fetch(new URL(`/xrpc/${ledger.getRun.$nsid}?uri=${encodeURIComponent(runUri)}`, appview.url)).then(
      (r) => r.json() as Promise<{ run: { uri: string; cid: string } }>,
    )
    await putRecord(community.account, ids.verification, {
      subject: { uri: run.run.uri, cid: run.run.cid },
      status: 'verified',
      reviewer: community.moderators[0].account.did,
      createdAt: now(),
    })

    await expect
      .poll(
        async () => {
          await page.goto(boardUrl)
          await page.locator('table.board, p:has-text("No verified runs yet.")').first().waitFor()
          return page.locator('table.board tbody tr').allInnerTexts()
        },
        { timeout: 20_000, interval: 500 },
      )
      .toEqual([expect.stringMatching(new RegExp(`^1\\s+${runner.handle.replace(/\./g, '\\.')}\\s+14:58\\.200`))])

    await page.click('table.board tbody a')
    await page.locator('p:has(.status.verified)').getByText('Rank 1').waitFor()

    // Editing a verified run sends it back to review and takes it off the board.
    await page.click('text=Edit run')
    await page.getByText('sends this run back to review').waitFor()
    expect(await page.inputValue('input[name=realTime]')).toBe('14:58.200')
    await page.fill('input[name=comment], textarea[name=comment]', 'Retimed from the start of the video')
    await page.click('button:has-text("Save changes")')
    await page.waitForURL(/\/run\?/)
    expect(new URL(page.url()).searchParams.get('uri')).toBe(runUri)
    await expect
      .poll(
        async () => {
          await page.reload()
          await page.locator('h1, .error').first().waitFor()
          return page.locator('p .status').first().innerText()
        },
        { timeout: 20_000, interval: 500 },
      )
      .toBe('Waiting for review')
    await page.getByText('Retimed from the start of the video').waitFor()
    await page.goto(boardUrl)
    await page.getByText('No verified runs yet.').waitFor()
    await page.close()
  }, 120_000)

  it('asks the sysadmins for a community, naming founders by handle', async () => {
    const runner = await createAccount(env, 'rq')
    const friend = await createAccount(env, 'rf')
    const page = await browser.newPage()
    await signInWithOAuth(page, { appUrl: runnerWeb.config.publicUrl, pdsUrl: env.pdsUrl, handle: runner.handle, password: runner.password })
    await page.goto(`${runnerWeb.config.publicUrl}/request`)
    await page.fill('input[name=title]', 'Celeste')
    await page.fill('input[name=year]', '2018')
    await page.fill('input[name=platforms]', 'PC, Switch')
    await page.fill('input[name=founders]', `${runner.handle}, @${friend.handle}`)
    await page.fill('textarea[name=note]', 'We run the Celeste Discord')
    await page.click('button:has-text("Send request")')
    await page.getByText('Request sent').waitFor()
    await page.locator('.requests li', { hasText: 'Waiting for a sysadmin' }).waitFor({ timeout: 15_000 })

    const { requests } = await waitFor(async () => {
      const url = new URL('/xrpc/app.speedrunledger-prototype.listCommunityRequests', appview.url)
      url.searchParams.set('requester', runner.did)
      const res = (await (await fetch(url)).json()) as any
      return res.requests?.length ? res : undefined
    })
    expect(requests[0]).toMatchObject({
      game: { title: 'Celeste', releaseYear: 2018, platforms: ['PC', 'Switch'] },
      founders: [{ did: runner.did }, { did: friend.did }],
      note: 'We run the Celeste Discord',
      status: 'pending',
    })
    await page.close()
  }, 120_000)

  it('shares a run to Bluesky from the runner’s account, and lists verdicts as notifications', async () => {
    const runner = await createAccount(env, 'sh')
    const page = await browser.newPage()
    await signInWithOAuth(page, { appUrl: runnerWeb.config.publicUrl, pdsUrl: env.pdsUrl, handle: runner.handle, password: runner.password })
    const category = community.categories.seventyStar
    await page.goto(`${runnerWeb.config.publicUrl}/submit?category=${encodeURIComponent(category.uri)}`)
    await page.fill('input[name=realTime]', '48:01.500')
    await page.fill('input[name=video]', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    await page.check('input[name=acknowledge]')
    await page.check('input[name=share]')
    await page.click('button:has-text("Submit run")')
    await page.waitForURL(/\/run\?/)
    await page.getByText('Posted to Bluesky').waitFor({ timeout: 20_000 })
    const runUri = new URL(page.url()).searchParams.get('uri')!

    const url = new URL('/xrpc/com.atproto.repo.listRecords', env.pdsUrl)
    url.search = new URLSearchParams({ repo: runner.did, collection: 'app.bsky.feed.post' }).toString()
    const { records } = (await (await fetch(url)).json()) as any
    expect(records).toHaveLength(1)
    expect(records[0].value.text).toBe('I ran Super Mario 64 70 Star in 48:01.500 (waiting for review). See the run')
    expect(records[0].value.embed.external.uri).toBe(`${runnerWeb.config.publicUrl}/run?${new URLSearchParams({ uri: runUri })}`)

    // A verdict shows up in notifications, with a count in the header until opened.
    const run = await waitFor(() => indexer.indexer.db.selectFrom('run').select(['uri', 'cid']).where('uri', '=', runUri).executeTakeFirst())
    await putRecord(community.account, ids.verification, {
      subject: run,
      status: 'changesRequested',
      reason: 'Please show the timer at the end',
      reviewer: community.moderators[0].account.did,
      createdAt: now(),
    })
    await expect
      .poll(
        async () => {
          await page.goto(`${runnerWeb.config.publicUrl}/`)
          return page
            .locator('nav .badge')
            .waitFor({ timeout: 2000 })
            .then(() => page.locator('nav .badge').innerText(), () => '')
        },
        { timeout: 20_000, interval: 500 },
      )
      .toBe('1')
    await page.click('nav >> text=Notifications')
    await page.getByText('asked for changes to your run').waitFor()
    await page.getByText('Please show the timer at the end').waitFor()
    await page.goto(`${runnerWeb.config.publicUrl}/`)
    await page.locator('h1').waitFor()
    await page.waitForTimeout(1000)
    expect(await page.locator('nav .badge').count()).toBe(0)
    await page.close()
  }, 120_000)
})
