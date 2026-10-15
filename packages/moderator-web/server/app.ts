import type { Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Client } from '@atproto/lex'
import type { OAuthSession } from '@atproto/oauth-client-node'
import { createDb, type Database, migrateToLatest } from '@speedrunledger/db'
import { ledger } from '@speedrunledger/lexicon'
import { serveClient, WebAuth, xrpcProxy } from '@speedrunledger/web-auth'
import express, { type Response } from 'express'
import type { ModeratorWebConfig } from './config.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', here.endsWith(join('dist', 'server')) ? '..' : '')

const CREATE_VERDICT = ledger.moderation.createVerdict.$nsid
const CREATE_BAN = ledger.moderation.createBan.$nsid
const UPDATE_GAME = ledger.moderation.updateGame.$nsid
const FLAG_RUN = ledger.moderation.flagRun.$nsid
const PROPOSAL_DAYS = 7

/**
 * What the Moderator app may do with a moderator's account: write their own
 * acceptances, proposals and votes, and ask their PDS for service-auth tokens
 * to call the community service. The community's own records are written by
 * that service, never by this app.
 */
export const MODERATOR_SCOPE = [
  'atproto',
  `repo:${ledger.community.memberAccept.$nsid}`,
  `repo:${ledger.community.proposal.$nsid}`,
  `repo:${ledger.community.vote.$nsid}`,
  ...[CREATE_VERDICT, CREATE_BAN, UPDATE_GAME, FLAG_RUN].map((nsid) => `rpc:${nsid}?aud=*`),
].join(' ')

const clientOf = (res: Response) => res.locals.client as Client

/** Validates a record the moderator writes into their own repo; returns it without $type, or answers 400. */
function parse<T extends { $type?: unknown }>(
  res: Response,
  schema: { $safeParse: (v: unknown) => { success: true; value: T } | { success: false; reason: unknown } },
  value: Record<string, unknown>,
  type: string,
): Omit<T, '$type'> | undefined {
  const result = schema.$safeParse({ ...value, $type: type })
  if (!result.success) {
    res.status(400).json({ error: 'InvalidRecord', message: String(result.reason) })
    return undefined
  }
  const { $type: _type, ...record } = result.value
  return record
}

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
    app.post('/api/bans', this.auth.requireUser, async (req, res) => {
      await this.callCommunityService(res, CREATE_BAN, req.body)
    })
    app.post('/api/games', this.auth.requireUser, async (req, res) => {
      await this.callCommunityService(res, UPDATE_GAME, req.body)
    })
    app.post('/api/flags', this.auth.requireUser, async (req, res) => {
      await this.callCommunityService(res, FLAG_RUN, req.body)
    })

    // Records in the moderator's own repo: accepting a membership, proposing, voting.
    app.post('/api/accept', this.auth.requireUser, async (req, res) => {
      const { memberAccept } = ledger.community
      const record = parse(res, memberAccept, { member: req.body.grant, createdAt: new Date().toISOString() }, memberAccept.$type)
      if (record) res.json(await clientOf(res).create(memberAccept, record))
    })
    app.post('/api/proposals', this.auth.requireUser, async (req, res) => {
      const { proposal } = ledger.community
      const createdAt = new Date()
      const expiresAt = new Date(createdAt.getTime() + PROPOSAL_DAYS * 24 * 60 * 60 * 1000)
      const record = parse(
        res,
        proposal,
        {
          community: req.body.community,
          action: req.body.action,
          reason: String(req.body.reason ?? '').trim(),
          expiresAt: expiresAt.toISOString(),
          createdAt: createdAt.toISOString(),
        },
        proposal.$type,
      )
      if (record) res.json(await clientOf(res).create(proposal, record))
    })
    app.post('/api/votes', this.auth.requireUser, async (req, res) => {
      const { vote } = ledger.community
      const reason = String(req.body.reason ?? '').trim()
      const record = parse(
        res,
        vote,
        { proposal: req.body.proposal, value: req.body.value, reason: reason || undefined, createdAt: new Date().toISOString() },
        vote.$type,
      )
      if (record) res.json(await clientOf(res).create(vote, record))
    })

    /** A handle or DID to a DID, for invite and ban forms. */
    app.get('/api/resolve', this.auth.requireUser, async (req, res) => {
      const actor = String(req.query.actor ?? '').trim().replace(/^@/, '')
      try {
        const { did, handle } = await this.auth.client.identityResolver.resolve(actor)
        res.json({ did, handle })
      } catch {
        res.status(404).json({ error: 'NotFound', message: `Could not find the account ${actor}` })
      }
    })

    /** The community's whole repo as a CAR file, straight from its PDS. */
    app.get('/api/export/:did', async (req, res) => {
      try {
        const { didDoc } = await this.auth.client.identityResolver.resolve(req.params.did)
        const pds = didDoc.service?.find((s) => String(s.id).endsWith('#atproto_pds'))?.serviceEndpoint
        if (typeof pds !== 'string') throw new Error('no PDS')
        res.redirect(new URL(`/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(req.params.did)}`, pds).toString())
      } catch {
        res.status(404).json({ error: 'NotFound', message: 'Could not find where this community is hosted' })
      }
    })

    app.get('/xrpc/:nsid', xrpcProxy(this.config.appviewUrl))
    await serveClient(app, { root, viteDev: this.config.viteDev })
    return app
  }

  async start(): Promise<void> {
    await migrateToLatest(this.db)
    const app = await this.app()
    await new Promise<void>((resolve) => {
      // IPv4 on purpose: the apps are opened at 127.0.0.1 (OAuth loopback), and WSL,
      // which Podman uses on Windows, forwards an IPv6 (::) listener only to Windows' ::1.
      this.server = app.listen(this.config.port, '0.0.0.0', () => resolve())
    })
  }

  async destroy(): Promise<void> {
    await new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve(undefined)))
    this.server?.closeAllConnections?.()
    await this.db.destroy()
  }
}
