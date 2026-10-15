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
].join(' ')

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
