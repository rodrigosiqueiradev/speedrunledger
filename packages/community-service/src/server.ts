import { timingSafeEqual } from 'node:crypto'
import { LexRouter, LexServerError, serviceAuth } from '@atproto/lex-server'
import { createServer, type Server } from '@atproto/lex-server/nodejs'
import { ledger } from '@speedrunledger/lexicon'
import { pino, type Logger } from 'pino'
import { AdminService } from './admin.js'
import { Announcer } from './announcer.js'
import type { CommunityServiceConfig } from './config.js'
import { ProposalExecutor } from './executor.js'
import { Labeler } from './labeler.js'
import { VideoChecker } from './video-checker.js'
import { CommunityService, fail } from './service.js'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const sameSecret = (a: string, b: string) => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)]
  return x.length === y.length && timingSafeEqual(x, y)
}

type Body = Record<string, any>
type AdminRoute = (body: Body, params: Record<string, string>) => Promise<unknown>

/**
 * The community service over HTTP: moderator procedures (service auth),
 * admin endpoints for `ledger-admin` (bearer token), and the did:web
 * document naming this service. Also runs the proposal executor.
 */
export class CommunityServiceServer {
  readonly service: CommunityService
  readonly admin: AdminService
  readonly executor: ProposalExecutor
  readonly announcer: Announcer
  readonly videos: VideoChecker
  labeler?: Labeler
  private server?: Server

  constructor(
    readonly config: CommunityServiceConfig,
    logger: Logger = pino({ level: process.env.LOG_LEVEL ?? 'info' }),
  ) {
    this.service = new CommunityService(config, logger)
    this.admin = new AdminService(this.service, { url: config.pdsUrl ?? '', adminPassword: config.pdsAdminPassword })
    this.executor = new ProposalExecutor(this.service)
    this.videos = new VideoChecker(this.service)
    this.announcer = new Announcer(this.service, {
      runnerAppUrl: config.runnerAppUrl ?? 'http://127.0.0.1:2585',
      feedServiceDid: config.feedServiceDid ?? 'did:web:localhost%3A2584',
    })
  }

  get url(): string {
    const address = this.server?.address()
    const port = typeof address === 'object' && address ? address.port : this.config.port
    return `http://localhost:${port}`
  }

  router(): LexRouter {
    const seen = new Map<string, number>()
    const verify = serviceAuth({
      audience: this.config.serviceDid as `did:${string}:${string}`,
      unique: async (nonce) => {
        const now = Date.now()
        for (const [n, at] of seen) if (now - at > 10 * 60_000) seen.delete(n)
        if (seen.has(nonce)) return false
        seen.set(nonce, now)
        return true
      },
      plcDirectoryUrl: this.config.plcUrl,
      allowHttp: this.config.devMode,
      fetch: this.config.devMode ? globalThis.fetch : undefined,
    })
    // lex-server's Node adapter aborts request.signal once the body has been read,
    // which would cancel the DID lookup for every procedure call; give auth its own.
    const auth: typeof verify = (ctx) =>
      verify({ ...ctx, request: { headers: ctx.request.headers, signal: AbortSignal.timeout(10_000) } as Request })
    return new LexRouter()
      .add(ledger.moderation.createVerdict, {
        auth,
        handler: async ({ credentials, input }) => ({ body: await this.service.createVerdict(credentials.did, input.body) }),
      })
      .add(ledger.moderation.createBan, {
        auth,
        handler: async ({ credentials, input }) => ({ body: await this.service.createBan(credentials.did, input.body) }),
      })
      .add(ledger.moderation.updateGame, {
        auth,
        handler: async ({ credentials, input }) => ({ body: await this.service.updateGame(credentials.did, input.body) }),
      })
      .add(ledger.moderation.flagRun, {
        auth,
        handler: async ({ credentials, input }) => {
          if (!this.labeler) throw fail(501, 'LabelerDisabled', 'This service has no labeler key, so it cannot flag runs')
          return { body: await this.labeler.flagRun(credentials.did, input.body) }
        },
      })
  }

  /** Admin endpoints, keyed by "METHOD /path" with :params. */
  private adminRoutes(): Record<string, AdminRoute> {
    const { admin, service } = this
    const need = (body: Body, ...keys: string[]) => {
      for (const key of keys) {
        if (typeof body[key] !== 'string' || !body[key]) throw new LexServerError(400, { error: 'InvalidRequest', message: `${key} is required` })
      }
    }
    return {
      'GET /admin/communities': async () => ({ communities: await service.listCommunities() }),
      'POST /admin/communities': async (b) => {
        need(b, 'identifier', 'password', 'pdsUrl')
        return service.registerAccount({ identifier: b.identifier, password: b.password, pdsUrl: b.pdsUrl }, 'community')
      },
      'POST /admin/communities/create': async (b) => {
        need(b, 'sysadmin', 'handle', 'name')
        return admin.createCommunity(b as never)
      },
      'POST /admin/communities/:did/games': async (b, p) => {
        need(b, 'sysadmin', 'title')
        return admin.addGame(b.sysadmin, p.did, { title: b.title, releaseYear: b.releaseYear, platforms: b.platforms })
      },
      'POST /admin/communities/:did/appoint': async (b, p) => {
        need(b, 'sysadmin', 'subject', 'reason')
        return admin.appoint(b.sysadmin, p.did, b.subject, b.reason)
      },
      'POST /admin/communities/:did/freeze': async (b, p) => {
        need(b, 'sysadmin', 'reason')
        return admin.setFrozen(b.sysadmin, p.did, true, b.reason)
      },
      'POST /admin/communities/:did/unfreeze': async (b, p) => {
        need(b, 'sysadmin', 'reason')
        return admin.setFrozen(b.sysadmin, p.did, false, b.reason)
      },
      'POST /admin/platform': async (b) => {
        need(b, 'handle', 'sysadmin')
        return admin.initPlatform({ handle: b.handle, sysadmin: b.sysadmin, email: b.email })
      },
      'GET /admin/sysadmins': async () => ({ sysadmins: await admin.listSysadmins() }),
      'POST /admin/sysadmins': async (b) => {
        need(b, 'sysadmin', 'subject')
        return admin.addSysadmin(b.sysadmin, b.subject)
      },
      'POST /admin/sysadmins/remove': async (b) => {
        need(b, 'sysadmin', 'subject')
        await admin.removeSysadmin(b.sysadmin, b.subject)
        return {}
      },
      'POST /admin/requests/deny': async (b) => {
        need(b, 'sysadmin', 'request', 'reason')
        return admin.denyRequest(b.sysadmin, b.request, b.reason)
      },
      'POST /admin/proposals/execute': async () => ({ executed: await this.executor.runOnce() }),
      'POST /admin/announcements/run': async () => ({ posted: await this.announcer.runOnce() }),
      'POST /admin/videos/check': async () => this.videos.runOnce(),
    }
  }

  private async handleAdmin(request: Request, url: URL): Promise<Response> {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
    if (!sameSecret(token, this.config.adminToken)) return json({ error: 'AuthenticationRequired' }, 401)
    const segments = url.pathname.split('/')
    for (const [key, route] of Object.entries(this.adminRoutes())) {
      const [method, pattern] = key.split(' ')
      const parts = pattern.split('/')
      if (method !== request.method || parts.length !== segments.length) continue
      const params: Record<string, string> = {}
      if (!parts.every((part, i) => (part.startsWith(':') ? (params[part.slice(1)] = decodeURIComponent(segments[i])) : part === segments[i]))) {
        continue
      }
      const body = request.method === 'GET' ? {} : ((await request.json().catch(() => ({}))) as Body)
      try {
        return json(await route(body, params))
      } catch (err) {
        if (err instanceof LexServerError) return err.toResponse()
        this.service.logger.error({ err, path: url.pathname }, 'admin request failed')
        return json({ error: 'InternalServerError', message: (err as Error).message }, 500)
      }
    }
    return json({ error: 'NotFound' }, 404)
  }

  async start(): Promise<void> {
    await this.service.migrate()
    if (this.config.labelerSigningKey) this.labeler = await Labeler.create(this.service, this.config.labelerSigningKey)
    const router = this.router()
    const fetch = async (request: Request): Promise<Response> => {
      const url = new URL(request.url)
      if (url.pathname === '/.well-known/did.json') {
        const labeler = this.labeler
        return json({
          '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
          id: this.config.serviceDid,
          ...(labeler
            ? {
                verificationMethod: [
                  {
                    id: `${this.config.serviceDid}#atproto_label`,
                    type: 'Multikey',
                    controller: this.config.serviceDid,
                    publicKeyMultibase: labeler.didKey.slice('did:key:'.length),
                  },
                ],
              }
            : {}),
          service: [
            { id: '#ledger_community', type: 'SpeedrunLedgerCommunityService', serviceEndpoint: url.origin },
            ...(labeler ? [{ id: '#atproto_labeler', type: 'AtprotoLabeler', serviceEndpoint: url.origin }] : []),
          ],
        })
      }
      if (url.pathname === '/xrpc/com.atproto.label.queryLabels') {
        if (!this.labeler) return json({ labels: [] })
        return this.labeler.queryLabels(url.searchParams)
      }
      if (url.pathname === '/_health') return json({ ok: true })
      if (url.pathname.startsWith('/admin/')) return this.handleAdmin(request, url)
      try {
        return await router.fetch(request)
      } catch (err) {
        return LexServerError.from(err).toResponse()
      }
    }
    const server = createServer(fetch, { gracefulTerminationTimeout: 2000 })
    this.server = server
    this.labeler?.attach(server)
    await new Promise<void>((resolve) => server.listen(this.config.port, resolve))
    if (this.config.executorIntervalMs > 0) {
      this.executor.start(this.config.executorIntervalMs)
      this.announcer.start(this.config.executorIntervalMs)
    }
    if (this.config.videoCheckIntervalMs > 0) this.videos.start(this.config.videoCheckIntervalMs)
  }

  async destroy(): Promise<void> {
    await this.executor.stop()
    await this.announcer.stop()
    await this.videos.stop()
    await this.labeler?.close()
    if (this.server) await this.server.terminate()
    await this.service.destroy()
  }
}
