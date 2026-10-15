import type { Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Client } from '@atproto/lex'
import { createDb, type Database, migrateToLatest } from '@speedrunledger/db'
import { ledger, type RunRecord } from '@speedrunledger/lexicon'
import { serveClient, WebAuth, xrpcProxy } from '@speedrunledger/web-auth'
import express, { type Response } from 'express'
import type { RunnerWebConfig } from './config.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', here.endsWith(join('dist', 'server')) ? '..' : '')

/** Records the Runner app writes into the signed-in runner's own repo. */
export const RUNNER_SCOPE = [
  'atproto',
  `repo:${ledger.run.$nsid}`,
  `repo:${ledger.runParticipant.$nsid}`,
  `repo:${ledger.community.request.$nsid}`,
  // Share to Bluesky: a post in the runner's own repo linking the run.
  'repo:app.bsky.feed.post?action=create',
].join(' ')

/** 15:02.340 or 1:02:03.000. */
function formatMs(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const sec = Math.floor((ms % 60_000) / 1000)
  const rest = String(ms % 1000).padStart(3, '0')
  return `${h > 0 ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(sec).padStart(2, '0')}.${rest}`
}

const STATUS_TEXT: Record<string, string> = {
  verified: 'verified',
  pending: 'waiting for review',
  changesRequested: 'waiting for changes',
  rejected: 'rejected',
  invalid: 'not valid',
}

/**
 * The Bluesky post for sharing a run: what it was, its status and rank, and a
 * link to it, both as a facet and as an external card.
 */
export function sharePost(
  run: { uri: string; status: string; rank?: number; times: Record<string, number | undefined>; verifiedTimes?: Record<string, number | undefined> },
  context: { game: string; category: string; primaryTiming: string },
  runUrl: string,
) {
  const key = `${context.primaryTiming}Ms`
  const ms = (run.verifiedTimes ?? run.times)[key] ?? run.times[key]
  const time = ms === undefined ? '' : ` in ${formatMs(ms)}`
  const standing = run.status === 'verified' && run.rank ? `, rank ${run.rank}` : ''
  const head = `I ran ${context.game} ${context.category}${time} (${STATUS_TEXT[run.status] ?? run.status}${standing}). `
  const link = 'See the run'
  const byteStart = Buffer.byteLength(head)
  return {
    $type: 'app.bsky.feed.post',
    text: head + link,
    facets: [
      {
        index: { byteStart, byteEnd: byteStart + Buffer.byteLength(link) },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: runUrl }],
      },
    ],
    embed: {
      $type: 'app.bsky.embed.external',
      external: { uri: runUrl, title: `${context.game} ${context.category}${time}`, description: 'On SpeedrunLedger: runs in runners’ own repos, verified by game communities.' },
    },
    langs: ['en'],
    createdAt: new Date().toISOString(),
  }
}

/** Builds the run record from the form, adding timestamps; throws on invalid input. */
export function buildRun(input: Record<string, unknown>): RunRecord {
  const now = new Date().toISOString()
  const record = { ...input, $type: ledger.run.$type, createdAt: now, performedAt: input.performedAt ?? now }
  const result = ledger.run.$safeParse(record)
  if (!result.success) throw new Error(String(result.reason))
  return result.value
}

const clientOf = (res: Response) => res.locals.client as Client

export class RunnerWeb {
  readonly db: Database
  readonly auth: WebAuth
  private server?: Server

  constructor(readonly config: RunnerWebConfig) {
    this.db = createDb(config.databaseUrl, { max: 5 })
    this.auth = new WebAuth(
      {
        publicUrl: config.publicUrl,
        clientName: 'SpeedrunLedger',
        scope: RUNNER_SCOPE,
        cookieSecret: config.cookieSecret,
        handleResolverUrl: config.devPdsUrl,
        plcUrl: config.plcUrl,
        allowHttp: config.devPdsUrl !== undefined,
      },
      this.db,
    )
  }

  async app(): Promise<express.Express> {
    const app = express()
    app.disable('x-powered-by')
    app.use(express.json({ limit: '100kb' }))
    app.use(this.auth.router())

    app.post('/api/runs', this.auth.requireUser, async (req, res) => {
      let record
      try {
        record = buildRun(req.body)
      } catch (err) {
        res.status(400).json({ error: 'InvalidRun', message: (err as Error).message })
        return
      }
      const { $type: _type, ...input } = record
      const out = await clientOf(res).create(ledger.run, input)
      res.json({ uri: out.uri, cid: out.cid })
    })

    app.put('/api/runs/:rkey', this.auth.requireUser, async (req, res) => {
      let record
      try {
        record = buildRun(req.body)
      } catch (err) {
        res.status(400).json({ error: 'InvalidRun', message: (err as Error).message })
        return
      }
      const { $type: _type, ...input } = record
      const out = await clientOf(res).put(ledger.run, input, { rkey: String(req.params.rkey) })
      res.json({ uri: out.uri, cid: out.cid })
    })

    app.delete('/api/runs/:rkey', this.auth.requireUser, async (req, res) => {
      await clientOf(res).delete(ledger.run, { rkey: String(req.params.rkey) })
      res.json({})
    })

    /** Posts a run to Bluesky from the runner's own account. */
    app.post('/api/runs/:rkey/share', this.auth.requireUser, async (req, res) => {
      const did = res.locals.did as string
      const uri = `at://${did}/${ledger.run.$nsid}/${String(req.params.rkey)}`
      const appview = (path: string) => fetch(new URL(path, this.config.appviewUrl)).then((r) => (r.ok ? (r.json() as Promise<any>) : undefined))
      const found = await appview(`/xrpc/app.speedrunledger-prototype.getRun?${new URLSearchParams({ uri })}`)
      if (!found) {
        res.status(404).json({ error: 'RunNotFound', message: 'That run is not indexed yet; try again in a moment' })
        return
      }
      const board = await appview(`/xrpc/app.speedrunledger-prototype.getLeaderboard?${new URLSearchParams({ category: found.run.category, limit: '1' })}`)
      if (!board) {
        res.status(404).json({ error: 'NotFound', message: 'The run’s category is not indexed' })
        return
      }
      const runUrl = `${this.config.publicUrl}/run?${new URLSearchParams({ uri })}`
      const record = sharePost(found.run, { game: board.game.title, category: board.category.name, primaryTiming: board.category.primaryTiming }, runUrl)
      const session = res.locals.session as { fetchHandler: (path: string, init: RequestInit) => Promise<globalThis.Response> }
      const out = await session.fetchHandler('/xrpc/com.atproto.repo.createRecord', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: did, collection: 'app.bsky.feed.post', record }),
      })
      res.status(out.status).type('application/json').send(await out.text())
    })

    /** Asks the sysadmins for a community; founders are given as handles or DIDs. */
    app.post('/api/requests', this.auth.requireUser, async (req, res) => {
      const body = req.body as { game?: Record<string, unknown>; founders?: unknown; note?: unknown }
      const names = (Array.isArray(body.founders) ? body.founders : []).map((f) => String(f).trim().replace(/^@/, '')).filter(Boolean)
      if (names.length === 0) {
        res.status(400).json({ error: 'InvalidRequest', message: 'Name at least one founding moderator' })
        return
      }
      const founders: string[] = []
      for (const name of names) {
        try {
          founders.push((await this.auth.client.identityResolver.resolve(name)).did)
        } catch {
          res.status(400).json({ error: 'UnknownFounder', message: `Could not find the account ${name}` })
          return
        }
      }
      const { request } = ledger.community
      const note = String(body.note ?? '').trim()
      const result = request.$safeParse({
        $type: request.$type,
        game: body.game,
        founders: [...new Set(founders)],
        note: note || undefined,
        createdAt: new Date().toISOString(),
      })
      if (!result.success) {
        res.status(400).json({ error: 'InvalidRequest', message: String(result.reason) })
        return
      }
      const { $type: _type, ...record } = result.value
      const out = await clientOf(res).create(request, record)
      res.json({ uri: out.uri, cid: out.cid })
    })

    app.get('/xrpc/:nsid', xrpcProxy(this.config.appviewUrl))
    await serveClient(app, { root, viteDev: this.config.viteDev })
    return app
  }

  async start(): Promise<void> {
    await migrateToLatest(this.db)
    const app = await this.app()
    await new Promise<void>((resolve) => {
      this.server = app.listen(this.config.port, () => resolve())
    })
  }

  async destroy(): Promise<void> {
    await new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve(undefined)))
    this.server?.closeAllConnections?.()
    await this.db.destroy()
  }
}
