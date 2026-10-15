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
  now,
  putRecord,
  randomId,
  type TestAccount,
  waitFor,
} from '@speedrunledger/testkit'
import { chromiumPath, freePort, signInWithOAuth } from '@speedrunledger/testkit/browser'
import { type Browser, chromium, type Page } from 'playwright-core'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AdminWeb } from '../server/index.js'

// The Admin app in a browser, against a real indexer, AppView and community
// service on the local PDS: first-run setup, answering community requests,
// stepping in on a community, managing sysadmins, and running jobs.

const ADMIN_TOKEN = `admin-e2e-${randomId()}`

let env: DevEnv
let indexer: IndexerService
let appview: AppViewServer
let communityService: CommunityServiceServer
let adminWeb: AdminWeb
let browser: Browser
let dropDb: () => Promise<void>
let sysadmin: TestAccount
let founder: TestAccount
let page: Page

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
  await communityService.start()
  const port = await freePort()
  adminWeb = new AdminWeb({
    port,
    publicUrl: `http://127.0.0.1:${port}`,
    databaseUrl: database.url,
    appviewUrl: appview.url,
    communityServiceUrl: communityService.url,
    adminToken: ADMIN_TOKEN,
    cookieSecret: 'e2e-cookie-secret-that-is-at-least-32-chars',
    devPdsUrl: env.pdsUrl,
    plcUrl: env.plcUrl,
    viteDev: true,
  })
  await adminWeb.start()
  browser = await chromium.launch({ executablePath: chromiumPath })
  sysadmin = await createAccount(env, 'sa')
  founder = await createAccount(env, 'fo')
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await adminWeb?.destroy()
  await communityService?.destroy()
  await appview?.destroy()
  await indexer?.destroy()
  await dropDb?.()
})

const signIn = async (who: TestAccount) => {
  const p = await browser.newPage()
  await signInWithOAuth(p, { appUrl: adminWeb.config.publicUrl, pdsUrl: env.pdsUrl, handle: who.handle, password: who.password })
  return p
}
const url = (path: string) => new URL(path, adminWeb.config.publicUrl).toString()

/** Reloads `target` until `text` shows up: writes reach the AppView once the indexer has seen them. */
async function reloadUntilShows(p: Page, target: string, text: string) {
  await expect
    .poll(
      async () => {
        await p.goto(target)
        await p.locator('h1, .error').first().waitFor()
        return p
          .getByText(text)
          .first()
          .waitFor({ timeout: 3000 })
          .then(
            () => true,
            () => false,
          )
      },
      { timeout: 20_000, interval: 500 },
    )
    .toBe(true)
    .catch(async (err) => {
      throw new Error(`${target} never showed "${text}"; it showed:\n${await p.locator('main').innerText().catch(() => '?')}`, { cause: err })
    })
}

const request = (title: string, note?: string) =>
  putRecord(founder, ids.communityRequest, { game: { title, releaseYear: 1996, platforms: ['N64'] }, founders: [founder.did], note, createdAt: now() })

describe('admin app', () => {
  it('sets up the platform on first run, with the setup code', async () => {
    page = await signIn(sysadmin)
    await page.getByText('Set up the platform').waitFor()
    await page.fill('input[name=platformHandle]', `plat${randomId(3)}.test`)
    await page.fill('input[name=setupCode]', 'not-the-code')
    await page.click('button:has-text("Create the platform account")')
    await page.getByText('That setup code is not right').waitFor()

    await page.fill('input[name=setupCode]', ADMIN_TOKEN)
    await page.click('button:has-text("Create the platform account")')
    await page.getByRole('heading', { name: 'Community requests' }).waitFor()
    expect(await adminWeb.admin.listSysadmins()).toEqual([sysadmin.did])
  })

  it('creates a community from a request, then adds a game, appoints, freezes and unfreezes', async () => {
    const req = await request('Super Mario 64', 'From the SM64 Discord')
    await reloadUntilShows(page, url('/'), 'From the SM64 Discord')
    await page.getByText(`@${founder.handle}`).first().waitFor()

    const handle = `c${randomId(3)}.test`
    await page.click('button:has-text("Create community")')
    await page.fill('input[name=handle]', handle)
    await page.click('form button:has-text("Create community")')
    await page.locator('.notice.ok:has-text("Created")').waitFor({ timeout: 20_000 })
    const created = await waitFor(async () => (await adminWeb.admin.listRequests('all')).find((r) => r.uri === req.uri && r.community))
    const did = created.community!

    await reloadUntilShows(page, url('/communities'), 'Super Mario 64')
    await page.click(`a:has-text("Super Mario 64")`)
    await page.getByRole('heading', { name: 'Super Mario 64', level: 1 }).waitFor()
    await page.getByText(`@${handle}`).first().waitFor()
    expect(await page.getAttribute('a:has-text("Export repo")', 'href')).toBe(`/api/communities/${encodeURIComponent(did)}/export`)

    // Add a game.
    await page.fill('input[name=gameTitle]', 'Super Mario 64 DS')
    await page.fill('input[name=gameYear]', '2004')
    await page.fill('input[name=gamePlatforms]', 'DS, Wii U VC')
    await page.click('button:has-text("Add game")')
    await page.getByText('Super Mario 64 DS (2004) · DS, Wii U VC').waitFor({ timeout: 20_000 })

    // The founder hasn't accepted, so no moderator is active and a sysadmin may appoint one.
    await page.getByText('Invited, has not accepted yet').waitFor()
    const appointee = await createAccount(env, 'ap')
    await page.fill('input[name=appointee]', appointee.handle)
    await page.fill('textarea[name=reason]', 'Founders never accepted')
    await page.click('button:has-text("Appoint")')
    await page.getByText(`Appointed @${appointee.handle}`).waitFor({ timeout: 20_000 })
    await waitFor(async () => {
      const res = await fetch(new URL(`/xrpc/app.speedrunledger-prototype.listModerators?community=${did}`, appview.url))
      const { moderators } = (await res.json()) as { moderators: { actor: { did: string } }[] }
      return moderators.some((m) => m.actor.did === appointee.did) ? true : undefined
    })

    // Freeze, then unfreeze.
    await page.fill('textarea[name=freezeReason]', 'Leaderboard vandalism')
    await page.getByRole('button', { name: 'Freeze community', exact: true }).click()
    await page.getByRole('button', { name: 'Unfreeze community', exact: true }).waitFor({ timeout: 20_000 })
    await page.locator('.notice:has-text("Frozen")').waitFor()
    await page.fill('textarea[name=freezeReason]', 'Cleaned up')
    await page.getByRole('button', { name: 'Unfreeze community', exact: true }).click()
    await page.getByRole('button', { name: 'Freeze community', exact: true }).waitFor({ timeout: 20_000 })
  })

  it('denies a request with a reason the requester sees', async () => {
    const req = await request('Not a real game')
    await reloadUntilShows(page, url('/'), 'Not a real game')
    const card = page.locator('article.request', { hasText: 'Not a real game' })
    await card.locator('button:has-text("Deny")').click()
    await card.locator('textarea[name=reason]').fill('Please link the game')
    await card.locator('button:has-text("Deny request")').click()
    await page.getByText('Denied the request for Not a real game.').waitFor()
    const denied = await waitFor(async () => (await adminWeb.admin.listRequests('all')).find((r) => r.uri === req.uri && r.status === 'denied'))
    expect(denied.denialReason).toBe('Please link the game')
    await page.goto(url('/'))
    await page.check('input[type=checkbox]')
    await page.getByText('Denied: Please link the game').waitFor({ timeout: 10_000 })
  })

  it('adds and removes sysadmins, and keeps the last one', async () => {
    const other = await createAccount(env, 'sb')
    await page.goto(url('/sysadmins'))
    await page.getByText(`@${sysadmin.handle}`).waitFor()
    expect(await page.locator('li button:has-text("Remove")').count()).toBe(0)

    await page.fill('input[name=newSysadmin]', other.handle)
    await page.click('button:has-text("Add sysadmin")')
    await page.getByText(`@${other.handle} is now a sysadmin.`).waitFor()
    const row = page.locator('li', { hasText: `@${other.handle}` })
    await row.waitFor()
    await row.locator('button:has-text("Remove")').click()
    await row.locator(`button:has-text("Remove @${other.handle}")`).click()
    await row.waitFor({ state: 'detached' })
    expect(await adminWeb.admin.listSysadmins()).toEqual([sysadmin.did])
  })

  it('runs the community service jobs on demand', async () => {
    await page.goto(url('/jobs'))
    const job = page.locator('.panel', { hasText: 'Carry out passed proposals' })
    await job.locator('button:has-text("Run now")').click()
    await job.getByText('Carried out 0 proposal(s).').waitFor()
  })

  it('turns away accounts that are not sysadmins', async () => {
    const stranger = await createAccount(env, 'st')
    const p = await signIn(stranger)
    await p.getByRole('heading', { name: 'Not a sysadmin' }).waitFor()
    expect(await p.locator('nav').count()).toBe(0)
    // Its session cookie gets nothing from the API either.
    const res = await p.request.get(url('/api/requests'))
    expect(res.status()).toBe(403)
    expect((await fetch(url('/api/requests'))).status).toBe(401)
  })
})
