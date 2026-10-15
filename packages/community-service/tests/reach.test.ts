import { verifySignature } from '@atproto/crypto'
import { decodeAll } from '@atproto/lex-cbor'
import { AppViewServer } from '@speedrunledger/appview'
import { ids } from '@speedrunledger/lexicon'
import { createAccount, putRecord, runRecord, setupCommunity, type TestAccount, type TestCommunity, waitFor } from '@speedrunledger/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { unsignedBytes } from '../src/index.js'
import { admin, callAs, type Harness, startHarness } from './helpers.js'

// World-record posts, the feed generator, notifications and labels, against
// the local PDS with a real indexer, AppView and community service.

const NS = 'app.speedrunledger-prototype'
let h: Harness
let appview: AppViewServer
let community: TestCommunity
let mod: TestAccount

beforeAll(async () => {
  h = await startHarness()
  appview = new AppViewServer({ databaseUrl: h.server.config.databaseUrl, port: 0, feedServiceDid: 'did:web:localhost%3A2584' })
  await appview.start()
  community = await setupCommunity(h.env, { moderators: 1 })
  mod = community.moderators[0].account
  await h.server.service.registerAccount({ identifier: community.account.handle, password: community.account.password, pdsUrl: h.env.pdsUrl })
  await waitFor(() => h.db.selectFrom('community_member').select('uri').where('member_did', '=', mod.did).where('active', '=', true).executeTakeFirst())
}, 60_000)

afterAll(async () => {
  await appview?.destroy()
  await h?.stop()
})

const xrpc = async (nsid: string, params: Record<string, string>) => {
  const res = await fetch(new URL(`/xrpc/${nsid}?${new URLSearchParams(params)}`, appview.url))
  return (await res.json()) as any
}

const getRecord = async (repo: string, collection: string, rkey: string) => {
  const url = new URL('/xrpc/com.atproto.repo.getRecord', h.env.pdsUrl)
  url.search = new URLSearchParams({ repo, collection, rkey }).toString()
  const res = await fetch(url)
  return res.ok ? ((await res.json()) as any) : undefined
}

/** Submits and verifies a run, waiting until it is ranked. */
async function verifiedRun(runner: TestAccount, ms: number) {
  const run = await putRecord(runner, ids.run, runRecord(community.categories.sixteenStar, { times: { realTimeMs: ms } }))
  await waitFor(() => h.db.selectFrom('run').select('uri').where('uri', '=', run.uri).executeTakeFirst())
  const verdict = await callAs(h.server, mod, `${NS}.moderation.createVerdict`, { run, status: 'verified' })
  expect(verdict.status).toBe(200)
  await waitFor(() => h.db.selectFrom('board_entry').select('run_uri').where('run_uri', '=', run.uri).executeTakeFirst())
  return run
}

describe('world records on Bluesky', () => {
  it('announces each record from the community, in a feed per game, and notifies the runners', async () => {
    const [first, second] = [await createAccount(h.env, 'wa'), await createAccount(h.env, 'wb')]
    const runA = await verifiedRun(first, 960_000)
    const runB = await verifiedRun(second, 950_250)

    expect((await admin(h.server, 'POST', '/admin/announcements/run')).body).toEqual({ posted: 2 })
    expect((await admin(h.server, 'POST', '/admin/announcements/run')).body).toEqual({ posted: 0 })

    // A feed declaration in the community's repo, keyed like the game.
    const gameRkey = community.game.uri.split('/').pop()!
    const feed = await getRecord(community.account.did, 'app.bsky.feed.generator', gameRkey)
    expect(feed.value).toMatchObject({ did: 'did:web:localhost%3A2584', displayName: 'Super Mario 64 WRs' })

    const rows = await h.db.selectFrom('announcement').selectAll().orderBy('world_record_id').execute()
    expect(rows.map((r) => r.error)).toEqual([null, null])
    const post = await getRecord(community.account.did, 'app.bsky.feed.post', rows[1].post_uri!.split('/').pop()!)
    expect(post.value.text).toBe(
      `New world record! @${second.handle} ran Super Mario 64 16 Star in 15:50.250, beating @${first.handle}’s 16:00.000. See the run`,
    )
    const text = Buffer.from(post.value.text)
    const facetText = (f: any) => text.subarray(f.index.byteStart, f.index.byteEnd).toString()
    expect(post.value.facets.map((f: any) => [facetText(f), f.features[0].did ?? f.features[0].uri])).toEqual([
      [`@${second.handle}`, second.did],
      [`@${first.handle}`, first.did],
      ['See the run', `http://127.0.0.1:2585/run?${new URLSearchParams({ uri: runB.uri })}`],
    ])

    // The feed generator serves the posts newest first.
    const skeleton = await xrpc('app.bsky.feed.getFeedSkeleton', { feed: feed.uri })
    expect(skeleton.feed.map((p: any) => p.post)).toEqual([rows[1].post_uri, rows[0].post_uri])
    const described = await xrpc('app.bsky.feed.describeFeedGenerator', {})
    expect(described.feeds.map((f: any) => f.uri)).toContain(feed.uri)

    // The progression and both runners' notifications.
    const { records } = await xrpc(`${NS}.listWorldRecords`, { category: community.categories.sixteenStar.uri })
    expect(records.map((r: any) => [r.run.uri, r.rankedMs, r.previous?.did, r.announcement])).toEqual([
      [runB.uri, 950_250, first.did, rows[1].post_uri],
      [runA.uri, 960_000, undefined, rows[0].post_uri],
    ])
    const forFirst = await xrpc(`${NS}.listNotifications`, { actor: first.did })
    expect(forFirst.notifications.map((n: any) => n.reason).sort()).toEqual(['verified', 'worldRecord', 'worldRecordBeaten'])
    expect(forFirst.notifications.find((n: any) => n.reason === 'worldRecordBeaten')).toMatchObject({
      subject: runB.uri,
      author: { did: second.did },
      text: '16 Star in 15:50.250',
    })
  }, 60_000)
})

describe('labels', () => {
  it('flags a run as suspected cheating with a signed label anyone can check', async () => {
    const runner = await createAccount(h.env, 'lr')
    const run = await putRecord(runner, ids.run, runRecord(community.categories.seventyStar))
    await waitFor(() => h.db.selectFrom('run').select('uri').where('uri', '=', run.uri).executeTakeFirst())

    const flagged = await callAs(h.server, mod, `${NS}.moderation.flagRun`, { run: run.uri, flag: true, reason: 'Audio cuts at 12:40' })
    expect(flagged.status).toBe(200)
    expect((await callAs(h.server, mod, `${NS}.moderation.flagRun`, { run: run.uri, flag: true })).body.error).toBe('NoChange')
    expect((await callAs(h.server, runner, `${NS}.moderation.flagRun`, { run: run.uri, flag: false })).body.error).toBe('NotModerator')

    // queryLabels returns it signed by the key in the service's DID document.
    const did = (await (await fetch(`${h.server.url}/.well-known/did.json`)).json()) as any
    const key = did.verificationMethod.find((m: any) => m.id.endsWith('#atproto_label'))
    expect(did.service.map((s: any) => s.id)).toContain('#atproto_labeler')
    const { labels } = (await (
      await fetch(`${h.server.url}/xrpc/com.atproto.label.queryLabels?${new URLSearchParams({ uriPatterns: `at://${runner.did}/*` })}`)
    ).json()) as any
    expect(labels).toEqual([
      { ver: 1, src: h.server.config.serviceDid, uri: run.uri, val: 'suspected-cheating', cts: expect.any(String), sig: { $bytes: expect.any(String) } },
    ])
    const sig = new Uint8Array(Buffer.from(labels[0].sig.$bytes, 'base64'))
    expect(await verifySignature(`did:key:${key.publicKeyMultibase}`, unsignedBytes(labels[0]), sig)).toBe(true)

    // The run view and the runner's notifications show it.
    const view = await xrpc(`${NS}.getRun`, { uri: run.uri })
    expect(view.run.labels).toEqual([
      { val: 'suspected-cheating', src: h.server.config.serviceDid, cts: labels[0].cts, moderator: { did: mod.did, handle: mod.handle }, reason: 'Audio cuts at 12:40' },
    ])
    const { notifications } = await xrpc(`${NS}.listNotifications`, { actor: runner.did })
    expect(notifications[0]).toMatchObject({ reason: 'flagged', subject: run.uri, text: 'Audio cuts at 12:40' })

    // subscribeLabels streams the label and its removal.
    const ws = new WebSocket(`${h.server.url.replace('http', 'ws')}/xrpc/com.atproto.label.subscribeLabels?cursor=0`)
    const frames: any[] = []
    ws.on('message', (data: Buffer) => frames.push([...decodeAll(new Uint8Array(data))]))
    await waitFor(async () => (frames.some(([, body]) => body.labels[0].uri === run.uri) ? true : undefined))
    expect((await callAs(h.server, mod, `${NS}.moderation.flagRun`, { run: run.uri, flag: false })).status).toBe(200)
    await waitFor(async () => (frames.some(([, body]) => body.labels[0].uri === run.uri && body.labels[0].neg) ? true : undefined))
    ws.close()
    expect(frames[0][0]).toEqual({ op: 1, t: '#labels' })
    expect((await xrpc(`${NS}.getRun`, { uri: run.uri })).run.labels).toBeUndefined()
  }, 60_000)
})
