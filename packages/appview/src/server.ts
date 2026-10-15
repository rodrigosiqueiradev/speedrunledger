import type { Server } from 'node:http'
import { createServer } from '@atproto/lex-server/nodejs'
import { createDb, type Database } from '@speedrunledger/db'
import { createRouter } from './router.js'

export interface AppViewConfig {
  databaseUrl: string
  port: number
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppViewConfig {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  return { databaseUrl: env.DATABASE_URL, port: Number(env.APPVIEW_PORT ?? env.PORT ?? 2584) }
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
    const server = createServer(router, { gracefulTerminationTimeout: 2000 })
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
