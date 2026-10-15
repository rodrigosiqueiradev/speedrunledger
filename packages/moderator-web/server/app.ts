import type { Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OAuthSession } from '@atproto/oauth-client-node'
import { createDb, type Database, migrateToLatest } from '@speedrunledger/db'
import { ledger } from '@speedrunledger/lexicon'
import { serveClient, WebAuth, xrpcProxy } from '@speedrunledger/web-auth'
import express, { type Response } from 'express'
import type { ModeratorWebConfig } from './config.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', here.endsWith(join('dist', 'server')) ? '..' : '')

const CREATE_VERDICT = ledger.moderation.createVerdict.$nsid

/**
 * What the Moderator app may do with a moderator's account: ask their PDS for
 * service-auth tokens to call the community service. The community's own
 * records are written by that service, never by this app.
 */
export const MODERATOR_SCOPE = ['atproto', `rpc:${CREATE_VERDICT}?aud=*`].join(' ')

export class ModeratorWeb {
  readonly db: Database
  readonly auth: WebAuth
  private server?: Server

  constructor(readonly config: ModeratorWebConfig) {
    this.db = createDb(config.databaseUrl, { max: 5 })
    this.auth = new WebAuth(
      {
        publicUrl: config.publicUrl,
        clientName: 'SpeedrunLedger Moderation',
        scope: MODERATOR_SCOPE,
        cookieSecret: config.cookieSecret,
        handleResolverUrl: config.devPdsUrl,
        plcUrl: config.plcUrl,
        allowHttp: config.devPdsUrl !== undefined,
      },
      this.db,
    )
  }

  /** Calls a community service procedure as the signed-in moderator, with a token their PDS signs. */
  private async callCommunityService(res: Response, nsid: string, body: unknown): Promise<void> {
    const session = res.locals.session as OAuthSession
    const params = new URLSearchParams({ aud: this.config.communityServiceDid, lxm: nsid })
    const tokenRes = await session.fetchHandler(`/xrpc/com.atproto.server.getServiceAuth?${params}`)
    if (!tokenRes.ok) {
      res.status(502).json({ error: 'ServiceAuthFailed', message: `Your PDS refused a token: ${await tokenRes.text()}` })
      return
    }
    const { token } = (await tokenRes.json()) as { token: string }
    const upstream = await fetch(new URL(`/xrpc/${nsid}`, this.config.communityServiceUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    res.status(upstream.status).type('application/json').send(await upstream.text())
  }

  async app(): Promise<express.Express> {
    const app = express()
    app.disable('x-powered-by')
    app.use(express.json({ limit: '100kb' }))
    app.use(this.auth.router())

    app.post('/api/verdicts', this.auth.requireUser, async (req, res) => {
      await this.callCommunityService(res, CREATE_VERDICT, req.body)
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
