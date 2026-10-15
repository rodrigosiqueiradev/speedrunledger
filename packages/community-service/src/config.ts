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
  /** The PDS new community and platform accounts are created on. */
  pdsUrl?: string
  /** The PDS admin password, for invite codes when the PDS requires them. */
  pdsAdminPassword?: string
  /** How often to look for passed proposals to carry out; 0 turns the executor off. */
  executorIntervalMs: number
  /** Allows plain-http DID and PDS lookups. */
  devMode: boolean
  /** The Runner app's public URL, for links in world-record posts. */
  runnerAppUrl?: string
  /** The world-record feed generator's DID (the AppView), named in feed declarations. */
  feedServiceDid?: string
  /** secp256k1 private key, hex: signs suspected-cheating labels. Without it, flagging is off. */
  labelerSigningKey?: string
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
    pdsUrl: env.PDS_URL,
    pdsAdminPassword: env.PDS_ADMIN_PASSWORD,
    executorIntervalMs: Number(env.EXECUTOR_INTERVAL_MS ?? 2000),
    devMode: env.DEV_MODE ? env.DEV_MODE === 'true' : (plcUrl?.startsWith('http:') ?? false),
    runnerAppUrl: env.RUNNER_PUBLIC_URL,
    feedServiceDid: env.FEED_SERVICE_DID,
    labelerSigningKey: env.LABELER_SIGNING_KEY,
  }
}
