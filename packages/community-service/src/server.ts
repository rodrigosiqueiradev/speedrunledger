import { timingSafeEqual } from 'node:crypto'
import { LexRouter, LexServerError, serviceAuth } from '@atproto/lex-server'
import { createServer, type Server } from '@atproto/lex-server/nodejs'
import { ledger } from '@speedrunledger/lexicon'
import { pino, type Logger } from 'pino'
import type { CommunityServiceConfig } from './config.js'
import { CommunityService } from './service.js'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const sameSecret = (a: string, b: string) => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)]
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * The community service over HTTP: `createVerdict` for moderators (service
 * auth), admin endpoints for the admin CLI (bearer token), and the did:web
 * document naming this service.
 */
export class CommunityServiceServer {
  readonly service: CommunityService
  private server?: Server

  constructor(
    readonly config: CommunityServiceConfig,
    logger: Logger = pino({ level: process.env.LOG_LEVEL ?? 'info' }),
  ) {
    this.service = new CommunityService(config, logger)
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
    return new LexRouter().add(ledger.moderation.createVerdict, {
      auth,
      handler: async ({ credentials, input }) => ({
        body: await this.service.createVerdict(credentials.did, input.body),
      }),
    })
  }

  private async admin(request: Request, url: URL): Promise<Response> {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
    if (!sameSecret(token, this.config.adminToken)) return json({ error: 'AuthenticationRequired' }, 401)
    if (url.pathname === '/admin/communities' && request.method === 'GET') {
      return json({ communities: await this.service.listCommunities() })
    }
    if (url.pathname === '/admin/communities' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const { identifier, password, pdsUrl } = body
      if (typeof identifier !== 'string' || typeof password !== 'string' || typeof pdsUrl !== 'string') {
        return json({ error: 'InvalidRequest', message: 'identifier, password and pdsUrl are required' }, 400)
      }
      try {
        return json(await this.service.registerCommunity({ identifier, password, pdsUrl }))
      } catch (err) {
        return json({ error: 'LoginFailed', message: (err as Error).message }, 400)
      }
    }
    return json({ error: 'NotFound' }, 404)
  }

  async start(): Promise<void> {
    await this.service.migrate()
    const router = this.router()
    const fetch = async (request: Request): Promise<Response> => {
      const url = new URL(request.url)
      if (url.pathname === '/.well-known/did.json') {
        return json({
          '@context': ['https://www.w3.org/ns/did/v1'],
          id: this.config.serviceDid,
          service: [{ id: '#ledger_community', type: 'SpeedrunLedgerCommunityService', serviceEndpoint: url.origin }],
        })
      }
      if (url.pathname === '/_health') return json({ ok: true })
      if (url.pathname.startsWith('/admin/')) return this.admin(request, url)
      try {
        return await router.fetch(request)
      } catch (err) {
        return LexServerError.from(err).toResponse()
      }
    }
    const server = createServer(fetch, { gracefulTerminationTimeout: 2000 })
    this.server = server
    await new Promise<void>((resolve) => server.listen(this.config.port, resolve))
  }

  async destroy(): Promise<void> {
    if (this.server) await this.server.terminate()
    await this.service.destroy()
  }
}
