export interface ModeratorWebConfig {
  port: number
  /** The URL people open; http://127.0.0.1:<port> makes the OAuth client a development loopback client. */
  publicUrl: string
  databaseUrl: string
  appviewUrl: string
  communityServiceUrl: string
  /** The community service's DID: the audience of the service-auth tokens this app asks for. */
  communityServiceDid: string
  cookieSecret: string
  /** Development: resolve handles through this PDS and allow plain-http OAuth. */
  devPdsUrl?: string
  plcUrl?: string
  /** Serve the React app through Vite's dev server instead of the built files. */
  viteDev: boolean
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ModeratorWebConfig {
  const port = Number(env.MODERATOR_PORT ?? env.PORT ?? 2587)
  const need = (key: string) => {
    const value = env[key]
    if (!value) throw new Error(`${key} is required`)
    return value
  }
  return {
    port,
    publicUrl: env.MODERATOR_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
    databaseUrl: need('DATABASE_URL'),
    appviewUrl: env.APPVIEW_URL ?? 'http://localhost:2584',
    communityServiceUrl: env.COMMUNITY_SERVICE_URL ?? 'http://localhost:2586',
    communityServiceDid: env.COMMUNITY_SERVICE_DID ?? 'did:web:localhost%3A2586',
    cookieSecret: need('COOKIE_SECRET'),
    devPdsUrl: env.DEV_MODE === 'false' ? undefined : env.PDS_URL,
    plcUrl: env.PLC_URL,
    viteDev: env.NODE_ENV !== 'production',
  }
}
