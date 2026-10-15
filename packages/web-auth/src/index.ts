import { Client } from '@atproto/lex'
import { NodeOAuthClient, type OAuthSession, requestLocalLock } from '@atproto/oauth-client-node'
import type { Database } from '@speedrunledger/db'
import express, { type NextFunction, type Request, type Response, type Router } from 'express'
import { getIronSession } from 'iron-session'
import { createStores } from './stores.js'

export { serveClient, xrpcProxy } from './app.js'
export { createStores } from './stores.js'

export interface WebAuthConfig {
  /** Where the app is reached, e.g. http://127.0.0.1:2585 in development or https://ledger.example. */
  publicUrl: string
  /** Display name in the authorization screen. */
  clientName: string
  /** OAuth scope, always including "atproto". */
  scope: string
  /** At least 32 characters; encrypts the session cookie. */
  cookieSecret: string
  /** Resolves handles with com.atproto.identity.resolveHandle on this service instead of DNS (development). */
  handleResolverUrl?: string
  plcUrl?: string
  /** Allow plain-http OAuth servers and PLC (local development only). */
  allowHttp?: boolean
}

interface CookieData {
  did?: string
}

const COOKIE_NAME = 'ledger_session'

/**
 * atproto OAuth for the web apps. The Node backend holds the tokens; the
 * browser only ever gets an encrypted cookie with the user's DID.
 */
export class WebAuth {
  readonly client: NodeOAuthClient

  constructor(
    readonly config: WebAuthConfig,
    db: Database,
  ) {
    const url = new URL(config.publicUrl)
    const redirectUri = new URL('/api/oauth/callback', url).toString()
    const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    const clientId = loopback
      ? `http://localhost?${new URLSearchParams({ redirect_uri: redirectUri, scope: config.scope })}`
      : new URL('/oauth-client-metadata.json', url).toString()
    this.client = new NodeOAuthClient({
      clientMetadata: {
        client_id: clientId,
        client_name: config.clientName,
        client_uri: loopback ? undefined : url.origin,
        redirect_uris: [redirectUri],
        scope: config.scope,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'web',
        token_endpoint_auth_method: 'none',
        dpop_bound_access_tokens: true,
      },
      ...createStores(db),
      handleResolver: config.handleResolverUrl,
      plcDirectoryUrl: config.plcUrl,
      allowHttp: config.allowHttp,
      // Token refreshes are serialized within this process; one process per app in the prototype.
      requestLock: requestLocalLock,
    })
  }

  private cookie(req: Request, res: Response) {
    return getIronSession<CookieData>(req, res, {
      cookieName: COOKIE_NAME,
      password: this.config.cookieSecret,
      cookieOptions: {
        secure: new URL(this.config.publicUrl).protocol === 'https:',
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      },
    })
  }

  /** The signed-in user's OAuth session, or undefined. */
  async session(req: Request, res: Response): Promise<OAuthSession | undefined> {
    const cookie = await this.cookie(req, res)
    if (!cookie.did) return undefined
    try {
      return await this.client.restore(cookie.did)
    } catch {
      cookie.destroy()
      return undefined
    }
  }

  /** A typed XRPC client acting as the signed-in user on their own PDS. */
  async userClient(req: Request, res: Response): Promise<Client | undefined> {
    const session = await this.session(req, res)
    return session ? new Client(session) : undefined
  }

  /** Express middleware: 401 unless signed in; puts the user's client on res.locals. */
  requireUser = async (req: Request, res: Response, next: NextFunction) => {
    const session = await this.session(req, res)
    if (!session) {
      res.status(401).json({ error: 'AuthRequired', message: 'Sign in first' })
      return
    }
    res.locals.session = session
    res.locals.did = session.did
    res.locals.client = new Client(session)
    next()
  }

  /** /api/login, /api/oauth/callback, /api/logout, /api/me and the client metadata document. */
  router(opts: { afterLogin?: string } = {}): Router {
    const router = express.Router()

    router.get('/oauth-client-metadata.json', (_req, res) => {
      res.json(this.client.clientMetadata)
    })

    router.get('/api/login', async (req, res) => {
      const handle = String(req.query.handle ?? '').trim().replace(/^@/, '')
      if (!handle) {
        res.status(400).json({ error: 'InvalidRequest', message: 'Enter your handle' })
        return
      }
      try {
        const url = await this.client.authorize(handle, { scope: this.config.scope })
        res.redirect(url.toString())
      } catch (err) {
        res.status(400).json({ error: 'LoginFailed', message: (err as Error).message })
      }
    })

    router.get('/api/oauth/callback', async (req, res) => {
      try {
        const params = new URLSearchParams(req.originalUrl.split('?')[1] ?? '')
        const { session } = await this.client.callback(params)
        const cookie = await this.cookie(req, res)
        cookie.did = session.did
        await cookie.save()
        res.redirect(opts.afterLogin ?? '/')
      } catch (err) {
        res.redirect(`/?loginError=${encodeURIComponent((err as Error).message)}`)
      }
    })

    router.post('/api/logout', async (req, res) => {
      const cookie = await this.cookie(req, res)
      if (cookie.did) {
        try {
          const session = await this.client.restore(cookie.did)
          await session.signOut()
        } catch {
          // Already gone.
        }
      }
      cookie.destroy()
      res.json({})
    })

    router.get('/api/me', async (req, res) => {
      const session = await this.session(req, res)
      if (!session) {
        res.status(401).json({ error: 'AuthRequired' })
        return
      }
      res.json({ did: session.did })
    })

    return router
  }
}
