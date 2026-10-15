import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { AppViewServer } from '@speedrunledger/appview'
import { CommunityServiceServer } from '@speedrunledger/community-service'
import { IndexerService, readConfig as readIndexerConfig } from '@speedrunledger/indexer'
import { ids } from '@speedrunledger/lexicon'
import { RunnerWeb } from '@speedrunledger/runner-web/server/index.js'
import { cookieName } from '@speedrunledger/web-auth'
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
import { chromiumPath, freePort, signInWithOAuth } from '@speedrunledger/testkit/browser'
import { type Browser, chromium, type Page } from 'playwright-core'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ModeratorWeb } from '../server/index.js'

// The Moderator app's review verdicts and votes, driven through the browser:
// categories and rules voted in until runners can use them, kicks and lifted
// bans carried out by the community service, dead video links, and one
// account signed in to both web apps at once.

const SERVICE_DID = 'did:web:localhost%3A2586'
const COOKIE_SECRET = 'e2e-cookie-secret-that-is-at-least-32-chars'

let env: DevEnv
let indexer: IndexerService
let appview: AppViewServer
let communityService: CommunityServiceServer
let moderatorWeb: ModeratorWeb
let runnerWeb: RunnerWeb
let browser: Browser
let dropDb: () => Promise<void>
/** Serves the runs' video links: /gone answers 404, anything else 200. */
let videos: Server
let videoBase: string

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
      pdsUrl: env.pdsUrl,
      executorIntervalMs: 0,
      videoCheckIntervalMs: 0,
      devMode: true,
      labelerSigningKey: randomBytes(32).toString('hex'),
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
    cookieSecret: COOKIE_SECRET,
    devPdsUrl: env.pdsUrl,
    plcUrl: env.plcUrl,
    viteDev: true,
  })
  await moderatorWeb.start()
  // The Runner app on the same database and cookie secret, as in the dev stack.
  const runnerPort = await freePort()
  runnerWeb = new RunnerWeb({
    port: runnerPort,
    publicUrl: `http://127.0.0.1:${runnerPort}`,
    databaseUrl: database.url,
    appviewUrl: appview.url,
    cookieSecret: COOKIE_SECRET,
    devPdsUrl: env.pdsUrl,
    plcUrl: env.plcUrl,
    viteDev: true,
  })
  await runnerWeb.start()
  videos = createServer((req, res) => {
    res.statusCode = req.url?.startsWith('/gone') ? 404 : 200
    res.end()
  })
  await new Promise<void>((resolve) => videos.listen(0, '127.0.0.1', resolve))
  videoBase = `http://127.0.0.1:${(videos.address() as { port: number }).port}`
  browser = await chromium.launch({ executablePath: chromiumPath })
  await new Promise((resolve) => setTimeout(resolve, 500))
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await runnerWeb?.destroy()
  await moderatorWeb?.destroy()
  await communityService?.destroy()
  await appview?.destroy()
  await indexer?.destroy()
  await new Promise((resolve) => videos?.close(resolve))
  await dropDb?.()
})

const xrpc = async (nsid: string, params: Record<string, string>) =>
  (await fetch(new URL(`/xrpc/app.speedrunledger-prototype.${nsid}?${new URLSearchParams(params)}`, appview.url))).json() as Promise<any>

/** A fresh community per test, so open proposals and rosters don't leak between tests. */
async function newCommunity(moderators: number): Promise<TestCommunity> {
  const community = await setupCommunity(env, { moderators })
  await communityService.service.registerAccount({
    identifier: community.account.handle,
    password: community.account.password,
    pdsUrl: env.pdsUrl,
  })
  return community
}

/** A run with a video link that works (or, with `gone`, one that answers 404), so the video check stays local. */
const run = (community: TestCommunity, realTimeMs: number, gone = false) =>
  runRecord(community.categories.sixteenStar, {
    times: { realTimeMs },
    videos: [{ url: `${videoBase}/${gone ? 'gone' : 'ok'}/${randomBytes(4).toString('hex')}` }],
  })

/** Has the community account verify a run directly, and waits until it is ranked. */
async function verifyDirectly(community: TestCommunity, ref: { uri: string; cid: string }) {
  await waitFor(() => indexer.indexer.db.selectFrom('run').select('uri').where('uri', '=', ref.uri).executeTakeFirst())
  await putRecord(community.account, ids.verification, {
    subject: ref,
    status: 'verified',
    reviewer: community.moderators[0].account.did,
    createdAt: now(),
  })
  await waitFor(() => indexer.indexer.db.selectFrom('board_entry').select('run_uri').where('run_uri', '=', ref.uri).executeTakeFirst())
}

const boardEntries = async (category: string) => ((await xrpc('getLeaderboard', { category })).entries ?? []) as any[]

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
    .catch(async (err) => {
      throw new Error(`${url} never got ready; it showed:\n${await page.locator('main').innerText().catch(() => '?')}`, { cause: err })
    })
}

/** True once `text` shows up on the page, waiting a little for its data to load. */
const shows = (page: Page, text: string) =>
  page
    .getByText(text)
    .first()
    .waitFor({ timeout: 3000 })
    .then(
      () => true,
      () => false,
    )

const signIn = async (who: { handle: string; password: string }) => {
  const page = await browser.newPage()
  await signInWithOAuth(page, { appUrl: moderatorWeb.config.publicUrl, pdsUrl: env.pdsUrl, handle: who.handle, password: who.password })
  return page
}
const manage = (community: TestCommunity, tab: string) =>
  `${moderatorWeb.config.publicUrl}/community?${new URLSearchParams({ did: community.account.did, tab })}`
const review = (uri: string) => `${moderatorWeb.config.publicUrl}/review?${new URLSearchParams({ uri })}`
const execute = () =>
  fetch(new URL('/admin/proposals/execute', communityService.url), {
    method: 'POST',
    headers: { authorization: 'Bearer e2e-admin', 'content-type': 'application/json' },
    body: '{}',
  })

/** After a propose button: waits for the app to switch to the proposals tab, failing on a form error. */
async function proposed(page: Page) {
  await page.locator('h2:has-text("Open"), form .error').first().waitFor()
  expect(await page.locator('form .error').allInnerTexts()).toEqual([])
}

/**
 * Votes yes on the open proposal made for `reason` (its title can change once
 * carried out); the community service then carries it out.
 */
async function voteYesAndCarryOut(page: Page, community: TestCommunity, reason: string, why: string) {
  const proposal = page.locator('article.proposal', { hasText: reason })
  await reloadUntil(page, manage(community, 'proposals'), async () => (await proposal.getByText('Vote yes').count()) > 0)
  await proposal.locator('input[placeholder="Why (optional)"]').fill(why)
  await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/votes') && r.ok()), proposal.locator('button:has-text("Vote yes")').click()])
  await reloadUntil(page, manage(community, 'proposals'), async () => {
    await execute()
    return (await proposal.getByText('carried out').count()) > 0
  })
  await proposal.getByText(`voted yes: ${why}`).waitFor()
}

describe('review verdicts', () => {
  it('rejects a run with a reason the runner sees', async () => {
    const community = await newCommunity(1)
    const runner = await createAccount(env, 'rj')
    const ref = await putRecord(runner, ids.run, run(community, 899_000))
    const page = await signIn(community.moderators[0].account)

    await reloadUntil(page, review(ref.uri), () => shows(page, 'Record verdict'))
    await page.check('input[value=rejected]')
    // Retime fields are only for verifying.
    expect(await page.locator('input[name=retime-realTime]').count()).toBe(0)
    await page.click('button:has-text("Record verdict")')
    await page.getByText('Tell the runner why').waitFor()
    await page.fill('textarea[name=reason]', 'The video is of a different run')
    await page.click('button:has-text("Record verdict")')
    await page.getByText('Verdict recorded').waitFor()

    const view = await waitFor(async () => {
      const res = await xrpc('getRun', { uri: ref.uri })
      return res.run?.status === 'rejected' ? res.run : undefined
    })
    expect(view.verdicts).toEqual([
      expect.objectContaining({ status: 'rejected', reason: 'The video is of a different run', reviewer: expect.objectContaining({ did: community.moderators[0].account.did }) }),
    ])
    expect(await boardEntries(community.categories.sixteenStar.uri)).toEqual([])
    await reloadUntil(page, page.url(), () => shows(page, 'Nothing to review'))
    await page.close()
  }, 120_000)

  it('retimes a verified run from the review page, and the board ranks the new time', async () => {
    const community = await newCommunity(2)
    const runner = await createAccount(env, 'rt')
    const ref = await putRecord(runner, ids.run, run(community, 910_000))
    await verifyDirectly(community, ref)
    expect((await boardEntries(community.categories.sixteenStar.uri))[0]).toMatchObject({ rankedMs: 910_000 })

    // The other moderator watches the video again and corrects the time.
    const mod = community.moderators[1].account
    const page = await signIn(mod)
    await reloadUntil(page, review(ref.uri), () => shows(page, 'Record verdict'))
    await page.locator('p .status.verified').waitFor()
    expect(await page.isChecked('input[value=verified]')).toBe(true)
    expect(await page.getAttribute('input[name=retime-realTime]', 'placeholder')).toBe('15:10.000')
    await page.fill('input[name=retime-realTime]', '15:09.250')
    await page.fill('textarea[name=reason]', 'Timing starts at the first frame of the fade')
    await page.click('button:has-text("Record verdict")')
    await page.getByText('Verdict recorded').waitFor()

    const entries = await waitFor(async () => {
      const res = await boardEntries(community.categories.sixteenStar.uri)
      return res[0]?.rankedMs === 909_250 ? res : undefined
    })
    expect(entries).toEqual([expect.objectContaining({ rank: 1, run: expect.objectContaining({ uri: ref.uri, verifiedTimes: { realTimeMs: 909_250 } }) })])

    await reloadUntil(page, review(ref.uri), async () => (await page.locator('ul.verdicts li').count()) === 2)
    await page.getByText('Timing starts at the first frame of the fade').waitFor()
    await page.close()
  }, 120_000)
})

describe('video links', () => {
  it('lists ranked runs whose video link is gone, after the community service checks them', async () => {
    const community = await newCommunity(1)
    const [fine, broken] = [await createAccount(env, 'vf'), await createAccount(env, 'vb')]
    await verifyDirectly(community, await putRecord(fine, ids.run, run(community, 900_000)))
    const gone = await putRecord(broken, ids.run, run(community, 920_000, true))
    await verifyDirectly(community, gone)

    const page = await signIn(community.moderators[0].account)
    await reloadUntil(page, manage(community, 'videos'), () => shows(page, 'Every checked link works.'))

    const check = await fetch(new URL('/admin/videos/check', communityService.url), {
      method: 'POST',
      headers: { authorization: 'Bearer e2e-admin', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(check.ok).toBe(true)
    expect(await check.json()).toMatchObject({ dead: 1 })

    await reloadUntil(page, manage(community, 'videos'), async () => (await page.locator('table.queue tbody tr').count()) > 0)
    const rows = await page.locator('table.queue tbody tr').allInnerTexts()
    const deadUrl = (await xrpc('getRun', { uri: gone.uri })).run.videos[0].url
    expect(rows).toEqual([expect.stringMatching(new RegExp(`^@${broken.handle.replace(/\./g, '\\.')}\\s+2\\s+${deadUrl.replace(/[.?]/g, '\\$&')} Not found \\(HTTP 404\\)\\s+\\d{4}-`))])

    // The runner's name leads to the run's review page, which marks the dead link.
    await page.click(`table.queue >> text=@${broken.handle}`)
    await page.waitForURL(/\/review\?/)
    await page.getByText('(dead link)').waitFor()
    await page.close()
  }, 120_000)
})

describe('votes', () => {
  it('proposes a new category and its rules, and a second moderator votes them in until runners can submit', async () => {
    const community = await newCommunity(2)
    const [a, b] = community.moderators.map((m) => m.account)

    // A proposes the category from "Games and categories".
    const pageA = await signIn(a)
    await reloadUntil(pageA, manage(community, 'games'), () => shows(pageA, 'Propose a category'))
    await pageA.click('button:has-text("Propose a category")')
    const form = pageA.locator('.category-form')
    await form.getByText('New category').waitFor()
    await form.locator('input[name=name]').fill('120 Star')
    await form.locator('textarea').first().fill('Collect all 120 stars')
    await form.locator('label.check', { hasText: 'In-game time' }).locator('input').check()
    await form.locator('textarea').nth(1).fill('The full-game category everyone asks for')
    await form.getByRole('button', { name: 'Propose', exact: true }).click()
    await proposed(pageA)
    await reloadUntil(pageA, manage(community, 'proposals'), () => shows(pageA, 'Add category “120 Star”'))
    await pageA.locator('article.proposal', { hasText: 'Add category “120 Star”' }).getByText('1 yes, 0 no; 2 of 2 needed').waitFor()

    // B votes it in; the community service writes the category.
    const pageB = await signIn(b)
    await voteYesAndCarryOut(pageB, community, 'The full-game category everyone asks for', 'Long overdue')
    const category = await waitFor(async () => {
      const res = await xrpc('getCommunity', { community: community.account.did })
      return res.community.games[0].categories.find((c: any) => c.name === '120 Star')
    })
    expect(category).toMatchObject({
      name: '120 Star',
      description: 'Collect all 120 stars',
      primaryTiming: 'realTime',
      timingMethods: ['realTime', 'gameTime'],
      requiresVideo: true,
      requiredApprovals: 1,
    })
    expect(category.uri.startsWith(`at://${community.account.did}/${ids.category}/`)).toBe(true)
    // The community's repo holds exactly the record voted on, description included.
    const written = new URL('/xrpc/com.atproto.repo.getRecord', env.pdsUrl)
    written.search = new URLSearchParams({ repo: community.account.did, collection: ids.category, rkey: category.uri.split('/').pop()! }).toString()
    expect(((await (await fetch(written)).json()) as any).value).toMatchObject({ name: '120 Star', description: 'Collect all 120 stars' })

    // A proposes its rules from the new row.
    await reloadUntil(pageA, manage(community, 'games'), () => shows(pageA, '120 Star'))
    await pageA.locator('tr', { hasText: '120 Star' }).getByRole('button', { name: 'Propose rules' }).click()
    const rules = pageA.locator('form:has(textarea[name=rules])')
    await rules.locator('textarea[name=rules]').fill('Timing starts on the Nintendo logo and ends on the final star grab.')
    await rules.locator('textarea:not([name=rules])').fill('Same timing as 70 Star')
    await rules.getByRole('button', { name: 'Propose rules' }).click()
    await proposed(pageA)
    await reloadUntil(pageA, manage(community, 'proposals'), () => shows(pageA, 'New rules for “120 Star”'))

    await voteYesAndCarryOut(pageB, community, 'Same timing as 70 Star', 'Clear enough')
    const live = await waitFor(async () => {
      const res = await xrpc('getLeaderboard', { category: category.uri })
      return res.category?.ruleset ? res : undefined
    })
    expect(live.category.ruleset.text).toBe('Timing starts on the Nintendo logo and ends on the final star grab.')

    // Live: a runner sees the board with its rules and can submit to it.
    const runner = await createAccount(env, 'cr')
    const runnerPage = await browser.newPage()
    await signInWithOAuth(runnerPage, { appUrl: runnerWeb.config.publicUrl, pdsUrl: env.pdsUrl, handle: runner.handle, password: runner.password })
    await runnerPage.goto(`${runnerWeb.config.publicUrl}/board?${new URLSearchParams({ category: category.uri })}`)
    await runnerPage.locator('h1:has-text("Super Mario 64 — 120 Star")').waitFor()
    expect(await runnerPage.locator('.category-description').innerText()).toBe('Collect all 120 stars')
    await runnerPage.click('summary:has-text("Rules")')
    await runnerPage.getByText('ends on the final star grab').waitFor()
    await runnerPage.click('text=Submit a run')
    await runnerPage.fill('input[name=realTime]', '1:39:28.000')
    await runnerPage.fill('input[name=gameTime]', '1:38:50.000')
    await runnerPage.fill('input[name=video]', `${videoBase}/ok/120`)
    await runnerPage.check('input[name=acknowledge]')
    await runnerPage.click('button:has-text("Submit run")')
    await runnerPage.waitForURL(/\/run\?/)
    await runnerPage.getByText('Waiting for review').waitFor({ timeout: 20_000 })
    const runUri = new URL(runnerPage.url()).searchParams.get('uri')!
    const { run: submitted } = await xrpc('getRun', { uri: runUri })
    expect(submitted).toMatchObject({ category: category.uri, times: { realTimeMs: 5_968_000, gameTimeMs: 5_930_000 }, problems: [] })
    // The run names the rules it was run under.
    const record = new URL('/xrpc/com.atproto.repo.getRecord', env.pdsUrl)
    record.search = new URLSearchParams({ repo: runner.did, collection: ids.run, rkey: runUri.split('/').pop()! }).toString()
    expect(((await (await fetch(record)).json()) as any).value.ruleset).toEqual({ uri: live.category.ruleset.uri, cid: live.category.ruleset.cid })
    await Promise.all([pageA.close(), pageB.close(), runnerPage.close()])
  }, 180_000)

  it('shows a category’s description, and keeps it when proposing changes to the category', async () => {
    const community = await newCommunity(2)
    const [a, b] = community.moderators.map((m) => m.account)
    const category = await putRecord(community.account, ids.category, {
      game: community.game,
      name: 'Any%',
      description: 'Beat Bowser as fast as possible, any route',
      kind: 'time',
      sort: 'asc',
      primaryTiming: 'realTime',
      createdAt: now(),
    })

    const pageA = await signIn(a)
    const row = pageA.locator('tr', { hasText: 'Any%' })
    await reloadUntil(pageA, manage(community, 'games'), () => shows(pageA, 'Beat Bowser as fast as possible'))
    expect(await row.locator('.category-description').innerText()).toBe('Beat Bowser as fast as possible, any route')

    // Asking for two approvals leaves the description as it was.
    await row.getByRole('button', { name: 'Propose changes' }).click()
    const form = pageA.locator('.category-form')
    await form.getByText('Change “Any%”').waitFor()
    expect(await form.locator('textarea').first().inputValue()).toBe('Beat Bowser as fast as possible, any route')
    await form.locator('input[name=approvals]').fill('2')
    await form.locator('textarea').nth(1).fill('Any% records deserve a second pair of eyes')
    await form.getByRole('button', { name: 'Propose', exact: true }).click()
    await proposed(pageA)
    await reloadUntil(pageA, manage(community, 'proposals'), () => shows(pageA, 'Change category “Any%”'))

    const pageB = await signIn(b)
    await voteYesAndCarryOut(pageB, community, 'Any% records deserve a second pair of eyes', 'Agreed')
    const changed = await waitFor(async () => {
      const res = await xrpc('getLeaderboard', { category: category.uri })
      return res.category?.requiredApprovals === 2 ? res.category : undefined
    })
    expect(changed).toMatchObject({ uri: category.uri, name: 'Any%', description: 'Beat Bowser as fast as possible, any route' })
    await reloadUntil(pageB, manage(community, 'games'), async () => (await pageB.locator('tr', { hasText: 'Any%' }).locator('td').nth(2).innerText()) === '2')
    expect(await pageB.locator('tr', { hasText: 'Any%' }).locator('.category-description').innerText()).toBe('Beat Bowser as fast as possible, any route')
    await Promise.all([pageA.close(), pageB.close()])
  }, 180_000)

  it('removes a moderator by vote', async () => {
    const community = await newCommunity(3)
    const [a, b, c] = community.moderators.map((m) => m.account)

    const pageA = await signIn(a)
    // Wait for all three acceptances, so all three count toward the majority.
    await reloadUntil(pageA, manage(community, 'moderators'), async () => (await pageA.locator('table.roster tbody tr', { hasText: 'Active' }).count()) === 3)
    // Nobody can propose removing themselves from the roster.
    expect(await pageA.locator('table.roster tbody tr', { hasText: a.handle }).getByText('Propose removal').count()).toBe(0)
    await pageA.locator('table.roster tbody tr', { hasText: c.handle }).getByRole('button', { name: 'Propose removal' }).click()
    await pageA.getByRole('textbox', { name: `Why remove @${c.handle}?` }).fill('Has not reviewed anything in a year')
    await pageA.locator('form', { has: pageA.getByRole('textbox', { name: `Why remove @${c.handle}?` }) }).getByRole('button', { name: 'Propose removal' }).click()
    await proposed(pageA)
    await reloadUntil(pageA, manage(community, 'proposals'), () => shows(pageA, `Remove @${c.handle} as a moderator`))
    // The moderator being removed has no vote on it.
    expect(await pageA.locator('article.proposal .tally').innerText()).toBe('1 yes, 0 no; 2 of 2 needed')

    const pageB = await signIn(b)
    await voteYesAndCarryOut(pageB, community, 'Has not reviewed anything in a year', 'Sadly yes')

    await reloadUntil(pageB, manage(community, 'moderators'), async () => (await pageB.locator('table.roster tbody tr').count()) === 2)
    expect(await pageB.locator('table.roster tbody tr', { hasText: c.handle }).count()).toBe(0)
    const { moderators } = await xrpc('listModerators', { community: community.account.did })
    expect(moderators.map((m: any) => m.actor.did).sort()).toEqual([a.did, b.did].sort())

    // The removed moderator can look, but not act.
    const pageC = await signIn(c)
    await reloadUntil(pageC, manage(community, 'moderators'), () => shows(pageC, 'You are not an active moderator here'))
    expect(await pageC.getByText('Invite a moderator').count()).toBe(0)
    await Promise.all([pageA.close(), pageB.close(), pageC.close()])
  }, 180_000)

  it('lifts a ban by vote, and the runner’s runs return to the board', async () => {
    const community = await newCommunity(2)
    const [a, b] = community.moderators.map((m) => m.account)
    const runner = await createAccount(env, 'lb')
    const ref = await putRecord(runner, ids.run, run(community, 905_000))
    await verifyDirectly(community, ref)

    const pageA = await signIn(a)
    await reloadUntil(pageA, manage(community, 'bans'), () => shows(pageA, 'Ban a runner'))
    await pageA.fill('input[name=banned]', runner.handle)
    await pageA.fill('textarea', 'Suspected splice')
    await pageA.click('form button:has-text("Ban")')
    await pageA.getByText(`Banned @${runner.handle}`).waitFor()
    await waitFor(async () => ((await boardEntries(community.categories.sixteenStar.uri)).length === 0 ? true : undefined))

    // The splice turned out to be a capture card glitch.
    await reloadUntil(pageA, manage(community, 'bans'), () => shows(pageA, 'Propose lifting'))
    await pageA.click('button:has-text("Propose lifting")')
    await pageA.locator('tr textarea').fill('The splice was a capture card glitch')
    await pageA.click('button:has-text("Propose lifting the ban")')
    await proposed(pageA)
    await reloadUntil(pageA, manage(community, 'proposals'), () => shows(pageA, `Lift the ban on @${runner.handle}`))

    const pageB = await signIn(b)
    await voteYesAndCarryOut(pageB, community, 'The splice was a capture card glitch', 'Checked the footage')

    // The decided proposal still names the runner, although the ban record is gone.
    await pageB.locator('article.proposal', { hasText: 'The splice was a capture card glitch' }).getByText(`Lift the ban on @${runner.handle}`).waitFor()
    const { proposals } = await xrpc('listProposals', { community: community.account.did, status: 'closed' })
    expect(proposals[0]).toMatchObject({ actionType: 'liftBan', subject: { did: runner.did, handle: runner.handle } })
    await reloadUntil(pageB, manage(community, 'bans'), () => shows(pageB, 'Nobody is banned.'))
    expect((await xrpc('listBans', { community: community.account.did })).bans).toEqual([])
    const entries = await waitFor(async () => {
      const res = await boardEntries(community.categories.sixteenStar.uri)
      return res.length === 1 ? res : undefined
    })
    expect(entries[0]).toMatchObject({ rank: 1, run: { uri: ref.uri } })
    await Promise.all([pageA.close(), pageB.close()])
  }, 180_000)

  it('lets one account signed in to both apps (Runner app last) still vote in the Moderator app', async () => {
    const community = await newCommunity(2)
    const [a, b] = community.moderators.map((m) => m.account)
    const newcomer = await createAccount(env, 'xa')
    await putRecord(a, ids.communityProposal, {
      community: community.account.did,
      action: { $type: `${ids.communityProposal}#invite`, subject: newcomer.did },
      reason: 'Signed in to both apps',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: now(),
    })

    // One browser: B signs in to the Moderator app, then to the Runner app.
    const context = await browser.newContext()
    const moderatorPage = await context.newPage()
    await signInWithOAuth(moderatorPage, { appUrl: moderatorWeb.config.publicUrl, pdsUrl: env.pdsUrl, handle: b.handle, password: b.password })
    const runnerPage = await context.newPage()
    await signInRunnerApp(runnerPage, b)

    // Back in the Moderator app, B is still signed in with the Moderator app's own session and can vote.
    const proposal = moderatorPage.locator('article.proposal', { hasText: `Invite @${newcomer.handle}` })
    await reloadUntil(moderatorPage, manage(community, 'proposals'), async () => (await proposal.getByText('Vote yes').count()) > 0)
    const [response] = await Promise.all([
      moderatorPage.waitForResponse((r) => r.url().endsWith('/api/votes')),
      proposal.locator('button:has-text("Vote yes")').click(),
    ])
    expect({ status: response.status(), body: await response.text() }).toMatchObject({ status: 200 })
    expect(await proposal.locator('.error').count()).toBe(0)
    const tally = await waitFor(async () => {
      const { proposals } = await xrpc('listProposals', { community: community.account.did, status: 'closed' })
      return proposals?.[0]
    })
    expect(tally).toMatchObject({ status: 'passed', yes: 2 })
    expect(tally.votes).toContainEqual(expect.objectContaining({ voter: expect.objectContaining({ did: b.did }), value: 'yes' }))

    // And the Runner app still works for them too.
    await runnerPage.reload()
    await runnerPage.getByText(b.handle).first().waitFor()
    await context.close()
  }, 180_000)

  it('keeps two different accounts signed in, one per app, in the same browser', async () => {
    const community = await newCommunity(1)
    const mod = community.moderators[0].account
    const runner = await createAccount(env, 'xr')

    const context = await browser.newContext()
    const moderatorPage = await context.newPage()
    await signInWithOAuth(moderatorPage, { appUrl: moderatorWeb.config.publicUrl, pdsUrl: env.pdsUrl, handle: mod.handle, password: mod.password })
    const runnerPage = await context.newPage()
    await signInRunnerApp(runnerPage, runner)

    // Both apps live on 127.0.0.1, where cookies ignore the port: each needs its own cookie.
    const names = (await context.cookies('http://127.0.0.1')).map((c) => c.name).sort()
    expect(names).toEqual([cookieName(moderatorWeb.config.publicUrl), cookieName(runnerWeb.config.publicUrl)].sort())
    expect(names[0]).not.toBe(names[1])

    const me = async (page: Page) => (await page.evaluate(() => fetch('/api/me').then((r) => r.json()))) as { did?: string }
    expect(await me(moderatorPage)).toMatchObject({ did: mod.did })
    expect(await me(runnerPage)).toMatchObject({ did: runner.did })

    await reloadUntil(moderatorPage, moderatorWeb.config.publicUrl, () => shows(moderatorPage, 'Review queue'))
    await moderatorPage.locator('header').getByText(mod.handle).waitFor()
    expect(await moderatorPage.locator('header').getByText(runner.handle).count()).toBe(0)
    await runnerPage.reload()
    await runnerPage.locator('header').getByText(runner.handle).waitFor()
    expect(await runnerPage.locator('header').getByText(mod.handle).count()).toBe(0)

    // Signing out of one app leaves the other signed in.
    await runnerPage.click('header button:has-text("Sign out")')
    await runnerPage.locator('input[aria-label="Your handle"]').waitFor()
    expect(await me(moderatorPage)).toMatchObject({ did: mod.did })
    await context.close()
  }, 180_000)
})

/**
 * Signs in to the Runner app in a browser that is already signed in to the
 * PDS (from the Moderator app), so the PDS may skip its password page.
 */
async function signInRunnerApp(page: Page, who: TestAccount) {
  await page.goto(runnerWeb.config.publicUrl)
  await page.fill('input[aria-label="Your handle"]', who.handle)
  await page.click('button:has-text("Sign in")')
  await page.waitForURL((url) => url.port === new URL(env.pdsUrl).port)
  const password = page.locator('input[name=password]')
  const authorize = page.locator('button:has-text("Authorize")')
  await password.or(authorize).first().waitFor()
  if (await password.isVisible()) {
    await password.fill(who.password)
    await page.click('button[type=submit]')
  }
  await authorize.click()
  await page.waitForURL((url) => url.origin === runnerWeb.config.publicUrl)
  await page.getByText(who.handle).first().waitFor()
}
