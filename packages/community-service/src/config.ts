export interface CommunityServiceConfig {
  port: number
  databaseUrl: string
  /** The audience moderators' service-auth JWTs must name. */
  serviceDid: string
  /** 32 bytes, hex: encrypts community credentials at rest. */
  secretKey: Buffer
  /** Bearer token for the admin endpoints the admin CLI calls. */
  adminToken: string
  plcUrl?: string
  /** Allows plain-http DID and PDS lookups. */
  devMode: boolean
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): CommunityServiceConfig {
  const need = (key: string) => {
    const value = env[key]
    if (!value) throw new Error(`${key} is required`)
    return value
  }
  const port = Number(env.COMMUNITY_SERVICE_PORT ?? env.PORT ?? 2586)
  const secretKey = Buffer.from(need('COMMUNITY_SECRET_KEY'), 'hex')
  if (secretKey.length !== 32) throw new Error('COMMUNITY_SECRET_KEY must be 32 bytes of hex')
  const plcUrl = env.PLC_URL
  return {
    port,
    databaseUrl: need('DATABASE_URL'),
    serviceDid: env.COMMUNITY_SERVICE_DID ?? `did:web:localhost%3A${port}`,
    secretKey,
    adminToken: need('COMMUNITY_ADMIN_TOKEN'),
    plcUrl,
    devMode: env.DEV_MODE ? env.DEV_MODE === 'true' : (plcUrl?.startsWith('http:') ?? false),
  }
}
