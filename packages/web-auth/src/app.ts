import { join } from 'node:path'
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express'

/** Forwards /xrpc/* reads to the AppView, as Caddy does in production. */
export function xrpcProxy(appviewUrl: string): RequestHandler {
  return async (req: Request, res: Response) => {
    const target = new URL(req.originalUrl, appviewUrl)
    const upstream = await fetch(target, { headers: { accept: 'application/json' } })
    res.status(upstream.status).type(upstream.headers.get('content-type') ?? 'application/json')
    res.send(Buffer.from(await upstream.arrayBuffer()))
  }
}

/**
 * Serves a React app: through Vite's dev server (hot reload) in development,
 * or the built files in dist/client with an SPA fallback. Also installs the
 * JSON error handler, so call it after the API routes.
 */
export async function serveClient(app: Express, opts: { root: string; viteDev: boolean }): Promise<void> {
  if (opts.viteDev) {
    const { createServer } = await import('vite')
    const vite = await createServer({ root: opts.root, server: { middlewareMode: true }, appType: 'spa' })
    app.use(vite.middlewares)
  } else {
    const client = join(opts.root, 'dist', 'client')
    app.use(express.static(client))
    app.get('/{*path}', (_req, res) => res.sendFile(join(client, 'index.html')))
  }
  app.use((err: Error & { status?: number; error?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.error ?? 'InternalServerError', message: err.message })
  })
}
