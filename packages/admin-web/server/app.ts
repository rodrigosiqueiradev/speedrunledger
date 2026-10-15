import { timingSafeEqual } from 'node:crypto'
import type { Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdminApiError, AdminClient } from '@speedrunledger/admin-client'
import { createDb, type Database, migrateToLatest } from '@speedrunledger/db'
import { serveClient, WebAuth, xrpcProxy } from '@speedrunledger/web-auth'
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import type { AdminWebConfig } from './config.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', here.endsWith(join('dist', 'server')) ? '..' : '')

/** The Admin app only needs to know who you are; everything it writes goes through the community service. */
export const ADMIN_SCOPE = 'atproto'

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string,
  ) {
    super(message)
  }
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const optional = (value: unknown) => text(value) || undefined
const did = (res: Response) => res.locals.did as string

/**
 * The Admin app: what `ledger-admin` does, for sysadmins who sign in with
 * their own atproto account. The backend holds the community service's admin
 * token and names the signed-in sysadmin on every write, through the same
 * AdminClient the command line uses; the community service checks again that
 * they are listed in the platform repo.
 */
export class AdminWeb {
  readonly db: Database
  readonly auth: WebAuth
  readonly admin: AdminClient
  private server?: Server

  constructor(readonly config: AdminWebConfig) {
    this.db = createDb(config.databaseUrl, { max: 5 })
    this.auth = new WebAuth(
      {
        publicUrl: config.publicUrl,
        clientName: 'SpeedrunLedger Admin',
        scope: ADMIN_SCOPE,
        cookieSecret: config.cookieSecret,
        handleResolverUrl: config.devPdsUrl,
        plcUrl: config.plcUrl,
        allowHttp: config.devPdsUrl !== undefined,
      },
      this.db,
    )
    this.admin = new AdminClient({
      communityServiceUrl: config.communityServiceUrl,
      adminToken: config.adminToken,
      appviewUrl: config.appviewUrl,
      pdsUrl: config.devPdsUrl,
      plcUrl: config.plcUrl ?? 'https://plc.directory',
    })
  }

  /** A handle or DID to a DID and handle, the same way sign-in resolves them. */
  private async actor(input: unknown): Promise<{ did: string; handle?: string }> {
    const actor = text(input).replace(/^@/, '')
    if (!actor) throw new HttpError(400, 'InvalidRequest', 'Enter a handle')
    try {
      const { did, handle } = await this.auth.client.identityResolver.resolve(actor)
      return { did, handle: handle === 'handle.invalid' ? undefined : handle }
    } catch {
      throw new HttpError(404, 'NotFound', `Could not find the account ${actor}`)
    }
  }

  async app(): Promise<express.Express> {
    const app = express()
    app.disable('x-powered-by')
    app.use(express.json({ limit: '100kb' }))
    app.use(this.auth.router())
    const { admin } = this
    /** 401 unless signed in, 403 unless listed as a sysadmin. */
    const sysadmin: RequestHandler = (req, res, next) =>
      this.auth.requireUser(req, res, () => {
        admin.listSysadmins().then((sysadmins) => {
          if (sysadmins.includes(did(res))) return next()
          res.status(403).json({ error: 'NotSysadmin', message: 'This account is not a sysadmin' })
        }, next)
      })

    /** Who you are, whether the platform is set up yet, and whether you are a sysadmin. */
    app.get('/api/whoami', this.auth.requireUser, async (_req, res) => {
      const [sysadmins, me] = await Promise.all([admin.listSysadmins(), this.actor(did(res)).catch(() => ({ did: did(res) }))])
      res.json({ ...me, initialized: sysadmins.length > 0, sysadmin: sysadmins.includes(did(res)) })
    })

    /**
     * First run: creates the platform account with the signed-in account as its
     * first sysadmin. The setup code (the admin token) proves this is the
     * person running the platform, not whoever signs in first.
     */
    app.post('/api/platform', this.auth.requireUser, async (req, res) => {
      if (!sameSecret(text(req.body.setupCode), this.config.adminToken)) {
        throw new HttpError(403, 'WrongSetupCode', 'That setup code is not right')
      }
      res.json(await admin.initPlatform({ handle: text(req.body.handle), sysadmin: did(res) }))
    })

    app.get('/api/sysadmins', sysadmin, async (_req, res) => {
      const dids = await admin.listSysadmins()
      res.json({ sysadmins: await Promise.all(dids.map((d) => this.actor(d).catch(() => ({ did: d })))) })
    })
    app.post('/api/sysadmins', sysadmin, async (req, res) => {
      const subject = await this.actor(req.body.actor)
      await admin.addSysadmin(did(res), subject.did)
      res.json(subject)
    })
    app.post('/api/sysadmins/remove', sysadmin, async (req, res) => {
      await admin.removeSysadmin(did(res), text(req.body.did))
      res.json({})
    })

    app.get('/api/requests', sysadmin, async (req, res) => {
      res.json({ requests: await admin.listRequests(req.query.status === 'all' ? 'all' : 'pending') })
    })
    app.post('/api/requests/deny', sysadmin, async (req, res) => {
      res.json(await admin.denyRequest(did(res), text(req.body.request), text(req.body.reason)))
    })

    app.get('/api/communities', sysadmin, async (_req, res) => {
      res.json({ communities: await admin.listCommunities() })
    })
    app.post('/api/communities', sysadmin, async (req, res) => {
      const b = req.body
      const founders = Array.isArray(b.founders) ? await Promise.all(b.founders.map(async (f: unknown) => (await this.actor(f)).did)) : []
      res.json(
        await admin.createCommunity({
          sysadmin: did(res),
          handle: text(b.handle),
          name: text(b.name),
          description: optional(b.description),
          request: optional(b.request),
          game: b.game?.title ? { title: text(b.game.title), releaseYear: b.game.releaseYear, platforms: b.game.platforms } : undefined,
          founders: founders.length ? founders : undefined,
          recoveryKey: optional(b.recoveryKey),
        }),
      )
    })
    app.post('/api/communities/register', sysadmin, async (req, res) => {
      res.json(await admin.registerCommunity(text(req.body.identifier), text(req.body.password)))
    })
    app.post('/api/communities/:did/games', sysadmin, async (req, res) => {
      const b = req.body
      res.json(await admin.addGame(did(res), String(req.params.did), { title: text(b.title), releaseYear: b.releaseYear, platforms: b.platforms }))
    })
    app.post('/api/communities/:did/appoint', sysadmin, async (req, res) => {
      const subject = await this.actor(req.body.actor)
      res.json({ ...(await admin.appoint(did(res), String(req.params.did), subject.did, text(req.body.reason))), subject })
    })
    app.post('/api/communities/:did/:action', sysadmin, async (req, res, next) => {
      const { action } = req.params
      if (action !== 'freeze' && action !== 'unfreeze') return next()
      res.json(await admin.setFrozen(did(res), String(req.params.did), action === 'freeze', text(req.body.reason)))
    })
    /** The community's whole repo as a CAR file, straight from its PDS. */
    app.get('/api/communities/:did/export', sysadmin, async (req, res) => {
      res.redirect(await admin.exportUrl(String(req.params.did)))
    })

    app.post('/api/jobs/proposals', sysadmin, async (_req, res) => {
      res.json(await admin.executeProposals())
    })
    app.post('/api/jobs/announcements', sysadmin, async (_req, res) => {
      res.json(await admin.runAnnouncements())
    })
    app.post('/api/jobs/videos', sysadmin, async (_req, res) => {
      res.json(await admin.checkVideos())
    })

    // Errors from the community service keep their status and name, with a message for people.
    app.use('/api', (err: Error, _req: Request, res: Response, next: NextFunction) => {
      if (err instanceof AdminApiError) res.status(err.status).json({ error: err.error, message: err.detail })
      else if (err instanceof HttpError) res.status(err.status).json({ error: err.error, message: err.message })
      else next(err)
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
