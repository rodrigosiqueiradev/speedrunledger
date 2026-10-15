import type { Server } from 'node:http'
import { createServer } from '@atproto/lex-server/nodejs'
import { createDb, type Database } from '@speedrunledger/db'
import { FeedGenerator } from './feed.js'
import { createRouter } from './router.js'

export interface AppViewConfig {
  databaseUrl: string
  port: number
  /** The DID Bluesky reaches the world-record feeds at; default did:web:localhost%3A<port>. */
  feedServiceDid?: string
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppViewConfig {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const port = Number(env.APPVIEW_PORT ?? env.PORT ?? 2584)
  return { databaseUrl: env.DATABASE_URL, port, feedServiceDid: env.FEED_SERVICE_DID }
}

/** Serves the AppView's XRPC queries over HTTP. The schema is owned by the indexer. */
export class AppViewServer {
  private server?: Server & { terminate?: () => Promise<void> }

  constructor(
    readonly config: AppViewConfig,
    readonly db: Database = createDb(config.databaseUrl),
  ) {}

  get url(): string {
    const address = this.server?.address()
    const port = typeof address === 'object' && address ? address.port : this.config.port
    return `http://localhost:${port}`
  }

  async start(): Promise<void> {
    const router = createRouter(this.db)
    const feeds = new FeedGenerator(this.db, this.config.feedServiceDid ?? `did:web:localhost%3A${this.config.port}`)
    const fetch = async (request: Request) => (await feeds.handle(request)) ?? router.fetch(request)
    const server = createServer(fetch, { gracefulTerminationTimeout: 2000 })
    this.server = server
    await new Promise<void>((resolve) => server.listen(this.config.port, resolve))
  }

  async destroy(): Promise<void> {
    const server = this.server
    if (server?.terminate) await server.terminate()
    else if (server) await new Promise((resolve) => server.close(resolve))
    await this.db.destroy()
  }
}
