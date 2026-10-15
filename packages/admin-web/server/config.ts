export interface AdminWebConfig {
  port: number
  /** The URL people open; http://127.0.0.1:<port> makes the OAuth client a development loopback client. */
  publicUrl: string
  databaseUrl: string
  appviewUrl: string
  communityServiceUrl: string
  /** The community service's admin token. Also the setup code that proves who may set up the platform. */
  adminToken: string
  cookieSecret: string
  /** Development: resolve handles through this PDS and allow plain-http OAuth. */
  devPdsUrl?: string
  plcUrl?: string
  /** Serve the React app through Vite's dev server instead of the built files. */
  viteDev: boolean
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AdminWebConfig {
  const port = Number(env.ADMIN_PORT ?? env.PORT ?? 2589)
  const need = (key: string) => {
    const value = env[key]
    if (!value) throw new Error(`${key} is required`)
    return value
  }
  return {
    port,
    publicUrl: env.ADMIN_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
    databaseUrl: need('DATABASE_URL'),
    appviewUrl: env.APPVIEW_URL ?? 'http://localhost:2584',
    communityServiceUrl: env.COMMUNITY_SERVICE_URL ?? 'http://localhost:2586',
    adminToken: need('COMMUNITY_ADMIN_TOKEN'),
    cookieSecret: need('COOKIE_SECRET'),
    devPdsUrl: env.DEV_MODE === 'false' ? undefined : env.PDS_URL,
    plcUrl: env.PLC_URL,
    viteDev: env.NODE_ENV !== 'production',
  }
}
